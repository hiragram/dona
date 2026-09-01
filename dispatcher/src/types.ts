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

export interface EventEnvelope {
  schema_version: 1;
  source: "slack";
  external_event_id: string;
  type: string;
  occurred_at: string;
  subject: Record<string, unknown>;
  payload: Record<string, unknown>;
  reply_target: Record<string, unknown> | null;
  trace?: Record<string, unknown>;
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
