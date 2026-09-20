import assert from "node:assert/strict";
import { decisionFixture } from "./decision.js";
import { fixtureConsumeAuthority } from "./consume-authority.js";
import { scope, content, wrapping, notification } from "./broker.js";
import { ApprovalConsumeBroker } from "../../../src/approval/consume-broker.js";
import { ApprovalExecutionBroker } from "../../../src/approval/execution-broker.js";
import { ApprovalExecutionMarkerStore } from "../../../src/approval/execution-marker-store.js";
import { installApprovalExecutionMarkerSchema } from "../../../src/approval/schema.js";
import { emptyMetadataRoot } from "../../../src/approval/metadata-tree.js";
import type { ApprovalExecutionMarkerKey } from "../../../src/approval/execution-marker.js";
import type { ExecutionCommand, ExecutionStartAuthority, ExecutionRecoveryAuthority, ExecutionReceiptAuthority } from "../../../src/approval/execution-authority.js";
import type { AuditEvent } from "../../../src/audit/codec.js";
export const executionKey: ApprovalExecutionMarkerKey = { purpose: "approval_execution_marker", version: 1, state: "active", activated_at: "2026-09-01T00:00:00.000Z",
  signing_expires_at: "2026-11-01T00:00:00.000Z", secret: Buffer.alloc(32, 94) };
export function executionFixture(t: { after(fn: () => void): void }) {
  const f = decisionFixture(t); f.decision.decide("approve", f.command("approve"));
  const consume = new ApprovalConsumeBroker(f.db, f.providers, scope, fixtureConsumeAuthority(f.records), () => content, () => wrapping, () => notification);
  const claim = consume.consume("consume", { request_handle: f.requestId, authority_ref: "fixture_consumer_connection", expected_revision: 3 });
  if (claim.status !== "claimed") throw Error();
  installApprovalExecutionMarkerSchema(f.db);
  const event: Omit<AuditEvent, "occurred_at"> = { scope: { instance_id: scope.instance_id, tenant_id: scope.workspace_id }, actor: { kind: "system", id: "fixture" },
    action: "approval_execution", operation: "slack.post_thread_reply.v1", resource_id: "fixture_root", outcome: "succeeded", reason: "none", session_ref: null,
    receipt_id: null, attempt_id: null, policy_revision: 1, binding_revision: 1, authz_revision: 1 };
  f.transaction.runPrepared("fixture_marker_admission", () => ({ event, resource_commitments: [{ scope: event.scope,
    resource_id: "approval_execution_markers", resource_digest: emptyMetadataRoot({ ...scope, collection: "approval_execution_markers_v1" }) }], mutation: () => null }));
  let startOverride: ((grant: ReturnType<ExecutionStartAuthority>) => ReturnType<ExecutionStartAuthority>) | null = null;
  let recoveryOverride: ((grant: ReturnType<ExecutionRecoveryAuthority>) => ReturnType<ExecutionRecoveryAuthority>) | null = null;
  let receiptOverride: ((grant: ReturnType<ExecutionReceiptAuthority>) => ReturnType<ExecutionReceiptAuthority>) | null = null;
  let receipt: Extract<ReturnType<ExecutionReceiptAuthority>, { status: "verified" }>["receipt"] = { outcome: "accepted", receipt_ref: "fixture_receipt" };
  let proof: "callback" | "reconcile" = "callback", revokedContent = false, revokedMarker = false, oldMarker = false;
  const start: ExecutionStartAuthority = (command, request, attempt) => {
    assert.equal(command.authority_ref, "fixture_executor_connection");
    const snapshot = JSON.parse(request.row.snapshot_json);
    const grant: ReturnType<ExecutionStartAuthority> = { status: "verified", scope, attempt_id: attempt.row.attempt_id, consumer_id: "fixture_executor",
      binding_id: request.row.binding_id, binding_revision: request.row.binding_revision, policy_revision: request.row.policy_revision, semantic_hash: request.row.semantic_hash,
      requester_authorization_revision: snapshot.preconditions.requester_authorization_revision, stale_reason: null };
    return startOverride ? startOverride(grant) : grant;
  };
  const recovery: ExecutionRecoveryAuthority = (command, _request, attempt) => {
    assert.equal(command.authority_ref, "fixture_executor_connection");
    const grant: ReturnType<ExecutionRecoveryAuthority> = { status: "verified", scope, attempt_id: attempt.row.attempt_id, consumer_id: "fixture_recovery" };
    return recoveryOverride ? recoveryOverride(grant) : grant;
  };
  const receipts: ExecutionReceiptAuthority = (command, _request, attempt) => {
    assert.equal(command.authority_ref, "fixture_executor_connection");
    const grant: ReturnType<ExecutionReceiptAuthority> = { status: "verified", scope, attempt_id: attempt.row.attempt_id, consumer_id: "fixture_receipt_reader",
      execution_fence: command.expected_fence, proof_kind: proof, receipt };
    return receiptOverride ? receiptOverride(grant) : grant;
  };
  // 認証文字列や結果はfixtureのみ。実connection/proof providerを提供しない。
  const broker = new ApprovalExecutionBroker(f.db, f.providers, scope, start, recovery, receipts,
    () => ({ ...content, state: revokedContent ? "revoked" : "active" }), () => wrapping,
    version => ({ ...executionKey, state: revokedMarker ? "revoked" : oldMarker && version !== null ? "verification_only" : "active" }));
  const attempt = () => f.records.read("execution", claim.attempt_handle)!;
  const command = (): ExecutionCommand => ({ attempt_handle: claim.attempt_handle, authority_ref: "fixture_executor_connection", expected_fence: attempt().row.fence });
  return { ...f, claim, execution: broker, attempt, executionCommand: command, markerStore: new ApprovalExecutionMarkerStore(f.db, f.providers, scope),
    authorities: { start, recovery, receipts },
    setStart: (value: typeof startOverride) => { startOverride = value; }, setRecovery: (value: typeof recoveryOverride) => { recoveryOverride = value; },
    setReceiptGrant: (value: typeof receiptOverride) => { receiptOverride = value; },
    setReceipt: (value: typeof receipt, kind: typeof proof = "callback") => { receipt = value; proof = kind; },
    revokeContent: () => { revokedContent = true; }, revokeMarker: () => { revokedMarker = true; }, retainMarker: () => { oldMarker = true; } };
}
