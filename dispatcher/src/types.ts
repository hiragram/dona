export const eventStatuses = [
  "queued",
  "dispatching",
  "waiting_agent",
  "completed",
  "retryable_failed",
  "blocked",
  "needs_review",
  "dead_letter",
] as const;

export type EventStatus = (typeof eventStatuses)[number];

export const jobStatuses = [
  "queued",
  "preparing",
  "dispatching",
  "running",
  "retryable_failed",
  "blocked",
  "completed",
  "failed",
  "cancelling",
  "cancelled",
  "needs_review",
] as const;

export type JobStatus = (typeof jobStatuses)[number];

export interface EventEnvelope {
  schema_version: 1;
  source: "slack" | "dona_job" | "dona_update";
  external_event_id: string;
  type: string;
  occurred_at: string;
  subject: Record<string, unknown>;
  payload: Record<string, unknown>;
  reply_target: Record<string, unknown> | null;
  trace?: Record<string, unknown>;
}

export type JobWorkspace =
  | { kind: "scratch" }
  | { kind: "github"; repository: string; base_ref?: string };

export interface CreateJobRequest {
  source_event_id: string;
  objective: string;
  workspace: JobWorkspace;
}

export interface SteerJobRequest {
  source_event_id: string;
  instruction: string;
}

export interface CancelJobRequest {
  source_event_id: string;
  reason?: string;
}

export interface JobResultEnvelope {
  schema_version: 1;
  job_id: string;
  status: "completed" | "failed";
  summary: string;
  output?: {
    format: "markdown" | "text";
    text: string;
  };
  artifacts?: Array<Record<string, unknown>>;
  actions?: unknown[];
  completed_at: string;
  [key: string]: unknown;
}

export interface ResultEnvelope {
  schema_version: 1;
  event_id: string;
  status: "completed" | "failed";
  summary?: string;
  actions?: unknown[];
  memory_candidates?: unknown[];
  completed_at: string;
  [key: string]: unknown;
}

export interface EventRow {
  sequence: number;
  event_id: string;
  schema_version: number;
  source: string;
  external_event_id: string;
  event_type: string;
  occurred_at: string;
  subject_json: string;
  payload_json: string;
  reply_target_json: string | null;
  trace_json: string | null;
  status: EventStatus;
  attempt_count: number;
  available_at: string;
  dispatch_started_at: string | null;
  prompt_accepted_at: string | null;
  completed_at: string | null;
  result_json: string | null;
  result_path: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueResult {
  row: EventRow;
  duplicate: boolean;
  payloadMismatch: boolean;
}

export interface JobRow {
  job_id: string;
  source_event_id: string;
  source: string;
  workspace_id: string | null;
  channel_id: string | null;
  thread_ts: string | null;
  actor_id: string | null;
  objective: string;
  workspace_json: string;
  status: JobStatus;
  attempt_count: number;
  available_at: string;
  workspace_path: string;
  result_path: string;
  herdr_workspace_id: string | null;
  herdr_pane_id: string | null;
  agent_name: string;
  dispatch_started_at: string | null;
  prompt_accepted_at: string | null;
  completed_at: string | null;
  result_json: string | null;
  completion_event_id: string | null;
  steer_event_id: string | null;
  steer_state: "dispatching" | "accepted" | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateJobResult {
  row: JobRow;
  duplicate: boolean;
  payloadMismatch: boolean;
}
