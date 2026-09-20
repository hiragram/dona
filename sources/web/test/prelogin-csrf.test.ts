import assert from "node:assert/strict";
import test from "node:test";
import { PreloginCsrf } from "../src/prelogin-csrf.js";
import type { SessionProtectionKey } from "../src/session-protection.js";
const now = "2026-09-19T00:00:01.000Z";
const key: SessionProtectionKey = { purpose: "web_cookie_index", version: 1, state: "active", secret: Buffer.alloc(32, 9),
  activated_at: "2026-09-01T00:00:00.000Z", signing_expires_at: "2026-11-01T00:00:00.000Z" };
const inventory = { retained_versions: [1], keys: [key] };

test("prelogin CSRFはcookieに結合して一回だけ消費し別cookie・tokenを拒否する", () => {
  const store = new PreloginCsrf(), first = store.issue(1, key, now), second = store.issue(1, key, now);
  assert.notEqual(first.cookie, first.csrf_token); assert.notEqual(first.cookie, second.cookie);
  assert.throws(() => store.consume(first.cookie, second.csrf_token, 1, inventory, now), { code: "csrf_invalid" });
  assert.throws(() => store.consume(first.cookie, "invalid", 1, inventory, now), { code: "csrf_invalid" });
  store.consume(first.cookie, first.csrf_token, 1, inventory, now);
  assert.throws(() => store.consume(first.cookie, first.csrf_token, 1, inventory, now), { code: "csrf_invalid" });
  assert.throws(() => new PreloginCsrf().consume(second.cookie, second.csrf_token, 1, inventory, now), { code: "csrf_invalid" });
});
test("5分境界・BFF世代・時計巻戻りで既存の準備を復元しない", () => {
  for (const mode of ["expiry", "generation", "rollback", "older_generation"] as const) {
    const store = new PreloginCsrf(), value = store.issue(2, key, now);
    if (mode === "generation") store.issue(3, key, now);
    const at = mode === "expiry" ? value.expires_at : mode === "rollback" ? "2026-09-19T00:00:00.000Z" : now;
    assert.throws(() => store.consume(value.cookie, value.csrf_token, mode === "older_generation" ? 1 : mode === "generation" ? 3 : 2, inventory, at));
    assert.throws(() => store.consume(value.cookie, value.csrf_token, mode === "generation" ? 3 : 2, inventory, now));
  }
});
test("保持keyを完全照合しverification-onlyで既存CSRFだけ消費できる", () => {
  const store = new PreloginCsrf(), value = store.issue(1, key, now), next = { ...key, version: 2, secret: Buffer.alloc(32, 10) };
  for (const keys of [{ retained_versions: [1, 2], keys: [next] }, { retained_versions: [1, 2], keys: [key, key] },
    { retained_versions: [1], keys: [{ ...key, state: "revoked" as const }] }, { retained_versions: [], keys: [] }]) {
    assert.throws(() => store.consume(value.cookie, value.csrf_token, 1, keys, now));
  }
  const retired = { ...key, state: "verification_only" as const };
  assert.throws(() => store.issue(1, retired, now));
  store.consume(value.cookie, value.csrf_token, 1, { retained_versions: [1, 2], keys: [next, retired] }, now);
});
test("512件のquotaを超えず保護期限で失効した準備だけを除く", () => {
  const store = new PreloginCsrf();
  for (let i = 0; i < 512; i++) store.issue(1, key, now);
  assert.throws(() => store.issue(1, key, now), { code: "identity_unavailable" });
  const later = "2026-09-19T00:05:01.000Z", value = store.issue(1, key, later);
  store.consume(value.cookie, value.csrf_token, 1, inventory, later);
});
