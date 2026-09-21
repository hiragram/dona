import { z } from "zod";
import { assertBrowserBoundary, assertCsrf, assertSameOrigin, clearBrowserCookie, parseBrowserCookies,
  privateHeaders, singleHeader, type RawHeaders } from "./browser.js";
import { evaluateSession, type SessionDenial, type SessionState } from "./domain.js";
import { ingressContextRequest, signIngressContext, type ContextIdentity, type ContextKey } from "./context.js";
import { subjectLookupIndexes, type IdentityIndexInventory } from "./identity-index.js";
import { cookieDigest, openAccessToken, sessionCsrf, type SessionBinding, type SessionProtectionKey } from "./session-protection.js";
import { authReadResultSchema, validateReadBinding, type AuthReadInput, type AuthReadResult } from "./read-shapes.js";
import { authWriteResultSchema, type AuthWriteInput } from "./write-shapes.js";
import { verifyWebPayload } from "./store-wire.js";
import { matchWebRoute } from "./routes.js";
import { parseWebPolicy, WebBoundaryError, type WebPolicy } from "./policy.js";
import type { OidcProtocol } from "./oidc.js";
import type { WebAuthReadClient } from "./auth-read-client.js";
import type { WebAuthWriteClient } from "./auth-write-client.js";
import type { WebSessionClient } from "./session-client.js";
import type { WebJobReadClient } from "./job-read-client.js";
import { maximumWebJobBrowserBodyBytes } from "./job-read-wire.js";
import type { WebCommandClient } from "./command-client.js";
import { deriveWebIdempotencyKey, parseBrowserCommand } from "./browser-command.js";
import { dashboardFailurePage, dashboardPage } from "./dashboard.js";

type Index = { key_version: number; digest: string };
type Snapshot = NonNullable<Extract<AuthReadResult, { operation: "session_lookup" }>["snapshot"]>;
type Reason = "identity_invalid" | "identity_unavailable" | "identity_mismatch" | "session_invalid" | "session_revoked"
  | "session_expired" | "origin_invalid" | "csrf_invalid" | "cookie_invalid" | "cookie_ambiguous";
type Status = 200 | 201 | 204 | 303 | 400 | 401 | 403 | 404 | 409 | 429 | 503;
export interface BrowserAuthRequest {
  method: string; target: string; headers: RawHeaders; body: Uint8Array;
  /** Trusted TLS/proxy listener result, never a request field/header. */
  transportVerified: boolean;
}
export interface BrowserAuthResponse { status: Status; headers: Record<string, string>; body: string; maximumBodyBytes?: number }
/** Current protected inventory, not browser input or an environment fallback. */
export interface BrowserAuthKeys {
  cookies(): { retained_versions: readonly number[]; keys: readonly SessionProtectionKey[] };
  protection(purpose: SessionProtectionKey["purpose"], version: number): SessionProtectionKey;
  identities(): IdentityIndexInventory;
  context(): ContextKey;
}
/** Trusted runtime composition. Production binds the authenticated UDS clients
 * and fixed OIDC protocol; these interfaces are not exposed to a browser. */
export interface BrowserAuthConnections {
  read: Pick<WebAuthReadClient, "read">;
  write: Pick<WebAuthWriteClient, "mutate">;
  session: Pick<WebSessionClient, "confirm">;
  oidc: Pick<OidcProtocol, "introspect">;
  jobRead?: Pick<WebJobReadClient, "execute">;
  command?: Pick<WebCommandClient, "execute">;
}
class AuthFailure extends Error {
  constructor(readonly status: Status, readonly reason: Reason, readonly publicReason: Reason | "durability_unavailable" = reason) { super(reason); }
}
const utc = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const versions = z.array(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)).min(1).max(128)
  .refine(values => new Set(values).size === values.length);
function binding(session: SessionState): SessionBinding {
  return { instance_id: session.instance_id, tenant_id: session.tenant_id, principal_id: session.principal_id,
    session_ref: session.session_ref, session_generation: session.session_generation, identity_binding_revision: session.identity_binding_revision,
    authz_revision: session.authz_revision, issued_at: session.authenticated_at, expires_at: session.expires_at };
}
function failure(reason: SessionDenial): AuthFailure {
  if (reason === "clock_anomaly") return new AuthFailure(503, "identity_unavailable");
  return new AuthFailure(401, reason === "revision_mismatch" ? "session_revoked" : reason);
}
function response(status: Status, value?: unknown, clear = false, maximumBodyBytes?: number): BrowserAuthResponse {
  return { status, headers: { ...privateHeaders, ...(status === 204 || status === 303 ? {} : { "content-type": "application/json; charset=utf-8" }),
    ...(clear ? { "set-cookie": clearBrowserCookie("session") } : {}) }, body: status === 204 || status === 303 ? "" : JSON.stringify(value), ...(maximumBodyBytes?{maximumBodyBytes}:{}) };
}
function loginRedirect(): BrowserAuthResponse {
  return { status: 303, headers: { ...privateHeaders, location: "/login", "set-cookie": clearBrowserCookie("session") }, body: "" };
}
function eventResponse(event:string,id:string,value:unknown):BrowserAuthResponse {const body=`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
  return{status:200,headers:{...privateHeaders,"content-type":"text/event-stream; charset=utf-8","x-accel-buffering":"no"},body,maximumBodyBytes:maximumWebJobBrowserBodyBytes};}

/** Browser session endpoints only. No listener, login fallback, job/approval
 * capability or UI is created by this controller. Every async boundary must
 * retain current protected time and authenticated repository binding. */
export class WebAuthController {
  private readonly policy: WebPolicy;
  constructor(policy: WebPolicy, private readonly connections: BrowserAuthConnections,
    private readonly keys: BrowserAuthKeys, private readonly protectedNow: () => string, private readonly generation: number) {
    this.policy = parseWebPolicy(policy);
    z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).parse(generation);
  }
  private clock(): () => string {
    let previous = -Infinity;
    return () => {
      const now = utc.parse(this.protectedNow()), at = Date.parse(now);
      if (at < previous) throw new AuthFailure(503, "identity_unavailable");
      previous = at; return now;
    };
  }
  private candidates(cookie: string, now: string): Index[] {
    const inventory = this.keys.cookies(), retained = versions.parse(inventory.retained_versions);
    if (inventory.keys.length !== retained.length || new Set(inventory.keys.map(key => key.version)).size !== retained.length
      || inventory.keys.some(key => !retained.includes(key.version))) throw new AuthFailure(503, "identity_unavailable");
    return inventory.keys.map(key => ({ key_version: key.version, digest: cookieDigest(cookie, key, now, "lookup") }))
      .sort((a, b) => a.key_version - b.key_version);
  }
  private async read(input: AuthReadInput, now: () => string): Promise<AuthReadResult> {
    const result = authReadResultSchema.parse(await this.connections.read.read(input)); now();
    validateReadBinding(input, result, this.policy);
    if ((result.operation === "login_context" && result.bff_generation !== this.generation)
      || (result.operation !== "login_context" && result.snapshot !== null && result.snapshot.bff_generation !== this.generation))
      throw new AuthFailure(401, "session_revoked");
    return result;
  }
  private async local(candidates: Index[], now: () => string): Promise<Snapshot> {
    const result = await this.read({ codec_version: 1, operation: "session_lookup", cookie_indexes: candidates }, now);
    if (result.operation !== "session_lookup" || result.snapshot === null) throw new AuthFailure(401, "session_invalid");
    return result.snapshot;
  }
  private async write(input: AuthWriteInput, now: () => string) {
    const result = authWriteResultSchema.parse(await this.connections.write.mutate(input)); now();
    if (result.operation !== input.operation) throw new AuthFailure(503, "identity_unavailable");
    return result.result;
  }
  private csrf(snapshot: Snapshot, now: string): string {
    const key = this.keys.protection("web_csrf", snapshot.session.csrf_key_version);
    if (key.version !== snapshot.session.csrf_key_version) throw new AuthFailure(503, "identity_unavailable");
    return sessionCsrf(binding(snapshot.session.state), key, now, "existing");
  }
  async handle(request: BrowserAuthRequest): Promise<BrowserAuthResponse> {
    const now = this.clock(); let candidates: Index[] | null = null, auditAttempted = false, dashboard = false;
    try {
      now();
      if (!(request.body instanceof Uint8Array) || request.body.byteLength > 65536 || request.headers.length > 128
        || request.headers.reduce((n, [key, value]) => n + Buffer.byteLength(key) + Buffer.byteLength(value), 0) > 16384)
        throw new AuthFailure(400, "session_invalid");
      if (request.headers.some(([name]) => /^(authorization|x-(actor|email|user|principal|tenant).*)$/i.test(name)))
        throw new AuthFailure(401, "identity_invalid");
      assertBrowserBoundary(this.policy, request.headers, request.transportVerified);
      let route;
      try { route = matchWebRoute(request.method, request.target); } catch { throw new AuthFailure(404, "session_invalid"); }
      dashboard = route.id === "dashboard";
      if (!["dashboard", "session", "local_csrf", "logout", "logout_status", "job_list", "job_read", "job_events", "job_submit", "job_cancel"].includes(route.id)) throw new AuthFailure(404, "session_invalid");
      let jobCursor:string|undefined,jobLimit:number|undefined;
      if(route.id==="job_list"){
        const url=new URL(request.target,this.policy.origin),keys=[...url.searchParams.keys()];
        if(keys.some(key=>!["cursor","limit"].includes(key))||new Set(keys).size!==keys.length)throw new AuthFailure(400,"session_invalid");
        const rawCursor=url.searchParams.get("cursor"),rawLimit=url.searchParams.get("limit");
        if(rawCursor!==null){if(!/^[A-Za-z0-9_-]{43}$/.test(rawCursor))throw new AuthFailure(400,"session_invalid");jobCursor=rawCursor;}
        if(rawLimit!==null){jobLimit=Number(rawLimit);if(!/^[1-9][0-9]?$/.test(rawLimit)||jobLimit>50)throw new AuthFailure(400,"session_invalid");}
      }
      let browserCommand: ReturnType<typeof parseBrowserCommand> | undefined;
      if (route.method === "POST") {
        assertSameOrigin(this.policy, request.headers);
        if (singleHeader(request.headers, "content-type") !== "application/json") throw new AuthFailure(400, "session_invalid");
        try {
          if (["job_submit", "job_cancel"].includes(route.id)) browserCommand = parseBrowserCommand(route.id, request.body);
          else z.strictObject({}).parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body)));
        }
        catch { throw new AuthFailure(400, "session_invalid"); }
      } else {
        const origin = singleHeader(request.headers, "origin");
        if (singleHeader(request.headers, "sec-fetch-site") !== "same-origin" || (origin !== undefined && origin !== this.policy.origin))
          throw new AuthFailure(403, "origin_invalid");
        if (request.body.byteLength !== 0) throw new AuthFailure(400, "session_invalid");
      }
      const cookie = parseBrowserCookies(request.headers).session;
      if (!cookie) throw new AuthFailure(401, "cookie_invalid");
      candidates = this.candidates(cookie, now());
      const snapshot = await this.local(candidates, now), session = snapshot.session.state;
      const cookieIndex = candidates.find(candidate => candidate.key_version === snapshot.session.cookie_key_version
        && candidate.digest === snapshot.session.cookie_digest);
      if (!cookieIndex) throw new AuthFailure(401, "cookie_invalid");
      const csrf = this.csrf(snapshot, now());
      if (route.id === "local_csrf") return response(200, { csrf_token: csrf });
      if (["job_submit", "job_cancel"].includes(route.id)) assertCsrf(this.policy, request.headers, csrf);
      if (route.id === "logout" || route.id === "logout_status") {
        assertCsrf(this.policy, request.headers, csrf);
        if (route.id === "logout_status") {
          const revoked = session.state === "revoked" && snapshot.payload === null;
          return response(200, { revoked }, revoked);
        }
        auditAttempted = true;
        try {
          const result = await this.write({ codec_version: 1, operation: "revoke_session", session_ref: session.session_ref, cookie: cookieIndex }, now);
          if (result.status !== "succeeded" || result.kind !== "revoked") throw Error();
          const after = await this.local(candidates, now);
          if (after.session.state.session_ref !== session.session_ref || after.session.state.state !== "revoked" || after.payload !== null
            || after.session.cookie_key_version !== cookieIndex.key_version || after.session.cookie_digest !== cookieIndex.digest) throw Error();
          return response(204, undefined, true);
        } catch { throw new AuthFailure(503, "identity_unavailable", "durability_unavailable"); }
      }
      let decision = evaluateSession(snapshot.principal, session, { instance_id: this.policy.instance_id, tenant_id: this.policy.tenant_id,
        bff_generation: snapshot.bff_generation }, now());
      if (!decision.allowed) throw failure(decision.reason);
      const payload = verifyWebPayload(snapshot.payload, snapshot.session);
      const tokenKey = this.keys.protection("web_access_token", snapshot.session.token_key_version);
      if (tokenKey.version !== snapshot.session.token_key_version) throw new AuthFailure(503, "identity_unavailable");
      const token = openAccessToken(payload.envelope, binding(session), tokenKey, now());
      const rejectIdentity = async (): Promise<never> => {
        auditAttempted = true;
        const result = await this.write({ codec_version: 1, operation: "revoke_inactive", session_ref: session.session_ref, cookie: cookieIndex }, now);
        if (result.status !== "denied" || result.reason !== "identity_invalid") throw new AuthFailure(503, "identity_unavailable");
        throw new AuthFailure(401, "identity_invalid");
      };
      let online;
      try { online = await this.connections.oidc.introspect(token, () => Math.floor(Date.parse(now()) / 1000)); now(); }
      catch (error) {
        if (error instanceof WebBoundaryError && error.code === "identity_invalid") return await rejectIdentity();
        throw error;
      }
      if (!online.active) return await rejectIdentity();
      const subjectIndexes = subjectLookupIndexes({ instance_id: this.policy.instance_id, tenant_id: this.policy.tenant_id,
        issuer: this.policy.oidc.issuer, subject: online.sub }, this.keys.identities())
        .map(index => ({ key_version: index.identity_index_key_version, digest: index.subject_digest }));
      const current = await this.read({ codec_version: 1, operation: "principal_lookup", subject_indexes: subjectIndexes }, now);
      if (current.operation !== "principal_lookup") throw new AuthFailure(503, "identity_unavailable");
      if (current.snapshot === null || current.snapshot.principal.principal_id !== session.principal_id) return await rejectIdentity();
      decision = evaluateSession(current.snapshot.principal, session, { instance_id: this.policy.instance_id, tenant_id: this.policy.tenant_id,
        bff_generation: current.snapshot.bff_generation }, now());
      if (!decision.allowed) throw failure(decision.reason);
      const issued = now(), deadline = Math.min(Date.parse(issued) + 10000, Date.parse(session.expires_at), online.expires_at * 1000);
      const identity: ContextIdentity = { instance_id: session.instance_id, tenant_id: session.tenant_id, principal_id: session.principal_id,
        session_ref: session.session_ref, session_generation: session.session_generation, principal_revoke_generation: session.principal_revoke_generation,
        identity_binding_revision: session.identity_binding_revision, authz_revision: session.authz_revision, bff_generation: session.bff_generation };
      const context = signIngressContext(identity, ingressContextRequest(request.method, request.target, request.body), this.keys.context(), issued, new Date(deadline).toISOString());
      if (["job_list","job_read","job_events"].includes(route.id)) {
        if (!this.connections.jobRead) throw new AuthFailure(503,"identity_unavailable");
        let cursor=jobCursor,limit=jobLimit;
        if(route.id==="job_events") {cursor=singleHeader(request.headers,"last-event-id");if(!cursor||!/^[A-Za-z0-9_-]{43}$/.test(cursor))throw new AuthFailure(400,"session_invalid");}
        auditAttempted=true;const result=await this.connections.jobRead.execute({codec_version:1,operation:route.id==="job_list"?"list":route.id==="job_read"?"detail":"events",
          method:"GET",target:request.target,context,...(cursor?{cursor}:{}),...(limit?{limit}:{})});
        if(Date.parse(now())>=deadline)throw new AuthFailure(503,"identity_unavailable");
        if(result.status==="denied"){const publicReason=result.reason==="internal_error"?"identity_unavailable":result.reason;
          return response(publicReason==="not_found"?404:publicReason==="scope_denied"?403:
            publicReason==="invalid_request"?400:publicReason==="cursor_invalid"?409:503,{error:publicReason});}
        if(result.kind==="events")return eventResponse(result.reset_required?"reset":result.changed?"job":"heartbeat",result.event_cursor,
          result.reset_required?{reset_required:true}:{job:result.job});
        return response(200,result.kind==="list"?{items:result.items,next_cursor:result.next_cursor}:{job:result.job,event_cursor:result.event_cursor},false,maximumWebJobBrowserBodyBytes);
      }
      if (browserCommand && ["job_submit", "job_cancel"].includes(route.id)) {
        if (!this.connections.command) throw new AuthFailure(503, "identity_unavailable");
        auditAttempted = true;
        const command = await this.connections.command.execute({ codec_version: 1, operation: route.id === "job_submit" ? "submit" : "cancel",
          method: "POST", target: request.target, context, browser_body: Buffer.from(request.body).toString("base64url"),
          idempotency_key: deriveWebIdempotencyKey(identity, browserCommand.request_id,
            this.keys.protection("web_cookie_index", snapshot.session.cookie_key_version), issued) });
        if (Date.parse(now()) >= deadline) throw new AuthFailure(503, "identity_unavailable");
        if (command.status === "denied") {
          const status: Status = command.reason === "invalid_request" ? 400 : command.reason === "scope_denied" || command.reason === "owner_mismatch" ? 403
            : command.reason === "not_found" ? 404 : command.reason === "quota_exceeded" ? 429
              : command.reason === "identity_unavailable" || command.reason === "acceptance_unknown" || command.reason === "internal_error" ? 503 : 409;
          return response(status, { error: command.reason });
        }
        return response(command.outcome === "created" ? 201 : 200, command);
      }
      const target = route.id === "dashboard" ? "/" : "/api/session";
      // Fetch MetadataはBFFでのみ解釈し、選択結果をUDS request全体のMACへ結ぶ。
      // poll/SSEやprogrammatic fetchをuser navigationとして保存しない。
      const userNavigation = route.id === "dashboard" && singleHeader(request.headers, "sec-fetch-mode") === "navigate"
        && singleHeader(request.headers, "sec-fetch-dest") === "document" && singleHeader(request.headers, "sec-fetch-user") === "?1";
      auditAttempted = true;
      const confirmation = await this.connections.session.confirm({ codec_version: 1, method: "GET", target, context,
        ...(userNavigation ? { user_navigation: true as const } : {}) }, identity);
      if (Date.parse(now()) >= deadline) throw new AuthFailure(503, "identity_unavailable");
      if (confirmation.status === "denied") {
        switch (confirmation.reason) {
          case "session_revoked": case "revision_mismatch": throw new AuthFailure(401, "session_revoked");
          case "session_expired": throw new AuthFailure(401, "session_expired");
          case "identity_mismatch": throw new AuthFailure(401, "identity_mismatch");
          case "session_invalid": case "proof_invalid": case "already_consumed": throw new AuthFailure(401, "session_invalid");
          default: throw new AuthFailure(503, "identity_unavailable");
        }
      }
      const currentCsrf = this.csrf(snapshot, now());
      if (Date.parse(now()) >= deadline) throw new AuthFailure(503, "identity_unavailable");
      if (route.id === "dashboard") return dashboardPage();
      return response(200, { principal: confirmation.principal, csrf_token: currentCsrf });
    } catch (error) {
      let failure = error instanceof AuthFailure ? error : error instanceof WebBoundaryError
        ? new AuthFailure(error.code === "identity_unavailable" || error.code === "deployment_invalid" ? 503
          : error.code === "origin_invalid" || error.code === "csrf_invalid" ? 403
            : error.code === "cookie_invalid" || error.code === "cookie_ambiguous" ? 400 : 401,
        error.code === "deployment_invalid" ? "identity_unavailable" : error.code)
        : new AuthFailure(503, "identity_unavailable");
      if (!auditAttempted) {
        try {
          const result = await this.write({ codec_version: 1, operation: "record_denial", cookie_indexes: candidates, reason: failure.reason }, now);
          if (result.status !== "denied" || result.reason !== failure.reason) throw Error();
        } catch { failure = new AuthFailure(503, "identity_unavailable"); }
      }
      if (dashboard && failure.status === 401) return loginRedirect();
      if (dashboard && failure.status === 503) return dashboardFailurePage();
      return response(failure.status, { error: failure.publicReason });
    }
  }
}
