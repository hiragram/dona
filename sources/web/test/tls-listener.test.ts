import assert from "node:assert/strict";
import test from "node:test";
import tls from "node:tls";
import net from "node:net";
import https from "node:https";
import { WebLoopbackTlsListener } from "../src/tls-listener.js";
import { WebTlsError } from "../src/tls-material.js";
import { certificate, publicComposition, request, tlsPolicy } from "./tls-fixture.js";
import type { WebPolicy } from "../src/policy.js";
async function raw(policy: WebPolicy, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port: Number(new URL(policy.origin).port), servername: "localhost", ca: certificate }, () => socket.write(text));
    let result = ""; socket.on("data", part => { result += part.toString(); }); socket.once("close", () => resolve(result));
    socket.once("error", reject); socket.setTimeout(16000, () => socket.destroy(new Error("fixture raw timeout")));
  });
}
test("実TLSで公開ページと固定assetを返し未知経路を認証サービスへ送らない", async t => {
  const policy = await tlsPolicy(), composition = publicComposition(policy), listener = new WebLoopbackTlsListener(policy, composition);
  t.after(() => listener.close()); await listener.start();
  for (const target of ["/login", "/login/complete", "/assets/login.js"]) {
    const reply = await request(policy, target, "GET", { cookie: "malformed" });
    assert.equal(reply.status, 200); assert.equal(reply.headers["cache-control"], "no-store"); assert.equal(reply.headers["referrer-policy"], "no-referrer");
    assert.equal(reply.headers.connection, "close"); assert.equal(reply.headers["content-length"], String(Buffer.byteLength(reply.body)));
  }
  for (const target of ["/login?private=value", "/assets/%6cogin.js", "/api/approvals/fixture", "/../login"])
    assert.equal((await request(policy, target)).status, 404);
  assert.deepEqual(composition.calls, []);
  assert.equal((await request(policy, "/login", "GET", { host: "other.invalid" })).status, 400);
  assert.equal((await request(policy, "/api/session", "GET", { "sec-fetch-site": "same-origin" })).status, 503);
  assert.deepEqual(composition.calls, ["write"]);
});
test("raw HTTPの曖昧length・chunked・header過多・upgrade・CONNECTを受付で拒否する", async t => {
  const policy = await tlsPolicy(), composition = publicComposition(policy), listener = new WebLoopbackTlsListener(policy, composition);
  t.after(() => listener.close()); await listener.start(); const host = new URL(policy.origin).host;
  for (const wire of [
    `GET /login HTTP/1.1\r\nHost: ${host}\r\nHost: ${host}\r\n\r\n`,
    `POST /api/login/csrf HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}`,
    `POST /api/login/csrf HTTP/1.1\r\nHost: ${host}\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n`,
    `POST /api/login/csrf HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 65\r\n\r\n`,
    `POST /api/login/csrf HTTP/1.1\r\nHost: ${host}\r\nExpect: 100-continue\r\nContent-Length: 2\r\n\r\n`,
    `GET /login HTTP/1.1\r\nHost: ${host}\r\nConnection: upgrade\r\nUpgrade: websocket\r\n\r\n`,
    `CONNECT localhost:443 HTTP/1.1\r\nHost: ${host}\r\n\r\n`,
    `GET /login HTTP/1.0\r\nHost: ${host}\r\n\r\n`,
    `GET /login HTTP/1.1\r\nHost: ${host}\r\n` + Array.from({ length: 129 }, (_, n) => `X-Test-${n}: x\r\n`).join("") + "\r\n",
    `GET /login HTTP/1.1\r\nHost: ${host}\r\nX-Too-Large: ${"x".repeat(17000)}\r\n\r\n`,
  ]) {
    const reply = await raw(policy, wire); assert.match(reply, /^HTTP\/1\.1 400 /);
    assert.match(reply, /cache-control: no-store/i); assert.match(reply, /referrer-policy: no-referrer/i);
    assert.ok(!reply.includes("X-Too-Large"));
  }
  assert.deepEqual(composition.calls, []);
});
test("一度だけstartしcloseは共有されbind失敗や保護時計失敗から再起動しない", async t => {
  const policy = await tlsPolicy(), composition = publicComposition(policy), listener = new WebLoopbackTlsListener(policy, composition);
  t.after(() => listener.close()); await listener.start(); await assert.rejects(listener.start(), WebTlsError);
  const other = new WebLoopbackTlsListener(policy, publicComposition(policy)); t.after(() => other.close());
  await assert.rejects(other.start(), WebTlsError); await assert.rejects(other.start(), WebTlsError);
  composition.setNow("2026-09-18T23:59:59.000Z"); await assert.rejects(request(policy, "/login"));
  const close = listener.close(); assert.equal(close, listener.close()); await close; await assert.rejects(listener.start(), WebTlsError);
  const unused = new WebLoopbackTlsListener(await tlsPolicy(), publicComposition(policy)); await unused.close(); await assert.rejects(unused.start(), WebTlsError);
  const early = new WebLoopbackTlsListener(await tlsPolicy(), publicComposition(policy)), starting = assert.rejects(early.start(), WebTlsError);
  await early.close(); await starting;
});
test("HTTP平文と遅いTLS handshakeを受け付けず固定期限で接続を閉じる", { timeout: 8000 }, async t => {
  const policy = await tlsPolicy(), listener = new WebLoopbackTlsListener(policy, publicComposition(policy));
  t.after(() => listener.close()); await listener.start(); const port = Number(new URL(policy.origin).port);
  const connect = (text: string) => new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => { if (text) socket.write(text); }); let data = "";
    socket.on("data", part => { data += part.toString(); }); socket.once("close", () => resolve(data)); socket.once("error", reject);
  });
  assert.equal(await connect("GET /login HTTP/1.1\r\nHost: localhost\r\n\r\n"), "");
  assert.equal(await connect(""), "");
});

test("socket切断後も未完了controllerの枠を保持し上限を迂回させない", async t => {
  const policy = await tlsPolicy(), composition = publicComposition(policy), pending: Array<() => void> = [];
  let entered: () => void = () => { throw Error("unexpected fixture read"); };
  composition.connections.read.read = async input => {
    assert.equal(input.operation, "login_context");
    return await new Promise(resolve => { pending.push(() => resolve({ operation: "login_context", bff_generation: 1, retained_subject_key_versions: [1] })); entered(); });
  };
  const listener = new WebLoopbackTlsListener(policy, composition); await listener.start();
  t.after(async () => { pending.forEach(resolve => resolve()); await listener.close(); });
  for (let index = 0; index < 32; index++) {
    const accepted = new Promise<void>(resolve => { entered = resolve; });
    const client = https.request({ host: "127.0.0.1", port: Number(new URL(policy.origin).port), ca: certificate, servername: "localhost", agent: false,
      method: "POST", path: "/api/login/csrf", headers: { host: new URL(policy.origin).host, origin: policy.origin,
        "sec-fetch-site": "same-origin", "content-type": "application/json", "content-length": "2" } });
    client.on("error", () => {}); client.end("{}"); await accepted;
    const closed = new Promise<void>(resolve => client.once("close", resolve)); client.destroy(); await closed;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal((await request(policy, "/login")).status, 503); assert.equal(pending.length, 32);
  pending.forEach(resolve => resolve()); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await request(policy, "/login")).status, 200); assert.deepEqual(composition.calls, []);
});

test("未handshake接続も32本で制限し追加接続を直ちに閉じる", { timeout: 3000 }, async t => {
  const policy = await tlsPolicy(), listener = new WebLoopbackTlsListener(policy, publicComposition(policy)), sockets: net.Socket[] = [];
  await listener.start(); t.after(async () => { sockets.forEach(socket => socket.destroy()); await listener.close(); });
  for (let index = 0; index < 32; index++) {
    await new Promise<void>((resolve, reject) => { const socket = net.connect(Number(new URL(policy.origin).port), "127.0.0.1", resolve); sockets.push(socket); socket.once("error", reject); });
  }
  const extra = net.connect(Number(new URL(policy.origin).port), "127.0.0.1"); sockets.push(extra);
  await new Promise<void>(resolve => { extra.once("close", () => resolve()); extra.on("error", () => {}); });
  assert.equal(extra.destroyed, true); assert.equal(sockets.slice(0, 32).every(socket => !socket.destroyed), true);
});

test("pipelineを再処理せず遅いHTTP本文もsecure接続の固定期限で閉じる", { timeout: 13000 }, async t => {
  const policy = await tlsPolicy(), composition = publicComposition(policy), listener = new WebLoopbackTlsListener(policy, composition);
  t.after(() => listener.close()); await listener.start(); const host = new URL(policy.origin).host;
  await raw(policy, `GET /login HTTP/1.1\r\nHost: ${host}\r\n\r\nGET /api/session HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
  assert.deepEqual(composition.calls, []);
  assert.equal(await raw(policy, `POST /api/login/csrf HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 2\r\n\r\n{`), "");
  assert.deepEqual(composition.calls, []);
});
