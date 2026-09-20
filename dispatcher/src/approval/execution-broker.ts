import type Database from "better-sqlite3";
import { z } from "zod";
import { auditEventSchema, type AuditEvent, type VerifiedAuditState } from "../audit/codec.js";
import { assertSynchronousCallback, assertSynchronousResult } from "../audit/synchronous.js";
import type { ApprovalRecord, ApprovalRecordScope } from "./record-codec.js";
import type { ApprovalTransactionProviders } from "./transaction.js";
import { ApprovalHistoryTransaction } from "./history-transaction.js";
import { ApprovalClockHistory } from "./clock-history.js";
import { approvalExpired, type ClockMark } from "./clock.js";
import { ApprovalRecordRepository } from "./record-repository.js";
import { ApprovalRecordMutation } from "./record-mutation.js";
import { ApprovalRequestLifecycle } from "./request-lifecycle.js";
import { ApprovalPayloadRepository } from "./payload-repository.js";
import { ApprovalPayloadMutation } from "./payload-mutation.js";
import { openApprovalPayload, type ApprovalPayloadKey } from "./payload-protection.js";
import { ApprovalExecutionMarkerStore } from "./execution-marker-store.js";
import { signApprovalExecutionMarker, verifyApprovalExecutionMarker, type ApprovalExecutionMarkerKey } from "./execution-marker.js";
import { executionCommandSchema, executionStartGrantSchema, executionRecoveryGrantSchema, executionReceiptGrantSchema,
  type ExecutionCommand, type ExecutionStartAuthority, type ExecutionRecoveryAuthority, type ExecutionReceiptAuthority } from "./execution-authority.js";
type Request = Extract<ApprovalRecord, { kind: "request" }>;
type Attempt = Extract<ApprovalRecord, { kind: "execution" }>;
type Event = Omit<AuditEvent, "occurred_at">;
type State = Attempt["row"]["state"];
export type ApprovalExecutionResult = { status: "started" | "updated" | "unchanged"; attempt_handle: string; attempt_state: State; fence: number }
  | { status: "denied"; reason: "unauthenticated" | "unauthorized" | "scope_mismatch" | "proof_invalid" | "unavailable" | "already_consumed" | "revision_mismatch" };
export class ApprovalExecutionError extends Error { constructor() { super("approval_execution_unverified"); this.name = "ApprovalExecutionError"; } }
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const terminal = (state: State) => ["succeeded", "failed", "needs_review"].includes(state);
/** 内部状態brokerのみ。外部送信・公開API・実authorityは提供しない。
 * startedを外部成功や、serializableな送信権限として公開してはならない。 */
export class ApprovalExecutionBroker {
  private readonly scope: ApprovalRecordScope;
  private readonly transaction: ApprovalHistoryTransaction;
  private readonly history: ApprovalClockHistory;
  private readonly records: ApprovalRecordRepository;
  private readonly mutations: ApprovalRecordMutation;
  private readonly lifecycle: ApprovalRequestLifecycle;
  private readonly payloads: ApprovalPayloadRepository;
  private readonly payloadMutation: ApprovalPayloadMutation;
  private readonly markers: ApprovalExecutionMarkerStore;
  constructor(db: Database.Database, providers: ApprovalTransactionProviders, scope: ApprovalRecordScope,
    private readonly authorizeStart: ExecutionStartAuthority, private readonly authorizeRecovery: ExecutionRecoveryAuthority,
    private readonly authorizeReceipt: ExecutionReceiptAuthority,
    private readonly contentKey: (version: number) => ApprovalPayloadKey,
    private readonly wrappingKey: (version: number) => ApprovalPayloadKey,
    private readonly markerKey: (version: number | null) => ApprovalExecutionMarkerKey) {
    try {
      assertSynchronousResult(scope); this.scope = Object.freeze(z.strictObject({ instance_id: id, workspace_id: id }).parse(scope));
      for (const callback of [authorizeStart, authorizeRecovery, authorizeReceipt, contentKey, wrappingKey, markerKey]) assertSynchronousCallback(callback);
      this.transaction = new ApprovalHistoryTransaction(db, providers, this.scope); this.history = new ApprovalClockHistory(db, this.scope);
      this.records = new ApprovalRecordRepository(db, providers.auditAnchors, providers.auditKeys, this.scope);
      this.mutations = new ApprovalRecordMutation(db, this.scope); this.lifecycle = new ApprovalRequestLifecycle(db, providers, this.scope);
      this.payloads = new ApprovalPayloadRepository(db, providers.auditAnchors, providers.auditKeys, this.scope);
      this.payloadMutation = new ApprovalPayloadMutation(db, this.scope); this.markers = new ApprovalExecutionMarkerStore(db, providers, this.scope);
    } catch { throw new ApprovalExecutionError(); }
  }
  start(transactionId: string, input: ExecutionCommand): ApprovalExecutionResult {
    try {
      assertSynchronousResult(input); const command = Object.freeze(executionCommandSchema.parse(input));
      return this.transaction.runPrepared<() => ApprovalExecutionResult>(transactionId, (mark, state) => {
        const base = this.base(), found = this.load(state, command);
        if (found === null) return this.denied(base, "unauthorized");
        const { request, attempt } = found, raw = this.authorizeStart(command, request, attempt, mark, state);
        assertSynchronousResult(raw); const grant = executionStartGrantSchema.parse(raw);
        if (grant.status === "denied") return this.denied(base, grant.reason);
        if (!this.matches(grant, attempt)) return this.denied(base, "scope_mismatch");
        const event = this.event(request, attempt, grant.consumer_id);
        if (command.expected_fence !== attempt.row.fence) return this.denied(event, "revision_mismatch");
        if (attempt.row.state !== "claimed") return this.denied(event, "already_consumed");
        this.clock(request, attempt, mark, state);
        if (approvalExpired(attempt.row.execution_expires_at, mark)) return this.change(mark, state, attempt, "needs_review", "expired", null, event);
        const snapshot = this.lifecycle.snapshot(request);
        const drift = grant.stale_reason !== null || grant.binding_id !== request.row.binding_id || grant.binding_revision !== request.row.binding_revision
          || grant.policy_revision !== request.row.policy_revision || grant.semantic_hash !== request.row.semantic_hash
          || grant.requester_authorization_revision !== snapshot.preconditions.requester_authorization_revision;
        if (drift) return this.change(mark, state, attempt, "needs_review", grant.stale_reason ?? "revision_mismatch", null, event);
        const payload = this.payloads.inspectInState(state, "attempt", attempt.row.attempt_id);
        let authentic = false;
        if (payload?.metadata.state === "active" && payload.secret.status === "present") {
          const binding = payload.metadata.binding;
          if (binding.request_id === request.row.request_id && payload.metadata.consume_id === attempt.row.consume_id
            && binding.semantic_hash === request.row.semantic_hash && binding.created_at === attempt.row.claimed_at
            && binding.expires_at === attempt.row.payload_expires_at && binding.content.mac === snapshot.content_hmac_sha256
            && binding.content.key_version === snapshot.content_hmac_key_version) {
            try {
              openApprovalPayload(payload.secret.envelope, binding, this.wrappingKey(payload.secret.envelope.key_version), this.contentKey(binding.content.key_version), mark);
              authentic = true;
            } catch { /* 破損/失効した本文を実行可能とは扱わない。 */ }
          }
        }
        if (!authentic) return this.change(mark, state, attempt, "needs_review", "integrity_failure", null, event);
        const activeKey = this.markerKey(null), next: Attempt = { ...attempt, row: { ...attempt.row, state: "executing", fence: attempt.row.fence + 1 } };
        const sealed = signApprovalExecutionMarker({ codec_version: 1, scope: this.scope, request_id: request.row.request_id, consume_id: attempt.row.consume_id,
          attempt_id: attempt.row.attempt_id, operation: "slack.post_thread_reply.v1", semantic_hash: request.row.semantic_hash,
          execution_fence: next.row.fence, created_at: mark.effective_utc, clock_transaction_id: mark.transaction_id, key_version: activeKey.version }, activeKey, mark);
        const records = this.mutations.prepare(mark, state, [{ previous: attempt, next }]), marker = this.markers.prepare(mark, state, sealed);
        return { event: { ...event, outcome: "pending" as const }, resource_commitments: [...records.resource_commitments, ...marker.resource_commitments],
          mutation: (): ApprovalExecutionResult => { records.mutation(); marker.mutation(); return this.result("started", next); } };
      });
    } catch { throw new ApprovalExecutionError(); }
  }
  recover(transactionId: string, input: ExecutionCommand): ApprovalExecutionResult {
    try {
      assertSynchronousResult(input); const command = Object.freeze(executionCommandSchema.parse(input));
      return this.transaction.runPrepared<() => ApprovalExecutionResult>(transactionId, (mark, state) => {
        const base = this.base(), found = this.load(state, command); if (found === null) return this.denied(base, "unauthorized");
        const { request, attempt } = found, raw = this.authorizeRecovery(command, request, attempt, mark, state);
        assertSynchronousResult(raw); const grant = executionRecoveryGrantSchema.parse(raw);
        if (grant.status === "denied") return this.denied(base, grant.reason);
        if (!this.matches(grant, attempt)) return this.denied(base, "scope_mismatch");
        const event = this.event(request, attempt, grant.consumer_id);
        if (command.expected_fence !== attempt.row.fence) return this.denied(event, "revision_mismatch");
        this.clock(request, attempt, mark, state);
        if (terminal(attempt.row.state)) return this.unchanged(event, attempt);
        const expired = approvalExpired(attempt.row.payload_expires_at, mark)
          || (attempt.row.state === "claimed" && approvalExpired(attempt.row.execution_expires_at, mark));
        const payload = this.payloads.inspectInState(state, "attempt", attempt.row.attempt_id);
        const missing = payload?.metadata.state !== "active" || payload.secret.status !== "present";
        // 実行復旧は期限切れでもまずunknownをdurableに記録する。保持期限を
        // 超えた本文は同時に削除し、次の復旧でneeds_reviewへ収束させる。
        // marker鍵失効もこの安全側への遷移を妨げない。照合時に別途検証する。
        if (attempt.row.state === "executing") return this.change(mark, state, attempt, "acceptance_unknown",
          expired ? "expired" : missing ? "integrity_failure" : "response_lost", null, event, expired || missing);
        if (expired || missing) return this.change(mark, state, attempt, "needs_review", expired ? "expired" : "integrity_failure", null, event);
        return this.unchanged(event, attempt);
      });
    } catch { throw new ApprovalExecutionError(); }
  }
  resolve(transactionId: string, input: ExecutionCommand): ApprovalExecutionResult {
    try {
      assertSynchronousResult(input); const command = Object.freeze(executionCommandSchema.parse(input));
      return this.transaction.runPrepared<() => ApprovalExecutionResult>(transactionId, (mark, state) => {
        const base = this.base(), found = this.load(state, command); if (found === null) return this.denied(base, "unauthorized");
        const { request, attempt } = found;
        // markerは認可でなく、receipt authorityがexact proofを照合するための内部入力。
        const marker = this.markers.readInState(state, attempt.row.attempt_id);
        if (marker === null) return this.denied(base, "proof_invalid");
        const raw = this.authorizeReceipt(command, request, attempt, marker, mark, state);
        assertSynchronousResult(raw); const grant = executionReceiptGrantSchema.parse(raw);
        if (grant.status === "denied") return this.denied(base, grant.reason);
        if (!this.matches(grant, attempt)) return this.denied(base, "scope_mismatch");
        const event = this.event(request, attempt, grant.consumer_id);
        if (command.expected_fence !== attempt.row.fence || grant.execution_fence !== attempt.row.fence) return this.denied(event, "revision_mismatch");
        this.clock(request, attempt, mark, state);
        if (terminal(attempt.row.state)) return this.unchanged(event, attempt);
        const expired = approvalExpired(attempt.row.payload_expires_at, mark);
        const payload = this.payloads.inspectInState(state, "attempt", attempt.row.attempt_id);
        const missing = payload?.metadata.state !== "active" || payload.secret.status !== "present";
        if (expired || missing) return this.change(mark, state, attempt,
          attempt.row.state === "executing" ? "acceptance_unknown" : "needs_review", expired ? "expired" : "integrity_failure", null, event, true);
        this.marker(state, attempt, mark);
        if (grant.proof_kind === "callback" ? attempt.row.state !== "executing" || marker.marker.execution_fence !== grant.execution_fence
          : attempt.row.state !== "acceptance_unknown") return this.denied(event, "proof_invalid");
        const proof = grant.receipt;
        if (proof.outcome === "accepted") return this.change(mark, state, attempt, "succeeded", "none", proof.receipt_ref, event);
        if (proof.outcome === "rejected") return this.change(mark, state, attempt, "failed", proof.reason, proof.receipt_ref, event);
        if (proof.outcome === "ambiguous") return grant.proof_kind === "reconcile"
          ? this.change(mark, state, attempt, "needs_review", "proof_invalid", null, event)
          : this.change(mark, state, attempt, "acceptance_unknown", "response_lost", null, event);
        return attempt.row.state === "acceptance_unknown" ? this.unchanged(event, attempt)
          : this.change(mark, state, attempt, "acceptance_unknown", "response_lost", null, event);
      });
    } catch { throw new ApprovalExecutionError(); }
  }
  private load(state: VerifiedAuditState, command: ExecutionCommand) {
    const attempt = this.records.readInState(state, "execution", command.attempt_handle); if (attempt === null) return null;
    const request = this.records.readInState(state, "request", attempt.row.request_id);
    if (request === null || request.row.state !== "consumed") throw Error();
    return { request, attempt };
  }
  private matches(grant: { scope: ApprovalRecordScope; attempt_id: string }, attempt: Attempt): boolean {
    return grant.scope.instance_id === this.scope.instance_id && grant.scope.workspace_id === this.scope.workspace_id && grant.attempt_id === attempt.row.attempt_id;
  }
  private clock(request: Request, attempt: Attempt, mark: Readonly<ClockMark>, state: VerifiedAuditState) {
    this.lifecycle.verifyClock(request, mark, state);
    const claim = this.history.readInState(state, attempt.row.clock_transaction_id);
    if (claim === null || claim.effective_utc !== attempt.row.claimed_at || claim.boot_id !== mark.boot_id
      || claim.continuous_ms > mark.continuous_ms || claim.effective_utc > mark.effective_utc) throw Error();
  }
  private marker(state: VerifiedAuditState, attempt: Attempt, mark: Readonly<ClockMark>) {
    const sealed = this.markers.readInState(state, attempt.row.attempt_id); if (sealed === null) throw Error();
    const created = this.history.readInState(state, sealed.marker.clock_transaction_id);
    if (created === null || created.effective_utc !== sealed.marker.created_at || created.boot_id !== mark.boot_id
      || created.continuous_ms > mark.continuous_ms || created.effective_utc > mark.effective_utc) throw Error();
    verifyApprovalExecutionMarker(sealed, this.markerKey(sealed.marker.key_version)); return sealed;
  }
  private change(mark: Readonly<ClockMark>, state: VerifiedAuditState, attempt: Attempt, nextState: Exclude<State, "claimed" | "executing">,
    reason: AuditEvent["reason"], receipt: string | null, event: Event, deletePayload = false) {
    const next: Attempt = { ...attempt, row: { ...attempt.row, state: nextState, fence: attempt.row.fence + 1,
      receipt_ref: receipt, failure_code: reason === "none" ? null : reason } };
    const records = this.mutations.prepare(mark, state, [{ previous: attempt, next }]);
    const payload = this.payloads.inspectInState(state, "attempt", attempt.row.attempt_id);
    const removal = (terminal(nextState) || deletePayload) && payload?.metadata.state === "active" ? this.payloadMutation.prepare(mark, state,
      [{ previous: payload.metadata, next: { ...payload.metadata, state: "deleted", deleted_at: mark.effective_utc }, envelope: null }]) : null;
    return { event: { ...event, outcome: nextState, reason, receipt_id: receipt }, resource_commitments: [...(removal?.resource_commitments ?? []), ...records.resource_commitments],
      mutation: (): ApprovalExecutionResult => { records.mutation(); removal?.mutation(); return this.result("updated", next); } };
  }
  private result(status: "started" | "updated" | "unchanged", attempt: Attempt): ApprovalExecutionResult {
    return { status, attempt_handle: attempt.row.attempt_id, attempt_state: attempt.row.state, fence: attempt.row.fence };
  }
  private unchanged(event: Event, attempt: Attempt) {
    const outcome: AuditEvent["outcome"] = terminal(attempt.row.state) || attempt.row.state === "acceptance_unknown" ? attempt.row.state as "succeeded" | "failed" | "needs_review" | "acceptance_unknown" : "pending";
    return { event: { ...event, outcome, reason: auditEventSchema.shape.reason.parse(attempt.row.failure_code ?? "none") }, resource_digest: null, mutation: () => this.result("unchanged", attempt) };
  }
  private denied(event: Event, reason: Extract<ApprovalExecutionResult, { status: "denied" }>["reason"]) {
    return { event: { ...event, outcome: "denied" as const, reason }, resource_digest: null,
      mutation: (): ApprovalExecutionResult => ({ status: "denied", reason }) };
  }
  private base(): Event {
    return { scope: { instance_id: this.scope.instance_id, tenant_id: this.scope.workspace_id }, actor: { kind: "unauthenticated", id: null },
      action: "approval_execution", operation: "slack.post_thread_reply.v1", resource_id: "approval_execution", outcome: "denied", reason: "none",
      session_ref: null, receipt_id: null, attempt_id: null, policy_revision: 0, binding_revision: 0, authz_revision: 0 };
  }
  private event(request: Request, attempt: Attempt, actorId: string): Event {
    return { ...this.base(), actor: { kind: "system", id: actorId }, resource_id: request.row.request_id, attempt_id: attempt.row.attempt_id,
      policy_revision: request.row.policy_revision, binding_revision: request.row.binding_revision,
      authz_revision: this.lifecycle.snapshot(request).preconditions.requester_authorization_revision };
  }
}
