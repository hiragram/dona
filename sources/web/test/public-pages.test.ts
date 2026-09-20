import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { WebPublicPages } from "../src/public-pages.js";
import { fixturePolicy } from "./fixtures.js";
import type { BrowserAuthRequest } from "../src/auth-controller.js";
const request = (target: string): BrowserAuthRequest => ({ method: "GET", target, transportVerified: true,
  body: Buffer.alloc(0), headers: [["host", "localhost:7443"]] });
test("public完了案内はcookieに依存せず固定linkだけを返す", () => {
  const pages = new WebPublicPages(fixturePolicy()), first = pages.handle(request("/login/complete"));
  assert.equal(first.status, 200);
  for (const value of ["malformed", "__Host-dona_session=invalid; __Host-dona_session=duplicate"]) {
    const input = request("/login/complete"); input.headers = [...input.headers, ["cookie", value]];
    assert.deepEqual(pages.handle(input), first);
  }
  assert.ok(first.body.includes('href="/"')); assert.ok(!/<script|http-equiv|\/api\/|<iframe|<form/i.test(first.body));
  assert.match(first.headers["content-security-policy"]!, /script-src 'none'; connect-src 'none'/);
  assert.equal(first.headers["cache-control"], "no-store"); assert.equal(first.headers["referrer-policy"], "no-referrer");
});
test("固定scriptとinline styleだけをCSPとSRIのdigestへ結合する", () => {
  const pages = new WebPublicPages(fixturePolicy()), login = pages.handle(request("/login")), script = pages.handle(request("/assets/login.js"));
  assert.equal(login.status, 200); assert.equal(script.status, 200);
  const digest = createHash("sha256").update(script.body).digest("base64"), style = /<style>([\s\S]*?)<\/style>/.exec(login.body)![1]!;
  assert.ok(login.body.includes('integrity="sha256-' + digest + '"'));
  assert.ok(login.headers["content-security-policy"]!.includes("script-src 'sha256-" + digest + "'"));
  assert.ok(login.headers["content-security-policy"]!.includes("style-src 'sha256-" + createHash("sha256").update(style).digest("base64") + "'"));
  assert.ok(!login.headers["content-security-policy"]!.includes("unsafe-inline"));
  assert.equal(script.headers["cache-control"], "no-store"); assert.equal(script.headers["referrer-policy"], "no-referrer");
  assert.ok(!script.body.includes("__DONA_PUBLIC_LOGIN_CONFIG__"));
});
test("public routeのhost・transport・body・pathを固定しprivate routeを返さない", () => {
  const pages = new WebPublicPages(fixturePolicy());
  for (const target of ["/", "/api/session", "/login?next=other", "/login/complete?code=secret", "/assets/../login.js", "/assets/%6cogin.js", "/assets/login.js?x=1"])
    assert.equal(pages.handle(request(target)).status, 404);
  assert.equal(pages.handle({ ...request("/login"), method: "POST" }).status, 404);
  for (const input of [{ ...request("/login"), transportVerified: false }, { ...request("/login"), body: Buffer.from("x") },
    { ...request("/login"), headers: [["host", "other"]] as const },
    { ...request("/login"), headers: [["host", "localhost:7443"], ["origin", "null"]] as const }]) {
    const result = pages.handle(input); assert.equal(result.status, 400); assert.equal(result.headers["cache-control"], "no-store");
  }
});
