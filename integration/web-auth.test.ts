import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setup, scope, wire, loginCookie } from "../dispatcher/test/web/fixtures.js";
import { encodeWebAuthState } from "../dispatcher/src/web/model.js";
import { WebAuthRepository } from "../dispatcher/src/web/repository.js";
import { WebInternalGateway } from "../dispatcher/src/web/internal-gateway.js";
import { WebAuthReadClient } from "../sources/web/src/auth-read-client.js";
import { WebAuthWriteClient } from "../sources/web/src/auth-write-client.js";
import { WebSessionClient } from "../sources/web/src/session-client.js";
import { OidcProtocol } from "../sources/web/src/oidc.js";
import { subjectLookupIndexes } from "../sources/web/src/identity-index.js";
import { WebAuthController } from "../sources/web/src/auth-controller.js";
import { controllerFixture } from "../sources/web/test/auth-controller-fixture.js";
import { fixturePolicy, fixtureSecret } from "../sources/web/test/fixtures.js";

// Real SQLite, audited repository, private UDS and BFF clients. IdP, protected
// clock/anchor/key material and TLS-listener classification are fixtures only.
async function fixture(t: Parameters<typeof setup>[0]) {
  const db = setup(t), local = controllerFixture({ ...fixturePolicy(), ...scope });
  db.store.initialize("initialize"); db.seedRegistry();
  const indexes = subjectLookupIndexes({ ...scope, issuer: local.policy.oidc.issuer, subject: "subject-A" }, local.keys.identities())
    .map(value => ({ key_version: value.identity_index_key_version, digest: value.subject_digest }));
  // Fixture-only already-authorized registry alias migration, through the same
  // verified aggregate root/audit transaction. No production enrollment API.
  db.transaction.runPrepared("fixture_subject_alias", (_mark, verified) => {
    const current = db.readState(), previous = encodeWebAuthState(current);
    assert.equal(verified.resource_bindings.find(value => value.resource_id === "web_auth_state")?.resource_digest, previous.digest);
    const next = encodeWebAuthState({ ...current, aliases: indexes.map(value => ({ principal_id: "principal", index_key_version: value.key_version, subject_digest: value.digest })) });
    return { event: { scope, actor: { kind: "system" as const, id: "fixture_registry_seed" }, action: "identity_change" as const,
      operation: "identity.change.v1" as const, resource_id: "web_auth_state", outcome: "succeeded" as const, reason: "none" as const,
      session_ref: null, receipt_id: null, attempt_id: null, policy_revision: 1, binding_revision: 1, authz_revision: 1 },
      resource_digest: next.digest, mutation: () => { db.db.prepare("UPDATE web_auth_state SET state_json=? WHERE instance_id=? AND tenant_id=?").run(next.canonical, scope.instance_id, scope.tenant_id); return null; } };
  });
  assert.equal(db.store.createLogin("create_login", wire.login, wire.login_payload, null).status, "succeeded");
  assert.equal(db.store.consumeLogin("consume_login", "login", loginCookie).status, "succeeded");
  assert.equal(db.store.createSession("create_session", "consume_login", indexes, local.snapshot.session, local.snapshot.payload!).status, "succeeded");
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dwc-")); fs.chmodSync(directory, 0o700);
  const socket = path.join(directory, "s");
  const credential = { purpose: "web_bff_service" as const, version: 1, state: "active" as const, ...scope,
    activated_at: "2026-09-01T00:00:00.000Z", signing_expires_at: "2026-11-01T00:00:00.000Z", secret: Buffer.alloc(32, 0x77) };
  const lookup = (version: number) => version === 1 ? credential : undefined;
  const repository = new WebAuthRepository(db.db, db.providers, scope, version => version === 1 ? local.keys.context() : undefined);
  const gateway = new WebInternalGateway(socket, scope, repository, lookup, local.now); await gateway.start();
  t.after(async () => { await gateway.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let online: Record<string, unknown> = { active: true, sub: "subject-A", client_id: local.policy.oidc.client_id,
    aud: local.policy.oidc.access_token_audience, exp: Date.parse(local.initial) / 1000 + 300 }, idpCalls = 0;
  const oidc = new OidcProtocol(local.policy, { clientSecret: () => fixtureSecret }, { fetch: (async (url, init) => {
    idpCalls++; assert.equal(url, local.policy.oidc.introspection_endpoint); assert.equal(init?.redirect, "error");
    assert.equal(new URLSearchParams(init?.body as string).get("token"), local.token);
    return new Response(JSON.stringify(online), { headers: { "content-type": "application/json" } });
  }) as typeof fetch });
  const connections = {
    read: new WebAuthReadClient(socket, scope, () => credential, lookup, local.now),
    write: new WebAuthWriteClient(socket, scope, () => credential, lookup, local.now),
    session: new WebSessionClient(socket, scope, () => credential, lookup, local.now), oidc,
  };
  const controller = new WebAuthController(local.policy, connections, local.keys, local.now);
  return { ...db, local, controller, connections, idpCalls: () => idpCalls, setOnline: (value: Record<string, unknown>) => { online = value; },
    setNow: (value: string) => { local.setNow(value); db.setNow(value); } };
}

test("実BFF・UDS・共有監査でsession確認からlogoutと失効read-backまで接続する", async t => {
  const f = await fixture(t), before = f.audit.verify().sequence;
  const session = await f.controller.handle(f.local.request()); assert.equal(session.status, 200);
  assert.equal(JSON.parse(session.body).principal.principal_id, "principal"); assert.equal(f.idpCalls(), 1);
  assert.equal(f.audit.verify().sequence, before + 1); assert.equal(f.readState().used_nonces.length, 1);
  const csrf = await f.controller.handle(f.local.request("/api/session/csrf", "POST")); assert.equal(csrf.status, 200);
  const logout = await f.controller.handle(f.local.request("/api/session/logout", "POST")); assert.equal(logout.status, 204);
  assert.match(logout.headers["set-cookie"]!, /Max-Age=0$/); assert.equal(f.readState().sessions[0]!.state.state, "revoked");
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM web_auth_payloads").get() as { n: number }).n, 0);
  assert.equal((await f.controller.handle(f.local.request())).status, 401); assert.equal(f.idpCalls(), 1);
  const stored = JSON.stringify(f.db.prepare("SELECT record_json FROM security_audit_records").all());
  for (const secret of [f.local.token, f.local.cookie, "subject-A", fixtureSecret]) assert.ok(!stored.includes(secret));
});

test("inactive時の失効と監査応答喪失を実repositoryで区別し再writeしない", async t => {
  for (const fault of ["none", "reserve_after", "finalize_before", "finalize_after"] as const) {
    const f = await fixture(t); f.setOnline({ active: false }); f.anchors.fault = fault;
    const calls = f.anchors.calls.length, result = await f.controller.handle(f.local.request());
    assert.equal(result.status, fault === "none" ? 401 : 503); assert.equal(result.headers["set-cookie"], undefined);
    assert.equal(f.anchors.calls.length - calls, fault === "reserve_after" ? 1 : 2);
    assert.equal(f.readState().sessions[0]!.state.state, fault === "reserve_after" ? "active" : "revoked");
    assert.equal(f.idpCalls(), 1);
  }
});

test("logout応答だけを失っても新しいwriteをせず現行stateをread-onlyで照合する", async t => {
  const f = await fixture(t), mutate = f.connections.write.mutate.bind(f.connections.write);
  let writes = 0; f.connections.write.mutate = async input => { writes++; await mutate(input); throw Error("fixture response lost"); };
  const before = f.audit.verify().sequence;
  const logout = await f.controller.handle(f.local.request("/api/session/logout", "POST")); assert.equal(logout.status, 503);
  assert.equal(logout.headers["set-cookie"], undefined); assert.equal(writes, 1); assert.equal(f.audit.verify().sequence, before + 1);
  const status = await f.controller.handle(f.local.request("/api/session/logout-status", "POST"));
  assert.equal(status.status, 200); assert.deepEqual(JSON.parse(status.body), { revoked: true });
  assert.match(status.headers["set-cookie"]!, /Max-Age=0$/); assert.equal(writes, 1); assert.equal(f.idpCalls(), 0);
  assert.equal(f.audit.verify().sequence, before + 1);
});

test("online subject不一致はregistry lookupで拒否しprivate principalを返さない", async t => {
  const f = await fixture(t); f.setOnline({ active: true, sub: "other-subject", client_id: f.local.policy.oidc.client_id,
    aud: f.local.policy.oidc.access_token_audience, exp: Date.parse(f.local.initial) / 1000 + 300 });
  const result = await f.controller.handle(f.local.request()); assert.equal(result.status, 401);
  assert.deepEqual(JSON.parse(result.body), { error: "identity_mismatch" }); assert.equal(f.readState().used_nonces.length, 0);
  assert.equal(f.readState().sessions[0]!.state.state, "active");
});

test("BFFのonline照合後のlocal revokeをDispatcherの最終transactionで拒否する", async t => {
  const f = await fixture(t), confirm = f.connections.session.confirm.bind(f.connections.session);
  f.connections.session.confirm = async (...args) => {
    const session = f.local.snapshot.session;
    await f.connections.write.mutate({ codec_version: 1, operation: "revoke_session", session_ref: session.state.session_ref,
      cookie: { key_version: session.cookie_key_version, digest: session.cookie_digest } });
    return confirm(...args);
  };
  const result = await f.controller.handle(f.local.request()); assert.equal(result.status, 401);
  assert.deepEqual(JSON.parse(result.body), { error: "session_invalid" }); assert.equal(f.readState().sessions[0]!.state.state, "revoked");
});
