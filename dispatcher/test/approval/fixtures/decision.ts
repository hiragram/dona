import assert from "node:assert/strict";
import { ApprovalDecisionBroker, type ApprovalDecisionCommand, type ApprovalDecisionGrant, type ApprovalDecisionAuthority } from "../../../src/approval/decision-broker.js";
import { ApprovalHistoryTransaction } from "../../../src/approval/history-transaction.js";
import { ApprovalRecordMutation } from "../../../src/approval/record-mutation.js";
import type { ApprovalRecord } from "../../../src/approval/record-codec.js";
import type { AuditEvent, VerifiedAuditState } from "../../../src/audit/codec.js";
import { assertCurrentAuditReadState } from "../../../src/audit/repository.js";
import { fixture, scope, intent, content, wrapping, notification as notificationKey } from "./broker.js";
export function decisionFixture(t: { after(fn: () => void): void }, sent = true) {
  const f = fixture(t), created = f.broker.create("create", intent);
  if (created.status === "denied") throw Error();
  const requestId = created.request_handle;
  const tx = new ApprovalHistoryTransaction(f.db, f.providers, scope), mutation = new ApprovalRecordMutation(f.db, scope);
  const notification = (kind: "approval_card" | "pending_notice") => {
    const row = f.records.readAlias({ name: "notification_request_kind", request_id: requestId, notification_kind: kind });
    if (row?.kind !== "notification") throw Error(); return row;
  };
  // Fixture-only delivery; no production adapter/claim is simulated as live proof.
  const deliver = (kind: "approval_card" | "pending_notice") => {
    const attemptId = notification(kind).row.notification_attempt_id;
    for (const next of ["dispatching", "sent"] as const) tx.runPrepared("fixture_" + kind + "_" + next, (mark, state) => {
      const old = f.records.readInState(state, "notification", attemptId)!;
      const request = f.records.readInState(state, "request", requestId)!;
      const changes: Array<{previous: ApprovalRecord; next: ApprovalRecord}> = [{ previous: old, next: { ...old, row: {
        ...old.row, state: next, fence: 1, message_ref: next === "sent" ? "message_" + kind : null } } }];
      if (kind === "approval_card" && next === "sent") changes.push({ previous: request, next: { ...request, row: { ...request.row, state: "sent", revision: request.row.revision + 1 } } });
      const event: Omit<AuditEvent, "occurred_at"> = { scope: { instance_id: scope.instance_id, tenant_id: scope.workspace_id }, actor: { kind: "system", id: "fixture" },
        action: "approval_delivery", operation: "slack.post_thread_reply.v1", resource_id: requestId, outcome: "succeeded", reason: "none", session_ref: null, receipt_id: null, attempt_id: null,
        policy_revision: 1, binding_revision: 3, authz_revision: 7 };
      return { event, ...mutation.prepare(mark, state, changes) };
    });
  };
  if (sent) deliver("approval_card");
  let override: ((grant: Extract<ApprovalDecisionGrant, { status: "verified" }>) => ApprovalDecisionGrant) | null = null;
  let captured: VerifiedAuditState | null = null, calls = 0;
  const authorize: ApprovalDecisionAuthority = (command, request, _mark, state) => {
    calls++; captured = state; assertCurrentAuditReadState(f.db, state); assert.equal(command.authority_ref, "fixture_authenticated_inbox");
    assert.equal(f.records.readInState(state, "request", request.row.request_id)!.row.revision, request.row.revision);
    const snapshot = JSON.parse(request.row.snapshot_json);
    const g: Extract<ApprovalDecisionGrant, { status: "verified" }> = { status: "verified", scope, request_id: requestId,
      actor_kind: command.action === "cancel" ? "requester" : "supervisor", actor_id: command.action === "cancel" ? snapshot.request_source.owner_id : "supervisor",
      binding_id: request.row.binding_id, binding_revision: request.row.binding_revision, policy_revision: request.row.policy_revision,
      semantic_hash: request.row.semantic_hash, requester_authorization_revision: snapshot.preconditions.requester_authorization_revision,
      presentation_ref: command.action === "cancel" ? null : "message_approval_card", presentation_revision: command.action === "cancel" ? null : 1, stale_reason: null };
    return override ? override(g) : g;
  };
  const broker = new ApprovalDecisionBroker(f.db, f.providers, scope, authorize, () => content, () => wrapping, () => notificationKey);
  const command = (action: "approve" | "reject" | "cancel", revision = 1): ApprovalDecisionCommand => ({ action, request_handle: requestId,
    authority_ref: "fixture_authenticated_inbox", expected_revision: revision, ...(action === "cancel" ? {} : { presentation_revision: 1 }) }) as ApprovalDecisionCommand;
  return { ...f, authorize, decision: broker, requestId, notification, deliver, command, setGrant: (fn: typeof override) => { override = fn; },
    authorityState: () => captured, calls: () => calls, read: () => f.records.read("request", requestId)!,
    rows: (table: "approval_decisions" | "approval_event_outbox" | "approval_payload_secrets" | "approval_presentation_updates") => Number(f.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()) };
}
