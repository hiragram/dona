import { assertSynchronousCallback } from "../audit/synchronous.js";
import { prepareSessionIngress, type WebContextKeyLookup, type SessionIngressGates, type SessionIngressResult } from "./ingress.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { AuditRepository } from "../audit/repository.js";
import type { AuditEvent, VerifiedAuditState } from "../audit/codec.js";
import { ApprovalTransaction, type ApprovalTransactionProviders } from "../approval/transaction.js";
import type { ClockMark } from "../approval/clock.js";
import { evaluateSession, type RegistryPrincipal, type WebPrincipal } from "./domain.js";
import { encodeWebAuthState, decodeWebAuthState, encodeWebPayload, verifyWebPayload, webPayloadBinding, webStateScopeSchema,
  WebStateError, type WebAuthState, type WebStateScope, type StoredWebLogin, type StoredWebPayload, type StoredWebSession } from "./model.js";
import { restartWebAuthState, pruneExpiredWebState } from "./lifecycle.js";
import { verifyWebAuthSchema } from "./schema.js";

const resourceId = "web_auth_state";
const indexSchema = z.strictObject({ key_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), digest: z.string().regex(/^[a-f0-9]{64}$/) });
const indexesSchema = z.array(indexSchema).max(128).refine(rows => new Set(rows.map(row => row.key_version)).size === rows.length);
export type WebIndexCandidate = z.infer<typeof indexSchema>;
export const webAuthDenialReasonSchema = z.enum(["identity_invalid", "identity_unavailable", "identity_mismatch", "session_invalid",
  "session_revoked", "session_expired", "origin_invalid", "csrf_invalid", "cookie_invalid", "cookie_ambiguous"]);
export type WebAuthDenialReason = z.infer<typeof webAuthDenialReasonSchema>;
export type WebJobReadIngressResult = {status:"denied";reason:AuditEvent["reason"]}
  | {status:"succeeded";kind:"job_read_session_verified";principal:WebPrincipal;session_ref:string;effective_utc:string};
export type WebStoreResult = SessionIngressResult | WebJobReadIngressResult | { status: "denied"; reason: AuditEvent["reason"] }
  | { status: "succeeded"; kind: "initialized" | "restarted" | "login_created" | "session_created" | "revoked" | "expired"; generation: number }
  | { status: "succeeded"; kind: "login_consumed"; login: StoredWebLogin; payload: StoredWebPayload; receipt_id: string };
type Plan = { next: WebAuthState | undefined; payloads: StoredWebPayload[]; result: WebStoreResult; principal?: RegistryPrincipal; session_ref?:string|null };
type Loaded = ReturnType<typeof encodeWebAuthState> | undefined;
const deny = (next: WebAuthState | undefined, reason: AuditEvent["reason"]): Plan => ({ next, payloads: [], result: { status: "denied", reason } });
const references = (state: WebAuthState | undefined): Map<string, StoredWebLogin | StoredWebSession> => new Map<string, StoredWebLogin | StoredWebSession>([
  ...(state?.sessions.flatMap(session => session.payload_ref ? [[session.payload_ref, session] as const] : []) ?? []),
  ...(state?.logins.map(login => [login.payload_ref, login] as const) ?? []),
]);
function indexes(input: unknown): WebIndexCandidate[] {
  try { return indexesSchema.parse(input); } catch { throw new WebStateError(); }
}

/** Internal Dispatcher repository, not a browser or authorization API. Only the
 * authenticated BFF broker may supply OIDC-derived indexes and sealed payloads.
 * Network authentication, Origin/CSRF and current resource authorization must be
 * enforced by their authoritative gate; this class never enables job execution.
 * All providers and repositories are constructed for this exact connection. */
export class WebAuthRepository {
  private readonly audit: AuditRepository;
  private readonly transaction: ApprovalTransaction;
  private readonly scope: WebStateScope;
  constructor(private readonly db: Database.Database, providers: ApprovalTransactionProviders, scope: WebStateScope, private readonly contextKeys?: WebContextKeyLookup) {
    try { this.scope = webStateScopeSchema.parse(scope); } catch { throw new WebStateError(); }
    if (contextKeys !== undefined) assertSynchronousCallback(contextKeys);
    verifyWebAuthSchema(db);
    this.transaction = new ApprovalTransaction(db, providers);
    this.audit = new AuditRepository(db, providers.auditAnchors, providers.auditKeys);
  }

  /** Construction-time alignment only; this is not a current identity proof. */
  configuredScope(): Readonly<WebStateScope> { return Object.freeze({ ...this.scope }); }

  private load(verified: VerifiedAuditState): Loaded {
    verifyWebAuthSchema(this.db);
    const binding = verified.resource_bindings.find(value => value.scope.instance_id === this.scope.instance_id
      && value.scope.tenant_id === this.scope.tenant_id && value.resource_id === resourceId);
    const row = this.db.prepare("SELECT state_json FROM web_auth_state WHERE instance_id=? AND tenant_id=?")
      .get(this.scope.instance_id, this.scope.tenant_id) as { state_json: string } | undefined;
    if (!binding && !row) return undefined;
    if (!binding || !row) throw new WebStateError();
    const decoded = decodeWebAuthState(row.state_json, this.scope);
    if (decoded.digest !== binding.resource_digest) throw new WebStateError();
    return decoded;
  }
  private payload(owner: StoredWebLogin | StoredWebSession): StoredWebPayload {
    if (!owner.payload_ref) throw new WebStateError();
    const row = this.db.prepare("SELECT payload_json FROM web_auth_payloads WHERE instance_id=? AND tenant_id=? AND payload_ref=?")
      .get(this.scope.instance_id, this.scope.tenant_id, owner.payload_ref) as { payload_json: string } | undefined;
    if (!row || Buffer.byteLength(row.payload_json, "utf8") > 16384) throw new WebStateError();
    const value = JSON.parse(row.payload_json);
    if (encodeWebPayload(value).canonical !== row.payload_json) throw new WebStateError();
    return verifyWebPayload(value, owner);
  }
  private commit(transactionId: string, operation: "web.login.v1" | "web.logout.v1" | "policy.change.v1" | "web.session.v1",
    sessionRef: string | null, prepare: (state: WebAuthState | undefined, mark: Readonly<ClockMark>) => Plan): WebStoreResult {
    return this.transaction.runPrepared(transactionId, (mark, verified) => {
      const loaded = this.load(verified), before = loaded?.state;
      if (before && Date.parse(mark.effective_utc) < Date.parse(before.updated_at)) throw new WebStateError();
      const plan = prepare(before, mark);
      const after = plan.next === undefined ? undefined : encodeWebAuthState(plan.next);
      if (after && (after.state.instance_id !== this.scope.instance_id || after.state.tenant_id !== this.scope.tenant_id
        || Date.parse(after.state.updated_at) > Date.parse(mark.effective_utc))) throw new WebStateError();
      if (before && !after) throw new WebStateError();
      const oldRefs = references(before), newRefs = references(after?.state);
      const added = new Map(plan.payloads.map(value => [value.payload_ref, encodeWebPayload(value)]));
      if (added.size !== plan.payloads.length) throw new WebStateError();
      for (const [ref, payload] of added) {
        const owner = newRefs.get(ref);
        if (!owner || oldRefs.has(ref) || this.db.prepare("SELECT 1 FROM web_auth_payloads WHERE instance_id=? AND tenant_id=? AND payload_ref=?")
          .get(this.scope.instance_id, this.scope.tenant_id, ref)) throw new WebStateError();
        verifyWebPayload(payload.payload, owner);
        if (Date.parse(payload.payload.envelope.sealed_at) > Date.parse(mark.effective_utc)) throw new WebStateError();
      }
      for (const [ref, owner] of newRefs) {
        if (!oldRefs.has(ref) && !added.has(ref)) throw new WebStateError();
        if (oldRefs.has(ref) && (oldRefs.get(ref)!.payload_digest !== owner.payload_digest
          || webPayloadBinding(oldRefs.get(ref)!) !== webPayloadBinding(owner))) throw new WebStateError();
      }
      const event: Omit<AuditEvent, "occurred_at"> = {
        scope: this.scope, actor: plan.principal ? { kind: "principal", id: plan.principal.principal_id }
          : operation === "policy.change.v1" ? { kind: "system", id: "web_auth_broker" } : { kind: "unauthenticated", id: null },
        action: operation === "web.login.v1" ? "web_login" : operation === "web.logout.v1" ? "web_logout" : operation === "web.session.v1" ? "web_authorize" : "policy_change",
        operation, resource_id: operation === "web.session.v1" ? plan.session_ref ?? resourceId : resourceId, outcome: plan.result.status,
        reason: plan.result.status === "denied" ? plan.result.reason : "none", session_ref: plan.session_ref ?? sessionRef,
        receipt_id: transactionId, attempt_id: null, policy_revision: plan.principal ? 1 : 0,
        binding_revision: plan.principal?.identity_binding_revision ?? 0, authz_revision: plan.principal?.authz_revision ?? 0,
      };
      const update = operation === "web.session.v1" && after ? {resource_commitments:[{scope:this.scope,resource_id:resourceId,resource_digest:after.digest}]} : {resource_digest:after?.digest ?? null};
      return { event, ...update, mutation: () => {
        if (after && after.canonical !== loaded?.canonical) {
          if (loaded) this.db.prepare("UPDATE web_auth_state SET state_json=? WHERE instance_id=? AND tenant_id=?")
            .run(after.canonical, this.scope.instance_id, this.scope.tenant_id);
          else this.db.prepare("INSERT INTO web_auth_state VALUES (?,?,?)").run(this.scope.instance_id, this.scope.tenant_id, after.canonical);
        }
        for (const ref of oldRefs.keys()) if (!newRefs.has(ref)) this.db.prepare("DELETE FROM web_auth_payloads WHERE instance_id=? AND tenant_id=? AND payload_ref=?")
          .run(this.scope.instance_id, this.scope.tenant_id, ref);
        for (const [ref, payload] of added) this.db.prepare("INSERT INTO web_auth_payloads VALUES (?,?,?,?)")
          .run(this.scope.instance_id, this.scope.tenant_id, ref, payload.canonical);
        verifyWebAuthSchema(this.db);
        if (after) {
          const stored = this.db.prepare("SELECT state_json FROM web_auth_state WHERE instance_id=? AND tenant_id=?")
            .get(this.scope.instance_id, this.scope.tenant_id) as { state_json: string };
          if (decodeWebAuthState(stored.state_json, this.scope).digest !== after.digest) throw new WebStateError();
        }
        for (const ref of added.keys()) this.payload(newRefs.get(ref)!);
        return plan.result;
      } };
    });
  }

  /** Internal authorization prerequisite only. A returned principal is not a
   * job or approval capability. Only authenticated BFF/route gates may mark a
   * navigation or command as activity; poll/SSE confirmation does not. */
  verifySessionIngress(transactionId:string,token:string,method:unknown,target:unknown,body:Uint8Array,gates:SessionIngressGates={}):WebStoreResult {
    const keys=this.contextKeys;
    return this.commit(transactionId,"web.session.v1",null,(state,mark)=>{
      if(!state)return deny(state,"deployment_invalid");
      if(!keys)return deny(state,"identity_unavailable");
      const plan=prepareSessionIngress(state,token,method,target,body,mark.effective_utc,keys,gates);
      if(plan.result.status==="succeeded"){
        const session=state.sessions.find(row=>row.state.session_ref===plan.session_ref);
        if(!session)throw new WebStateError();this.payload(session);
      }
      return {next:plan.next,result:plan.result,payloads:[],session_ref:plan.session_ref,...(plan.principal?{principal:plan.principal}:{})};
    });
  }

  /** Job-read-specific extension. The generic session result and auth semantics
   * remain unchanged; this returns only server-derived clock/session evidence. */
  verifyJobReadIngress(transactionId:string,token:string,method:unknown,target:unknown,body:Uint8Array):WebJobReadIngressResult {
    return this.commit(transactionId,"web.session.v1",null,(state,mark)=>{
      if(!state)return deny(state,"deployment_invalid");
      if(!this.contextKeys)return deny(state,"identity_unavailable");
      const plan=prepareSessionIngress(state,token,method,target,body,mark.effective_utc,this.contextKeys);
      if(plan.result.status==="denied")return{next:plan.next,result:plan.result,payloads:[],session_ref:plan.session_ref,
        ...(plan.principal?{principal:plan.principal}:{})};
      const session=state.sessions.find(row=>row.state.session_ref===plan.session_ref);
      if(!session)throw new WebStateError();this.payload(session);
      return{next:plan.next,result:{status:"succeeded",kind:"job_read_session_verified",principal:plan.result.principal,
        session_ref:session.state.session_ref,effective_utc:mark.effective_utc},payloads:[],session_ref:session.state.session_ref,
        ...(plan.principal?{principal:plan.principal}:{})};
    }) as WebJobReadIngressResult;
  }

  auditJobReadOutcome(transactionId:string,authority:Extract<WebJobReadIngressResult,{status:"succeeded"}>,
    operation:"web.job_list.v1"|"web.job_read.v1"|"web.sse_subscribe.v1",resourceId:string,
    outcome:"succeeded"|"denied"|"failed",reason:"none"|"resource_not_visible"|"scope_denied"|"invalid_input"|"unavailable"):boolean {
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(resourceId))throw new WebStateError();
    return this.transaction.runPrepared(transactionId,(mark,verified)=>{
      const loaded=this.load(verified)?.state;if(!loaded)throw new WebStateError();
      const storedPrincipal=loaded.principals.find(row=>row.principal_id===authority.principal.principal_id);
      const session=loaded.sessions.find(row=>row.state.session_ref===authority.session_ref);
      const decision=storedPrincipal&&session?evaluateSession(storedPrincipal,session.state,
        {instance_id:loaded.instance_id,tenant_id:loaded.tenant_id,bff_generation:loaded.bff_generation},mark.effective_utc):null;
      const current=decision?.allowed===true&&decision.principal.instance_id===authority.principal.instance_id
        &&decision.principal.tenant_id===authority.principal.tenant_id
        &&decision.principal.principal_id===authority.principal.principal_id
        &&decision.principal.identity_binding_revision===authority.principal.identity_binding_revision
        &&decision.principal.authz_revision===authority.principal.authz_revision;
      const event:Omit<AuditEvent,"occurred_at">={scope:this.scope,actor:{kind:"principal",id:authority.principal.principal_id},
        action:"web_authorize",operation,resource_id:resourceId,outcome:current?outcome:"denied",
        reason:current?reason:(decision?.allowed===false?decision.reason:"session_invalid"),session_ref:authority.session_ref,
        receipt_id:transactionId,attempt_id:null,policy_revision:1,binding_revision:authority.principal.identity_binding_revision,
        authz_revision:authority.principal.authz_revision};
      return{event,resource_digest:null,mutation:()=>current};
    });
  }

  initialize(transactionId: string): WebStoreResult {
    return this.commit(transactionId, "policy.change.v1", null, (state, mark) => {
      if (state) return deny(state, "idempotency_conflict");
      const next: WebAuthState = { codec_version: 1, ...this.scope, bff_generation: 1, created_at: mark.effective_utc,
        updated_at: mark.effective_utc, retained_subject_key_versions: [], principals: [], aliases: [], sessions: [],
        logins: [], consumed_logins: [], used_nonces: [] };
      return { next, payloads: [], result: { status: "succeeded", kind: "initialized", generation: 1 } };
    });
  }
  restart(transactionId: string, expectedGeneration?: number): WebStoreResult {
    if (expectedGeneration !== undefined && (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)) throw new WebStateError();
    return this.commit(transactionId, "policy.change.v1", null, (state, mark) => {
      if (!state) return deny(state, "deployment_invalid");
      if (expectedGeneration !== undefined && state.bff_generation !== expectedGeneration) return deny(state, "revision_mismatch");
      const next = restartWebAuthState(state, mark.effective_utc);
      return { next, payloads: [], result: { status: "succeeded", kind: "restarted", generation: next.bff_generation } };
    });
  }
  expire(transactionId: string): WebStoreResult {
    return this.commit(transactionId, "policy.change.v1", null, (state, mark) => {
      if (!state) return deny(state, "deployment_invalid");
      const next = pruneExpiredWebState(state, mark.effective_utc);
      return { next, payloads: [], result: { status: "succeeded", kind: "expired", generation: next.bff_generation } };
    });
  }
  createLogin(transactionId: string, input: Omit<StoredWebLogin, "previous_session_ref">, payload: StoredWebPayload,
    browserSessionCookies: WebIndexCandidate[] | null): WebStoreResult {
    const candidates = browserSessionCookies === null ? null : indexes(browserSessionCookies);
    return this.commit(transactionId, "web.login.v1", null, (state, mark) => {
      if (!state) return deny(state, "deployment_invalid");
      if (candidates !== null && (!candidates.length || state.sessions.some(session => !candidates.some(candidate => candidate.key_version === session.cookie_key_version)))) return deny(state, "identity_unavailable");
      const prior = candidates === null ? [] : state.sessions.filter(session => candidates.some(candidate => candidate.key_version === session.cookie_key_version && candidate.digest === session.cookie_digest));
      if (prior.length > 1) return deny(state, "cookie_invalid");
      const login: StoredWebLogin = { ...input, previous_session_ref: prior[0]?.state.session_ref ?? null };
      if (state.logins.some(value => value.binding.login_ref === login.binding.login_ref)
        || state.consumed_logins.some(value => value.login_ref === login.binding.login_ref)
        || state.logins.some(value => value.binding.cookie_key_version === login.binding.cookie_key_version && value.binding.cookie_digest === login.binding.cookie_digest)
        || state.sessions.some(value => value.cookie_key_version === login.binding.cookie_key_version && value.cookie_digest === login.binding.cookie_digest)) return deny(state, "idempotency_conflict");
      if (state.logins.length >= 512) return deny(state, "quota_exceeded");
      const now = Date.parse(mark.effective_utc), created = Date.parse(login.binding.created_at);
      if (login.binding.bff_generation !== state.bff_generation || created > now || now - created > 10000
        || Date.parse(login.binding.expires_at) <= now) return deny(state, "expired");
      const next = { ...state, updated_at: mark.effective_utc, logins: [...state.logins, login].sort((a, b) => a.binding.login_ref < b.binding.login_ref ? -1 : 1) };
      return { next, payloads: [payload], result: { status: "succeeded", kind: "login_created", generation: state.bff_generation } };
    });
  }
  consumeLogin(transactionId: string, loginRef: string, cookie: WebIndexCandidate): WebStoreResult {
    const candidate = indexes([cookie])[0]!;
    return this.commit(transactionId, "web.login.v1", null, (state, mark) => this.consumeLoginPlan(state, mark, transactionId, loginRef, candidate));
  }
  /** Select and consume in one audited transaction. Never derive login_ref from
   * the raw browser cookie or return a secret through a preliminary read. */
  consumeLoginByCookie(transactionId: string, cookieIndexes: WebIndexCandidate[]): WebStoreResult {
    const candidates = indexes(cookieIndexes);
    return this.commit(transactionId, "web.login.v1", null, (state, mark) => {
      if (!state) return deny(state, "deployment_invalid");
      if (!candidates.length || state.logins.some(login => !candidates.some(candidate => candidate.key_version === login.binding.cookie_key_version))) return deny(state, "identity_unavailable");
      const matches = state.logins.filter(login => candidates.some(candidate => candidate.key_version === login.binding.cookie_key_version && candidate.digest === login.binding.cookie_digest));
      if (matches.length > 1) return deny(state, "cookie_ambiguous");
      const login = matches[0]; if (!login) return deny(state, "already_consumed");
      return this.consumeLoginPlan(state, mark, transactionId, login.binding.login_ref,
        candidates.find(candidate => candidate.key_version === login.binding.cookie_key_version)!);
    });
  }
  private consumeLoginPlan(state: WebAuthState | undefined, mark: Readonly<ClockMark>, transactionId: string, loginRef: string, candidate: WebIndexCandidate): Plan {
    if (!state) return deny(state, "deployment_invalid");
    const login = state.logins.find(value => value.binding.login_ref === loginRef);
    if (!login) return deny(state, "already_consumed");
    const now = Date.parse(mark.effective_utc);
    if (login.binding.cookie_key_version !== candidate.key_version || login.binding.cookie_digest !== candidate.digest) return deny(state, "cookie_invalid");
    if (login.binding.bff_generation !== state.bff_generation || now >= Date.parse(login.binding.expires_at)) return deny(state, "expired");
    if (state.consumed_logins.length >= 512) return deny(state, "quota_exceeded");
    const payload = this.payload(login);
    const next = { ...state, updated_at: mark.effective_utc, logins: state.logins.filter(value => value !== login),
      consumed_logins: [...state.consumed_logins, { receipt_id: transactionId, login_ref: loginRef, bff_generation: state.bff_generation, previous_session_ref: login.previous_session_ref,
        consumed_at: mark.effective_utc, expires_at: new Date(Math.min(now + 10000, Date.parse(login.binding.expires_at))).toISOString() }]
        .sort((a, b) => a.receipt_id < b.receipt_id ? -1 : 1) };
    return { next, payloads: [], result: { status: "succeeded", kind: "login_consumed", login, payload, receipt_id: transactionId } };
  }
  createSession(transactionId: string, receiptId: string, subjectIndexes: WebIndexCandidate[], session: StoredWebSession, payload: StoredWebPayload): WebStoreResult {
    const candidates = indexes(subjectIndexes);
    return this.commit(transactionId, "web.login.v1", session.state.session_ref, (state, mark) => {
      if (!state) return deny(state, "deployment_invalid");
      const receipt = state.consumed_logins.find(value => value.receipt_id === receiptId);
      if (!receipt) return deny(state, "already_consumed");
      const now = Date.parse(mark.effective_utc);
      if (receipt.bff_generation !== state.bff_generation || now >= Date.parse(receipt.expires_at)) return deny(state, "expired");
      if (!state.retained_subject_key_versions.length || candidates.length !== state.retained_subject_key_versions.length
        || state.retained_subject_key_versions.some(version => !candidates.some(value => value.key_version === version))) return deny(state, "identity_unavailable");
      const matches = new Set(state.aliases.filter(alias => candidates.some(candidate => candidate.key_version === alias.index_key_version
        && candidate.digest === alias.subject_digest)).map(alias => alias.principal_id));
      const principal = matches.size === 1 ? state.principals.find(value => matches.has(value.principal_id)) : undefined;
      if (!principal || principal.principal_id !== session.state.principal_id) return deny(state, "identity_mismatch");
      if (now - Date.parse(session.state.authenticated_at) > 10000 || !evaluateSession(principal, session.state,
        { ...this.scope, bff_generation: state.bff_generation }, mark.effective_utc).allowed) return deny(state, "session_invalid");
      if (state.sessions.some(value => value.state.session_ref === session.state.session_ref
        || (value.cookie_key_version === session.cookie_key_version && value.cookie_digest === session.cookie_digest))
        || state.logins.some(value => value.binding.cookie_key_version === session.cookie_key_version && value.binding.cookie_digest === session.cookie_digest)) return deny(state, "idempotency_conflict");
      if (state.sessions.length >= 2048) return deny(state, "quota_exceeded");
      const next = { ...state, updated_at: mark.effective_utc, consumed_logins: state.consumed_logins.filter(value => value !== receipt),
        sessions: [...state.sessions.map(value => value.state.session_ref !== receipt.previous_session_ref ? value
          : { ...value, state: { ...value.state, state: "revoked" as const }, payload_ref: null, payload_digest: null }), session]
          .sort((a, b) => a.state.session_ref < b.state.session_ref ? -1 : 1),
        used_nonces: state.used_nonces.filter(value => value.session_ref !== receipt.previous_session_ref) };
      return { next, payloads: [payload], principal, result: { status: "succeeded", kind: "session_created", generation: state.bff_generation } };
    });
  }
  revokeSession(transactionId: string, sessionRef: string, cookie: WebIndexCandidate): WebStoreResult {
    const candidate = indexes([cookie])[0]!;
    return this.commit(transactionId, "web.logout.v1", sessionRef, (state, mark) => {
      if (!state) return deny(state, "deployment_invalid");
      const session = state.sessions.find(value => value.state.session_ref === sessionRef);
      if (!session || session.cookie_key_version !== candidate.key_version || session.cookie_digest !== candidate.digest) return deny(state, "cookie_invalid");
      const next: WebAuthState = { ...state, updated_at: mark.effective_utc,
        sessions: state.sessions.map(value => value !== session ? value : { ...value, state: { ...value.state, state: "revoked" }, payload_ref: null, payload_digest: null }),
        used_nonces: state.used_nonces.filter(value => value.session_ref !== sessionRef) };
      return { next, payloads: [], principal: state.principals.find(value => value.principal_id === session.state.principal_id)!,
        result: { status: "succeeded", kind: "revoked", generation: state.bff_generation } };
    });
  }

  /** Authenticated BFF reports inactive/invalid IdP identity for this bound token.
   * The result remains a denial; payload deletion and audit commit together. */
  revokeInactiveSession(transactionId: string, sessionRef: string, cookie: WebIndexCandidate): WebStoreResult {
    const candidate = indexes([cookie])[0]!;
    return this.commit(transactionId, "web.session.v1", null, (state, mark) => {
      if (!state) return deny(state, "deployment_invalid");
      const session = state.sessions.find(value => value.state.session_ref === sessionRef);
      if (!session || session.cookie_key_version !== candidate.key_version || session.cookie_digest !== candidate.digest) return deny(state, "cookie_invalid");
      const next: WebAuthState = { ...state, updated_at: mark.effective_utc,
        sessions: state.sessions.map(value => value !== session ? value : { ...value, state: { ...value.state, state: "revoked" }, payload_ref: null, payload_digest: null }),
        used_nonces: state.used_nonces.filter(value => value.session_ref !== sessionRef) };
      // Do not upgrade an online authentication failure into a trusted actor.
      return { ...deny(next, "identity_invalid"), session_ref: sessionRef };
    });
  }

  /** Bounded denial only, never a client-claimed actor or permission grant. */
  recordAuthDenial(transactionId: string, cookieIndexes: WebIndexCandidate[] | null, reasonInput: WebAuthDenialReason): WebStoreResult {
    const candidates = cookieIndexes === null ? null : indexes(cookieIndexes), reason = webAuthDenialReasonSchema.parse(reasonInput);
    return this.commit(transactionId, "web.session.v1", null, state => {
      if (!state) return deny(state, "deployment_invalid");
      if (candidates !== null && (!candidates.length || state.sessions.some(session => !candidates.some(candidate => candidate.key_version === session.cookie_key_version)))) return deny(state, "identity_unavailable");
      const matches = candidates === null ? [] : state.sessions.filter(session => candidates.some(candidate => candidate.key_version === session.cookie_key_version && candidate.digest === session.cookie_digest));
      if (matches.length > 1) return deny(state, "cookie_ambiguous");
      return { ...deny(state, reason), session_ref: matches[0]?.state.session_ref ?? null };
    });
  }

  /** Authenticated BFF preparation only; this projection never enrolls an
   * identity or confirms that a browser/session may perform an action. */
  loginContext() {
    return this.audit.readVerifiedState(verified => {
      const state = this.load(verified)?.state;
      if (!state) throw new WebStateError();
      return { bff_generation: state.bff_generation, retained_subject_key_versions: [...state.retained_subject_key_versions] };
    });
  }

  /** Match the complete HMAC inventory against one current verified registry.
   * OIDC subject stays in BFF memory; groups/email never enter this lookup. */
  lookupPrincipal(subjectIndexes: WebIndexCandidate[]) {
    const candidates = indexes(subjectIndexes);
    return this.audit.readVerifiedState(verified => {
      const state = this.load(verified)?.state;
      if (!state || !state.retained_subject_key_versions.length || candidates.length !== state.retained_subject_key_versions.length
        || state.retained_subject_key_versions.some(version => !candidates.some(value => value.key_version === version))) throw new WebStateError();
      const matches = new Set(state.aliases.filter(alias => candidates.some(candidate => candidate.key_version === alias.index_key_version
        && candidate.digest === alias.subject_digest)).map(alias => alias.principal_id));
      if (matches.size > 1) throw new WebStateError();
      const principal = state.principals.find(value => matches.has(value.principal_id));
      return principal ? { principal, bff_generation: state.bff_generation } : null;
    });
  }

  /** Local operator projection only. The caller still owns resource-level
   * authorization; this supplies one current audit-verified registry row. */
  lookupPrincipalById(principalId:string) {
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(principalId))throw new WebStateError();
    return this.audit.readVerifiedState(verified=>{
      const state=this.load(verified)?.state;if(!state)throw new WebStateError();
      return state.principals.find(value=>value.principal_id===principalId)??null;
    });
  }

  /** Verified local data only, never online authentication or resource authority.
   * Caller must supply all retained cookie index keys needed by current rows. */
  lookupSession(cookieIndexes: WebIndexCandidate[]) {
    const candidates = indexes(cookieIndexes);
    return this.audit.readVerifiedState(verified => {
      const state = this.load(verified)?.state;
      if (!state) throw new WebStateError();
      if (state.sessions.some(session => !candidates.some(candidate => candidate.key_version === session.cookie_key_version))) throw new WebStateError();
      const matches = state.sessions.filter(session => candidates.some(candidate => candidate.key_version === session.cookie_key_version && candidate.digest === session.cookie_digest));
      if (matches.length > 1) throw new WebStateError();
      const session = matches[0]; if (!session) return null;
      const principal = state.principals.find(value => value.principal_id === session.state.principal_id)!;
      return { session, principal, bff_generation: state.bff_generation, payload: session.payload_ref ? this.payload(session) : null };
    });
  }
}
