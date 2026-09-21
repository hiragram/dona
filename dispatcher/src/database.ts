import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

import Database from "better-sqlite3";
import { ulid } from "ulid";

import { expandHome, jobResourceDefaults, jobResourceHardLimits } from "./config.js";
import type {
  CreateJobRequest,
  CreateJobResult,
  EnqueueResult,
  EventJobProjection,
  EventJobReconciliation,
  EventEnvelope,
  EventRow,
  EventStatus,
  JobResultEnvelope,
  JobGroupNotificationMode,
  JobGroupRow,
  JobGroupSnapshot,
  JobGroupTransition,
  JobRow,
  JobStatus,
  ResultEnvelope,
} from "./types.js";
import { eventStatuses, jobStatuses } from "./types.js";
import { jobAgentName } from "./job-agent-name.js";
import {
  canonicalJobPayloadSha256,
  jobCreationObjectiveBytesFromWorkspace,
  jobCreationPayloadSha256FromWorkspace,
  legacyJobKey,
  parseCreateJobRequest,
  parseJobWorkspace,
  serializeJobWorkspace,
  stableStringify,
} from "./validation.js";

const statusSql = eventStatuses.map((status) => `'${status}'`).join(", ");
const jobStatusSql = jobStatuses.map((status) => `'${status}'`).join(", ");
const retryDelaysMs = [5_000, 30_000, 120_000, 600_000] as const;
const jobGroupSnapshotJobLimit = 32;
const jobAttentionStatuses = new Set<JobStatus>(["blocked", "failed", "needs_review"]);
const jobNotificationStatuses = new Set<JobStatus>(["blocked", "completed", "failed", "cancelled", "needs_review"]);
const jobsRunnableFairIndexSql = `
  CREATE INDEX jobs_runnable_fair_idx
    ON jobs(source_event_id, created_at, job_id, available_at)
    WHERE status = 'queued'
`;
export type JobCreationErrorCode =
  | "job_idempotency_conflict"
  | "job_group_closed"
  | "job_group_limit_exceeded";

export interface JobAdmissionLimits {
  jobsPerEventMax: number;
  jobObjectiveTotalMaxBytes: number;
}

export interface JobCreationLimitDetails {
  resource: "jobs_per_event" | "objective_utf8_bytes_per_event";
  current: number;
  attempted: number;
  maximum: number;
}

export interface JobQueueStats {
  queuedJobs: number;
  queuedSourceEvents: number;
  queuedMaxPerEvent: number;
}

export class JobCreationError extends Error {
  constructor(
    readonly code: JobCreationErrorCode,
    message: string,
    readonly limitDetails?: JobCreationLimitDetails,
  ) {
    super(message);
    this.name = "JobCreationError";
  }
}

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

export type DispatcherMigrationStep = "jobs_copied" | "indexes_recreated" | "groups_backfilled";
// Runtime callers leave this unset. Tests use it to prove that every v2 rebuild phase rolls back atomically.
export type DispatcherMigrationHook = (step: DispatcherMigrationStep) => void;
export type JobNotificationStep = "event_enqueued" | "transition_claimed" | "job_linked";
// Runtime callers leave this unset. Tests use it to prove notification publication is one transaction.
export type JobNotificationHook = (step: JobNotificationStep) => void;

function nowUtc(): string {
  return new Date().toISOString();
}

function retryAt(attemptCount: number, now: Date): string {
  const delay = retryDelaysMs[Math.min(Math.max(attemptCount - 1, 0), retryDelaysMs.length - 1)]!;
  return new Date(now.getTime() + delay).toISOString();
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
function assertSupportedWebJobProjectionSchema(db: Database.Database): void {
  const schemaExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_job_projection_schema'").get();
  if (schemaExists) {
    const versions = db.prepare("SELECT version FROM web_job_projection_schema").all() as Array<{ version: number }>;
    if (versions.length !== 1 || versions[0]!.version > 3) throw new Error("web_job_projection_schema_unsupported");
  }
}

function ensureWebJobProjectionSchema(db: Database.Database): void {
  assertSupportedWebJobProjectionSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_job_projection_events (
      sequence   INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id     TEXT NOT NULL,
      event_kind TEXT NOT NULL CHECK (event_kind IN ('snapshot','updated','progress','deleted')),
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS web_job_projection_events_job_idx
      ON web_job_projection_events(job_id,sequence);
    CREATE INDEX IF NOT EXISTS web_job_projection_events_retention_idx
      ON web_job_projection_events(created_at,sequence);
    CREATE TABLE IF NOT EXISTS web_job_projection_retention (
      singleton               INTEGER PRIMARY KEY CHECK (singleton=1),
      pruned_through_sequence INTEGER NOT NULL
    ) STRICT;
    INSERT OR IGNORE INTO web_job_projection_retention(singleton,pruned_through_sequence) VALUES(1,0);
    CREATE TABLE IF NOT EXISTS web_job_projection_cursors (
      cursor_digest     TEXT PRIMARY KEY CHECK (length(cursor_digest)=64),
      cursor_kind       TEXT NOT NULL CHECK (cursor_kind IN ('list','events')),
      instance_id       TEXT NOT NULL,
      tenant_id         TEXT NOT NULL,
      principal_id      TEXT NOT NULL,
      authorization_kind TEXT NOT NULL CHECK (authorization_kind IN ('own','granted','own_or_granted')),
      grant_id          TEXT,
      grant_revision    INTEGER CHECK (grant_revision>0 OR grant_revision IS NULL),
      resource_id       TEXT,
      snapshot_sequence INTEGER NOT NULL,
      after_created_at  TEXT,
      after_job_id      TEXT,
      expires_at        TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      CHECK ((grant_id IS NULL) = (grant_revision IS NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS web_job_projection_cursors_expiry_idx
      ON web_job_projection_cursors(expires_at);
    CREATE TABLE IF NOT EXISTS web_job_progress_versions (
      job_id     TEXT PRIMARY KEY,
      sequence   INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_job_projection_state (
      singleton      INTEGER PRIMARY KEY CHECK (singleton=1),
      initialized_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_job_projection_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton=1),
      version   INTEGER NOT NULL CHECK (version>=1)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_job_read_grants (
      grant_id       TEXT PRIMARY KEY,
      job_id         TEXT NOT NULL,
      instance_id    TEXT NOT NULL,
      tenant_id      TEXT NOT NULL,
      principal_id   TEXT NOT NULL,
      grant_revision INTEGER NOT NULL CHECK (grant_revision>0),
      state          TEXT NOT NULL CHECK (state IN ('active','revoked')),
      expires_at     TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      UNIQUE(job_id,instance_id,tenant_id,principal_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS web_job_read_grants_principal_idx
      ON web_job_read_grants(instance_id,tenant_id,principal_id,state,expires_at,job_id);
    CREATE TRIGGER IF NOT EXISTS web_job_projection_insert
      AFTER INSERT ON jobs WHEN new.source='web' BEGIN
        INSERT INTO web_job_projection_events(job_id,event_kind,created_at)
        VALUES(new.job_id,'snapshot',new.updated_at);
      END;
    CREATE TRIGGER IF NOT EXISTS web_job_projection_delete
      AFTER DELETE ON jobs WHEN old.source='web' BEGIN
        INSERT INTO web_job_projection_events(job_id,event_kind,created_at)
        VALUES(old.job_id,'deleted',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
  `);
  const upgrade = () => {
    const current = db.prepare("SELECT version FROM web_job_projection_schema WHERE singleton=1")
      .get() as { version: number } | undefined;
    if ((current?.version ?? 0) < 3) {
      const cursorColumns = db.pragma("table_info(web_job_projection_cursors)") as Array<{ name: string }>;
      if (!["authorization_kind","grant_id","grant_revision"].every(name=>cursorColumns.some(column=>column.name===name))) db.exec(`
        DROP TABLE web_job_projection_cursors;
        CREATE TABLE web_job_projection_cursors (
          cursor_digest      TEXT PRIMARY KEY CHECK (length(cursor_digest)=64),
          cursor_kind        TEXT NOT NULL CHECK (cursor_kind IN ('list','events')),
          instance_id        TEXT NOT NULL,
          tenant_id          TEXT NOT NULL,
          principal_id       TEXT NOT NULL,
          authorization_kind TEXT NOT NULL CHECK (authorization_kind IN ('own','granted','own_or_granted')),
          grant_id           TEXT,
          grant_revision     INTEGER CHECK (grant_revision>0 OR grant_revision IS NULL),
          resource_id        TEXT,
          snapshot_sequence  INTEGER NOT NULL,
          after_created_at   TEXT,
          after_job_id       TEXT,
          expires_at         TEXT NOT NULL,
          created_at         TEXT NOT NULL,
          CHECK ((grant_id IS NULL) = (grant_revision IS NULL))
        ) STRICT;
        CREATE INDEX web_job_projection_cursors_expiry_idx ON web_job_projection_cursors(expires_at);
      `);
      db.prepare(`INSERT INTO web_job_projection_schema(singleton,version) VALUES(1,3)
        ON CONFLICT(singleton) DO UPDATE SET version=excluded.version`).run();
    }
    db.exec(`
      DROP TRIGGER IF EXISTS web_job_projection_update;
      CREATE TRIGGER web_job_projection_update
        AFTER UPDATE ON jobs WHEN new.source='web' AND (
          old.status IS NOT new.status OR old.updated_at IS NOT new.updated_at
          OR old.completed_at IS NOT new.completed_at
        ) BEGIN
          INSERT INTO web_job_projection_events(job_id,event_kind,created_at)
          VALUES(new.job_id,'updated',new.updated_at);
        END;
    `);
  };
  if (db.inTransaction) upgrade(); else db.transaction(upgrade).immediate();
  const initialize = () => {
    const claimed = db.prepare(`INSERT OR IGNORE INTO web_job_projection_state(singleton,initialized_at)
      VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run().changes;
    if (claimed === 0) return;
    db.exec(`INSERT INTO web_job_projection_events(job_id,event_kind,created_at)
      SELECT jobs.job_id,'snapshot',jobs.updated_at FROM jobs WHERE jobs.source='web'
      AND NOT EXISTS (SELECT 1 FROM web_job_projection_events events WHERE events.job_id=jobs.job_id);`);
  };
  if (db.inTransaction) initialize(); else db.transaction(initialize).immediate();
}
function ensureWebCommandSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_command_receipts (
      receipt_id       TEXT PRIMARY KEY,
      instance_id      TEXT NOT NULL,
      tenant_id        TEXT NOT NULL,
      principal_id     TEXT NOT NULL,
      operation        TEXT NOT NULL CHECK (operation IN ('submit', 'cancel')),
      canonical_sha256 TEXT NOT NULL CHECK (length(canonical_sha256) = 64),
      job_id            TEXT NOT NULL REFERENCES jobs(job_id),
      source_event_id   TEXT NOT NULL REFERENCES events(event_id),
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS web_command_receipts_owner_idx
      ON web_command_receipts(instance_id, tenant_id, principal_id, updated_at);
  `);
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
  assertSupportedWebJobProjectionSchema(db);
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
    const webProjectionInstalled = db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_job_projection_events'
    `).get() !== undefined;
    const jobsHasKey = (db.pragma("table_info(jobs)") as Array<{ name: string }>).some(({ name }) => name === "job_key");
    const hasWebReceipts = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_command_receipts'").get() !== undefined;
    if (hasWebReceipts) db.exec(`
      CREATE TABLE web_command_receipts_v3_backup AS SELECT * FROM web_command_receipts;
      DROP TABLE web_command_receipts;
    `);
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
    migrationHook("groups_backfilled");
    if (webProjectionInstalled) ensureWebJobProjectionSchema(db);
    if (hasWebReceipts) {
      ensureWebCommandSchema(db);
      db.exec(`
        INSERT INTO web_command_receipts SELECT * FROM web_command_receipts_v3_backup;
        DROP TABLE web_command_receipts_v3_backup;
      `);
    }
    db.pragma(`user_version = ${targetWrite}`);
  };
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  if (targetWrite >= 3 && currentVersion < 3) outerTransaction ? migrateV3() : db.transaction(migrateV3)();
  if (targetWrite === 2 && currentVersion === 2) ensureV2BridgeSchema(db);
  if ((db.pragma("user_version", { simple: true }) as number) >= 3) {
    ensureJobsRunnableFairIndex(db);
    ensureJobsWorkspaceJobIndex(db);
    ensureJobsStatusJobIndex(db);
  }
  ensureWebCommandSchema(db);
}

export interface WebCommandIdentity {
  instance_id: string;
  tenant_id: string;
  principal_id: string;
}
export interface WebCommandReceipt {
  receipt_id: string;
  instance_id: string;
  tenant_id: string;
  principal_id: string;
  operation: "submit" | "cancel";
  canonical_sha256: string;
  job_id: string;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface WebJobReadIdentity {
  instance_id: string;
  tenant_id: string;
  principal_id: string;
  authorization_kind: "own" | "granted" | "own_or_granted";
}
export interface WebJobPage {
  rows: JobRow[];
  next_cursor: string | null;
  snapshot_sequence: number;
}
export interface WebJobChangePage {
  rows: Array<{ sequence: number; job_id: string; event_kind: "snapshot"|"updated"|"progress"|"deleted"; created_at: string }>;
  next_cursor: string;
  reset_required: boolean;
}
export interface WebJobSnapshot {
  row: JobRow;
  event_cursor: string;
}
interface WebProjectionCursorRow {
  cursor_digest: string;
  cursor_kind: "list"|"events";
  instance_id: string;
  tenant_id: string;
  principal_id: string;
  authorization_kind: "own" | "granted" | "own_or_granted";
  grant_id: string | null;
  grant_revision: number | null;
  resource_id: string | null;
  snapshot_sequence: number;
  after_created_at: string | null;
  after_job_id: string | null;
  expires_at: string;
  created_at: string;
}

export class DispatcherDatabase {
  private readonly db: Database.Database;
  private readonly jobAdmissionLimits: JobAdmissionLimits;
  private readonly schemaWrite: 2 | 3;
  private webJobProjectionReady = false;

  constructor(
    databasePath: string,
    jobAdmissionLimits: JobAdmissionLimits = jobResourceDefaults,
  ) {
    if (
      !Number.isSafeInteger(jobAdmissionLimits.jobsPerEventMax) ||
      jobAdmissionLimits.jobsPerEventMax <= 0 ||
      jobAdmissionLimits.jobsPerEventMax > jobResourceHardLimits.jobsPerEventMax
    ) {
      throw new Error(`jobsPerEventMax must be a positive integer at most ${jobResourceHardLimits.jobsPerEventMax}`);
    }
    if (
      !Number.isSafeInteger(jobAdmissionLimits.jobObjectiveTotalMaxBytes) ||
      jobAdmissionLimits.jobObjectiveTotalMaxBytes <= 0
    ) {
      throw new Error("jobObjectiveTotalMaxBytes must be a positive integer");
    }
    this.jobAdmissionLimits = { ...jobAdmissionLimits };
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(databasePath), 0o700);
    this.db = new Database(databasePath);
    fs.chmodSync(databasePath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 2000");
    this.db.pragma("foreign_keys = ON");
    const existingVersion = this.db.pragma("user_version", { simple: true }) as number;
    this.schemaWrite = !process.env.DONA_RELEASE_MANIFEST_PATH && existingVersion === 2
      ? 2
      : dispatcherSchemaCompatibility.write;
    migrateDispatcherDatabase(this.db, () => {}, false, this.schemaWrite);
  }

  close(): void {
    this.db.close();
  }

  assertReadableWritable(): void {
    this.db.prepare("SELECT 1").get();
    this.db.prepare("UPDATE events SET updated_at = updated_at WHERE 0").run();
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
    const parsedRequest = parseCreateJobRequest(request);
    const sourceEvent = this.getRequired(parsedRequest.source_event_id);
    const jobKey = parsedRequest.job_key ?? legacyJobKey;
    const canonicalPayloadSha256 = canonicalJobPayloadSha256(parsedRequest);
    const objectiveUtf8Bytes = Buffer.byteLength(parsedRequest.objective, "utf8");
    const workspaceJson = serializeJobWorkspace(
      parsedRequest.workspace,
      canonicalPayloadSha256,
      objectiveUtf8Bytes,
    );
    const replyTarget = sourceEvent.reply_target_json
      ? JSON.parse(sourceEvent.reply_target_json) as Record<string, unknown>
      : {};
    const subject = JSON.parse(sourceEvent.subject_json) as Record<string, unknown>;
    const webSource = sourceEvent.source === "web" && sourceEvent.reply_target_json === null;
    const workspaceId = webSource ? stringValue(subject.tenant_id) : stringValue(replyTarget.workspace_id);
    const channelId = webSource ? undefined : stringValue(replyTarget.channel_id);
    const threadTs = webSource ? undefined : stringValue(replyTarget.thread_ts);
    if ((!webSource && (
      sourceEvent.source !== "slack" || stringValue(replyTarget.kind) !== "slack_thread" ||
      !workspaceId || !channelId || !threadTs
    )) || (webSource && (!workspaceId || !stringValue(subject.instance_id) || !stringValue(subject.principal_id)))) {
      throw new Error(`Event ${sourceEvent.event_id} does not have a Slack thread reply target`);
    }

    return this.db.transaction((): CreateJobResult => {
      const existing = this.db
        .prepare("SELECT * FROM jobs WHERE source_event_id = ? AND job_key = ?")
        .get(parsedRequest.source_event_id, jobKey) as JobRow | undefined;
      if (existing) {
        const existingCanonicalPayloadSha256 = jobCreationPayloadSha256FromWorkspace(
          JSON.parse(existing.workspace_json) as unknown,
        );
        if (existingCanonicalPayloadSha256 === undefined && jobKey !== legacyJobKey) {
          throw new JobCreationError(
            "job_idempotency_conflict",
            `Job key ${jobKey} has no immutable canonical payload fingerprint`,
          );
        }
        if (existingCanonicalPayloadSha256 !== undefined && existingCanonicalPayloadSha256 !== canonicalPayloadSha256) {
          throw new JobCreationError(
            "job_idempotency_conflict",
            `Job key ${jobKey} already exists with a different canonical payload`,
          );
        }
        return {
          row: existing,
          outcome: "reused",
          duplicate: true,
        };
      }

      const currentSourceEvent = this.getRequired(parsedRequest.source_event_id);
      if (["completed", "blocked", "needs_review", "dead_letter"].includes(currentSourceEvent.status)) {
        throw new JobCreationError(
          "job_group_closed",
          `Job group ${parsedRequest.source_event_id} is closed because its source event is ${currentSourceEvent.status}`,
        );
      }
      const group = this.getJobGroup(parsedRequest.source_event_id);
      if (group?.sealed_at) {
        throw new JobCreationError("job_group_closed", `Job group ${parsedRequest.source_event_id} is sealed`);
      }
      if (group?.notification_mode === "grouped" && parsedRequest.job_key === undefined) {
        throw new JobCreationError(
          "job_group_closed",
          `Grouped job group ${parsedRequest.source_event_id} requires an explicit job key`,
        );
      }
      const hasLegacyDefaultJob = group?.notification_mode === "legacy" && this.db.prepare(`
        SELECT 1 FROM jobs WHERE source_event_id = ? AND job_key = ?
      `).get(parsedRequest.source_event_id, legacyJobKey) !== undefined;
      if (hasLegacyDefaultJob && jobKey !== legacyJobKey) {
        throw new JobCreationError(
          "job_group_closed",
          `Legacy job group ${parsedRequest.source_event_id} does not accept additional job keys`,
        );
      }

      const admittedJobs = this.db.prepare(`
        SELECT objective, workspace_json FROM jobs WHERE source_event_id = ?
      `).all(parsedRequest.source_event_id) as Array<Pick<JobRow, "objective" | "workspace_json">>;
      if (this.schemaWrite === 2 && (parsedRequest.job_key !== undefined || admittedJobs.length > 0)) {
        throw new Error("multi_job_feature_disabled_for_schema_v2_bridge");
      }
      if (admittedJobs.length >= this.jobAdmissionLimits.jobsPerEventMax) {
        throw new JobCreationError(
          "job_group_limit_exceeded",
          "Job group jobs-per-event limit exceeded",
          {
            resource: "jobs_per_event",
            current: admittedJobs.length,
            attempted: admittedJobs.length + 1,
            maximum: this.jobAdmissionLimits.jobsPerEventMax,
          },
        );
      }
      const currentObjectiveBytes = admittedJobs.reduce((total, row) => {
        const workspace = JSON.parse(row.workspace_json) as unknown;
        // Older v3 and migrated v2 rows do not have the immutable byte count. Queued steers only append,
        // so the persisted objective is a fail-closed upper bound rather than an unsafe undercount.
        return total + (
          jobCreationObjectiveBytesFromWorkspace(workspace) ?? Buffer.byteLength(row.objective, "utf8")
        );
      }, 0);
      const attemptedObjectiveBytes = currentObjectiveBytes + objectiveUtf8Bytes;
      if (attemptedObjectiveBytes > this.jobAdmissionLimits.jobObjectiveTotalMaxBytes) {
        throw new JobCreationError(
          "job_group_limit_exceeded",
          "Job group objective UTF-8 byte limit exceeded",
          {
            resource: "objective_utf8_bytes_per_event",
            current: currentObjectiveBytes,
            attempted: attemptedObjectiveBytes,
            maximum: this.jobAdmissionLimits.jobObjectiveTotalMaxBytes,
          },
        );
      }

      const jobId = jobAgentName(
        `job_${ulid(at.getTime()).toLowerCase()}`,
        parsedRequest.objective,
      );
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
      const resultPath = path.join(resultDir, `${jobId}.json`);
      const timestamp = at.toISOString();
      if (!group) {
        this.db.prepare(`
          INSERT INTO job_groups (
            source_event_id, sealed_at, notification_mode, attention_event_id,
            all_terminal_event_id, created_at, updated_at
          ) VALUES (?, NULL, ?, NULL, NULL, ?, ?)
        `).run(
          parsedRequest.source_event_id,
          jobKey === legacyJobKey ? "legacy" : "grouped",
          timestamp,
          timestamp,
        );
      }
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
        webSource ? stringValue(subject.principal_id) : stringValue(subject.actor_id),
        parsedRequest.objective,
        workspaceJson,
        timestamp,
        workspacePath,
        resultPath,
        jobId,
        timestamp,
        timestamp,
      );
      return { row: this.getJobRequired(jobId), outcome: "created", duplicate: false };
    }).immediate();
  }

  createWebJob(input: WebCommandIdentity & { idempotency_key: string; objective: string; workspace: CreateJobRequest["workspace"] },
    workspaceRoot: string, resultDir: string, at = new Date()): { outcome: "created" | "reused"; row: JobRow; receipt: WebCommandReceipt } {
    if (!/^[0-9a-f]{64}$/.test(input.idempotency_key)) throw new Error("web_command_invalid");
    for (const value of [input.instance_id, input.tenant_id, input.principal_id]) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("web_command_invalid");
    }
    const parsed = parseCreateJobRequest({ source_event_id: "evt_00000000000000000000000000", objective: input.objective, workspace: input.workspace });
    const canonical = canonicalJobPayloadSha256(parsed);
    const receiptId = `web_submit_${input.idempotency_key}`;
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM web_command_receipts WHERE receipt_id = ?")
        .get(receiptId) as WebCommandReceipt | undefined;
      if (existing) {
        if (existing.operation !== "submit" || existing.canonical_sha256 !== canonical || existing.instance_id !== input.instance_id
          || existing.tenant_id !== input.tenant_id || existing.principal_id !== input.principal_id) throw new JobCreationError("job_idempotency_conflict", "Web command receipt conflicts with the canonical payload");
        return { outcome: "reused" as const, row: this.getJobRequired(existing.job_id), receipt: existing };
      }
      const active = this.db.prepare(`SELECT COUNT(*) AS count FROM jobs
        WHERE source='web' AND workspace_id=? AND actor_id=?
          AND status NOT IN ('completed','failed','cancelled')`)
        .get(input.tenant_id, input.principal_id) as { count: number };
      if (active.count >= this.jobAdmissionLimits.jobsPerEventMax) throw new JobCreationError("job_group_limit_exceeded",
        "Web owner active-job limit exceeded", { resource: "jobs_per_event", current: active.count,
          attempted: active.count + 1, maximum: this.jobAdmissionLimits.jobsPerEventMax });
      const timestamp = at.toISOString();
      const source = this.enqueue({ schema_version: 1, source: "web", external_event_id: `command:${input.idempotency_key}`,
        type: "web_job_submit", occurred_at: timestamp, subject: { instance_id: input.instance_id, tenant_id: input.tenant_id,
          principal_id: input.principal_id }, payload: { canonical_payload_sha256: canonical }, reply_target: null }, at);
      if (source.duplicate || source.payloadMismatch) throw new JobCreationError("job_idempotency_conflict", "Web command event conflicts with the canonical payload");
      const created = this.createJob({ source_event_id: source.row.event_id, objective: parsed.objective, workspace: parsed.workspace }, workspaceRoot, resultDir, at);
      this.db.prepare("UPDATE events SET status='completed', completed_at=?, updated_at=? WHERE event_id=? AND status='queued'")
        .run(timestamp, timestamp, source.row.event_id);
      this.db.prepare("UPDATE job_groups SET sealed_at=?, updated_at=? WHERE source_event_id=? AND sealed_at IS NULL")
        .run(timestamp, timestamp, source.row.event_id);
      this.db.prepare(`INSERT INTO web_command_receipts
        (receipt_id,instance_id,tenant_id,principal_id,operation,canonical_sha256,job_id,source_event_id,created_at,updated_at)
        VALUES (?,?,?,?, 'submit', ?,?,?,?,?)`).run(receiptId, input.instance_id, input.tenant_id, input.principal_id,
          canonical, created.row.job_id, source.row.event_id, timestamp, timestamp);
      const receipt = this.db.prepare("SELECT * FROM web_command_receipts WHERE receipt_id=?").get(receiptId) as WebCommandReceipt;
      return { outcome: "created" as const, row: created.row, receipt };
    }).immediate();
  }

  getWebCommandReceipt(receiptId: string, identity: WebCommandIdentity): WebCommandReceipt | undefined {
    const row = this.db.prepare("SELECT * FROM web_command_receipts WHERE receipt_id=?").get(receiptId) as WebCommandReceipt | undefined;
    return row && row.instance_id === identity.instance_id && row.tenant_id === identity.tenant_id
      && row.principal_id === identity.principal_id ? row : undefined;
  }

  assertWebJobOwner(jobId: string, identity: WebCommandIdentity): JobRow {
    const job = this.getJobRequired(jobId), event = this.getRequired(job.source_event_id);
    const subject = JSON.parse(event.subject_json) as Record<string, unknown>;
    if (job.source !== "web" || event.source !== "web" || stringValue(subject.instance_id) !== identity.instance_id
      || stringValue(subject.tenant_id) !== identity.tenant_id || stringValue(subject.principal_id) !== identity.principal_id) {
      throw new Error("web_job_owner_mismatch");
    }
    return job;
  }

  recordWebCancelReceipt(receiptId: string, canonicalSha256: string, identity: WebCommandIdentity, jobId: string, at = new Date()): WebCommandReceipt {
    if (!/^web_cancel_[0-9a-f]{64}$/.test(receiptId) || !/^[0-9a-f]{64}$/.test(canonicalSha256)) throw new Error("web_command_invalid");
    const job = this.assertWebJobOwner(jobId, identity), timestamp = at.toISOString();
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM web_command_receipts WHERE receipt_id=?").get(receiptId) as WebCommandReceipt | undefined;
      if (existing) {
        if (existing.operation !== "cancel" || existing.canonical_sha256 !== canonicalSha256 || existing.job_id !== jobId
          || existing.instance_id !== identity.instance_id || existing.tenant_id !== identity.tenant_id || existing.principal_id !== identity.principal_id)
          throw new Error("web_command_conflict");
        return existing;
      }
      this.db.prepare(`INSERT INTO web_command_receipts
        (receipt_id,instance_id,tenant_id,principal_id,operation,canonical_sha256,job_id,source_event_id,created_at,updated_at)
        VALUES (?,?,?,?, 'cancel', ?,?,?,?,?)`).run(receiptId, identity.instance_id, identity.tenant_id, identity.principal_id,
          canonicalSha256, jobId, job.source_event_id, timestamp, timestamp);
      return this.db.prepare("SELECT * FROM web_command_receipts WHERE receipt_id=?").get(receiptId) as WebCommandReceipt;
    })();
  }

  getJob(jobId: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
  }

  listWebJobs(identity: WebJobReadIdentity, limit: number, cursor?: string, at = new Date()): WebJobPage {
    this.ensureWebJobProjectionReady();
    this.assertWebReadIdentity(identity);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("web_job_read_invalid");
    return this.db.transaction(() => {
      const now = at.toISOString();
      let snapshot = this.webProjectionHead(), afterCreated: string | null = null, afterJob: string | null = null;
      if (cursor !== undefined) {
        const saved = this.webProjectionCursor(cursor, "list", identity, null, now);
        snapshot = saved.snapshot_sequence; afterCreated = saved.after_created_at; afterJob = saved.after_job_id;
        if (!afterCreated || !afterJob) throw new Error("web_job_cursor_invalid");
      }
      const rows = this.db.prepare(`
        SELECT jobs.* FROM jobs JOIN events source_event ON source_event.event_id=jobs.source_event_id
        WHERE ${this.webJobAccessSql()}
          AND EXISTS (SELECT 1 FROM web_job_projection_events first_event
            WHERE first_event.job_id=jobs.job_id AND first_event.sequence<=?)
          AND (? IS NULL OR jobs.created_at < ? OR (jobs.created_at = ? AND jobs.job_id < ?))
        ORDER BY jobs.created_at DESC,jobs.job_id DESC LIMIT ?
      `).all(...this.webJobAccessParameters(identity, now), snapshot,
        afterCreated, afterCreated, afterCreated, afterJob, limit + 1) as JobRow[];
      const visible = rows.slice(0, limit), more = rows.length > limit;
      const next = more && visible.length > 0 ? this.issueWebProjectionCursor("list", identity, null, snapshot,
        visible.at(-1)!.created_at, visible.at(-1)!.job_id, at, 15 * 60_000) : null;
      return { rows: visible, next_cursor: next, snapshot_sequence: snapshot };
    })();
  }

  getWebJobForRead(jobId: string, identity: WebJobReadIdentity, at = new Date()): JobRow | undefined {
    this.ensureWebJobProjectionReady();
    this.assertWebReadIdentity(identity);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw new Error("web_job_read_invalid");
    return this.db.prepare(`SELECT jobs.* FROM jobs JOIN events source_event ON source_event.event_id=jobs.source_event_id
      WHERE jobs.job_id=? AND ${this.webJobAccessSql()}`)
      .get(jobId, ...this.webJobAccessParameters(identity, at.toISOString())) as JobRow | undefined;
  }

  webJobEventCursor(identity: WebJobReadIdentity, jobId: string, at = new Date()): string {
    const snapshot = this.webJobSnapshot(identity, jobId, at);
    if (!snapshot) throw new Error("web_job_not_found");
    return snapshot.event_cursor;
  }

  webJobSnapshot(identity: WebJobReadIdentity, jobId: string, at = new Date()): WebJobSnapshot | undefined {
    this.ensureWebJobProjectionReady();
    this.assertWebReadIdentity(identity);
    return this.db.transaction(() => {
      const row = this.getWebJobForRead(jobId, identity, at);
      if (!row) return undefined;
      const event_cursor = this.issueWebProjectionCursor("events", identity, jobId, this.webProjectionHead(), null, null, at, 60 * 60_000);
      return { row, event_cursor };
    }).immediate();
  }

  listWebJobChanges(identity: WebJobReadIdentity, jobId: string, cursor: string, limit = 50, at = new Date()): WebJobChangePage {
    this.ensureWebJobProjectionReady();
    this.assertWebReadIdentity(identity);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !this.getWebJobForRead(jobId, identity, at)) throw new Error("web_job_read_invalid");
    return this.db.transaction(() => {
      const saved = this.webProjectionCursor(cursor, "events", identity, jobId, at.toISOString());
      const retention = this.db.prepare("SELECT pruned_through_sequence FROM web_job_projection_retention WHERE singleton=1")
        .get() as { pruned_through_sequence: number };
      if (saved.snapshot_sequence < retention.pruned_through_sequence) {
        return { rows: [], next_cursor: this.issueWebProjectionCursor("events", identity, jobId,
          this.webProjectionHead(), null, null, at, 60 * 60_000), reset_required: true };
      }
      const rows = this.db.prepare(`SELECT sequence,job_id,event_kind,created_at FROM web_job_projection_events
        WHERE job_id=? AND sequence>? ORDER BY sequence LIMIT ?`)
        .all(jobId, saved.snapshot_sequence, limit) as WebJobChangePage["rows"];
      const sequence = rows.at(-1)?.sequence ?? saved.snapshot_sequence;
      return { rows, next_cursor: this.issueWebProjectionCursor("events", identity, jobId, sequence, null, null, at, 60 * 60_000), reset_required: false };
    })();
  }

  recordWebJobProgress(jobId: string, sequence: number, updatedAt: string, receivedAt = new Date()): boolean {
    this.ensureWebJobProjectionReady();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId) || !Number.isSafeInteger(sequence) || sequence < 0
      || !Number.isFinite(Date.parse(updatedAt)) || new Date(updatedAt).toISOString() !== updatedAt
      || !Number.isFinite(receivedAt.getTime())) throw new Error("web_job_progress_invalid");
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT sequence FROM web_job_progress_versions WHERE job_id=?")
        .get(jobId) as { sequence: number } | undefined;
      if (existing && existing.sequence >= sequence) return false;
      this.db.prepare(`INSERT INTO web_job_progress_versions(job_id,sequence,updated_at) VALUES(?,?,?)
        ON CONFLICT(job_id) DO UPDATE SET sequence=excluded.sequence,updated_at=excluded.updated_at
        WHERE excluded.sequence>web_job_progress_versions.sequence`).run(jobId, sequence, updatedAt);
      this.db.prepare("INSERT INTO web_job_projection_events(job_id,event_kind,created_at) VALUES(?,'progress',?)")
        .run(jobId, receivedAt.toISOString());
      return true;
    })();
  }

  pruneWebJobProjection(before: Date, at = new Date(), limit = 1000): { events: number; cursors: number } {
    this.ensureWebJobProjectionReady();
    if (!Number.isFinite(before.getTime()) || before.getTime() > at.getTime()
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error("web_job_retention_invalid");
    return this.db.transaction(() => {
      const cutoff=before.toISOString(),eligible=`SELECT projection.sequence FROM web_job_projection_events projection
        WHERE projection.created_at<? AND (NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.job_id=projection.job_id)
          OR projection.sequence<>(SELECT MIN(anchor.sequence) FROM web_job_projection_events anchor WHERE anchor.job_id=projection.job_id))
        ORDER BY projection.sequence LIMIT ?`;
      const candidate=this.db.prepare(`SELECT MAX(sequence) AS sequence FROM (${eligible})`).get(cutoff,limit) as {sequence:number|null};
      const events = this.db.prepare(`DELETE FROM web_job_projection_events WHERE sequence IN (${eligible})`).run(cutoff,limit).changes;
      if(candidate.sequence!==null)this.db.prepare(`UPDATE web_job_projection_retention SET pruned_through_sequence=MAX(pruned_through_sequence,?) WHERE singleton=1`)
        .run(candidate.sequence);
      const cursors = this.db.prepare(`DELETE FROM web_job_projection_cursors WHERE cursor_digest IN (
        SELECT cursor_digest FROM web_job_projection_cursors WHERE expires_at<=? ORDER BY expires_at,cursor_digest LIMIT ?
      )`).run(at.toISOString(),limit).changes;
      return { events, cursors };
    })();
  }

  getJobGroup(sourceEventId: string): JobGroupRow | undefined {
    return this.db.prepare("SELECT * FROM job_groups WHERE source_event_id = ?")
      .get(sourceEventId) as JobGroupRow | undefined;
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
      const timestamp = at.toISOString();
      const changed = this.db.prepare(`
        UPDATE job_groups SET ${field} = ?, updated_at = ?
        WHERE source_event_id = ? AND ${field} IS NULL
      `).run(eventId, timestamp, sourceEventId).changes;
      return { row: this.getJobGroupRequired(sourceEventId), claimed: changed === 1 };
    }).immediate();
  }

  listJobs(status?: JobStatus, limit = 100): JobRow[] {
    if (status) {
      return this.db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY created_at LIMIT ?").all(status, limit) as JobRow[];
    }
    return this.db.prepare("SELECT * FROM jobs ORDER BY created_at LIMIT ?").all(limit) as JobRow[];
  }

  listNonterminalWorkspaceJobIds(workspaceId:string,afterJobId="",limit=500):string[] {
    return (this.db.prepare(`SELECT job_id FROM jobs WHERE workspace_id=? AND job_id>? AND status NOT IN ('blocked','completed','failed','cancelled','needs_review') ORDER BY job_id LIMIT ?`).all(workspaceId,afterJobId,limit) as Array<{job_id:string}>).map((row)=>row.job_id);
  }
  listNonterminalJobs(afterJobId="",limit=500):JobRow[] {return this.db.prepare(`SELECT * FROM jobs WHERE job_id>? AND status NOT IN ('blocked','completed','failed','cancelled','needs_review') ORDER BY job_id LIMIT ?`).all(afterJobId,limit) as JobRow[];}
  listJobsAfter(afterJobId="",limit=500):JobRow[] {return this.db.prepare("SELECT * FROM jobs WHERE job_id>? ORDER BY job_id LIMIT ?").all(afterJobId,limit) as JobRow[];}
  listStatusJobsAfter(status:JobStatus,afterJobId="",limit=500):JobRow[] {return this.db.prepare("SELECT * FROM jobs WHERE status=? AND job_id>? ORDER BY job_id LIMIT ?").all(status,afterJobId,limit) as JobRow[];}

  listThreadJobs(workspaceId: string, channelId: string, threadTs: string, limit = 100): JobRow[] {
    return this.db.prepare(`
      SELECT * FROM jobs
      WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(workspaceId, channelId, threadTs, limit) as JobRow[];
  }

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

  listJobsNeedingNotification(limit = 100): JobRow[] {
    return this.db.prepare(`
      SELECT jobs.* FROM jobs
      JOIN job_groups ON job_groups.source_event_id = jobs.source_event_id
      WHERE jobs.status IN ('blocked', 'completed', 'failed', 'cancelled', 'needs_review')
        AND (
          jobs.completion_event_id IS NULL
          OR (
            job_groups.notification_mode = 'grouped'
            AND job_groups.attention_event_id IS NOT NULL
            AND job_groups.all_terminal_event_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM jobs AS sibling
              WHERE sibling.source_event_id = jobs.source_event_id
                AND sibling.status NOT IN ('completed', 'failed', 'cancelled', 'needs_review')
            )
          )
        )
        AND (job_groups.notification_mode = 'legacy' OR job_groups.sealed_at IS NOT NULL)
      ORDER BY
        CASE WHEN jobs.status IN ('blocked', 'failed', 'needs_review') THEN 0 ELSE 1 END,
        jobs.updated_at,
        jobs.job_id
      LIMIT ?
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
        last_error_code = 'ambiguous_job_control',
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

  setJobRuntime(jobId: string, herdrWorkspaceId: string, herdrPaneId: string): void {
    this.updateJob(jobId, ["preparing"], "preparing", {
      herdr_workspace_id: herdrWorkspaceId,
      herdr_pane_id: herdrPaneId,
    });
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

  saveJobResult(jobId: string, result: JobResultEnvelope, resultPath: string): void {
    const status: JobStatus = result.status === "completed" ? "completed" : "failed";
    this.updateJob(jobId, ["running"], status, {
      result_json: stableStringify(result),
      result_path: resultPath,
      completed_at: result.completed_at,
      last_error_code: result.status === "failed" ? "agent_reported_failure" : null,
      last_error_message: result.status === "failed" ? result.summary : null,
    });
  }

  appendQueuedJobInstruction(jobId: string, sourceEventId: string, instruction: string): JobRow {
    this.assertJobSourceMatchesThread(jobId, sourceEventId);
    const row = this.getJobRequired(jobId);
    if (row.steer_event_id === sourceEventId && row.steer_state === "accepted") return row;
    if (!["queued", "retryable_failed"].includes(row.status)) throw new Error(`Job ${jobId} is not waiting to start`);
    this.db.prepare(`
      UPDATE jobs SET objective = objective || ?, steer_event_id = ?, steer_state = 'accepted', updated_at = ?
      WHERE job_id = ?
    `).run(`\n\n[DONA_FOLLOW_UP]\n${instruction}\n[/DONA_FOLLOW_UP]`, sourceEventId, nowUtc(), jobId);
    return this.getJobRequired(jobId);
  }

  beginJobSteer(jobId: string, sourceEventId: string): { row: JobRow; duplicate: boolean } {
    this.assertJobSourceMatchesThread(jobId, sourceEventId);
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
    if (!["queued", "preparing", "dispatching", "retryable_failed", "running", "blocked"].includes(row.status)) {
      throw new Error(`Job ${jobId} in status ${row.status} cannot be cancelled`);
    }
    this.updateJob(jobId, [row.status], "cancelling", { completion_event_id: null });
    return this.getJobRequired(jobId);
  }

  beginWebJobCancellation(jobId: string, identity: WebCommandIdentity): JobRow {
    const row = this.assertWebJobOwner(jobId, identity);
    if (row.status === "cancelled") return row;
    if (row.status === "cancelling") throw new Error("web_cancel_acceptance_unknown");
    if (!["queued", "preparing", "dispatching", "retryable_failed", "running", "blocked", "needs_review"].includes(row.status)) {
      throw new Error(`web_job_terminal:${row.status}`);
    }
    this.updateJob(jobId, [row.status], "cancelling", { completion_event_id: null });
    return this.getJobRequired(jobId);
  }

  markJobCancelled(jobId: string, reason: string, at = new Date()): void {
    this.updateJob(jobId, ["cancelling"], "cancelled", {
      completed_at: at.toISOString(),
      last_error_code: "cancelled",
      last_error_message: reason,
    });
  }

  enqueueJobNotification(
    jobId: string,
    at = new Date(),
    notificationHook: JobNotificationHook = () => {},
  ): EnqueueResult {
    return this.db.transaction(() => {
      const job = this.getJobRequired(jobId);
      const timestamp = at.toISOString();
      let group = this.getJobGroupRequired(job.source_event_id);
      if (job.completion_event_id) {
        const existing = this.get(job.completion_event_id);
        if (!existing) throw new Error(`Job ${jobId} references a missing completion event`);
        const needsAllTerminal = group.notification_mode === "grouped" &&
          group.attention_event_id !== null && group.all_terminal_event_id === null &&
          this.db.prepare(`
            SELECT 1 FROM jobs
            WHERE source_event_id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'needs_review')
            LIMIT 1
          `).get(job.source_event_id) === undefined;
        if (!needsAllTerminal) return { row: existing, duplicate: true, payloadMismatch: false };
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
      if (sourceEvent.source === "web") {
        if (!job.completion_event_id) this.db.prepare("UPDATE jobs SET completion_event_id=?, updated_at=? WHERE job_id=?")
          .run(sourceEvent.event_id, timestamp, jobId);
        return { row: sourceEvent, duplicate: job.completion_event_id !== null, payloadMismatch: false };
      }
      const result = job.result_json ? JSON.parse(job.result_json) as Record<string, unknown> : null;
      const snapshot = group.notification_mode === "grouped"
        ? this.buildJobGroupSnapshot(job.source_event_id, group, job)
        : undefined;
      const envelope: EventEnvelope = {
        schema_version: 1,
        source: "dona_job",
        external_event_id: `${job.job_id}:${job.status}${job.completion_event_id ? ":all_terminal" : ""}`,
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
      notificationHook("event_enqueued");
      if (snapshot && snapshot.transition !== "progress") {
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

  assertJobSourceMatchesThread(jobId: string, sourceEventId: string, allowNotification = false): void {
    const job = this.getJobRequired(jobId);
    const sourceEvent = this.getRequired(sourceEventId);
    const replyTarget = sourceEvent.reply_target_json
      ? JSON.parse(sourceEvent.reply_target_json) as Record<string, unknown>
      : {};
    if (
      (sourceEvent.source !== "slack" && !(allowNotification && sourceEvent.source === "dona_job")) ||
      stringValue(replyTarget.workspace_id) !== job.workspace_id ||
      stringValue(replyTarget.channel_id) !== job.channel_id ||
      stringValue(replyTarget.thread_ts) !== job.thread_ts
    ) {
      throw new Error(`Event ${sourceEventId} does not belong to job ${jobId}'s Slack thread`);
    }
  }

  hasBlockedEvent(): boolean {
    return this.db.prepare("SELECT 1 FROM events WHERE status = 'blocked' LIMIT 1").get() !== undefined;
  }

  nextWaiting(): EventRow | undefined {
    return this.db
      .prepare("SELECT * FROM events WHERE status = 'waiting_agent' ORDER BY sequence LIMIT 1")
      .get() as EventRow | undefined;
  }

  nextAvailable(at = new Date()): EventRow | undefined {
    const head = this.db
      .prepare(`
        SELECT * FROM events
        WHERE status IN ('queued', 'retryable_failed') AND source != 'dona_update'
        ORDER BY sequence LIMIT 1
      `)
      .get() as EventRow | undefined;
    return head && head.available_at <= at.toISOString() ? head : undefined;
  }

  updateEventsNeedingNotification(): EventRow[] {
    return this.db.prepare(`
      SELECT * FROM events
      WHERE source = 'dona_update' AND status IN ('queued', 'retryable_failed')
      ORDER BY sequence
    `).all() as EventRow[];
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
      const timestamp = at.toISOString();
      this.db.prepare(`
        UPDATE job_groups SET sealed_at = ?, updated_at = ?
        WHERE sealed_at IS NULL AND source_event_id IN (
          SELECT event_id FROM events WHERE status = 'dispatching'
        )
      `).run(timestamp, timestamp);
      return this.db.prepare(`
        UPDATE events SET
          status = 'needs_review',
          last_error_code = 'stale_dispatching',
          last_error_message = 'Dispatcher restarted while prompt acceptance was unknown',
          updated_at = ?
        WHERE status = 'dispatching'
      `).run(timestamp).changes;
    }).immediate();
  }

  beginDispatch(eventId: string, resultPath: string, at = new Date()): EventRow {
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
    if (changed !== 1) throw new Error(`Event ${eventId} is no longer dispatchable`);
    return this.get(eventId)!;
  }

  markWaiting(eventId: string, at = new Date()): void {
    this.transition(eventId, ["dispatching"], "waiting_agent", {
      prompt_accepted_at: at.toISOString(),
      last_error_code: null,
      last_error_message: null,
    });
  }

  markBlocked(eventId: string, message: string, from: EventStatus[] = ["queued", "retryable_failed", "dispatching", "waiting_agent"]): void {
    this.transition(eventId, from, "blocked", {
      last_error_code: "agent_blocked",
      last_error_message: message,
    });
  }

  markNeedsReview(eventId: string, code: string, message: string): void {
    this.transition(eventId, ["dispatching", "waiting_agent"], "needs_review", {
      last_error_code: code,
      last_error_message: message,
    });
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
      if (status === "dead_letter") this.sealJobGroupIfPresent(eventId, at.toISOString());
      return this.get(eventId)!;
    }).immediate();
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
      this.sealJobGroupIfPresent(eventId, at.toISOString());
      return this.get(eventId)!;
    }).immediate();
  }

  recordWaitingError(eventId: string, code: string, message: string, at = new Date()): void {
    this.db
      .prepare(`
        UPDATE events SET last_error_code = ?, last_error_message = ?, updated_at = ?
        WHERE event_id = ? AND status = 'waiting_agent'
      `)
      .run(code, message, at.toISOString(), eventId);
  }

  saveCompleted(eventId: string, result: ResultEnvelope, resultPath: string): void {
    this.transition(eventId, ["waiting_agent"], "completed", {
      result_json: stableStringify(result),
      result_path: resultPath,
      completed_at: result.completed_at,
      last_error_code: null,
      last_error_message: null,
    });
  }

  saveFailedResult(eventId: string, result: ResultEnvelope, resultPath: string): void {
    this.transition(eventId, ["waiting_agent"], "dead_letter", {
      result_json: stableStringify(result),
      result_path: resultPath,
      completed_at: result.completed_at,
      last_error_code: "agent_reported_failure",
      last_error_message: result.summary ?? "Agent reported failure",
    });
  }

  manualRetry(eventId: string, force: boolean, at = new Date()): EventRow {
    const row = this.getRequired(eventId);
    if (["blocked", "needs_review"].includes(row.status) && !force) {
      throw new Error(`${row.status} may already have side effects; repeat with --force after review`);
    }
    if (!["blocked", "needs_review", "dead_letter", "retryable_failed"].includes(row.status)) {
      throw new Error(`Event in status ${row.status} cannot be retried`);
    }
    this.db
      .prepare(`
        UPDATE events SET status = 'queued', attempt_count = 0, available_at = ?,
          dispatch_started_at = NULL, prompt_accepted_at = NULL, completed_at = NULL,
          result_json = NULL, result_path = NULL, last_error_code = NULL,
          last_error_message = NULL, updated_at = ? WHERE event_id = ?
      `)
      .run(at.toISOString(), at.toISOString(), eventId);
    return this.getRequired(eventId);
  }

  manualComplete(eventId: string, at = new Date()): EventRow {
    return this.db.transaction(() => {
      const row = this.getRequired(eventId);
      const timestamp = at.toISOString();
      if (row.status === "completed") {
        this.sealJobGroupIfPresent(eventId, timestamp);
        return row;
      }
      const result: ResultEnvelope = {
        schema_version: 1,
        event_id: eventId,
        status: "completed",
        summary: "Manually marked completed after operator review",
        actions: [],
        memory_candidates: [],
        completed_at: timestamp,
      };
      this.db.prepare(`
          UPDATE events SET status = 'completed', result_json = ?, completed_at = ?,
            last_error_code = NULL, last_error_message = NULL, updated_at = ?
          WHERE event_id = ?
        `).run(stableStringify(result), timestamp, timestamp, eventId);
      this.sealJobGroupIfPresent(eventId, timestamp);
      return this.getRequired(eventId);
    }).immediate();
  }

  manualDeadLetter(eventId: string, at = new Date()): EventRow {
    return this.db.transaction(() => {
      const row = this.getRequired(eventId);
      const timestamp = at.toISOString();
      this.db.prepare(`
        UPDATE events SET status = 'dead_letter', last_error_code = 'operator_dead_letter',
          last_error_message = 'Moved to dead letter by operator', updated_at = ? WHERE event_id = ?
      `).run(timestamp, eventId);
      this.sealJobGroupIfPresent(eventId, timestamp);
      return this.getRequired(eventId);
    }).immediate();
  }

  private getRequired(eventId: string): EventRow {
    const row = this.get(eventId);
    if (!row) throw new Error(`Event ${eventId} was not found`);
    return row;
  }

  private ensureWebJobProjectionReady(): void {
    if (this.webJobProjectionReady) return;
    ensureWebJobProjectionSchema(this.db);
    this.webJobProjectionReady = true;
  }

  private webJobAccessSql(): string {
    return `jobs.source='web' AND source_event.source='web' AND jobs.workspace_id=?
      AND json_valid(source_event.subject_json)
      AND json_extract(source_event.subject_json,'$.instance_id')=?
      AND json_extract(source_event.subject_json,'$.tenant_id')=?
      AND ((? IN ('own','own_or_granted') AND jobs.actor_id=? AND json_extract(source_event.subject_json,'$.principal_id')=?)
        OR (? IN ('granted','own_or_granted') AND EXISTS (SELECT 1 FROM web_job_read_grants grant_row
          WHERE grant_row.job_id=jobs.job_id AND grant_row.instance_id=? AND grant_row.tenant_id=?
            AND grant_row.principal_id=? AND grant_row.state='active' AND grant_row.expires_at>?)))`;
  }

  private webJobAccessParameters(identity: WebJobReadIdentity, now: string): unknown[] {
    return [identity.tenant_id, identity.instance_id, identity.tenant_id,
      identity.authorization_kind, identity.principal_id, identity.principal_id,
      identity.authorization_kind, identity.instance_id, identity.tenant_id, identity.principal_id, now];
  }

  private assertWebReadIdentity(identity: WebJobReadIdentity): void {
    for (const value of [identity.instance_id, identity.tenant_id, identity.principal_id])
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("web_job_read_invalid");
    if (!['own','granted','own_or_granted'].includes(identity.authorization_kind)) throw new Error("web_job_read_invalid");
  }

  private webProjectionHead(): number {
    return (this.db.prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM web_job_projection_events")
      .get() as { sequence: number }).sequence;
  }

  private issueWebProjectionCursor(kind: "list"|"events", identity: WebJobReadIdentity, resourceId: string | null,
    snapshot: number, afterCreated: string | null, afterJob: string | null, at: Date, ttlMs: number): string {
    const token = randomBytes(32).toString("base64url"), digest = createHash("sha256").update(token).digest("hex");
    const grant = kind === "events" && resourceId ? this.webJobGrantEvidence(resourceId, identity, at.toISOString()) : null;
    this.db.prepare(`DELETE FROM web_job_projection_cursors WHERE cursor_digest IN (
      SELECT cursor_digest FROM web_job_projection_cursors WHERE expires_at<=?
      ORDER BY expires_at,cursor_digest LIMIT 128
    )`).run(at.toISOString());
    this.db.prepare(`INSERT INTO web_job_projection_cursors
      (cursor_digest,cursor_kind,instance_id,tenant_id,principal_id,authorization_kind,grant_id,grant_revision,resource_id,snapshot_sequence,after_created_at,after_job_id,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(digest, kind, identity.instance_id, identity.tenant_id, identity.principal_id, identity.authorization_kind,
        grant?.grant_id??null,grant?.grant_revision??null,resourceId, snapshot, afterCreated, afterJob, new Date(at.getTime() + ttlMs).toISOString(), at.toISOString());
    return token;
  }

  private webProjectionCursor(token: string, kind: "list"|"events", identity: WebJobReadIdentity,
    resourceId: string | null, now: string): WebProjectionCursorRow {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, "base64url").toString("base64url") !== token)
      throw new Error("web_job_cursor_invalid");
    const digest = createHash("sha256").update(token).digest("hex");
    const row = this.db.prepare("SELECT * FROM web_job_projection_cursors WHERE cursor_digest=?")
      .get(digest) as WebProjectionCursorRow | undefined;
    if (!row || row.cursor_kind !== kind || row.instance_id !== identity.instance_id || row.tenant_id !== identity.tenant_id
      || row.principal_id !== identity.principal_id || row.authorization_kind !== identity.authorization_kind
      || row.resource_id !== resourceId || row.expires_at <= now)
      throw new Error("web_job_cursor_invalid");
    const grant=kind==="events"&&resourceId?this.webJobGrantEvidence(resourceId,identity,now):null;
    if(row.grant_id!==(grant?.grant_id??null)||row.grant_revision!==(grant?.grant_revision??null))throw new Error("web_job_cursor_invalid");
    return row;
  }

  private webJobGrantEvidence(jobId:string,identity:WebJobReadIdentity,now:string):{grant_id:string;grant_revision:number}|null {
    if(identity.authorization_kind!=="granted"){
      const owned=this.db.prepare(`SELECT 1 FROM jobs JOIN events source_event ON source_event.event_id=jobs.source_event_id
        WHERE jobs.job_id=? AND jobs.source='web' AND source_event.source='web' AND jobs.workspace_id=? AND jobs.actor_id=?
          AND json_valid(source_event.subject_json) AND json_extract(source_event.subject_json,'$.instance_id')=?
          AND json_extract(source_event.subject_json,'$.tenant_id')=? AND json_extract(source_event.subject_json,'$.principal_id')=?`)
        .get(jobId,identity.tenant_id,identity.principal_id,identity.instance_id,identity.tenant_id,identity.principal_id);
      if(owned)return null;
    }
    const grant=this.db.prepare(`SELECT grant_id,grant_revision FROM web_job_read_grants
      WHERE job_id=? AND instance_id=? AND tenant_id=? AND principal_id=? AND state='active' AND expires_at>?`)
      .get(jobId,identity.instance_id,identity.tenant_id,identity.principal_id,now) as {grant_id:string;grant_revision:number}|undefined;
    if(!grant)throw new Error("web_job_cursor_invalid");return grant;
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
    if (jobAttentionStatuses.has(notificationJob.status) && group.attention_event_id === null) {
      transition = "attention";
    } else if (total > 0 && allJobsTerminal && group.all_terminal_event_id === null) {
      transition = "all_terminal";
    }

    const jobs = this.db.prepare(`
      SELECT job_id, job_key, status FROM jobs
      WHERE source_event_id = ? ORDER BY created_at, job_id LIMIT ?
    `).all(sourceEventId, jobGroupSnapshotJobLimit) as JobGroupSnapshot["jobs"];
    return {
      source_event_id: sourceEventId,
      total,
      pending,
      status_counts: statusCounts,
      jobs,
      transition,
    };
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
    const current = this.getJobRequired(jobId);
    const wallClock = Date.parse(nowUtc());
    const previous = Date.parse(current.updated_at);
    const timestamp = new Date(Math.max(wallClock, previous + 1)).toISOString();
    const assignments = [...Object.keys(values).map((key) => `${key} = ?`), "status = ?", "updated_at = ?"];
    const params = [...Object.values(values), to, timestamp, jobId, ...from];
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
