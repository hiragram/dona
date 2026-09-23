import { encodeApprovalSnapshot, type ApprovalSnapshot, type ApprovalSourceContext } from "../../../src/approval/snapshot.js";
import type { ApprovalRecord, ApprovalRecordKind } from "../../../src/approval/record-codec.js";
export const recordScope = { instance_id: "instance_a", workspace_id: "workspace_a" };
const context: ApprovalSourceContext = { ...recordScope, request_source: { source_event_id: "event_a", source_job_id: null,
  owner_kind: "authenticated_event_actor", owner_id: "requester_a", operation_slot: "reply_1" } };
export function snapshotFixture(): ApprovalSnapshot {
  return { codec_version: 1, operation_kind: "slack.post_thread_reply.v1", ...structuredClone(context),
    target: { channel_id: "channel_a", thread_ts: "1700000000.000001" }, policy_revision: 1,
    policy: { reply_broadcast: false, special_mentions: "deny_all", allowed_user_mentions: [], max_user_mentions: 3, shared_channel: "deny", reconcile_marker: "block_id_attempt_id_mac_v1" },
    encrypted_content_ref: "payload-store:fixture_content", content_hmac_sha256: "a".repeat(64), content_hmac_key_version: 1,
    preconditions: { thread_exists: true, channel_is_shared: false, root_message_revision: { edited_ts: null, content_hmac_sha256: "b".repeat(64) },
      ordered_thread_revision: { complete: true, items: [{ message_ts: "1700000000.000001", edited_ts: null, content_hmac_sha256: "b".repeat(64) }] },
      workspace_binding_revision: 3, requester_authorization_revision: 7 } };
}
/** Canonical storage fixtures only. Actor fields and binding IDs do not provide
 * authenticated provenance; no production broker or adapter consumes these. */
export function recordFixtures(): { [K in ApprovalRecordKind]: Extract<ApprovalRecord, { kind: K }> } {
  const snapshot = encodeApprovalSnapshot(snapshotFixture(), context);
  const owner = { codec_version: 1 as const, scope: { ...recordScope } }, clock = { clock_transaction_id: "fixture_clock" };
  return {
    request: { ...owner, kind: "request", row: { request_id: "request", ...recordScope, creation_key: snapshot.creation_key,
      snapshot_json: snapshot.canonical, semantic_hash: snapshot.semantic_hash, binding_id: "binding", binding_revision: 3,
      policy_revision: 1, model_version: "fixture-1.0", state: "requested", revision: 1, created_at: "2026-09-19T00:00:00.000Z",
      expires_at: "2026-09-19T00:15:00.000Z", consume_expires_at: null, ...clock } },
    decision: { ...owner, kind: "decision", row: { decision_id: "decision", request_id: "request", ...recordScope,
      semantic_hash: snapshot.semantic_hash, binding_id: "binding", binding_revision: 3, kind: "approve", actor_kind: "supervisor",
      actor_id: "supervisor", presentation_revision: 1, decided_at: "2026-09-19T00:14:00.000Z", ...clock } },
    consume: { ...owner, kind: "consume", row: { consume_id: "consume", request_id: "request", decision_id: "decision",
      decision_kind: "approve", attempt_id: "attempt", claimed_at: "2026-09-19T00:18:00.000Z", ...clock } },
    execution: { ...owner, kind: "execution", row: { attempt_id: "attempt", request_id: "request", consume_id: "consume",
      state: "claimed", fence: 1, claimed_at: "2026-09-19T00:18:00.000Z", execution_expires_at: "2026-09-19T00:18:30.000Z",
      payload_expires_at: "2026-09-20T00:18:00.000Z", receipt_ref: null, failure_code: null, ...clock } },
    notification: { ...owner, kind: "notification", row: { notification_attempt_id: "notification", request_id: "request", kind: "approval_card",
      state: "pending", request_revision: 1, presentation_revision: 1, marker_mac: "c".repeat(64), marker_key_version: 1, fence: 0, message_ref: null, ...clock } },
    event: { ...owner, kind: "event", row: { event_id: "event", decision_id: "decision", kind: "dona_approval.decision.v1", state: "pending", delivered_at: null } },
    presentation: { ...owner, kind: "presentation", row: { update_id: "update", notification_attempt_id: "notification", message_ref: "adapter_message",
      desired_revision: 2, state: "pending", fence: 0, ...clock } },
  };
}
