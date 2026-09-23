import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuditEvent, VerifiedAuditState } from "../audit/codec.js";
import { assertSynchronousResult } from "../audit/synchronous.js";
import type { ApprovalTransactionProviders } from "./transaction.js";
import { ApprovalClockHistory } from "./clock-history.js";
import { approvalExpiry, type ClockMark } from "./clock.js";
import { ApprovalRecordRepository } from "./record-repository.js";
import { ApprovalRecordMutation } from "./record-mutation.js";
import type { ApprovalRecord, ApprovalRecordScope } from "./record-codec.js";
import type { ApprovalRecordSqlChange } from "./record-sql.js";
import { ApprovalPayloadRepository } from "./payload-repository.js";
import { ApprovalPayloadMutation } from "./payload-mutation.js";
import { decodeApprovalSnapshot } from "./snapshot.js";
import { requestPayloadRequired, type RequestState } from "./domain.js";

type Request = Extract<ApprovalRecord, {kind:"request"}>;
type Decision = Extract<ApprovalRecord, {kind:"decision"}>;
export type ApprovalLifecycleResult = {status:"changed";request_state:RequestState}
  | {status:"decided";decision_handle:string;decision:Decision["row"]["kind"];request_state:RequestState};
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const opaque = (prefix:string) => prefix + randomUUID().replaceAll("-", "");
/** 認可済みbroker prepareの内部plan。actor認可・外部送信・transaction開始を
 * 代行しない。同じVerifiedAuditStateと保護clock mutationへだけ接続する。 */
export class ApprovalRequestLifecycle {
  private readonly scope: ApprovalRecordScope;
  private readonly history: ApprovalClockHistory;
  private readonly records: ApprovalRecordRepository;
  private readonly recordMutation: ApprovalRecordMutation;
  private readonly payloads: ApprovalPayloadRepository;
  private readonly payloadMutation: ApprovalPayloadMutation;
  constructor(db:Database.Database, providers:ApprovalTransactionProviders, scope:ApprovalRecordScope) {
    assertSynchronousResult(scope);this.scope=Object.freeze(z.strictObject({instance_id:id,workspace_id:id}).parse(scope));
    this.history=new ApprovalClockHistory(db,this.scope);
    this.records=new ApprovalRecordRepository(db,providers.auditAnchors,providers.auditKeys,this.scope);
    this.recordMutation=new ApprovalRecordMutation(db,this.scope);
    this.payloads=new ApprovalPayloadRepository(db,providers.auditAnchors,providers.auditKeys,this.scope);
    this.payloadMutation=new ApprovalPayloadMutation(db,this.scope);
  }
  snapshot(request: Request) {
    const stored = JSON.parse(request.row.snapshot_json);
    return decodeApprovalSnapshot(request.row.snapshot_json, request.row.semantic_hash, { ...this.scope, request_source: stored.request_source }).snapshot;
  }
  verifyClock(request: Request, mark: Readonly<ClockMark>, state: VerifiedAuditState): void {
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
  notification(state: VerifiedAuditState, request: Request, kind: "approval_card" | "pending_notice") {
    const row = this.records.readAliasInState(state, { name: "notification_request_kind", request_id: request.row.request_id, notification_kind: kind });
    if (row?.kind !== "notification") throw Error(); return row;
  }
  notifications(mark:Readonly<ClockMark>,state:VerifiedAuditState,request:Request,nextRevision:number):ApprovalRecordSqlChange[] {
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(nextRevision);
    const changes:ApprovalRecordSqlChange[]=[];
    for (const kind of ["approval_card", "pending_notice"] as const) {
      const notification = this.notification(state, request, kind);
      if (notification.row.state === "pending") changes.push({ previous: notification, next: { ...notification, row: { ...notification.row, state: "aborted" } } });
      if (notification.row.state === "sent") {
        const revision = Math.max(nextRevision, notification.row.presentation_revision + 1);
        const prior = this.records.readAliasInState(state, { name: "presentation_revision", notification_attempt_id: notification.row.notification_attempt_id, desired_revision: revision });
        if (prior === null) changes.push({ previous: null, next: { codec_version: 1, scope: this.scope, kind: "presentation", row: {
          update_id: opaque("apu_"), notification_attempt_id: notification.row.notification_attempt_id, message_ref: notification.row.message_ref!, desired_revision: revision,
          state: "pending", fence: 0, clock_transaction_id: mark.transaction_id } } });
      }
    }
    return changes;
  }
  change(mark: Readonly<ClockMark>, state: VerifiedAuditState, request: Request, nextState: RequestState, decision: Decision | null, event: Omit<AuditEvent, "occurred_at">) {
    const next: Request = { ...request, row: { ...request.row, state: nextState, revision: request.row.revision + 1,
      consume_expires_at: nextState === "approved" ? approvalExpiry(mark, "consume") : request.row.consume_expires_at } };
    const changes: ApprovalRecordSqlChange[] = [{ previous: request, next }];
    if (decision !== null) {
      changes.push({ previous: null, next: decision }, { previous: null, next: { codec_version: 1, scope: this.scope, kind: "event",
        row: { event_id: opaque("ape_"), decision_id: decision.row.decision_id, kind: "dona_approval.decision.v1", state: "pending", delivered_at: null } } });
    }
    changes.push(...this.notifications(mark, state, request, next.row.revision));
    const records = this.recordMutation.prepare(mark, state, changes);
    const payload = this.payloads.inspectInState(state, "request", request.row.request_id);
    const removal = !requestPayloadRequired(nextState) && payload?.metadata.state === "active"
      ? this.payloadMutation.prepare(mark, state, [{ previous: payload.metadata, next: { ...payload.metadata, state: "deleted", deleted_at: mark.effective_utc }, envelope: null }]) : null;
    return { event, resource_commitments: [...(removal?.resource_commitments ?? []), ...records.resource_commitments], mutation: (): ApprovalLifecycleResult => {
      records.mutation(); removal?.mutation();
      return decision === null ? { status: "changed", request_state: nextState }
        : { status: "decided", decision_handle: decision.row.decision_id, decision: decision.row.kind, request_state: nextState };
    } };
  }
}
