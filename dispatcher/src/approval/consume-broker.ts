import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuditEvent, VerifiedAuditState } from "../audit/codec.js";
import { assertSynchronousCallback, assertSynchronousResult } from "../audit/synchronous.js";
import type { ApprovalTransactionProviders } from "./transaction.js";
import { ApprovalHistoryTransaction } from "./history-transaction.js";
import { ApprovalClockHistory } from "./clock-history.js";
import { approvalExpired, type ClockMark } from "./clock.js";
import { ApprovalRecordRepository } from "./record-repository.js";
import { ApprovalRecordMutation } from "./record-mutation.js";
import type { ApprovalRecord, ApprovalRecordScope } from "./record-codec.js";
import { ApprovalRequestLifecycle } from "./request-lifecycle.js";
import { ApprovalPayloadRepository } from "./payload-repository.js";
import { ApprovalPayloadMutation } from "./payload-mutation.js";
import { openApprovalPayload, sealApprovalPayload, type ApprovalPayloadBinding, type ApprovalPayloadKey, type SealedApprovalPayload } from "./payload-protection.js";
import { encodeApprovalPayloadEnvelope } from "./payload-metadata.js";
import { verifyApprovalNotificationMarker, type ApprovalNotificationKey } from "./notification-marker.js";
import { approvalSupervisorBindingRequired } from "./schema.js";
import type { SupervisorBindingGuard } from "./supervisor-binding.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const scopeSchema = z.strictObject({ instance_id: id, workspace_id: id });
const commandSchema = z.strictObject({ request_handle: id, authority_ref: id, expected_revision: positive });
export type ApprovalConsumeCommand = z.infer<typeof commandSchema>;
type Request = Extract<ApprovalRecord, { kind: "request" }>;
const denial = z.enum(["unauthenticated", "unauthorized", "proof_invalid", "scope_mismatch", "unavailable"]);
const staleReason = z.enum(["binding_revoked", "revision_mismatch", "snapshot_mismatch", "resource_not_visible"]);
const grantSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("denied"), reason: denial }),
  z.strictObject({ status: z.literal("verified"), scope: scopeSchema, request_id: id, decision_id: id, event_id: id, consumer_id: id,
    binding_id: id, binding_revision: positive, policy_revision: positive, semantic_hash: z.string().regex(/^[a-f0-9]{64}$/),
    requester_authorization_revision: positive, stale_reason: staleReason.nullable() }),
]);
export type ApprovalConsumeGrant = z.infer<typeof grantSchema>;
/** trusted内部consumer専用。authority_refを認証済みconnectionと保存済み
 * decision eventへ解決し、consumerの操作権限、current binding/policy、
 * requester権限、supervisor visibility、shared状態、exact snapshotとclosed
 * operation allowlistを毎回検証する。handle/event ID所持は認可ではない。
 * stateは同じ同期監査callback内だけ有効。実provider/defaultを提供しない。 */
export type ApprovalConsumeAuthority = (command: Readonly<ApprovalConsumeCommand>, request: Request,
  mark: Readonly<ClockMark>, state: VerifiedAuditState) => ApprovalConsumeGrant;
export type ApprovalConsumeResult =
  | { status: "claimed" | "reused"; consume_handle: string; attempt_handle: string; attempt_state: Extract<ApprovalRecord, { kind: "execution" }>["row"]["state"] }
  | { status: "changed"; request_state: "needs_review" | "consume_expired" }
  | { status: "denied"; reason: z.infer<typeof denial> | "decision_conflict" | "revision_mismatch" };
export class ApprovalConsumeError extends Error { constructor() { super("approval_consume_unverified"); this.name = "ApprovalConsumeError"; } }
const opaque = (prefix: string) => prefix + randomUUID().replaceAll("-", "");
/** claim後の外部call開始期限。consume期限を越えず、延長も再claimもしない。 */
export const approvalExecutionStartWindowMs = 30_000;
export class ApprovalConsumeBroker {
  private readonly scope: ApprovalRecordScope;
  private readonly transaction: ApprovalHistoryTransaction;
  private readonly history: ApprovalClockHistory;
  private readonly records: ApprovalRecordRepository;
  private readonly recordMutation: ApprovalRecordMutation;
  private readonly lifecycle: ApprovalRequestLifecycle;
  private readonly payloads: ApprovalPayloadRepository;
  private readonly payloadMutation: ApprovalPayloadMutation;
  constructor(private readonly db: Database.Database, providers: ApprovalTransactionProviders, scope: ApprovalRecordScope,
    private readonly authorize: ApprovalConsumeAuthority,
    private readonly contentKey: (version: number) => ApprovalPayloadKey,
    /** nullは新規seal用active鍵、versionは既存envelopeの保持鍵を選ぶ。 */
    private readonly wrappingKey: (version: number | null) => ApprovalPayloadKey,
    private readonly notificationKey: (version: number) => ApprovalNotificationKey,
    private readonly bindingGuard?: SupervisorBindingGuard) {
    try {
      assertSynchronousResult(scope); this.scope = Object.freeze(scopeSchema.parse(scope));
      for (const callback of [authorize, contentKey, wrappingKey, notificationKey]) assertSynchronousCallback(callback);
      if (approvalSupervisorBindingRequired(db) && bindingGuard === undefined) throw Error();
      this.transaction = new ApprovalHistoryTransaction(db, providers, this.scope);
      this.history = new ApprovalClockHistory(db, this.scope);
      this.records = new ApprovalRecordRepository(db, providers.auditAnchors, providers.auditKeys, this.scope);
      this.recordMutation = new ApprovalRecordMutation(db, this.scope);
      this.lifecycle = new ApprovalRequestLifecycle(db, providers, this.scope);
      this.payloads = new ApprovalPayloadRepository(db, providers.auditAnchors, providers.auditKeys, this.scope);
      this.payloadMutation = new ApprovalPayloadMutation(db, this.scope);
    } catch { throw new ApprovalConsumeError(); }
  }
  consume(transactionId: string, input: ApprovalConsumeCommand): ApprovalConsumeResult {
    try {
      if (approvalSupervisorBindingRequired(this.db) && this.bindingGuard === undefined) throw Error();
      assertSynchronousResult(input); const command = Object.freeze(commandSchema.parse(input));
      return this.transaction.runPrepared<() => ApprovalConsumeResult>(transactionId, (mark, state) => {
        const base: Omit<AuditEvent, "occurred_at"> = { scope: { instance_id: this.scope.instance_id, tenant_id: this.scope.workspace_id },
          actor: { kind: "unauthenticated", id: null }, action: "approval_consume", operation: "approval.consume.v1", resource_id: "approval_consume",
          outcome: "denied", reason: "unauthenticated", session_ref: null, receipt_id: null, attempt_id: null, policy_revision: 0, binding_revision: 0, authz_revision: 0 };
        const denied = (reason: Extract<ApprovalConsumeResult, { status: "denied" }>["reason"], event = base) =>
          ({ event: { ...event, outcome: "denied" as const, reason }, resource_digest: null, mutation: () => ({ status: "denied" as const, reason }) });
        const request = this.records.readInState(state, "request", command.request_handle);
        if (request === null) return denied("unauthorized");
        const raw = this.authorize(command, request, mark, state); assertSynchronousResult(raw); const grant = grantSchema.parse(raw);
        if (grant.status === "denied") return denied(grant.reason);
        if (grant.scope.instance_id !== this.scope.instance_id || grant.scope.workspace_id !== this.scope.workspace_id
          || grant.request_id !== request.row.request_id) return denied("scope_mismatch");
        const decision = this.records.readInState(state, "decision", request.row.request_id);
        if (decision === null || decision.row.kind !== "approve" || decision.row.decision_id !== grant.decision_id) return denied("decision_conflict");
        const eventRecord = this.records.readAliasInState(state, { name: "event_decision", decision_id: decision.row.decision_id });
        if (eventRecord?.kind !== "event" || eventRecord.row.event_id !== grant.event_id) return denied("proof_invalid");
        const snapshot = this.lifecycle.snapshot(request);
        const event = { ...base, actor: { kind: "system" as const, id: grant.consumer_id }, resource_id: request.row.request_id,
          binding_revision: request.row.binding_revision, policy_revision: request.row.policy_revision, authz_revision: snapshot.preconditions.requester_authorization_revision };
        this.lifecycle.verifyClock(request, mark, state);
        const prior = this.records.readInState(state, "consume", request.row.request_id);
        if (prior === null && (request.row.state !== "approved" || command.expected_revision !== request.row.revision))
          return denied(request.row.state !== "approved" ? "decision_conflict" : "revision_mismatch", event);
        const currentBinding = this.bindingGuard?.current(state, mark, "consume", { binding_id: request.row.binding_id,
          revision: request.row.binding_revision, actor_id: decision.row.actor_id }, snapshot.target) ?? true;
        const drift = !currentBinding || grant.stale_reason !== null || grant.binding_id !== request.row.binding_id || grant.binding_revision !== request.row.binding_revision
          || grant.policy_revision !== request.row.policy_revision || grant.semantic_hash !== request.row.semantic_hash
          || grant.requester_authorization_revision !== snapshot.preconditions.requester_authorization_revision;
        const change = (next: "needs_review" | "consume_expired", reason: AuditEvent["reason"]) => {
          const plan = this.lifecycle.change(mark, state, request, next, null, { ...event, outcome: next === "needs_review" ? "needs_review" : "succeeded", reason });
          return { event: plan.event, resource_commitments: plan.resource_commitments, mutation: (): ApprovalConsumeResult => {
            plan.mutation(); return { status: "changed", request_state: next };
          } };
        };
        if (drift) return prior === null ? change("needs_review", grant.stale_reason ?? "revision_mismatch") : denied("revision_mismatch", event);
        const card = this.lifecycle.notification(state, request, "approval_card");
        if (card.row.state !== "sent" || decision.row.presentation_revision !== card.row.presentation_revision) return denied("proof_invalid", event);
        const cardMark = this.history.readInState(state, card.row.clock_transaction_id);
        if (cardMark === null || cardMark.boot_id !== mark.boot_id || cardMark.continuous_ms > mark.continuous_ms || cardMark.effective_utc > mark.effective_utc) throw Error();
        verifyApprovalNotificationMarker({ codec_version: 1, ...this.scope, request_id: request.row.request_id,
          notification_attempt_id: card.row.notification_attempt_id, kind: "approval_card", semantic_hash: request.row.semantic_hash,
          created_at: cardMark.effective_utc, key_version: card.row.marker_key_version }, card.row.marker_mac, this.notificationKey(card.row.marker_key_version));
        if (prior !== null) {
          if (request.row.state !== "consumed" || prior.row.decision_id !== decision.row.decision_id) throw Error();
          const claim = this.history.readInState(state, prior.row.clock_transaction_id), attempt = this.records.readInState(state, "execution", prior.row.attempt_id);
          if (claim === null || attempt === null || claim.effective_utc !== prior.row.claimed_at || claim.boot_id !== mark.boot_id
            || claim.continuous_ms > mark.continuous_ms || claim.effective_utc > mark.effective_utc) throw Error();
          return { event: { ...event, outcome: "succeeded" as const, reason: "none" as const, attempt_id: prior.row.attempt_id }, resource_digest: null,
            mutation: (): ApprovalConsumeResult => ({ status: "reused", consume_handle: prior.row.consume_id, attempt_handle: prior.row.attempt_id, attempt_state: attempt.row.state }) };
        }
        if (approvalExpired(request.row.consume_expires_at!, mark)) return change("consume_expired", "consume_expired");
        const payload = this.payloads.inspectInState(state, "request", request.row.request_id);
        if (payload === null || payload.metadata.state !== "active" || payload.secret.status !== "present") return change("needs_review", "integrity_failure");
        const old = payload.metadata.binding;
        if (old.request_id !== request.row.request_id || old.semantic_hash !== request.row.semantic_hash || "payload-store:" + old.payload_ref !== snapshot.encrypted_content_ref
          || old.created_at !== request.row.created_at || old.content.mac !== snapshot.content_hmac_sha256 || old.content.key_version !== snapshot.content_hmac_key_version)
          return change("needs_review", "integrity_failure");
        const consumeId = opaque("apc_"), attemptId = opaque("apx_"), payloadRef = opaque("app_");
        const executionExpires = new Date(Math.min(Date.parse(mark.effective_utc) + approvalExecutionStartWindowMs, Date.parse(request.row.consume_expires_at!))).toISOString();
        const payloadExpires = new Date(Date.parse(mark.effective_utc) + 24 * 3600000).toISOString();
        const binding: ApprovalPayloadBinding = { ...old, owner_kind: "attempt", owner_id: attemptId, payload_ref: payloadRef, created_at: mark.effective_utc, expires_at: payloadExpires };
        let envelope: SealedApprovalPayload;
        try {
          const contentKey = this.contentKey(old.content.key_version);
          const text = openApprovalPayload(payload.secret.envelope, old, this.wrappingKey(payload.secret.envelope.key_version), contentKey, mark);
          envelope = sealApprovalPayload(text, binding, this.wrappingKey(null), contentKey, mark);
        } catch { return change("needs_review", "integrity_failure"); }
        const next: Request = { ...request, row: { ...request.row, state: "consumed", revision: request.row.revision + 1 } };
        const records = this.recordMutation.prepare(mark, state, [{ previous: request, next },
          { previous: null, next: { codec_version: 1, scope: this.scope, kind: "consume", row: { consume_id: consumeId, request_id: request.row.request_id,
            decision_id: decision.row.decision_id, decision_kind: "approve", attempt_id: attemptId, claimed_at: mark.effective_utc, clock_transaction_id: mark.transaction_id } } },
          { previous: null, next: { codec_version: 1, scope: this.scope, kind: "execution", row: { attempt_id: attemptId, request_id: request.row.request_id, consume_id: consumeId,
            state: "claimed", fence: 1, claimed_at: mark.effective_utc, execution_expires_at: executionExpires, payload_expires_at: payloadExpires,
            receipt_ref: null, failure_code: null, clock_transaction_id: mark.transaction_id } } },
          ...this.lifecycle.notifications(mark, state, request, next.row.revision)]);
        const transfer = this.payloadMutation.prepare(mark, state, [{ previous: payload.metadata, next: { ...payload.metadata, state: "deleted", deleted_at: mark.effective_utc }, envelope: null },
          { previous: null, next: { codec_version: 1, binding, consume_id: consumeId, envelope_digest: encodeApprovalPayloadEnvelope(envelope).digest, state: "active", deleted_at: null }, envelope }]);
        return { event: { ...event, outcome: "succeeded" as const, reason: "none" as const, attempt_id: attemptId },
          resource_commitments: [...transfer.resource_commitments, ...records.resource_commitments], mutation: (): ApprovalConsumeResult => {
            records.mutation(); transfer.mutation(); return { status: "claimed", consume_handle: consumeId, attempt_handle: attemptId, attempt_state: "claimed" };
          } };
      });
    } catch { throw new ApprovalConsumeError(); }
  }
}
