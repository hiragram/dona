import { createHash, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { AgentStatus, HerdrCommandResult } from "./herdr.js";
import type { JobRow, JobStatus } from "./types.js";

export const liveSessionSchemaVersion = 1;
export const liveSessionReceiptRetentionSeconds = 30 * 24 * 60 * 60;

export type LiveSessionQueryStatus =
  | "observed"
  | "not_addressable"
  | "agent_not_found"
  | "query_timeout"
  | "transport_unavailable"
  | "malformed_response"
  | "dispatcher_restarted";

export type LiveSessionReconciliationState =
  | "prompt_acceptance_possible_running"
  | "consistent_running"
  | "terminal_result_available"
  | "terminal_result_missing"
  | "durable_live_conflict"
  | "identity_conflict"
  | "session_absent"
  | "not_addressable"
  | "unknown";

export interface LiveSessionIdentityRow {
  job_id: string;
  identity_version: 1;
  herdr_agent_session_id: string;
  herdr_workspace_id: string | null;
  herdr_pane_id: string | null;
  agent_name: string | null;
  max_state_change_seq: number | null;
  recorded_at: string;
  generation_nonce: string | null;
}

export interface LiveSessionReceiptProjection {
  schema_version: 1;
  receipt_id: string;
  job_id: string;
  observed_at: string;
  boot_id: string;
  identity_generation_sha256?: string | null;
  durable_status_before: JobStatus;
  durable_status_after: JobStatus;
  result_present_before: boolean;
  result_present_after: boolean;
  live_session: {
    query_status: LiveSessionQueryStatus;
    session_state: AgentStatus | null;
    identity_match: boolean | null;
    state_change_seq: number | null;
    freshness_ms: number;
  };
  reconciliation: {
    state: LiveSessionReconciliationState;
    confidence: "bounded_observation" | "fail_closed";
    reason_codes: string[];
    safe_next_action: "review_existing_session" | "review_durable_result" | "do_not_retry";
  };
}

interface LiveSessionReceiptRow {
  receipt_id: string;
  job_id: string;
  source_event_id: string | null;
  boot_id: string;
  started_at: string;
  completed_at: string;
  durable_status_before: JobStatus;
  durable_status_after: JobStatus;
  result_present_before: number;
  result_present_after: number;
  query_status: LiveSessionQueryStatus;
  session_state: AgentStatus | null;
  identity_match: number | null;
  state_change_seq: number | null;
  reconciliation_state: LiveSessionReconciliationState;
  confidence: "bounded_observation" | "fail_closed";
  reason_codes_json: string;
  safe_next_action: "review_existing_session" | "review_durable_result" | "do_not_retry";
  duration_ms: number;
  identity_generation_sha256: string | null;
}

export interface LiveSessionObservationInput {
  before: JobRow;
  after: JobRow;
  sourceEventId?: string;
  bootId: string;
  startedAt: string;
  completedAt: string;
  expectedIdentity?: string;
  identityGenerationChanged?: boolean;
  previousStateChangeSeq?: number;
  result?: HerdrCommandResult;
}

export function migrateLiveSession(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_session_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version = ${liveSessionSchemaVersion})
    );
    INSERT OR IGNORE INTO live_session_schema(singleton, version) VALUES(1, ${liveSessionSchemaVersion});
  `);
  const marker = db.prepare("SELECT version FROM live_session_schema WHERE singleton=1").pluck().get();
  if (marker !== liveSessionSchemaVersion) throw new Error("Unsupported live session schema version");
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_live_session_identities (
      job_id TEXT PRIMARY KEY,
      identity_version INTEGER NOT NULL CHECK (identity_version = 1),
      herdr_agent_session_id TEXT NOT NULL CHECK (length(herdr_agent_session_id) BETWEEN 1 AND 512),
      herdr_workspace_id TEXT,
      herdr_pane_id TEXT,
      agent_name TEXT,
      max_state_change_seq INTEGER CHECK (max_state_change_seq >= 0 OR max_state_change_seq IS NULL),
      recorded_at TEXT NOT NULL,
      generation_nonce TEXT
    );
    CREATE TABLE IF NOT EXISTS live_session_query_receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id TEXT NOT NULL UNIQUE,
      job_id TEXT NOT NULL,
      source_event_id TEXT,
      boot_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      durable_status_before TEXT NOT NULL,
      durable_status_after TEXT NOT NULL,
      result_present_before INTEGER NOT NULL CHECK (result_present_before IN (0,1)),
      result_present_after INTEGER NOT NULL CHECK (result_present_after IN (0,1)),
      query_status TEXT NOT NULL,
      session_state TEXT,
      identity_match INTEGER CHECK (identity_match IN (0,1) OR identity_match IS NULL),
      state_change_seq INTEGER CHECK (state_change_seq >= 0 OR state_change_seq IS NULL),
      reconciliation_state TEXT NOT NULL,
      confidence TEXT NOT NULL CHECK (confidence IN ('bounded_observation','fail_closed')),
      reason_codes_json TEXT NOT NULL,
      safe_next_action TEXT NOT NULL,
      duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
      identity_generation_sha256 TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS live_session_receipts_job_idx
      ON live_session_query_receipts(job_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS live_session_receipts_retention_idx
      ON live_session_query_receipts(created_at);
    CREATE TRIGGER IF NOT EXISTS live_session_receipts_no_update
      BEFORE UPDATE ON live_session_query_receipts BEGIN SELECT RAISE(ABORT, 'live_session_receipt_append_only'); END;
  `);
  const identityColumns = new Set((db.prepare("PRAGMA table_info(job_live_session_identities)").all() as Array<{name:string}>).map(row=>row.name));
  for (const column of ["herdr_workspace_id", "herdr_pane_id", "agent_name"] as const) {
    if (!identityColumns.has(column)) db.exec(`ALTER TABLE job_live_session_identities ADD COLUMN ${column} TEXT`);
  }
  if (!identityColumns.has("max_state_change_seq")) db.exec("ALTER TABLE job_live_session_identities ADD COLUMN max_state_change_seq INTEGER CHECK (max_state_change_seq >= 0 OR max_state_change_seq IS NULL)");
  if (!identityColumns.has("generation_nonce")) db.exec("ALTER TABLE job_live_session_identities ADD COLUMN generation_nonce TEXT");
  const receiptColumns = new Set((db.prepare("PRAGMA table_info(live_session_query_receipts)").all() as Array<{name:string}>).map(row=>row.name));
  if (!receiptColumns.has("identity_generation_sha256")) db.exec("ALTER TABLE live_session_query_receipts ADD COLUMN identity_generation_sha256 TEXT");
}

export function liveSessionIdentityGenerationSha256(
  job: Pick<JobRow,"herdr_workspace_id"|"herdr_pane_id"|"agent_name">,
  identity: LiveSessionIdentityRow | undefined,
): string | undefined {
  if (!identity?.generation_nonce || !expectedLiveSessionIdentity(job, identity)) return undefined;
  return createHash("sha256").update(JSON.stringify([
    identity.identity_version, identity.generation_nonce, identity.herdr_agent_session_id,
    identity.herdr_workspace_id, identity.herdr_pane_id, identity.agent_name, identity.recorded_at,
    job.herdr_workspace_id, job.herdr_pane_id, job.agent_name,
  ])).digest("hex");
}

export function expectedLiveSessionIdentity(job: Pick<JobRow,"herdr_workspace_id"|"herdr_pane_id"|"agent_name">, identity: LiveSessionIdentityRow | undefined): string | undefined {
  if (!job.herdr_workspace_id || !job.herdr_pane_id || !identity?.herdr_agent_session_id) return undefined;
  if (identity.herdr_workspace_id !== job.herdr_workspace_id || identity.herdr_pane_id !== job.herdr_pane_id || identity.agent_name !== job.agent_name) return undefined;
  return JSON.stringify([job.herdr_workspace_id, job.herdr_pane_id, job.agent_name, identity.herdr_agent_session_id]);
}

function classifyQuery(result: HerdrCommandResult | undefined, expectedIdentity: string | undefined): {
  queryStatus: LiveSessionQueryStatus;
  sessionState: AgentStatus | null;
  identityMatch: boolean | null;
  sequence: number | null;
} {
  if (!expectedIdentity) return { queryStatus: "not_addressable", sessionState: null, identityMatch: null, sequence: null };
  if (!result) return { queryStatus: "dispatcher_restarted", sessionState: null, identityMatch: null, sequence: null };
  if (result.aborted) return { queryStatus: "dispatcher_restarted", sessionState: null, identityMatch: null, sequence: null };
  if (result.timedOut) return { queryStatus: "query_timeout", sessionState: null, identityMatch: null, sequence: null };
  if (!result.ok && ["agent_not_found", "agent_not_running", "not_found"].includes(result.errorCode ?? "")) {
    return { queryStatus: "agent_not_found", sessionState: null, identityMatch: null, sequence: null };
  }
  if (!result.ok) return { queryStatus: "transport_unavailable", sessionState: null, identityMatch: null, sequence: null };
  if (!result.agentIdentity || !result.agentStatus || result.stateChangeSeq === undefined) {
    return { queryStatus: "malformed_response", sessionState: null, identityMatch: null, sequence: null };
  }
  return {
    queryStatus: "observed",
    sessionState: result.agentStatus,
    identityMatch: result.agentIdentity === expectedIdentity,
    sequence: result.stateChangeSeq,
  };
}

function reconcile(input: LiveSessionObservationInput, query: ReturnType<typeof classifyQuery>): {
  state: LiveSessionReconciliationState;
  confidence: "bounded_observation" | "fail_closed";
  reasonCodes: string[];
  safeNextAction: "review_existing_session" | "review_durable_result" | "do_not_retry";
} {
  const reasons = [`durable_${input.after.status}`, `live_${query.queryStatus}`];
  if (input.before.status !== input.after.status || Boolean(input.before.result_json) !== Boolean(input.after.result_json)) {
    reasons.push("durable_changed_during_query");
  }
  if (input.identityGenerationChanged) {
    reasons.push("identity_generation_changed_during_query");
    return { state: "unknown", confidence: "fail_closed", reasonCodes: reasons, safeNextAction: "do_not_retry" };
  }
  if (query.queryStatus === "not_addressable") {
    return { state: "not_addressable", confidence: "fail_closed", reasonCodes: reasons, safeNextAction: "do_not_retry" };
  }
  if (query.queryStatus === "agent_not_found") {
    return { state: "session_absent", confidence: "fail_closed", reasonCodes: reasons, safeNextAction: "do_not_retry" };
  }
  if (query.queryStatus !== "observed") {
    return { state: "unknown", confidence: "fail_closed", reasonCodes: reasons, safeNextAction: "do_not_retry" };
  }
  if (!query.identityMatch) {
    reasons.push("identity_mismatch");
    return { state: "identity_conflict", confidence: "fail_closed", reasonCodes: reasons, safeNextAction: "do_not_retry" };
  }
  if (input.previousStateChangeSeq !== undefined && query.sequence !== null && query.sequence < input.previousStateChangeSeq) {
    reasons.push("same_identity", "state_sequence_regressed");
    return { state: "unknown", confidence: "fail_closed", reasonCodes: reasons, safeNextAction: "do_not_retry" };
  }
  reasons.push("same_identity", `live_${query.sessionState ?? "unknown"}`);
  const terminalDurable = ["completed", "failed", "cancelled"].includes(input.after.status);
  const liveRunning = query.sessionState === "working" || query.sessionState === "blocked";
  const liveTerminal = query.sessionState === "idle" || query.sessionState === "done";
  if (terminalDurable && liveRunning) {
    return { state: "durable_live_conflict", confidence: "fail_closed", reasonCodes: reasons, safeNextAction: "review_existing_session" };
  }
  if (liveTerminal && input.after.result_json) {
    reasons.push("result_present");
    return { state: "terminal_result_available", confidence: "bounded_observation", reasonCodes: reasons, safeNextAction: "review_durable_result" };
  }
  if (liveTerminal) {
    reasons.push("result_absent");
    return { state: "terminal_result_missing", confidence: "fail_closed", reasonCodes: reasons, safeNextAction: "do_not_retry" };
  }
  if (liveRunning && input.after.prompt_accepted_at) {
    reasons.push("prompt_acceptance_recorded");
    return { state: "consistent_running", confidence: "bounded_observation", reasonCodes: reasons, safeNextAction: "review_existing_session" };
  }
  if (liveRunning && ["dispatching", "needs_review"].includes(input.after.status) && !input.after.result_json) {
    reasons.push("prompt_acceptance_unproven", "result_absent");
    return { state: "prompt_acceptance_possible_running", confidence: "bounded_observation", reasonCodes: reasons, safeNextAction: "review_existing_session" };
  }
  return { state: "unknown", confidence: "fail_closed", reasonCodes: reasons, safeNextAction: "do_not_retry" };
}

export function buildLiveSessionReceipt(input: LiveSessionObservationInput): LiveSessionReceiptProjection {
  const classified = classifyQuery(input.result, input.expectedIdentity);
  const query = input.identityGenerationChanged ? {...classified,identityMatch:null} : classified;
  const decision = reconcile(input, query);
  const duration = Math.max(0, Date.parse(input.completedAt) - Date.parse(input.startedAt));
  return {
    schema_version: 1,
    receipt_id: `lsr_${randomUUID().replaceAll("-", "")}`,
    job_id: input.after.job_id,
    observed_at: input.completedAt,
    boot_id: input.bootId,
    durable_status_before: input.before.status,
    durable_status_after: input.after.status,
    result_present_before: input.before.result_json !== null,
    result_present_after: input.after.result_json !== null,
    live_session: {
      query_status: query.queryStatus,
      session_state: query.sessionState,
      identity_match: query.identityMatch,
      state_change_seq: query.sequence,
      freshness_ms: duration,
    },
    reconciliation: {
      state: decision.state,
      confidence: decision.confidence,
      reason_codes: decision.reasonCodes,
      safe_next_action: decision.safeNextAction,
    },
  };
}

export function insertLiveSessionReceipt(db: Database.Database, sourceEventId: string | undefined, receipt: LiveSessionReceiptProjection, startedAt: string): void {
  db.prepare(`INSERT INTO live_session_query_receipts(
    receipt_id,job_id,source_event_id,boot_id,started_at,completed_at,durable_status_before,durable_status_after,
    result_present_before,result_present_after,query_status,session_state,identity_match,state_change_seq,
    reconciliation_state,confidence,reason_codes_json,safe_next_action,duration_ms,identity_generation_sha256,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    receipt.receipt_id, receipt.job_id, sourceEventId ?? null, receipt.boot_id, startedAt, receipt.observed_at,
    receipt.durable_status_before, receipt.durable_status_after, Number(receipt.result_present_before), Number(receipt.result_present_after),
    receipt.live_session.query_status, receipt.live_session.session_state, receipt.live_session.identity_match === null ? null : Number(receipt.live_session.identity_match),
    receipt.live_session.state_change_seq, receipt.reconciliation.state, receipt.reconciliation.confidence,
    JSON.stringify(receipt.reconciliation.reason_codes), receipt.reconciliation.safe_next_action, receipt.live_session.freshness_ms,
    receipt.identity_generation_sha256 ?? null, receipt.observed_at,
  );
}

export function projectLiveSessionReceipt(row: LiveSessionReceiptRow): LiveSessionReceiptProjection {
  return {
    schema_version: 1,
    receipt_id: row.receipt_id,
    job_id: row.job_id,
    observed_at: row.completed_at,
    boot_id: row.boot_id,
    identity_generation_sha256: row.identity_generation_sha256,
    durable_status_before: row.durable_status_before,
    durable_status_after: row.durable_status_after,
    result_present_before: row.result_present_before === 1,
    result_present_after: row.result_present_after === 1,
    live_session: {
      query_status: row.query_status,
      session_state: row.session_state,
      identity_match: row.identity_match === null ? null : row.identity_match === 1,
      state_change_seq: row.state_change_seq,
      freshness_ms: row.duration_ms,
    },
    reconciliation: {
      state: row.reconciliation_state,
      confidence: row.confidence,
      reason_codes: JSON.parse(row.reason_codes_json) as string[],
      safe_next_action: row.safe_next_action,
    },
  };
}

export type { LiveSessionReceiptRow };
