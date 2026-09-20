import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { cookieDigest, type SessionProtectionKey } from "./session-protection.js";
import { WebBoundaryError } from "./policy.js";

const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const utc = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const versions = z.array(revision).min(1).max(128).refine(values => new Set(values).size === values.length);
const token = z.string().length(43).refine(value => /^[A-Za-z0-9_-]+$/.test(value)
  && Buffer.from(value, "base64url").length === 32 && Buffer.from(value, "base64url").toString("base64url") === value);
export interface CookieKeyInventory { retained_versions: readonly number[]; keys: readonly SessionProtectionKey[] }
/** Complete protected inventory only. A missing/revoked key is not a fallback. */
export function cookieIndexes(cookie: string, inventory: CookieKeyInventory, now: string) {
  const retained = versions.parse(inventory.retained_versions);
  if (inventory.keys.length !== retained.length || new Set(inventory.keys.map(key => key.version)).size !== retained.length
    || inventory.keys.some(key => !retained.includes(key.version))) throw new WebBoundaryError("identity_unavailable");
  return inventory.keys.map(key => ({ key_version: key.version, digest: cookieDigest(cookie, key, now, "lookup") }))
    .sort((a, b) => a.key_version - b.key_version);
}
interface Entry { key_version: number; cookie_digest: string; csrf_digest: Buffer; expires: number }
/** Process-local synchronizer CSRF preparation only. This is NOT the durable
 * login/nonce/audit store. It cannot grant identity or recover authority after a
 * restart. The actual OIDC login is committed and consumed by Dispatcher. */
export class PreloginCsrf {
  private generation = 0;
  private highWater = -Infinity;
  private readonly entries = new Map<string, Entry>();
  private current(generation: number, now: string): number {
    let at: number;
    try { revision.parse(generation); at = Date.parse(utc.parse(now)); }
    catch { this.entries.clear(); throw new WebBoundaryError("identity_unavailable"); }
    if (at < this.highWater || generation < this.generation) {
      this.entries.clear(); throw new WebBoundaryError("identity_unavailable");
    }
    if (generation > this.generation) this.entries.clear();
    this.generation = generation; this.highWater = at;
    for (const [index, entry] of this.entries) if (at >= entry.expires) this.entries.delete(index);
    return at;
  }
  private digest(value: string): Buffer {
    return createHash("sha256").update("dona.web.prelogin-csrf.v1\0").update(token.parse(value)).digest();
  }
  issue(generation: number, key: SessionProtectionKey, now: string): { cookie: string; csrf_token: string; expires_at: string } {
    const at = this.current(generation, now);
    if (this.entries.size >= 512) throw new WebBoundaryError("identity_unavailable");
    const cookie = randomBytes(32).toString("base64url"), csrf = randomBytes(32).toString("base64url");
    const digest = cookieDigest(cookie, key, now, "create"), index = key.version + ":" + digest;
    if (this.entries.has(index)) throw new WebBoundaryError("identity_unavailable");
    this.entries.set(index, { key_version: key.version, cookie_digest: digest, csrf_digest: this.digest(csrf), expires: at + 300000 });
    return { cookie, csrf_token: csrf, expires_at: new Date(at + 300000).toISOString() };
  }
  consume(cookie: string, csrf: string, generation: number, inventory: CookieKeyInventory, now: string): void {
    this.current(generation, now);
    const candidates = cookieIndexes(cookie, inventory, now), matches = candidates
      .map(value => ({ index: value.key_version + ":" + value.digest, entry: this.entries.get(value.key_version + ":" + value.digest) }))
      .filter(value => value.entry !== undefined);
    if (matches.length !== 1) throw new WebBoundaryError("csrf_invalid");
    const match = matches[0]!;
    let actual: Buffer;
    try { actual = this.digest(csrf); } catch { throw new WebBoundaryError("csrf_invalid"); }
    if (!timingSafeEqual(actual, match.entry!.csrf_digest)) throw new WebBoundaryError("csrf_invalid");
    this.entries.delete(match.index);
  }
}
