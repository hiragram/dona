import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { createHash, createHmac } from "node:crypto";
import { WebAuthWriteService } from "../../src/web/auth-write-service.js";
import { verifyServiceRequest, signServiceResponse, parseAuthWriteInput, type WebServiceCredential } from "../../src/web/write-auth.js";
import { verifyServiceRequest as verifySessionRequest } from "../../src/web/service-auth.js";
import { writeTransactionId } from "../../src/web/write-shapes.js";
import { setup, scope, activeSession, sessionCookie, wire } from "./fixtures.js";
const fixture = JSON.parse(fs.readFileSync(new URL("../../../test-fixtures/web-auth-write-v1.json", import.meta.url), "utf8"));
const sessionFixture = JSON.parse(fs.readFileSync(new URL("../../../test-fixtures/web-session-service-v1.json", import.meta.url), "utf8"));
const credential: WebServiceCredential = { purpose: "web_bff_service", version: 1, state: "active", ...scope,
  activated_at: "2026-09-01T00:00:00.000Z", signing_expires_at: "2026-11-01T00:00:00.000Z", secret: Buffer.alloc(32, fixture.key_byte) };
const lookup = (version: number) => version === 1 ? credential : undefined;
function signed(claims: unknown): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return payload + "." + createHmac("sha256", credential.secret).update("dona.web-auth-write.request.v1\0").update(payload).digest("base64url");
}
function requestBody(input: unknown) {
  const body = JSON.stringify(input), claims = { ...fixture.cases[0].request_claims, body_digest: createHash("sha256").update(body).digest("hex") };
  return { body, proof: signed(claims) };
}
function call(socketPath: string, options: { proof?: string; body?: string; target?: string; headers?: Record<string, string> } = {}) {
  return new Promise<string>((resolve, reject) => {
    const body = options.body ?? fixture.cases[0].request_body;
    const request = http.request({ socketPath, path: options.target ?? "/v1/web/auth/write", method: "POST", agent: false,
      headers: { host: "dona-web-auth-write", "content-type": "application/json", "content-length": String(Buffer.byteLength(body)),
        connection: "close", "x-dona-service-proof": options.proof ?? fixture.cases[0].request_proof, ...options.headers } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk)); response.once("error", reject);
      response.once("end", () => resolve(Buffer.concat(chunks).toString()));
    });
    request.once("error", reject); request.end(body);
  });
}
async function serviceFixture(t: Parameters<typeof setup>[0], credentials = lookup) {
  const f = setup(t); f.store.initialize("initialize"); f.seedRegistry();
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dwr-")); fs.chmodSync(directory, 0o700);
  const socket = path.join(directory, "s"); const service = new WebAuthWriteService(socket, scope, f.store, credentials, () => fixture.now);
  await service.start(); t.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { ...f, directory, socket, service };
}
const decodeResult = (proof: string) => JSON.parse(Buffer.from(proof.split(".")[0]!, "base64url").toString()).result;

test("書込codecは独立wire・transaction ID・結果bindingを照合する", () => {
  assert.equal(fixture.fixture_only, true);
  for (const row of fixture.cases) {
    assert.deepEqual(parseAuthWriteInput(row.request_body), row.input);
    assert.deepEqual(verifyServiceRequest(row.request_proof, row.request_body, scope, lookup, fixture.now), row.request_claims);
    assert.equal(writeTransactionId(row.request_proof), row.transaction_id);
    assert.equal(signServiceResponse(row.request_proof, row.request_body, row.result, scope, lookup, fixture.now), row.response_proof);
    assert.throws(() => verifySessionRequest(row.request_proof, row.request_body, scope, lookup, fixture.now));
  }
  assert.throws(() => verifyServiceRequest(sessionFixture.request_proof, sessionFixture.request_body, scope,
    () => ({ ...credential, secret: Buffer.alloc(32, sessionFixture.key_byte) }), fixture.now));
  const row = fixture.cases[1];
  assert.throws(() => signServiceResponse(row.request_proof, row.request_body,
    { ...row.result, result: { ...row.result.result, receipt_id: "other" } }, scope, lookup, fixture.now));
  const create = fixture.cases[0];
  for (const input of [{ ...create.input, actor: "operator" }, { ...create.input, login: { ...create.input.login, previous_session_ref: "other" } },
    { ...create.input, payload: { ...create.input.payload, binding_digest: "0".repeat(64) } }, { codec_version: 1, operation: "initialize" }]) {
    assert.throws(() => parseAuthWriteInput(JSON.stringify(input)));
  }
});

test("実UDSでloginから失効まで監査commitし同じproofを一回だけ受理する", async t => {
  const f = await serviceFixture(t); const initialSequence = f.audit.verify().sequence;
  for (const [i, row] of fixture.cases.entries()) {
    const options = { body: row.request_body, proof: row.request_proof };
    assert.equal(await call(f.socket, options), row.response_proof);
    assert.equal(f.audit.verify().sequence, initialSequence + i + 1);
    assert.ok(f.marks.used.has(row.transaction_id));
    const before = f.readState(), calls = f.anchors.calls.length;
    await assert.rejects(call(f.socket, options)); assert.deepEqual(f.readState(), before); assert.equal(f.anchors.calls.length, calls);
    if (i === 1) {
      assert.equal(before.logins.length, 0); assert.equal(before.consumed_logins[0]!.receipt_id, row.transaction_id);
      assert.equal(f.db.prepare("SELECT 1 FROM web_auth_payloads WHERE payload_ref=?").get(wire.login.payload_ref), undefined);
    }
    if (i === 2) { assert.equal(before.sessions[0]!.state.state, "active"); assert.equal(before.consumed_logins.length, 0); }
    if (i === 3) assert.equal(before.sessions[0]!.state.state, "active");
    if (i >= 4) { assert.equal(before.sessions[0]!.state.state, "revoked"); assert.equal(before.sessions[0]!.payload_ref, null); }
  }
  assert.equal(f.readState().bff_generation, 2);
  const sequence = f.audit.verify().sequence;
  for (const row of fixture.cases) await assert.rejects(call(f.socket, { body: row.request_body, proof: row.request_proof }));
  assert.equal(f.audit.verify().sequence, sequence);
  const records = (f.db.prepare("SELECT record_json FROM security_audit_records").all() as Array<{ record_json: string }>).map(row => JSON.parse(row.record_json));
  const inactive = records.find(row => row.transaction_id === fixture.cases[4].transaction_id);
  assert.ok(inactive); const event = inactive.event;
  assert.equal(event.outcome, "denied"); assert.equal(event.reason, "identity_invalid"); assert.equal(event.actor.kind, "unauthenticated"); assert.equal(event.session_ref, "session");
  const stored = JSON.stringify(records); assert.ok(!stored.includes(fixture.cases[0].request_proof));
});

test("cookie不一致の消費とstale restartは既存stateを変更しない", async t => {
  const f = await serviceFixture(t); const login = fixture.cases[0], restart = fixture.cases[7];
  await call(f.socket, { body: login.request_body, proof: login.request_proof });
  const bad = decodeResult(await call(f.socket, requestBody({ codec_version: 1, operation: "consume_login", cookie_indexes: [{ key_version: 1, digest: "0".repeat(64) }] })));
  assert.equal(bad.result.status, "denied"); assert.equal(f.readState().logins.length, 1);
  const before = f.readState();
  const stale = decodeResult(await call(f.socket, requestBody({ codec_version: 1, operation: "restart", expected_generation: 2 })));
  assert.equal(stale.result.reason, "revision_mismatch"); assert.deepEqual(f.readState(), before);
  await call(f.socket, { body: restart.request_body, proof: restart.request_proof }); assert.equal(f.readState().bff_generation, 2);
  const again = decodeResult(await call(f.socket, requestBody(restart.input)));
  assert.equal(again.result.reason, "revision_mismatch"); assert.equal(f.readState().bff_generation, 2);
});

test("IdP inactive失効のreserve/finalize不明時は成功を返さず再試行しない", async t => {
  for (const fault of ["reserve_after", "finalize_before", "finalize_after"] as const) {
    const f = await serviceFixture(t);
    for (const row of fixture.cases.slice(0, 3)) await call(f.socket, { body: row.request_body, proof: row.request_proof });
    f.anchors.fault = fault; const row = fixture.cases[4], calls = f.anchors.calls.length;
    await assert.rejects(call(f.socket, { body: row.request_body, proof: row.request_proof }));
    const after = f.anchors.calls.length;
    assert.equal(after - calls, fault === "reserve_after" ? 1 : 2);
    assert.equal(f.readState().sessions[0]!.state.state, fault === "reserve_after" ? "active" : "revoked");
    assert.equal(f.readState().sessions[0]!.payload_ref === null, fault !== "reserve_after");
    await assert.rejects(call(f.socket, { body: row.request_body, proof: row.request_proof })); assert.equal(f.anchors.calls.length, after);
    f.anchors.fault = "none";
    if (fault === "finalize_after") assert.equal(f.store.lookupSession([sessionCookie])?.session.state.state, "revoked");
    else assert.throws(() => f.store.lookupSession([sessionCookie]));
  }
});

test("commit後のcredential失効で応答を失っても同じwriteを再送しない", async t => {
  let lookups = 0; const f = await serviceFixture(t, () => ++lookups === 1 ? credential : { ...credential, state: "revoked" });
  const row = fixture.cases[0];
  await assert.rejects(call(f.socket, { body: row.request_body, proof: row.request_proof }));
  assert.equal(f.readState().logins.length, 1); const sequence = f.audit.verify().sequence;
  await assert.rejects(call(f.socket, { body: row.request_body, proof: row.request_proof })); assert.equal(f.audit.verify().sequence, sequence);
});

test("拒否auditはclient actorを受け付けずlocal logoutはIdPなしで冪等に失効する", async t => {
  const f = await serviceFixture(t);
  for (const row of fixture.cases.slice(0, 3)) await call(f.socket, { body: row.request_body, proof: row.request_proof });
  const denial = requestBody({ codec_version: 1, operation: "record_denial", cookie_indexes: null, reason: "cookie_ambiguous" });
  assert.equal(decodeResult(await call(f.socket, denial)).result.reason, "cookie_ambiguous");
  const row = fixture.cases[5]; assert.equal(decodeResult(await call(f.socket, { body: row.request_body, proof: row.request_proof })).result.kind, "revoked");
  assert.equal(decodeResult(await call(f.socket, requestBody(row.input))).result.kind, "revoked");
  assert.equal(f.store.lookupSession([sessionCookie])?.session.state.state, "revoked");
  const before = f.audit.verify().sequence;
  for (const options of [{ proof: "invalid" }, { target: "/v1/web/auth/read" }, { headers: { "x-principal-id": "other" } },
    requestBody({ codec_version: 1, operation: "initialize" }), requestBody({ ...fixture.cases[3].input, actor: "operator" })]) await assert.rejects(call(f.socket, options));
  assert.equal(f.audit.verify().sequence, before);
});
