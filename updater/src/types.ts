export const updateStates = [
  "requested",
  "planning",
  "awaiting_approval",
  "approved",
  "preparing",
  "staged",
  "quiescing",
  "activating",
  "restarting",
  "verifying",
  "succeeded",
  "failed",
  "rolling_back",
  "rolled_back",
  "needs_review",
  "cancelled",
] as const;

export type UpdateState = (typeof updateStates)[number];

export const terminalUpdateStates = [
  "succeeded",
  "failed",
  "rolled_back",
  "needs_review",
  "cancelled",
] as const satisfies readonly UpdateState[];

export interface Compatibility {
  protocol: number;
  config: number;
  app_schema_read_min: number;
  app_schema_read_max: number;
  app_schema_write: number;
  rollback_safe: boolean;
}

export interface ReplyTarget {
  kind: "slack_thread";
  workspace_id: string;
  channel_id: string;
  thread_ts: string;
}

export interface PlanRequest {
  source_event_id: string;
  reply_target: ReplyTarget;
}

export interface ApplyRequest {
  source_event_id: string;
  reply_target: ReplyTarget;
  plan_id: string;
  plan_hash: string;
  approval_id: string;
}

export interface CancelRequest {
  source_event_id: string;
  reply_target: ReplyTarget;
  request_id: string;
  reason?: string;
}

export interface ReleaseManifest {
  schema_version: 1;
  sha: string;
  repository: string;
  policy_version: string;
  lock_hashes: Record<string, string>;
  node_version: string;
  npm_version: string;
  built_at: string;
  compatibility: Compatibility;
}

export interface UpdatePlan {
  schema_version: 1;
  plan_id: string;
  plan_hash: string;
  policy_version: string;
  current_sha: string;
  target_sha: string;
  previous_sha: string | null;
  compatibility: Compatibility;
  rollback_compatible: boolean;
  created_at: string;
}

export interface UpdateRow {
  request_id: string;
  source_event_id: string;
  reply_target_json: string;
  state: UpdateState;
  current_sha: string;
  target_sha: string;
  previous_sha: string | null;
  plan_id: string;
  plan_hash: string;
  policy_version: string;
  compatibility_json: string;
  rollback_compatible: number;
  approval_id: string | null;
  approval_event_id: string | null;
  attempt: number;
  activation_generation: number;
  restart_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  fence: number;
  cancellation_requested: number;
  cancellation_event_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface OutboxRow {
  outbox_id: string;
  request_id: string;
  external_event_id: string;
  payload_json: string;
  status: "pending" | "delivering" | "delivered" | "needs_review";
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface HealthSnapshot {
  service: "dispatcher" | "slack_adapter";
  live: boolean;
  ready: boolean;
  build_sha: string | null;
  protocol: number | null;
  app_schema: number | null;
  config: number | null;
  workspaces_ready?: boolean;
}

export interface DrainSnapshot {
  service: "dispatcher" | "slack_adapter";
  quiescing: boolean;
  drained: boolean;
  in_flight: number;
  unsafe_states: string[];
}

export interface CommandResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  output_truncated: boolean;
}

export interface ActivationReceipt {
  schema_version: 1;
  request_id: string;
  fence: number;
  generation: number;
  from_sha: string;
  to_sha: string;
  pointer_switched_at: string;
}
