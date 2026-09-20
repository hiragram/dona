import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { assertBrowserBoundary, assertSameOrigin, clearBrowserCookie, parseBrowserCookies, privateHeaders, setBrowserCookie, singleHeader } from "./browser.js";
import { parseOidcCallback } from "./callback.js";
import { matchWebRoute } from "./routes.js";
import { parseWebPolicy, WebBoundaryError, type WebPolicy } from "./policy.js";
import { PreloginCsrf, cookieIndexes } from "./prelogin-csrf.js";
import { openLoginTransaction, sealLoginTransaction } from "./login-protection.js";
import { assertProtectionKey, cookieDigest, sealAccessToken, type SessionBinding, type SessionProtectionKey } from "./session-protection.js";
import { subjectLookupIndexes } from "./identity-index.js";
import { encodeWebPayload, verifyWebPayload, webPayloadBinding, type StoredWebLogin, type StoredWebSession } from "./store-wire.js";
import { authReadResultSchema, validateReadBinding, type AuthReadInput } from "./read-shapes.js";
import { authWriteResultSchema, type AuthWriteInput, type AuthWriteResult } from "./write-shapes.js";
import type { BrowserAuthKeys, BrowserAuthRequest } from "./auth-controller.js";
import type { OidcProtocol } from "./oidc.js";
import type { WebAuthReadClient } from "./auth-read-client.js";
import type { WebAuthWriteClient } from "./auth-write-client.js";

type Reason = "identity_invalid" | "identity_unavailable" | "identity_mismatch" | "session_invalid" | "session_revoked"
  | "session_expired" | "origin_invalid" | "csrf_invalid" | "cookie_invalid" | "cookie_ambiguous";
type Status = 200 | 303 | 400 | 401 | 403 | 404 | 503;
export interface BrowserLoginResponse { status: Status; headers: Record<string, string | string[]>; body: string }
export interface BrowserLoginKeys extends BrowserAuthKeys { active(purpose: SessionProtectionKey["purpose"]): SessionProtectionKey }
export interface BrowserLoginConnections {
  read: Pick<WebAuthReadClient, "read">; write: Pick<WebAuthWriteClient, "mutate">; oidc: Pick<OidcProtocol, "createLogin" | "exchange">;
}
const utc = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
class LoginFailure extends Error { constructor(readonly status: Status, readonly reason: Reason) { super(reason); } }
function denied(result: Extract<AuthWriteResult["result"], { status: "denied" }>): never {
  switch (result.reason) {
    case "revision_mismatch": case "session_revoked": throw new LoginFailure(401, "session_revoked");
    case "expired": case "session_expired": throw new LoginFailure(401, "session_expired");
    case "cookie_ambiguous": throw new LoginFailure(400, "cookie_ambiguous");
    case "cookie_invalid": throw new LoginFailure(401, "cookie_invalid");
    case "identity_invalid": case "identity_mismatch": case "session_invalid": case "already_consumed": throw new LoginFailure(401, "identity_invalid");
    default: throw new LoginFailure(503, "identity_unavailable");
  }
}
const random = () => randomBytes(32).toString("base64url");
function response(status: Status, value?: unknown, headers: Record<string, string | string[]> = {}): BrowserLoginResponse {
  return { status, headers: { ...privateHeaders, "content-type": "application/json; charset=utf-8", ...headers },
    body: status === 303 ? "" : JSON.stringify(value) };
}
/** Login endpoints only. A trusted runtime supplies the generation established
 * by its durable restart/read-back gate. This class never initializes that gate,
 * enrolls a principal, starts a listener, or treats IdP claims as local roles. */
export class WebLoginController {
  private readonly policy: WebPolicy;
  private readonly prelogin = new PreloginCsrf();
  private lastTime = -Infinity;
  private clockFailed = false;
  constructor(policy: WebPolicy, private readonly connections: BrowserLoginConnections, private readonly keys: BrowserLoginKeys,
    private readonly protectedNow: () => string, private readonly generation: number) {
    this.policy = parseWebPolicy(policy); revision.parse(generation);
  }
  private now = (): string => {
    try {
      const value = utc.parse(this.protectedNow()), at = Date.parse(value);
      if (this.clockFailed || at < this.lastTime) throw Error();
      this.lastTime = at; return value;
    } catch { this.clockFailed = true; throw new LoginFailure(503, "identity_unavailable"); }
  };
  private active(purpose: SessionProtectionKey["purpose"]): SessionProtectionKey {
    const key = this.keys.active(purpose); assertProtectionKey(key, purpose, Date.parse(this.now()), true); return key;
  }
  private async read(input: AuthReadInput) {
    const result = authReadResultSchema.parse(await this.connections.read.read(input)); this.now();
    validateReadBinding(input, result, this.policy); return result;
  }
  private async write(input: AuthWriteInput) {
    const result = authWriteResultSchema.parse(await this.connections.write.mutate(input)); this.now();
    if (result.operation !== input.operation) throw new LoginFailure(503, "identity_unavailable");
    if (result.result.status === "succeeded" && result.result.kind !== "login_consumed" && result.result.generation !== this.generation)
      throw new LoginFailure(503, "identity_unavailable");
    return result.result;
  }
  async handle(request: BrowserAuthRequest): Promise<BrowserLoginResponse> {
    let auditAttempted = false;
    try {
      this.now();
      if (!(request.body instanceof Uint8Array) || request.body.byteLength > 64 || request.headers.length > 128
        || request.headers.reduce((n, [key, value]) => n + Buffer.byteLength(key) + Buffer.byteLength(value), 0) > 16384)
        throw new LoginFailure(400, "session_invalid");
      if (request.headers.some(([name]) => /^(authorization|x-(actor|email|user|principal|tenant).*)$/i.test(name)))
        throw new LoginFailure(401, "identity_invalid");
      assertBrowserBoundary(this.policy, request.headers, request.transportVerified);
      let route;
      try { route = matchWebRoute(request.method, request.target); } catch { throw new LoginFailure(404, "session_invalid"); }
      if (!["prelogin_csrf", "login_start", "login_callback"].includes(route.id)) throw new LoginFailure(404, "session_invalid");
      if (route.method === "POST") {
        assertSameOrigin(this.policy, request.headers);
        if (singleHeader(request.headers, "content-type") !== "application/json") throw new LoginFailure(400, "session_invalid");
        try { z.strictObject({}).parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body))); }
        catch { throw new LoginFailure(400, "session_invalid"); }
      } else if (request.body.byteLength !== 0) throw new LoginFailure(400, "session_invalid");
      const cookies = parseBrowserCookies(request.headers);
      if (route.id !== "login_callback") {
        const current = await this.read({ codec_version: 1, operation: "login_context" });
        if (current.operation !== "login_context" || current.bff_generation !== this.generation)
          throw new LoginFailure(503, "identity_unavailable");
        if (route.id === "prelogin_csrf") {
          const prepared = this.prelogin.issue(this.generation, this.active("web_cookie_index"), this.now());
          return response(200, { csrf_token: prepared.csrf_token }, { "set-cookie": setBrowserCookie("prelogin", prepared.cookie, 300) });
        }
        const csrf = singleHeader(request.headers, "x-dona-csrf");
        if (!cookies.prelogin || !csrf) throw new LoginFailure(403, "csrf_invalid");
        this.prelogin.consume(cookies.prelogin, csrf, this.generation, this.keys.cookies(), this.now());
        const created = this.connections.oidc.createLogin(Math.floor(Date.parse(this.now()) / 1000));
        const cookie = random(), cookieKey = this.active("web_cookie_index"), loginKey = this.active("web_login_transaction");
        const login: StoredWebLogin = { binding: { instance_id: this.policy.instance_id, tenant_id: this.policy.tenant_id,
          login_ref: "login_" + random(), bff_generation: this.generation, cookie_key_version: cookieKey.version,
          cookie_digest: cookieDigest(cookie, cookieKey, this.now(), "create"),
          created_at: new Date(created.transaction.created_at * 1000).toISOString(), expires_at: new Date(created.transaction.expires_at * 1000).toISOString() },
          payload_ref: "payload_" + random(), payload_digest: "0".repeat(64), key_version: loginKey.version, previous_session_ref: null };
        const encoded = encodeWebPayload({ codec_version: 1, purpose: "web_login_transaction", payload_ref: login.payload_ref,
          binding_digest: webPayloadBinding(login), envelope: sealLoginTransaction(created.transaction, login.binding, loginKey, this.now()) });
        login.payload_digest = encoded.digest;
        const { previous_session_ref: _unused, ...inputLogin } = login;
        const previous = cookies.session ? cookieIndexes(cookies.session, this.keys.cookies(), this.now()) : null;
        auditAttempted = true;
        const result = await this.write({ codec_version: 1, operation: "create_login", login: inputLogin, payload: encoded.payload, browser_session_cookies: previous });
        if (result.status === "denied") denied(result);
        if (result.kind !== "login_created") throw new LoginFailure(503, "identity_unavailable");
        const age = Math.floor((Date.parse(login.binding.expires_at) - Date.parse(this.now())) / 1000);
        return response(200, { authorization_url: created.authorization_url }, { "set-cookie": [setBrowserCookie("login", cookie, age), clearBrowserCookie("prelogin")] });
      }
      let callback;
      try { callback = parseOidcCallback(request.target, this.policy.oidc.issuer); } catch { throw new LoginFailure(400, "identity_invalid"); }
      if (!cookies.login) throw new LoginFailure(401, "cookie_invalid");
      const candidates = cookieIndexes(cookies.login, this.keys.cookies(), this.now()), began = Date.parse(this.now());
      auditAttempted = true;
      const consumed = await this.write({ codec_version: 1, operation: "consume_login", cookie_indexes: candidates });
      if (consumed.status === "denied") denied(consumed);
      if (consumed.kind !== "login_consumed") throw new LoginFailure(401, "identity_invalid");
      auditAttempted = false; // The consume is known durable; later authentication denial may be audited once.
      const owner = consumed.login.binding;
      if (owner.instance_id !== this.policy.instance_id || owner.tenant_id !== this.policy.tenant_id || owner.bff_generation !== this.generation
        || !candidates.some(value => value.key_version === owner.cookie_key_version && value.digest === owner.cookie_digest))
        throw new LoginFailure(503, "identity_unavailable");
      const payload = verifyWebPayload(consumed.payload, consumed.login), key = this.keys.protection("web_login_transaction", consumed.login.key_version);
      if (key.version !== consumed.login.key_version) throw new LoginFailure(503, "identity_unavailable");
      const transaction = openLoginTransaction(payload.envelope, owner, key, this.now());
      if (!timingSafeEqual(Buffer.from(transaction.state), Buffer.from(callback.state)) || callback.kind === "denied") throw new LoginFailure(401, "identity_invalid");
      const tokens = await this.connections.oidc.exchange(transaction, callback, () => Math.floor(Date.parse(this.now()) / 1000)); this.now();
      const indexes = subjectLookupIndexes({ instance_id: this.policy.instance_id, tenant_id: this.policy.tenant_id,
        issuer: this.policy.oidc.issuer, subject: tokens.sub }, this.keys.identities())
        .map(value => ({ key_version: value.identity_index_key_version, digest: value.subject_digest }));
      const current = await this.read({ codec_version: 1, operation: "principal_lookup", subject_indexes: indexes });
      if (current.operation !== "principal_lookup" || current.snapshot === null || current.snapshot.principal.state !== "active")
        throw new LoginFailure(401, "identity_invalid");
      if (current.snapshot.bff_generation !== this.generation) throw new LoginFailure(401, "session_revoked");
      const principal = current.snapshot.principal, cookie = random(), cookieKey = this.active("web_cookie_index"), csrfKey = this.active("web_csrf"), tokenKey = this.active("web_access_token");
      const issued = this.now(), expires = Math.min(Date.parse(issued) + 8 * 3600 * 1000, tokens.expires_at * 1000);
      if (Date.parse(issued) >= began + 10000 || expires <= Date.parse(issued)) throw new LoginFailure(401, "session_expired");
      const session: StoredWebSession = { state: { codec_version: 1, instance_id: this.policy.instance_id, tenant_id: this.policy.tenant_id,
        principal_id: principal.principal_id, session_ref: "session_" + random(), session_generation: 1, state: "active", bff_generation: this.generation,
        principal_revoke_generation: principal.revoke_generation, identity_binding_revision: principal.identity_binding_revision, authz_revision: principal.authz_revision,
        authenticated_at: issued, expires_at: new Date(expires).toISOString(), access_token_expires_at: new Date(tokens.expires_at * 1000).toISOString(), last_activity_at: issued },
        cookie_key_version: cookieKey.version, cookie_digest: cookieDigest(cookie, cookieKey, this.now(), "create"), csrf_key_version: csrfKey.version,
        token_key_version: tokenKey.version, payload_ref: "payload_" + random(), payload_digest: "0".repeat(64) };
      const binding: SessionBinding = { instance_id: session.state.instance_id, tenant_id: session.state.tenant_id, principal_id: principal.principal_id,
        session_ref: session.state.session_ref, session_generation: 1, identity_binding_revision: principal.identity_binding_revision,
        authz_revision: principal.authz_revision, issued_at: issued, expires_at: session.state.expires_at };
      const encoded = encodeWebPayload({ codec_version: 1, purpose: "web_access_token", payload_ref: session.payload_ref,
        binding_digest: webPayloadBinding(session), envelope: sealAccessToken(tokens.access_token, binding, tokenKey, this.now()) });
      session.payload_digest = encoded.digest;
      auditAttempted = true;
      const result = await this.write({ codec_version: 1, operation: "create_session", receipt_id: consumed.receipt_id, subject_indexes: indexes, session, payload: encoded.payload });
      if (result.status === "denied") denied(result);
      if (result.kind !== "session_created") throw new LoginFailure(401, "identity_invalid");
      const final = Date.parse(this.now());
      if (final >= began + 10000 || final >= expires) throw new LoginFailure(503, "identity_unavailable");
      return response(303, undefined, { location: "/login/complete",
        "set-cookie": [setBrowserCookie("session", cookie, Math.floor((expires - final) / 1000)), clearBrowserCookie("login")] });
    } catch (error) {
      let failure = error instanceof LoginFailure ? error : error instanceof WebBoundaryError
        ? new LoginFailure(error.code === "identity_unavailable" || error.code === "deployment_invalid" ? 503
          : error.code === "origin_invalid" || error.code === "csrf_invalid" ? 403
            : error.code === "cookie_invalid" || error.code === "cookie_ambiguous" ? 400 : 401,
          error.code === "deployment_invalid" ? "identity_unavailable" : error.code)
        : new LoginFailure(503, "identity_unavailable");
      if (!auditAttempted) {
        try {
          const result = await this.write({ codec_version: 1, operation: "record_denial", cookie_indexes: null, reason: failure.reason });
          if (result.status !== "denied" || result.reason !== failure.reason) throw Error();
        } catch { failure = new LoginFailure(503, "identity_unavailable"); }
      }
      return response(failure.status, { error: failure.reason });
    }
  }
}
