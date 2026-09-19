/** Transport-neutral state transitions. These functions authorize no operation:
 * callers must verify persisted identity, revisions, time, snapshot and audit in
 * the same transaction before applying the returned states. */
export type RequestState = "requested" | "delivery_pending" | "delivery_unknown" | "sent" | "approved"
  | "rejected" | "cancelled" | "expired" | "delivery_failed" | "consumed" | "execution_cancelled"
  | "consume_expired" | "needs_review";
export type DeliveryState = "pending" | "dispatching" | "sent" | "failed" | "acceptance_unknown" | "needs_review" | "aborted";
export type ExecutionState = "claimed" | "executing" | "succeeded" | "failed" | "acceptance_unknown" | "needs_review";
export type DecisionKind = "approve" | "reject" | "cancel" | "expire";
export class ApprovalTransitionError extends Error {
  constructor() { super("approval_transition_rejected"); this.name = "ApprovalTransitionError"; }
}
const undecided = new Set<RequestState>(["requested", "delivery_pending", "delivery_unknown", "sent"]);
const requestStates = new Set<RequestState>(["requested", "delivery_pending", "delivery_unknown", "sent", "approved", "rejected",
  "cancelled", "expired", "delivery_failed", "consumed", "execution_cancelled", "consume_expired", "needs_review"]);
function checkDelivery(state: DeliveryState): void {
  if (!["pending", "dispatching", "sent", "failed", "acceptance_unknown", "needs_review", "aborted"].includes(state)) throw new ApprovalTransitionError();
}
function checkRequest(state: RequestState): void { if (!requestStates.has(state)) throw new ApprovalTransitionError(); }

export function recordDecision(request: RequestState, delivery: DeliveryState, kind: DecisionKind): RequestState {
  checkRequest(request); checkDelivery(delivery);
  if (!undecided.has(request)) throw new ApprovalTransitionError();
  if (kind === "approve" || kind === "reject") {
    if (request !== "sent" || delivery !== "sent") throw new ApprovalTransitionError();
    return kind === "approve" ? "approved" : "rejected";
  }
  if (kind === "cancel") return "cancelled";
  if (kind === "expire") return "expired";
  throw new ApprovalTransitionError();
}

export function invalidateRequest(request: RequestState): RequestState {
  checkRequest(request);
  return undecided.has(request) || request === "approved" ? "needs_review" : request;
}
export function terminateApproved(request: RequestState, cause: "cancel" | "expire" | "consume"): RequestState {
  if (request !== "approved") throw new ApprovalTransitionError();
  if (cause === "cancel") return "execution_cancelled";
  if (cause === "expire") return "consume_expired";
  if (cause === "consume") return "consumed";
  throw new ApprovalTransitionError();
}

/** A late successful delivery must never revive a terminal request. */
export function settleDelivery(request: RequestState, delivery: DeliveryState, result: "sent" | "failed" | "acceptance_unknown" | "needs_review"):
  { request: RequestState; delivery: DeliveryState } {
  checkRequest(request); checkDelivery(delivery);
  const allowed = delivery === "dispatching" ? ["sent", "failed", "acceptance_unknown"]
    : delivery === "acceptance_unknown" ? ["sent", "needs_review"] : [];
  if (!allowed.includes(result)) throw new ApprovalTransitionError();
  if (!undecided.has(request)) return { request, delivery: result };
  if ((delivery === "dispatching" && request !== "delivery_pending")
    || (delivery === "acceptance_unknown" && request !== "delivery_unknown")) throw new ApprovalTransitionError();
  const next: RequestState = result === "sent" ? "sent" : result === "failed" ? "delivery_failed"
    : result === "acceptance_unknown" ? "delivery_unknown" : "needs_review";
  return { request: next, delivery: result };
}

export function claimDelivery(request: RequestState, delivery: DeliveryState): DeliveryState {
  checkRequest(request); checkDelivery(delivery);
  if (delivery !== "pending") throw new ApprovalTransitionError();
  if (!undecided.has(request)) return "aborted";
  if (request !== "delivery_pending") throw new ApprovalTransitionError();
  return "dispatching";
}
export function abortPendingDelivery(request: RequestState, delivery: DeliveryState): DeliveryState {
  checkRequest(request); checkDelivery(delivery);
  if (!undecided.has(request) && delivery === "pending") return "aborted";
  return delivery;
}
/** Persist the pair in one transaction; recovering only the attempt leaves a
 * delivery_pending request unable to reconcile its now-unknown delivery. */
export function recoverDelivery(request: RequestState, delivery: DeliveryState): { request: RequestState; delivery: DeliveryState } {
  checkRequest(request); checkDelivery(delivery);
  if (delivery === "dispatching") return settleDelivery(request, delivery, "acceptance_unknown");
  if (undecided.has(request)) {
    const expected = delivery === "pending" ? "delivery_pending" : delivery === "sent" ? "sent"
      : delivery === "acceptance_unknown" ? "delivery_unknown" : null;
    if (request !== expected) throw new ApprovalTransitionError();
  }
  return { request, delivery: abortPendingDelivery(request, delivery) };
}
export function transitionExecution(current: ExecutionState, next: ExecutionState): ExecutionState {
  const transitions: Record<ExecutionState, readonly ExecutionState[]> = {
    claimed: ["executing", "needs_review"], executing: ["succeeded", "failed", "acceptance_unknown"],
    acceptance_unknown: ["succeeded", "failed", "needs_review"], succeeded: [], failed: [], needs_review: [],
  };
  if (!Object.hasOwn(transitions, current) || !transitions[current].includes(next)) throw new ApprovalTransitionError();
  return next;
}
export function recoverExecution(current: ExecutionState, elapsedProven: boolean): { state: ExecutionState; delete_payload: boolean; record_unknown: boolean } {
  if (typeof elapsedProven !== "boolean" || !["claimed", "executing", "succeeded", "failed", "acceptance_unknown", "needs_review"].includes(current)) throw new ApprovalTransitionError();
  if (current === "succeeded" || current === "failed" || current === "needs_review") return { state: current, delete_payload: true, record_unknown: false };
  if (!elapsedProven) return { state: "needs_review", delete_payload: true, record_unknown: current === "executing" };
  return { state: current === "executing" ? "acceptance_unknown" : current, delete_payload: false, record_unknown: current === "executing" };
}
export function requestPayloadRequired(state: RequestState): boolean {
  checkRequest(state);
  return undecided.has(state) || state === "approved";
}
