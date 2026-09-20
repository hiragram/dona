import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { WebLoopbackTlsListener } from "../sources/web/src/tls-listener.js";
import { request, tlsPolicy, tlsProvider, type TlsReply } from "../sources/web/test/tls-fixture.js";
import { loginOidcFixture } from "../sources/web/test/login-oidc-fixture.js";
import { fixture } from "./web-auth-fixture.js";

function cookie(reply: TlsReply, name: string): string {
  const lines = reply.headers["set-cookie"] ?? [], found = lines.find(line => line.startsWith(name + "="));
  assert.ok(found); return found.split(";", 1)[0]!;
}
async function start(t: TestContext) {
  const f = await fixture(t, await tlsPolicy()), policy = f.local.policy;
  const oidc = await loginOidcFixture(policy, f.local.now, f.local.token);
  const connections = { ...f.connections, oidc: { ...oidc.connection, introspect: f.connections.oidc.introspect.bind(f.connections.oidc) } };
  const listener = new WebLoopbackTlsListener(policy, { connections, keys: { ...f.local.keys, active: f.local.key },
    protectedNow: f.local.now, generation: 1, tls: tlsProvider });
  await listener.start(); t.after(() => listener.close());
  const post = (target: string, cookies?: string, csrf?: string) => request(policy, target, "POST", {
    origin: policy.origin, "sec-fetch-site": "same-origin", "content-type": "application/json",
    ...(cookies ? { cookie: cookies } : {}), ...(csrf ? { "x-dona-csrf": csrf } : {}) }, "{}");
  async function loginStart() {
    const prepared = await post("/api/login/csrf"); assert.equal(prepared.status, 200, prepared.body);
    const begin = await post("/api/login/start", cookie(prepared, "__Host-dona_prelogin") + "; __Host-dona_session=" + f.local.cookie,
      JSON.parse(prepared.body).csrf_token); assert.equal(begin.status, 200, begin.body);
    const url = new URL(JSON.parse(begin.body).authorization_url);
    const target = "/oidc/callback?code=fixture-code&state=" + url.searchParams.get("state");
    return { begin, target, loginCookie: cookie(begin, "__Host-dona_login") };
  }
  return { ...f, policy, listener, oidc, post, loginStart };
}
test("TLSから実UDS・監査repositoryまでlogin rotationとlocal logoutを接続する", async t => {
  const f = await start(t), before = f.readState(), complete = await request(f.policy, "/login/complete", "GET", { cookie: "malformed" });
  assert.equal(complete.status, 200); assert.deepEqual(f.readState(), before); assert.equal(f.idpCalls(), 0);
  const began = await f.loginStart(); assert.equal(began.begin.headers["set-cookie"]?.length, 2);
  assert.ok(began.begin.headers["set-cookie"]!.some(value => value.includes("SameSite=Lax")));
  const callback = await request(f.policy, began.target, "GET", { cookie: began.loginCookie, "sec-fetch-site": "cross-site" });
  assert.equal(callback.status, 303, callback.body); assert.equal(callback.headers.location, "/login/complete");
  assert.equal(callback.headers["set-cookie"]?.length, 2); assert.equal(callback.headers["referrer-policy"], "no-referrer");
  const sessionCookie = cookie(callback, "__Host-dona_session"); assert.notEqual(sessionCookie, "__Host-dona_session=" + f.local.cookie);
  const session = await request(f.policy, "/api/session", "GET", { cookie: sessionCookie, "sec-fetch-site": "same-origin" });
  assert.equal(session.status, 200, session.body); assert.equal(f.idpCalls(), 1);
  const activity = f.readState().sessions.find(row => row.state.state === "active")!.state.last_activity_at;
  const loggedOut = await f.post("/api/session/logout", sessionCookie, JSON.parse(session.body).csrf_token);
  assert.equal(loggedOut.status, 204, loggedOut.body); assert.match(loggedOut.headers["set-cookie"]![0]!, /Max-Age=0/); assert.equal(f.idpCalls(), 1);
  assert.equal(f.readState().sessions.filter(row => row.state.state === "active").length, 0);
  assert.equal(f.readState().sessions.find(row => row.state.last_activity_at === activity)!.state.last_activity_at, activity);
  assert.equal((await request(f.policy, began.target, "GET", { cookie: began.loginCookie })).status, 401);
  assert.deepEqual(f.oidc.calls, ["/token", "/jwks", "/introspect"]);
  const audit = JSON.stringify(f.db.prepare("SELECT record_json FROM security_audit_records").all());
  for (const secret of [f.local.token, sessionCookie.split("=")[1]!, new URL("https://fixture.invalid" + began.target).searchParams.get("state")!]) assert.ok(!audit.includes(secret));
});
test("TLSへの応答前にsession作成結果を失ってもcookieや自動再writeを返さない", async t => {
  const f = await start(t), began = await f.loginStart(), mutate = f.connections.write.mutate.bind(f.connections.write), writes: string[] = [];
  f.connections.write.mutate = async input => { writes.push(input.operation); const result = await mutate(input); if (input.operation === "create_session") throw Error("synthetic response lost"); return result; };
  const result = await request(f.policy, began.target, "GET", { cookie: began.loginCookie });
  assert.equal(result.status, 503); assert.equal(result.headers["set-cookie"], undefined);
  assert.deepEqual(writes, ["consume_login", "create_session"]); assert.equal(f.readState().sessions.length, 2);
});
test("TLSのraw cookieを結合せず曖昧cookieを監査denialへ渡す", async t => {
  const f = await start(t), result = await request(f.policy, "/api/session", "GET", { "sec-fetch-site": "same-origin",
    cookie: "__Host-dona_session=" + f.local.cookie + "; __Host-dona_session=" + f.local.cookie });
  assert.equal(result.status, 400); assert.deepEqual(JSON.parse(result.body), { error: "cookie_ambiguous" });
  assert.equal(f.idpCalls(), 0); assert.equal(f.readState().sessions[0]!.state.state, "active");
});

test("実TLS・署名UDS・共有監査でnavigation activityを確定しpollでは延長しない", async t => {
  const f=await start(t), before=f.readState().sessions[0]!.state;
  const headers={cookie:"__Host-dona_session="+f.local.cookie,"sec-fetch-site":"same-origin"};
  f.setNow("2026-09-19T00:00:02.000Z");
  assert.equal((await request(f.policy,"/","GET",headers)).status,200);
  assert.equal(f.readState().sessions[0]!.state.last_activity_at,before.last_activity_at);
  f.setNow("2026-09-19T00:00:03.000Z");
  const navigation={...headers,"sec-fetch-mode":"navigate","sec-fetch-dest":"document","sec-fetch-user":"?1"};
  const sequence=f.audit.verify().sequence,nonceCount=f.readState().used_nonces.length;
  const result=await request(f.policy,"/","GET",navigation);assert.equal(result.status,200,result.body);
  assert.deepEqual(f.readState().sessions[0]!.state,{...before,last_activity_at:f.local.now()});
  assert.equal(f.audit.verify().sequence,sequence+1);assert.equal(f.readState().used_nonces.length,nonceCount+1);
  f.setNow("2026-09-19T00:00:04.000Z");
  assert.equal((await request(f.policy,"/api/session","GET",navigation)).status,200);
  assert.equal(f.readState().sessions[0]!.state.last_activity_at,"2026-09-19T00:00:03.000Z");
  assert.equal(f.idpCalls(),3);
});

test("navigation確定後の応答喪失を503にしactivity writeを再送しない", async t => {
  const f=await start(t), confirm=f.connections.session.confirm.bind(f.connections.session);let calls=0;
  f.connections.session.confirm=async (...args)=>{calls++;await confirm(...args);throw Error("fixture response lost");};
  f.setNow("2026-09-19T00:00:02.000Z");const sequence=f.audit.verify().sequence;
  const result=await request(f.policy,"/","GET",{cookie:"__Host-dona_session="+f.local.cookie,"sec-fetch-site":"same-origin",
    "sec-fetch-mode":"navigate","sec-fetch-dest":"document","sec-fetch-user":"?1"});
  assert.equal(result.status,503);assert.deepEqual(JSON.parse(result.body),{error:"identity_unavailable"});
  assert.equal(result.headers["set-cookie"],undefined);assert.equal(calls,1);
  assert.equal(f.readState().sessions[0]!.state.last_activity_at,f.local.now());assert.equal(f.audit.verify().sequence,sequence+1);
});
