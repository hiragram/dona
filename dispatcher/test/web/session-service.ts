import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { createHmac, createHash } from "node:crypto";
import { WebSessionService } from "../../src/web/session-service.js";
import { WebAuthRepository } from "../../src/web/repository.js";
import { verifyServiceRequest, signServiceResponse, parseSessionServiceInput, type WebServiceCredential } from "../../src/web/service-auth.js";
import type { ContextKey } from "../../src/web/context.js";
import { setup, scope, activeSession } from "./fixtures.js";

const fixture = JSON.parse(fs.readFileSync(new URL("../../../test-fixtures/web-session-service-v1.json", import.meta.url), "utf8"));
const credential: WebServiceCredential = { purpose: "web_bff_service", version: 1, state: "active", ...scope,
  activated_at: "2026-09-01T00:00:00.000Z", signing_expires_at: "2026-11-01T00:00:00.000Z", secret: Buffer.alloc(32, fixture.key_byte) };
const lookup = (version: number) => version === 1 ? credential : undefined;
const contextKey: ContextKey = { purpose: "web_ingress_context", version: 1, state: "active", activated_at: credential.activated_at,
  signing_expires_at: credential.signing_expires_at, secret: Buffer.alloc(32, 99) };
function signedRequest(claims: unknown): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return payload + "." + createHmac("sha256", credential.secret).update("dona.web-service.request.v1\0").update(payload).digest("base64url");
}
function call(socketPath: string, options: { proof?: string; body?: string; target?: string; headers?: Record<string, string> } = {}) {
  return new Promise<string>((resolve, reject) => {
    const body = options.body ?? fixture.request_body;
    const request = http.request({ socketPath, path: options.target ?? "/v1/web/session/verify", method: "POST", agent: false,
      headers: { host: "dona-web-session", "content-type": "application/json", "content-length": String(Buffer.byteLength(body)),
        connection: "close", "x-dona-service-proof": options.proof ?? fixture.request_proof, ...options.headers } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk)); response.once("error", reject);
      response.once("end", () => resolve(Buffer.concat(chunks).toString()));
    });
    request.once("error", reject); request.end(body);
  });
}
async function serviceFixture(t: Parameters<typeof setup>[0]) {
  const f = setup(t); activeSession(f);
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dws-")); fs.chmodSync(directory, 0o700);
  const socket = path.join(directory, "s");
  const repository = new WebAuthRepository(f.db, f.providers, scope, version => version === 1 ? contextKey : undefined);
  const service = new WebSessionService(socket, scope, repository, lookup, () => fixture.now);
  await service.start();
  t.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { ...f, directory, socket, service, repository };
}

test("service proofの独立golden wireとdomain/scope/期限を照合する", () => {
  assert.equal(fixture.fixture_only, true);
  assert.deepEqual(parseSessionServiceInput(fixture.request_body), fixture.input);
  assert.deepEqual(verifyServiceRequest(fixture.request_proof, fixture.request_body, scope, lookup, fixture.now), fixture.request_claims);
  assert.equal(signServiceResponse(fixture.request_proof, fixture.request_body, fixture.result, scope, lookup, fixture.now), fixture.response_proof);
  for (const claims of [{ ...fixture.request_claims, key_version: 2 }, { ...fixture.request_claims, tenant_id: "other" },
    { ...fixture.request_claims, audience: "dona.bff.web-session-response" }, { ...fixture.request_claims, path: "/admin" },
    { ...fixture.request_claims, nonce: "x".repeat(43) }, { ...fixture.request_claims, issued_at: "2026-09-19T00:00:02.000Z" }]) {
    assert.throws(() => verifyServiceRequest(signedRequest(claims), fixture.request_body, scope, lookup, fixture.now));
  }
  assert.throws(() => verifyServiceRequest(fixture.request_proof, fixture.request_body + " ", scope, lookup, fixture.now));
  assert.throws(() => verifyServiceRequest(fixture.request_proof, fixture.request_body, scope, lookup, fixture.request_claims.expires_at));
  assert.throws(() => verifyServiceRequest(fixture.request_proof, fixture.request_body, scope, () => ({ ...credential, state: "revoked" }), fixture.now));
  assert.throws(() => parseSessionServiceInput(fixture.request_body.replace('"codec_version":1', '"codec_version":1,"codec_version":1')));
  let reads = 0;
  assert.throws(() => signServiceResponse(fixture.request_proof, fixture.request_body, fixture.result, scope,
    () => ++reads === 1 ? credential : { ...credential, version: 2 }, fixture.now));
});

test("activity属性は固定dashboardだけに許可しservice MACの改変を拒否する", () => {
  const input={...fixture.input,target:"/",user_navigation:true}, body=JSON.stringify(input);
  assert.deepEqual(parseSessionServiceInput(body),input);
  for(const altered of [{...input,target:"/api/session"},{...input,user_navigation:false},{...input,user_navigation:"true"}])
    assert.throws(()=>parseSessionServiceInput(JSON.stringify(altered)));
  const claims={...fixture.request_claims,body_digest:createHash("sha256").update(body).digest("hex")};
  const proof=signedRequest(claims);assert.deepEqual(verifyServiceRequest(proof,body,scope,lookup,fixture.now),claims);
  const stripped=JSON.stringify({...fixture.input,target:"/"});
  assert.throws(()=>verifyServiceRequest(proof,stripped,scope,lookup,fixture.now));
  assert.throws(()=>verifyServiceRequest(fixture.request_proof,body,scope,lookup,fixture.now));
});

test("実UDSからsession nonceと監査を確定し再送を拒否する", async t => {
  const f = await serviceFixture(t); const sequence = f.audit.verify().sequence;
  assert.equal((fs.statSync(f.socket).mode & 0o777), 0o600);
  const response = await call(f.socket); assert.equal(response, fixture.response_proof);
  assert.equal(f.readState().used_nonces.length, 1); assert.equal(f.audit.verify().sequence, sequence + 1);
  const duplicate = await call(f.socket);
  assert.deepEqual(JSON.parse(Buffer.from(duplicate.split(".")[0]!, "base64url").toString()).result, { status: "denied", reason: "already_consumed" });
  assert.equal(f.readState().used_nonces.length, 1); assert.equal(f.audit.verify().sequence, sequence + 2);
  const persisted = JSON.stringify(f.db.prepare("SELECT record_json FROM security_audit_records").all());
  assert.ok(!persisted.includes(fixture.request_proof) && !persisted.includes(fixture.input.context));
  await assert.rejects(f.service.start());
  assert.ok(fs.statSync(f.socket).isSocket()); // Duplicate start does not close the running service.
});

test("未認証・改変・余分なidentity headerはrepositoryを呼ばない", async t => {
  const f = await serviceFixture(t); const before = f.audit.verify().sequence, calls = f.anchors.calls.length;
  for (const options of [{ proof: "invalid" }, { body: fixture.request_body + " " }, { target: "/v1/web/session/verify?x=1" },
    { headers: { "x-principal-id": "principal" } }, { headers: { host: "other" } }]) await assert.rejects(call(f.socket, options));
  assert.equal(f.audit.verify().sequence, before); assert.equal(f.anchors.calls.length, calls);
  assert.equal(f.readState().used_nonces.length, 0);
});

test("anchor応答喪失後は成功を返さず自動再試行しない", async t => {
  for (const fault of ["reserve_after", "finalize_before", "finalize_after"] as const) {
    const f = await serviceFixture(t); f.anchors.fault = fault; const calls = f.anchors.calls.length;
    await assert.rejects(call(f.socket));
    assert.equal(f.anchors.calls.length - calls, fault === "reserve_after" ? 1 : 2);
    assert.equal(f.readState().used_nonces.length, fault === "reserve_after" ? 0 : 1);
  }
});

test("既存socket・公開directory・symlink parentは上書きしない", async t => {
  const f = await serviceFixture(t), before = fs.lstatSync(f.socket);
  assert.throws(() => new WebSessionService(f.socket, { ...scope, tenant_id: "other" }, f.repository, lookup, () => fixture.now));
  await assert.rejects(new WebSessionService(f.socket, scope, f.repository, lookup, () => fixture.now).start());
  assert.equal(fs.lstatSync(f.socket).ino, before.ino);
  fs.chmodSync(f.directory, 0o755);
  await assert.rejects(new WebSessionService(path.join(f.directory, "other"), scope, f.repository, lookup, () => fixture.now).start());
  fs.chmodSync(f.directory, 0o700);
  const link = path.join(f.directory, "link"); fs.symlinkSync(f.directory, link);
  await assert.rejects(new WebSessionService(path.join(link, "other"), scope, f.repository, lookup, () => fixture.now).start());
  assert.ok(fs.statSync(f.socket).isSocket());
});

test("起動後にUDS権限が変化してもrepositoryへ到達させない", async t => {
  const f = await serviceFixture(t), calls = f.anchors.calls.length;
  fs.chmodSync(f.directory, 0o755); await assert.rejects(call(f.socket)); fs.chmodSync(f.directory, 0o700);
  fs.chmodSync(f.socket, 0o666); await assert.rejects(call(f.socket)); fs.chmodSync(f.socket, 0o600);
  assert.equal(f.anchors.calls.length, calls); assert.equal(f.readState().used_nonces.length, 0);
  assert.equal(await call(f.socket), fixture.response_proof);
});

test("raw header重複・chunked body・不完全requestをboundedに拒否する", async t => {
  const f = await serviceFixture(t), before = f.anchors.calls.length;
  const socketPath = path.join(f.directory, "bounded");
  const bounded = new WebSessionService(socketPath, scope, f.repository, lookup, () => fixture.now, 100);
  await bounded.start(); t.after(() => bounded.close());
  for (const request of [
    `POST /v1/web/session/verify HTTP/1.1\r\nHost: dona-web-session\r\nContent-Type: application/json\r\nContent-Length: 1\r\nConnection: close\r\nX-Dona-Service-Proof: invalid\r\nX-Dona-Service-Proof: invalid\r\n\r\nx`,
    `POST /v1/web/session/verify HTTP/1.1\r\nHost: dona-web-session\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\nX-Dona-Service-Proof: invalid\r\n\r\n1\r\nx\r\n0\r\n\r\n`,
    `POST /v1/web/session/verify HTTP/1.1\r\nHost: dona-web-session\r\n`,
    `POST /v1/web/session/verify HTTP/1.1\r\nHost: dona-web-session\r\nContent-Type: application/json\r\nContent-Length: 100\r\nConnection: close\r\nX-Dona-Service-Proof: invalid\r\n\r\nx`,
  ]) {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(socketPath), limit = setTimeout(() => { socket.destroy(); reject(Error("fixture deadline exceeded")); }, 1500);
      socket.once("connect", () => socket.write(request)); socket.on("data", () => {}); socket.on("error", () => {});
      socket.once("close", () => { clearTimeout(limit); resolve(); });
    });
  }
  assert.equal(f.anchors.calls.length, before); assert.equal(f.readState().used_nonces.length, 0);
});
