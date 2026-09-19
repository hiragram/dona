import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test, { type TestContext } from "node:test";
import { createHash, createHmac } from "node:crypto";
import { WebAuthReadClient } from "../src/auth-read-client.js";
import { encodeAuthReadInput, signServiceRequest, verifyServiceResponse, WebServiceError, type WebServiceCredential } from "../src/read-auth.js";
const fixture = JSON.parse(fs.readFileSync(new URL("../../../test-fixtures/web-auth-read-v1.json", import.meta.url), "utf8"));
const credential: WebServiceCredential = { purpose: "web_bff_service", version: 1, state: "active", ...fixture.scope,
  activated_at: "2026-09-01T00:00:00.000Z", signing_expires_at: "2026-11-01T00:00:00.000Z", secret: Buffer.alloc(32, fixture.key_byte) };
const lookup = (version: number) => version === 1 ? credential : undefined;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function seal(kind: string, value: unknown): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return payload + "." + createHmac("sha256", credential.secret).update(`dona.web-auth-read.${kind}.v1\0`).update(payload).digest("base64url");
}
function responseProof(proof: string, row: any, override: Record<string, unknown> = {}): string {
  const request = JSON.parse(Buffer.from(proof.split(".")[0]!, "base64url").toString());
  return seal("response", { ...row.response_claims, request_nonce: request.nonce,
    request_body_digest: request.body_digest, request_proof_digest: hash(proof), ...override });
}
type Handler = (proof: string, row: any, response: http.ServerResponse) => void;
async function fixtureServer(t: TestContext, handler: Handler) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dwrc-")); fs.chmodSync(directory, 0o700);
  const socket = path.join(directory, "s"); let calls = 0;
  const server = http.createServer((request, response) => {
    calls++; const chunks: Buffer[] = [], proof = request.headers["x-dona-service-proof"] as string;
    request.on("data", chunk => chunks.push(chunk)); request.once("end", () => {
      const claims = JSON.parse(Buffer.from(proof.split(".")[0]!, "base64url").toString());
      const body = Buffer.concat(chunks).toString();
      assert.equal(seal("request", claims), proof); assert.equal(claims.body_digest, hash(body));
      assert.equal(request.headers.host, "dona-web-auth-read"); assert.equal(request.url, "/v1/web/auth/read");
      assert.equal(request.method, "POST"); assert.ok(!JSON.stringify(request.headers).includes(Buffer.from(credential.secret).toString("base64")));
      const row = fixture.cases.find((value: any) => value.request_body === body); assert.ok(row); handler(proof, row, response);
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve)); fs.chmodSync(socket, 0o600);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); });
  return { socket, directory, get calls() { return calls; }, client: (deadline = 1000, keys = lookup) =>
    new WebAuthReadClient(socket, fixture.scope, () => credential, keys, () => fixture.now, deadline) };
}
function send(response: http.ServerResponse, body: string, extra: Record<string, string | string[]> = {}) {
  response.writeHead(200, { "content-type": "application/vnd.dona.web-auth-read-response", "content-length": String(Buffer.byteLength(body)), connection: "close", ...extra });
  response.end(body);
}

test("読取client codecは独立wireとsealed payload bindingを検証する", () => {
  assert.equal(fixture.fixture_only, true);
  for (const row of fixture.cases) {
    assert.equal(encodeAuthReadInput(row.input), row.request_body);
    assert.deepEqual(verifyServiceResponse(row.response_proof, row.request_proof, row.request_body, fixture.scope, lookup, fixture.now), row.result);
    const generated = signServiceRequest(row.request_body, fixture.scope, credential, fixture.now);
    const claims = JSON.parse(Buffer.from(generated.split(".")[0]!, "base64url").toString());
    assert.equal(seal("request", claims), generated);
    assert.deepEqual({ ...claims, nonce: row.request_claims.nonce }, row.request_claims);
    assert.throws(() => verifyServiceResponse(row.response_proof, generated, row.request_body, fixture.scope, lookup, fixture.now));
  }
  const row = fixture.cases[1];
  const badResults = [fixture.cases[2].result, { ...row.result, secret: "fixture only" },
    { ...row.result, snapshot: { ...row.result.snapshot, principal: { ...row.result.snapshot.principal, tenant_id: "other" } } },
    { ...row.result, snapshot: { ...row.result.snapshot, session: { ...row.result.snapshot.session, cookie_digest: "0".repeat(64) } } },
    { ...row.result, snapshot: { ...row.result.snapshot, payload: { ...row.result.snapshot.payload, binding_digest: "0".repeat(64) } } },
    { ...row.result, snapshot: { ...row.result.snapshot, payload: { ...row.result.snapshot.payload,
      envelope: { ...row.result.snapshot.payload.envelope, ciphertext: "dGFtcGVyZWQ" } } } }];
  for (const result of badResults) assert.throws(() => verifyServiceResponse(responseProof(row.request_proof, row, { result }),
    row.request_proof, row.request_body, fixture.scope, lookup, fixture.now), WebServiceError);
  assert.throws(() => encodeAuthReadInput({ codec_version: 1, operation: "session_lookup", cookie_indexes: [], token: "forbidden" }));
});

test("実UDSのread clientは各呼出しで再読し失効projectionも権限へ変換しない", async t => {
  let revoked = false;
  const f = await fixtureServer(t, (proof, row, response) => {
    let result = row.result;
    if (revoked && row.input.operation === "session_lookup" && row.result.snapshot) result = { ...row.result, snapshot: { ...row.result.snapshot,
      session: { ...row.result.snapshot.session, state: { ...row.result.snapshot.session.state, state: "revoked" }, payload_ref: null, payload_digest: null }, payload: null } };
    send(response, responseProof(proof, row, { result }));
  });
  const client = f.client();
  for (const row of fixture.cases) assert.deepEqual(await client.read(row.input), row.result);
  revoked = true; const current = await client.read(fixture.cases[1].input);
  assert.equal(current.operation, "session_lookup");
  if (current.operation === "session_lookup") { assert.equal(current.snapshot?.session.state.state, "revoked"); assert.equal(current.snapshot?.payload, null); }
  assert.equal(f.calls, 5);
});

test("改変・別request・別operation・失効credential・余分なresponse headerを拒否する", async t => {
  for (const fault of ["tamper", "nonce", "operation", "header", "key"] as const) {
    const f = await fixtureServer(t, (proof, row, response) => {
      let result = responseProof(proof, row);
      if (fault === "tamper") result += "x";
      if (fault === "nonce") result = responseProof(proof, row, { request_nonce: Buffer.alloc(32, 9).toString("base64url") });
      if (fault === "operation") result = responseProof(proof, row, { result: fixture.cases[2].result });
      send(response, result, fault === "header" ? { "set-cookie": "forbidden" } : {});
    });
    const keys = fault === "key" ? () => ({ ...credential, state: "revoked" as const }) : lookup;
    await assert.rejects(f.client(1000, keys).read(fixture.cases[0].input), WebServiceError); assert.equal(f.calls, 1);
  }
});

test("応答喪失とwhole-body timeoutを再送せずsocketの変更も拒否する", async t => {
  for (const fault of ["lost", "timeout", "changed"] as const) {
    const f = await fixtureServer(t, (proof, row, response) => {
      if (fault === "lost") response.destroy();
      if (fault === "changed") { fs.chmodSync(f.socket, 0o666); send(response, responseProof(proof, row)); }
    });
    await assert.rejects(f.client(fault === "timeout" ? 100 : 1000).read(fixture.cases[0].input), WebServiceError); assert.equal(f.calls, 1);
  }
});

test("private UDSを検証する前にrequestを送らず期限・scope・keyも拒否する", async t => {
  const f = await fixtureServer(t, (proof, row, response) => send(response, responseProof(proof, row)));
  fs.chmodSync(f.directory, 0o755); await assert.rejects(f.client().read(fixture.cases[0].input)); fs.chmodSync(f.directory, 0o700);
  assert.equal(f.calls, 0);
  assert.throws(() => f.client(5001));
  assert.throws(() => signServiceRequest(fixture.cases[0].request_body, fixture.scope, { ...credential, tenant_id: "other" }, fixture.now));
  assert.throws(() => signServiceRequest(fixture.cases[0].request_body, fixture.scope, { ...credential, state: "verification_only" }, fixture.now));
  const row = fixture.cases[0];
  assert.throws(() => verifyServiceResponse(row.response_proof, row.request_proof, row.request_body, fixture.scope, lookup, row.request_claims.expires_at));
});
