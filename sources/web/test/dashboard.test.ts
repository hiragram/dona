import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { dashboardPage, dashboardScript, dashboardStyles } from "../src/dashboard.js";
import { controllerFixture } from "./auth-controller-fixture.js";

test("authenticated dashboardは固定assetだけをCSP digestへ結合しprivate cacheを禁止する", () => {
  const response = dashboardPage();
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.match(response.headers["content-security-policy"]!, /connect-src 'self'/);
  assert.ok(response.headers["content-security-policy"]!.includes("style-src 'sha256-" + createHash("sha256").update(dashboardStyles).digest("base64") + "'"));
  assert.ok(response.headers["content-security-policy"]!.includes("script-src 'sha256-" + createHash("sha256").update(dashboardScript).digest("base64") + "'"));
  assert.ok(!response.headers["content-security-policy"]!.includes("unsafe-inline"));
  assert.ok(!/localStorage|sessionStorage|indexedDB|serviceWorker/i.test(dashboardScript));
  assert.match(response.body, /<label for="objective">/);
  assert.match(response.body, /role="status"/);
  assert.match(response.body, /<dialog id="cancel-dialog"/);
});

test("dashboard navigationだけHTMLを返しsession APIはbounded JSONのまま維持する", async () => {
  const dashboard = controllerFixture(), page = await dashboard.controller.handle(dashboard.request("/"));
  assert.equal(page.status, 200);
  assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
  assert.match(page.body, /<title>Dona ワークスペース<\/title>/);
  assert.ok(!page.body.includes(dashboard.cookie) && !page.body.includes(dashboard.token));

  const session = controllerFixture(), json = await session.controller.handle(session.request("/api/session"));
  assert.equal(json.status, 200);
  assert.equal(json.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(JSON.parse(json.body).principal.principal_id, "principal");
});

test("失効済みdashboard navigationだけsession cookieを消去してloginへ戻す", async () => {
  const dashboard = controllerFixture();
  dashboard.connections.session.confirm = async () => ({ status: "denied", reason: "session_revoked" });
  const page = await dashboard.controller.handle(dashboard.request("/"));
  assert.equal(page.status, 303);
  assert.equal(page.headers.location, "/login");
  assert.match(page.headers["set-cookie"]!, /Max-Age=0/);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.body, "");

  const api = controllerFixture();
  api.connections.session.confirm = async () => ({ status: "denied", reason: "session_revoked" });
  const json = await api.controller.handle(api.request("/api/session"));
  assert.equal(json.status, 401);
  assert.deepEqual(JSON.parse(json.body), { error: "session_revoked" });
  assert.equal(json.headers.location, undefined);
});

test("不正または重複session cookieのdashboard navigationだけloginへ戻す",async()=>{
  for(const cookieHeader of ["__Host-dona_session=short","__Host-dona_session="+"A".repeat(43)+"; __Host-dona_session="+"A".repeat(43)]){
    const dashboard=controllerFixture(),request=dashboard.request("/");request.headers=request.headers.map(([name,value])=>name==="cookie"?[name,cookieHeader]:[name,value]);const page=await dashboard.controller.handle(request);assert.equal(page.status,303);assert.equal(page.headers.location,"/login");assert.match(page.headers["set-cookie"]!,/Max-Age=0/);assert.equal(page.body,"");
    const api=controllerFixture(),apiRequest=api.request("/api/session");apiRequest.headers=apiRequest.headers.map(([name,value])=>name==="cookie"?[name,cookieHeader]:[name,value]);const json=await api.controller.handle(apiRequest);assert.equal(json.status,400);assert.equal(json.headers.location,undefined);assert.match(JSON.parse(json.body).error,/^cookie_(invalid|ambiguous)$/);
  }
});

test("不正session cookieは監査失敗時も消去してloginへ戻す",async()=>{
  for(const cookieHeader of ["__Host-dona_session=short","__Host-dona_session="+"A".repeat(43)+"; __Host-dona_session="+"A".repeat(43)]){
    const dashboard=controllerFixture();dashboard.connections.write.mutate=async()=>{throw Error("private audit details");};const request=dashboard.request("/");request.headers=request.headers.map(([name,value])=>name==="cookie"?[name,cookieHeader]:[name,value]);const page=await dashboard.controller.handle(request);assert.equal(page.status,303);assert.equal(page.headers.location,"/login");assert.match(page.headers["set-cookie"]!,/Max-Age=0/);assert.equal(page.body,"");
  }
});

test("IdP障害中のdashboard navigationはlocal logoutを持つsafe shellを返す", async () => {
  const dashboard = controllerFixture();
  dashboard.connections.oidc.introspect = async () => { throw Error("provider unavailable private detail"); };
  const page = await dashboard.controller.handle(dashboard.request("/"));
  assert.equal(page.status, 503);
  assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(page.headers["cache-control"], "no-store");
  assert.match(page.body, /id="logout"/);
  assert.match(page.body, /id="private-view" hidden/);
  assert.ok(!page.body.includes(dashboard.cookie) && !page.body.includes(dashboard.token) && !page.body.includes("provider unavailable"));

  const api = controllerFixture();
  api.connections.oidc.introspect = async () => { throw Error("provider unavailable private detail"); };
  const json = await api.controller.handle(api.request("/api/session"));
  assert.equal(json.status, 503);
  assert.deepEqual(JSON.parse(json.body), { error: "identity_unavailable" });
});

test("origin拒否のaudit失敗ではdashboard shellを返さない", async () => {
  const dashboard = controllerFixture();
  dashboard.connections.write.mutate = async () => { throw Error("private audit details"); };
  const request = dashboard.request("/");
  request.headers = [...request.headers, ["origin", "https://cross-site.test"]];
  const result = await dashboard.controller.handle(request);
  assert.equal(result.status, 503);
  assert.equal(result.headers["content-type"], "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(result.body), { error: "identity_unavailable" });
  assert.ok(!result.body.includes("<script>"));
});
