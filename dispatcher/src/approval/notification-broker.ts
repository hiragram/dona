import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuditEvent, VerifiedAuditState } from "../audit/codec.js";
import { assertSynchronousCallback, assertSynchronousResult } from "../audit/synchronous.js";
import type { ApprovalRecord, ApprovalRecordScope } from "./record-codec.js";
import type { ApprovalRecordSqlChange } from "./record-sql.js";
import type { ApprovalTransactionProviders } from "./transaction.js";
import { ApprovalHistoryTransaction } from "./history-transaction.js";
import { ApprovalClockHistory } from "./clock-history.js";
import { approvalExpired, type ClockMark } from "./clock.js";
import { ApprovalRecordRepository } from "./record-repository.js";
import { ApprovalRecordMutation } from "./record-mutation.js";
import { ApprovalRequestLifecycle, type ApprovalLifecycleResult } from "./request-lifecycle.js";
import { ApprovalPayloadRepository } from "./payload-repository.js";
import { ApprovalPayloadMutation } from "./payload-mutation.js";
import { openApprovalPayload, type ApprovalPayloadKey } from "./payload-protection.js";
import { verifyApprovalNotificationMarker, type ApprovalNotificationKey } from "./notification-marker.js";
import { settleDelivery, recoverDelivery, requestPayloadRequired, type RequestState, type DeliveryState } from "./domain.js";
import { notificationCommandSchema, notificationClaimGrantSchema, notificationRecoveryGrantSchema, notificationReceiptGrantSchema,
  type NotificationCommand, type NotificationClaimAuthority, type NotificationRecoveryAuthority, type NotificationReceiptAuthority } from "./notification-authority.js";
type Request = Extract<ApprovalRecord, { kind: "request" }>;
type Notification = Extract<ApprovalRecord, { kind: "notification" }>;
type Event = Omit<AuditEvent, "occurred_at">;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const undecided = new Set<RequestState>(["requested", "delivery_pending", "delivery_unknown", "sent"]);
const terminal = (value: DeliveryState) => ["sent", "failed", "needs_review", "aborted"].includes(value);
const opaque = (prefix: string) => prefix + randomUUID().replaceAll("-", "");
export type ApprovalNotificationResult = ApprovalLifecycleResult
  | { status: "dispatching" | "updated" | "unchanged"; notification_handle: string; delivery_state: DeliveryState; fence: number; request_state: RequestState }
  | { status: "denied"; reason: "unauthenticated" | "unauthorized" | "scope_mismatch" | "proof_invalid" | "unavailable" | "revision_mismatch" | "already_consumed" };
export class ApprovalNotificationError extends Error { constructor() { super("approval_notification_unverified"); this.name = "ApprovalNotificationError"; } }
/** 内部outbox状態だけを更新する。実配送・projection公開・再送権限を提供しない。 */
export class ApprovalNotificationBroker {
  private readonly scope: ApprovalRecordScope;
  private readonly transaction: ApprovalHistoryTransaction;
  private readonly history: ApprovalClockHistory;
  private readonly records: ApprovalRecordRepository;
  private readonly mutations: ApprovalRecordMutation;
  private readonly lifecycle: ApprovalRequestLifecycle;
  private readonly payloads: ApprovalPayloadRepository;
  private readonly payloadMutation: ApprovalPayloadMutation;
  constructor(db: Database.Database, providers: ApprovalTransactionProviders, scope: ApprovalRecordScope,
    private readonly authorizeClaim: NotificationClaimAuthority, private readonly authorizeRecovery: NotificationRecoveryAuthority,
    private readonly authorizeReceipt: NotificationReceiptAuthority, private readonly contentKey: (version: number) => ApprovalPayloadKey,
    private readonly wrappingKey: (version: number) => ApprovalPayloadKey, private readonly markerKey: (version: number) => ApprovalNotificationKey) {
    try {
      assertSynchronousResult(scope); this.scope = Object.freeze(z.strictObject({ instance_id: id, workspace_id: id }).parse(scope));
      for (const callback of [authorizeClaim, authorizeRecovery, authorizeReceipt, contentKey, wrappingKey, markerKey]) assertSynchronousCallback(callback);
      this.transaction = new ApprovalHistoryTransaction(db, providers, this.scope); this.history = new ApprovalClockHistory(db, this.scope);
      this.records = new ApprovalRecordRepository(db, providers.auditAnchors, providers.auditKeys, this.scope);
      this.mutations = new ApprovalRecordMutation(db, this.scope); this.lifecycle = new ApprovalRequestLifecycle(db, providers, this.scope);
      this.payloads = new ApprovalPayloadRepository(db, providers.auditAnchors, providers.auditKeys, this.scope);
      this.payloadMutation = new ApprovalPayloadMutation(db, this.scope);
    } catch { throw new ApprovalNotificationError(); }
  }
  claim(transactionId: string, input: NotificationCommand): ApprovalNotificationResult {
    try {
      assertSynchronousResult(input); const command = Object.freeze(notificationCommandSchema.parse(input));
      return this.transaction.runPrepared<() => ApprovalNotificationResult>(transactionId, (mark, state) => {
        const base = this.base(), found = this.load(state, command); if (found === null) return this.denied(base, "unauthorized");
        const { request, notification } = found, raw = this.authorizeClaim(command, request, notification, mark, state);
        assertSynchronousResult(raw); const grant = notificationClaimGrantSchema.parse(raw);
        if (grant.status === "denied") return this.denied(base, grant.reason);
        if (!this.matches(grant, notification)) return this.denied(base, "scope_mismatch");
        const event = this.event(request, notification, grant.consumer_id);
        if (command.expected_fence !== notification.row.fence) return this.denied(event, "revision_mismatch");
        if (notification.row.state !== "pending") return this.denied(event, "already_consumed");
        this.lifecycle.verifyClock(request, mark, state);
        if (!undecided.has(request.row.state)) return this.change(mark, state, request, notification, request.row.state, "aborted", null, event, "none");
        if (approvalExpired(request.row.expires_at, mark)) return this.expire(mark, state, request, event);
        const snapshot = this.lifecycle.snapshot(request);
        if (grant.stale_reason !== null || grant.binding_id !== request.row.binding_id || grant.binding_revision !== request.row.binding_revision
          || grant.policy_revision !== request.row.policy_revision || grant.semantic_hash !== request.row.semantic_hash
          || grant.requester_authorization_revision !== snapshot.preconditions.requester_authorization_revision)
          return this.lifecycle.change(mark, state, request, "needs_review", null, { ...event, outcome: "needs_review", reason: grant.stale_reason ?? "revision_mismatch" });
        this.marker(state, request, notification, mark);
        if (notification.row.kind === "approval_card") {
          if (request.row.state !== "delivery_pending") throw Error();
          if (!this.payloadAuthentic(request, mark, state)) return this.lifecycle.change(mark, state, request, "needs_review", null,
            { ...event, outcome: "needs_review", reason: "integrity_failure" });
        }
        return this.change(mark, state, request, notification, request.row.state, "dispatching", null, event, "none", "dispatching");
      });
    } catch { throw new ApprovalNotificationError(); }
  }
  recover(transactionId: string, input: NotificationCommand): ApprovalNotificationResult {
    try {
      assertSynchronousResult(input); const command = Object.freeze(notificationCommandSchema.parse(input));
      return this.transaction.runPrepared<() => ApprovalNotificationResult>(transactionId, (mark, state) => {
        const base = this.base(), found = this.load(state, command); if (found === null) return this.denied(base, "unauthorized");
        const { request, notification } = found, raw = this.authorizeRecovery(command, request, notification, mark, state);
        assertSynchronousResult(raw); const grant = notificationRecoveryGrantSchema.parse(raw);
        if (grant.status === "denied") return this.denied(base, grant.reason);
        if (!this.matches(grant, notification)) return this.denied(base, "scope_mismatch");
        const event = this.event(request, notification, grant.consumer_id);
        if (command.expected_fence !== notification.row.fence) return this.denied(event, "revision_mismatch");
        this.lifecycle.verifyClock(request, mark, state);
        if (notification.row.state === "dispatching") {
          const expired = undecided.has(request.row.state) && approvalExpired(request.row.expires_at, mark);
          const current = expired ? "expired" : request.row.state;
          const next = notification.row.kind === "approval_card" ? recoverDelivery(current, "dispatching").request : current;
          return this.change(mark, state, request, notification, next, "acceptance_unknown", null, event, expired ? "approval_expired" : "response_lost");
        }
        if (undecided.has(request.row.state) && approvalExpired(request.row.expires_at, mark)) return this.expire(mark, state, request, event);
        if (notification.row.state === "pending" && !undecided.has(request.row.state))
          return this.change(mark, state, request, notification, request.row.state, "aborted", null, event, "none");
        return this.unchanged(event, request, notification);
      });
    } catch { throw new ApprovalNotificationError(); }
  }
  resolve(transactionId: string, input: NotificationCommand): ApprovalNotificationResult {
    try {
      assertSynchronousResult(input); const command = Object.freeze(notificationCommandSchema.parse(input));
      return this.transaction.runPrepared<() => ApprovalNotificationResult>(transactionId, (mark, state) => {
        const base = this.base(), found = this.load(state, command); if (found === null) return this.denied(base, "unauthorized");
        const { request, notification } = found, raw = this.authorizeReceipt(command, request, notification, mark, state);
        assertSynchronousResult(raw); const grant = notificationReceiptGrantSchema.parse(raw);
        if (grant.status === "denied") return this.denied(base, grant.reason);
        if (!this.matches(grant, notification)) return this.denied(base, "scope_mismatch");
        const event = this.event(request, notification, grant.consumer_id);
        if (command.expected_fence !== notification.row.fence || grant.delivery_fence !== notification.row.fence) return this.denied(event, "revision_mismatch");
        this.lifecycle.verifyClock(request, mark, state);
        if (terminal(notification.row.state)) return this.unchanged(event, request, notification);
        if (grant.proof_kind === "callback" ? notification.row.state !== "dispatching" : notification.row.state !== "acceptance_unknown")
          return this.denied(event, "proof_invalid");
        this.marker(state, request, notification, mark);
        const receipt = grant.receipt;
        const expired = undecided.has(request.row.state) && approvalExpired(request.row.expires_at, mark);
        if (receipt.outcome === "unknown" && notification.row.state === "acceptance_unknown")
          return expired ? this.expire(mark, state, request, event) : this.unchanged(event, request, notification);
        const next: DeliveryState = receipt.outcome === "sent" ? "sent" : receipt.outcome === "rejected" ? "failed"
          : receipt.outcome === "ambiguous" && grant.proof_kind === "reconcile" ? "needs_review" : "acceptance_unknown";
        // unknownからのknown failureはauthorityのexact rejection証拠が必要だが、
        // domainの現行reconcileはsent/needs_reviewのみ。安易に拡張しない。
        if (notification.row.state === "acceptance_unknown" && next === "failed") return this.denied(event, "proof_invalid");
        const current = expired ? "expired" : request.row.state;
        const requestState = notification.row.kind === "approval_card"
          ? settleDelivery(current, notification.row.state, next).request : current;
        return this.change(mark, state, request, notification, requestState, next, receipt.outcome === "sent" ? receipt.presentation_ref : null,
          event, receipt.outcome === "rejected" ? receipt.reason : next === "acceptance_unknown" ? "response_lost" : next === "needs_review" ? "proof_invalid" : "none");
      });
    } catch { throw new ApprovalNotificationError(); }
  }
  private load(state: VerifiedAuditState, command: NotificationCommand) {
    const notification = this.records.readInState(state, "notification", command.notification_handle); if (notification === null) return null;
    const request = this.records.readInState(state, "request", notification.row.request_id); if (request === null) throw Error(); return { request, notification };
  }
  private matches(grant: { scope: ApprovalRecordScope; notification_id: string }, notification: Notification) {
    return grant.scope.instance_id === this.scope.instance_id && grant.scope.workspace_id === this.scope.workspace_id
      && grant.notification_id === notification.row.notification_attempt_id;
  }
  private marker(state: VerifiedAuditState, request: Request, notification: Notification, mark: Readonly<ClockMark>) {
    const created = this.history.readInState(state, notification.row.clock_transaction_id);
    if (created === null || created.boot_id !== mark.boot_id || created.continuous_ms > mark.continuous_ms || created.effective_utc > mark.effective_utc) throw Error();
    verifyApprovalNotificationMarker({ codec_version: 1, ...this.scope, request_id: request.row.request_id,
      notification_attempt_id: notification.row.notification_attempt_id, kind: notification.row.kind, semantic_hash: request.row.semantic_hash,
      created_at: created.effective_utc, key_version: notification.row.marker_key_version }, notification.row.marker_mac, this.markerKey(notification.row.marker_key_version));
  }
  private payloadAuthentic(request: Request, mark: Readonly<ClockMark>, state: VerifiedAuditState) {
    const payload = this.payloads.inspectInState(state, "request", request.row.request_id), snapshot = this.lifecycle.snapshot(request);
    if (payload?.metadata.state !== "active" || payload.secret.status !== "present") return false;
    const binding = payload.metadata.binding;
    if (binding.request_id !== request.row.request_id || binding.semantic_hash !== request.row.semantic_hash
      || "payload-store:" + binding.payload_ref !== snapshot.encrypted_content_ref || binding.created_at !== request.row.created_at
      || binding.content.mac !== snapshot.content_hmac_sha256 || binding.content.key_version !== snapshot.content_hmac_key_version) return false;
    try { openApprovalPayload(payload.secret.envelope, binding, this.wrappingKey(payload.secret.envelope.key_version), this.contentKey(binding.content.key_version), mark); return true; }
    catch { return false; }
  }
  private expiryDecision(mark: Readonly<ClockMark>, state: VerifiedAuditState, request: Request): Extract<ApprovalRecord, {kind:"decision"}> {
    if (!undecided.has(request.row.state) || this.records.readInState(state, "decision", request.row.request_id) !== null) throw Error();
    return { codec_version: 1, scope: this.scope, kind: "decision", row: {
      decision_id: opaque("apd_"), request_id: request.row.request_id, ...this.scope, semantic_hash: request.row.semantic_hash, binding_id: request.row.binding_id,
      binding_revision: request.row.binding_revision, kind: "expire", actor_kind: "system", actor_id: "approval_expiry", presentation_revision: null,
      decided_at: mark.effective_utc, clock_transaction_id: mark.transaction_id } };
  }
  private expire(mark: Readonly<ClockMark>, state: VerifiedAuditState, request: Request, event: Event) {
    return this.lifecycle.change(mark, state, request, "expired", this.expiryDecision(mark, state, request), { ...event, outcome: "succeeded", reason: "approval_expired" });
  }
  private change(mark: Readonly<ClockMark>, state: VerifiedAuditState, request: Request, notification: Notification, requestState: RequestState,
    deliveryState: DeliveryState, message: string | null, event: Event, reason: AuditEvent["reason"], resultStatus: "dispatching" | "updated" = "updated") {
    const next: Notification = { ...notification, row: { ...notification.row, state: deliveryState, fence: notification.row.fence + 1, message_ref: message ?? notification.row.message_ref } };
    const nextRequest: Request = { ...request, row: { ...request.row, state: requestState, revision: request.row.revision + Number(requestState !== request.row.state) } };
    const changes: ApprovalRecordSqlChange[] = [{ previous: notification, next }];
    if (requestState !== request.row.state) changes.push({ previous: request, next: nextRequest });
    if (requestState === "expired" && request.row.state !== "expired") {
      const decision = this.expiryDecision(mark, state, request);
      changes.push({ previous: null, next: decision }, { previous: null, next: { codec_version: 1, scope: this.scope, kind: "event",
        row: { event_id: opaque("ape_"), decision_id: decision.row.decision_id, kind: "dona_approval.decision.v1", state: "pending", delivered_at: null } } });
    }
    if (!requestPayloadRequired(requestState)) {
      // 別notificationのpending abortと既存sentの更新を同じtransactionへ含める。
      changes.push(...this.lifecycle.notifications(mark, state, request, nextRequest.row.revision)
        .filter(change => change.next.kind !== "notification" || change.next.row.notification_attempt_id !== notification.row.notification_attempt_id));
      if (deliveryState === "sent") {
        const revision = Math.max(nextRequest.row.revision, notification.row.presentation_revision + 1);
        const previous = this.records.readAliasInState(state, { name: "presentation_revision", notification_attempt_id: notification.row.notification_attempt_id, desired_revision: revision });
        if (previous === null) changes.push({ previous: null, next: { codec_version: 1, scope: this.scope, kind: "presentation", row: {
          update_id: opaque("apu_"), notification_attempt_id: notification.row.notification_attempt_id, message_ref: next.row.message_ref!, desired_revision: revision,
          state: "pending", fence: 0, clock_transaction_id: mark.transaction_id } } });
      }
    }
    const records = this.mutations.prepare(mark, state, changes), payload = this.payloads.inspectInState(state, "request", request.row.request_id);
    const removal = !requestPayloadRequired(requestState) && payload?.metadata.state === "active" ? this.payloadMutation.prepare(mark, state,
      [{ previous: payload.metadata, next: { ...payload.metadata, state: "deleted", deleted_at: mark.effective_utc }, envelope: null }]) : null;
    const outcome: AuditEvent["outcome"] = deliveryState === "acceptance_unknown" || deliveryState === "needs_review" ? deliveryState
      : deliveryState === "failed" ? "failed" : deliveryState === "dispatching" ? "pending" : "succeeded";
    return { event: { ...event, outcome, reason, receipt_id: message }, resource_commitments: [...records.resource_commitments, ...(removal?.resource_commitments ?? [])],
      mutation: (): ApprovalNotificationResult => { records.mutation(); removal?.mutation(); return this.result(resultStatus, nextRequest, next); } };
  }
  private result(status: "dispatching" | "updated" | "unchanged", request: Request, notification: Notification): ApprovalNotificationResult {
    return { status, notification_handle: notification.row.notification_attempt_id, delivery_state: notification.row.state, fence: notification.row.fence, request_state: request.row.state };
  }
  private unchanged(event: Event, request: Request, notification: Notification) {
    const outcome: AuditEvent["outcome"] = notification.row.state === "acceptance_unknown" || notification.row.state === "needs_review" ? notification.row.state
      : notification.row.state === "failed" ? "failed" : terminal(notification.row.state) ? "succeeded" : "pending";
    return { event: { ...event, outcome }, resource_digest: null, mutation: () => this.result("unchanged", request, notification) };
  }
  private denied(event: Event, reason: Extract<ApprovalNotificationResult, { status: "denied" }>["reason"]) {
    return { event: { ...event, outcome: "denied" as const, reason }, resource_digest: null,
      mutation: (): ApprovalNotificationResult => ({ status: "denied", reason }) };
  }
  private base(): Event {
    return { scope: { instance_id: this.scope.instance_id, tenant_id: this.scope.workspace_id }, actor: { kind: "unauthenticated", id: null },
      action: "approval_delivery", operation: "slack.post_thread_reply.v1", resource_id: "approval_notification", outcome: "denied", reason: "none",
      session_ref: null, receipt_id: null, attempt_id: null, policy_revision: 0, binding_revision: 0, authz_revision: 0 };
  }
  private event(request: Request, notification: Notification, actor: string): Event {
    return { ...this.base(), actor: { kind: "system", id: actor }, resource_id: request.row.request_id, attempt_id: notification.row.notification_attempt_id,
      binding_revision: request.row.binding_revision, policy_revision: request.row.policy_revision,
      authz_revision: this.lifecycle.snapshot(request).preconditions.requester_authorization_revision };
  }
}
