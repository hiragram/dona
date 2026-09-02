import type { UpdateState } from "./types.js";

const transitions: Readonly<Record<UpdateState, readonly UpdateState[]>> = {
  requested: ["planning", "cancelled", "failed"],
  planning: ["awaiting_approval", "failed", "needs_review", "cancelled"],
  awaiting_approval: ["approved", "cancelled", "failed"],
  approved: ["preparing", "cancelled", "failed", "needs_review"],
  preparing: ["staged", "failed", "needs_review", "cancelled"],
  staged: ["quiescing", "cancelled", "failed", "needs_review"],
  quiescing: ["activating", "failed", "needs_review"],
  activating: ["restarting", "rolling_back", "needs_review"],
  restarting: ["verifying", "rolling_back", "needs_review"],
  verifying: ["succeeded", "rolling_back", "needs_review"],
  succeeded: [],
  failed: [],
  rolling_back: ["rolled_back", "needs_review"],
  rolled_back: [],
  needs_review: ["rolling_back"],
  cancelled: [],
};

export function canTransition(from: UpdateState, to: UpdateState): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: UpdateState, to: UpdateState): void {
  if (!canTransition(from, to)) throw new Error(`Invalid update transition: ${from} -> ${to}`);
}

export function isTerminal(state: UpdateState): boolean {
  return ["succeeded", "failed", "rolled_back", "needs_review", "cancelled"].includes(state);
}
