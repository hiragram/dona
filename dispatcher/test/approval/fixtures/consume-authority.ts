import assert from "node:assert/strict";
import type { ApprovalConsumeAuthority } from "../../../src/approval/consume-broker.js";
import type { ApprovalRecordRepository } from "../../../src/approval/record-repository.js";
import { scope } from "./broker.js";
/** Test-only authenticated consumer. This string is not a production proof. */
export function fixtureConsumeAuthority(records: ApprovalRecordRepository): ApprovalConsumeAuthority {
  return (command, request, _mark, state) => {
    assert.equal(command.authority_ref, "fixture_consumer_connection");
    const decision = records.readInState(state, "decision", request.row.request_id);
    if (decision === null) return { status: "denied", reason: "unauthorized" };
    const event = records.readAliasInState(state, { name: "event_decision", decision_id: decision.row.decision_id });
    assert.equal(event?.kind, "event"); if (event?.kind !== "event") throw Error();
    const snapshot = JSON.parse(request.row.snapshot_json);
    return { status: "verified", scope, request_id: request.row.request_id, decision_id: decision.row.decision_id, event_id: event.row.event_id,
      consumer_id: "fixture_executor", binding_id: request.row.binding_id, binding_revision: request.row.binding_revision,
      policy_revision: request.row.policy_revision, semantic_hash: request.row.semantic_hash,
      requester_authorization_revision: snapshot.preconditions.requester_authorization_revision, stale_reason: null };
  };
}
