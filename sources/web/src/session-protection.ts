import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const utc = z.string().refine(value => { const n = Date.parse(value); return Number.isFinite(n) && new Date(n).toISOString() === value; });
const bindingSchema = z.strictObject({
  instance_id: id, tenant_id: id, principal_id: id, session_ref: id,
  session_generation: version, identity_binding_revision: version, authz_revision: version,
  issued_at: utc, expires_at: utc,
}).refine(value => Date.parse(value.expires_at) > Date.parse(value.issued_at)
  && Date.parse(value.expires_at) - Date.parse(value.issued_at) <= 8 * 3600 * 1000);
export type SessionBinding = z.infer<typeof bindingSchema>;
export interface SessionProtectionKey {
  version: number;
  purpose: "web_access_token" | "web_cookie_index" | "web_csrf" | "web_login_transaction";
  state: "active" | "verification_only" | "revoked";
  activated_at: string;
  signing_expires_at: string;
  secret: Uint8Array;
}
const envelopeSchema = z.strictObject({
  codec_version: z.literal(1), key_version: version, sealed_at: utc,
  nonce: z.string().max(16), ciphertext: z.string().min(1).max(10923), tag: z.string().max(22),
});
export type SealedAccessToken = z.infer<typeof envelopeSchema>;
export class SessionProtectionError extends Error {
  constructor() { super("session_protection_unverified"); this.name = "SessionProtectionError"; }
}
function guard<T>(action: () => T): T { try { return action(); } catch { throw new SessionProtectionError(); } }
function time(now: string): number { return Date.parse(utc.parse(now)); }
export function assertProtectionKey(key: SessionProtectionKey, purpose: SessionProtectionKey["purpose"], at: number, sign: boolean): void {
  if (key.purpose !== purpose || !["active", "verification_only"].includes(key.state)
    || !(key.secret instanceof Uint8Array) || key.secret.byteLength !== 32) throw new SessionProtectionError();
  version.parse(key.version);
  const start = time(key.activated_at); const end = time(key.signing_expires_at);
  if (end <= start || end - start > 90 * 24 * 3600 * 1000 || at < start
    || (sign && (key.state !== "active" || at >= end))) throw new SessionProtectionError();
}
function decode(value: string, bytes?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new SessionProtectionError();
  const buffer = Buffer.from(value, "base64url");
  if (buffer.toString("base64url") !== value || (bytes !== undefined && buffer.length !== bytes)) throw new SessionProtectionError();
  return buffer;
}
function binding(input: SessionBinding, now: number): SessionBinding {
  const value = bindingSchema.parse(input);
  if (now < time(value.issued_at) || now >= time(value.expires_at)) throw new SessionProtectionError();
  return value;
}
function additionalData(value: SessionBinding, keyVersion: number, sealedAt: string): Buffer {
  // Fixed positional encoding of schema-validated fields; no browser identity,
  // plaintext token, or mutable display metadata enters the authenticated data.
  return Buffer.from(JSON.stringify(["dona.web.access-token", 1, keyVersion, sealedAt,
    value.instance_id, value.tenant_id, value.principal_id, value.session_ref,
    value.session_generation, value.identity_binding_revision, value.authz_revision, value.issued_at, value.expires_at]));
}
/** Caller obtains current purpose-separated key material from the protected
 * credential store. These functions never provision keys or implement a store. */
export function sealAccessToken(token: string, input: SessionBinding, key: SessionProtectionKey, now: string): SealedAccessToken {
  return guard(() => {
    const at = time(now); const owner = binding(input, at); assertProtectionKey(key, "web_access_token", at, true);
    if (typeof token !== "string") throw new SessionProtectionError();
    const plaintext = Buffer.from(token, "utf8");
    try {
      if (plaintext.length < 1 || plaintext.length > 8192 || plaintext.toString("utf8") !== token) throw new SessionProtectionError();
      const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key.secret, nonce, { authTagLength: 16 });
      cipher.setAAD(additionalData(owner, key.version, now));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { codec_version: 1, key_version: key.version, sealed_at: now, nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
    } finally { plaintext.fill(0); }
  });
}
export function openAccessToken(input: unknown, ownerInput: SessionBinding, key: SessionProtectionKey, now: string): string {
  return guard(() => {
    const at = time(now); const owner = binding(ownerInput, at); const envelope = envelopeSchema.parse(input);
    assertProtectionKey(key, "web_access_token", at, false);
    const sealedAt = time(envelope.sealed_at);
    if (envelope.key_version !== key.version || sealedAt < time(key.activated_at) || sealedAt >= time(key.signing_expires_at)
      || sealedAt < time(owner.issued_at) || sealedAt > at) throw new SessionProtectionError();
    const ciphertext = decode(envelope.ciphertext); if (ciphertext.length < 1 || ciphertext.length > 8192) throw new SessionProtectionError();
    const decipher = createDecipheriv("aes-256-gcm", key.secret, decode(envelope.nonce, 12), { authTagLength: 16 });
    decipher.setAAD(additionalData(owner, key.version, envelope.sealed_at)); decipher.setAuthTag(decode(envelope.tag, 16));
    let first: Buffer | undefined; let plaintext: Buffer | undefined;
    try {
      first = decipher.update(ciphertext); plaintext = Buffer.concat([first, decipher.final()]);
      return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } finally { first?.fill(0); plaintext?.fill(0); }
  });
}
export function cookieDigest(cookie: string, key: SessionProtectionKey, now: string, mode: "create" | "lookup"): string {
  return guard(() => {
    if (mode !== "create" && mode !== "lookup") throw new SessionProtectionError();
    assertProtectionKey(key, "web_cookie_index", time(now), mode === "create");
    const raw = decode(cookie, 32);
    try { return createHmac("sha256", key.secret).update("dona.web.cookie-index.v1\0").update(String(key.version)).update("\0").update(raw).digest("hex"); }
    finally { raw.fill(0); }
  });
}
/** Can protect local logout even for an expired session; the caller still checks
 * the same local cookie, stored binding, exact Origin and Fetch Metadata. */
export function sessionCsrf(input: SessionBinding, key: SessionProtectionKey, now: string, mode: "create" | "existing"): string {
  return guard(() => {
    if (mode !== "create" && mode !== "existing") throw new SessionProtectionError();
    const owner = bindingSchema.parse(input); assertProtectionKey(key, "web_csrf", time(now), mode === "create");
    return createHmac("sha256", key.secret).update("dona.web.csrf.v1\0")
      .update(JSON.stringify([key.version, owner.instance_id, owner.tenant_id, owner.principal_id, owner.session_ref, owner.session_generation])).digest("base64url");
  });
}
