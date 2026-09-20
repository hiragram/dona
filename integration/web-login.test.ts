import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { WebLoginController, type BrowserLoginResponse } from "../sources/web/src/login-controller.js";
import type { BrowserAuthRequest } from "../sources/web/src/auth-controller.js";
import { loginOidcFixture } from "../sources/web/test/login-oidc-fixture.js";
import { fixture } from "./web-auth-fixture.js";

function cookie(response: BrowserLoginResponse, name: string): string {
  const headers = response.headers["set-cookie"], lines = typeof headers === "string" ? [headers] : headers ?? [];
  const value = lines.find(line => line.startsWith(name + "=")); assert.ok(value); return value.split(";", 1)[0]!;
}
async function loginFixture(t: TestContext) {
  const f = await fixture(t), oidc = await loginOidcFixture(f.local.policy, f.local.now, f.local.token);
  const controller = new WebLoginController(f.local.policy, { ...f.connections, oidc: oidc.connection },
    { ...f.local.keys, active: f.local.key }, f.local.now, 1);
  const post = (target: string): BrowserAuthRequest => f.local.request(target, "POST");
  async function start() {
    const prepared = await controller.handle(post("/api/login/csrf")); assert.equal(prepared.status, 200);
    const request = post("/api/login/start"), prelogin = cookie(prepared, "__Host-dona_prelogin");
    request.headers = request.headers.filter(([name]) => name !== "cookie" && name !== "x-dona-csrf");
    request.headers = [...request.headers, ["cookie", prelogin + "; __Host-dona_session=" + f.local.cookie], ["x-dona-csrf", JSON.parse(prepared.body).csrf_token]];
    const response = await controller.handle(request); assert.equal(response.status, 200, response.body);
    const url = new URL(JSON.parse(response.body).authorization_url);
    const callback: BrowserAuthRequest = { method: "GET", target: "/oidc/callback?code=fixture-code&state=" + url.searchParams.get("state"),
      transportVerified: true, body: Buffer.alloc(0), headers: [["host", new URL(f.local.policy.origin).host],
        ["sec-fetch-site", "cross-site"], ["cookie", cookie(response, "__Host-dona_login")]] };
    return { prepared, request, response, callback, url };
  }
  return { ...f, login: controller, oidc, post, start };
}

test("実共有repositoryでpreloginからcallback・Strict session rotationへ接続する", async t => {
  const f = await loginFixture(t), principals = f.readState().principals;
  const started = await f.start(); assert.equal(f.oidc.calls.length, 0);
  assert.match(cookie(started.prepared, "__Host-dona_prelogin"), /^__Host-dona_prelogin=/);
  assert.ok((started.response.headers["set-cookie"] as string[]).some(line => line.includes("SameSite=Lax")));
  assert.equal(f.readState().logins.length, 1);
  const result = await f.login.handle(started.callback); assert.equal(result.status, 303, result.body);
  assert.equal(result.headers.location, "/login/complete"); assert.equal(result.headers["referrer-policy"], "no-referrer");
  assert.equal(result.headers["cache-control"], "no-store"); assert.equal(result.body, "");
  const nextCookie = cookie(result, "__Host-dona_session"); assert.notEqual(nextCookie, "__Host-dona_session=" + f.local.cookie);
  assert.ok((result.headers["set-cookie"] as string[]).some(line => line.includes("SameSite=Strict")));
  const state = f.readState(); assert.equal(state.logins.length, 0); assert.equal(state.consumed_logins.length, 0);
  assert.deepEqual(state.principals, principals); assert.equal(state.sessions.find(row => row.state.session_ref === "session")!.state.state, "revoked");
  const request = f.local.request(); request.headers = request.headers.map(([name, value]) => [name, name === "cookie" ? nextCookie : value]);
  assert.equal((await f.controller.handle(request)).status, 200);
  assert.equal((await f.controller.handle(f.local.request())).status, 401);
  assert.deepEqual(f.oidc.calls, ["/token", "/jwks", "/introspect"]);
  const audit = JSON.stringify(f.db.prepare("SELECT record_json FROM security_audit_records").all());
  for (const secret of [nextCookie.split("=")[1]!, f.local.token, started.url.searchParams.get("state")!, "subject-A"])
    assert.ok(!audit.includes(secret));
});

test("prelogin再送とcallback再送は新しいloginやtoken交換を作らない", async t => {
  const f = await loginFixture(t), started = await f.start();
  const duplicate = await f.login.handle(started.request); assert.equal(duplicate.status, 403); assert.equal(f.readState().logins.length, 1);
  assert.equal((await f.login.handle(started.callback)).status, 303);
  assert.equal((await f.login.handle(started.callback)).status, 401);
  assert.deepEqual(f.oidc.calls, ["/token", "/jwks", "/introspect"]);
  assert.equal(f.readState().sessions.filter(row => row.state.state === "active").length, 1);
});

test("state・nonce・未登録subject・inactiveではconsume後にsessionを発行しない", async t => {
  for (const mode of ["state", "nonce", "subject", "inactive", "unavailable"] as const) {
    const f = await loginFixture(t), started = await f.start();
    if (mode === "state") started.callback.target = "/oidc/callback?code=fixture-code&state=" + Buffer.alloc(32, 0xff).toString("base64url");
    else f.oidc.setMode(mode);
    const result = await f.login.handle(started.callback); assert.equal(result.status, mode === "unavailable" ? 503 : 401, result.body);
    assert.equal(result.headers["set-cookie"], undefined); assert.equal(f.readState().logins.length, 0);
    assert.equal(f.readState().sessions.length, 1); assert.equal(f.readState().sessions[0]!.state.state, "active");
    assert.equal(f.oidc.calls.filter(route => route === "/token").length, mode === "state" ? 0 : 1);
    const calls = f.oidc.calls.length; assert.equal((await f.login.handle(started.callback)).status, 401); assert.equal(f.oidc.calls.length, calls);
  }
});

test("consumeまたはsession作成の応答喪失でcookieを返さず自動再writeしない", async t => {
  for (const lost of ["consume_login", "create_session"] as const) {
    const f = await loginFixture(t), started = await f.start(), mutate = f.connections.write.mutate.bind(f.connections.write);
    const writes: string[] = [];
    f.connections.write.mutate = async input => { writes.push(input.operation); const result = await mutate(input); if (input.operation === lost) throw Error("fixture response lost"); return result; };
    const result = await f.login.handle(started.callback); assert.equal(result.status, 503); assert.equal(result.headers["set-cookie"], undefined);
    assert.deepEqual(writes, lost === "consume_login" ? ["consume_login"] : ["consume_login", "create_session"]);
    assert.equal(f.readState().sessions.length, lost === "consume_login" ? 1 : 2);
  }
});

test("10秒のconsume receipt期限を延長せず遅れたIdP結果を拒否する", async t => {
  const f = await loginFixture(t), started = await f.start(), exchange = f.oidc.connection.exchange;
  f.oidc.connection.exchange = async (...args) => { const result = await exchange(...args); f.setNow("2026-09-19T00:00:12.000Z"); return result; };
  const result = await f.login.handle(started.callback); assert.equal(result.status, 401); assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(f.readState().sessions.length, 1); assert.equal(f.readState().logins.length, 0);
});

test("login開始はexact Origin・prelogin CSRFを要求しpublic GETを処理しない", async t => {
  const f = await loginFixture(t);
  const wrong = f.post("/api/login/csrf"); wrong.headers = wrong.headers.filter(([name]) => name !== "origin");
  assert.equal((await f.login.handle(wrong)).status, 403);
  assert.equal((await f.login.handle(f.post("/api/login/start"))).status, 403);
  assert.equal((await f.login.handle(f.local.request("/login/complete"))).status, 404);
  assert.equal(f.readState().logins.length, 0); assert.equal(f.oidc.calls.length, 0);
});
