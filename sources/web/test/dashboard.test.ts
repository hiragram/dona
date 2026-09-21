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
