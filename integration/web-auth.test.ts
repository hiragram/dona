import assert from "node:assert/strict";
import test from "node:test";
import { scope } from "../dispatcher/test/web/fixtures.js";
import { encodeWebAuthState } from "../dispatcher/src/web/model.js";
import { fixtureSecret } from "../sources/web/test/fixtures.js";
import { fixture } from "./web-auth-fixture.js";

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
  assert.equal(logout.body, '{"error":"durability_unavailable"}');
  assert.equal(logout.headers["set-cookie"], undefined); assert.equal(writes, 1); assert.equal(f.audit.verify().sequence, before + 1);
  const status = await f.controller.handle(f.local.request("/api/session/logout-status", "POST"));
  assert.equal(status.status, 200); assert.deepEqual(JSON.parse(status.body), { revoked: true });
  assert.match(status.headers["set-cookie"]!, /Max-Age=0$/); assert.equal(writes, 1); assert.equal(f.idpCalls(), 0);
  assert.equal(f.audit.verify().sequence, before + 1);
});

test("online subject・client不一致はsessionを失効しprivate principalを返さない", async t => {
 for (const mode of ["subject", "client"] as const) {
  const f = await fixture(t); f.setOnline({ active: true, sub: mode === "subject" ? "other-subject" : "subject-A", client_id: mode === "client" ? "other-client" : f.local.policy.oidc.client_id,
    aud: f.local.policy.oidc.access_token_audience, exp: Date.parse(f.local.initial) / 1000 + 300 });
  const result = await f.controller.handle(f.local.request()); assert.equal(result.status, 401);
  assert.deepEqual(JSON.parse(result.body), { error: "identity_invalid" }); assert.equal(f.readState().used_nonces.length, 0);
  assert.equal(f.readState().sessions[0]!.state.state, "revoked"); assert.equal(f.readState().sessions[0]!.payload_ref, null);
 }
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
  assert.deepEqual(JSON.parse(result.body), { error: "session_revoked" }); assert.equal(f.readState().sessions[0]!.state.state, "revoked");
  const latest = f.db.prepare("SELECT record_json FROM security_audit_records ORDER BY sequence DESC LIMIT 1").get() as { record_json: string };
  assert.equal(JSON.parse(latest.record_json).event.reason, "session_revoked");
});


test("最終transaction直前のprincipal変更を監査付きで失効として返す", async t => {
  for (const change of ["state", "revoke_generation", "authz_revision", "identity_binding_revision"] as const) {
    const f = await fixture(t), confirm = f.connections.session.confirm.bind(f.connections.session);
    let confirms = 0;
    f.connections.session.confirm = async (...args) => {
      confirms++;
      f.transaction.runPrepared("fixture_principal_change", (_mark, verified) => {
        const current = f.readState(), previous = encodeWebAuthState(current);
        assert.equal(verified.resource_bindings.find(value => value.resource_id === "web_auth_state")?.resource_digest, previous.digest);
        if (change === "state") current.principals[0]!.state = "revoked";
        else current.principals[0]![change]++;
        const next = encodeWebAuthState(current);
        return { event: { scope, actor: { kind: "system" as const, id: "fixture_registry_change" }, action: "identity_change" as const,
          operation: "identity.change.v1" as const, resource_id: "web_auth_state", outcome: "succeeded" as const, reason: "none" as const,
          session_ref: null, receipt_id: null, attempt_id: null, policy_revision: 1, binding_revision: 1, authz_revision: 1 },
          resource_digest: next.digest, mutation: () => { f.db.prepare("UPDATE web_auth_state SET state_json=? WHERE instance_id=? AND tenant_id=?").run(next.canonical, scope.instance_id, scope.tenant_id); return null; } };
      });
      return confirm(...args);
    };
    const before = f.audit.verify().sequence, result = await f.controller.handle(f.local.request());
    assert.equal(result.status, 401); assert.deepEqual(JSON.parse(result.body), { error: "session_revoked" });
    assert.equal(confirms, 1); assert.equal(f.audit.verify().sequence, before + 2); assert.equal(f.readState().used_nonces.length, 0);
    const latest = f.db.prepare("SELECT record_json FROM security_audit_records ORDER BY sequence DESC LIMIT 1").get() as { record_json: string };
    assert.equal(JSON.parse(latest.record_json).event.reason, change === "state" || change === "revoke_generation" ? "session_revoked" : "revision_mismatch");
  }
});
