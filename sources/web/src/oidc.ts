import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { z } from "zod";
import { parseWebPolicy, WebBoundaryError, type WebPolicy } from "./policy.js";

const text = z.string().min(1).max(8192);
const subject = z.string().min(1).max(255);
const bearerType = z.string().refine(value => value.toLowerCase() === "bearer");
const seconds = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const audience = z.union([z.string().min(1).max(256), z.array(z.string().min(1).max(256)).min(1).max(16)]);
export const loginTransactionSchema = z.strictObject({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/), created_at: seconds, expires_at: seconds,
}).refine(t => t.expires_at - t.created_at === 300);
export type LoginTransaction = z.infer<typeof loginTransactionSchema>;
export type OnlineToken = { active: false } | { active: true; sub: string; expires_at: number };
export interface OidcTransport { fetch: typeof fetch }
export interface OidcSecrets { clientSecret(reference: string): string }
/** Reads a fresh, verified protected clock. Never use client time or an unverified
 * wall-clock fallback; the caller also rechecks its durable gate after I/O. */
export type OidcClock = () => number;
function monotonicClock(clock: OidcClock): OidcClock {
  if (typeof clock !== "function") throw new WebBoundaryError("identity_invalid");
  let previous = seconds.parse(clock());
  return () => { const current = seconds.parse(clock());
    if (current < previous) throw new WebBoundaryError("identity_invalid");
    previous = current; return current; };
}
const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const requiredAudience = (actual: string | string[], expected: string) => typeof actual === "string" ? actual === expected : actual.includes(expected) && new Set(actual).size === actual.length;

/** The caller durably creates/binds/consumes login transactions through the
 * common audit boundary. This protocol class never substitutes an in-memory
 * map for one-use state, cookie rotation, session storage, or revocation. */
export class OidcProtocol {
  private readonly policy: WebPolicy;
  constructor(policy: WebPolicy, private readonly secrets: OidcSecrets, private readonly transport: OidcTransport = { fetch: globalThis.fetch }) {
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new WebBoundaryError("deployment_invalid");
    this.policy = parseWebPolicy(policy);
  }
  createLogin(now: number): { transaction: LoginTransaction; authorization_url: string } {
    try {
      seconds.parse(now);
      const generate = () => randomBytes(32).toString("base64url");
      const transaction = loginTransactionSchema.parse({ state: generate(), nonce: generate(), verifier: generate(), created_at: now, expires_at: now + 300 });
      const target = new URL(this.policy.oidc.authorization_endpoint);
      target.search = new URLSearchParams({ response_type: "code", client_id: this.policy.oidc.client_id,
        redirect_uri: this.policy.oidc.redirect_uri, scope: "openid", state: transaction.state, nonce: transaction.nonce,
        code_challenge_method: "S256", code_challenge: createHash("sha256").update(transaction.verifier).digest("base64url") }).toString();
      return { transaction, authorization_url: target.href };
    } catch { throw new WebBoundaryError("identity_invalid"); }
  }
  private authentication(): string {
    try {
      const secret = this.secrets.clientSecret(this.policy.oidc.client_secret_ref);
      if (typeof secret !== "string" || Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 4096 || /[\r\n\0]/.test(secret)) throw new Error();
      const formComponent = (value: string) => new URLSearchParams({ x: value }).toString().slice(2);
      return "Basic " + Buffer.from(formComponent(this.policy.oidc.client_id) + ":" + formComponent(secret)).toString("base64");
    } catch { throw new WebBoundaryError("identity_unavailable"); }
  }
  private async request(endpoint: "token_endpoint" | "jwks_endpoint" | "introspection_endpoint", fields?: URLSearchParams): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new WebBoundaryError("identity_unavailable")); }, 3000); });
    const operation = async () => {
      const response = await this.transport.fetch(this.policy.oidc[endpoint], {
        method: fields ? "POST" : "GET", redirect: "error", signal: controller.signal,
        headers: { accept: "application/json", ...(fields ? { "content-type": "application/x-www-form-urlencoded", authorization: this.authentication() } : {}) },
        ...(fields ? { body: fields.toString() } : {}),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new WebBoundaryError(endpoint === "token_endpoint" && response.status === 400 ? "identity_invalid" : "identity_unavailable");
      }
      if (!/^application\/(json|jwk-set\+json)(;|$)/i.test(response.headers.get("content-type") ?? "")) {
        await response.body?.cancel(); throw new WebBoundaryError("identity_invalid");
      }
      const limit = endpoint === "jwks_endpoint" ? 128 * 1024 : 32 * 1024;
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
        await response.body?.cancel(); throw new WebBoundaryError("identity_invalid");
      }
      if (!response.body) throw new WebBoundaryError("identity_invalid");
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > limit) { await reader.cancel(); throw new WebBoundaryError("identity_invalid"); }
          chunks.push(part.value);
        }
        try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { throw new WebBoundaryError("identity_invalid"); }
      } finally { reader.releaseLock(); }
    };
    try { return await Promise.race([operation(), expired]); }
    catch (error) { if (error instanceof WebBoundaryError) throw error; throw new WebBoundaryError("identity_unavailable"); }
    finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  async inspect(accessToken: string, expectedSubject: string, clock: OidcClock): Promise<OnlineToken> {
    try {
      text.parse(accessToken); subject.parse(expectedSubject); const current = monotonicClock(clock);
      const input = await this.request("introspection_endpoint", new URLSearchParams({ token: accessToken, token_type_hint: "access_token" }));
      const now = current();
      const state = z.object({ active: z.boolean() }).parse(input);
      if (!state.active) return { active: false };
      const active = z.object({ active: z.literal(true), sub: subject, client_id: z.string(), aud: audience, exp: seconds, token_type: bearerType.optional() }).parse(input);
      if (!equal(active.sub, expectedSubject) || active.client_id !== this.policy.oidc.client_id
        || !requiredAudience(active.aud, this.policy.oidc.access_token_audience) || active.exp <= now) throw new WebBoundaryError("identity_invalid");
      return { active: true, sub: active.sub, expires_at: active.exp };
    } catch (error) { if (error instanceof WebBoundaryError) throw error; throw new WebBoundaryError("identity_invalid"); }
  }
  /** Invoke once only AFTER the server durably consumes this cookie-bound login
   * transaction. An exception never authorizes a token exchange retry. */
  async exchange(transactionInput: LoginTransaction, callback: { code: string; state: string }, clock: OidcClock): Promise<{ sub: string; access_token: string; expires_at: number }> {
    try {
      const transaction = loginTransactionSchema.parse(transactionInput); const current = monotonicClock(clock); const now = current();
      const code = z.string().min(1).max(4096).parse(callback.code);
      if (typeof callback.state !== "string" || !equal(transaction.state, callback.state) || now < transaction.created_at || now >= transaction.expires_at) throw new WebBoundaryError("identity_invalid");
      const response = await this.request("token_endpoint", new URLSearchParams({ grant_type: "authorization_code", code,
        redirect_uri: this.policy.oidc.redirect_uri, code_verifier: transaction.verifier }));
      const tokens = z.object({ access_token: text, id_token: z.string().min(1).max(16384), token_type: bearerType, expires_in: seconds.min(1), refresh_token: z.never().optional() }).parse(response);
      const header = decodeProtectedHeader(tokens.id_token);
      if (!header.kid || header.kid.length > 128 || !this.policy.oidc.algorithms.includes(header.alg as "RS256" | "ES256") || header.jku || header.jwk || header.x5u) throw new WebBoundaryError("identity_invalid");
      const jwks = z.object({ keys: z.array(z.record(z.string(), z.unknown())).min(1).max(64) }).parse(await this.request("jwks_endpoint"));
      if (jwks.keys.filter(key => key.kid === header.kid).length !== 1 || jwks.keys.some(key => ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some(name => name in key))) throw new WebBoundaryError("identity_invalid");
      const verifiedAt = current();
      const { payload } = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
        issuer: this.policy.oidc.issuer, audience: this.policy.oidc.client_id, algorithms: this.policy.oidc.algorithms,
        requiredClaims: ["iss", "sub", "aud", "exp", "iat", "nonce"], currentDate: new Date(verifiedAt * 1000), maxTokenAge: 300, clockTolerance: 0,
      });
      const claims = z.object({ sub: subject, aud: audience, exp: seconds, iat: seconds, nonce: z.string(), azp: z.string().optional() }).parse(payload);
      if (!requiredAudience(claims.aud, this.policy.oidc.client_id) || !equal(claims.nonce, transaction.nonce) || claims.iat < transaction.created_at || claims.iat > verifiedAt
        || (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== this.policy.oidc.client_id)
        || (claims.azp !== undefined && claims.azp !== this.policy.oidc.client_id)) throw new WebBoundaryError("identity_invalid");
      const online = await this.inspect(tokens.access_token, claims.sub, current);
      if (!online.active || current() >= Math.min(online.expires_at, now + tokens.expires_in, claims.exp, now + 8 * 3600)) throw new WebBoundaryError("identity_invalid");
      return { sub: claims.sub, access_token: tokens.access_token,
        expires_at: Math.min(online.expires_at, now + tokens.expires_in, claims.exp, now + 8 * 3600) };
    } catch (error) { if (error instanceof WebBoundaryError) throw error; throw new WebBoundaryError("identity_invalid"); }
  }
}
