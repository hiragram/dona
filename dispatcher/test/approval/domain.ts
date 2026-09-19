import assert from "node:assert/strict";
import test from "node:test";
import { recordDecision, invalidateRequest, terminateApproved, settleDelivery, claimDelivery, abortPendingDelivery,
  recoverDelivery, transitionExecution, recoverExecution, requestPayloadRequired, ApprovalTransitionError,
  type RequestState, type DecisionKind, type ExecutionState } from "../../src/approval/domain.js";

test("approvalはexecution成功ではなく、同期済みpresentationだけからconsumeへ進む", () => {
  const dispatched = claimDelivery("delivery_pending", "pending");
  const sent = settleDelivery("delivery_pending", dispatched, "sent");
  const approved = recordDecision(sent.request, sent.delivery, "approve");
  assert.equal(approved, "approved"); assert.equal(requestPayloadRequired(approved), true);
  assert.equal(terminateApproved(approved, "consume"), "consumed");
  assert.equal(requestPayloadRequired("consumed"), false);
  assert.equal(transitionExecution("claimed", "executing"), "executing");
  assert.equal(transitionExecution("executing", "succeeded"), "succeeded");
  assert.throws(() => transitionExecution("claimed", "succeeded"), ApprovalTransitionError);
  for (const [request, delivery] of [["delivery_unknown", "acceptance_unknown"], ["delivery_pending", "dispatching"], ["sent", "dispatching"]] as const) {
    assert.throws(() => recordDecision(request, delivery, "approve"), ApprovalTransitionError);
  }
});

test("decisionの先着後にapprove・reject・cancel・expireで上書きできない", () => {
  for (const first of ["approve", "reject", "cancel", "expire"] as const) {
    const state = recordDecision("sent", "sent", first);
    for (const later of ["approve", "reject", "cancel", "expire"] as DecisionKind[]) {
      assert.throws(() => recordDecision(state, "sent", later), ApprovalTransitionError);
    }
  }
  for (const state of ["execution_cancelled", "consume_expired", "consumed", "needs_review"] as RequestState[]) {
    assert.throws(() => terminateApproved(state, "consume"), ApprovalTransitionError);
  }
});

test("cancel・expire・invalidation後の遅延配送はrequestをsentへ戻さない", () => {
  for (const terminal of ["cancelled", "expired", "needs_review", "rejected"] as const) {
    assert.deepEqual(settleDelivery(terminal, "dispatching", "sent"), { request: terminal, delivery: "sent" });
    assert.deepEqual(settleDelivery(terminal, "acceptance_unknown", "sent"), { request: terminal, delivery: "sent" });
    assert.equal(abortPendingDelivery(terminal, "pending"), "aborted");
    assert.equal(claimDelivery(terminal, "pending"), "aborted");
    assert.equal(requestPayloadRequired(terminal), false);
    assert.throws(() => recordDecision(terminal, "sent", "approve"), ApprovalTransitionError);
  }
  assert.equal(invalidateRequest("approved"), "needs_review");
  assert.equal(invalidateRequest("delivery_unknown"), "needs_review");
  assert.equal(invalidateRequest("consumed"), "consumed");
});

test("配送・実行の受理不明は再送可能な状態へ戻らない", () => {
  assert.deepEqual(recoverDelivery("delivery_pending", "dispatching"), { request: "delivery_unknown", delivery: "acceptance_unknown" });
  assert.throws(() => claimDelivery("delivery_unknown", "acceptance_unknown"), ApprovalTransitionError);
  assert.throws(() => settleDelivery("delivery_unknown", "acceptance_unknown", "failed"), ApprovalTransitionError);
  assert.equal(recoverExecution("executing", true).state, "acceptance_unknown");
  for (const next of ["claimed", "executing"] as ExecutionState[]) {
    assert.throws(() => transitionExecution("acceptance_unknown", next), ApprovalTransitionError);
  }
  for (const current of ["claimed", "executing", "acceptance_unknown"] as const) {
    const result = recoverExecution(current, false);
    assert.equal(result.state, "needs_review"); assert.equal(result.delete_payload, true);
    assert.equal(result.record_unknown, current === "executing");
  }
});

test("配送復旧はrequestとattemptを同時にunknownへ進め、照合後もterminalを復活させない", () => {
  const recovered = recoverDelivery("delivery_pending", "dispatching");
  assert.deepEqual(recoverDelivery(recovered.request, recovered.delivery), recovered);
  assert.deepEqual(settleDelivery(recovered.request, recovered.delivery, "sent"), { request: "sent", delivery: "sent" });
  assert.throws(() => recordDecision(recovered.request, recovered.delivery, "approve"), ApprovalTransitionError);
  for (const terminal of ["cancelled", "expired", "needs_review"] as const) {
    const late = recoverDelivery(terminal, "dispatching");
    assert.deepEqual(late, { request: terminal, delivery: "acceptance_unknown" });
    assert.deepEqual(settleDelivery(late.request, late.delivery, "sent"), { request: terminal, delivery: "sent" });
    assert.deepEqual(recoverDelivery(terminal, "pending"), { request: terminal, delivery: "aborted" });
  }
  assert.throws(() => recoverDelivery("delivery_pending", "acceptance_unknown"), ApprovalTransitionError);
});

test("unknown stateと不整合なrequest/delivery pairはfail closed", () => {
  assert.throws(() => recordDecision("sent", "unknown" as never, "cancel"), ApprovalTransitionError);
  assert.throws(() => settleDelivery("sent", "dispatching", "sent"), ApprovalTransitionError);
  assert.throws(() => claimDelivery("sent", "pending"), ApprovalTransitionError);
  assert.throws(() => abortPendingDelivery("cancelled", "unknown" as never), ApprovalTransitionError);
  assert.throws(() => transitionExecution("toString" as never, "executing"), ApprovalTransitionError);
  assert.throws(() => recoverExecution("claimed", "false" as never), ApprovalTransitionError);
});
