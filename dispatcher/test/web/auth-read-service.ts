import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { createHash, createHmac } from "node:crypto";
import { WebAuthReadService } from "../../src/web/auth-read-service.js";
import { verifyServiceRequest, signServiceResponse, parseAuthReadInput, type WebServiceCredential } from "../../src/web/read-auth.js";
import { verifyServiceRequest as verifySessionRequest } from "../../src/web/service-auth.js";
import { encodeWebAuthState } from "../../src/web/model.js";
import { setup, scope, activeSession, sessionCookie, wire } from "./fixtures.js";
const fixture = JSON.parse(fs.readFileSync(new URL("../../../test-fixtures/web-auth-read-v1.json", import.meta.url), "utf8"));
const sessionFixture = JSON.parse(fs.readFileSync(new URL("../../../test-fixtures/web-session-service-v1.json", import.meta.url), "utf8"));
const credential: WebServiceCredential = { purpose: "web_bff_service", version: 1, state: "active", ...scope,
  activated_at: "2026-09-01T00:00:00.000Z", signing_expires_at: "2026-11-01T00:00:00.000Z", secret: Buffer.alloc(32, fixture.key_byte) };
const lookup = (version: number) => version === 1 ? credential : undefined;
function signed(claims: unknown): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return payload + "." + createHmac("sha256", credential.secret).update("dona.web-auth-read.request.v1\0").update(payload).digest("base64url");
}
function requestBody(input: unknown) {
  const body = JSON.stringify(input), claims = { ...fixture.cases[0].request_claims, body_digest: createHash("sha256").update(body).digest("hex") };
  return { body, proof: signed(claims) };
}
function call(socketPath: string, options: { proof?: string; body?: string; target?: string; headers?: Record<string, string> } = {}) {
  return new Promise<string>((resolve, reject) => {
    const body = options.body ?? fixture.cases[0].request_body;
    const request = http.request({ socketPath, path: options.target ?? "/v1/web/auth/read", method: "POST", agent: false,
      headers: { host: "dona-web-auth-read", "content-type": "application/json", "content-length": String(Buffer.byteLength(body)),
        connection: "close", "x-dona-service-proof": options.proof ?? fixture.cases[0].request_proof, ...options.headers } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk)); response.once("error", reject);
      response.once("end", () => resolve(Buffer.concat(chunks).toString()));
    });
    request.once("error", reject); request.end(body);
  });
}
async function serviceFixture(t: Parameters<typeof setup>[0]) {
  const f = setup(t); activeSession(f);
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dwr-")); fs.chmodSync(directory, 0o700);
  const socket = path.join(directory, "s"); const service = new WebAuthReadService(socket, scope, f.store, lookup, () => fixture.now);
  await service.start(); t.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { ...f, directory, socket, service };
}
const decodeResult = (proof: string) => JSON.parse(Buffer.from(proof.split(".")[0]!, "base64url").toString()).result;

test("読取codecは独立wireとoperation・scopeを照合し別APIのproofを拒否する", () => {
  assert.equal(fixture.fixture_only, true);
  for (const row of fixture.cases) {
    assert.deepEqual(parseAuthReadInput(row.request_body), row.input);
    assert.deepEqual(verifyServiceRequest(row.request_proof, row.request_body, scope, lookup, fixture.now), row.request_claims);
    assert.equal(signServiceResponse(row.request_proof, row.request_body, row.result, scope, lookup, fixture.now), row.response_proof);
    assert.throws(() => verifySessionRequest(row.request_proof, row.request_body, scope, lookup, fixture.now));
    assert.throws(() => verifyServiceRequest(row.request_proof, row.request_body, { ...scope, tenant_id: "other" }, lookup, fixture.now));
    assert.throws(() => verifyServiceRequest(row.request_proof, row.request_body, scope, lookup, row.request_claims.expires_at));
  }
  const first = fixture.cases[0];
  assert.throws(() => verifyServiceRequest(sessionFixture.request_proof, sessionFixture.request_body, scope,
    () => ({ ...credential, secret: Buffer.alloc(32, sessionFixture.key_byte) }), fixture.now));
  assert.throws(() => signServiceResponse(first.request_proof, first.request_body, fixture.cases[2].result, scope, lookup, fixture.now));
  assert.throws(() => parseAuthReadInput(first.request_body.replace('"codec_version":1', '"codec_version":1,"codec_version":1')));
  for (const input of [{ ...first.input, raw_subject: "never forward" }, { codec_version: 1, operation: "restart" },
    { codec_version: 1, operation: "principal_lookup", subject_indexes: [] }]) assert.throws(() => parseAuthReadInput(JSON.stringify(input)));
});

test("実UDSとSQLiteで三つの読取を行い再読でもstate・nonce・監査を変更しない", async t => {
  const f = await serviceFixture(t), before = f.readState(), sequence = f.audit.verify().sequence, calls = f.anchors.calls.length;
  for (const row of fixture.cases) {
    const options = { proof: row.request_proof, body: row.request_body };
    assert.equal(await call(f.socket, options), row.response_proof); assert.equal(await call(f.socket, options), row.response_proof);
  }
  assert.deepEqual(f.readState(), before); assert.equal(f.audit.verify().sequence, sequence); assert.equal(f.anchors.calls.length, calls);
  assert.equal(fs.statSync(f.socket).mode & 0o777, 0o600);
});

test("認証不正・identity header・別operationをrepositoryへ通さない", async t => {
  const f = await serviceFixture(t), before = f.audit.verify().sequence;
  for (const options of [{ proof: "invalid" }, { body: fixture.cases[0].request_body + " " }, { target: "/v1/web/auth/read?x=1" },
    { target: "/v1/web/session/verify" }, { headers: { "x-principal-id": "principal" } }, { headers: { host: "other" } },
    requestBody({ codec_version: 1, operation: "restart" })]) await assert.rejects(call(f.socket, options));
  assert.equal(f.audit.verify().sequence, before); assert.equal(f.readState().bff_generation, 1);
});

test("完全なsubject鍵一覧だけを照合し曖昧なprincipalを選ばない", t => {
  const f = setup(t); assert.throws(() => f.store.loginContext());
  f.store.initialize("initialize"); assert.throws(() => f.store.lookupPrincipal([{ key_version: 1, digest: "a".repeat(64) }]));
  f.seedRegistry([1, 2]); const indexes = [1, 2].map(key_version => ({ key_version, digest: "a".repeat(64) }));
  assert.deepEqual(f.store.loginContext(), { bff_generation: 1, retained_subject_key_versions: [1, 2] });
  assert.equal(f.store.lookupPrincipal(indexes)?.principal.principal_id, "principal");
  assert.equal(f.store.lookupPrincipal(indexes.map(value => ({ ...value, digest: "0".repeat(64) }))), null);
  for (const input of [[indexes[0]!], [...indexes, indexes[0]!], [indexes[0]!, { ...indexes[1]!, key_version: 3 }]]) assert.throws(() => f.store.lookupPrincipal(input));
  // Fixture-only authorized registry change, not a production operator endpoint.
  f.transaction.runPrepared("ambiguous_registry", (mark, verified) => {
    const before = f.readState(); assert.equal(verified.resource_bindings.find(row => row.resource_id === "web_auth_state")?.resource_digest, encodeWebAuthState(before).digest);
    const after = encodeWebAuthState({ ...before, updated_at: mark.effective_utc, principals: [...before.principals, { ...wire.principal, principal_id: "second" }],
      aliases: before.aliases.map(alias => alias.index_key_version === 2 ? { ...alias, principal_id: "second" } : alias) });
    return { event: { scope, actor: { kind: "system" as const, id: "fixture_registry_seed" }, action: "identity_change" as const,
      operation: "identity.change.v1" as const, resource_id: "web_auth_state", outcome: "succeeded" as const, reason: "none" as const,
      session_ref: null, receipt_id: null, attempt_id: null, policy_revision: 1, binding_revision: 1, authz_revision: 1 }, resource_digest: after.digest,
      mutation: () => { f.db.prepare("UPDATE web_auth_state SET state_json=? WHERE instance_id=? AND tenant_id=?").run(after.canonical, scope.instance_id, scope.tenant_id); return null; } };
  });
  assert.throws(() => f.store.lookupPrincipal(indexes));
});

test("失効・restart・未検証anchorは古いsessionの権限にfallbackしない", async t => {
  const f = await serviceFixture(t), row = fixture.cases[1], options = { body: row.request_body, proof: row.request_proof };
  f.store.revokeSession("logout", "session", sessionCookie);
  const revoked = decodeResult(await call(f.socket, options)); assert.equal(revoked.snapshot.session.state.state, "revoked"); assert.equal(revoked.snapshot.payload, null);
  f.store.restart("restart"); const restarted = decodeResult(await call(f.socket, options));
  assert.equal(restarted.snapshot.bff_generation, 2); assert.equal(restarted.snapshot.session.state.state, "revoked");
  f.anchors.value.pending_transaction_id = "unknown"; await assert.rejects(call(f.socket, options));
});

test("保存payload改変と実行中socket権限変更では読取結果を返さない", async t => {
  const f = await serviceFixture(t); fs.chmodSync(f.socket, 0o666); await assert.rejects(call(f.socket)); fs.chmodSync(f.socket, 0o600);
  const payload = { ...wire.payload, envelope: { ...wire.payload.envelope, ciphertext: "dGFtcGVyZWQ" } };
  f.db.prepare("UPDATE web_auth_payloads SET payload_json=? WHERE payload_ref=?").run(JSON.stringify(payload), wire.payload.payload_ref);
  await assert.rejects(call(f.socket, { body: fixture.cases[1].request_body, proof: fixture.cases[1].request_proof }));
});
