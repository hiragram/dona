import { timingSafeEqual } from "node:crypto";
import { WebBoundaryError, type WebPolicy } from "./policy.js";

export type RawHeaders = ReadonlyArray<readonly [string, string]>;
export const sessionCookieName = "__Host-dona_session";
export const loginCookieName = "__Host-dona_login";
export const preloginCookieName = "__Host-dona_prelogin";
const bearer = /^[A-Za-z0-9_-]{43}$/;
function randomToken(value: string): boolean {
  return bearer.test(value) && Buffer.from(value, "base64url").toString("base64url") === value;
}
export function singleHeader(headers: RawHeaders, name: string): string | undefined {
  const values = headers.filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value);
  if (values.length > 1 || values.some(value => /[\r\n\0]/.test(value))) throw new WebBoundaryError("origin_invalid");
  return values[0];
}
/** Call only on routes that use cookies; /login/complete stays public and does
 * not inspect a session, issue private bootstrap data, or automatically redirect. */
export function parseBrowserCookies(headers: RawHeaders): Readonly<{ session?: string; login?: string; prelogin?: string }> {
  const lines = headers.filter(([name]) => name.toLowerCase() === "cookie").map(([, value]) => value);
  if (lines.reduce((n, value) => n + Buffer.byteLength(value), 0) > 8192) throw new WebBoundaryError("cookie_invalid");
  const found = new Map<string, string>();
  for (const line of lines) {
    if (/[\x00-\x1f\x7f]/.test(line)) throw new WebBoundaryError("cookie_invalid");
    for (const part of line.split(";")) {
      const match = /^ *([!#$%&'*+.^_`|~0-9A-Za-z-]+)=([\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*) *$/.exec(part);
      if (!match || !match[1] || match[2] === undefined) throw new WebBoundaryError("cookie_invalid");
      const [, name, value] = match;
      if (name !== sessionCookieName && name !== loginCookieName && name !== preloginCookieName) continue;
      if (found.has(name)) throw new WebBoundaryError("cookie_ambiguous");
      if (!randomToken(value)) throw new WebBoundaryError("cookie_invalid");
      found.set(name, value);
    }
  }
  return { ...(found.has(sessionCookieName) ? { session: found.get(sessionCookieName)! } : {}),
    ...(found.has(preloginCookieName) ? { prelogin: found.get(preloginCookieName)! } : {}),
    ...(found.has(loginCookieName) ? { login: found.get(loginCookieName)! } : {}) };
}
export function setBrowserCookie(kind: "session" | "login" | "prelogin", value: string, maximumAgeSeconds: number): string {
  if (!randomToken(value) || !Number.isSafeInteger(maximumAgeSeconds) || maximumAgeSeconds < 1
    || maximumAgeSeconds > (kind === "session" ? 8 * 3600 : 300)) throw new WebBoundaryError("cookie_invalid");
  return `${kind === "session" ? sessionCookieName : kind === "login" ? loginCookieName : preloginCookieName}=${value}; Path=/; Secure; HttpOnly; SameSite=${kind === "login" ? "Lax" : "Strict"}; Max-Age=${maximumAgeSeconds}`;
}
/** Session: only after durable revoke/read-back. Login: known consume.
 * Prelogin: process-local preparation was consumed; it carries no identity. */
export function clearBrowserCookie(kind: "session" | "login" | "prelogin"): string {
  return `${kind === "session" ? sessionCookieName : kind === "login" ? loginCookieName : preloginCookieName}=; Path=/; Secure; HttpOnly; SameSite=${kind === "login" ? "Lax" : "Strict"}; Max-Age=0`;
}
export const privateHeaders = Object.freeze({
  "cache-control": "no-store", pragma: "no-cache", "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'",
  "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()", "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin", "strict-transport-security": "max-age=31536000",
});
/** transportVerified is supplied by the TLS/credential-authenticated UDS server,
 * never derived from Forwarded, X-Forwarded-Proto, or another browser header. */
export function assertBrowserBoundary(policy: WebPolicy, headers: RawHeaders, transportVerified: boolean): void {
  if (!transportVerified || singleHeader(headers, "host") !== new URL(policy.origin).host
    || headers.some(([name]) => /^(forwarded|x-forwarded-.*|x-user|x-principal.*|x-tenant.*|authorization)$/i.test(name))) {
    throw new WebBoundaryError("origin_invalid");
  }
}
export function assertSameOrigin(policy: WebPolicy, headers: RawHeaders): void {
  if (singleHeader(headers, "origin") !== policy.origin || singleHeader(headers, "sec-fetch-site") !== "same-origin") {
    throw new WebBoundaryError("origin_invalid");
  }
}
/** expected comes from the verified local session binding. The comparison does
 * not authorize a session by itself, and may also protect IdP-independent logout. */
export function assertCsrf(policy: WebPolicy, headers: RawHeaders, expected: string): void {
  assertSameOrigin(policy, headers);
  const supplied = singleHeader(headers, "x-dona-csrf");
  if (!randomToken(expected) || !supplied || !randomToken(supplied)
    || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) throw new WebBoundaryError("csrf_invalid");
}
