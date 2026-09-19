import assert from "node:assert/strict";
import test from "node:test";
import { cookieDigest, openAccessToken, sealAccessToken, sessionCsrf, SessionProtectionError, type SessionBinding, type SessionProtectionKey } from "../src/session-protection.js";
// Synthetic fixture keys only; no credential store or production key is created.
const key = (purpose: SessionProtectionKey["purpose"]): SessionProtectionKey => ({ version: 1, purpose, state: "active", activated_at: "2026-09-01T00:00:00.000Z", signing_expires_at: "2026-11-01T00:00:00.000Z", secret: Buffer.alloc(32, 7) });
const owner: SessionBinding = { instance_id: "instance_a", tenant_id: "tenant_a", principal_id: "principal_a", session_ref: "session_a", session_generation: 1, identity_binding_revision: 1, authz_revision: 1, issued_at: "2026-09-19T00:00:00.000Z", expires_at: "2026-09-19T01:00:00.000Z" };
const now = owner.issued_at;
const token = "test-only-opaque-access-token";

test("access tokenを認証付き暗号で保護しnonceを再使用しない", () => {
  const first = sealAccessToken(token, owner, key("web_access_token"), now);
  const second = sealAccessToken(token, owner, key("web_access_token"), now);
  assert.notEqual(first.nonce, second.nonce); assert.notEqual(first.ciphertext, second.ciphertext);
  assert.ok(!JSON.stringify(first).includes(token)); assert.equal(openAccessToken(first, owner, key("web_access_token"), now), token);
});
test("principal・session・revision・期限への暗号文の差し替えを拒否する", () => {
  const sealed = sealAccessToken(token, owner, key("web_access_token"), now);
  const mutations: Partial<SessionBinding>[] = [{ instance_id: "instance_b" }, { tenant_id: "tenant_b" }, { principal_id: "principal_b" }, { session_ref: "session_b" }, { session_generation: 2 }, { identity_binding_revision: 2 }, { authz_revision: 2 }, { issued_at: "2026-09-18T23:59:59.000Z" }, { expires_at: "2026-09-19T02:00:00.000Z" }];
  for (const mutation of mutations) assert.throws(() => openAccessToken(sealed, { ...owner, ...mutation }, key("web_access_token"), now), SessionProtectionError);
  assert.throws(() => openAccessToken({ ...sealed, sealed_at: "2026-09-19T00:00:01.000Z" }, owner, key("web_access_token"), "2026-09-19T00:00:02.000Z"), SessionProtectionError);
});
test("tag・nonce・ciphertext・codec改変から平文を返さない", () => {
  const sealed = sealAccessToken(token, owner, key("web_access_token"), now);
  for (const mutation of [{ tag: Buffer.alloc(16, 3).toString("base64url") }, { tag: Buffer.alloc(15).toString("base64url") }, { nonce: Buffer.alloc(12).toString("base64url") }, { ciphertext: Buffer.from("modified").toString("base64url") }, { key_version: 2 }, { codec_version: 2 }, { secret: "unrecognized" }]) {
    assert.throws(() => openAccessToken({ ...sealed, ...mutation }, owner, key("web_access_token"), now), { message: "session_protection_unverified" });
  }
});
test("用途・key状態・session期限の違反を拒否し旧鍵は検証だけに使う", () => {
  const sealed = sealAccessToken(token, owner, key("web_access_token"), now);
  const old = { ...key("web_access_token"), state: "verification_only" as const };
  assert.equal(openAccessToken(sealed, owner, old, now), token);
  assert.throws(() => sealAccessToken(token, owner, old, now), SessionProtectionError);
  for (const invalid of [key("web_cookie_index"), { ...old, state: "revoked" as const }, { ...old, secret: Buffer.alloc(31) }]) {
    assert.throws(() => openAccessToken(sealed, owner, invalid, now), SessionProtectionError);
  }
  assert.throws(() => openAccessToken(sealed, owner, key("web_access_token"), owner.expires_at), SessionProtectionError);
  assert.throws(() => sealAccessToken(token, { ...owner, expires_at: "2026-09-19T09:00:00.000Z" }, key("web_access_token"), now), SessionProtectionError);
  assert.throws(() => sealAccessToken("x".repeat(8193), owner, key("web_access_token"), now), SessionProtectionError);
  assert.throws(() => sealAccessToken("\ud800", owner, key("web_access_token"), now), SessionProtectionError);
});
test("cookieは用途別keyed digestとしrotation後のlookupを区別する", () => {
  const cookie = Buffer.alloc(32, 8).toString("base64url"); const active = key("web_cookie_index");
  const digest = cookieDigest(cookie, active, now, "create"); assert.match(digest, /^[a-f0-9]{64}$/); assert.ok(!digest.includes(cookie));
  assert.notEqual(cookieDigest(cookie, { ...active, version: 2 }, now, "lookup"), digest);
  assert.throws(() => cookieDigest(cookie, active, now, "invalid" as never), SessionProtectionError);
  const old = { ...active, state: "verification_only" as const };
  assert.equal(cookieDigest(cookie, old, now, "lookup"), digest);
  assert.throws(() => cookieDigest(cookie, old, now, "create"), SessionProtectionError);
  assert.throws(() => cookieDigest(cookie, key("web_csrf"), now, "lookup"), SessionProtectionError);
  assert.throws(() => cookieDigest(cookie + "=", active, now, "lookup"), SessionProtectionError);
});
test("CSRFをsessionへ結合し期限後のlocal logoutでも同じ値を再構成する", () => {
  const csrf = sessionCsrf(owner, key("web_csrf"), now, "create"); assert.match(csrf, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(sessionCsrf(owner, { ...key("web_csrf"), version: 2 }, now, "create"), csrf);
  assert.notEqual(sessionCsrf({ ...owner, session_ref: "session_b" }, key("web_csrf"), now, "create"), csrf);
  assert.equal(sessionCsrf(owner, { ...key("web_csrf"), state: "verification_only" }, "2026-09-20T00:00:00.000Z", "existing"), csrf);
  assert.throws(() => sessionCsrf(owner, { ...key("web_csrf"), state: "verification_only" }, now, "create"), SessionProtectionError);
});
