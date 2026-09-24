import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { ulid } from "ulid";

import { expandHome, jobResourceDefaults, jobResourceHardLimits } from "./config.js";

import type {
  CreateJobRequest,
  CreateJobResult,
  EventJobProjection,
  EventJobReconciliation,
  EnqueueResult,
  EventEnvelope,
  EventRow,
  EventStatus,
  JobGroupRow,
  JobGroupSnapshot,
  JobGroupTransition,
  JobGroupNotificationMode,
  JobResultEnvelope,
  JobRow,
  JobStatus,
  ResultEnvelope,
} from "./types.js";
import { eventStatuses, jobStatuses } from "./types.js";
import { jobAgentName } from "./job-agent-name.js";
import { createJobDisplayLabel } from "./job-display-label.js";
import { insertEventJobBinding, legacySlackBinding, migrateJobRouting, readEventJobBinding } from "./job-routing.js";
import { migrateScheduler, type SchedulerMigrationStep } from "./scheduler/schema.js";
import {
  insertLiveSessionReceipt,
  migrateLiveSession,
  projectLiveSessionReceipt,
  type LiveSessionIdentityRow,
  type LiveSessionReceiptProjection,
  type LiveSessionReceiptRow,
} from "./live-session.js";
import { projectWorkResultContent, SchedulerRepository, validateWorkResultContent, validateWorkResultEnvelope } from "./scheduler/repository.js";
import { canonicalJobPayloadSha256, jobCreationObjectiveBytesFromWorkspace, jobCreationPayloadSha256FromWorkspace,
  jobObjectiveCharacterMax, legacyJobKey, parseCreateJobRequest, parseJobWorkspace, serializeJobWorkspace, stableStringify } from "./validation.js";

const statusSql = eventStatuses.map((status) => `'${status}'`).join(", ");
const jobStatusSql = jobStatuses.map((status) => `'${status}'`).join(", ");
const retryDelaysMs = [5_000, 30_000, 120_000, 600_000] as const;
function configuredSchemaWrite(): 2 | 3 {
  const manifestPath = process.env.DONA_RELEASE_MANIFEST_PATH;
  if (!manifestPath) return 3;
  const manifest = JSON.parse(fs.readFileSync(expandHome(manifestPath), "utf8")) as { compatibility?: { app_schema_write?: unknown } };
  const write = manifest.compatibility?.app_schema_write;
  if (write !== 2 && write !== 3) throw new Error("Release manifest app_schema_write is invalid");
  return write;
}

export const dispatcherSchemaCompatibility = {
  read_min: 2,
  read_max: 3,
  get write(): 2 | 3 { return configuredSchemaWrite(); },
} as const;


const jobGroupSnapshotJobLimit = 32;
const jobAttentionStatuses = new Set<JobStatus>(["blocked", "failed", "needs_review"]);
const jobNotificationStatuses = new Set<JobStatus>(["blocked", "completed", "failed", "cancelled", "needs_review"]);
export type JobNotificationStep = "event_enqueued" | "transition_claimed" | "job_linked";
export type JobNotificationHook = (step: JobNotificationStep) => void;
export type DispatcherMigrationStep = "jobs_copied" | "indexes_recreated" | "groups_backfilled" | SchedulerMigrationStep;
export type DispatcherMigrationHook = (step: DispatcherMigrationStep) => void;
export interface JobQueueStats { queuedJobs:number; queuedSourceEvents:number; queuedMaxPerEvent:number; }
const jobsRunnableFairIndexSql = `
  CREATE INDEX jobs_runnable_fair_idx
    ON jobs(source_event_id, created_at, job_id, available_at)
    WHERE status = 'queued'
`;

export interface JobAdmissionLimits { jobsPerEventMax: number; jobObjectiveTotalMaxBytes: number; }
export class JobCreationError extends Error {
  constructor(readonly code: "job_idempotency_conflict" | "job_group_closed" | "job_group_limit_exceeded", message: string,
    readonly limitDetails?: { resource: "jobs_per_event" | "objective_utf8_bytes_per_event"; current: number; attempted: number; maximum: number }) {
    super(message); this.name = "JobCreationError";
  }
}
export class ScheduledJobCreationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message); this.name = "ScheduledJobCreationError";
  }
}
export interface JobNotificationVerificationRequest { schema_version:1;event_id:string;workspace_id:string;channel_id:string;thread_ts:string|null;message_ts:string;body_sha256:string;desired_session_status:"active"|"suspended"|null; }
export interface JobNotificationEvidence { event_id:string;workspace_id:string;channel_id:string;thread_ts:string|null;message_ts:string;body_sha256:string;posted_at:string;reply_broadcast:false;identity_block_verified:boolean;session_status:"active"|"suspended"|null; }
function notificationText(payload:{result?:{summary?:unknown};error_message?:unknown;job_status?:unknown}):string {
  return typeof payload.result?.summary==="string"?payload.result.summary:typeof payload.error_message==="string"?payload.error_message:
    payload.job_status==="cancelled"?"ジョブは中止されました":payload.job_status==="blocked"?"ジョブは入力待ちです":"ジョブの確認が必要です";
}

function nowUtc(): string {
  return new Date().toISOString();
}

function retryAt(attemptCount: number, now: Date): string {
  const delay = retryDelaysMs[Math.min(Math.max(attemptCount - 1, 0), retryDelaysMs.length - 1)]!;
  return new Date(now.getTime() + delay).toISOString();
}

function renderJobResult(result: Record<string, unknown> | null): string {
  if (!result) return "完了";
  const summary = typeof result.summary === "string" ? result.summary : "完了";
  const output = result.output && typeof result.output === "object" && !Array.isArray(result.output)
    ? result.output as Record<string, unknown> : undefined;
  return typeof output?.text === "string" && output.text.trim() ? `${summary}\n\n${output.text}` : summary;
}

function containsHostAbsolutePath(value:string):boolean {
  if(/\bfile:(?:\/\/)?[^\s<>]*/i.test(value)) return true;
  const withoutUrls=value.replace(/\bfile:\/\//gi,"").replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/gi,"");
  return /(?:^|[^A-Za-z0-9._~-])\/(?:Users|home|root|etc|var|private|tmp|opt|usr|Library|System|Applications|Volumes|dev|bin|sbin)(?:\/|\b)/.test(withoutUrls);
}

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().replace(/;$/, "");
}

function ensureJobsRunnableFairIndex(db: Database.Database): void {
  const existing = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'jobs_runnable_fair_idx'
  `).get() as { sql: string | null } | undefined;
  if (existing?.sql && normalizedSql(existing.sql) === normalizedSql(jobsRunnableFairIndexSql)) return;
  db.transaction(() => {
    db.exec("DROP INDEX IF EXISTS jobs_runnable_fair_idx");
    db.exec(jobsRunnableFairIndexSql);
  })();
}

function ensureV2BridgeSchema(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === "job_key")) {
    db.exec("ALTER TABLE jobs ADD COLUMN job_key TEXT NOT NULL DEFAULT 'legacy-default'");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_groups (
      source_event_id       TEXT PRIMARY KEY REFERENCES events(event_id),
      sealed_at             TEXT,
      notification_mode     TEXT NOT NULL CHECK (notification_mode IN ('grouped', 'legacy')),
      attention_event_id    TEXT REFERENCES events(event_id),
      all_terminal_event_id TEXT REFERENCES events(event_id),
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS job_groups_transition_idx
      ON job_groups(notification_mode, sealed_at, updated_at);
    CREATE INDEX IF NOT EXISTS jobs_event_idx ON jobs(source_event_id, created_at);
    INSERT OR IGNORE INTO job_groups (
      source_event_id, sealed_at, notification_mode, attention_event_id,
      all_terminal_event_id, created_at, updated_at
    )
    SELECT jobs.source_event_id, NULL, 'legacy', NULL, NULL, MIN(jobs.created_at), MAX(jobs.updated_at)
    FROM jobs GROUP BY jobs.source_event_id;
  `);
  ensureJobsRunnableFairIndex(db);
  ensureJobsWorkspaceJobIndex(db);
  ensureJobsStatusJobIndex(db);
  ensureJobAttentionResolutionSchema(db);
  reconcileLegacyAttentionClaims(db);
}
function ensureJobsWorkspaceJobIndex(db:Database.Database):void {db.exec(`
  CREATE INDEX IF NOT EXISTS jobs_workspace_job_idx ON jobs(workspace_id,job_id);
  CREATE INDEX IF NOT EXISTS jobs_nonterminal_workspace_job_idx ON jobs(workspace_id,job_id)
    WHERE status NOT IN ('blocked','completed','failed','cancelled','needs_review');
`);}
function ensureJobsStatusJobIndex(db:Database.Database):void {db.exec(`
  CREATE INDEX IF NOT EXISTS jobs_status_job_idx ON jobs(status,job_id);
  CREATE INDEX IF NOT EXISTS jobs_nonterminal_job_idx ON jobs(job_id)
    WHERE status NOT IN ('blocked','completed','failed','cancelled','needs_review');
`);}
function ensureJobAttentionResolutionSchema(db: Database.Database): void { db.exec(`
  CREATE TABLE IF NOT EXISTS job_attention_resolutions (
    job_id TEXT PRIMARY KEY,
    source_event_id TEXT NOT NULL REFERENCES events(event_id),
    attention_event_id TEXT NOT NULL REFERENCES events(event_id),
    status_at_resolution TEXT NOT NULL CHECK (status_at_resolution IN ('failed', 'completed', 'cancelled')),
    resolution_kind TEXT NOT NULL CHECK (resolution_kind IN ('validated_result', 'operator_reconcile')),
    resolution_event_id TEXT REFERENCES events(event_id),
    resolved_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS job_attention_resolutions_event_idx
    ON job_attention_resolutions(source_event_id, attention_event_id);
  CREATE TABLE IF NOT EXISTS job_attention_delivery_receipts (
    attention_event_id TEXT PRIMARY KEY REFERENCES events(event_id),
    source_event_id TEXT NOT NULL REFERENCES events(event_id),
    workspace_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    message_ts TEXT NOT NULL,
    body_sha256 TEXT NOT NULL,
    verified_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS job_attention_delivery_claims (
    attention_event_id TEXT PRIMARY KEY REFERENCES events(event_id),
    source_event_id TEXT NOT NULL REFERENCES events(event_id),
    claim_token TEXT NOT NULL UNIQUE,
    expected_event_updated_at TEXT NOT NULL,
    message_ts TEXT NOT NULL,
    body_sha256 TEXT NOT NULL,
    claimed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS job_attention_legacy_claims (
    source_event_id TEXT PRIMARY KEY REFERENCES events(event_id),
    all_terminal_event_id TEXT NOT NULL REFERENCES events(event_id),
    event_status_at_detection TEXT NOT NULL,
    recovery_state TEXT NOT NULL CHECK (recovery_state IN ('superseded','needs_review')),
    detected_at TEXT NOT NULL
  );
`);}

function reconcileLegacyAttentionClaims(db: Database.Database): void {
  const candidates=db.prepare(`SELECT g.source_event_id,g.all_terminal_event_id,e.status
    FROM job_groups g JOIN events e ON e.event_id=g.all_terminal_event_id
    WHERE g.notification_mode='grouped'
      AND g.all_terminal_event_id IS NOT NULL
      AND json_extract(e.payload_json,'$.group.attention_resolution_state') IS NULL`)
    .all() as Array<{source_event_id:string;all_terminal_event_id:string;status:EventStatus}>;
  const at=nowUtc();
  for(const candidate of candidates) {
    const safeToSupersede=["queued","retryable_failed"].includes(candidate.status);
    db.prepare(`INSERT OR IGNORE INTO job_attention_legacy_claims
      (source_event_id,all_terminal_event_id,event_status_at_detection,recovery_state,detected_at)
      VALUES(?,?,?,?,?)`).run(candidate.source_event_id,candidate.all_terminal_event_id,candidate.status,
      safeToSupersede?"superseded":"needs_review",at);
    if(!safeToSupersede) continue;
    const changed=db.prepare(`UPDATE events SET status='completed',completed_at=?,updated_at=?,
      last_error_code='legacy_group_terminal_superseded',last_error_message=NULL
      WHERE event_id=? AND status IN ('queued','retryable_failed')`)
      .run(at,at,candidate.all_terminal_event_id).changes;
    if(changed!==1) throw new Error("legacy_group_terminal_changed_during_recovery");
    db.prepare("UPDATE jobs SET completion_event_id=NULL,updated_at=? WHERE source_event_id=? AND completion_event_id=?")
      .run(at,candidate.source_event_id,candidate.all_terminal_event_id);
    db.prepare(`UPDATE job_groups SET all_terminal_event_id=NULL,
      attention_event_id=CASE WHEN NOT EXISTS (
        SELECT 1 FROM jobs j WHERE j.source_event_id=job_groups.source_event_id
          AND j.status NOT IN ('completed','cancelled')
      ) THEN NULL ELSE attention_event_id END,
      updated_at=?
      WHERE source_event_id=? AND all_terminal_event_id=?`)
      .run(at,candidate.source_event_id,candidate.all_terminal_event_id);
  }
}

export function migrateDispatcherDatabase(
  db: Database.Database,
  migrationHook: DispatcherMigrationHook = () => {},
  outerTransaction = false,
  targetWrite: 2 | 3 = dispatcherSchemaCompatibility.write,
): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > dispatcherSchemaCompatibility.read_max) {
    throw new Error(
      `Database schema version ${version} is newer than supported version ${dispatcherSchemaCompatibility.read_max}`,
    );
  }
  if (version < 1) db.exec(`
    CREATE TABLE events (
      sequence            INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id            TEXT NOT NULL UNIQUE,
      schema_version      INTEGER NOT NULL,
      source              TEXT NOT NULL,
      external_event_id   TEXT NOT NULL,
      event_type          TEXT NOT NULL,
      occurred_at         TEXT NOT NULL,
      subject_json        TEXT NOT NULL,
      payload_json        TEXT NOT NULL,
      reply_target_json   TEXT,
      trace_json          TEXT,
      status              TEXT NOT NULL CHECK (status IN (${statusSql})),
      attempt_count       INTEGER NOT NULL DEFAULT 0,
      available_at        TEXT NOT NULL,
      dispatch_started_at TEXT,
      prompt_accepted_at  TEXT,
      completed_at        TEXT,
      result_json         TEXT,
      result_path         TEXT,
      last_error_code     TEXT,
      last_error_message  TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      UNIQUE (source, external_event_id)
    );
    CREATE INDEX events_dispatch_idx ON events(status, available_at, sequence);
    PRAGMA user_version = 1;
  `);
  if (version < 2) db.exec(`
    CREATE TABLE jobs (
      job_id                TEXT PRIMARY KEY,
      source_event_id       TEXT NOT NULL UNIQUE REFERENCES events(event_id),
      source                TEXT NOT NULL,
      workspace_id          TEXT,
      channel_id            TEXT,
      thread_ts             TEXT,
      actor_id              TEXT,
      objective             TEXT NOT NULL,
      workspace_json        TEXT NOT NULL,
      status                TEXT NOT NULL CHECK (status IN (${jobStatusSql})),
      attempt_count         INTEGER NOT NULL DEFAULT 0,
      available_at          TEXT NOT NULL,
      workspace_path        TEXT NOT NULL,
      result_path           TEXT NOT NULL,
      herdr_workspace_id    TEXT,
      herdr_pane_id         TEXT,
      agent_name            TEXT NOT NULL UNIQUE,
      dispatch_started_at   TEXT,
      prompt_accepted_at    TEXT,
      completed_at          TEXT,
      result_json           TEXT,
      completion_event_id   TEXT REFERENCES events(event_id),
      steer_event_id        TEXT,
      steer_state           TEXT CHECK (steer_state IN ('dispatching', 'accepted') OR steer_state IS NULL),
      last_error_code       TEXT,
      last_error_message    TEXT,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL
    );
    CREATE INDEX jobs_run_idx ON jobs(status, available_at, created_at);
    CREATE INDEX jobs_thread_idx ON jobs(workspace_id, channel_id, thread_ts, created_at);
    PRAGMA user_version = 2;
  `);
  const migrateV3 = () => {
    const hasLegacyStopMarkers = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_job_agents_to_stop'").get() !== undefined;
    db.exec("CREATE TEMP TABLE legacy_job_stop_markers_v3(job_id TEXT PRIMARY KEY, stopped_at TEXT)");
    if (hasLegacyStopMarkers) db.exec("INSERT INTO legacy_job_stop_markers_v3 SELECT job_id, stopped_at FROM legacy_job_agents_to_stop");
    const hasGroups = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_groups'").get() !== undefined;
    if (hasGroups) db.exec("CREATE TEMP TABLE preserved_job_groups_v3 AS SELECT * FROM job_groups");
    const jobsHasKey = (db.pragma("table_info(jobs)") as Array<{ name: string }>).some(({ name }) => name === "job_key");
    db.exec(`
      CREATE TABLE jobs_v3 (
        job_id                TEXT PRIMARY KEY,
        source_event_id       TEXT NOT NULL REFERENCES events(event_id),
        job_key               TEXT NOT NULL DEFAULT 'legacy-default',
        source                TEXT NOT NULL,
        workspace_id          TEXT,
        channel_id            TEXT,
        thread_ts             TEXT,
        actor_id              TEXT,
        objective             TEXT NOT NULL,
        workspace_json        TEXT NOT NULL,
        status                TEXT NOT NULL CHECK (status IN (${jobStatusSql})),
        attempt_count         INTEGER NOT NULL DEFAULT 0,
        available_at          TEXT NOT NULL,
        workspace_path        TEXT NOT NULL,
        result_path           TEXT NOT NULL,
        herdr_workspace_id    TEXT,
        herdr_pane_id         TEXT,
        agent_name            TEXT NOT NULL UNIQUE,
        dispatch_started_at   TEXT,
        prompt_accepted_at    TEXT,
        completed_at          TEXT,
        result_json           TEXT,
        completion_event_id   TEXT REFERENCES events(event_id),
        steer_event_id        TEXT,
        steer_state           TEXT CHECK (steer_state IN ('dispatching', 'accepted') OR steer_state IS NULL),
        last_error_code       TEXT,
        last_error_message    TEXT,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        UNIQUE (source_event_id, job_key)
      );
      INSERT INTO jobs_v3 (
        job_id, source_event_id, job_key, source, workspace_id, channel_id, thread_ts, actor_id,
        objective, workspace_json, status, attempt_count, available_at, workspace_path, result_path,
        herdr_workspace_id, herdr_pane_id, agent_name, dispatch_started_at, prompt_accepted_at,
        completed_at, result_json, completion_event_id, steer_event_id, steer_state,
        last_error_code, last_error_message, created_at, updated_at
      )
      SELECT
        job_id, source_event_id, ${jobsHasKey ? "job_key" : "'legacy-default'"}, source, workspace_id, channel_id, thread_ts, actor_id,
        objective, workspace_json, status, attempt_count, available_at, workspace_path, result_path,
        herdr_workspace_id, herdr_pane_id, agent_name, dispatch_started_at, prompt_accepted_at,
        completed_at, result_json, completion_event_id, steer_event_id, steer_state,
        last_error_code, last_error_message, created_at, updated_at
      FROM jobs;
    `);
    migrationHook("jobs_copied");

    db.exec(`
      DROP TABLE jobs;
      ALTER TABLE jobs_v3 RENAME TO jobs;
      CREATE INDEX jobs_run_idx ON jobs(status, available_at, created_at);
      CREATE INDEX jobs_thread_idx ON jobs(workspace_id, channel_id, thread_ts, created_at);
      CREATE INDEX jobs_event_idx ON jobs(source_event_id, created_at);
      ${jobsRunnableFairIndexSql};
    `);
    if (hasLegacyStopMarkers) db.exec(`INSERT OR REPLACE INTO legacy_job_agents_to_stop(job_id, stopped_at)
      SELECT marker.job_id, marker.stopped_at FROM legacy_job_stop_markers_v3 marker JOIN jobs USING(job_id);`);
    db.exec("DROP TABLE legacy_job_stop_markers_v3");
    migrationHook("indexes_recreated");

    db.exec(`
      DROP TABLE IF EXISTS job_groups;
      CREATE TABLE job_groups (
        source_event_id       TEXT PRIMARY KEY REFERENCES events(event_id),
        sealed_at             TEXT,
        notification_mode     TEXT NOT NULL CHECK (notification_mode IN ('grouped', 'legacy')),
        attention_event_id    TEXT REFERENCES events(event_id),
        all_terminal_event_id TEXT REFERENCES events(event_id),
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );
      CREATE INDEX job_groups_transition_idx
        ON job_groups(notification_mode, sealed_at, updated_at);
    `);
    const eventColumns = new Set((db.pragma("table_info(events)") as Array<{name:string}>).map(row=>row.name));
    if (["status","completed_at","updated_at"].every(column=>eventColumns.has(column))) db.exec(`
      INSERT INTO job_groups (
        source_event_id, sealed_at, notification_mode, attention_event_id,
        all_terminal_event_id, created_at, updated_at
      )
      SELECT
        jobs.source_event_id,
        CASE
          WHEN events.status NOT IN ('dispatching', 'waiting_agent')
            THEN COALESCE(events.completed_at, events.updated_at, MAX(jobs.updated_at))
          ELSE NULL
        END,
        CASE
          WHEN MAX(CASE WHEN jobs.completion_event_id IS NOT NULL THEN 1 ELSE 0 END) = 1
            THEN 'legacy'
          ELSE 'grouped'
        END,
        NULL,
        NULL,
        MIN(jobs.created_at),
        MAX(jobs.updated_at)
      FROM jobs
      JOIN events ON events.event_id = jobs.source_event_id
      GROUP BY jobs.source_event_id;
    `);
    if (hasGroups) db.exec("INSERT OR REPLACE INTO job_groups SELECT * FROM preserved_job_groups_v3; DROP TABLE preserved_job_groups_v3;");
    migrationHook("groups_backfilled");
    db.pragma(`user_version = ${targetWrite}`);
  };
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  if (targetWrite >= 3 && currentVersion < 3) outerTransaction ? migrateV3() : db.transaction(migrateV3)();
  if (targetWrite === 2 && currentVersion === 2) ensureV2BridgeSchema(db);
  if ((db.pragma("user_version", { simple: true }) as number) >= 3) {
    ensureJobsRunnableFairIndex(db);
    ensureJobsWorkspaceJobIndex(db);
    ensureJobsStatusJobIndex(db);
    ensureJobAttentionResolutionSchema(db);
    reconcileLegacyAttentionClaims(db);
  }
}

export class DispatcherDatabase {
  private readonly db: Database.Database;
  readonly scheduler: SchedulerRepository;
  private readonly schemaWrite: 2 | 3;
  private readonly migrationHook: DispatcherMigrationHook;
  private readonly jobAdmissionLimits: JobAdmissionLimits;

  constructor(databasePath: string, migrationHookOrLimits: DispatcherMigrationHook | JobAdmissionLimits = jobResourceDefaults) {
    this.migrationHook = typeof migrationHookOrLimits === "function" ? migrationHookOrLimits : () => {};
    this.jobAdmissionLimits = typeof migrationHookOrLimits === "function"
      ? { jobsPerEventMax: 8, jobObjectiveTotalMaxBytes: 400_000 } : migrationHookOrLimits;
    if (!Number.isSafeInteger(this.jobAdmissionLimits.jobsPerEventMax) || this.jobAdmissionLimits.jobsPerEventMax < 1 || this.jobAdmissionLimits.jobsPerEventMax > 32) throw new Error("jobsPerEventMax must be between 1 and 32");
    if (!Number.isSafeInteger(this.jobAdmissionLimits.jobObjectiveTotalMaxBytes) || this.jobAdmissionLimits.jobObjectiveTotalMaxBytes < 1) throw new Error("jobObjectiveTotalMaxBytes must be positive");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(databasePath), 0o700);
    this.db = new Database(databasePath);
    fs.chmodSync(databasePath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 2000");
    this.db.pragma("foreign_keys = ON");
    const existingVersion = this.db.pragma("user_version", {simple:true}) as number;
    this.schemaWrite = !process.env.DONA_RELEASE_MANIFEST_PATH && existingVersion === 2
      ? 2 : dispatcherSchemaCompatibility.write;
    try {
      this.db.transaction(() => {
        migrateDispatcherDatabase(this.db, this.migrationHook, true, this.schemaWrite);
        migrateScheduler(this.db, this.migrationHook, true);
        migrateLiveSession(this.db);
      }).immediate();
      const routingTable=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_routing_schema'").get()!==undefined;
      const routingMarker=routingTable&&this.db.prepare("SELECT 1 FROM job_routing_schema WHERE singleton=1").get()!==undefined;
      const eventColumns=new Set((this.db.prepare("PRAGMA table_info(events)").all() as Array<{name:string}>).map(row=>row.name));
      const legacyScheduleResults=!routingMarker&&["source","status","result_path"].every(column=>eventColumns.has(column))?(this.db.prepare(`SELECT e.event_id,e.result_path FROM events e JOIN schedule_runs r ON r.event_id=e.event_id
        JOIN schedule_revisions v ON v.schedule_id=r.schedule_id AND v.revision=r.revision
        WHERE e.source='dona_schedule' AND e.status='completed' AND e.result_path IS NOT NULL AND v.action='work.read_only'
          AND r.status='materialized' AND r.job_id IS NULL AND NOT EXISTS (SELECT 1 FROM jobs WHERE source_event_id=e.event_id)`).all() as Array<{event_id:string;result_path:string}>):[];
      const movedResults:Array<{from:string;to:string}>=[];
      try {
        for(const row of legacyScheduleResults) if(fs.existsSync(row.result_path)) {
          const backup=`${row.result_path}.routing-migration-backup`;
          if(fs.existsSync(backup)) throw new Error("routing_migration_result_backup_exists");
          fs.renameSync(row.result_path,backup); movedResults.push({from:row.result_path,to:backup});
        }
        migrateJobRouting(this.db);
      } catch(error) {
        for(const moved of movedResults.reverse()) if(fs.existsSync(moved.to)&&!fs.existsSync(moved.from)) fs.renameSync(moved.to,moved.from);
        throw error;
      }
      this.db.exec("CREATE TABLE IF NOT EXISTS legacy_job_agents_to_stop(job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,stopped_at TEXT)");
      for(const row of this.db.prepare("SELECT job_id,result_path,status FROM jobs").all() as Array<{job_id:string;result_path:string;status:string}>) {
        if(path.basename(row.result_path)!==`${row.job_id}.json`) continue;
        const mayHaveLiveLegacyAgent=["retryable_failed","preparing","dispatching","running","blocked","needs_review","cancelling"].includes(row.status);
        if(mayHaveLiveLegacyAgent) this.db.prepare("INSERT OR IGNORE INTO legacy_job_agents_to_stop(job_id) VALUES(?)").run(row.job_id);
        if(mayHaveLiveLegacyAgent) this.db.prepare(`UPDATE jobs SET status='needs_review',last_error_code='legacy_agent_sandbox_unknown',
          last_error_message='Legacy agent may retain the shared result-directory grant',updated_at=? WHERE job_id=?`).run(new Date().toISOString(),row.job_id);
        else if(row.status==="queued") this.db.prepare("UPDATE jobs SET result_path=? WHERE job_id=?").run(path.join(path.dirname(row.result_path),row.job_id,"result.json"),row.job_id);
      }
      if(["status","result_path","last_error_code","last_error_message","updated_at"].every(column=>eventColumns.has(column))) {
        for(const row of this.db.prepare("SELECT event_id,result_path FROM events WHERE status='queued' AND last_error_code='manual_retry_cleanup_pending' AND result_path IS NOT NULL").all() as Array<{event_id:string;result_path:string}>) {
          if(!row.result_path.endsWith(".retry-backup")) throw new Error("invalid_retry_backup_path");
          fs.rmSync(row.result_path,{force:true});
          this.db.prepare("UPDATE events SET result_path=NULL,last_error_code=NULL,last_error_message=NULL,updated_at=? WHERE event_id=? AND status='queued' AND last_error_code='manual_retry_cleanup_pending'")
            .run(nowUtc(),row.event_id);
        }
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.scheduler = new SchedulerRepository(this.db, (event, at) => this.enqueue(event, at), undefined, (jobId,resultPath) => {
      const legacy=path.basename(resultPath)===`${jobId}.json`;
      const isolated=path.basename(resultPath)==="result.json"&&path.basename(path.dirname(resultPath))===jobId;
      const migrationBackup=path.basename(resultPath)===`${jobId}.json.routing-migration-backup`;
      if(!legacy&&!isolated&&!migrationBackup) return false;
      try {
        if(isolated) fs.rmSync(path.dirname(resultPath),{recursive:true,force:true});
        else if(migrationBackup) fs.unlinkSync(resultPath);
        else {
          const directory=path.dirname(resultPath), prefix=`${jobId}.json`;
          for(const name of fs.readdirSync(directory)) if(name===prefix||name.startsWith(`${prefix}.`)) fs.unlinkSync(path.join(directory,name));
        }
        return true;
      } catch(error) { return (error as NodeJS.ErrnoException).code==="ENOENT"; }
    });
  }

  close(): void {
    this.db.close();
  }

  assertReadableWritable(): void {
    this.db.prepare("SELECT 1").get();
    this.db.prepare("UPDATE events SET updated_at = updated_at WHERE 0").run();
  }

  enqueue(envelope: EventEnvelope, at = new Date()): EnqueueResult {
    const timestamp = at.toISOString();
    const subjectJson = stableStringify(envelope.subject);
    const payloadJson = stableStringify(envelope.payload);
    const replyTargetJson = envelope.reply_target === null ? null : stableStringify(envelope.reply_target);
    const traceJson = envelope.trace === undefined ? null : stableStringify(envelope.trace);

    return this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM events WHERE source = ? AND external_event_id = ?")
        .get(envelope.source, envelope.external_event_id) as EventRow | undefined;
      if (existing) {
        const mismatch =
          existing.schema_version !== envelope.schema_version ||
          existing.event_type !== envelope.type ||
          existing.occurred_at !== envelope.occurred_at ||
          existing.subject_json !== subjectJson ||
          existing.payload_json !== payloadJson ||
          existing.reply_target_json !== replyTargetJson;
        const binding=legacySlackBinding(existing);
        if(binding) insertEventJobBinding(this.db,existing.event_id,binding);
        return { row: existing, duplicate: true, payloadMismatch: mismatch };
      }

      const eventId = `evt_${ulid(at.getTime())}`;
      const result = this.db
        .prepare(`
          INSERT INTO events (
            event_id, schema_version, source, external_event_id, event_type,
            occurred_at, subject_json, payload_json, reply_target_json, trace_json,
            status, available_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
        `)
        .run(
          eventId,
          envelope.schema_version,
          envelope.source,
          envelope.external_event_id,
          envelope.type,
          envelope.occurred_at,
          subjectJson,
          payloadJson,
          replyTargetJson,
          traceJson,
          timestamp,
          timestamp,
          timestamp,
        );
      const row = this.getBySequence(Number(result.lastInsertRowid));
      if (!row) throw new Error("Inserted event could not be read back");
      const binding=legacySlackBinding(row);
      if(binding) insertEventJobBinding(this.db,row.event_id,binding);
      return { row, duplicate: false, payloadMismatch: false };
    })();
  }

  get(eventId: string): EventRow | undefined {
    return this.db.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId) as EventRow | undefined;
  }

  getByExternalId(source: string, externalEventId: string): EventRow | undefined {
    return this.db.prepare("SELECT * FROM events WHERE source = ? AND external_event_id = ?")
      .get(source, externalEventId) as EventRow | undefined;
  }

  isEventCompleted(eventId: string): boolean {
    return this.db.prepare("SELECT 1 FROM events WHERE event_id = ? AND status = 'completed'")
      .get(eventId) !== undefined;
  }

  updateSafetyStatus(): { safe: boolean; unsafe_states: string[] } {
    const unsafe: string[] = [];
    const eventRows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM events
      WHERE status IN ('dispatching', 'waiting_agent') GROUP BY status
    `).all() as Array<{ status: string; count: number }>;
    for (const row of eventRows) unsafe.push(`events.${row.status}:${row.count}`);
    const jobRows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM jobs
      WHERE status IN ('dispatching', 'cancelling') GROUP BY status
    `).all() as Array<{ status: string; count: number }>;
    for (const row of jobRows) unsafe.push(`jobs.${row.status}:${row.count}`);
    const steer = this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE steer_state = 'dispatching'")
      .get() as { count: number };
    if (steer.count > 0) unsafe.push(`jobs.steer_acceptance_unknown:${steer.count}`);
    return { safe: unsafe.length === 0, unsafe_states: unsafe };
  }

  getBySequence(sequence: number): EventRow | undefined {
    return this.db.prepare("SELECT * FROM events WHERE sequence = ?").get(sequence) as EventRow | undefined;
  }

  list(status?: EventStatus, limit = 100): EventRow[] {
    if (status) {
      return this.db
        .prepare("SELECT * FROM events WHERE status = ? ORDER BY sequence LIMIT ?")
        .all(status, limit) as EventRow[];
    }
    return this.db.prepare("SELECT * FROM events ORDER BY sequence LIMIT ?").all(limit) as EventRow[];
  }

  createJob(
    request: CreateJobRequest,
    workspaceRoot: string,
    resultDir: string,
    at = new Date(),
  ): CreateJobResult {
    let parsedRequest=parseCreateJobRequest(request);
    const sourceEvent = this.getRequired(parsedRequest.source_event_id);
    if (sourceEvent.source === "dona_schedule") parsedRequest = parseCreateJobRequest(request, true);
    const jobKey=parsedRequest.job_key??legacyJobKey;
    const canonicalPayloadSha256=canonicalJobPayloadSha256(parsedRequest);
    const objectiveUtf8Bytes=Buffer.byteLength(parsedRequest.objective,"utf8");
    const displayLabel = createJobDisplayLabel(parsedRequest.display, parsedRequest.workspace);
    const workspaceJson = serializeJobWorkspace(parsedRequest.workspace,canonicalPayloadSha256,objectiveUtf8Bytes,displayLabel);
    const legacyWorkspaceJson = serializeJobWorkspace(parsedRequest.workspace,canonicalPayloadSha256,objectiveUtf8Bytes);
    const replyTarget = sourceEvent.reply_target_json
      ? JSON.parse(sourceEvent.reply_target_json) as Record<string, unknown>
      : {};
    const subject = JSON.parse(sourceEvent.subject_json) as Record<string, unknown>;
    const workspaceId = stringValue(replyTarget.workspace_id);
    const channelId = stringValue(replyTarget.channel_id);
    const threadTs = stringValue(replyTarget.thread_ts);
    const binding = readEventJobBinding(this.db, sourceEvent.event_id);
    if (!binding) throw new Error(`Event ${sourceEvent.event_id} does not have an authorized job owner`);
    if (binding.owner.kind === "schedule" && parsedRequest.workspace.kind !== "scratch") {
      throw new ScheduledJobCreationError("scheduled_workspace_mismatch", "Scheduled work permits only a scratch workspace");
    }
    if (binding.owner.kind === "schedule") {
      const payload = JSON.parse(sourceEvent.payload_json) as { work?: { objective?: unknown; scope?: unknown; allowed_external_writes?: unknown } };
      if (parsedRequest.job_key!==undefined || parsedRequest.display!==undefined || typeof payload.work?.objective!=="string" || payload.work.objective !== parsedRequest.objective || payload.work.scope !== "read_only" ||
        !Array.isArray(payload.work.allowed_external_writes) || payload.work.allowed_external_writes.length !== 0) {
        throw new ScheduledJobCreationError("scheduled_scope_mismatch", "Scheduled work request does not match its persisted read-only scope");
      }
    }

    const created = this.db.transaction((): CreateJobResult | undefined => {
      const existing = this.db
        .prepare("SELECT * FROM jobs WHERE source_event_id = ? AND job_key = ?")
        .get(parsedRequest.source_event_id,jobKey) as JobRow | undefined;
      if (existing) {
        const stored=jobCreationPayloadSha256FromWorkspace(JSON.parse(existing.workspace_json));
        if(stored!==undefined&&stored!==canonicalPayloadSha256) throw new JobCreationError("job_idempotency_conflict",`Job key ${jobKey} already exists with a different canonical payload`);
        const exactLegacyPayload=existing.objective===parsedRequest.objective && stableStringify(parseJobWorkspace(JSON.parse(existing.workspace_json)))===stableStringify(parsedRequest.workspace);
        if(stored===undefined&&!exactLegacyPayload)
          throw new JobCreationError("job_idempotency_conflict",`Job key ${jobKey} does not match the persisted payload`);
        if(stored===undefined&&exactLegacyPayload) this.db.prepare("UPDATE jobs SET workspace_json=? WHERE job_id=?").run(legacyWorkspaceJson,existing.job_id);
        if(binding.owner.kind==="schedule") {
          const authorized=this.db.prepare(`SELECT 1 FROM schedule_runs r JOIN schedules s USING(schedule_id)
            JOIN schedule_revisions v ON v.schedule_id=r.schedule_id AND v.revision=r.revision
            WHERE r.run_id=? AND r.job_id=? AND r.revision=? AND r.status='started'
              AND s.state='active' AND s.revision=r.revision AND julianday(v.expires_at)>julianday(?)`).get(
            binding.owner.run_id,existing.job_id,binding.owner.revision,at.toISOString());
          if(!["dispatching","waiting_agent"].includes(sourceEvent.status)||!authorized) throw new ScheduledJobCreationError("scheduled_run_not_authorized", "Schedule run is no longer authorized for job reuse");
        }
        return {row:this.getJobRequired(existing.job_id),outcome:"reused",duplicate:true};
      }
      if(binding.owner.kind==="schedule") {
        if(!["dispatching","waiting_agent"].includes(sourceEvent.status)) {
          throw new ScheduledJobCreationError("scheduled_event_not_dispatching", "Scheduled work event is not dispatching");
        }
        const payload=JSON.parse(sourceEvent.payload_json) as {work?:{authorization_target?:{workspace_id?:unknown;channel_id?:unknown}}};
        const target=payload.work?.authorization_target;
        if(typeof target?.workspace_id!=="string"||typeof target.channel_id!=="string") throw new ScheduledJobCreationError("scheduled_authorization_target_missing", "Scheduled work authorization target is missing");
        const earliest=new Date(at.getTime()-120_000).toISOString();
        const consumed=this.db.prepare(`UPDATE events SET schedule_access_consumed_at=? WHERE event_id=? AND schedule_access_checked_at>=?
          AND schedule_access_checked_at<=? AND schedule_access_consumed_at IS NULL`).run(at.toISOString(),sourceEvent.event_id,earliest,at.toISOString()).changes;
        if(consumed!==1) throw new ScheduledJobCreationError("scheduled_access_receipt_unavailable", "Scheduled work current access receipt is missing or expired");
      } else {
        if(["completed","blocked","needs_review","dead_letter"].includes(sourceEvent.status)) throw new JobCreationError("job_group_closed","Source event is closed");
        const group=this.db.prepare("SELECT sealed_at,notification_mode FROM job_groups WHERE source_event_id=?").get(sourceEvent.event_id) as {sealed_at:string|null;notification_mode:string}|undefined;
        if(group?.sealed_at) throw new JobCreationError("job_group_closed","Job group is sealed");
        if(group?.notification_mode==="grouped"&&parsedRequest.job_key===undefined) throw new JobCreationError("job_group_closed","Grouped jobs require an explicit job key");
        if(group?.notification_mode==="legacy"&&jobKey!==legacyJobKey) throw new JobCreationError("job_group_closed","Legacy job group does not accept additional keys");
        const admitted=this.db.prepare("SELECT objective,workspace_json FROM jobs WHERE source_event_id=?").all(sourceEvent.event_id) as Array<{objective:string;workspace_json:string}>;
        if(admitted.length>=this.jobAdmissionLimits.jobsPerEventMax) throw new JobCreationError("job_group_limit_exceeded","Job group jobs-per-event limit exceeded",{resource:"jobs_per_event",current:admitted.length,attempted:admitted.length+1,maximum:this.jobAdmissionLimits.jobsPerEventMax});
        const currentBytes=admitted.reduce((sum,row)=>sum+(jobCreationObjectiveBytesFromWorkspace(JSON.parse(row.workspace_json))??Buffer.byteLength(row.objective,"utf8")),0);
        if(currentBytes+objectiveUtf8Bytes>this.jobAdmissionLimits.jobObjectiveTotalMaxBytes) throw new JobCreationError("job_group_limit_exceeded","Job group objective UTF-8 byte limit exceeded",{resource:"objective_utf8_bytes_per_event",current:currentBytes,attempted:currentBytes+objectiveUtf8Bytes,maximum:this.jobAdmissionLimits.jobObjectiveTotalMaxBytes});
        const effectiveBytes=admitted.reduce((sum,row)=>sum+Buffer.byteLength(row.objective,"utf8"),0);
        if(effectiveBytes+objectiveUtf8Bytes>this.jobAdmissionLimits.jobObjectiveTotalMaxBytes) throw new JobCreationError("job_group_limit_exceeded","Effective job group objective limit exceeded",{resource:"objective_utf8_bytes_per_event",current:effectiveBytes,attempted:effectiveBytes+objectiveUtf8Bytes,maximum:this.jobAdmissionLimits.jobObjectiveTotalMaxBytes});
        if(!group) this.db.prepare("INSERT INTO job_groups(source_event_id,sealed_at,notification_mode,attention_event_id,all_terminal_event_id,created_at,updated_at) VALUES(?,NULL,?,NULL,NULL,?,?)").run(sourceEvent.event_id,jobKey===legacyJobKey?"legacy":"grouped",at.toISOString(),at.toISOString());
      }

      if (this.schemaWrite === 2 && parsedRequest.job_key !== undefined) throw new Error("multi_job_feature_disabled_for_schema_v2_bridge");
      const jobId = jobAgentName(`job_${ulid(at.getTime()).toLowerCase()}`, parsedRequest.objective);
      const workspacePath = parsedRequest.workspace.kind === "scratch"
        ? path.join(workspaceRoot, "scratch", jobId)
        : path.join(
          workspaceRoot,
          "github",
          parsedRequest.workspace.repository.split("/")[0]!,
          parsedRequest.workspace.repository.split("/")[1]!,
          "worktrees",
          jobId,
        );
      const resultPath = path.join(resultDir, jobId, "result.json");
      const timestamp = at.toISOString();
      this.db.prepare(`
        INSERT INTO jobs (
          job_id, source_event_id, job_key, source, workspace_id, channel_id, thread_ts, actor_id,
          objective, workspace_json, status, available_at, workspace_path, result_path,
          agent_name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)
      `).run(
        jobId,
        parsedRequest.source_event_id,
        jobKey,
        sourceEvent.source,
        workspaceId,
        channelId,
        threadTs,
        stringValue(subject.actor_id),
        parsedRequest.objective,
        workspaceJson,
        timestamp,
        workspacePath,
        resultPath,
        jobId,
        timestamp,
        timestamp,
      );
      this.db.prepare(`INSERT INTO job_owner_bindings(job_id,source_event_id,owner_json,destination_json)
        SELECT ?,event_id,owner_json,destination_json FROM event_job_bindings WHERE event_id=?`).run(jobId,sourceEvent.event_id);
      if (binding.owner.kind === "schedule") {
        const scheduleAt = new Date(Math.floor(at.getTime() / 1_000) * 1_000).toISOString().replace(".000Z", "Z");
        try {
          this.scheduler.setRunState(binding.owner.run_id, "materialized", "started",
            { tenant_id: binding.owner.tenant_id, actor_id: "scheduler", role: "admin", source_event_id: sourceEvent.event_id },
            scheduleAt, jobId);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "run_not_authorized") throw error;
          this.db.prepare("DELETE FROM job_owner_bindings WHERE job_id=?").run(jobId);
          this.db.prepare("DELETE FROM jobs WHERE job_id=?").run(jobId);
          return undefined;
        }
      }
      return { row: this.getJobRequired(jobId), outcome:"created", duplicate: false };
    }).immediate();
    if (!created) throw new ScheduledJobCreationError("scheduled_run_not_authorized", "Schedule run is no longer authorized for job creation");
    return created;
  }

  createScheduledJob(sourceEventId: string, workspaceRoot: string, resultDir: string, at = new Date()): CreateJobResult {
    const event = this.getRequired(sourceEventId);
    const payload = JSON.parse(event.payload_json) as { work?: { objective?: unknown } };
    if (event.source !== "dona_schedule" || typeof payload.work?.objective !== "string") {
      throw new ScheduledJobCreationError("scheduled_contract_missing", "Persisted scheduled work contract is unavailable");
    }
    return this.createJob({ source_event_id: sourceEventId, objective: payload.work.objective, workspace: { kind: "scratch" } }, workspaceRoot, resultDir, at);
  }

  recordScheduledDelegationRejection(eventId: string, code: string, at = new Date()): boolean {
    if (!/^scheduled_[a-z0-9_]{1,96}$/.test(code)) throw new Error("invalid_scheduled_delegation_code");
    const changed = this.db.prepare(`UPDATE events SET last_error_code=?,last_error_message=?,updated_at=?
      WHERE event_id=? AND source='dona_schedule' AND status IN ('dispatching','waiting_agent')
        AND NOT EXISTS (SELECT 1 FROM schedule_runs WHERE event_id=events.event_id AND job_id IS NOT NULL)`)
      .run(`delegation_rejected:${code}`, "Scheduled job delegation was definitely rejected before acceptance", at.toISOString(), eventId).changes;
    return changed === 1;
  }

  getJob(jobId: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
  }

  listJobs(status?: JobStatus, limit = 100): JobRow[] {
    if (status) {
      return this.db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY created_at LIMIT ?").all(status, limit) as JobRow[];
    }
    return this.db.prepare("SELECT * FROM jobs ORDER BY created_at LIMIT ?").all(limit) as JobRow[];
  }

  listLegacySharedGrantJobs():JobRow[] {
    return this.db.prepare(`SELECT j.* FROM jobs j JOIN legacy_job_agents_to_stop l USING(job_id) WHERE l.stopped_at IS NULL
      AND j.status IN ('retryable_failed','preparing','dispatching','running','blocked','needs_review','cancelling') ORDER BY j.created_at,j.job_id`).all() as JobRow[];
  }

  markLegacySharedGrantAgentStopped(jobId:string):void {this.db.prepare("UPDATE legacy_job_agents_to_stop SET stopped_at=? WHERE job_id=?").run(nowUtc(),jobId);}
  isLegacySharedGrantAgentStopped(jobId:string):boolean {
    return this.db.prepare("SELECT 1 FROM legacy_job_agents_to_stop WHERE job_id=? AND stopped_at IS NOT NULL").get(jobId)!==undefined;
  }

  listThreadJobs(workspaceId: string, channelId: string, threadTs: string, limit = 100): JobRow[] {
    return this.db.prepare(`
      SELECT * FROM jobs
      WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(workspaceId, channelId, threadTs, limit) as JobRow[];
  }

  listOwnerJobs(sourceEventId: string, limit = 100): JobRow[] {
    const binding=readEventJobBinding(this.db,sourceEventId);
    const completion=!binding?this.db.prepare("SELECT owner_json FROM job_completion_results WHERE notification_event_id=?").get(sourceEventId) as {owner_json:string}|undefined:undefined;
    const ownerJson=binding?stableStringify(binding.owner):completion?.owner_json;
    if(!ownerJson) throw new Error("Unknown job owner");
    return this.db.prepare(`SELECT j.* FROM jobs j JOIN job_owner_bindings b USING(job_id)
      WHERE b.owner_json=? ORDER BY j.created_at DESC LIMIT ?`).all(ownerJson,limit) as JobRow[];
  }

  listRunnableJobs(at = new Date(), limit = 100): JobRow[] {
    return this.db.prepare(`
      WITH ranked AS (
        SELECT job_id,rowid AS insertion_order,ROW_NUMBER() OVER (PARTITION BY source_event_id ORDER BY created_at,rowid) AS fairness_rank
        FROM jobs WHERE (status IN ('queued','retryable_failed') AND available_at<=?) OR status IN ('preparing','dispatching','running')
      ) SELECT jobs.* FROM ranked JOIN jobs USING(job_id)
        WHERE jobs.status IN ('queued','retryable_failed','running')
        ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,fairness_rank,created_at,ranked.insertion_order LIMIT ?
    `).all(at.toISOString(), limit) as JobRow[];
  }

  listOverdueScheduledJobs(at = new Date()): JobRow[] {
    const deadline = new Date(at.getTime() - 3_600_000).toISOString();
    return this.db.prepare(`SELECT j.* FROM jobs j JOIN job_owner_bindings b USING(job_id)
      WHERE j.status IN ('running','blocked','needs_review') AND COALESCE(j.prompt_accepted_at,j.dispatch_started_at)<=?
        AND (j.status!='needs_review' OR j.last_error_code IN ('ambiguous_prompt_acceptance','prompt_acceptance_unknown','prompt_interrupted','invalid_result','agent_wait_observation_unknown'))
        AND json_extract(b.owner_json,'$.kind')='schedule'
      ORDER BY COALESCE(j.prompt_accepted_at,j.dispatch_started_at),j.job_id`).all(deadline) as JobRow[];
  }

  listAmbiguousScheduledJobs():JobRow[] {
    return this.db.prepare(`SELECT j.* FROM jobs j JOIN job_owner_bindings b USING(job_id)
      WHERE j.status='needs_review' AND j.last_error_code IN ('ambiguous_prompt_acceptance','prompt_acceptance_unknown','prompt_interrupted','cancel_acceptance_unknown','cancel_exit_unknown','ambiguous_cancel_acceptance','invalid_result','invalid_result_agent_stop_unknown','agent_wait_observation_unknown')
        AND json_extract(b.owner_json,'$.kind')='schedule' ORDER BY j.updated_at,j.job_id`).all() as JobRow[];
  }

  settleAmbiguousCancellation(jobId:string,reason:string,at=new Date()):void {
    this.db.transaction(()=>{
      const job=this.getJobRequired(jobId),binding=readEventJobBinding(this.db,job.source_event_id);
      if(binding?.owner.kind!=="schedule") throw new Error("scheduled_job_binding_required");
      if(job.completion_event_id) {
        const completion=this.db.prepare("SELECT notification_state FROM job_completion_results WHERE notification_event_id=?").get(job.completion_event_id) as {notification_state:string}|undefined;
        if(completion?.notification_state==="pending") {
          const changed=this.db.prepare("UPDATE events SET status='completed',completed_at=?,updated_at=?,last_error_code='job_result_superseded',last_error_message=NULL WHERE event_id=? AND status IN ('queued','retryable_failed')").run(at.toISOString(),at.toISOString(),job.completion_event_id).changes;
          if(changed!==1) throw new Error("prior_notification_requires_reconciliation");
          this.db.prepare("UPDATE job_completion_results SET notification_state='none' WHERE notification_event_id=? AND notification_state='pending'").run(job.completion_event_id);
        } else if(!completion||!["none","accepted"].includes(completion.notification_state)) throw new Error("prior_notification_requires_reconciliation");
        this.db.prepare("UPDATE jobs SET completion_event_id=NULL WHERE job_id=?").run(jobId);
      }
      const reconciledAt=new Date(Math.floor(at.getTime()/1000)*1000).toISOString().replace(".000Z","Z");
      this.scheduler.markWorkRunNeedsReview(binding.owner.run_id,jobId,reconciledAt,job.source_event_id);
      this.scheduler.reconcileWorkRun(binding.owner.run_id,"cancelled",{tenant_id:binding.owner.tenant_id,actor_id:"dispatcher-admin",role:"admin",source_event_id:null},reconciledAt);
      this.updateJob(jobId,["needs_review"],"cancelled",{completed_at:at.toISOString(),last_error_code:"cancelled",last_error_message:reason});
    }).immediate();
  }

  listScheduledJobsRequiringCancellation(at = new Date()): JobRow[] {
    return this.db.prepare(`SELECT j.* FROM jobs j JOIN job_owner_bindings b USING(job_id)
      JOIN schedules s ON s.schedule_id=json_extract(b.owner_json,'$.schedule_id')
      JOIN schedule_revisions r ON r.schedule_id=s.schedule_id AND r.revision=json_extract(b.owner_json,'$.revision')
      WHERE json_extract(b.owner_json,'$.kind')='schedule'
        AND (s.state IN ('cancelled','expired') OR julianday(r.expires_at)<=julianday(?))
        AND j.status IN ('queued','retryable_failed','preparing','dispatching','running','blocked','needs_review')
        AND (j.status!='needs_review' OR j.last_error_code IN ('ambiguous_prompt_acceptance','prompt_acceptance_unknown','prompt_interrupted','invalid_result','agent_wait_observation_unknown'))
      ORDER BY j.created_at,j.job_id`).all(at.toISOString()) as JobRow[];
  }

  listTerminalScheduledJobsNeedingCleanup(limit = 100): JobRow[] {
    return this.db.prepare(`SELECT DISTINCT j.* FROM jobs j JOIN job_completion_results c USING(job_id)
      WHERE (j.status IN ('completed','failed','cancelled') OR (j.status='needs_review' AND j.last_error_code='workspace_cleanup_failed')) AND j.herdr_workspace_id IS NOT NULL
        AND json_extract(c.owner_json,'$.kind')='schedule' AND json_extract(j.workspace_json,'$.kind')='scratch'
      ORDER BY j.completed_at,j.job_id LIMIT ?`).all(limit) as JobRow[];
  }

  markJobRuntimeCleaned(jobId: string): void {
    this.db.transaction(()=>{
      const changed=this.db.prepare(`UPDATE jobs SET herdr_workspace_id=NULL,herdr_pane_id=NULL,updated_at=?
        WHERE job_id=? AND (status IN ('completed','failed','cancelled') OR (status='needs_review' AND last_error_code='workspace_cleanup_failed'))`).run(nowUtc(),jobId).changes;
      if(changed===1)this.db.prepare("DELETE FROM job_live_session_identities WHERE job_id=?").run(jobId);
    }).immediate();
  }

  getJobGroup(sourceEventId: string): JobGroupRow | undefined {
    return this.db.prepare("SELECT * FROM job_groups WHERE source_event_id = ?")
      .get(sourceEventId) as JobGroupRow | undefined;
  }

  getLegacyAttentionClaim(sourceEventId: string): {
    source_event_id:string;all_terminal_event_id:string;event_status_at_detection:string;
    recovery_state:"superseded"|"needs_review";detected_at:string;
  } | undefined {
    return this.db.prepare("SELECT * FROM job_attention_legacy_claims WHERE source_event_id=?")
      .get(sourceEventId) as ReturnType<DispatcherDatabase["getLegacyAttentionClaim"]>;
  }

  ensureJobGroup(
    sourceEventId: string,
    notificationMode: JobGroupNotificationMode,
    at = new Date(),
  ): { row: JobGroupRow; created: boolean } {
    this.getRequired(sourceEventId);
    return this.db.transaction(() => {
      const existing = this.getJobGroup(sourceEventId);
      if (existing) {
        if (existing.notification_mode !== notificationMode) {
          throw new Error(`Job group ${sourceEventId} already uses ${existing.notification_mode} notifications`);
        }
        return { row: existing, created: false };
      }
      const timestamp = at.toISOString();
      this.db.prepare(`
        INSERT INTO job_groups (
          source_event_id, sealed_at, notification_mode, attention_event_id,
          all_terminal_event_id, created_at, updated_at
        ) VALUES (?, NULL, ?, NULL, NULL, ?, ?)
      `).run(sourceEventId, notificationMode, timestamp, timestamp);
      return { row: this.getJobGroupRequired(sourceEventId), created: true };
    })();
  }

  sealJobGroup(sourceEventId: string, at = new Date()): JobGroupRow {
    return this.db.transaction(() => {
      const timestamp = at.toISOString();
      const changed = this.sealJobGroupIfPresent(sourceEventId, timestamp);
      if (changed === 0) this.getJobGroupRequired(sourceEventId);
      return this.getJobGroupRequired(sourceEventId);
    }).immediate();
  }

  claimJobGroupTransition(
    sourceEventId: string,
    transition: Exclude<JobGroupTransition, "progress">,
    eventId: string,
    at = new Date(),
  ): { row: JobGroupRow; claimed: boolean } {
    this.getRequired(eventId);
    const field = transition === "attention" ? "attention_event_id" : "all_terminal_event_id";
    return this.db.transaction(() => {
      const existing = this.getJobGroupRequired(sourceEventId);
      if (!existing.sealed_at) throw new Error(`Job group ${sourceEventId} is not sealed`);
      if (transition === "all_terminal" && existing.all_terminal_event_id) {
        return { row: existing, claimed: false };
      }
      if (transition === "all_terminal" && !this.groupCanClaimAllTerminal(sourceEventId, existing)) {
        throw new Error("job_group_attention_unresolved");
      }
      const timestamp = at.toISOString();
      const changed = this.db.prepare(`
        UPDATE job_groups SET ${field} = ?, updated_at = ?
        WHERE source_event_id = ? AND ${field} IS NULL
      `).run(eventId, timestamp, sourceEventId).changes;
      return { row: this.getJobGroupRequired(sourceEventId), claimed: changed === 1 };
    }).immediate();
  }

  listJobsNeedingNotification(limit = 100): JobRow[] {
    return this.db.prepare(`
      SELECT j.* FROM jobs j
      JOIN job_owner_bindings b ON b.job_id=j.job_id
      LEFT JOIN job_groups g ON g.source_event_id=j.source_event_id
      WHERE j.status IN ('blocked','completed','failed','cancelled','needs_review') AND (
        (json_extract(b.owner_json,'$.kind')='schedule' AND j.completion_event_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM job_completion_results c WHERE c.job_id=j.job_id AND c.job_status=j.status))
        OR (json_extract(b.owner_json,'$.kind')='slack_thread'
          AND (g.notification_mode='legacy' OR (g.sealed_at IS NOT NULL AND g.all_terminal_event_id IS NULL))
          AND (j.completion_event_id IS NULL
            OR (g.notification_mode='grouped' AND g.attention_event_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM jobs sibling WHERE sibling.source_event_id=j.source_event_id
                AND sibling.status NOT IN ('completed','failed','cancelled'))
              AND NOT EXISTS (SELECT 1 FROM jobs unresolved WHERE unresolved.source_event_id=j.source_event_id
                AND unresolved.status='failed' AND NOT EXISTS (
                  SELECT 1 FROM job_attention_resolutions r WHERE r.job_id=unresolved.job_id
                    AND r.source_event_id=j.source_event_id AND r.status_at_resolution='failed')))
            OR (g.notification_mode='grouped'
              AND g.attention_event_id IS NULL AND g.all_terminal_event_id IS NULL
              AND j.status IN ('blocked','failed','needs_review')
              AND NOT EXISTS (SELECT 1 FROM job_attention_resolutions r
                WHERE r.job_id=j.job_id AND r.source_event_id=j.source_event_id
                  AND r.status_at_resolution=j.status))))
      )
      ORDER BY CASE WHEN j.status IN ('blocked','failed','needs_review') THEN 0 ELSE 1 END,j.updated_at,j.job_id LIMIT ?
    `).all(limit) as JobRow[];
  }

  recoverStaleJobs(at = new Date()): { retryable: number; needsReview: number } {
    const timestamp = at.toISOString();
    const retryable = this.db.prepare(`
      UPDATE jobs SET status = 'retryable_failed', available_at = ?,
        last_error_code = 'stale_preparing',
        last_error_message = 'Dispatcher restarted before the job prompt was attempted', updated_at = ?
      WHERE status = 'preparing'
    `).run(timestamp, timestamp).changes;
    const needsReview = this.db.prepare(`
      UPDATE jobs SET status = 'needs_review',
        last_error_code = CASE WHEN status='cancelling' THEN 'ambiguous_cancel_acceptance'
          WHEN status='dispatching' THEN 'ambiguous_prompt_acceptance' ELSE 'ambiguous_steer_acceptance' END,
        last_error_message = 'Dispatcher restarted while job prompt, steer, or cancellation acceptance was unknown',
        steer_state = NULL, updated_at = ?
      WHERE status IN ('dispatching', 'cancelling') OR steer_state = 'dispatching'
    `).run(timestamp).changes;
    return { retryable, needsReview };
  }

  beginJobPreparation(jobId: string, at = new Date()): JobRow {
    const timestamp = at.toISOString();
    const changed = this.db.prepare(`
      UPDATE jobs SET status = 'preparing', attempt_count = attempt_count + 1,
        last_error_code = NULL, last_error_message = NULL, updated_at = ?
      WHERE job_id = ? AND status IN ('queued', 'retryable_failed') AND available_at <= ?
    `).run(timestamp, jobId, timestamp).changes;
    if (changed !== 1) throw new Error(`Job ${jobId} is no longer ready to prepare`);
    return this.getJobRequired(jobId);
  }

  setJobRuntime(jobId: string, herdrWorkspaceId: string, herdrPaneId: string, agentSessionId?: string, at = new Date()): void {
    if (agentSessionId !== undefined && (agentSessionId.length < 1 || agentSessionId.length > 512)) throw new Error("Herdr agent session identity is invalid");
    this.db.transaction(() => {
      const changed=this.db.prepare("UPDATE jobs SET herdr_workspace_id=?,herdr_pane_id=? WHERE job_id=? AND status IN ('preparing','cancelling')")
        .run(herdrWorkspaceId,herdrPaneId,jobId).changes;
      if(changed!==1)throw new Error(`Job ${jobId} is no longer preparing or cancelling`);
      const agentName=(this.db.prepare("SELECT agent_name FROM jobs WHERE job_id=?").get(jobId) as {agent_name:string}).agent_name;
      const existing=this.getJobLiveSessionIdentity(jobId);
      const sameIdentity=agentSessionId!==undefined&&existing?.herdr_agent_session_id===agentSessionId
        &&existing.herdr_workspace_id===herdrWorkspaceId&&existing.herdr_pane_id===herdrPaneId&&existing.agent_name===agentName;
      if(!sameIdentity)this.db.prepare("DELETE FROM job_live_session_identities WHERE job_id=?").run(jobId);
      if (agentSessionId !== undefined&&!sameIdentity) this.db.prepare(`INSERT INTO job_live_session_identities(
        job_id,identity_version,herdr_agent_session_id,herdr_workspace_id,herdr_pane_id,agent_name,recorded_at)
        SELECT job_id,1,?,?,?,?,? FROM jobs WHERE job_id=?`)
        .run(agentSessionId,herdrWorkspaceId,herdrPaneId,agentName,at.toISOString(),jobId);
    }).immediate();
  }

  getJobLiveSessionIdentity(jobId: string): LiveSessionIdentityRow | undefined {
    return this.db.prepare("SELECT * FROM job_live_session_identities WHERE job_id=?").get(jobId) as LiveSessionIdentityRow | undefined;
  }

  appendLiveSessionReceipt(sourceEventId: string | undefined, receipt: LiveSessionReceiptProjection, startedAt: string, identity?:LiveSessionIdentityRow): LiveSessionReceiptProjection {
    return this.db.transaction(() => {
      let auditedReceipt=receipt;
      const sequence=receipt.live_session.state_change_seq;
      if(identity&&receipt.live_session.query_status==="observed"&&receipt.live_session.identity_match===true&&sequence!==null){
        const currentSequence=this.latestLiveSessionStateChangeSeq(receipt.job_id,identity);
        if(currentSequence!==undefined&&sequence<currentSequence){
          auditedReceipt={...receipt,reconciliation:{state:"unknown",confidence:"fail_closed",
            reason_codes:[...new Set([...receipt.reconciliation.reason_codes,"same_identity","state_sequence_regressed"])],
            safe_next_action:"do_not_retry"}};
        }
      }
      insertLiveSessionReceipt(this.db,sourceEventId,auditedReceipt,startedAt);
      if(identity&&auditedReceipt.live_session.query_status==="observed"&&auditedReceipt.live_session.identity_match===true&&sequence!==null){
        const changed=this.db.prepare(`UPDATE job_live_session_identities SET max_state_change_seq=CASE
          WHEN max_state_change_seq IS NULL OR max_state_change_seq<? THEN ? ELSE max_state_change_seq END
          WHERE job_id=? AND recorded_at=? AND herdr_agent_session_id=? AND herdr_workspace_id=? AND herdr_pane_id=? AND agent_name=?`)
          .run(sequence,sequence,identity.job_id,identity.recorded_at,identity.herdr_agent_session_id,
            identity.herdr_workspace_id,identity.herdr_pane_id,identity.agent_name).changes;
        if(changed!==1)throw new Error("Live session identity generation changed before audit append");
      }
      return auditedReceipt;
    }).immediate();
  }

  getLiveSessionReceipt(jobId: string, receiptId: string): LiveSessionReceiptProjection | undefined {
    const row=this.db.prepare("SELECT * FROM live_session_query_receipts WHERE job_id=? AND receipt_id=?")
      .get(jobId,receiptId) as LiveSessionReceiptRow | undefined;
    return row ? projectLiveSessionReceipt(row) : undefined;
  }

  resolveInvalidJobResult(jobId: string, receiptId: string, expectedUpdatedAt: string, at = new Date()): JobRow {
    return this.db.transaction(() => {
      const job = this.getJobRequired(jobId);
      const binding = readEventJobBinding(this.db, job.source_event_id);
      if (binding?.owner.kind === "schedule") throw new Error("scheduled_job_reconciliation_required");
      if (job.status !== "needs_review" || !["invalid_result", "invalid_result_agent_stopped"].includes(job.last_error_code ?? ""))
        throw new Error("job_invalid_result_reconciliation_unavailable");
      if (job.updated_at !== expectedUpdatedAt) throw new Error("job_changed_since_review");
      if (job.result_json !== null) throw new Error("job_result_already_accepted");
      const receipt = this.getLiveSessionReceipt(jobId, receiptId);
      if (!receipt || receipt.durable_status_after !== "needs_review" || receipt.result_present_after ||
          receipt.reconciliation.safe_next_action !== "do_not_retry") throw new Error("live_session_receipt_mismatch");
      if (Date.parse(receipt.observed_at) < Date.parse(job.updated_at)) throw new Error("live_session_receipt_precedes_job_state");
      const latest = this.db.prepare("SELECT receipt_id FROM live_session_query_receipts WHERE job_id=? ORDER BY sequence DESC LIMIT 1")
        .get(jobId) as {receipt_id:string}|undefined;
      if (latest?.receipt_id !== receiptId) throw new Error("newer_live_session_receipt_exists");
      const group = this.getJobGroup(job.source_event_id);
      for (const eventId of new Set([job.completion_event_id, group?.attention_event_id, group?.all_terminal_event_id])) {
        if (!eventId) continue;
        const event = this.getRequired(eventId);
        const pending = ["queued", "retryable_failed"].includes(event.status);
        if (pending) {
          this.db.prepare(`UPDATE events SET status='completed',completed_at=?,updated_at=?,
            last_error_code='job_result_superseded',last_error_message=NULL WHERE event_id=?`)
            .run(at.toISOString(),at.toISOString(),eventId);
        } else if (event.status !== "completed") throw new Error("prior_notification_requires_reconciliation");
        this.db.prepare(`UPDATE job_groups SET
          attention_event_id=CASE WHEN attention_event_id=? AND ? THEN NULL ELSE attention_event_id END,
          all_terminal_event_id=CASE WHEN all_terminal_event_id=? THEN NULL ELSE all_terminal_event_id END
          WHERE source_event_id=?`).run(eventId,pending?1:0,eventId,job.source_event_id);
      }
      const changed = this.db.prepare(`UPDATE jobs SET status='failed',completed_at=?,updated_at=?,
        completion_event_id=NULL,last_error_code='invalid_result_operator_resolved',last_error_message=?
        WHERE job_id=? AND status='needs_review' AND updated_at=? AND result_json IS NULL`)
        .run(at.toISOString(), at.toISOString(), `Operator reviewed worker termination and side effects; receipt ${receiptId}`, jobId, expectedUpdatedAt).changes;
      if (changed !== 1) throw new Error("job_changed_since_review");
      if (group?.notification_mode === "grouped" && group.attention_event_id) {
        this.recordAttentionResolution(jobId, group.attention_event_id, "failed", "operator_reconcile", null, at);
      }
      this.enqueueJobNotification(jobId, at);
      return this.getJobRequired(jobId);
    }).immediate();
  }

  resolveFailedJobAttention(
    sourceEventId: string, jobId: string, attentionEventId: string, expectedUpdatedAt: string,
    at = new Date(),
  ): JobRow {
    return this.db.transaction(() => {
      const job = this.getJobRequired(jobId);
      const group = this.getJobGroupRequired(sourceEventId);
      if (job.source_event_id !== sourceEventId || group.notification_mode !== "grouped" ||
          group.attention_event_id !== attentionEventId || group.all_terminal_event_id ||
          job.status !== "failed" || job.updated_at !== expectedUpdatedAt) {
        throw new Error("attention_resolution_binding_mismatch");
      }
      if (readEventJobBinding(this.db, sourceEventId)?.owner.kind !== "slack_thread") {
        throw new Error("attention_resolution_owner_mismatch");
      }
      const event = this.getRequired(attentionEventId);
      if (!this.attentionNotificationSettled(event)) throw new Error("attention_notification_requires_reconciliation");
      this.recordAttentionResolution(jobId, attentionEventId, "failed", "operator_reconcile", null, at);
      this.enqueueJobNotification(jobId, at);
      return this.getJobRequired(jobId);
    }).immediate();
  }

  resolveNeedsReviewAttention(
    sourceEventId: string, jobId: string, attentionEventId: string,
    receiptId: string, expectedUpdatedAt: string, at = new Date(),
  ): JobRow {
    return this.db.transaction(() => {
      const job = this.getJobRequired(jobId);
      const group = this.getJobGroupRequired(sourceEventId);
      if (job.source_event_id !== sourceEventId || group.notification_mode !== "grouped" ||
          group.attention_event_id !== attentionEventId || group.all_terminal_event_id ||
          job.status !== "needs_review" || job.updated_at !== expectedUpdatedAt || job.result_json !== null) {
        throw new Error("attention_resolution_binding_mismatch");
      }
      if (readEventJobBinding(this.db, sourceEventId)?.owner.kind !== "slack_thread") {
        throw new Error("attention_resolution_owner_mismatch");
      }
      const receipt = this.getLiveSessionReceipt(jobId, receiptId);
      if (!receipt || receipt.durable_status_after !== "needs_review" || receipt.result_present_after ||
          receipt.reconciliation.safe_next_action !== "do_not_retry" ||
          Date.parse(receipt.observed_at) < Date.parse(job.updated_at)) {
        throw new Error("live_session_receipt_mismatch");
      }
      const latest = this.db.prepare("SELECT receipt_id FROM live_session_query_receipts WHERE job_id=? ORDER BY sequence DESC LIMIT 1")
        .get(jobId) as {receipt_id:string}|undefined;
      if (latest?.receipt_id !== receiptId) throw new Error("newer_live_session_receipt_exists");
      const previous = job.completion_event_id ? this.getRequired(job.completion_event_id) : undefined;
      if (previous && ["queued", "retryable_failed"].includes(previous.status)) {
        this.db.prepare(`UPDATE events SET status='completed',completed_at=?,updated_at=?,
          last_error_code='job_result_superseded',last_error_message=NULL WHERE event_id=?`)
          .run(at.toISOString(),at.toISOString(),previous.event_id);
        this.db.prepare("UPDATE job_groups SET attention_event_id=NULL WHERE source_event_id=? AND attention_event_id=?")
          .run(sourceEventId,previous.event_id);
      } else if (previous && previous.status !== "completed") {
        throw new Error("prior_notification_requires_reconciliation");
      }
      const changed = this.db.prepare(`UPDATE jobs SET status='failed',completed_at=?,updated_at=?,completion_event_id=NULL,
        last_error_code='attention_operator_resolved',last_error_message='Operator reviewed worker termination and side effects'
        WHERE job_id=? AND status='needs_review' AND updated_at=? AND result_json IS NULL`)
        .run(at.toISOString(),at.toISOString(),jobId,expectedUpdatedAt).changes;
      if (changed !== 1) throw new Error("job_changed_since_review");
      this.recordAttentionResolution(jobId,attentionEventId,"failed","operator_reconcile",null,at);
      this.enqueueJobNotification(jobId,at);
      return this.getJobRequired(jobId);
    }).immediate();
  }

  attentionDeliveryVerificationRequest(
    sourceEventId: string, attentionEventId: string, messageTs: string, bodySha256: string,
  ): JobNotificationVerificationRequest {
    const group = this.getJobGroupRequired(sourceEventId);
    const event = this.getRequired(attentionEventId);
    if (group.attention_event_id !== attentionEventId || group.all_terminal_event_id !== null ||
        event.status !== "completed" || !event.result_json ||
        !/^[a-f0-9]{64}$/.test(bodySha256) || !/^\d+\.\d+$/.test(messageTs)) {
      throw new Error("attention_delivery_reconciliation_unavailable");
    }
    const result = JSON.parse(event.result_json) as ResultEnvelope;
    if (result.event_id !== attentionEventId || result.status !== "completed") {
      throw new Error("attention_delivery_reconciliation_unavailable");
    }
    const payload = JSON.parse(event.payload_json) as { group?: { source_event_id?: string; transition?: string } };
    const target = event.reply_target_json ? JSON.parse(event.reply_target_json) as Record<string, unknown> : null;
    if (payload.group?.source_event_id !== sourceEventId || payload.group.transition !== "attention" ||
        target?.kind !== "slack_thread" || typeof target.workspace_id !== "string" ||
        typeof target.channel_id !== "string" || typeof target.thread_ts !== "string") {
      throw new Error("attention_delivery_reconciliation_unavailable");
    }
    return {schema_version:1,event_id:attentionEventId,workspace_id:target.workspace_id,
      channel_id:target.channel_id,thread_ts:target.thread_ts,message_ts:messageTs,
      body_sha256:bodySha256,desired_session_status:"suspended"};
  }

  claimAttentionDeliveryReconciliation(
    sourceEventId: string, attentionEventId: string, expectedUpdatedAt: string,
    messageTs: string, bodySha256: string, at = new Date(),
  ): { request: JobNotificationVerificationRequest; claimToken: string } {
    return this.db.transaction(() => {
      const request=this.attentionDeliveryVerificationRequest(sourceEventId,attentionEventId,messageTs,bodySha256);
      if(this.getRequired(attentionEventId).updated_at!==expectedUpdatedAt) throw new Error("attention_event_changed_since_verification");
      if(this.db.prepare("SELECT 1 FROM job_attention_delivery_receipts WHERE attention_event_id=?").get(attentionEventId))
        throw new Error("attention_delivery_already_verified");
      const claimToken=ulid();
      this.db.prepare(`INSERT INTO job_attention_delivery_claims
        (attention_event_id,source_event_id,claim_token,expected_event_updated_at,message_ts,body_sha256,claimed_at)
        VALUES(?,?,?,?,?,?,?)`)
        .run(attentionEventId,sourceEventId,claimToken,expectedUpdatedAt,messageTs,bodySha256,at.toISOString());
      return {request,claimToken};
    }).immediate();
  }

  resumeAttentionDeliveryReconciliation(
    sourceEventId: string, attentionEventId: string, expectedUpdatedAt: string,
    messageTs: string, bodySha256: string, claimToken: string,
  ): { request: JobNotificationVerificationRequest; claimToken: string } {
    const request=this.attentionDeliveryVerificationRequest(sourceEventId,attentionEventId,messageTs,bodySha256);
    const claim=this.db.prepare("SELECT * FROM job_attention_delivery_claims WHERE attention_event_id=?")
      .get(attentionEventId) as {source_event_id:string;claim_token:string;expected_event_updated_at:string;message_ts:string;body_sha256:string}|undefined;
    if(!claim || claim.source_event_id!==sourceEventId || claim.claim_token!==claimToken ||
        claim.expected_event_updated_at!==expectedUpdatedAt || claim.message_ts!==messageTs ||
        claim.body_sha256!==bodySha256 || this.getRequired(attentionEventId).updated_at!==expectedUpdatedAt)
      throw new Error("attention_delivery_claim_mismatch");
    return {request,claimToken};
  }

  recordVerifiedAttentionDelivery(
    sourceEventId: string, attentionEventId: string, expectedUpdatedAt: string, claimToken: string,
    evidence: JobNotificationEvidence, at = new Date(),
  ): void {
    this.db.transaction(() => {
      const event = this.getRequired(attentionEventId);
      if (event.updated_at !== expectedUpdatedAt) throw new Error("attention_event_changed_since_verification");
      const request = this.attentionDeliveryVerificationRequest(sourceEventId, attentionEventId,
        evidence.message_ts, evidence.body_sha256);
      const claim=this.db.prepare("SELECT * FROM job_attention_delivery_claims WHERE attention_event_id=?")
        .get(attentionEventId) as {source_event_id:string;claim_token:string;expected_event_updated_at:string;message_ts:string;body_sha256:string}|undefined;
      if(!claim || claim.source_event_id!==sourceEventId || claim.claim_token!==claimToken ||
          claim.expected_event_updated_at!==expectedUpdatedAt || claim.message_ts!==evidence.message_ts ||
          claim.body_sha256!==evidence.body_sha256) throw new Error("attention_delivery_claim_mismatch");
      if (evidence.event_id !== request.event_id || evidence.workspace_id !== request.workspace_id ||
          evidence.channel_id !== request.channel_id || evidence.thread_ts !== request.thread_ts ||
          evidence.session_status !== "suspended" || evidence.reply_broadcast !== false ||
          evidence.identity_block_verified !== true) throw new Error("attention_delivery_evidence_mismatch");
      const existing = this.db.prepare("SELECT * FROM job_attention_delivery_receipts WHERE attention_event_id=?")
        .get(attentionEventId) as {source_event_id:string;message_ts:string;body_sha256:string}|undefined;
      if (existing) {
        if (existing.source_event_id !== sourceEventId || existing.message_ts !== evidence.message_ts ||
            existing.body_sha256 !== evidence.body_sha256) throw new Error("attention_delivery_receipt_conflict");
        return;
      }
      this.db.prepare(`INSERT INTO job_attention_delivery_receipts
        (attention_event_id,source_event_id,workspace_id,channel_id,thread_ts,message_ts,body_sha256,verified_at)
        VALUES(?,?,?,?,?,?,?,?)`)
        .run(attentionEventId,sourceEventId,evidence.workspace_id,evidence.channel_id,evidence.thread_ts,
          evidence.message_ts,evidence.body_sha256,at.toISOString());
      this.db.prepare("DELETE FROM job_attention_delivery_claims WHERE attention_event_id=? AND claim_token=?")
        .run(attentionEventId,claimToken);
    }).immediate();
  }

  latestLiveSessionStateChangeSeq(jobId: string, identity:LiveSessionIdentityRow): number | undefined {
    const current=this.db.prepare(`SELECT max_state_change_seq FROM job_live_session_identities
      WHERE job_id=? AND recorded_at=? AND herdr_agent_session_id=? AND herdr_workspace_id=? AND herdr_pane_id=? AND agent_name=?`)
      .get(jobId,identity.recorded_at,identity.herdr_agent_session_id,identity.herdr_workspace_id,identity.herdr_pane_id,identity.agent_name) as {max_state_change_seq:number|null}|undefined;
    const receipt=this.db.prepare(`SELECT MAX(state_change_seq) AS state_change_seq FROM live_session_query_receipts
      WHERE job_id=? AND completed_at>=? AND query_status='observed' AND identity_match=1 AND state_change_seq IS NOT NULL`)
      .get(jobId,identity.recorded_at) as {state_change_seq:number|null}|undefined;
    const values=[current?.max_state_change_seq,receipt?.state_change_seq].filter((value):value is number=>value!==null&&value!==undefined);
    return values.length>0?Math.max(...values):undefined;
  }

  liveSessionRetentionPlan(cutoff: string): { receipt_rows: number } {
    const receipt_rows=(this.db.prepare("SELECT count(*) AS count FROM live_session_query_receipts WHERE created_at<=?")
      .get(cutoff) as {count:number}).count;
    return {receipt_rows};
  }

  purgeLiveSessionReceipts(cutoff: string): { receipt_rows: number } {
    const plan=this.liveSessionRetentionPlan(cutoff);
    this.db.prepare("DELETE FROM live_session_query_receipts WHERE created_at<=?").run(cutoff);
    return plan;
  }

  beginJobDispatch(jobId: string, at = new Date()): JobRow {
    this.updateJob(jobId, ["preparing"], "dispatching", { dispatch_started_at: at.toISOString() });
    return this.getJobRequired(jobId);
  }

  markJobRunning(jobId: string, at = new Date()): void {
    this.updateJob(jobId, ["dispatching"], "running", {
      prompt_accepted_at: at.toISOString(),
      last_error_code: null,
      last_error_message: null,
    });
  }

  recordJobPreparationFailure(
    jobId: string,
    code: string,
    message: string,
    maxAttempts: number,
    at = new Date(),
  ): JobRow {
    const row = this.getJobRequired(jobId);
    if (row.status !== "preparing") throw new Error(`Job ${jobId} is not preparing`);
    const status: JobStatus = row.attempt_count >= maxAttempts ? "failed" : "retryable_failed";
    const availableAt = status === "failed" ? at.toISOString() : retryAt(row.attempt_count, at);
    this.updateJob(jobId, ["preparing"], status, {
      available_at: availableAt,
      last_error_code: code,
      last_error_message: message,
      ...(status === "failed" ? { completed_at: at.toISOString() } : {}),
    });
    return this.getJobRequired(jobId);
  }

  recordJobSafePromptFailure(
    jobId: string,
    code: string,
    message: string,
    maxAttempts: number,
    at = new Date(),
  ): JobRow {
    const row = this.getJobRequired(jobId);
    if (row.status !== "dispatching") throw new Error(`Job ${jobId} is not dispatching`);
    const status: JobStatus = row.attempt_count >= maxAttempts ? "failed" : "retryable_failed";
    const availableAt = status === "failed" ? at.toISOString() : retryAt(row.attempt_count, at);
    this.updateJob(jobId, ["dispatching"], status, {
      available_at: availableAt,
      last_error_code: code,
      last_error_message: message,
      ...(status === "failed" ? { completed_at: at.toISOString() } : {}),
    });
    return this.getJobRequired(jobId);
  }

  markJobNeedsReview(jobId: string, code: string, message: string): void {
    const row = this.getJobRequired(jobId);
    if (["completed", "failed", "cancelled"].includes(row.status)) return;
    this.updateJob(jobId, [row.status], "needs_review", {
      last_error_code: code,
      last_error_message: message,
      steer_state: null,
    });
  }

  markJobBlocked(jobId: string, message: string, from: JobStatus[] = ["running"]): void {
    this.updateJob(jobId, from, "blocked", {
      last_error_code: "agent_blocked",
      last_error_message: message,
    });
  }

  recordInvalidResultAgentStopFailure(jobId:string,message:string):void {
    this.db.prepare("UPDATE jobs SET last_error_code='invalid_result_agent_stop_unknown',last_error_message=?,updated_at=? WHERE job_id=? AND status='needs_review'").run(message,nowUtc(),jobId);
  }
  recordInvalidResultAgentStopped(jobId:string):void {
    this.db.prepare("UPDATE jobs SET last_error_code='invalid_result_agent_stopped',last_error_message='Invalid Result was fenced and the agent exit was observed',updated_at=? WHERE job_id=? AND status='needs_review'").run(nowUtc(),jobId);
  }

  reconcileScheduledRun(runId:string,outcome:"failed"|"cancelled",at=new Date()):unknown {
    const row=this.db.prepare("SELECT s.tenant_id,r.job_id FROM schedule_runs r JOIN schedules s USING(schedule_id) WHERE r.run_id=?").get(runId) as {tenant_id:string;job_id:string|null}|undefined;
    if(!row) throw new Error(`Run ${runId} was not found`);
    return this.db.transaction(()=>{
      const reconciledAt=new Date(Math.floor(at.getTime()/1000)*1000).toISOString().replace(".000Z","Z");
      if(row.job_id) {
        const job=this.getJobRequired(row.job_id);
        if(job.completion_event_id) {
          const completion=this.db.prepare("SELECT notification_state,notification_authorization_phase FROM job_completion_results WHERE notification_event_id=?").get(job.completion_event_id) as {notification_state:string;notification_authorization_phase:string}|undefined;
          if(completion?.notification_state==="pending"&&completion.notification_authorization_phase==="none") {
            const changed=this.db.prepare("UPDATE events SET status='completed',completed_at=?,updated_at=?,last_error_code='job_result_superseded',last_error_message=NULL WHERE event_id=? AND status IN ('queued','retryable_failed')").run(reconciledAt,reconciledAt,job.completion_event_id).changes;
            if(changed!==1) throw new Error("prior_notification_requires_reconciliation");
            this.db.prepare("UPDATE job_completion_results SET notification_state='none' WHERE notification_event_id=? AND notification_state='pending'").run(job.completion_event_id);
          } else if(completion&&! ["none","accepted"].includes(completion.notification_state)) throw new Error("prior_notification_requires_reconciliation");
          this.db.prepare("UPDATE jobs SET completion_event_id=NULL WHERE job_id=?").run(row.job_id);
        }
      }
      const result=this.scheduler.reconcileWorkRun(runId,outcome,{tenant_id:row.tenant_id,actor_id:"dispatcher-admin",role:"admin",source_event_id:null},reconciledAt);
      if(row.job_id) {
        this.db.prepare("UPDATE jobs SET status=?,completed_at=?,last_error_code=NULL,last_error_message=NULL,updated_at=? WHERE job_id=? AND status IN ('needs_review','blocked')")
          .run(outcome,reconciledAt,reconciledAt,row.job_id);
        this.db.prepare("UPDATE job_completion_results SET work_state=? WHERE job_id=? AND work_state='needs_review'").run(outcome,row.job_id);
      }
      return result;
    }).immediate();
  }

  saveJobResult(jobId: string, result: JobResultEnvelope, resultPath: string, at = new Date(), notificationHook: JobNotificationHook = () => {}): void {
    this.db.transaction(() => {
      const job=this.getJobRequired(jobId);
      this.assertJobCompletionBinding(job);
      if (result.job_id !== jobId) throw new Error("job_result_identity_mismatch");
      if (job.result_json === stableStringify(result) && job.status === result.status) return;
      const binding = readEventJobBinding(this.db,job.source_event_id);
      if (binding?.owner.kind === "schedule") {
        const serialized=stableStringify(result);
        validateWorkResultEnvelope(serialized);
        if(containsHostAbsolutePath(serialized)||serialized.includes(job.workspace_path)||serialized.includes(path.dirname(job.result_path))) throw new Error("scheduled_work_local_path_reported");
        const rendered=renderJobResult(result as unknown as Record<string,unknown>);
        validateWorkResultContent(rendered);
        if(containsHostAbsolutePath(rendered)||rendered.includes(job.workspace_path)||rendered.includes(path.dirname(job.result_path))) throw new Error("scheduled_work_local_path_reported");
        if((result.actions??[]).length!==0) throw new Error("scheduled_work_external_write_reported");
      }
      const status: JobStatus = result.status === "completed" ? "completed" : "failed";
      const completedAt = new Date(result.completed_at);
      if(binding?.owner.kind==="schedule"&&completedAt.getTime()>at.getTime()) throw new Error("completed_at_is_in_the_future");
      const acceptedDeadline=job.prompt_accepted_at??job.dispatch_started_at;
      if(binding?.owner.kind==="schedule"&&acceptedDeadline&&at.getTime()>Date.parse(acceptedDeadline)+3_600_000)
        throw new Error("scheduled_work_result_deadline_exceeded");
      const recoverAmbiguous=job.status==="needs_review"&&(["ambiguous_prompt_acceptance","prompt_acceptance_unknown","prompt_interrupted","cancel_acceptance_unknown","cancel_exit_unknown","ambiguous_cancel_acceptance","agent_wait_observation_unknown","invalid_result_agent_stopped"].includes(job.last_error_code??"")||
        (job.last_error_code==="legacy_agent_sandbox_unknown"&&this.isLegacySharedGrantAgentStopped(jobId)));
      if(binding?.owner.kind==="schedule"&&job.dispatch_started_at&&completedAt.getTime()<Date.parse(job.dispatch_started_at))
        throw new Error("completed_at_precedes_prompt_dispatch");
      this.db.transaction(()=>{
        const attentionEventId = this.getJobGroup(job.source_event_id)?.attention_event_id;
        if(recoverAmbiguous&&job.completion_event_id) {
          const priorEvent = this.getRequired(job.completion_event_id);
          if(binding?.owner.kind === "slack_thread" && !["queued", "retryable_failed", "completed"].includes(priorEvent.status)) {
            throw new Error("prior_notification_requires_reconciliation");
          }
          const prior=this.db.prepare("SELECT notification_state FROM job_completion_results WHERE notification_event_id=?").get(job.completion_event_id) as {notification_state:string}|undefined;
          if(prior&&prior.notification_state!=="pending") throw new Error("prior_notification_requires_reconciliation");
          this.db.prepare("UPDATE events SET status='completed',completed_at=?,updated_at=?,last_error_code='job_result_superseded',last_error_message=NULL WHERE event_id=? AND status IN ('queued','retryable_failed')").run(completedAt.toISOString(),completedAt.toISOString(),job.completion_event_id);
          if(binding?.owner.kind === "slack_thread" && ["queued", "retryable_failed"].includes(priorEvent.status)) {
            this.db.prepare("UPDATE job_groups SET attention_event_id=NULL WHERE source_event_id=? AND attention_event_id=?")
              .run(job.source_event_id, priorEvent.event_id);
          }
          this.db.prepare("UPDATE job_completion_results SET notification_state='none' WHERE notification_event_id=? AND notification_state='pending'").run(job.completion_event_id);
          this.db.prepare("UPDATE jobs SET completion_event_id=NULL WHERE job_id=?").run(jobId);
        }
        if(recoverAmbiguous&&binding?.owner.kind==="schedule") this.scheduler.recoverWorkRunForResult(binding.owner.run_id,jobId,job.source_event_id,new Date(Math.floor(at.getTime()/1000)*1000).toISOString().replace(".000Z","Z"));
        this.updateJob(jobId, recoverAmbiguous?["needs_review"]:["running","cancelling"], status, {
          result_json: stableStringify(result), result_path: resultPath, completed_at: completedAt.toISOString(),
          last_error_code: result.status === "failed" ? "agent_reported_failure" : null,
          last_error_message: result.status === "failed" ? result.summary : null,
        });
        if (recoverAmbiguous && attentionEventId && binding?.owner.kind === "slack_thread") {
          this.recordAttentionResolution(jobId, attentionEventId, status, "validated_result", null, at);
        }
        if(binding?.owner.kind==="schedule") this.materializeJobCompletion(jobId,at,notificationHook);
      }).immediate();
    }).immediate();
  }

  appendQueuedJobInstruction(jobId: string, sourceEventId: string, instruction: string): JobRow {
    return this.db.transaction(() => {
      this.assertJobSourceMatchesThread(jobId, sourceEventId);
      this.assertJobSteerAllowed(jobId);
      if (this.getRequired(sourceEventId).source !== "slack") throw new Error("Job control requires a Slack source event");
      const row = this.getJobRequired(jobId);
      if (row.steer_event_id === sourceEventId && row.steer_state === "accepted") return row;
      if (!["queued", "retryable_failed"].includes(row.status)) throw new Error(`Job ${jobId} is not waiting to start`);
      const addition = `\n\n[DONA_FOLLOW_UP]\n${instruction}\n[/DONA_FOLLOW_UP]`;
      const objective = row.objective + addition;
      if ([...objective].length > jobObjectiveCharacterMax) throw new Error("Effective job objective character limit exceeded");
      const siblings = this.db.prepare("SELECT objective FROM jobs WHERE source_event_id=?").all(row.source_event_id) as Array<{objective:string}>;
      const current = siblings.reduce((sum,job)=>sum+Buffer.byteLength(job.objective,"utf8"),0);
      const attempted = current + Buffer.byteLength(addition,"utf8");
      const maximum = this.jobAdmissionLimits.jobObjectiveTotalMaxBytes;
      if (attempted > maximum) throw new JobCreationError("job_group_limit_exceeded","Effective job group objective limit exceeded",{resource:"objective_utf8_bytes_per_event",current,attempted,maximum});
      this.db.prepare(`UPDATE jobs SET objective=?,steer_event_id=?,steer_state='accepted',updated_at=? WHERE job_id=?`)
        .run(objective,sourceEventId,nowUtc(),jobId);
      return this.getJobRequired(jobId);
    }).immediate();
  }

  beginJobSteer(jobId: string, sourceEventId: string): { row: JobRow; duplicate: boolean } {
    this.assertJobSourceMatchesThread(jobId, sourceEventId);
    this.assertJobSteerAllowed(jobId);
    if (this.getRequired(sourceEventId).source !== "slack") throw new Error("Job control requires a Slack source event");
    const row = this.getJobRequired(jobId);
    if (row.steer_event_id === sourceEventId && row.steer_state === "accepted") return { row, duplicate: true };
    if (row.status !== "running") throw new Error(`Job ${jobId} in status ${row.status} cannot be steered`);
    this.db.prepare(`
      UPDATE jobs SET steer_event_id = ?, steer_state = 'dispatching', updated_at = ? WHERE job_id = ?
    `).run(sourceEventId, nowUtc(), jobId);
    return { row: this.getJobRequired(jobId), duplicate: false };
  }

  markJobSteerAccepted(jobId: string, sourceEventId: string): void {
    const changed = this.db.prepare(`
      UPDATE jobs SET steer_state = 'accepted', updated_at = ?
      WHERE job_id = ? AND steer_event_id = ? AND steer_state = 'dispatching'
    `).run(nowUtc(), jobId, sourceEventId).changes;
    if (changed !== 1) throw new Error(`Job ${jobId} steer state changed unexpectedly`);
  }

  clearJobSteer(jobId: string, sourceEventId: string): void {
    this.db.prepare(`
      UPDATE jobs SET steer_event_id = NULL, steer_state = NULL, updated_at = ?
      WHERE job_id = ? AND steer_event_id = ? AND steer_state = 'dispatching'
    `).run(nowUtc(), jobId, sourceEventId);
  }

  beginJobCancellation(jobId: string, sourceEventId: string): JobRow {
    this.assertJobSourceMatchesThread(jobId, sourceEventId);
    const row = this.getJobRequired(jobId);
    if (row.status === "cancelled") return row;
    if(row.status==="needs_review"&&["cancel_acceptance_unknown","cancel_exit_unknown","ambiguous_cancel_acceptance"].includes(row.last_error_code??"")) {
      throw new Error("cancellation_requires_reconciliation");
    }
    if (!["queued", "retryable_failed", "preparing", "dispatching", "running", "blocked", "needs_review"].includes(row.status)) {
      throw new Error(`Job ${jobId} in status ${row.status} cannot be cancelled`);
    }
    this.db.transaction(()=>{
      if(readEventJobBinding(this.db, row.source_event_id)?.owner.kind === "slack_thread") {
        const group = this.getJobGroup(row.source_event_id);
        const eventIds = new Set([row.completion_event_id, group?.attention_event_id, group?.all_terminal_event_id]);
        for (const eventId of eventIds) {
          if (!eventId) continue;
          const previous = this.getRequired(eventId);
          if (["queued", "retryable_failed"].includes(previous.status)) {
            this.db.prepare("UPDATE events SET status='completed',completed_at=?,updated_at=?,last_error_code='job_result_superseded',last_error_message=NULL WHERE event_id=?")
              .run(nowUtc(),nowUtc(),previous.event_id);
            this.db.prepare(`UPDATE job_groups SET
              attention_event_id=CASE WHEN attention_event_id=? THEN NULL ELSE attention_event_id END,
              all_terminal_event_id=CASE WHEN all_terminal_event_id=? THEN NULL ELSE all_terminal_event_id END
              WHERE source_event_id=?`).run(previous.event_id,previous.event_id,row.source_event_id);
            this.db.prepare("UPDATE jobs SET completion_event_id=NULL WHERE source_event_id=? AND completion_event_id=?")
              .run(row.source_event_id, previous.event_id);
          } else if (previous.status !== "completed") {
            throw new Error("prior_notification_requires_reconciliation");
          }
        }
      } else if(row.completion_event_id) {
        const prior=this.db.prepare("SELECT notification_state,notification_authorization_phase FROM job_completion_results WHERE notification_event_id=?")
          .get(row.completion_event_id) as {notification_state:string;notification_authorization_phase:string}|undefined;
        if(prior?.notification_state==="pending"&&prior.notification_authorization_phase==="none") {
          const changed=this.db.prepare("UPDATE events SET status='completed',completed_at=?,updated_at=?,last_error_code='job_result_superseded',last_error_message=NULL WHERE event_id=? AND status IN ('queued','retryable_failed')")
            .run(nowUtc(),nowUtc(),row.completion_event_id).changes;
          if(changed!==1) throw new Error("prior_notification_requires_reconciliation");
          this.db.prepare("UPDATE job_completion_results SET notification_state='none' WHERE notification_event_id=? AND notification_state='pending'").run(row.completion_event_id);
        } else if(prior&&! ["none","accepted"].includes(prior.notification_state)) throw new Error("prior_notification_requires_reconciliation");
      }
      this.db.prepare("UPDATE job_groups SET all_terminal_event_id=NULL WHERE source_event_id=?")
        .run(row.source_event_id);
      this.updateJob(jobId, [row.status], "cancelling", { completion_event_id: null });
    }).immediate();
    return this.getJobRequired(jobId);
  }

  markJobCancelled(jobId: string, reason: string, at = new Date()): void {
    this.updateJob(jobId, ["cancelling"], "cancelled", {
      completed_at: at.toISOString(),
      last_error_code: "cancelled",
      last_error_message: reason,
    });
  }

  enqueueJobNotification(jobId: string, at = new Date(), notificationHook: JobNotificationHook = () => {}): EnqueueResult {
    return this.db.transaction(() => {
      const job = this.getJobRequired(jobId);
      this.assertJobSourceMatchesThread(jobId, job.source_event_id);
      const binding = readEventJobBinding(this.db, job.source_event_id)!;
      return binding.owner.kind === "schedule"
        ? this.materializeJobCompletion(jobId, at, notificationHook)
        : this.enqueueRegularJobNotification(jobId, at, notificationHook);
    }).immediate();
  }

  private enqueueRegularJobNotification(
    jobId: string,
    at = new Date(),
    notificationHook: JobNotificationHook = () => {},
  ): EnqueueResult {
    return this.db.transaction(() => {
      const job = this.getJobRequired(jobId);
      this.assertJobSourceMatchesThread(jobId, job.source_event_id);
      const timestamp = at.toISOString();
      let group = this.getJobGroupRequired(job.source_event_id);
      if (group.notification_mode === "grouped" && group.all_terminal_event_id) {
        const existing = this.getRequired(group.all_terminal_event_id);
        if (!job.completion_event_id) {
          this.db.prepare("UPDATE jobs SET completion_event_id=?,updated_at=? WHERE job_id=?")
            .run(existing.event_id, timestamp, jobId);
          notificationHook("job_linked");
        }
        return { row: existing, duplicate: true, payloadMismatch: false };
      }
      if (job.completion_event_id) {
        const existing = this.get(job.completion_event_id);
        if (!existing) throw new Error(`Job ${jobId} references a missing completion event`);
        const needsReplacementAttention = group.notification_mode === "grouped" &&
          group.attention_event_id === null && group.all_terminal_event_id === null &&
          jobAttentionStatuses.has(job.status) && !this.jobAttentionResolved(job);
        const needsAllTerminal = group.notification_mode === "grouped" &&
          group.attention_event_id !== null && group.all_terminal_event_id === null &&
          this.groupCanClaimAllTerminal(job.source_event_id, group);
        if (!needsAllTerminal && !needsReplacementAttention) return { row: existing, duplicate: true, payloadMismatch: false };
      }
      if (!jobNotificationStatuses.has(job.status)) {
        throw new Error(`Job ${jobId} in status ${job.status} does not need a notification`);
      }
      const isUnverifiedMigratedLegacyJob =
        job.job_key === legacyJobKey &&
        jobCreationPayloadSha256FromWorkspace(JSON.parse(job.workspace_json) as unknown) === undefined;
      const groupJobCount = this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE source_event_id = ?")
        .get(job.source_event_id) as { count: number };
      if (group.notification_mode === "grouped" && isUnverifiedMigratedLegacyJob && groupJobCount.count === 1) {
        const changed = this.db.prepare(`
          UPDATE job_groups SET notification_mode = 'legacy', updated_at = ?
          WHERE source_event_id = ? AND notification_mode = 'grouped'
            AND attention_event_id IS NULL AND all_terminal_event_id IS NULL
        `).run(timestamp, job.source_event_id).changes;
        if (changed !== 1) throw new Error(`Legacy job group ${job.source_event_id} could not be normalized`);
        group = this.getJobGroupRequired(job.source_event_id);
      }
      if (group.notification_mode === "grouped" && !group.sealed_at) {
        throw new Error(`Job group ${job.source_event_id} is not sealed`);
      }
      const sourceEvent = this.getRequired(job.source_event_id);
      const result = job.result_json ? JSON.parse(job.result_json) as Record<string, unknown> : null;
      const snapshot = group.notification_mode === "grouped"
        ? this.buildJobGroupSnapshot(job.source_event_id, group, job)
        : undefined;
      const legacyRecovery = snapshot?.transition === "all_terminal"
        ? this.getLegacyAttentionClaim(job.source_event_id) : undefined;
      const envelope: EventEnvelope = {
        schema_version: 1,
        source: "dona_job",
        external_event_id: `${job.job_id}:${job.status}${legacyRecovery
          ? `:legacy_recovery:${legacyRecovery.all_terminal_event_id}`
          : job.completion_event_id
            ? snapshot?.transition === "attention" ? ":attention_replacement" : ":all_terminal" : ""}`,
        type: `job_${job.status}`,
        occurred_at: timestamp,
        subject: {
          job_id: job.job_id,
          source_event_id: job.source_event_id,
          ...(job.workspace_id ? { workspace_id: job.workspace_id } : {}),
          ...(job.channel_id ? { channel_id: job.channel_id } : {}),
          ...(job.thread_ts ? { thread_ts: job.thread_ts } : {}),
          ...(job.actor_id ? { actor_id: job.actor_id } : {}),
        },
        payload: {
          job_id: job.job_id,
          job_key: job.job_key,
          job_status: job.status,
          workspace: parseJobWorkspace(JSON.parse(job.workspace_json)) as Record<string, unknown>,
          ...(snapshot ? { group: snapshot } : {}),
          ...(result ? { result } : {}),
          ...(job.last_error_code ? { error_code: job.last_error_code } : {}),
          ...(job.last_error_message ? { error_message: job.last_error_message } : {}),
        },
        reply_target: sourceEvent.reply_target_json
          ? JSON.parse(sourceEvent.reply_target_json) as Record<string, unknown>
          : null,
        trace: { job_id: job.job_id, source_event_id: job.source_event_id },
      };
      const enqueued = this.enqueue(envelope, at);
      if (enqueued.payloadMismatch) {
        throw new Error(`Job ${jobId} notification conflicts with an existing completion event`);
      }
      const binding = readEventJobBinding(this.db, job.source_event_id)!;
      insertEventJobBinding(this.db, enqueued.row.event_id, binding);
      notificationHook("event_enqueued");
      if (snapshot && snapshot.transition !== "progress") {
        if (snapshot.transition === "all_terminal" && !this.groupCanClaimAllTerminal(job.source_event_id, group)) {
          throw new Error("job_group_attention_unresolved");
        }
        const field = snapshot.transition === "attention" ? "attention_event_id" : "all_terminal_event_id";
        const claimed = this.db.prepare(`
          UPDATE job_groups SET ${field} = ?, updated_at = ?
          WHERE source_event_id = ? AND ${field} IS NULL
        `).run(enqueued.row.event_id, timestamp, job.source_event_id).changes;
        if (claimed !== 1) throw new Error(`Job group ${job.source_event_id} lost ${snapshot.transition} ownership`);
      }
      notificationHook("transition_claimed");
      if (!job.completion_event_id) {
        this.db.prepare("UPDATE jobs SET completion_event_id = ?, updated_at = ? WHERE job_id = ?")
          .run(enqueued.row.event_id, timestamp, jobId);
      }
      notificationHook("job_linked");
      return enqueued;
    }).immediate();
  }

  private materializeJobCompletion(jobId: string, at: Date, notificationHook: JobNotificationHook = () => {}): EnqueueResult {
    const job = this.getJobRequired(jobId);
    this.assertJobCompletionBinding(job);
    if (!jobNotificationStatuses.has(job.status)) throw new Error("job_not_ready_for_completion");
    if (job.completion_event_id) {
      const existing = this.get(job.completion_event_id);
      if (!existing) throw new Error(`Job ${jobId} references a missing completion event`);
      return { row: existing, duplicate: true, payloadMismatch: false };
    }
    const sourceEvent = this.getRequired(job.source_event_id);
    const binding=readEventJobBinding(this.db,job.source_event_id);
    if(!binding) throw new Error("Unknown completion owner");
    this.assertJobSourceMatchesThread(jobId,job.source_event_id);
    const prior=this.db.prepare("SELECT 1 FROM job_completion_results WHERE job_id=? AND job_status=?").get(jobId,job.status);
    if(prior) return {row:sourceEvent,duplicate:true,payloadMismatch:false};
    const result = job.result_json ? JSON.parse(job.result_json) as Record<string, unknown> : null;
    const workState=job.status==="completed"?"completed":job.status==="cancelled"?"cancelled":job.status==="needs_review"?"needs_review":"failed";
    const notificationState=binding.destination.kind==="none"?"none":"pending";
    const completedAt=binding.owner.kind==="schedule"?at.toISOString():job.completed_at??job.updated_at;
    this.db.prepare(`INSERT OR IGNORE INTO job_completion_results
      (job_id,job_status,source_event_id,owner_json,destination_json,work_state,notification_state,materialized_at,content_delete_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(job.job_id,job.status,job.source_event_id,stableStringify(binding.owner),
      stableStringify(binding.destination),workState,notificationState,completedAt,new Date(Date.parse(completedAt)+604_800_000).toISOString());
    if(binding.owner.kind==="schedule") {
      const scheduleAt=new Date(Math.floor(Date.parse(completedAt)/1_000)*1_000).toISOString().replace(".000Z","Z");
      const next=job.status==="completed"?"completed":job.status==="cancelled"?"cancelled":job.status==="needs_review"?"needs_review":"failed";
      if(next==="needs_review"||job.status==="blocked") {
        this.db.prepare("UPDATE job_completion_results SET work_state='needs_review' WHERE job_id=? AND job_status=?").run(job.job_id,job.status);
        this.scheduler.markWorkRunNeedsReview(binding.owner.run_id,job.job_id,scheduleAt,job.source_event_id);
      } else if(next==="cancelled"&&this.scheduler.getRun(binding.owner.run_id)?.status==="needs_review") {
        this.scheduler.reconcileWorkRun(binding.owner.run_id,"cancelled",
          {tenant_id:binding.owner.tenant_id,actor_id:"scheduler",role:"admin",source_event_id:job.source_event_id},scheduleAt);
      } else if(this.scheduler.getRun(binding.owner.run_id)?.status===next) {
        // Reconciliation may terminalize the run before completion notification materialization.
      } else try {
        this.scheduler.setRunState(binding.owner.run_id,"started",next,
          {tenant_id:binding.owner.tenant_id,actor_id:"scheduler",role:"admin",source_event_id:job.source_event_id},scheduleAt,job.job_id,
          next==="completed"?renderJobResult(result):null,scheduleAt,true);
      } catch(error) {
        if(!(error instanceof Error)||error.message!=="content_requires_redaction") throw error;
        this.db.prepare("UPDATE job_completion_results SET work_state='needs_review',notification_state='needs_review' WHERE job_id=? AND job_status=?").run(job.job_id,job.status);
        this.scheduler.markWorkRunNeedsReview(binding.owner.run_id,job.job_id,scheduleAt,job.source_event_id);
      }
    }
    if(binding.destination.kind==="none") return {row:sourceEvent,duplicate:true,payloadMismatch:false};
    const envelope: EventEnvelope = {
      schema_version: 1,
      source: "dona_job",
      external_event_id: `${job.job_id}:${job.status}`,
      type: `job_${job.status}`,
      occurred_at: at.toISOString(),
      subject: {
        job_id: job.job_id,
        source_event_id: job.source_event_id,
        ...(job.workspace_id ? { workspace_id: job.workspace_id } : {}),
        ...(job.channel_id ? { channel_id: job.channel_id } : {}),
        ...(job.thread_ts ? { thread_ts: job.thread_ts } : {}),
        ...(job.actor_id ? { actor_id: job.actor_id } : {}),
      },
      payload: {
        job_id: job.job_id,
        job_status: job.status,
        owner_kind: binding.owner.kind,
        ...(binding.owner.kind === "schedule" ? {} : { workspace: parseJobWorkspace(JSON.parse(job.workspace_json)) }),
        ...(result ? { result: binding.owner.kind==="schedule"
          ? {schema_version:result.schema_version,job_id:result.job_id,status:result.status,
              summary:projectWorkResultContent(renderJobResult(result)),completed_at:result.completed_at}
          : result } : {}),
        ...(binding.owner.kind==="schedule"?{notification_format:"plain_text"}:{}),
        ...(job.last_error_code ? { error_code: job.last_error_code } : {}),
        ...(job.last_error_message ? { error_message: this.safeNotificationError(job.last_error_message,binding.owner.kind==="schedule",job) } : {}),
      },
          reply_target: binding.destination.kind==="slack"?binding.destination.target:binding.destination,
      trace: { job_id: job.job_id, source_event_id: job.source_event_id },
    };
    const enqueued = this.enqueue(envelope, at);
    if (enqueued.payloadMismatch) throw new Error("job_notification_payload_mismatch");
    notificationHook("event_enqueued");
    notificationHook("transition_claimed");
    this.db.prepare("UPDATE jobs SET completion_event_id = ?, updated_at = ? WHERE job_id = ?")
      .run(enqueued.row.event_id, at.toISOString(), jobId);
    const notificationBodySha256=createHash("sha256").update(notificationText(envelope.payload as {result?:{summary?:unknown};error_message?:unknown;job_status?:unknown})).digest("hex");
    this.db.prepare(`UPDATE job_completion_results SET notification_event_id=?,notification_body_sha256=? WHERE job_id=? AND job_status=?`)
      .run(enqueued.row.event_id,notificationBodySha256,jobId,job.status);
    notificationHook("job_linked");
    return enqueued;
  }

  private assertJobCompletionBinding(job: JobRow): void {
    this.assertJobSourceMatchesThread(job.job_id, job.source_event_id);
    const binding = readEventJobBinding(this.db, job.source_event_id)!;
    const owner = this.db.prepare("SELECT source_event_id,destination_json FROM job_owner_bindings WHERE job_id=?")
      .get(job.job_id) as { source_event_id: string; destination_json: string };
    if (owner.source_event_id !== job.source_event_id || owner.destination_json !== stableStringify(binding.destination)) {
      throw new Error("job_completion_binding_mismatch");
    }
    if (binding.owner.kind === "schedule") {
      const run = this.db.prepare(`SELECT 1 FROM schedule_runs r JOIN schedules s USING(schedule_id)
        WHERE r.run_id=? AND r.schedule_id=? AND r.revision=? AND r.event_id=? AND r.job_id=?
          AND s.tenant_id=? AND s.owner_id=?`).get(binding.owner.run_id, binding.owner.schedule_id,
          binding.owner.revision, job.source_event_id, job.job_id, binding.owner.tenant_id, binding.owner.owner_id);
      if (!run) throw new Error("job_completion_run_mismatch");
    }
  }

  private safeNotificationError(message:string,scheduled:boolean,job?:JobRow):string {
    if(!scheduled) return message;
    if(containsHostAbsolutePath(message)||job&&(message.includes(job.workspace_path)||message.includes(path.dirname(job.result_path)))) return "実行エラーの詳細は安全上省略されました";
    try { return projectWorkResultContent(message); }
    catch { return "実行エラーの詳細は安全上省略されました"; }
  }

  private setNotificationState(eventId:string,state:"none"|"accepted"|"failed"|"needs_review",at:Date,expectedStates?:Array<"failed"|"needs_review">):void {
    const rows=this.db.prepare(`SELECT json_extract(c.owner_json,'$.run_id') AS run_id,c.materialized_at,r.created_at AS run_created_at,r.started_at,r.terminal_at,s.updated_at AS schedule_updated_at
      FROM job_completion_results c JOIN schedule_runs r ON r.run_id=json_extract(c.owner_json,'$.run_id') JOIN schedules s USING(schedule_id)
      WHERE c.notification_event_id=? AND json_extract(c.owner_json,'$.kind')='schedule'`).all(eventId) as Array<{run_id:string;materialized_at:string;run_created_at:string;started_at:string|null;terminal_at:string|null;schedule_updated_at:string}>;
    const requested=new Date(Math.floor(at.getTime()/1000)*1000).toISOString().replace(".000Z","Z");
    if(state==="failed"||state==="needs_review") for(const row of rows) this.scheduler.markWorkNotificationNeedsReview(row.run_id,[requested,row.materialized_at,row.run_created_at,row.started_at,row.terminal_at,row.schedule_updated_at].filter((value):value is string=>value!==null).sort().at(-1)!);
    const updated=expectedStates
      ?this.db.prepare(`UPDATE job_completion_results SET notification_state=? WHERE notification_event_id=? AND notification_state IN (${expectedStates.map(()=>"?").join(",")})`).run(state,eventId,...expectedStates).changes
      :this.db.prepare("UPDATE job_completion_results SET notification_state=? WHERE notification_event_id=?").run(state,eventId).changes;
    if(expectedStates&&updated!==1)throw new Error("scheduled_notification_not_reconcilable");
    if(state==="accepted") for(const row of rows) this.scheduler.settleWorkNotification(row.run_id,[requested,row.materialized_at,row.run_created_at,row.started_at,row.terminal_at,row.schedule_updated_at].filter((value):value is string=>value!==null).sort().at(-1)!);
  }

  assertJobSourceMatchesThread(jobId: string, sourceEventId: string): void {
    const binding=readEventJobBinding(this.db,sourceEventId);
    const owner=this.db.prepare("SELECT owner_json FROM job_owner_bindings WHERE job_id=?").get(jobId) as {owner_json:string}|undefined;
    const completion=this.db.prepare("SELECT owner_json FROM job_completion_results WHERE notification_event_id=?").get(sourceEventId) as {owner_json:string}|undefined;
    if(!owner||(!binding&&completion?.owner_json!==owner.owner_json)||(binding&&stableStringify(binding.owner)!==owner.owner_json))
      throw new Error(`Event ${sourceEventId} does not belong to job ${jobId}'s owner`);
  }

  private assertJobSteerAllowed(jobId:string):void {
    const row=this.db.prepare("SELECT owner_json FROM job_owner_bindings WHERE job_id=?").get(jobId) as {owner_json:string}|undefined;
    if(row&&(JSON.parse(row.owner_json) as {kind?:unknown}).kind==="schedule") throw new Error("Scheduled jobs cannot be steered");
  }

  hasBlockedEvent(at=new Date()): boolean {
    this.suppressUnauthorizedScheduledNotifications(at);
    return this.db.prepare("SELECT 1 FROM events WHERE status = 'blocked' LIMIT 1").get() !== undefined;
  }

  nextWaiting(): EventRow | undefined {
    this.suppressUnauthorizedScheduledNotifications(new Date());
    return this.db
      .prepare("SELECT * FROM events WHERE status = 'waiting_agent' ORDER BY sequence LIMIT 1")
      .get() as EventRow | undefined;
  }

  nextAvailable(at = new Date()): EventRow | undefined {
    this.suppressUnauthorizedScheduledNotifications(at);
    const head = this.db
      .prepare(`
        SELECT * FROM events
        WHERE status IN ('queued', 'retryable_failed') AND source NOT IN ('dona_update', 'scheduler')
        ORDER BY sequence LIMIT 1
      `)
      .get() as EventRow | undefined;
    return head && head.available_at <= at.toISOString() ? head : undefined;
  }

  private suppressUnauthorizedScheduledNotifications(at: Date): void {
    const timestamp=at.toISOString();
    this.db.transaction(()=>{
      const rows=this.db.prepare(`SELECT e.event_id,e.status,c.notification_state,c.notification_authorization_phase,json_extract(c.owner_json,'$.schedule_id') AS schedule_id FROM events e JOIN job_completion_results c ON c.notification_event_id=e.event_id
        JOIN schedules s ON s.schedule_id=json_extract(c.owner_json,'$.schedule_id')
        JOIN schedule_revisions r ON r.schedule_id=s.schedule_id AND r.revision=json_extract(c.owner_json,'$.revision')
        WHERE e.source='dona_job' AND e.status IN ('queued','retryable_failed','dispatching','waiting_agent','blocked') AND json_extract(c.owner_json,'$.kind')='schedule'
          AND (julianday(c.materialized_at,'+900 seconds')<julianday(?) OR s.state NOT IN ('active','needs_review')
            OR s.revision!=json_extract(c.owner_json,'$.revision') OR julianday(r.expires_at)<=julianday(?))`)
        .all(timestamp,timestamp) as Array<{event_id:string;status:string;notification_state:string;notification_authorization_phase:string;schedule_id:string}>;
      for(const row of rows) {
        if(["dispatching","waiting_agent"].includes(row.status)||(row.status==="blocked"&&row.notification_authorization_phase==="write")||(row.notification_state==="needs_review"&&row.notification_authorization_phase==="write")) {
          this.db.prepare("UPDATE events SET status='needs_review',updated_at=?,last_error_code='notification_delivery_ambiguous',last_error_message=NULL WHERE event_id=? AND status IN ('queued','retryable_failed','dispatching','waiting_agent','blocked')").run(timestamp,row.event_id);
          this.setNotificationState(row.event_id,"needs_review",at);
          continue;
        }
        this.db.prepare(`UPDATE events SET status='completed',completed_at=?,updated_at=?,last_error_code='schedule_notification_suppressed',
          last_error_message=NULL WHERE event_id=? AND status IN ('queued','retryable_failed','dispatching','waiting_agent','blocked')`).run(timestamp,timestamp,row.event_id);
        this.setNotificationState(row.event_id,"none",at);
        this.scheduler.completeIfDrained(row.schedule_id,timestamp);
      }
    }).immediate();
  }

  authorizeJobNotification(eventId:string,at=new Date(),receipt?:{workspace_id:string;channel_id:string;user_id:string;issued_at:string;nonce:string;channel_kind?:string;channel_user_id?:string|null}):Record<string,unknown> {
    this.suppressUnauthorizedScheduledNotifications(at);
    return this.db.transaction(()=>{
      const timestamp=at.toISOString();
      const row=this.db.prepare(`SELECT e.status,c.owner_json,c.destination_json,c.notification_authorization_phase,c.notification_preflight_authorized_at FROM events e
        JOIN job_completion_results c ON c.notification_event_id=e.event_id
        JOIN schedules s ON s.schedule_id=json_extract(c.owner_json,'$.schedule_id')
        JOIN schedule_revisions r ON r.schedule_id=s.schedule_id AND r.revision=json_extract(c.owner_json,'$.revision')
        WHERE e.event_id=? AND e.source='dona_job' AND e.status IN ('dispatching','waiting_agent')
          AND ((c.notification_state='pending' AND c.notification_authorization_phase='none') OR
            (c.notification_state='needs_review' AND c.notification_authorization_phase='preflight')) AND json_extract(c.owner_json,'$.kind')='schedule'
          AND julianday(c.materialized_at,'+900 seconds')>=julianday(?) AND s.state IN ('active','needs_review')
          AND s.revision=json_extract(c.owner_json,'$.revision') AND julianday(r.expires_at)>julianday(?)`).get(eventId,timestamp,timestamp) as
        {status:string;owner_json:string;destination_json:string;notification_authorization_phase:string;notification_preflight_authorized_at:string|null}|undefined;
      if(!row) throw new Error("schedule_notification_not_authorized");
      const owner=JSON.parse(row.owner_json) as {owner_id:string;schedule_id:string;revision:number},destination=JSON.parse(row.destination_json) as {kind?:string;target?:{kind?:string;workspace_id?:string;channel_id?:string}};
      if(row.notification_authorization_phase==="none"&&receipt) throw new Error("schedule_notification_receipt_unexpected");
      const receiptIssuedAt=Date.parse(receipt?.issued_at??"");
      if(row.notification_authorization_phase==="preflight"&&(!receipt||!receipt.nonce||!Number.isFinite(receiptIssuedAt)||destination.kind!=="slack"||receipt.workspace_id!==destination.target?.workspace_id||receipt.channel_id!==destination.target.channel_id||receipt.user_id!==owner.owner_id||row.notification_preflight_authorized_at===null||receiptIssuedAt<Date.parse(row.notification_preflight_authorized_at)||Math.abs(at.getTime()-receiptIssuedAt)>120_000)) throw new Error("schedule_notification_access_receipt_invalid");
      if(row.notification_authorization_phase==="preflight"&&destination.target?.kind==="owner_dm"&&(receipt?.channel_kind!=="im"||receipt.channel_user_id!==owner.owner_id)) throw new Error("schedule_notification_access_receipt_invalid");
      if(row.notification_authorization_phase==="preflight"&&this.db.prepare("INSERT OR IGNORE INTO schedule_access_receipt_nonces(nonce,event_id,consumed_at) VALUES(?,?,?)").run(receipt!.nonce,eventId,timestamp).changes!==1)
        throw new Error("schedule_notification_access_receipt_already_consumed");
      if(row.status==="dispatching") this.markWaiting(eventId,at);
      const nextPhase=row.notification_authorization_phase==="none"?"preflight":"write";
      this.db.prepare("UPDATE job_completion_results SET notification_state='needs_review',notification_authorization_phase=?,notification_preflight_authorized_at=?,notification_write_authorized_at=? WHERE notification_event_id=?")
        .run(nextPhase,nextPhase==="preflight"?timestamp:row.notification_preflight_authorized_at,nextPhase==="write"?timestamp:null,eventId);
      return {authorized:true,event_id:eventId,owner_id:owner.owner_id,schedule_id:owner.schedule_id,revision:owner.revision,
        access_receipt_verified:nextPhase==="write",destination:JSON.parse(row.destination_json) as Record<string,unknown>};
    }).immediate();
  }

  recordScheduleJobAccess(eventId:string,receipt:{workspace_id:string;channel_id:string;user_id:string;issued_at:string;nonce:string},at=new Date()):Record<string,unknown> {
    return this.db.transaction(()=>{
      const event=this.getRequired(eventId),binding=readEventJobBinding(this.db,eventId);
      const payload=JSON.parse(event.payload_json) as {work?:{authorization_target?:{workspace_id?:unknown;channel_id?:unknown}}};
      const target=payload.work?.authorization_target;
      const receiptIssuedAt=Date.parse(receipt.issued_at);
      if(event.source!=="dona_schedule"||!["dispatching","waiting_agent"].includes(event.status)||binding?.owner.kind!=="schedule"||!receipt.nonce||!Number.isFinite(receiptIssuedAt)||receipt.user_id!==binding.owner.owner_id||
        receipt.workspace_id!==target?.workspace_id||receipt.channel_id!==target.channel_id||event.schedule_access_consumed_at!==null||Math.abs(at.getTime()-receiptIssuedAt)>120_000) throw new Error("schedule_access_receipt_mismatch");
      if(event.status==="dispatching") this.markWaiting(eventId,at);
      const nonce=this.db.prepare("INSERT OR IGNORE INTO schedule_access_receipt_nonces(nonce,event_id,consumed_at) VALUES(?,?,?)")
        .run(receipt.nonce,eventId,at.toISOString()).changes;
      if(nonce!==1) throw new Error("schedule_access_receipt_already_consumed");
      const changed=this.db.prepare("UPDATE events SET schedule_access_checked_at=? WHERE event_id=? AND schedule_access_checked_at IS NULL").run(receipt.issued_at,eventId).changes;
      if(changed!==1) throw new Error("schedule_access_receipt_already_recorded");
      return {authorized:true,event_id:eventId,checked_at:at.toISOString()};
    }).immediate();
  }

  updateEventsNeedingNotification(): EventRow[] {
    return this.db.prepare(`
      SELECT * FROM events
      WHERE source = 'dona_update' AND status IN ('queued', 'retryable_failed')
      ORDER BY sequence
    `).all() as EventRow[];
  }

  saveDeterministicCompleted(eventId: string, result: ResultEnvelope, resultPath: string): void {
    const row = this.getRequired(eventId);
    if (row.status === "completed") return;
    this.transition(eventId, ["queued", "retryable_failed"], "completed", {
      result_json: stableStringify(result),
      result_path: resultPath,
      completed_at: result.completed_at,
      last_error_code: null,
      last_error_message: null,
    });
  }

  saveDeterministicFailure(eventId: string, result: ResultEnvelope, resultPath: string, code: string): void {
    const row = this.getRequired(eventId);
    if (["needs_review", "completed"].includes(row.status)) return;
    this.transition(eventId, ["queued", "retryable_failed"], "needs_review", {
      result_json: stableStringify(result),
      result_path: resultPath,
      completed_at: result.completed_at,
      last_error_code: code,
      last_error_message: result.summary ?? "Update notification requires review",
    });
  }

  recoverStaleDispatching(at = new Date()): number {
    return this.db.transaction(() => {
      this.db.prepare(`UPDATE job_groups SET sealed_at=?,updated_at=? WHERE sealed_at IS NULL
        AND source_event_id IN (SELECT event_id FROM events WHERE status='dispatching')`).run(at.toISOString(),at.toISOString());
      const scheduled=(this.db.prepare("SELECT event_id FROM events WHERE status='dispatching' AND source='dona_schedule'").all() as Array<{event_id:string}>);
      const notifications=(this.db.prepare(`SELECT e.event_id,c.owner_json FROM events e JOIN job_completion_results c
        ON c.notification_event_id=e.event_id WHERE e.status='dispatching' AND e.source='dona_job'`).all() as Array<{event_id:string;owner_json:string}>);
      const changed=this.db.prepare(`
        UPDATE events SET
          status = 'needs_review',
          last_error_code = 'stale_dispatching',
          last_error_message = 'Dispatcher restarted while prompt acceptance was unknown',
          updated_at = ?
        WHERE status = 'dispatching'
      `).run(at.toISOString()).changes;
      const timestamp=new Date(Math.floor(at.getTime()/1000)*1000).toISOString().replace(".000Z","Z");
      for(const row of scheduled) this.scheduler.settleUndelegatedWorkEvent(row.event_id,"needs_review",timestamp);
      for(const row of notifications) {
        this.setNotificationState(row.event_id,"needs_review",at);
      }
      return changed;
    }).immediate();
  }

  beginDispatch(eventId: string, resultPath: string, at = new Date()): EventRow {
    this.suppressUnauthorizedScheduledNotifications(at);
    const before=this.getRequired(eventId);
    if(before.source==="dona_schedule"&&before.result_path&&path.basename(before.result_path)===`${eventId}.json.routing-migration-backup`) {
      try { fs.unlinkSync(before.result_path); } catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
    }
    const timestamp = at.toISOString();
    const changed = this.db
      .prepare(`
        UPDATE events SET
          status = 'dispatching', attempt_count = attempt_count + 1,
          dispatch_started_at = ?, prompt_accepted_at = NULL,
          result_path = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ?
        WHERE event_id = ? AND status IN ('queued', 'retryable_failed')
      `)
      .run(timestamp, resultPath, timestamp, eventId).changes;
    if (changed !== 1) {
      const current=this.get(eventId);
      if(current?.status==="completed"&&["schedule_suppressed","schedule_notification_suppressed"].includes(current.last_error_code??"")) return current;
      throw new Error(`Event ${eventId} is no longer dispatchable`);
    }
    return this.get(eventId)!;
  }

  markWaiting(eventId: string, at = new Date()): void {
    this.transition(eventId, ["dispatching"], "waiting_agent", {
      prompt_accepted_at: at.toISOString(),
      last_error_code: null,
      last_error_message: null,
    });
  }

  markBlocked(eventId: string, message: string, from: EventStatus[] = ["queued", "retryable_failed", "dispatching", "waiting_agent"], at = new Date()): void {
    this.db.transaction(()=>{
      const scheduled=this.getRequired(eventId).source==="dona_schedule";
      this.transition(eventId, from, scheduled ? "needs_review" : "blocked", {last_error_code: "agent_blocked",last_error_message: message});
      this.scheduler.settleUndelegatedWorkEvent(eventId,"needs_review",new Date(Math.floor(at.getTime()/1000)*1000).toISOString().replace(".000Z","Z"));
      this.setNotificationState(eventId,"needs_review",at);
    }).immediate();
  }

  markNeedsReview(eventId: string, code: string, message: string): void {
    this.db.transaction(()=>{
      this.transition(eventId, ["dispatching", "waiting_agent"], "needs_review", {last_error_code: code,last_error_message: message});
      this.scheduler.settleUndelegatedWorkEvent(eventId,"needs_review",new Date().toISOString().replace(/\.\d{3}Z$/,"Z"));
      this.setNotificationState(eventId,"needs_review",new Date());
    }).immediate();
  }

  recordPreDispatchFailure(eventId: string, code: string, message: string, maxAttempts: number, at = new Date()): EventRow {
    return this.db.transaction(() => {
      const row = this.get(eventId);
      if (!row || !["queued", "retryable_failed"].includes(row.status)) {
        throw new Error(`Event ${eventId} is no longer dispatchable`);
      }
      const attemptCount = row.attempt_count + 1;
      const status: EventStatus = attemptCount >= maxAttempts ? "dead_letter" : "retryable_failed";
      const availableAt = status === "dead_letter" ? at.toISOString() : retryAt(attemptCount, at);
      this.db
        .prepare(`
          UPDATE events SET status = ?, attempt_count = ?, available_at = ?,
            last_error_code = ?, last_error_message = ?, updated_at = ?
          WHERE event_id = ?
        `)
        .run(status, attemptCount, availableAt, code, message, at.toISOString(), eventId);
      if(status==="dead_letter") {
        this.sealJobGroupIfPresent(eventId, at.toISOString());
        this.scheduler.settleUndelegatedWorkEvent(eventId,"failed",new Date(Math.floor(at.getTime()/1000)*1000).toISOString().replace(".000Z","Z"));
        this.setNotificationState(eventId,"failed",at);
      }
      return this.get(eventId)!;
    })();
  }

  recordSafePromptFailure(eventId: string, code: string, message: string, maxAttempts: number, at = new Date()): EventRow {
    return this.db.transaction(() => {
      const row = this.get(eventId);
      if (!row || row.status !== "dispatching") throw new Error(`Event ${eventId} is not dispatching`);
      const status: EventStatus = row.attempt_count >= maxAttempts ? "dead_letter" : "retryable_failed";
      const availableAt = status === "dead_letter" ? at.toISOString() : retryAt(row.attempt_count, at);
      this.db
        .prepare(`
          UPDATE events SET status = ?, available_at = ?, last_error_code = ?,
            last_error_message = ?, updated_at = ? WHERE event_id = ?
        `)
        .run(status, availableAt, code, message, at.toISOString(), eventId);
      if(status==="dead_letter") {
        this.sealJobGroupIfPresent(eventId, at.toISOString());
        this.scheduler.settleUndelegatedWorkEvent(eventId,"failed",new Date(Math.floor(at.getTime()/1000)*1000).toISOString().replace(".000Z","Z"));
        this.setNotificationState(eventId,"failed",at);
      }
      this.sealJobGroupIfPresent(eventId, at.toISOString());
      return this.get(eventId)!;
    })();
  }

  recordWaitingError(eventId: string, code: string, message: string, at = new Date()): void {
    this.db
      .prepare(`
        UPDATE events SET last_error_code = ?, last_error_message = ?, updated_at = ?
        WHERE event_id = ? AND status = 'waiting_agent'
      `)
      .run(code, message, at.toISOString(), eventId);
  }

  notificationVerificationRequest(eventId:string,result:ResultEnvelope):JobNotificationVerificationRequest|undefined {
    const completion=this.db.prepare("SELECT job_status,owner_json,destination_json FROM job_completion_results WHERE notification_event_id=?").get(eventId) as {job_status:string;owner_json:string;destination_json:string}|undefined;
    if(!completion)return undefined;
    const owner=JSON.parse(completion.owner_json) as {owner_id?:unknown;run_id?:string}; if(!owner.run_id)return undefined;
    const destination=JSON.parse(completion.destination_json) as {kind?:unknown;target?:Record<string,unknown>},target=destination.kind==="slack"?destination.target:undefined;
    const payload=JSON.parse(this.getRequired(eventId).payload_json) as {result?:{summary?:unknown};error_message?:unknown;job_status?:unknown};
    const text=notificationText(payload);
    const post=(result.actions??[]).find(action=>action&&typeof action==="object"&&!Array.isArray(action)&&(action as Record<string,unknown>).tool==="dona_slack.post_message") as Record<string,unknown>|undefined;
    if(!target||!post||typeof post.message_ts!=="string")return undefined;
    return {schema_version:1,event_id:eventId,workspace_id:String(target.workspace_id??""),channel_id:String(target.channel_id??""),thread_ts:target.kind==="thread"?String(target.thread_ts??""):null,message_ts:post.message_ts,body_sha256:createHash("sha256").update(text).digest("hex"),
      desired_session_status:target.kind==="thread"?(["blocked","needs_review"].includes(completion.job_status)?"suspended":completion.job_status==="failed"?((result.actions??[]).some(action=>action&&typeof action==="object"&&!Array.isArray(action)&&(action as Record<string,unknown>).status==="suspended")?"suspended":"active"):"active"):null};
  }

  notificationReconciliationVerificationRequest(eventId:string,post:{workspace_id:string;channel_id:string;message_ts:string;thread_ts?:string}):JobNotificationVerificationRequest|undefined {
    const stored=this.getRequired(eventId).result_json;
    const prior:ResultEnvelope=stored?JSON.parse(stored) as ResultEnvelope:{schema_version:1,event_id:eventId,status:"completed",summary:"reconciliation",actions:[],completed_at:new Date().toISOString()};
    const actions=(prior.actions??[]).filter(action=>!action||typeof action!=="object"||Array.isArray(action)||(action as Record<string,unknown>).tool!=="dona_slack.post_message");
    const request=this.notificationVerificationRequest(eventId,{...prior,actions:[...actions,{tool:"dona_slack.post_message",workspace:"operator",workspace_id:post.workspace_id,channel_id:post.channel_id,message_ts:post.message_ts,...(post.thread_ts?{thread_ts:post.thread_ts,reply_broadcast:false}:{}),mrkdwn:false,parse:"none"}]});
    const completion=this.db.prepare("SELECT notification_body_sha256 FROM job_completion_results WHERE notification_event_id=?").get(eventId) as {notification_body_sha256:string|null}|undefined;
    return request&&completion?.notification_body_sha256?{...request,body_sha256:completion.notification_body_sha256}:request;
  }

  notificationSessionSettlementRequest(eventId:string):{schema_version:1;event_id:string;workspace_id:string;channel_id:string;thread_ts:string;desired_session_status:"active"|"suspended"}|undefined {
    const completion=this.db.prepare("SELECT job_status,destination_json FROM job_completion_results WHERE notification_event_id=?").get(eventId) as {job_status:string;destination_json:string}|undefined;
    if(!completion)return undefined;
    const destination=JSON.parse(completion.destination_json) as {kind?:unknown;target?:Record<string,unknown>},target=destination.kind==="slack"?destination.target:undefined;
    if(target?.kind!=="thread")return undefined;
    return {schema_version:1,event_id:eventId,workspace_id:String(target.workspace_id??""),channel_id:String(target.channel_id??""),thread_ts:String(target.thread_ts??""),desired_session_status:["blocked","needs_review"].includes(completion.job_status)?"suspended":"active"};
  }

  claimNotificationReconciliation(eventId:string,resume=false):string {
    const current=this.getRequired(eventId);
    if(current.last_error_code==="operator_notification_reconcile_claimed") {
      if(resume&&current.last_error_message)return current.last_error_message;
      throw new Error("scheduled_notification_reconcile_requires_explicit_resume");
    }
    const token=ulid().toLowerCase();
    const changed=this.db.prepare(`UPDATE events SET last_error_code='operator_notification_reconcile_claimed',last_error_message=? WHERE event_id=?
      AND COALESCE(last_error_code,'')!='operator_notification_reconcile_claimed' AND EXISTS (SELECT 1 FROM job_completion_results c WHERE c.notification_event_id=events.event_id AND c.notification_state IN ('failed','needs_review'))`).run(token,eventId).changes;
    if(changed!==1)throw new Error("scheduled_notification_not_reconcilable");
    return token;
  }
  private assertNotificationReconciliationClaim(eventId:string,token?:string):void {
    const row=this.getRequired(eventId);
    if(row.last_error_code==="operator_notification_reconcile_claimed"&&row.last_error_message!==token)throw new Error("scheduled_notification_reconcile_claim_conflict");
  }

  private notificationDelivered(eventId:string,result:ResultEnvelope,acceptedAt:Date,evidence?:JobNotificationEvidence):{delivered:boolean;runId?:string} {
    const completion=this.db.prepare("SELECT job_status,owner_json,destination_json,notification_state,notification_authorization_phase,notification_write_authorized_at,notification_body_sha256,materialized_at FROM job_completion_results WHERE notification_event_id=?").get(eventId) as {job_status:string;owner_json:string;destination_json:string;notification_state:string;notification_authorization_phase:string;notification_write_authorized_at:string|null;notification_body_sha256:string|null;materialized_at:string}|undefined;
    if(!completion)return {delivered:false};
    const event=this.getRequired(eventId);
    const payload=JSON.parse(event.payload_json) as {result?:{summary?:unknown};error_message?:unknown;job_status?:unknown};
    const expectedBody=notificationText(payload);
    const expectedBodySha256=completion.notification_body_sha256??createHash("sha256").update(expectedBody).digest("hex");
    const destination=JSON.parse(completion.destination_json) as {kind?:unknown;target?:Record<string,unknown>},target=destination.kind==="slack"?destination.target:undefined;
    const owner=JSON.parse(completion.owner_json) as {owner_id?:unknown;run_id?:string};
    const actions=(result.actions??[]).flatMap((action,index)=>action&&typeof action==="object"&&!Array.isArray(action)?[{index,value:action as Record<string,unknown>}]:[]);
    const posts=actions.filter(({value})=>typeof value.tool==="string"&&value.tool.endsWith(".post_message"));
    const ambiguousPost=posts.some(({value})=>value.ambiguous===true);
    const authorized=actions.find(({value})=>value.tool==="dona_dispatcher.authorize_job_notification"&&value.authorized===true&&value.event_id===eventId);
    const access=actions.find(({index,value})=>index>(authorized?.index??Number.MAX_SAFE_INTEGER)&&value.tool==="dona_slack.check_user_channel_access"&&value.authorized===true&&value.workspace_id===target?.workspace_id&&value.channel_id===target?.channel_id&&value.user_id===owner.owner_id);
    const reauthorized=actions.find(({index,value})=>index>(access?.index??Number.MAX_SAFE_INTEGER)&&value.tool==="dona_dispatcher.authorize_job_notification"&&value.authorized===true&&value.access_receipt_verified===true&&value.event_id===eventId);
    const allowedActions=actions.every(({value})=>{
      if(value.tool==="dona_dispatcher.authorize_job_notification") return value.event_id===eventId&&value.authorized===true&&value.success!==false&&value.ok!==false&&!("error" in value);
      if(value.tool==="dona_slack.check_user_channel_access") return value.authorized===true&&value.workspace_id===target?.workspace_id&&value.channel_id===target?.channel_id&&value.user_id===owner.owner_id;
      if(value.tool==="dona_slack.post_message") return true;
      return target?.kind==="thread"&&value.tool==="dona_slack.set_agent_session_status"&&value.workspace===access?.value.workspace&&value.channel_id===target.channel_id&&
        value.thread_ts===target.thread_ts&&
        (["blocked","needs_review"].includes(completion.job_status)?["processing","suspended"]:completion.job_status==="failed"?["processing","active","suspended"]:["processing","active"]).includes(String(value.status));
    });
    const validPost=posts.find(({index,value})=>index===(reauthorized?.index??Number.MAX_SAFE_INTEGER)+1&&value.tool==="dona_slack.post_message"&&value.body_sha256===expectedBodySha256&&value.mrkdwn===false&&value.parse==="none"&&typeof value.workspace==="string"&&value.workspace===access?.value.workspace&&typeof value.message_ts==="string"&&/^\d{1,20}\.\d{6}$/.test(value.message_ts)&&value.success!==false&&value.ok!==false&&value.ambiguous!==true&&!("error" in value)&&value.channel_id===target?.channel_id&&(target?.kind==="thread"?(value.thread_ts===target.thread_ts&&value.reply_broadcast===false):value.thread_ts===undefined));
    const postedAt=Date.parse(evidence?.posted_at??"");
    const receiptValid=evidence?.event_id===eventId&&evidence.workspace_id===target?.workspace_id&&evidence.channel_id===target?.channel_id&&evidence.thread_ts===(target?.kind==="thread"?target.thread_ts:null)&&
      evidence.message_ts===validPost?.value.message_ts&&evidence.body_sha256===expectedBodySha256&&evidence.reply_broadcast===false&&evidence.identity_block_verified===true&&Number.isFinite(postedAt);
    const withinDeadline=receiptValid&&postedAt<=Date.parse(completion.materialized_at)+900_000;
    const authorization=this.db.prepare(`SELECT r.expires_at FROM schedule_runs run
      JOIN schedule_revisions r ON r.schedule_id=run.schedule_id AND r.revision=run.revision WHERE run.run_id=?`)
      .get(owner.run_id??"") as {expires_at:string}|undefined;
    const withinAuthorizationExpiry=receiptValid&&authorization!==undefined&&postedAt<Date.parse(authorization.expires_at);
    const withinWriteAuthorization=receiptValid&&completion.notification_write_authorized_at!==null&&postedAt>=Date.parse(completion.notification_write_authorized_at)-5_000&&postedAt<=Date.parse(completion.notification_write_authorized_at)+120_000;
    return {delivered:receiptValid&&withinDeadline&&withinAuthorizationExpiry&&withinWriteAuthorization&&allowedActions&&posts.length===1&&!ambiguousPost&&completion.notification_state==="needs_review"&&completion.notification_authorization_phase==="write"&&validPost!==undefined,...(owner.run_id?{runId:owner.run_id}:{})};
  }

  jobNotificationState(jobId:string):Record<string,unknown> {
    const row=this.db.prepare(`SELECT c.notification_state,c.notification_authorization_phase
      FROM jobs j JOIN job_completion_results c ON c.notification_event_id=j.completion_event_id
      WHERE j.job_id=? AND json_extract(c.owner_json,'$.kind')='schedule'`).get(jobId);
    return row ? row as Record<string,unknown> : {};
  }

  isNotificationAccepted(eventId:string):boolean { return this.db.prepare("SELECT 1 FROM job_completion_results WHERE notification_event_id=? AND notification_state='accepted'").get(eventId)!==undefined; }
  markNotificationSessionNeedsReview(eventId:string,at=new Date()):void { this.db.transaction(()=>this.setNotificationState(eventId,"needs_review",at))(); }

  saveCompleted(eventId: string, result: ResultEnvelope, resultPath: string, acceptedAt=new Date(),evidence?:JobNotificationEvidence): void {
    if(Date.parse(result.completed_at)>acceptedAt.getTime()) throw new Error("completed_at_is_in_the_future");
    this.db.transaction(()=>{
      const event=this.getRequired(eventId);
      if(event.status==="completed"&&["schedule_suppressed","schedule_notification_suppressed","job_result_superseded"].includes(event.last_error_code??"")) return;
      if(event.status==="needs_review"&&event.source==="dona_job") return;
      if(event.source==="dona_schedule") {
        const run=this.db.prepare("SELECT job_id,status FROM schedule_runs WHERE event_id=?").get(eventId) as {job_id:string|null;status:string}|undefined;
        if(!run?.job_id||run.status==="materialized") {
          const rejected=event.last_error_code?.startsWith("delegation_rejected:")===true;
          const rejectionCode=rejected?event.last_error_code!.slice("delegation_rejected:".length):undefined;
          const ambiguous=(result.actions??[]).some(action=>action!==null&&typeof action==="object"&&!Array.isArray(action)&&
            typeof (action as Record<string,unknown>).tool==="string"&&String((action as Record<string,unknown>).tool).endsWith(".post_message")&&
            (action as Record<string,unknown>).ambiguous===true);
          const posted=(result.actions??[]).some(action=>action!==null&&typeof action==="object"&&!Array.isArray(action)&&
            typeof (action as Record<string,unknown>).tool==="string"&&String((action as Record<string,unknown>).tool).endsWith(".post_message")&&
            typeof (action as Record<string,unknown>).message_ts==="string");
          const needsReview=ambiguous||posted;
          this.transition(eventId,["waiting_agent"],rejected&&!needsReview?"dead_letter":"needs_review",{result_json:stableStringify(result),result_path:resultPath,
            completed_at:result.completed_at,last_error_code:rejected?event.last_error_code:"schedule_job_not_delegated",
            last_error_message:rejected?event.last_error_message:"Scheduled work completed without a bound job"});
          this.scheduler.settleUndelegatedWorkEvent(eventId,rejected&&!needsReview?"failed":"needs_review",
            new Date(Math.floor(Date.parse(result.completed_at)/1000)*1000).toISOString().replace(".000Z","Z"),rejectionCode);
          return;
        }
      }
      this.transition(eventId, ["waiting_agent"], "completed", {
        result_json: stableStringify(result), result_path: resultPath, completed_at: result.completed_at,
        last_error_code: null, last_error_message: null,
      });
      const delivery=this.notificationDelivered(eventId,result,acceptedAt,evidence);
      if(delivery.runId) {
        this.setNotificationState(eventId,delivery.delivered?"accepted":"needs_review",new Date(result.completed_at));
      }
    }).immediate();
  }

  saveFailedResult(eventId: string, result: ResultEnvelope, resultPath: string, acceptedAt=new Date(),evidence?:JobNotificationEvidence): void {
    if(Date.parse(result.completed_at)>acceptedAt.getTime()) throw new Error("completed_at_is_in_the_future");
    this.db.transaction(()=>{
      const event=this.getRequired(eventId);
      if(event.status==="completed"&&["schedule_suppressed","schedule_notification_suppressed","job_result_superseded"].includes(event.last_error_code??"")) return;
      if(event.status==="needs_review"&&event.source==="dona_job") return;
      if(event.source==="dona_schedule") {
        const run=this.db.prepare("SELECT job_id,status FROM schedule_runs WHERE event_id=?").get(eventId) as {job_id:string|null;status:string}|undefined;
        const rejected=event.last_error_code?.startsWith("delegation_rejected:")===true;
        if((!run?.job_id||run.status==="materialized")&&rejected) {
          const rejectionCode=event.last_error_code!.slice("delegation_rejected:".length);
          const ambiguous=(result.actions??[]).some(action=>action!==null&&typeof action==="object"&&!Array.isArray(action)&&
            typeof (action as Record<string,unknown>).tool==="string"&&String((action as Record<string,unknown>).tool).endsWith(".post_message")&&
            (action as Record<string,unknown>).ambiguous===true);
          const posted=(result.actions??[]).some(action=>action!==null&&typeof action==="object"&&!Array.isArray(action)&&
            typeof (action as Record<string,unknown>).tool==="string"&&String((action as Record<string,unknown>).tool).endsWith(".post_message")&&
            typeof (action as Record<string,unknown>).message_ts==="string");
          const needsReview=ambiguous||posted;
          this.transition(eventId,["waiting_agent"],needsReview?"needs_review":"dead_letter",{result_json:stableStringify(result),result_path:resultPath,
            completed_at:result.completed_at,last_error_code:event.last_error_code,last_error_message:event.last_error_message});
          this.scheduler.settleUndelegatedWorkEvent(eventId,needsReview?"needs_review":"failed",new Date(Math.floor(Date.parse(result.completed_at)/1000)*1000).toISOString().replace(".000Z","Z"),rejectionCode);
          return;
        }
      }
      const delivery=this.notificationDelivered(eventId,result,acceptedAt,evidence);
      if(delivery.delivered) {
        this.transition(eventId,["waiting_agent"],"completed",{result_json:stableStringify(result),result_path:resultPath,completed_at:result.completed_at,last_error_code:"agent_failed_after_delivery",last_error_message:result.summary??"Agent failed after confirmed delivery"});
        this.setNotificationState(eventId,"accepted",new Date(result.completed_at));return;
      }
      const ambiguous=(result.actions??[]).some(action=>action!==null&&typeof action==="object"&&!Array.isArray(action)&&
        typeof (action as Record<string,unknown>).tool==="string"&&String((action as Record<string,unknown>).tool).endsWith(".post_message")&&
        (action as Record<string,unknown>).ambiguous===true);
      const posted=(result.actions??[]).some(action=>action!==null&&typeof action==="object"&&!Array.isArray(action)&&
        typeof (action as Record<string,unknown>).tool==="string"&&String((action as Record<string,unknown>).tool).endsWith(".post_message")&&
        typeof (action as Record<string,unknown>).message_ts==="string");
      const needsReview=ambiguous||posted;
      this.transition(eventId, ["waiting_agent"], needsReview?"needs_review":"dead_letter", {result_json: stableStringify(result),result_path: resultPath,
        completed_at: result.completed_at,last_error_code: ambiguous?"ambiguous_external_write":posted?"incomplete_delivery_after_post":"agent_reported_failure",
        last_error_message: result.summary ?? "Agent reported failure"});
      this.scheduler.settleUndelegatedWorkEvent(eventId,needsReview||event.source==="dona_schedule"?"needs_review":"failed",new Date(Math.floor(Date.parse(result.completed_at)/1000)*1000).toISOString().replace(".000Z","Z"));
      this.setNotificationState(eventId,needsReview?"needs_review":"failed",new Date(result.completed_at));
    }).immediate();
  }

  manualRetry(eventId: string, force: boolean, at = new Date()): EventRow {
    const row = this.getRequired(eventId);
    if (["blocked", "needs_review"].includes(row.status) && !force) {
      throw new Error(`${row.status} may already have side effects; repeat with --force after review`);
    }
    if (!["blocked", "needs_review", "dead_letter", "retryable_failed"].includes(row.status)) {
      throw new Error(`Event in status ${row.status} cannot be retried`);
    }
    const notification=this.db.prepare("SELECT notification_state,notification_authorization_phase FROM job_completion_results WHERE notification_event_id=?")
      .get(eventId) as {notification_state:string;notification_authorization_phase:string}|undefined;
    const reportedPost=row.result_json!==null&&this.db.prepare(`SELECT 1 FROM json_each(?,'$.actions')
      WHERE json_extract(value,'$.tool') LIKE '%.post_message' LIMIT 1`).get(row.result_json)!==undefined;
    if(notification&&reportedPost) throw new Error("scheduled_notification_retry_requires_reconciliation");
    if(notification&&row.result_path&&fs.existsSync(row.result_path)) throw new Error("scheduled_notification_retry_requires_reconciliation");
    if(notification&&!((notification.notification_state==="failed"&&["none","preflight"].includes(notification.notification_authorization_phase))||(notification.notification_state==="needs_review"&&["none","preflight"].includes(notification.notification_authorization_phase))))
      throw new Error("scheduled_notification_retry_requires_reconciliation");
    const undelegatedRun=row.source==="dona_schedule"?this.db.prepare("SELECT status,job_id FROM schedule_runs WHERE event_id=?").get(eventId) as {status:string;job_id:string|null}|undefined:undefined;
    if(undelegatedRun?.job_id===null&&undelegatedRun.status!=="materialized") throw new Error("schedule_event_retry_requires_reconciliation");
    const resultBackupPath=row.result_path?`${row.result_path}.retry-backup`:null;
    if(resultBackupPath&&fs.existsSync(resultBackupPath)) {
      if(fs.existsSync(row.result_path!)) throw new Error("retry_result_backup_exists");
      fs.renameSync(resultBackupPath,row.result_path!);
    }
    if(row.result_path&&fs.existsSync(row.result_path)) {
      fs.renameSync(row.result_path,resultBackupPath!);
    }
    try {
      this.db.transaction(()=>{
        this.db.prepare(`
          UPDATE events SET status = 'queued', attempt_count = 0, available_at = ?,
            dispatch_started_at = NULL, prompt_accepted_at = NULL, completed_at = NULL,
            result_json = NULL, result_path = ?, last_error_code = ?,
            last_error_message = NULL, schedule_access_checked_at = NULL,
            schedule_access_consumed_at = NULL, updated_at = ? WHERE event_id = ?
        `).run(at.toISOString(), resultBackupPath, resultBackupPath?"manual_retry_cleanup_pending":null, at.toISOString(), eventId);
        this.db.prepare("UPDATE job_completion_results SET notification_state='pending',notification_authorization_phase='none',notification_preflight_authorized_at=NULL,notification_write_authorized_at=NULL WHERE notification_event_id=? AND (notification_state='failed' OR (notification_state='needs_review' AND notification_authorization_phase IN ('none','preflight')))").run(eventId);
      }).immediate();
    } catch(error) {
      if(row.result_path&&resultBackupPath&&fs.existsSync(resultBackupPath)&&!fs.existsSync(row.result_path)) fs.renameSync(resultBackupPath,row.result_path);
      throw error;
    }
    if(resultBackupPath) {
      fs.rmSync(resultBackupPath,{force:true});
      this.db.prepare("UPDATE events SET result_path=NULL,last_error_code=NULL,updated_at=? WHERE event_id=? AND status='queued' AND last_error_code='manual_retry_cleanup_pending'")
        .run(nowUtc(),eventId);
    }
    return this.getRequired(eventId);
  }

  manualComplete(eventId: string, at = new Date()): EventRow {
    return this.db.transaction(() => {
      const row = this.getRequired(eventId);
      if(row.source==="dona_schedule") throw new Error("scheduled_event_completion_requires_reconciliation");
      const scheduledNotification=this.db.prepare(`SELECT 1 FROM job_completion_results WHERE notification_event_id=?
        AND json_extract(owner_json,'$.kind')='schedule' AND notification_state!='accepted'`).get(eventId);
      if(scheduledNotification) throw new Error("scheduled_notification_receipt_required");
      if (row.status === "completed") {
        this.sealJobGroupIfPresent(eventId, at.toISOString());
        this.setNotificationState(eventId,"accepted",at);
        return this.getRequired(eventId);
      }
      const result: ResultEnvelope = {
        schema_version: 1,
        event_id: eventId,
        status: "completed",
        summary: "Manually marked completed after operator review",
        actions: [],
        memory_candidates: [],
        completed_at: at.toISOString(),
      };
      this.db
        .prepare(`
          UPDATE events SET status = 'completed', result_json = ?, completed_at = ?,
            last_error_code = NULL, last_error_message = NULL, updated_at = ?
          WHERE event_id = ?
        `)
        .run(stableStringify(result), at.toISOString(), at.toISOString(), eventId);
      this.sealJobGroupIfPresent(eventId, at.toISOString());
      this.setNotificationState(eventId,"accepted",at);
      return this.getRequired(eventId);
    }).immediate();
  }

  reconcileScheduledNotification(eventId:string,receipt:{workspace_id:string;channel_id:string;message_ts:string;thread_ts?:string},at=new Date(),claimToken?:string):EventRow {
    return this.db.transaction(()=>{
      this.assertNotificationReconciliationClaim(eventId,claimToken);
      this.getRequired(eventId);
      const completion=this.db.prepare(`SELECT destination_json,notification_state FROM job_completion_results
        WHERE notification_event_id=? AND json_extract(owner_json,'$.kind')='schedule'`).get(eventId) as {destination_json:string;notification_state:string}|undefined;
      if(!completion||!["failed","needs_review"].includes(completion.notification_state)) throw new Error("scheduled_notification_not_reconcilable");
      const destination=JSON.parse(completion.destination_json) as {kind?:string;target?:{kind?:string;workspace_id?:string;channel_id?:string;thread_ts?:string}};
      const target=destination.kind==="slack"?destination.target:undefined;
      if(!target||receipt.workspace_id!==target.workspace_id||receipt.channel_id!==target.channel_id||
        !/^\d{1,20}\.\d{6}$/.test(receipt.message_ts)||(target.kind==="thread"?receipt.thread_ts!==target.thread_ts:receipt.thread_ts!==undefined)) throw new Error("scheduled_notification_receipt_mismatch");
      const result:ResultEnvelope={schema_version:1,event_id:eventId,status:"completed",summary:"Operator reconciled a verified scheduled notification receipt",
        actions:[{tool:"operator.reconcile_job_notification",workspace_id:receipt.workspace_id,channel_id:receipt.channel_id,message_ts:receipt.message_ts,...(receipt.thread_ts?{thread_ts:receipt.thread_ts}:{})}],memory_candidates:[],completed_at:at.toISOString()};
      this.db.prepare(`UPDATE events SET status='completed',result_json=?,completed_at=?,last_error_code=NULL,last_error_message=NULL,updated_at=? WHERE event_id=?`)
        .run(stableStringify(result),at.toISOString(),at.toISOString(),eventId);
      this.setNotificationState(eventId,"accepted",at,["failed","needs_review"]);
      return this.getRequired(eventId);
    }).immediate();
  }

  reconcileScheduledNotificationNotSent(eventId:string,at=new Date(),claimToken?:string):EventRow {
    return this.db.transaction(()=>{
      this.assertNotificationReconciliationClaim(eventId,claimToken);
      this.getRequired(eventId);
      const completion=this.db.prepare(`SELECT json_extract(owner_json,'$.run_id') AS run_id,notification_state FROM job_completion_results
        WHERE notification_event_id=? AND json_extract(owner_json,'$.kind')='schedule'`).get(eventId) as {run_id:string;notification_state:string}|undefined;
      if(!completion||!["failed","needs_review"].includes(completion.notification_state)) throw new Error("scheduled_notification_not_reconcilable");
      const result:ResultEnvelope={schema_version:1,event_id:eventId,status:"completed",summary:"Operator confirmed the scheduled notification was not sent",
        actions:[{tool:"operator.reconcile_job_notification",outcome:"not_sent"}],memory_candidates:[],completed_at:at.toISOString()};
      this.db.prepare("UPDATE events SET status='completed',result_json=?,completed_at=?,last_error_code='notification_confirmed_not_sent',last_error_message=NULL,updated_at=? WHERE event_id=?")
        .run(stableStringify(result),at.toISOString(),at.toISOString(),eventId);
      this.setNotificationState(eventId,"none",at,["failed","needs_review"]);
      this.scheduler.reconcileWorkNotificationNotSent(completion.run_id,new Date(Math.floor(at.getTime()/1000)*1000).toISOString().replace(".000Z","Z"));
      return this.getRequired(eventId);
    }).immediate();
  }

  manualDeadLetter(eventId: string, at = new Date()): EventRow {
    const row=this.getRequired(eventId);
    const notification=this.db.prepare("SELECT notification_state FROM job_completion_results WHERE notification_event_id=?").get(eventId) as {notification_state:string}|undefined;
    if(notification?.notification_state==="accepted") return row;
    this.db.transaction(()=>{
      this.db.prepare(`
        UPDATE events SET status = 'dead_letter', last_error_code = 'operator_dead_letter',
          last_error_message = 'Moved to dead letter by operator', updated_at = ? WHERE event_id = ?
      `)
      .run(at.toISOString(), eventId);
      this.scheduler.settleUndelegatedWorkEvent(eventId,"failed",new Date(Math.floor(at.getTime()/1000)*1000).toISOString().replace(".000Z","Z"));
      this.sealJobGroupIfPresent(eventId, at.toISOString());
      this.setNotificationState(eventId,"failed",at);
    }).immediate();
    return this.getRequired(eventId);
  }

  schemaCompatibility(): {
    actual: number;
    read_min: number;
    read_max: number;
    write: number;
  } {
    return {
      actual: this.db.pragma("user_version", { simple: true }) as number,
      read_min: dispatcherSchemaCompatibility.read_min,
      read_max: dispatcherSchemaCompatibility.read_max,
      write: this.schemaWrite,
    };
  }

  listNonterminalWorkspaceJobIds(workspaceId:string,afterJobId="",limit=500):string[] {
    return (this.db.prepare(`SELECT job_id FROM jobs WHERE workspace_id=? AND job_id>? AND status NOT IN ('blocked','completed','failed','cancelled','needs_review') ORDER BY job_id LIMIT ?`).all(workspaceId,afterJobId,limit) as Array<{job_id:string}>).map((row)=>row.job_id);
  }
  listNonterminalJobs(afterJobId="",limit=500):JobRow[] {return this.db.prepare(`SELECT * FROM jobs WHERE job_id>? AND status NOT IN ('blocked','completed','failed','cancelled','needs_review') ORDER BY job_id LIMIT ?`).all(afterJobId,limit) as JobRow[];}
  listJobsAfter(afterJobId="",limit=500):JobRow[] {return this.db.prepare("SELECT * FROM jobs WHERE job_id>? ORDER BY job_id LIMIT ?").all(afterJobId,limit) as JobRow[];}
  listStatusJobsAfter(status:JobStatus,afterJobId="",limit=500):JobRow[] {return this.db.prepare("SELECT * FROM jobs WHERE status=? AND job_id>? ORDER BY job_id LIMIT ?").all(status,afterJobId,limit) as JobRow[];}

  listEventJobs(sourceEventId: string, jobKey?: string): EventJobProjection[] {
    const rows = jobKey === undefined
      ? this.db.prepare(`
          SELECT * FROM jobs WHERE source_event_id = ? ORDER BY created_at, job_id
        `).all(sourceEventId) as JobRow[]
      : this.db.prepare(`
          SELECT * FROM jobs WHERE source_event_id = ? AND job_key = ? ORDER BY created_at, job_id
        `).all(sourceEventId, jobKey) as JobRow[];
    return rows.map((row) => ({
      job_id: row.job_id,
      job_key: row.job_key,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at,
      last_error_code: row.last_error_code,
      result_summary: this.jobResultSummary(row),
    }));
  }

  reconcileEventJob(
    sourceEventId: string,
    jobKey: string,
    canonicalPayloadSha256: string,
  ): EventJobReconciliation {
    const row = this.db.prepare(`
      SELECT workspace_json FROM jobs WHERE source_event_id = ? AND job_key = ?
    `).get(sourceEventId, jobKey) as Pick<JobRow, "workspace_json"> | undefined;
    if (!row) return "not_found";
    const storedSha256 = jobCreationPayloadSha256FromWorkspace(JSON.parse(row.workspace_json) as unknown);
    if (storedSha256 === undefined) return "unverified_legacy";
    return storedSha256 === canonicalPayloadSha256 ? "matched" : "conflict";
  }

  listRunningJobs(): JobRow[] {
    return this.db.prepare(`
      SELECT * FROM jobs WHERE status = 'running' ORDER BY created_at, job_id
    `).all() as JobRow[];
  }

  beginRunnableCycle(at = new Date()): string | undefined {
    const timestamp = at.toISOString();
    return this.db.transaction(() => {
      this.db.prepare(`
        UPDATE jobs INDEXED BY jobs_run_idx
        SET status = 'queued', updated_at = ?
        WHERE status = 'retryable_failed' AND available_at <= ?
      `).run(timestamp, timestamp);
      const row = this.db.prepare(`
        SELECT source_event_id FROM jobs INDEXED BY jobs_runnable_fair_idx
        WHERE status = 'queued' AND available_at <= ?
        ORDER BY source_event_id DESC
        LIMIT 1
      `).get(timestamp) as Pick<JobRow, "source_event_id"> | undefined;
      return row?.source_event_id;
    })();
  }

  nextRunnableJob(
    at = new Date(),
    afterSourceEventId = "",
    excludedSourceEventIds: string[] = [],
    excludedJobIds: string[] = [],
    throughSourceEventId?: string,
  ): JobRow | undefined {
    const timestamp = at.toISOString();
    const cycleEndSourceEventId = throughSourceEventId ?? this.beginRunnableCycle(at);
    if (cycleEndSourceEventId === undefined) return undefined;
    const sourcePlaceholders = excludedSourceEventIds.map(() => "?").join(", ");
    const jobPlaceholders = excludedJobIds.map(() => "?").join(", ");
    const excludedSources = excludedSourceEventIds.length > 0
      ? `AND source_event_id NOT IN (${sourcePlaceholders})`
      : "";
    const excludedJobs = excludedJobIds.length > 0 ? `AND job_id NOT IN (${jobPlaceholders})` : "";
    const statement = this.db.prepare(`
      SELECT * FROM jobs INDEXED BY jobs_runnable_fair_idx
      WHERE status = 'queued' AND available_at <= ?
        AND source_event_id > ?
        AND source_event_id <= ?
        ${excludedSources}
        ${excludedJobs}
      ORDER BY source_event_id, created_at, job_id
      LIMIT 1
    `);
    return statement.get(
      timestamp,
      afterSourceEventId,
      cycleEndSourceEventId,
      ...excludedSourceEventIds,
      ...excludedJobIds,
    ) as JobRow | undefined;
  }

  nextWaitingJobAt(
    after: Date,
    excludedSourceEventIds: string[] = [],
    excludedJobIds: string[] = [],
  ): Date | undefined {
    const sourcePlaceholders = excludedSourceEventIds.map(() => "?").join(", ");
    const jobPlaceholders = excludedJobIds.map(() => "?").join(", ");
    const excludedSources = excludedSourceEventIds.length > 0
      ? `AND source_event_id NOT IN (${sourcePlaceholders})`
      : "";
    const excludedJobs = excludedJobIds.length > 0 ? `AND job_id NOT IN (${jobPlaceholders})` : "";
    const statement = this.db.prepare(`
      SELECT available_at FROM jobs INDEXED BY jobs_run_idx
      WHERE status = ? AND available_at > ?
        ${excludedSources}
        ${excludedJobs}
      ORDER BY available_at, created_at
      LIMIT 1
    `);
    const nextForStatus = (status: "queued" | "retryable_failed") => statement.get(
      status,
      after.toISOString(),
      ...excludedSourceEventIds,
      ...excludedJobIds,
    ) as Pick<JobRow, "available_at"> | undefined;
    const candidates = [nextForStatus("queued"), nextForStatus("retryable_failed")]
      .filter((row): row is Pick<JobRow, "available_at"> => row !== undefined)
      .sort((left, right) => left.available_at.localeCompare(right.available_at));
    return candidates[0] ? new Date(candidates[0].available_at) : undefined;
  }

  jobQueueStats(excludedJobIds: string[] = []): JobQueueStats {
    const jobPlaceholders = excludedJobIds.map(() => "?").join(", ");
    const excludedJobs = excludedJobIds.length > 0 ? `AND job_id NOT IN (${jobPlaceholders})` : "";
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(job_count), 0) AS queued_jobs,
        COUNT(*) AS queued_source_events,
        COALESCE(MAX(job_count), 0) AS queued_max_per_event
      FROM (
        SELECT source_event_id, COUNT(*) AS job_count
        FROM jobs
        WHERE status IN ('queued', 'retryable_failed')
          ${excludedJobs}
        GROUP BY source_event_id
      )
    `).get(...excludedJobIds) as {
      queued_jobs: number;
      queued_source_events: number;
      queued_max_per_event: number;
    };
    return {
      queuedJobs: row.queued_jobs,
      queuedSourceEvents: row.queued_source_events,
      queuedMaxPerEvent: row.queued_max_per_event,
    };
  }

  quarantineUpdateNotification(eventId: string, code: string, message: string, at = new Date()): EventRow {
    const row = this.getRequired(eventId);
    if (row.source !== "dona_update" || !["queued", "retryable_failed"].includes(row.status)) {
      throw new Error(`Event ${eventId} is not a pending update notification`);
    }
    const changed = this.db.prepare(`
      UPDATE events SET status = 'dead_letter', last_error_code = ?, last_error_message = ?,
        updated_at = ?
      WHERE event_id = ? AND source = 'dona_update' AND status IN ('queued', 'retryable_failed')
    `).run(code, message.slice(0, 2_000), at.toISOString(), eventId).changes;
    if (changed !== 1) throw new Error(`Event ${eventId} is no longer a pending update notification`);
    return this.getRequired(eventId);
  }

  private jobResultSummary(row: JobRow): string | null {
    if (!row.result_json) return null;
    try {
      const result = JSON.parse(row.result_json) as Record<string, unknown>;
      if (typeof result.summary !== "string") return null;
      const characters = Array.from(result.summary);
      return characters.length <= 500 ? result.summary : `${characters.slice(0, 499).join("")}…`;
    } catch {
      return null;
    }
  }

  private getRequired(eventId: string): EventRow {
    const row = this.get(eventId);
    if (!row) throw new Error(`Event ${eventId} was not found`);
    return row;
  }

  private getJobRequired(jobId: string): JobRow {
    const row = this.getJob(jobId);
    if (!row) throw new Error(`Job ${jobId} was not found`);
    return row;
  }

  private getJobGroupRequired(sourceEventId: string): JobGroupRow {
    const row = this.getJobGroup(sourceEventId);
    if (!row) throw new Error(`Job group ${sourceEventId} was not found`);
    return row;
  }

  private buildJobGroupSnapshot(
    sourceEventId: string,
    group: JobGroupRow,
    notificationJob: JobRow,
  ): JobGroupSnapshot {
    const counts = this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM jobs WHERE source_event_id = ? GROUP BY status
    `).all(sourceEventId) as Array<{ status: JobStatus; count: number }>;
    const statusCounts: Partial<Record<JobStatus, number>> = {};
    let total = 0;
    let pending = 0;
    let allJobsTerminal = true;
    for (const row of counts) {
      statusCounts[row.status] = row.count;
      total += row.count;
      if (!["completed", "cancelled", "failed", "needs_review"].includes(row.status)) pending += row.count;
      if (!["completed", "cancelled", "failed", "needs_review"].includes(row.status)) allJobsTerminal = false;
    }

    let transition: JobGroupTransition = "progress";
    if (jobAttentionStatuses.has(notificationJob.status) && group.attention_event_id === null &&
      !this.jobAttentionResolved(notificationJob) &&
      !this.groupCanClaimAllTerminal(sourceEventId, group)) {
      transition = "attention";
    } else if (total > 0 && allJobsTerminal && group.all_terminal_event_id === null &&
      this.groupCanClaimAllTerminal(sourceEventId, group)) {
      transition = "all_terminal";
    }

    const jobs = this.db.prepare(`
      SELECT job_id, job_key, status FROM jobs
      WHERE source_event_id = ? ORDER BY created_at, job_id LIMIT ?
    `).all(sourceEventId, jobGroupSnapshotJobLimit) as JobGroupSnapshot["jobs"];
    return {
      source_event_id: sourceEventId,
      attention_resolution_state: transition === "attention" ? "unresolved"
        : group.attention_event_id === null ? (statusCounts.failed ? "resolved" : "not_required")
        : this.groupCanClaimAllTerminal(sourceEventId, group) ? "resolved" : "unresolved",
      total,
      pending,
      status_counts: statusCounts,
      jobs,
      transition,
    };
  }

  private groupCanClaimAllTerminal(sourceEventId: string, group: JobGroupRow): boolean {
    if (group.notification_mode !== "grouped" || !group.sealed_at || group.all_terminal_event_id) return false;
    if (this.db.prepare("SELECT 1 FROM job_attention_delivery_claims WHERE source_event_id=? LIMIT 1")
      .get(sourceEventId)) return false;
    if (group.attention_event_id && !this.attentionNotificationSettled(this.getRequired(group.attention_event_id))) return false;
    const unresolved = this.db.prepare(`
      SELECT 1 FROM jobs j WHERE j.source_event_id=? AND (
        j.status NOT IN ('completed','failed','cancelled') OR
        (j.status='failed' AND NOT EXISTS (
          SELECT 1 FROM job_attention_resolutions r WHERE r.job_id=j.job_id
            AND r.source_event_id=j.source_event_id
            AND r.status_at_resolution='failed'
        ))
      ) LIMIT 1
    `).get(sourceEventId);
    if (unresolved) return false;
    return true;
  }

  private jobAttentionResolved(job: JobRow): boolean {
    if (job.status !== "failed") return false;
    return this.db.prepare(`SELECT 1 FROM job_attention_resolutions
      WHERE job_id=? AND source_event_id=? AND status_at_resolution='failed'`)
      .get(job.job_id,job.source_event_id) !== undefined;
  }

  private attentionNotificationSettled(event: EventRow): boolean {
    if (event.source !== "dona_job" || event.status !== "completed" || !event.result_json) return false;
    const payload = JSON.parse(event.payload_json) as { group?: { transition?: string } };
    const result = JSON.parse(event.result_json) as ResultEnvelope;
    if (payload.group?.transition !== "attention" || result.event_id !== event.event_id || result.status !== "completed") return false;
    if (this.db.prepare("SELECT 1 FROM job_attention_delivery_receipts WHERE attention_event_id=?")
      .get(event.event_id)) return true;
    const actions = result.actions ?? [];
    const target = event.reply_target_json ? JSON.parse(event.reply_target_json) as Record<string, unknown> : null;
    if (target?.kind !== "slack_thread" || typeof target.workspace_id !== "string" ||
        typeof target.channel_id !== "string" ||
        typeof target.thread_ts !== "string") return false;
    if (actions.some(action => action && typeof action === "object" &&
      (action as Record<string, unknown>).ambiguous === true)) return false;
    const actionSucceeded = (action: Record<string, unknown>) =>
      action.ambiguous !== true && action.success !== false && action.ok !== false && !("error" in action);
    return actions.some(action => action && typeof action === "object" &&
      (action as Record<string, unknown>).tool === "dona_slack.post_message" &&
      typeof (action as Record<string, unknown>).message_ts === "string" &&
      /^\d+\.\d+$/.test((action as Record<string, unknown>).message_ts as string) &&
      (action as Record<string, unknown>).workspace_id === target.workspace_id &&
      (action as Record<string, unknown>).channel_id === target.channel_id &&
      (action as Record<string, unknown>).thread_ts === target.thread_ts &&
      (action as Record<string, unknown>).reply_broadcast !== true &&
      actionSucceeded(action as Record<string, unknown>)) &&
      actions.some(action => action && typeof action === "object" &&
        (action as Record<string, unknown>).tool === "dona_slack.set_agent_session_status" &&
        (action as Record<string, unknown>).status === "suspended" &&
        (action as Record<string, unknown>).workspace_id === target.workspace_id &&
        (action as Record<string, unknown>).channel_id === target.channel_id &&
        (action as Record<string, unknown>).thread_ts === target.thread_ts &&
        actionSucceeded(action as Record<string, unknown>));
  }

  private recordAttentionResolution(
    jobId: string, attentionEventId: string, status: "completed" | "failed" | "cancelled",
    kind: "validated_result" | "operator_reconcile", resolutionEventId: string | null, at: Date,
  ): void {
    const job = this.getJobRequired(jobId);
    const attention = this.getRequired(attentionEventId);
    if (job.status !== status || attention.source !== "dona_job") throw new Error("attention_resolution_binding_mismatch");
    const payload = JSON.parse(attention.payload_json) as { group?: { transition?: string; source_event_id?: string } };
    if (payload.group?.transition !== "attention" || payload.group.source_event_id !== job.source_event_id) {
      throw new Error("attention_resolution_binding_mismatch");
    }
    const existing = this.db.prepare("SELECT * FROM job_attention_resolutions WHERE job_id=?")
      .get(jobId) as { attention_event_id: string; status_at_resolution: string; resolution_kind: string } | undefined;
    if (existing) {
      if (existing.attention_event_id !== attentionEventId || existing.status_at_resolution !== status || existing.resolution_kind !== kind)
        throw new Error("attention_resolution_conflict");
      return;
    }
    this.db.prepare(`INSERT INTO job_attention_resolutions
      (job_id,source_event_id,attention_event_id,status_at_resolution,resolution_kind,resolution_event_id,resolved_at)
      VALUES(?,?,?,?,?,?,?)`)
      .run(jobId, job.source_event_id, attentionEventId, status, kind, resolutionEventId, at.toISOString());
    const unresolvedSibling = this.db.prepare(`SELECT 1 FROM jobs j WHERE j.source_event_id=? AND j.job_id<>?
      AND (j.status IN ('blocked','needs_review') OR (j.status='failed' AND NOT EXISTS (
        SELECT 1 FROM job_attention_resolutions r WHERE r.job_id=j.job_id
          AND r.source_event_id=j.source_event_id AND r.status_at_resolution='failed'
      ))) LIMIT 1`).get(job.source_event_id,jobId);
    if (unresolvedSibling && this.attentionNotificationSettled(attention)) {
      this.db.prepare(`UPDATE job_groups SET attention_event_id=NULL,updated_at=?
        WHERE source_event_id=? AND attention_event_id=? AND all_terminal_event_id IS NULL`)
        .run(at.toISOString(),job.source_event_id,attentionEventId);
    }
  }

  private sealJobGroupIfPresent(sourceEventId: string, timestamp: string): number {
    return this.db.prepare(`
      UPDATE job_groups SET sealed_at = ?, updated_at = ?
      WHERE source_event_id = ? AND sealed_at IS NULL
    `).run(timestamp, timestamp, sourceEventId).changes;
  }

  private updateJob(
    jobId: string,
    from: JobStatus[],
    to: JobStatus,
    values: Record<string, string | null>,
  ): void {
    const timestamp = nowUtc();
    const binding=readEventJobBinding(this.db,this.getJobRequired(jobId).source_event_id),persisted={...values};
    const job=this.getJobRequired(jobId);
    if(binding?.owner.kind==="schedule"&&typeof persisted.last_error_message==="string") persisted.last_error_message=this.safeNotificationError(persisted.last_error_message,true,job);
    const assignments = [...Object.keys(persisted).map((key) => `${key} = ?`), "status = ?", "updated_at = ?"];
    const params = [...Object.values(persisted), to, timestamp, jobId, ...from];
    const placeholders = from.map(() => "?").join(", ");
    const changed = this.db.prepare(
      `UPDATE jobs SET ${assignments.join(", ")} WHERE job_id = ? AND status IN (${placeholders})`,
    ).run(...params).changes;
    if (changed !== 1) throw new Error(`Invalid status transition for job ${jobId} to ${to}`);
  }

  private transition(
    eventId: string,
    from: EventStatus[],
    to: EventStatus,
    values: Record<string, string | null>,
  ): void {
    this.db.transaction(() => {
      const current = this.getRequired(eventId);
      const timestamp = nowUtc();
      const assignments = [...Object.keys(values).map((key) => `${key} = ?`), "status = ?", "updated_at = ?"];
      const params = [...Object.values(values), to, timestamp, eventId, ...from];
      const placeholders = from.map(() => "?").join(", ");
      const changed = this.db
        .prepare(`UPDATE events SET ${assignments.join(", ")} WHERE event_id = ? AND status IN (${placeholders})`)
        .run(...params).changes;
      if (changed !== 1) throw new Error(`Invalid status transition for event ${eventId} to ${to}`);
      const leftAgentOwnedState =
        ["dispatching", "waiting_agent"].includes(current.status) &&
        !["dispatching", "waiting_agent"].includes(to);
      if (leftAgentOwnedState || ["completed", "blocked", "needs_review", "dead_letter"].includes(to)) {
        this.sealJobGroupIfPresent(eventId, timestamp);
      }
    }).immediate();
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
