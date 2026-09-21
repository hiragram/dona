import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import type { WebJobReadBroker } from "../dispatcher/src/web/job-read-broker.js";
import type { WebCommandBroker } from "../dispatcher/src/web/command-broker.js";
import type { WebJobReadGrantOperatorKey } from "../dispatcher/src/web/internal-service.js";

// Real SQLite, audited repository, private UDS and BFF clients. IdP, protected
// clock/anchor/key material and TLS-listener classification are fixtures only.
export async function fixture(t: Parameters<typeof setup>[0], policy = fixturePolicy(), brokers?: {
  commands?: (repository: WebAuthRepository) => WebCommandBroker;
  jobReads?: (repository: WebAuthRepository) => WebJobReadBroker;
  grantOperatorKey?:WebJobReadGrantOperatorKey;
}) {
  const db = setup(t), local = controllerFixture({ ...policy, ...scope });
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
  const gateway = new WebInternalGateway(socket, scope, repository, lookup, local.now, 5000,
    brokers?.commands?.(repository), brokers?.jobReads?.(repository),brokers?.grantOperatorKey); await gateway.start();
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
  const controller = new WebAuthController(local.policy, connections, local.keys, local.now, 1);
  return { ...db, local, controller, connections, socket, gateway, credential, lookup, repository, idpCalls: () => idpCalls, setOnline: (value: Record<string, unknown>) => { online = value; },
    setNow: (value: string) => { local.setNow(value); db.setNow(value); } };
}
