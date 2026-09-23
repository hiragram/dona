import type { ApprovalRecord } from "./record-codec.js";
import type { ApprovalIndexIdentity } from "./index-codec.js";
type Selector = Extract<ApprovalIndexIdentity, { kind: "alias" }>["selector"];
/** 構造検証済みrecordからのみ呼ぶ内部固定mapping。 */
export function approvalRecordAliases(record: ApprovalRecord): readonly Selector[] {
  switch (record.kind) {
    case "request": return [{ name: "request_creation", creation_key: record.row.creation_key }];
    case "decision": return [{ name: "decision_id", decision_id: record.row.decision_id }];
    case "consume": return [{ name: "consume_id", consume_id: record.row.consume_id }, { name: "consume_decision", decision_id: record.row.decision_id }, { name: "consume_attempt", attempt_id: record.row.attempt_id }];
    case "execution": return [{ name: "execution_request", request_id: record.row.request_id }, { name: "execution_consume", consume_id: record.row.consume_id }];
    case "notification": return [{ name: "notification_request_kind", request_id: record.row.request_id, notification_kind: record.row.kind },
      ...(record.row.message_ref === null ? [] : [{ name: "notification_message" as const, message_ref: record.row.message_ref }])];
    case "event": return [{ name: "event_decision", decision_id: record.row.decision_id }];
    case "presentation": return [{ name: "presentation_revision", notification_attempt_id: record.row.notification_attempt_id, desired_revision: record.row.desired_revision }];
  }
}
export function approvalRecordPrimary(record: ApprovalRecord): string {
  switch (record.kind) {
    case "request": case "decision": case "consume": return record.row.request_id;
    case "execution": return record.row.attempt_id;
    case "notification": return record.row.notification_attempt_id;
    case "event": return record.row.event_id;
    case "presentation": return record.row.update_id;
  }
}
export function approvalRecordActive(record: ApprovalRecord): boolean {
  switch (record.kind) {
    case "request": return ["requested", "delivery_pending", "delivery_unknown", "sent", "approved"].includes(record.row.state);
    case "decision": case "consume": return false;
    case "execution": return ["claimed", "executing", "acceptance_unknown"].includes(record.row.state);
    case "notification": case "presentation": return ["pending", "dispatching", "acceptance_unknown"].includes(record.row.state);
    case "event": return record.row.state === "pending";
  }
}
