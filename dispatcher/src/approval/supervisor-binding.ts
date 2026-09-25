import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { AuditRepository, assertCurrentAuditReadState, type AuditAnchorStore } from "../audit/repository.js";
import type { AuditKeyLookup, AuditEvent, VerifiedAuditState } from "../audit/codec.js";
import { assertSynchronousCallback, assertSynchronousResult } from "../audit/synchronous.js";
import { ApprovalHistoryTransaction } from "./history-transaction.js";
import type { ApprovalTransactionProviders } from "./transaction.js";
import { verifyApprovalSupervisorBindingSchema } from "./schema.js";
import { encodeKeychainCasRequest, parseKeychainCasResponse } from "./keychain-cas.js";
import type { ClockMark } from "./clock.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const utc = z.string().max(24).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const scopeSchema = z.strictObject({ instance_id: id, workspace_id: id });
const proofSchema = z.strictObject({
  operator_id: id, credential_id: id, credential_domain: id,
  credential_kind: z.enum(["os_account", "hardware_backed"]),
  action: z.enum(["bootstrap", "rotate", "revoke", "break_glass"]),
  transaction_id: id, proposal_digest: digest,
});
const bindingSchema = z.strictObject({
  codec_version: z.literal(1), scope: scopeSchema, team_id: id, supervisor_user_id: id,
  transaction_id: id,
  revision: positive, status: z.enum(["active", "revoked", "break_glass"]),
  operation_scope_digest: digest.nullable(), target_scope_digest: digest.nullable(),
  expires_at: utc.nullable(), reason: z.string().min(8).max(512).nullable(), reason_digest: digest.nullable(),
  changed_at: utc, operator_ids: z.tuple([id, id]), operator_proof_digests: z.tuple([digest, digest]),
}).superRefine((value, ctx) => {
  if (value.operator_ids[0] === value.operator_ids[1] ||
    (value.status === "break_glass") !== (value.expires_at !== null && value.reason !== null && value.reason_digest !== null
      && value.operation_scope_digest !== null && value.target_scope_digest !== null))
    ctx.addIssue({ code: "custom", message: "binding_invalid" });
  if (value.status !== "break_glass" && (value.expires_at !== null || value.reason !== null || value.reason_digest !== null
    || value.operation_scope_digest !== null || value.target_scope_digest !== null))
    ctx.addIssue({ code: "custom", message: "binding_invalid" });
});
export type SupervisorBinding = z.infer<typeof bindingSchema>;
export type SupervisorBindingScope = z.infer<typeof scopeSchema>;
export type VerifiedOperatorProof = z.infer<typeof proofSchema>;
export type SupervisorBindingAction = VerifiedOperatorProof["action"];
export interface BindingGeneration {
  readonly revision: number;
  readonly digest: string;
  readonly transaction_id: string;
}
/** DB/backup外のrollback-resistant credential store。nullからのreserveは初回だけ成功する。 */
export interface BindingGenerationStore {
  read(scope: SupervisorBindingScope): BindingGeneration | null;
  reserve(scope: SupervisorBindingScope, expected: BindingGeneration | null, proposed: BindingGeneration): BindingGeneration;
}
/** 固定native Keychain CASへのtransport。呼出し元が任意commandを渡さない。 */
export interface BindingKeychainTransport { exchange(request: string): string }
const protectedGenesis = z.strictObject({ codec_version: z.literal(1), kind: z.literal("genesis"), scope_digest: digest });
const protectedGeneration = z.strictObject({ codec_version: z.literal(1), kind: z.literal("binding_generation"),
  scope_digest: digest, revision: positive, digest, transaction_id: id });
/** separately provisioned Keychain itemの初期値。ここではprovisionしない。 */
export function bindingGenerationGenesis(scopeInput: SupervisorBindingScope): Uint8Array {
  const scope = scopeSchema.parse(scopeInput);
  return Buffer.from(canonical({ codec_version: 1, kind: "genesis", scope_digest: hash(scope) }));
}
/** Keychain scopeはinstance/workspaceのhashで分離。初回CASはgenesisから
 * generation 1へだけ進め、native側のrevision/bytes一致CASを使う。 */
export class KeychainBindingGenerations implements BindingGenerationStore {
  private readonly scope: SupervisorBindingScope;
  private readonly nativeScope: { access_group: string; instance_id: string; purpose: "binding_generation" };
  constructor(scopeInput: SupervisorBindingScope, accessGroup: string, private readonly transport: BindingKeychainTransport) {
    this.scope = scopeSchema.parse(scopeInput);
    this.nativeScope = { access_group: accessGroup,
      instance_id: "ab_" + hash(this.scope).slice(0, 64), purpose: "binding_generation" };
    encodeKeychainCasRequest(this.nativeScope);
    assertSynchronousCallback(transport.exchange);
  }
  private observed(): { revision: number; value: Uint8Array; generation: BindingGeneration | null } {
    const response = parseKeychainCasResponse(this.transport.exchange(encodeKeychainCasRequest(this.nativeScope)));
    if (response.status !== "observed") throw new SupervisorBindingError();
    const bytes = Buffer.from(response.value, "base64");
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (bytes.toString("utf8") !== canonical(parsed)) throw new SupervisorBindingError();
    if (response.revision === 1 && same(protectedGenesis.parse(parsed),
      { codec_version: 1, kind: "genesis", scope_digest: hash(this.scope) }))
      return { revision: response.revision, value: bytes, generation: null };
    const head = protectedGeneration.parse(parsed);
    if (head.scope_digest !== hash(this.scope) || head.revision !== response.revision - 1) throw new SupervisorBindingError();
    return { revision: response.revision, value: bytes,
      generation: { revision: head.revision, digest: head.digest, transaction_id: head.transaction_id } };
  }
  read(scopeInput: SupervisorBindingScope): BindingGeneration | null {
    try { if (!same(scopeSchema.parse(scopeInput), this.scope)) throw Error(); return this.observed().generation; }
    catch { throw new SupervisorBindingError(); }
  }
  reserve(scopeInput: SupervisorBindingScope, expected: BindingGeneration | null, proposed: BindingGeneration): BindingGeneration {
    try {
      if (!same(scopeSchema.parse(scopeInput), this.scope)) throw Error();
      const before = this.observed(); const next = parseGeneration(proposed);
      if (!same(before.generation, expected) || next.revision !== (expected?.revision ?? 0) + 1) throw Error();
      const value = Buffer.from(canonical({ codec_version: 1, kind: "binding_generation", scope_digest: hash(this.scope), ...next }));
      const response = parseKeychainCasResponse(this.transport.exchange(encodeKeychainCasRequest(this.nativeScope,
        { revision: before.revision, value: before.value }, value)));
      if (response.status !== "changed" || response.revision !== before.revision + 1
        || response.value !== value.toString("base64") || !same(this.observed().generation, next)) throw Error();
      return next;
    } catch { throw new SupervisorBindingError(); }
  }
}
/** ローカルoperator経路で二人分を認証する。通常event/MCPへ公開しない。 */
export type OperatorProofAuthority = (action: SupervisorBindingAction, transactionId: string,
  proposalDigest: string) => readonly [VerifiedOperatorProof, VerifiedOperatorProof];
export class SupervisorBindingError extends Error {
  constructor() { super("supervisor_binding_unverified"); this.name = "SupervisorBindingError"; }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string {
  return createHash("sha256").update("dona.supervisor-binding.v1\0").update(canonical(value)).digest("hex");
}
function parseGeneration(value: unknown): BindingGeneration {
  return z.strictObject({ revision: positive, digest, transaction_id: id }).parse(value);
}
function same(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
function recordDigest(binding: SupervisorBinding): string { return hash(binding); }
export function supervisorReasonDigest(reason: string): string { return hash(z.string().min(8).max(512).parse(reason)); }
function auditRoot(state: VerifiedAuditState, scope: SupervisorBindingScope): string | null {
  const roots = state.resource_bindings.filter(value => value.resource_id === "approval_binding"
    && value.scope.instance_id === scope.instance_id && value.scope.tenant_id === scope.workspace_id);
  if (roots.length > 1) throw new SupervisorBindingError();
  return roots[0]?.resource_digest ?? null;
}

/** 同じ共有監査state、保護generation、SQLite行を三方向で照合する。 */
export class SupervisorBindingRepository {
  private readonly audit: AuditRepository;
  private readonly scope: SupervisorBindingScope;
  constructor(private readonly db: Database.Database, anchors: AuditAnchorStore, keys: AuditKeyLookup,
    scope: SupervisorBindingScope, private readonly generations: BindingGenerationStore) {
    try {
      assertSynchronousResult(scope); this.scope = Object.freeze(scopeSchema.parse(scope));
      verifyApprovalSupervisorBindingSchema(db);
      this.audit = new AuditRepository(db, anchors, keys);
    } catch { throw new SupervisorBindingError(); }
  }
  read(): SupervisorBinding | null {
    try { return this.audit.readVerifiedState(state => this.readInState(state)); }
    catch { throw new SupervisorBindingError(); }
  }
  readInState(state: VerifiedAuditState): SupervisorBinding | null {
    try {
      assertCurrentAuditReadState(this.db, state);
      const raw = this.db.prepare("SELECT binding_json,revision FROM main.approval_supervisor_bindings WHERE instance_id=? AND workspace_id=?")
        .get(this.scope.instance_id, this.scope.workspace_id) as { binding_json: string; revision: number } | undefined;
      const root = auditRoot(state, this.scope);
      const protectedValue = this.generations.read(this.scope);
      if (raw === undefined) {
        if (root !== null || protectedValue !== null) throw Error();
        return null;
      }
      const parsed = bindingSchema.parse(JSON.parse(raw.binding_json));
      if (raw.binding_json !== canonical(parsed) || !same(parsed.scope, this.scope) || parsed.revision !== raw.revision
        || root !== recordDigest(parsed) || protectedValue === null) throw Error();
      const generation = parseGeneration(protectedValue);
      if (generation.revision !== parsed.revision || generation.digest !== root
        || generation.transaction_id !== parsed.transaction_id) throw Error();
      return Object.freeze(parsed);
    } catch { throw new SupervisorBindingError(); }
  }
  matchesScope(input: SupervisorBindingScope): boolean {
    try { return same(scopeSchema.parse(input), this.scope); } catch { return false; }
  }
}

/** binding IDは表示名やaliasに依存せず、revisionは別に照合する。 */
export function supervisorBindingId(bindingInput: SupervisorBinding): string {
  const binding = bindingSchema.parse(bindingInput);
  return "asb_" + hash({ scope: binding.scope, team_id: binding.team_id,
    supervisor_user_id: binding.supervisor_user_id }).slice(0, 32);
}
export function supervisorOperationScopeDigest(operation: string): string { return hash({ operation }); }
export function supervisorTargetScopeDigest(target: { channel_id: string; thread_ts: string }): string {
  return hash({ channel_id: id.parse(target.channel_id),
    thread_ts: z.string().regex(/^[0-9]{10}\.[0-9]{6}$/).parse(target.thread_ts) });
}
const accessSchema = z.strictObject({
  transaction_id: id, phase: z.enum(["create", "delivery", "decision", "consume", "execution"]),
  instance_id: id, workspace_id: id, alias: id, team_id: id, user_id: id,
  active: z.boolean(), can_approve: z.boolean(), target_visible: z.boolean(), shared: z.boolean(),
  operation_scope_digest: digest, target_scope_digest: digest,
  observed_at: utc, expires_at: utc,
});
export type SupervisorAccessReceipt = z.infer<typeof accessSchema>;
export type SupervisorAccessPhase = SupervisorAccessReceipt["phase"];
const observationSchema = z.strictObject({
  transaction_id: id, phase: accessSchema.shape.phase,
  instance_id: id, workspace_id: id, alias: id, team_id: id, user_id: id,
  operation_kind: z.literal("slack.post_thread_reply.v1"),
  target: z.strictObject({ channel_id: id, thread_ts: z.string().regex(/^[0-9]{10}\.[0-9]{6}$/) }),
  active: z.literal(true), can_approve: z.literal(true), target_visible: z.literal(true), shared: z.literal(false),
  observed_at: utc, expires_at: utc,
});
/** 認証済みinternal channelで受けたSlack観測だけを正規化する。 */
export function bindSupervisorAccessObservation(input: unknown, binding: SupervisorBinding,
  alias: string, phase: SupervisorAccessPhase, transactionId: string,
  target: { channel_id: string; thread_ts: string },
  key: { version: number; secret: Uint8Array }): SupervisorAccessReceipt {
  try {
    assertSynchronousResult(input);
    const signed = z.strictObject({ key_version: positive, observation: observationSchema, mac: digest }).parse(input);
    if (!Number.isSafeInteger(key.version) || key.version !== signed.key_version
      || !(key.secret instanceof Uint8Array) || key.secret.byteLength !== 32) throw Error();
    const computed = createHmac("sha256", key.secret).update("dona.approval.access.v1\0")
      .update(canonical({ key_version: signed.key_version, observation: signed.observation })).digest();
    if (!timingSafeEqual(computed, Buffer.from(signed.mac, "hex"))) throw Error();
    const observation = signed.observation, current = bindingSchema.parse(binding);
    if (observation.transaction_id !== transactionId || observation.phase !== phase || observation.alias !== alias
      || observation.instance_id !== current.scope.instance_id || observation.workspace_id !== current.scope.workspace_id
      || observation.team_id !== current.team_id || observation.user_id !== current.supervisor_user_id
      || observation.target.channel_id !== target.channel_id || observation.target.thread_ts !== target.thread_ts) throw Error();
    return accessSchema.parse({ transaction_id: transactionId, phase,
      instance_id: observation.instance_id, workspace_id: observation.workspace_id, alias,
      team_id: observation.team_id, user_id: observation.user_id,
      active: true, can_approve: true, target_visible: true, shared: false,
      operation_scope_digest: supervisorOperationScopeDigest(observation.operation_kind),
      target_scope_digest: supervisorTargetScopeDigest(observation.target),
      observed_at: observation.observed_at, expires_at: observation.expires_at });
  } catch { throw new SupervisorBindingError(); }
}
/** Registryが現在のalias->teamを解決し、Slack user/current accessをfreshに確認する。
 * 署名済み/認証済みreceiptはphaseとtransaction IDへ一回だけ結合する。 */
export type SupervisorCurrentAccess = (binding: SupervisorBinding, phase: SupervisorAccessPhase,
  transactionId: string, operationDigest: string, targetDigest: string) => SupervisorAccessReceipt;
export class SupervisorBindingGuard {
  constructor(private readonly repository: SupervisorBindingRepository, private readonly alias: string,
    private readonly access: SupervisorCurrentAccess) {
    id.parse(alias); assertSynchronousCallback(access);
  }
  matchesScope(scope: SupervisorBindingScope): boolean { return this.repository.matchesScope(scope); }
  current(state: VerifiedAuditState, mark: Readonly<ClockMark>, phase: SupervisorAccessPhase,
    expected: { binding_id: string | null; revision: number | null; actor_id: string | null },
    target: { channel_id: string; thread_ts: string }): boolean {
    try {
      const binding = this.repository.readInState(state);
      if (binding === null || binding.status === "revoked"
        || (expected.binding_id !== null && supervisorBindingId(binding) !== expected.binding_id)
        || (expected.revision !== null && binding.revision !== expected.revision)
        || (expected.actor_id !== null && binding.supervisor_user_id !== expected.actor_id)) return false;
      if (binding.status === "break_glass" && Date.parse(binding.expires_at!) <= Date.parse(mark.effective_utc)) return false;
      const operationDigest = supervisorOperationScopeDigest("slack.post_thread_reply.v1");
      const targetDigest = supervisorTargetScopeDigest(target);
      if (binding.status === "break_glass" && (binding.operation_scope_digest !== operationDigest
        || binding.target_scope_digest !== targetDigest)) return false;
      const raw = this.access(binding, phase, mark.transaction_id, operationDigest, targetDigest);
      assertSynchronousResult(raw); const receipt = accessSchema.parse(raw);
      return receipt.transaction_id === mark.transaction_id && receipt.phase === phase
        && receipt.instance_id === binding.scope.instance_id && receipt.workspace_id === binding.scope.workspace_id
        && receipt.alias === this.alias && receipt.team_id === binding.team_id
        && receipt.user_id === binding.supervisor_user_id && receipt.active && receipt.can_approve
        && receipt.target_visible && !receipt.shared && receipt.operation_scope_digest === operationDigest
        && receipt.target_scope_digest === targetDigest
        && Date.parse(receipt.observed_at) <= Date.parse(mark.effective_utc)
        && Date.parse(receipt.expires_at) > Date.parse(mark.effective_utc)
        && Date.parse(mark.effective_utc) - Date.parse(receipt.observed_at) <= 30_000;
    } catch { return false; }
  }
}

const proposalSchema = z.strictObject({ team_id: id, supervisor_user_id: id,
  reason: z.string().min(8).max(512).nullable(), reason_digest: digest.nullable(),
  operation_scope_digest: digest.nullable(), target_scope_digest: digest.nullable(),
  expires_at: utc.nullable() });
export type SupervisorBindingProposal = z.infer<typeof proposalSchema>;
/** 明示的なoperator-only service。operator proofはtrusted callbackから得る。 */
export class SupervisorBindingOperator {
  private readonly transaction: ApprovalHistoryTransaction;
  private readonly repository: SupervisorBindingRepository;
  private readonly scope: SupervisorBindingScope;
  constructor(private readonly db: Database.Database, providers: ApprovalTransactionProviders, scope: SupervisorBindingScope,
    private readonly generations: BindingGenerationStore, private readonly proofs: OperatorProofAuthority) {
    try {
      assertSynchronousResult(scope); this.scope = Object.freeze(scopeSchema.parse(scope));
      assertSynchronousCallback(proofs);
      this.transaction = new ApprovalHistoryTransaction(db, providers, scope);
      this.repository = new SupervisorBindingRepository(db, providers.auditAnchors, providers.auditKeys, scope, generations);
    } catch { throw new SupervisorBindingError(); }
  }
  change(transactionId: string, action: SupervisorBindingAction, proposalInput: SupervisorBindingProposal): SupervisorBinding {
    try {
      id.parse(transactionId); assertSynchronousResult(proposalInput);
      const proposal = Object.freeze(proposalSchema.parse(proposalInput));
      if (proposal.team_id !== this.scope.workspace_id) throw Error();
      if (proposal.reason !== null && proposal.reason_digest !== supervisorReasonDigest(proposal.reason)) throw Error();
      if (action === "break_glass" ? proposal.expires_at === null || proposal.reason === null || proposal.reason_digest === null
          || proposal.operation_scope_digest === null || proposal.target_scope_digest === null
        : proposal.expires_at !== null || proposal.reason !== null || proposal.reason_digest !== null
          || proposal.operation_scope_digest !== null || proposal.target_scope_digest !== null) throw Error();
      return this.transaction.runPrepared<() => SupervisorBinding>(transactionId, (mark: Readonly<ClockMark>, state) => {
        const old = this.repository.readInState(state);
        if ((action === "bootstrap") !== (old === null)) throw Error();
        if (old !== null && action !== "break_glass" && action !== "revoke" && old.status === "revoked") throw Error();
        if (old !== null && proposal.team_id !== old.team_id) throw Error();
        if (old !== null && action === "revoke" && proposal.supervisor_user_id !== old.supervisor_user_id) throw Error();
        if (old !== null && old.revision === Number.MAX_SAFE_INTEGER) throw Error();
        const revision = (old?.revision ?? 0) + 1;
        if (action === "break_glass") {
          const duration = Date.parse(proposal.expires_at!) - Date.parse(mark.effective_utc);
          if (duration <= 0 || duration > 30 * 60_000) throw Error();
        }
        const scopeDigest = hash({ action, transaction_id: transactionId, scope: this.scope, revision, proposal });
        const rawProofs = this.proofs(action, transactionId, scopeDigest);
        assertSynchronousResult(rawProofs);
        const [first, second] = z.tuple([proofSchema, proofSchema]).parse(rawProofs);
        if (first.operator_id === second.operator_id || first.credential_id === second.credential_id
          || first.credential_domain === second.credential_domain
          || [first, second].some(proof => proof.action !== action || proof.transaction_id !== transactionId
            || proof.proposal_digest !== scopeDigest)) throw Error();
        const binding: SupervisorBinding = bindingSchema.parse({ codec_version: 1, scope: this.scope,
          transaction_id: transactionId,
          team_id: proposal.team_id, supervisor_user_id: proposal.supervisor_user_id, revision,
          status: action === "revoke" ? "revoked" : action === "break_glass" ? "break_glass" : "active",
          operation_scope_digest: action === "break_glass" ? proposal.operation_scope_digest : null,
          target_scope_digest: action === "break_glass" ? proposal.target_scope_digest : null,
          expires_at: action === "break_glass" ? proposal.expires_at : null,
          reason: action === "break_glass" ? proposal.reason : null,
          reason_digest: action === "break_glass" ? proposal.reason_digest : null,
          changed_at: mark.effective_utc, operator_ids: [first.operator_id, second.operator_id],
          operator_proof_digests: [hash(first), hash(second)] });
        const next: BindingGeneration = { revision, digest: recordDigest(binding), transaction_id: transactionId };
        const expected = old === null ? null : parseGeneration(this.generations.read(this.scope));
        if (old !== null && (expected?.revision !== old.revision || expected.digest !== recordDigest(old))) throw Error();
        // CAS must durably reserve before the DB transaction commits. An unused
        // generation after a failure is deliberately not rolled back or retried.
        const accepted = parseGeneration(this.generations.reserve(this.scope, expected, next));
        if (!same(accepted, next) || !same(parseGeneration(this.generations.read(this.scope)), next)) throw Error();
        const event: Omit<AuditEvent, "occurred_at"> = {
          scope: { instance_id: this.scope.instance_id, tenant_id: this.scope.workspace_id },
          actor: { kind: "operator", id: first.operator_id }, action: "binding_change", operation: "binding.change.v1",
          resource_id: "approval_binding", outcome: "succeeded", reason: "none", session_ref: null,
          receipt_id: null, attempt_id: null, policy_revision: 0, binding_revision: revision, authz_revision: 0,
        };
        return { event, resource_digest: next.digest, mutation: () => {
          if (old === null) this.db.prepare("INSERT INTO main.approval_supervisor_bindings(instance_id,workspace_id,binding_json,revision) VALUES (?,?,?,?)")
            .run(this.scope.instance_id, this.scope.workspace_id, canonical(binding), revision);
          else {
            const updated = this.db.prepare("UPDATE main.approval_supervisor_bindings SET binding_json=?,revision=? WHERE instance_id=? AND workspace_id=? AND revision=?")
              .run(canonical(binding), revision, this.scope.instance_id, this.scope.workspace_id, old.revision);
            if (updated.changes !== 1) throw Error();
          }
          return binding;
        } };
      });
    } catch { throw new SupervisorBindingError(); }
  }
}
