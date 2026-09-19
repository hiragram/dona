import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { createHmac } from "node:crypto";
import { WebInternalGateway } from "../../src/web/internal-gateway.js";
import { WebSessionService } from "../../src/web/session-service.js";
import { WebAuthReadService } from "../../src/web/auth-read-service.js";
import { WebAuthWriteService } from "../../src/web/auth-write-service.js";
import { WebAuthRepository } from "../../src/web/repository.js";
import type { WebServiceCredential } from "../../src/web/service-auth.js";
import type { ContextKey } from "../../src/web/context.js";
import { setup, scope, activeSession } from "./fixtures.js";

const read = JSON.parse(fs.readFileSync(new URL("../../../test-fixtures/web-auth-read-v1.json", import.meta.url), "utf8"));
const write = JSON.parse(fs.readFileSync(new URL("../../../test-fixtures/web-auth-write-v1.json", import.meta.url), "utf8"));
const session = JSON.parse(fs.readFileSync(new URL("../../../test-fixtures/web-session-service-v1.json", import.meta.url), "utf8"));
const credential: WebServiceCredential = { purpose: "web_bff_service", version: 1, state: "active", ...scope,
  activated_at: "2026-09-01T00:00:00.000Z", signing_expires_at: "2026-11-01T00:00:00.000Z", secret: Buffer.alloc(32, 0x77) };
const lookup = (version: number) => version === 1 ? credential : undefined;
const contextKey: ContextKey = { purpose: "web_ingress_context", version: 1, state: "active", activated_at: credential.activated_at,
  signing_expires_at: credential.signing_expires_at, secret: Buffer.alloc(32, 99) };
const definitions = {
  session: { path: "/v1/web/session/verify", host: "dona-web-session", domain: "dona.web-service.request.v1\0", row: session },
  read: { path: "/v1/web/auth/read", host: "dona-web-auth-read", domain: "dona.web-auth-read.request.v1\0", row: read.cases[0] },
  write: { path: "/v1/web/auth/write", host: "dona-web-auth-write", domain: "dona.web-auth-write.request.v1\0", row: write.cases[5] },
} as const;
type Kind = keyof typeof definitions;
function request(kind: Kind) {
  const definition = definitions[kind], payload = Buffer.from(JSON.stringify(definition.row.request_claims)).toString("base64url");
  return { body: definition.row.request_body as string, proof: payload + "." + createHmac("sha256", credential.secret)
    .update(definition.domain).update(payload).digest("base64url") };
}
function call(socketPath: string, kind: Kind, override: { target?: string; host?: string; proof?: string; length?: number } = {}) {
  const definition = definitions[kind], input = request(kind);
  return new Promise<string>((resolve, reject) => {
    const req = http.request({ socketPath, method: "POST", path: override.target ?? definition.path, agent: false,
      headers: { host: override.host ?? definition.host, "content-type": "application/json", connection: "close",
        "content-length": String(override.length ?? Buffer.byteLength(input.body)), "x-dona-service-proof": override.proof ?? input.proof } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk)); response.once("error", reject);
      response.once("end", () => resolve(Buffer.concat(chunks).toString()));
    });
    req.once("error", reject); req.end(input.body);
  });
}
const decode = (proof: string) => JSON.parse(Buffer.from(proof.split(".")[0]!, "base64url").toString()).result;
async function fixture(t: Parameters<typeof setup>[0], Service = WebInternalGateway, deadlineMs = 5000) {
  const f = setup(t); activeSession(f);
  const repository = new WebAuthRepository(f.db, f.providers, scope, version => version === 1 ? contextKey : undefined);
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dwg-")); fs.chmodSync(directory, 0o700);
  const socket = path.join(directory, "s"), service = new Service(socket, scope, repository, lookup, () => session.now, deadlineMs);
  await service.start(); t.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { ...f, socket, directory, service };
}

test("同じUDSでread・session確認・失効writeを固定protocolのまま接続する", async t => {
  const f = await fixture(t), inode = fs.statSync(f.socket).ino, before = f.audit.verify().sequence;
  assert.equal(decode(await call(f.socket, "read")).operation, "login_context");
  assert.equal(f.audit.verify().sequence, before);
  assert.equal(decode(await call(f.socket, "session")).status, "succeeded");
  assert.equal(decode(await call(f.socket, "write")).result.kind, "revoked");
  assert.equal(f.readState().sessions[0]!.state.state, "revoked");
  assert.equal(decode(await call(f.socket, "session")).status, "denied");
  await assert.rejects(call(f.socket, "write")); // Identical proof never receives a fresh transaction ID.
  assert.equal(f.audit.verify().sequence, before + 3);
  assert.equal(fs.statSync(f.socket).ino, inode); assert.equal(fs.statSync(f.socket).mode & 0o777, 0o600);
});

test("gatewayは別protocolのHost・proof・未知pathと個別body上限を拒否する", async t => {
  const f = await fixture(t), sequence = f.audit.verify().sequence;
  for (const kind of Object.keys(definitions) as Kind[]) {
    for (const other of Object.keys(definitions) as Kind[]) {
      if (other === kind) continue;
      await assert.rejects(call(f.socket, kind, { host: definitions[other].host }));
      await assert.rejects(call(f.socket, kind, { proof: request(other).proof }));
    }
    for (const target of ["/v1/web/admin", definitions[kind].path + "?x=1", definitions[kind].path + "/"])
      await assert.rejects(call(f.socket, kind, { target }));
    await assert.rejects(call(f.socket, kind, { length: kind === "session" ? 16385 : 32769 }));
  }
  assert.equal(f.audit.verify().sequence, sequence); assert.equal(f.readState().used_nonces.length, 0);
});

test("既存の専用serviceはgatewayの別endpointを公開しない", async t => {
  for (const [allowed, Service] of [["session", WebSessionService], ["read", WebAuthReadService], ["write", WebAuthWriteService]] as const) {
    const f = await fixture(t, Service), before = f.audit.verify().sequence;
    for (const kind of Object.keys(definitions) as Kind[]) if (kind !== allowed) await assert.rejects(call(f.socket, kind));
    assert.equal(f.audit.verify().sequence, before);
    await call(f.socket, allowed);
  }
});

test("gatewayのsocket権限変更と監査commit不明を全protocolでfail closedにする", async t => {
  const f = await fixture(t), before = f.audit.verify().sequence;
  fs.chmodSync(f.socket, 0o666);
  for (const kind of Object.keys(definitions) as Kind[]) await assert.rejects(call(f.socket, kind));
  assert.equal(f.audit.verify().sequence, before);
  fs.chmodSync(f.socket, 0o600); f.anchors.fault = "finalize_before";
  await assert.rejects(call(f.socket, "write"));
  assert.equal(f.readState().sessions[0]!.state.state, "revoked");
  const calls = f.anchors.calls.length;
  for (const kind of Object.keys(definitions) as Kind[]) await assert.rejects(call(f.socket, kind));
  assert.equal(f.anchors.calls.length, calls);
});

test("全endpointは共通の接続枠を使い未完requestを期限内に切断する", async t => {
  const f = await fixture(t, WebInternalGateway, 500), sockets: net.Socket[] = [];
  const connect = () => new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(f.socket); sockets.push(socket); socket.once("error", reject); socket.once("connect", () => resolve(socket));
  });
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  for (let i = 0; i < 32; i++) await connect();
  await assert.rejects(call(f.socket, "read"));
  await Promise.all(sockets.map(socket => socket.destroyed ? Promise.resolve() : new Promise<void>(resolve => socket.once("close", () => resolve()))));
  assert.equal(decode(await call(f.socket, "read")).operation, "login_context");
});
