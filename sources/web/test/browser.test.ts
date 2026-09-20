import assert from "node:assert/strict";
import test from "node:test";
import { parseWebPolicy, WebBoundaryError } from "../src/policy.js";
import { assertBrowserBoundary, assertCsrf, parseBrowserCookies, setBrowserCookie, privateHeaders, type RawHeaders } from "../src/browser.js";
import { fixturePolicy } from "./fixtures.js";
const token = Buffer.alloc(32, 1).toString("base64url");
const cookie = "__Host-dona_session=" + token;

test("cookieは固定属性とcanonicalな256-bit tokenだけを受け付ける", () => {
  const header = setBrowserCookie("session", token, 300);
  assert.match(header, /Secure; HttpOnly; SameSite=Strict; Max-Age=300$/); assert.ok(!header.includes("Domain"));
  assert.deepEqual(parseBrowserCookies([["Cookie", cookie]]), { session: token });
  assert.match(setBrowserCookie("login", token, 300), /SameSite=Lax/);
  assert.match(setBrowserCookie("prelogin", token, 300), /^__Host-dona_prelogin=.*SameSite=Strict; Max-Age=300$/);
  assert.deepEqual(parseBrowserCookies([["cookie", "__Host-dona_prelogin=" + token]]), { prelogin: token });
  assert.throws(() => setBrowserCookie("prelogin", token, 301), WebBoundaryError);
  assert.throws(() => setBrowserCookie("login", token, 301), WebBoundaryError);
  assert.throws(() => setBrowserCookie("session", "short", 10), WebBoundaryError);
});
test("同値を含む重複cookie・malformed cookieを選択せず拒否する", () => {
  for (const headers of [[["Cookie", cookie + "; " + cookie]], [["Cookie", cookie], ["cookie", cookie]]] as RawHeaders[]) {
    assert.throws(() => parseBrowserCookies(headers), { code: "cookie_ambiguous" });
  }
  for (const invalid of [cookie + "\n", "bad", cookie + "; bad", "__Host-dona_session=short", "a=\"quoted\"", "a=値", "a=" + "x".repeat(8193)]) {
    assert.throws(() => parseBrowserCookies([["cookie", invalid]]), { code: "cookie_invalid" });
  }
  assert.throws(() => parseBrowserCookies([["cookie", "__Host-dona_prelogin=" + token + "; __Host-dona_prelogin=" + token]]), { code: "cookie_ambiguous" });
  assert.throws(() => parseBrowserCookies([["cookie", "__Host-dona_prelogin=short"]]), { code: "cookie_invalid" });
  assert.deepEqual(parseBrowserCookies([]), {});
});
test("Host・proxy spoof・Origin・CSRFの不一致を拒否する", () => {
  const policy = fixturePolicy();
  const headers: RawHeaders = [["host", "localhost:7443"], ["origin", policy.origin], ["sec-fetch-site", "same-origin"], ["x-dona-csrf", token]];
  assertBrowserBoundary(policy, headers, true); assertCsrf(policy, headers, token);
  assert.throws(() => assertBrowserBoundary(policy, headers, false), WebBoundaryError);
  for (const [name, value] of [["host", "evil.example"], ["forwarded", "proto=https"], ["X-Forwarded-Proto", "https"], ["X-User", "operator"], ["authorization", "Bearer fake"]]) {
    assert.throws(() => assertBrowserBoundary(policy, [...headers, [name!, value!]], true), WebBoundaryError);
  }
  for (const bad of ["null", "https://localhost:7444", "http://localhost:7443", "https://evil.example"]) {
    assert.throws(() => assertCsrf(policy, headers.map(pair => pair[0] === "origin" ? ["origin", bad] : pair), token), WebBoundaryError);
  }
  assert.throws(() => assertCsrf(policy, headers.filter(([key]) => key !== "origin"), token), WebBoundaryError);
  assert.throws(() => assertCsrf(policy, headers, Buffer.alloc(32, 2).toString("base64url")), { code: "csrf_invalid" });
});
test("不完全deployment policyと未知fieldを起動設定として受け付けない", () => {
  const valid = fixturePolicy(); assert.equal(parseWebPolicy(valid).mode, "loopback");
  assert.equal(parseWebPolicy({ ...valid, oidc: { ...valid.oidc, issuer: "https://idp.example.test" } }).oidc.issuer, "https://idp.example.test");
  const invalid = [{ ...valid, origin: "http://localhost:7443" }, { ...valid, origin: "https://localhost:7443/" },
    { ...valid, mode: "internet" }, { ...valid, listener: { ...valid.listener, trust_all_proxies: true } },
    { ...valid, dispatcher_socket_path: "/fixture/../other.sock" }, { ...valid, oidc: { ...valid.oidc, redirect_uri: "https://evil.example/callback" } },
    { ...valid, oidc: { ...valid.oidc, token_endpoint: "https://idp.example.test/token#fragment" } },
    { ...valid, oidc: { ...valid.oidc, algorithms: ["none"] } }];
  for (const input of invalid) assert.throws(() => parseWebPolicy(input), { code: "deployment_invalid" });
});
test("private responseはcache・frame・Referer経由の再公開を禁止する", () => {
  assert.equal(privateHeaders["cache-control"], "no-store"); assert.equal(privateHeaders["referrer-policy"], "no-referrer");
  assert.match(privateHeaders["content-security-policy"], /frame-ancestors 'none'/); assert.equal(privateHeaders["x-content-type-options"], "nosniff");
});
