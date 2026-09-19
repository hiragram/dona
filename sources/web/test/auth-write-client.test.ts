import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test, { type TestContext } from "node:test";
import { createHash, createHmac } from "node:crypto";
import { WebAuthWriteClient } from "../src/auth-write-client.js";
import { encodeAuthWriteInput, signServiceRequest, verifyServiceResponse, WebServiceError, type WebServiceCredential } from "../src/write-auth.js";
const fixture = JSON.parse(fs.readFileSync(new URL("../../../test-fixtures/web-auth-write-v1.json", import.meta.url), "utf8"));
const credential: WebServiceCredential = { purpose: "web_bff_service", version: 1, state: "active", ...fixture.scope,
  activated_at: "2026-09-01T00:00:00.000Z", signing_expires_at: "2026-11-01T00:00:00.000Z", secret: Buffer.alloc(32, fixture.key_byte) };
const lookup = (version: number) => version === 1 ? credential : undefined;
const transactionId = (proof: string) => "web_auth_" + createHash("sha256").update("dona.web-auth-write.transaction.v1\0").update(proof).digest("hex");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function seal(kind: string, value: unknown): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return payload + "." + createHmac("sha256", credential.secret).update(`dona.web-auth-write.${kind}.v1\0`).update(payload).digest("base64url");
}
function responseProof(proof: string, row: any, override: Record<string, unknown> = {}): string {
  const request = JSON.parse(Buffer.from(proof.split(".")[0]!, "base64url").toString());
  const result = row.input.operation === "consume_login" ? { ...row.result, result: { ...row.result.result, receipt_id: transactionId(proof) } } : row.result;
  return seal("response", { ...row.response_claims, result, request_nonce: request.nonce,
    request_body_digest: request.body_digest, request_proof_digest: hash(proof), ...override });
}
type Handler = (proof: string, row: any, response: http.ServerResponse) => void;
async function fixtureServer(t: TestContext, handler: Handler) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dwrc-")); fs.chmodSync(directory, 0o700);
  const socket = path.join(directory, "s"); let calls = 0, lastProof = "";
  const server = http.createServer((request, response) => {
    calls++; const chunks: Buffer[] = [], proof = request.headers["x-dona-service-proof"] as string; lastProof = proof;
    request.on("data", chunk => chunks.push(chunk)); request.once("end", () => {
      const claims = JSON.parse(Buffer.from(proof.split(".")[0]!, "base64url").toString());
      const body = Buffer.concat(chunks).toString();
      assert.equal(seal("request", claims), proof); assert.equal(claims.body_digest, hash(body));
      assert.equal(request.headers.host, "dona-web-auth-write"); assert.equal(request.url, "/v1/web/auth/write");
      assert.equal(request.method, "POST"); assert.ok(!JSON.stringify(request.headers).includes(Buffer.from(credential.secret).toString("base64")));
      const row = fixture.cases.find((value: any) => value.request_body === body); assert.ok(row); handler(proof, row, response);
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve)); fs.chmodSync(socket, 0o600);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); });
  return { socket, directory, get calls() { return calls; }, get lastProof() { return lastProof; }, client: (deadline = 1000, keys = lookup) =>
    new WebAuthWriteClient(socket, fixture.scope, () => credential, keys, () => fixture.now, deadline) };
}
function send(response: http.ServerResponse, body: string, extra: Record<string, string | string[]> = {}) {
  response.writeHead(200, { "content-type": "application/vnd.dona.web-auth-write-response", "content-length": String(Buffer.byteLength(body)), connection: "close", ...extra });
  response.end(body);
}

test("書込clientは独立wireとproof由来receiptを照合する", () => {
  assert.equal(fixture.fixture_only, true);
  for (const row of fixture.cases) {
    assert.equal(encodeAuthWriteInput(row.input), row.request_body);
    assert.equal(transactionId(row.request_proof), row.transaction_id);
    assert.deepEqual(verifyServiceResponse(row.response_proof, row.request_proof, row.request_body, fixture.scope, lookup, fixture.now), row.result);
    const generated = signServiceRequest(row.request_body, fixture.scope, credential, fixture.now);
    assert.throws(() => verifyServiceResponse(row.response_proof, generated, row.request_body, fixture.scope, lookup, fixture.now));
  }
  const row = fixture.cases[1];
  for (const result of [{ ...row.result, result: { ...row.result.result, receipt_id: "other" } },
    { ...row.result, result: { ...row.result.result, login: { ...row.result.result.login, binding: { ...row.result.result.login.binding, tenant_id: "other" } } } },
    { ...row.result, result: { ...row.result.result, payload: { ...row.result.result.payload, binding_digest: "0".repeat(64) } } }]) {
    assert.throws(() => verifyServiceResponse(responseProof(row.request_proof, row, { result }), row.request_proof, row.request_body, fixture.scope, lookup, fixture.now));
  }
  const restart = fixture.cases[7];
  assert.throws(() => verifyServiceResponse(responseProof(restart.request_proof, restart, { result: { ...restart.result,
    result: { ...restart.result.result, generation: 3 } } }), restart.request_proof, restart.request_body, fixture.scope, lookup, fixture.now));
});

test("clientは実UDSで八つの固定operationとdenialを検証する", async t => {
  const f = await fixtureServer(t, (proof, row, response) => send(response, responseProof(proof, row)));
  for (const row of fixture.cases) {
    const result = await f.client().mutate(row.input);
    const expected = row.input.operation === "consume_login" ? { ...row.result, result: { ...row.result.result, receipt_id: transactionId(f.lastProof) } } : row.result;
    assert.deepEqual(result, expected);
  }
  assert.equal(f.calls, 8);
});

test("commit受理が不明な応答喪失・timeout・署名不正を再送しない", async t => {
  for (const fault of ["lost", "timeout", "tamper", "nonce", "operation"] as const) {
    const f = await fixtureServer(t, (proof, row, response) => {
      if (fault === "lost") { response.destroy(); return; }
      if (fault === "timeout") return;
      const extra = fault === "nonce" ? { request_nonce: Buffer.alloc(32, 9).toString("base64url") }
        : fault === "operation" ? { result: fixture.cases[7].result } : {};
      send(response, responseProof(proof, row, extra) + (fault === "tamper" ? "x" : ""));
    });
    await assert.rejects(f.client(fault === "timeout" ? 100 : 1000).mutate(fixture.cases[0].input), WebServiceError); assert.equal(f.calls, 1);
  }
});

test("payload・scope・callback actor・旧session参照の注入は送信前に拒否する", async t => {
  const f = await fixtureServer(t, (proof, row, response) => send(response, responseProof(proof, row))), input = fixture.cases[0].input;
  for (const value of [{ ...input, actor: "operator" }, { ...input, login: { ...input.login, previous_session_ref: "other" } },
    { ...input, login: { ...input.login, binding: { ...input.login.binding, instance_id: "other" } } },
    { ...input, payload: { ...input.payload, envelope: { ...input.payload.envelope, ciphertext: "dGFtcGVyZWQ" } } },
    { codec_version: 1, operation: "initialize" }]) await assert.rejects(f.client().mutate(value));
  assert.equal(f.calls, 0);
});

test("古いcredential・socket変更・不要なheaderを成功応答にしない", async t => {
  for (const fault of ["credential", "socket", "header"] as const) {
    const f = await fixtureServer(t, (proof, row, response) => {
      if (fault === "socket") fs.chmodSync(f.socket, 0o666);
      send(response, responseProof(proof, row), fault === "header" ? { "set-cookie": "forbidden" } : {});
    });
    const keys = fault === "credential" ? () => ({ ...credential, state: "revoked" as const }) : lookup;
    await assert.rejects(f.client(1000, keys).mutate(fixture.cases[0].input), WebServiceError); assert.equal(f.calls, 1);
  }
});

test("期限切れproofと応答の不正generationは受理しない", () => {
  for (const row of fixture.cases) {
    assert.throws(() => verifyServiceResponse(row.response_proof, row.request_proof, row.request_body, fixture.scope, lookup, row.request_claims.expires_at));
  }
  const row = fixture.cases[0];
  assert.throws(() => verifyServiceResponse(responseProof(row.request_proof, row, { result: { ...row.result,
    result: { ...row.result.result, generation: 2 } } }), row.request_proof, row.request_body, fixture.scope, lookup, fixture.now));
  assert.throws(() => signServiceRequest(row.request_body, fixture.scope, { ...credential, state: "verification_only" }, fixture.now));
});
