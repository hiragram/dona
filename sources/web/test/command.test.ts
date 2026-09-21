import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { controllerFixture } from "./auth-controller-fixture.js";
import { deriveWebIdempotencyKey } from "../src/browser-command.js";
import { encodeWebCommandInput, signWebCommandProof, verifyWebCommandResponse } from "../src/command-wire.js";

function commandRequest(f: ReturnType<typeof controllerFixture>, target: string, value: unknown) {
  const request = f.request(target, "POST"); request.body = Buffer.from(JSON.stringify(value)); return request;
}

test("verified principalとserver導出keyだけをcommand UDSへ渡し再送で同じkeyを使う", async () => {
  const f = controllerFixture(); f.snapshot.principal.scopes = ["job:submit"];
  const seen: Array<Record<string, unknown>> = [];
  f.connections.command = { execute: async input => { seen.push(input); return { status: "succeeded", outcome: seen.length === 1 ? "created" : "reused",
    receipt_id: "web_submit_" + input.idempotency_key, job: { job_id: "job_test", status: "queued" } }; } };
  const requestId = randomBytes(32).toString("base64url"), value = { request_id: requestId, objective: "調査する", workspace: { kind: "scratch" } };
  const first = await f.controller.handle(commandRequest(f, "/api/jobs", value));
  const second = await f.controller.handle(commandRequest(f, "/api/jobs", value));
  assert.equal(first.status, 201); assert.equal(second.status, 200); assert.equal(seen.length, 2);
  assert.equal(seen[0]!.idempotency_key, seen[1]!.idempotency_key); assert.match(String(seen[0]!.idempotency_key), /^[0-9a-f]{64}$/);
  assert.notEqual(seen[0]!.idempotency_key, requestId); assert.equal(seen[0]!.browser_body, Buffer.from(JSON.stringify(value)).toString("base64url"));
  assert.notEqual(seen[0]!.context, seen[1]!.context);
});

test("idempotency keyはcontext key rotationではなくsessionの固定cookie keyへbindする", () => {
  const f = controllerFixture(), identity = { ...f.snapshot.session.state }, requestId = randomBytes(32).toString("base64url");
  const first = deriveWebIdempotencyKey(identity, requestId, f.key("web_cookie_index"), f.initial);
  const rotatedContext = { ...f.keys.context(), version: 2, secret: Buffer.alloc(32, 42) };
  assert.notDeepEqual(rotatedContext.secret, f.keys.context().secret);
  assert.equal(deriveWebIdempotencyKey(identity, requestId, f.key("web_cookie_index"), f.initial), first);
});

test("command応答はrequest proofへbindしたMACがない限り受理しない", () => {
  const now = "2026-09-19T00:00:01.000Z", scope = { instance_id: "instance", tenant_id: "tenant" };
  const credential = { purpose: "web_bff_service" as const, version: 1, state: "active" as const, ...scope,
    activated_at: "2026-09-01T00:00:00.000Z", signing_expires_at: "2026-11-01T00:00:00.000Z", secret: Buffer.alloc(32, 7) };
  const body = encodeWebCommandInput({ codec_version: 1, operation: "submit", method: "POST", target: "/api/jobs",
    context: "context", browser_body: Buffer.from("{}").toString("base64url"), idempotency_key: "a".repeat(64) });
  const requestProof = signWebCommandProof(body, scope, credential, now), request = JSON.parse(Buffer.from(requestProof.split(".")[0]!, "base64url").toString("utf8"));
  const result = { status: "denied" as const, reason: "internal_error" as const };
  const response = { codec_version: 1, key_version: 1, ...scope, request_nonce: request.nonce,
    request_body_digest: createHash("sha256").update(body).digest("hex"), request_proof_digest: createHash("sha256").update(requestProof).digest("hex"),
    issued_at: now, expires_at: request.expires_at, result };
  const payload = Buffer.from(JSON.stringify(response)).toString("base64url"), proof = payload + "." + createHmac("sha256", credential.secret)
    .update("dona.web-command.response.v1\0").update(payload).digest("base64url");
  assert.deepEqual(verifyWebCommandResponse(proof, requestProof, body, scope, () => credential, now), result);
  assert.throws(() => verifyWebCommandResponse(proof.slice(0, -1) + "A", requestProof, body, scope, () => credential, now));
  assert.throws(() => verifyWebCommandResponse(JSON.stringify(result), requestProof, body, scope, () => credential, now));
});

test("command入力のidentity・source・URL・path・token注入とoversizeをUDS送信前に拒否する", async () => {
  const f = controllerFixture(); f.snapshot.principal.scopes = ["job:submit"]; let calls = 0;
  f.connections.command = { execute: async () => { calls++; return { status: "denied", reason: "invalid_request" }; } };
  const requestId = randomBytes(32).toString("base64url"), base = { request_id: requestId, objective: "safe", workspace: { kind: "scratch" } };
  for (const patch of [{ source: "web" }, { principal_id: "other" }, { token: "secret" }, { path: "/private" }, { callback_url: "https://evil.invalid" }]) {
    const result = await f.controller.handle(commandRequest(f, "/api/jobs", { ...base, ...patch })); assert.equal(result.status, 400);
  }
  const large = await f.controller.handle(commandRequest(f, "/api/jobs", { ...base, objective: "x".repeat(65536) }));
  assert.equal(large.status, 400); assert.equal(calls, 0);
});

test("cancelのtyped denialをbounded HTTP errorへ写像し応答喪失を自動再送しない", async () => {
  const f = controllerFixture(); f.snapshot.principal.scopes = ["job:cancel:own"]; let calls = 0;
  f.connections.command = { execute: async () => { calls++; throw new Error("private /path token"); } };
  const result = await f.controller.handle(commandRequest(f, "/api/jobs/job_test/cancel", { request_id: randomBytes(32).toString("base64url") }));
  assert.equal(result.status, 503); assert.deepEqual(JSON.parse(result.body), { error: "identity_unavailable" }); assert.equal(calls, 1);
  assert.ok(!result.body.includes("private")); assert.ok(!result.body.includes("token"));
});
