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

export interface SchemaRollout {
  schema_version: 1;
  phase: string;
  database_schema: number;
  multi_job_enabled: boolean;
  capabilities: string[];
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
  reconcile_after: string | null;
  reconcile_deadline: string | null;
  last_reconciled_at: string | null;
  observed_active_sha: string | null;
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
  dispatcher_event_id: string | null;
  dispatcher_accepted_at: string | null;
  slack_reported_at: string | null;
  next_attempt_at: string | null;
  superseded_by_outbox_id: string | null;
}

export const runtimeOperationKinds = [
  "stop_main_agent",
  "stop_slack",
  "stop_dispatcher",
  "start_target_main_agent",
  "start_target_dispatcher",
  "start_target_slack",
  "restart_current_dispatcher",
  "restart_current_slack",
  "stop_target_slack",
  "stop_target_dispatcher",
  "stop_target_main_agent",
  "start_previous_main_agent",
  "start_previous_dispatcher",
  "start_previous_slack",
  "legacy_confirmation",
] as const;

export type RuntimeOperationKind = (typeof runtimeOperationKinds)[number];
export type RuntimeOperationPhase = "prepared" | "accepted" | "observed" | "rejected" | "acceptance_unknown";

export interface RuntimeOperationRow {
  operation_id: string;
  request_id: string;
  fence: number;
  kind: RuntimeOperationKind;
  phase: RuntimeOperationPhase;
  target_ref: string;
  expected_sha: string | null;
  previous_session_id: string | null;
  observed_session_id: string | null;
  evidence_json: string;
  created_at: string;
  updated_at: string;
}

export type CompletionDeliveryResult =
  | { outcome: "accepted"; event_id: string }
  | { outcome: "definitive_rejection"; error_code: string }
  | { outcome: "acceptance_unknown"; error_code: string }
  | { outcome: "unavailable"; error_code: string };

export type CompletionLookupResult =
  | { outcome: "exists"; event_id: string; status: string }
  | { outcome: "absent" }
  | { outcome: "conflict"; error_code: string }
  | { outcome: "unavailable"; error_code: string };

export interface HealthSnapshot {
  service: "dispatcher" | "slack_adapter";
  live: boolean;
  ready: boolean;
  build_sha: string | null;
  protocol: number | null;
  app_schema: number | null;
  app_schema_read_min?: number;
  app_schema_read_max?: number;
  app_schema_write?: number;
  config: number | null;
  update_notification_protocol?: number;
  workspaces_ready?: boolean;
}

export interface DrainSnapshot {
  service: "dispatcher" | "slack_adapter";
  quiescing: boolean;
  drained: boolean;
  in_flight: number;
  unsafe_states: string[];
}

export type MainAgentStatus = "idle" | "done" | "working" | "blocked" | "unknown";

export interface MainAgentObservation {
  exists: boolean;
  name: string | null;
  kind: string | null;
  pane_id: string | null;
  status: MainAgentStatus | null;
  interactive_ready: boolean;
  working_directory: string | null;
  session_id: string | null;
  matches_release: boolean;
  error_code: string | null;
}

export interface MainAgentStopResult {
  outcome: "stopped" | "rejected" | "accepted_unknown";
  pane_id: string | null;
  error_code: string | null;
}

export interface MainAgentStartResult {
  outcome: "started" | "rejected" | "accepted_unknown";
  observation: MainAgentObservation;
  error_code: string | null;
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
