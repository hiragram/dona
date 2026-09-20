import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertSynchronousCallback, assertSynchronousResult } from "../audit/synchronous.js";
import type { AuditEvent, VerifiedAuditState } from "../audit/codec.js";
import type { ApprovalTransactionProviders } from "./transaction.js";
import { ApprovalHistoryTransaction } from "./history-transaction.js";
import { ApprovalClockHistory } from "./clock-history.js";
import { approvalExpired, approvalExpiry, type ClockMark } from "./clock.js";
import { ApprovalRecordRepository } from "./record-repository.js";
import { ApprovalRecordMutation } from "./record-mutation.js";
import type { ApprovalRecord, ApprovalRecordScope } from "./record-codec.js";
import type { ApprovalRecordSqlChange } from "./record-sql.js";
import { ApprovalPayloadRepository } from "./payload-repository.js";
import { ApprovalPayloadMutation } from "./payload-mutation.js";
import { openApprovalPayload, type ApprovalPayloadKey } from "./payload-protection.js";
import { decodeApprovalSnapshot } from "./snapshot.js";
import { verifyApprovalNotificationMarker, type ApprovalNotificationKey } from "./notification-marker.js";
import { recordDecision, terminateApproved, requestPayloadRequired, type RequestState } from "./domain.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const scopeSchema = z.strictObject({ instance_id: id, workspace_id: id });
const commandSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.enum(["approve", "reject"]), request_handle: id, authority_ref: id, expected_revision: positive, presentation_revision: positive }),
  z.strictObject({ action: z.literal("cancel"), request_handle: id, authority_ref: id, expected_revision: positive }),
]);
export type ApprovalDecisionCommand = z.infer<typeof commandSchema>;
type Request = Extract<ApprovalRecord, { kind: "request" }>;
type Decision = Extract<ApprovalRecord, { kind: "decision" }>;
const rejection = z.enum(["unauthenticated", "unauthorized", "proof_invalid", "scope_mismatch", "unavailable"]);
const staleReason = z.enum(["binding_revoked", "revision_mismatch", "snapshot_mismatch", "resource_not_visible"]);
const grantSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("denied"), reason: rejection }),
  z.strictObject({ status: z.literal("verified"), scope: scopeSchema, request_id: id, actor_kind: z.enum(["supervisor", "requester"]), actor_id: id,
    binding_id: id, binding_revision: positive, policy_revision: positive, semantic_hash: z.string().regex(/^[a-f0-9]{64}$/),
    requester_authorization_revision: positive, presentation_ref: id.nullable(), presentation_revision: positive.nullable(),
    stale_reason: staleReason.nullable() }),
]);
export type ApprovalDecisionGrant = z.infer<typeof grantSchema>;
/** trusted adapter専用。authority_refを認証済みconnection/durable inboxへ解決し、
 * actorのrequest操作権限、current binding/policy、requester権限、visibility、
 * shared状態とexact snapshotを毎回検証する。stale_reasonも認証済みactorが
 * このrequestを操作できる場合だけ返す。ID所持・client actorはproofではない。
 * stateは同期callback内で共有repositoryを読むためだけに有効。実providerなし。 */
export type ApprovalDecisionAuthority = (command: Readonly<ApprovalDecisionCommand>, request: Request,
  mark: Readonly<ClockMark>, state: VerifiedAuditState) => ApprovalDecisionGrant;
export type ApprovalDecisionResult =
  | { status: "decided" | "reused"; decision_handle: string; decision: Decision["row"]["kind"]; request_state: RequestState }
  | { status: "changed" | "unchanged"; request_state: RequestState }
  | { status: "denied"; reason: z.infer<typeof rejection> | "decision_conflict" | "presentation_stale" | "revision_mismatch" };
export class ApprovalDecisionError extends Error { constructor() { super("approval_decision_unverified"); this.name = "ApprovalDecisionError"; } }
const undecided = new Set<RequestState>(["requested", "delivery_pending", "delivery_unknown", "sent"]);
const opaque = (prefix: string) => prefix + randomUUID().replaceAll("-", "");

/** 内部durable decision core。外部API/配送/consume/実行を公開しない。 */
export class ApprovalDecisionBroker {
  private readonly scope: ApprovalRecordScope;
  private readonly transaction: ApprovalHistoryTransaction;
  private readonly history: ApprovalClockHistory;
  private readonly records: ApprovalRecordRepository;
  private readonly recordMutation: ApprovalRecordMutation;
  private readonly payloads: ApprovalPayloadRepository;
  private readonly payloadMutation: ApprovalPayloadMutation;
  constructor(db: Database.Database, providers: ApprovalTransactionProviders, scope: ApprovalRecordScope,
    private readonly authorize: ApprovalDecisionAuthority,
    private readonly contentKey: (version: number) => ApprovalPayloadKey,
    private readonly wrappingKey: (version: number) => ApprovalPayloadKey,
    private readonly notificationKey: (version: number) => ApprovalNotificationKey) {
    try {
      assertSynchronousResult(scope); this.scope = Object.freeze(scopeSchema.parse(scope));
      for (const callback of [authorize, contentKey, wrappingKey, notificationKey]) assertSynchronousCallback(callback);
      this.transaction = new ApprovalHistoryTransaction(db, providers, this.scope);
      this.history = new ApprovalClockHistory(db, this.scope);
      this.records = new ApprovalRecordRepository(db, providers.auditAnchors, providers.auditKeys, this.scope);
      this.recordMutation = new ApprovalRecordMutation(db, this.scope);
      this.payloads = new ApprovalPayloadRepository(db, providers.auditAnchors, providers.auditKeys, this.scope);
      this.payloadMutation = new ApprovalPayloadMutation(db, this.scope);
    } catch { throw new ApprovalDecisionError(); }
  }
  decide(transactionId: string, input: ApprovalDecisionCommand): ApprovalDecisionResult {
    try {
      assertSynchronousResult(input); const command = Object.freeze(commandSchema.parse(input));
      return this.transaction.runPrepared<() => ApprovalDecisionResult>(transactionId, (mark, state) => {
        const request = this.records.readInState(state, "request", command.request_handle);
        const base = this.event(command.action);
        const denied = (reason: Extract<ApprovalDecisionResult, { status: "denied" }>["reason"], event = base) =>
          ({ event: { ...event, outcome: "denied" as const, reason }, resource_digest: null, mutation: () => ({ status: "denied" as const, reason }) });
        if (request === null) return denied("unauthorized");
        const raw = this.authorize(command, request, mark, state); assertSynchronousResult(raw);
        const grant = grantSchema.parse(raw);
        if (grant.status === "denied") return denied(grant.reason);
        const snapshot = this.snapshot(request);
        if (grant.scope.instance_id !== this.scope.instance_id || grant.scope.workspace_id !== this.scope.workspace_id
          || grant.request_id !== request.row.request_id) return denied("scope_mismatch");
        if (command.action === "cancel" ? grant.actor_kind !== "requester" || grant.actor_id !== snapshot.request_source.owner_id
          : grant.actor_kind !== "supervisor") return denied("unauthorized");
        const event = { ...base, actor: { kind: "principal" as const, id: grant.actor_id }, resource_id: request.row.request_id,
          binding_revision: request.row.binding_revision, policy_revision: request.row.policy_revision,
          authz_revision: snapshot.preconditions.requester_authorization_revision };
        this.verifyClock(request, mark, state);
        const prior = this.records.readInState(state, "decision", request.row.request_id);
        // Proof mismatch must not invalidate a request even when policy also drifted.
        if (command.action !== "cancel") {
          const card = this.notification(state, request, "approval_card");
          if (card.row.state !== "sent" || grant.presentation_ref !== card.row.message_ref
            || command.presentation_revision !== card.row.presentation_revision || grant.presentation_revision !== card.row.presentation_revision
            || command.expected_revision !== card.row.request_revision) return denied("presentation_stale", event);
          const notificationMark = this.history.readInState(state, card.row.clock_transaction_id);
          if (notificationMark === null || notificationMark.boot_id !== mark.boot_id
            || notificationMark.continuous_ms > mark.continuous_ms || notificationMark.effective_utc > mark.effective_utc) throw Error();
          verifyApprovalNotificationMarker({ codec_version: 1, ...this.scope, request_id: request.row.request_id,
            notification_attempt_id: card.row.notification_attempt_id, kind: "approval_card", semantic_hash: request.row.semantic_hash,
            created_at: notificationMark.effective_utc, key_version: card.row.marker_key_version }, card.row.marker_mac,
            this.notificationKey(card.row.marker_key_version));
        } else if (command.expected_revision !== request.row.revision && !(prior?.row.kind === "cancel" && prior.row.actor_id === grant.actor_id)) {
          return denied("revision_mismatch", event);
        }
        const mutable = undecided.has(request.row.state) || request.row.state === "approved";
        const drift = grant.stale_reason !== null || grant.binding_id !== request.row.binding_id || grant.binding_revision !== request.row.binding_revision
          || grant.policy_revision !== request.row.policy_revision || grant.semantic_hash !== request.row.semantic_hash
          || grant.requester_authorization_revision !== snapshot.preconditions.requester_authorization_revision;
        if (mutable && drift) return this.change(mark, state, request, "needs_review", null,
          { ...event, outcome: "needs_review", reason: grant.stale_reason ?? "revision_mismatch" });
        if (drift) return denied("unauthorized", event);
        if (command.action !== "cancel") {
          if (prior !== null) {
            if (prior.row.kind !== command.action || prior.row.actor_kind !== grant.actor_kind || prior.row.actor_id !== grant.actor_id
              || prior.row.presentation_revision !== command.presentation_revision) return denied("decision_conflict", event);
            return { event: { ...event, outcome: "succeeded" as const, reason: "none" as const }, resource_digest: null,
              mutation: () => ({ status: "reused" as const, decision_handle: prior.row.decision_id, decision: prior.row.kind, request_state: request.row.state }) };
          }
        } else if (prior?.row.kind === "cancel" && prior.row.actor_id === grant.actor_id) {
          return { event: { ...event, outcome: "succeeded" as const, reason: "none" as const }, resource_digest: null,
            mutation: () => ({ status: "reused" as const, decision_handle: prior.row.decision_id, decision: prior.row.kind, request_state: request.row.state }) };
        }
        if (!mutable) return denied("decision_conflict", event);
        if (command.expected_revision !== request.row.revision) return denied("revision_mismatch", event);
        if (request.row.state === "approved") {
          if (command.action !== "cancel") return denied("decision_conflict", event);
          const expired = approvalExpired(request.row.consume_expires_at!, mark);
          return this.change(mark, state, request, terminateApproved("approved", expired ? "expire" : "cancel"), null,
            { ...event, outcome: "succeeded", reason: expired ? "consume_expired" : "none" });
        }
        if (approvalExpired(request.row.expires_at, mark)) return this.expireRequest(mark, state, request);
        if (prior !== null) return denied("decision_conflict", event);
        let next: RequestState;
        if (command.action === "cancel") next = recordDecision(request.row.state, this.notification(state, request, "approval_card").row.state, "cancel");
        else {
          if (request.row.state !== "sent") return denied("presentation_stale", event);
          next = recordDecision(request.row.state, "sent", command.action);
          if (command.action === "approve" && !this.payloadAuthentic(request, mark, state))
            return this.change(mark, state, request, "needs_review", null, { ...event, outcome: "needs_review", reason: "integrity_failure" });
        }
        const decision = this.decision(request, mark, command.action, grant.actor_kind, grant.actor_id,
          command.action === "cancel" ? null : command.presentation_revision);
        return this.change(mark, state, request, next, decision, { ...event, outcome: "succeeded", reason: "none" });
      });
    } catch { throw new ApprovalDecisionError(); }
  }
  /** trusted内部expiry worker専用。transport commandとして公開しない。 */
  expire(transactionId: string, requestHandle: string): ApprovalDecisionResult {
    try {
      id.parse(requestHandle);
      return this.transaction.runPrepared<() => ApprovalDecisionResult>(transactionId, (mark, state) => {
        const request = this.records.readInState(state, "request", requestHandle);
        if (request === null) throw Error();
        this.verifyClock(request, mark, state);
        if (undecided.has(request.row.state) && approvalExpired(request.row.expires_at, mark)) return this.expireRequest(mark, state, request);
        const event = { ...this.event("cancel"), actor: { kind: "system" as const, id: "approval_expiry" }, operation: "slack.post_thread_reply.v1" as const, resource_id: request.row.request_id,
          policy_revision: request.row.policy_revision, binding_revision: request.row.binding_revision, outcome: "succeeded" as const, reason: "none" as const };
        if (request.row.state === "approved" && approvalExpired(request.row.consume_expires_at!, mark))
          return this.change(mark, state, request, "consume_expired", null, { ...event, reason: "consume_expired" });
        return { event, resource_digest: null, mutation: () => ({ status: "unchanged" as const, request_state: request.row.state }) };
      });
    } catch { throw new ApprovalDecisionError(); }
  }
  private event(action: ApprovalDecisionCommand["action"]): Omit<AuditEvent, "occurred_at"> {
    return { scope: { instance_id: this.scope.instance_id, tenant_id: this.scope.workspace_id }, actor: { kind: "unauthenticated", id: null },
      action: "approval_decision", operation: action === "approve" ? "approval.approve.v1" : action === "reject" ? "approval.reject.v1" : "approval.cancel.v1",
      resource_id: "approval_decision", outcome: "denied", reason: "unauthenticated", session_ref: null, receipt_id: null, attempt_id: null,
      policy_revision: 0, binding_revision: 0, authz_revision: 0 };
  }
  private snapshot(request: Request) {
    const stored = JSON.parse(request.row.snapshot_json);
    return decodeApprovalSnapshot(request.row.snapshot_json, request.row.semantic_hash, { ...this.scope, request_source: stored.request_source }).snapshot;
  }
  private verifyClock(request: Request, mark: Readonly<ClockMark>, state: VerifiedAuditState): void {
    const created = this.history.readInState(state, request.row.clock_transaction_id);
    if (created === null || created.effective_utc !== request.row.created_at || created.boot_id !== mark.boot_id
      || created.continuous_ms > mark.continuous_ms || created.effective_utc > mark.effective_utc) throw Error();
    if (request.row.consume_expires_at !== null) {
      const decision = this.records.readInState(state, "decision", request.row.request_id);
      if (decision === null || decision.row.kind !== "approve") throw Error();
      const approved = this.history.readInState(state, decision.row.clock_transaction_id);
      if (approved === null || approved.effective_utc !== decision.row.decided_at || approved.boot_id !== mark.boot_id
        || approved.continuous_ms > mark.continuous_ms || approved.effective_utc > mark.effective_utc
        || approvalExpiry(approved, "consume") !== request.row.consume_expires_at) throw Error();
    }
  }
  private notification(state: VerifiedAuditState, request: Request, kind: "approval_card" | "pending_notice") {
    const row = this.records.readAliasInState(state, { name: "notification_request_kind", request_id: request.row.request_id, notification_kind: kind });
    if (row?.kind !== "notification") throw Error(); return row;
  }
  private payloadAuthentic(request: Request, mark: Readonly<ClockMark>, state: VerifiedAuditState): boolean {
    const payload = this.payloads.inspectInState(state, "request", request.row.request_id);
    if (payload === null) return false;
    const snapshot = this.snapshot(request), binding = payload.metadata.binding;
    if (payload.metadata.state !== "active" || payload.secret.status !== "present" || binding.request_id !== request.row.request_id
      || binding.semantic_hash !== request.row.semantic_hash || "payload-store:" + binding.payload_ref !== snapshot.encrypted_content_ref
      || binding.created_at !== request.row.created_at || binding.content.mac !== snapshot.content_hmac_sha256
      || binding.content.key_version !== snapshot.content_hmac_key_version) return false;
    try {
      // 本文は戻り値・audit・outboxへ渡さず認証にだけ使う。
      openApprovalPayload(payload.secret.envelope, binding, this.wrappingKey(payload.secret.envelope.key_version),
        this.contentKey(binding.content.key_version), mark); return true;
    } catch { return false; }
  }
  private decision(request: Request, mark: Readonly<ClockMark>, kind: Decision["row"]["kind"], actorKind: Decision["row"]["actor_kind"], actorId: string, presentation: number | null): Decision {
    return { codec_version: 1, scope: this.scope, kind: "decision", row: { decision_id: opaque("apd_"), request_id: request.row.request_id, ...this.scope,
      semantic_hash: request.row.semantic_hash, binding_id: request.row.binding_id, binding_revision: request.row.binding_revision,
      kind, actor_kind: actorKind, actor_id: actorId, presentation_revision: presentation, decided_at: mark.effective_utc, clock_transaction_id: mark.transaction_id } };
  }
  private expireRequest(mark: Readonly<ClockMark>, state: VerifiedAuditState, request: Request) {
    if (this.records.readInState(state, "decision", request.row.request_id) !== null) throw Error();
    return this.change(mark, state, request, "expired", this.decision(request, mark, "expire", "system", "approval_expiry", null),
      { ...this.event("cancel"), actor: { kind: "system", id: "approval_expiry" }, operation: "slack.post_thread_reply.v1", resource_id: request.row.request_id,
        binding_revision: request.row.binding_revision, policy_revision: request.row.policy_revision, outcome: "succeeded", reason: "approval_expired" });
  }
  private change(mark: Readonly<ClockMark>, state: VerifiedAuditState, request: Request, nextState: RequestState, decision: Decision | null, event: Omit<AuditEvent, "occurred_at">) {
    const next: Request = { ...request, row: { ...request.row, state: nextState, revision: request.row.revision + 1,
      consume_expires_at: nextState === "approved" ? approvalExpiry(mark, "consume") : request.row.consume_expires_at } };
    const changes: ApprovalRecordSqlChange[] = [{ previous: request, next }];
    if (decision !== null) {
      changes.push({ previous: null, next: decision }, { previous: null, next: { codec_version: 1, scope: this.scope, kind: "event",
        row: { event_id: opaque("ape_"), decision_id: decision.row.decision_id, kind: "dona_approval.decision.v1", state: "pending", delivered_at: null } } });
    }
    for (const kind of ["approval_card", "pending_notice"] as const) {
      const notification = this.notification(state, request, kind);
      if (notification.row.state === "pending") changes.push({ previous: notification, next: { ...notification, row: { ...notification.row, state: "aborted" } } });
      if (notification.row.state === "sent") {
        const revision = Math.max(next.row.revision, notification.row.presentation_revision + 1);
        const prior = this.records.readAliasInState(state, { name: "presentation_revision", notification_attempt_id: notification.row.notification_attempt_id, desired_revision: revision });
        if (prior === null) changes.push({ previous: null, next: { codec_version: 1, scope: this.scope, kind: "presentation", row: {
          update_id: opaque("apu_"), notification_attempt_id: notification.row.notification_attempt_id, message_ref: notification.row.message_ref!, desired_revision: revision,
          state: "pending", fence: 0, clock_transaction_id: mark.transaction_id } } });
      }
    }
    const records = this.recordMutation.prepare(mark, state, changes);
    const payload = this.payloads.inspectInState(state, "request", request.row.request_id);
    const removal = !requestPayloadRequired(nextState) && payload?.metadata.state === "active"
      ? this.payloadMutation.prepare(mark, state, [{ previous: payload.metadata, next: { ...payload.metadata, state: "deleted", deleted_at: mark.effective_utc }, envelope: null }]) : null;
    return { event, resource_commitments: [...(removal?.resource_commitments ?? []), ...records.resource_commitments], mutation: (): ApprovalDecisionResult => {
      records.mutation(); removal?.mutation();
      return decision === null ? { status: "changed", request_state: nextState }
        : { status: "decided", decision_handle: decision.row.decision_id, decision: decision.row.kind, request_state: nextState };
    } };
  }
}
