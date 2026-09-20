import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test, { type TestContext } from "node:test";
import { createHash, createHmac } from "node:crypto";
import { WebSessionClient } from "../src/session-client.js";
import { signServiceRequest, verifyServiceResponse, encodeSessionServiceInput, WebServiceError, type WebServiceCredential } from "../src/service-auth.js";
const fixture = JSON.parse(fs.readFileSync(new URL("../../../test-fixtures/web-session-service-v1.json", import.meta.url), "utf8"));
const credential: WebServiceCredential = { purpose: "web_bff_service", version: 1, state: "active", ...fixture.scope,
  activated_at: "2026-09-01T00:00:00.000Z", signing_expires_at: "2026-11-01T00:00:00.000Z", secret: Buffer.alloc(32, fixture.key_byte) };
const lookup = (version: number) => version === 1 ? credential : undefined;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function seal(kind: string, value: unknown): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return payload + "." + createHmac("sha256", credential.secret).update(`dona.web-service.${kind}.v1\0`).update(payload).digest("base64url");
}
function responseProof(proof: string, override: Record<string, unknown> = {}): string {
  const request = JSON.parse(Buffer.from(proof.split(".")[0]!, "base64url").toString());
  return seal("response", { ...fixture.response_claims, request_nonce: request.nonce,
    request_body_digest: request.body_digest, request_proof_digest: hash(proof), ...override });
}
type Handler = (proof: string, response: http.ServerResponse, request: http.IncomingMessage) => void;
async function fixtureServer(t: TestContext, handler: Handler) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dwc-")); fs.chmodSync(directory, 0o700);
  const socket = path.join(directory, "s"); let calls = 0;
  const server = http.createServer((request, response) => {
    calls++; const proof = request.headers["x-dona-service-proof"] as string; const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk)); request.once("end", () => {
      const claims = JSON.parse(Buffer.from(proof.split(".")[0]!, "base64url").toString());
      assert.equal(seal("request", claims), proof); assert.equal(claims.body_digest, hash(Buffer.concat(chunks).toString()));
      assert.equal(request.headers.host, "dona-web-session"); assert.equal(request.url, "/v1/web/session/verify");
      assert.ok(!JSON.stringify(request.headers).includes(Buffer.from(credential.secret).toString("base64")));
      handler(proof, response, request);
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve)); fs.chmodSync(socket, 0o600);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); });
  return { socket, directory, get calls() { return calls; }, client: (deadline = 1000, keys = lookup) =>
    new WebSessionClient(socket, fixture.scope, () => credential, keys, () => fixture.now, deadline) };
}
function send(response: http.ServerResponse, body: string, extra: Record<string, string | string[]> = {}) {
  response.writeHead(200, { "content-type": "application/vnd.dona.web-session-response", "content-length": String(Buffer.byteLength(body)), connection: "close", ...extra });
  response.end(body);
}

test("service codecは独立golden wireを照合し別requestと改変を拒否する", () => {
  assert.equal(fixture.fixture_only, true); assert.equal(encodeSessionServiceInput(fixture.input), fixture.request_body);
  assert.deepEqual(verifyServiceResponse(fixture.response_proof, fixture.request_proof, fixture.request_body, fixture.scope, lookup, fixture.now), fixture.result);
  const generated = signServiceRequest(fixture.request_body, fixture.scope, credential, fixture.now);
  const claims = JSON.parse(Buffer.from(generated.split(".")[0]!, "base64url").toString());
  assert.equal(seal("request", claims), generated); assert.deepEqual({ ...claims, nonce: fixture.request_claims.nonce }, fixture.request_claims);
  assert.notEqual(generated, fixture.request_proof);
  for (const value of [fixture.response_proof + "x", fixture.request_proof, seal("response", { ...fixture.response_claims, request_body_digest: "0".repeat(64) }),
    seal("response", { ...fixture.response_claims, request_nonce: Buffer.alloc(32, 1).toString("base64url") }),
    seal("response", { ...fixture.response_claims, result: { ...fixture.result, secret: "fixture only" } })]) {
    assert.throws(() => verifyServiceResponse(value, fixture.request_proof, fixture.request_body, fixture.scope, lookup, fixture.now), WebServiceError);
  }
  assert.throws(() => verifyServiceResponse(fixture.response_proof, generated, fixture.request_body, fixture.scope, lookup, fixture.now));
  assert.throws(() => verifyServiceResponse(fixture.response_proof, fixture.request_proof, fixture.request_body, fixture.scope, lookup, fixture.request_claims.expires_at));
  assert.throws(() => signServiceRequest(fixture.request_body, fixture.scope, { ...credential, state: "verification_only" }, fixture.now));
  assert.throws(() => signServiceRequest(fixture.request_body, fixture.scope, { ...credential, secret: Buffer.alloc(31) }, fixture.now));
  let reads = 0;
  assert.throws(() => verifyServiceResponse(fixture.response_proof, fixture.request_proof, fixture.request_body, fixture.scope,
    () => ++reads === 1 ? credential : { ...credential, version: 2 }, fixture.now));
});

test("BFF clientは実UDSで署名responseと期待principalを照合する", async t => {
  const f = await fixtureServer(t, (proof, response) => send(response, responseProof(proof)));
  assert.deepEqual(await f.client().confirm(fixture.input, fixture.identity), fixture.result); assert.equal(f.calls, 1);
  const denied = await fixtureServer(t, (proof, response) => send(response, responseProof(proof, { result: { status: "denied", reason: "session_revoked" } })));
  assert.deepEqual(await denied.client().confirm(fixture.input, fixture.identity), { status: "denied", reason: "session_revoked" }); assert.equal(denied.calls, 1);
});

test("MAC・request・principal・header・HTTP statusの不一致を再送せず拒否する", async t => {
  for (const fault of ["mac", "old_request", "principal", "extra_header", "duplicate_header", "redirect", "oversize", "partial", "missing_reason", "unknown_reason"] as const) {
    const f = await fixtureServer(t, (proof, response) => {
      const valid = responseProof(proof);
      if (fault === "missing_reason" || fault === "unknown_reason") send(response, responseProof(proof, { result: { status: "denied", ...(fault === "unknown_reason" ? { reason: "not_a_contract" } : {}) } }));
      else if (fault === "redirect") { response.writeHead(302, { location: "https://example.invalid/" }); response.end(); }
      else if (fault === "oversize") send(response, "x".repeat(16385));
      else if (fault === "partial") { response.writeHead(200, { "content-type": "application/vnd.dona.web-session-response", "content-length": "1000", connection: "close" }); response.end("partial"); }
      else if (fault === "extra_header") send(response, valid, { "x-principal-id": "principal" });
      else if (fault === "duplicate_header") send(response, valid, { "content-type": ["application/vnd.dona.web-session-response", "application/vnd.dona.web-session-response"] });
      else if (fault === "principal") send(response, responseProof(proof, { result: { status: "succeeded", principal: { ...fixture.result.principal, principal_id: "other" } } }));
      else send(response, fault === "mac" ? valid + "x" : fixture.response_proof);
    });
    await assert.rejects(f.client().confirm(fixture.input, fixture.identity), error => error instanceof WebServiceError && error.message === "web_service_unverified");
    assert.equal(f.calls, 1, fault);
  }
});

test("dribbling responseも全体deadlineで止めcredential失効後は採用しない", async t => {
  const slow = await fixtureServer(t, (proof, response) => {
    const data = responseProof(proof); response.writeHead(200, { "content-type": "application/vnd.dona.web-session-response", "content-length": String(data.length), connection: "close" });
    let index = 0; const timer = setInterval(() => { response.write(data[index++]); if (index === data.length) { clearInterval(timer); response.end(); } }, 5);
    response.once("close", () => clearInterval(timer));
  });
  await assert.rejects(slow.client(40).confirm(fixture.input, fixture.identity), WebServiceError); assert.equal(slow.calls, 1);
  const revoked = await fixtureServer(t, (proof, response) => send(response, responseProof(proof)));
  await assert.rejects(revoked.client(1000, () => ({ ...credential, state: "revoked" })).confirm(fixture.input, fixture.identity), WebServiceError);
  assert.equal(revoked.calls, 1);
});

test("公開directory・socket権限・scope不一致では送信しない", async t => {
  const f = await fixtureServer(t, (proof, response) => send(response, responseProof(proof)));
  fs.chmodSync(f.directory, 0o755); await assert.rejects(f.client().confirm(fixture.input, fixture.identity), WebServiceError); fs.chmodSync(f.directory, 0o700);
  fs.chmodSync(f.socket, 0o666); await assert.rejects(f.client().confirm(fixture.input, fixture.identity), WebServiceError); fs.chmodSync(f.socket, 0o600);
  await assert.rejects(f.client().confirm(fixture.input, { ...fixture.identity, tenant_id: "other" }), WebServiceError);
  assert.equal(f.calls, 0);
});
