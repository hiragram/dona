import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { ulid } from "ulid";

import type {
  CreateJobRequest,
  CreateJobResult,
  EnqueueResult,
  EventEnvelope,
  EventRow,
  EventStatus,
  JobResultEnvelope,
  JobGroupNotificationMode,
  JobGroupRow,
  JobGroupTransition,
  JobRow,
  JobStatus,
  ResultEnvelope,
} from "./types.js";
import { eventStatuses, jobStatuses } from "./types.js";
import { stableStringify } from "./validation.js";

const statusSql = eventStatuses.map((status) => `'${status}'`).join(", ");
const jobStatusSql = jobStatuses.map((status) => `'${status}'`).join(", ");
const retryDelaysMs = [5_000, 30_000, 120_000, 600_000] as const;

export const dispatcherSchemaCompatibility = {
  read_min: 2,
  read_max: 3,
  write: 3,
} as const;

export type DispatcherMigrationStep = "jobs_copied" | "indexes_recreated" | "groups_backfilled";
// Runtime callers leave this unset. Tests use it to prove that every v2 rebuild phase rolls back atomically.
export type DispatcherMigrationHook = (step: DispatcherMigrationStep) => void;

function nowUtc(): string {
  return new Date().toISOString();
}

function retryAt(attemptCount: number, now: Date): string {
  const delay = retryDelaysMs[Math.min(Math.max(attemptCount - 1, 0), retryDelaysMs.length - 1)]!;
  return new Date(now.getTime() + delay).toISOString();
}

export function migrateDispatcherDatabase(
  db: Database.Database,
  migrationHook: DispatcherMigrationHook = () => {},
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
  if (version < 3) db.transaction(() => {
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
        job_id, source_event_id, 'legacy-default', source, workspace_id, channel_id, thread_ts, actor_id,
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
    `);
    migrationHook("indexes_recreated");

    db.exec(`
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
    db.pragma(`user_version = ${dispatcherSchemaCompatibility.write}`);
  })();
}

export class DispatcherDatabase {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(databasePath), 0o700);
    this.db = new Database(databasePath);
    fs.chmodSync(databasePath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 2000");
    this.db.pragma("foreign_keys = ON");
    migrateDispatcherDatabase(this.db);
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
      ...dispatcherSchemaCompatibility,
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
    const sourceEvent = this.getRequired(request.source_event_id);
    const workspaceJson = stableStringify(request.workspace);
    const replyTarget = sourceEvent.reply_target_json
      ? JSON.parse(sourceEvent.reply_target_json) as Record<string, unknown>
      : {};
    const subject = JSON.parse(sourceEvent.subject_json) as Record<string, unknown>;
    const workspaceId = stringValue(replyTarget.workspace_id);
    const channelId = stringValue(replyTarget.channel_id);
    const threadTs = stringValue(replyTarget.thread_ts);
    if (
      sourceEvent.source !== "slack" ||
      stringValue(replyTarget.kind) !== "slack_thread" ||
      !workspaceId ||
      !channelId ||
      !threadTs
    ) {
      throw new Error(`Event ${sourceEvent.event_id} does not have a Slack thread reply target`);
    }

    return this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM jobs WHERE source_event_id = ? AND job_key = 'legacy-default'")
        .get(request.source_event_id) as JobRow | undefined;
      if (existing) {
        return {
          row: existing,
          duplicate: true,
          payloadMismatch: existing.objective !== request.objective || existing.workspace_json !== workspaceJson,
        };
      }

      const jobId = `job_${ulid(at.getTime()).toLowerCase()}`;
      const workspacePath = request.workspace.kind === "scratch"
        ? path.join(workspaceRoot, "scratch", jobId)
        : path.join(
          workspaceRoot,
          "github",
          request.workspace.repository.split("/")[0]!,
          request.workspace.repository.split("/")[1]!,
          "worktrees",
          jobId,
        );
      const resultPath = path.join(resultDir, `${jobId}.json`);
      const timestamp = at.toISOString();
      const group = this.getJobGroup(request.source_event_id);
      if (group?.sealed_at) throw new Error(`Job group ${request.source_event_id} is sealed`);
      if (!group) {
        this.db.prepare(`
          INSERT INTO job_groups (
            source_event_id, sealed_at, notification_mode, attention_event_id,
            all_terminal_event_id, created_at, updated_at
          ) VALUES (?, NULL, 'grouped', NULL, NULL, ?, ?)
        `).run(request.source_event_id, timestamp, timestamp);
      }
      this.db.prepare(`
        INSERT INTO jobs (
          job_id, source_event_id, job_key, source, workspace_id, channel_id, thread_ts, actor_id,
          objective, workspace_json, status, available_at, workspace_path, result_path,
          agent_name, created_at, updated_at
        ) VALUES (?, ?, 'legacy-default', ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)
      `).run(
        jobId,
        request.source_event_id,
        sourceEvent.source,
        workspaceId,
        channelId,
        threadTs,
        stringValue(subject.actor_id),
        request.objective,
        workspaceJson,
        timestamp,
        workspacePath,
        resultPath,
        jobId,
        timestamp,
        timestamp,
      );
      return { row: this.getJobRequired(jobId), duplicate: false, payloadMismatch: false };
    })();
  }

  getJob(jobId: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
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
    const timestamp = at.toISOString();
    const changed = this.db.prepare(`
      UPDATE job_groups SET sealed_at = ?, updated_at = ?
      WHERE source_event_id = ? AND sealed_at IS NULL
    `).run(timestamp, timestamp, sourceEventId).changes;
    if (changed === 0) this.getJobGroupRequired(sourceEventId);
    return this.getJobGroupRequired(sourceEventId);
  }

  claimJobGroupTransition(
    sourceEventId: string,
    transition: JobGroupTransition,
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
    })();
  }

  listJobs(status?: JobStatus, limit = 100): JobRow[] {
    if (status) {
      return this.db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY created_at LIMIT ?").all(status, limit) as JobRow[];
    }
    return this.db.prepare("SELECT * FROM jobs ORDER BY created_at LIMIT ?").all(limit) as JobRow[];
  }

  listThreadJobs(workspaceId: string, channelId: string, threadTs: string, limit = 100): JobRow[] {
    return this.db.prepare(`
      SELECT * FROM jobs
      WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(workspaceId, channelId, threadTs, limit) as JobRow[];
  }

  listRunnableJobs(at = new Date(), limit = 100): JobRow[] {
    return this.db.prepare(`
      SELECT * FROM jobs
      WHERE (status IN ('queued', 'retryable_failed') AND available_at <= ?)
         OR status = 'running'
      ORDER BY created_at LIMIT ?
    `).all(at.toISOString(), limit) as JobRow[];
  }

  listJobsNeedingNotification(limit = 100): JobRow[] {
    return this.db.prepare(`
      SELECT * FROM jobs
      WHERE status IN ('blocked', 'completed', 'failed', 'cancelled', 'needs_review')
        AND completion_event_id IS NULL
      ORDER BY updated_at LIMIT ?
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
    if (!["queued", "retryable_failed", "running", "blocked"].includes(row.status)) {
      throw new Error(`Job ${jobId} in status ${row.status} cannot be cancelled`);
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

  enqueueJobNotification(jobId: string, at = new Date()): EnqueueResult {
    const job = this.getJobRequired(jobId);
    if (job.completion_event_id) {
      const existing = this.get(job.completion_event_id);
      if (!existing) throw new Error(`Job ${jobId} references a missing completion event`);
      return { row: existing, duplicate: true, payloadMismatch: false };
    }
    const sourceEvent = this.getRequired(job.source_event_id);
    const result = job.result_json ? JSON.parse(job.result_json) as Record<string, unknown> : null;
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
        workspace: JSON.parse(job.workspace_json) as Record<string, unknown>,
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
    this.db.prepare("UPDATE jobs SET completion_event_id = ?, updated_at = ? WHERE job_id = ?")
      .run(enqueued.row.event_id, at.toISOString(), jobId);
    return enqueued;
  }

  private assertJobSourceMatchesThread(jobId: string, sourceEventId: string): void {
    const job = this.getJobRequired(jobId);
    const sourceEvent = this.getRequired(sourceEventId);
    const replyTarget = sourceEvent.reply_target_json
      ? JSON.parse(sourceEvent.reply_target_json) as Record<string, unknown>
      : {};
    if (
      sourceEvent.source !== "slack" ||
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
    return this.db
      .prepare(`
        UPDATE events SET
          status = 'needs_review',
          last_error_code = 'stale_dispatching',
          last_error_message = 'Dispatcher restarted while prompt acceptance was unknown',
          updated_at = ?
        WHERE status = 'dispatching'
      `)
      .run(at.toISOString()).changes;
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
    const row = this.getRequired(eventId);
    if (row.status === "completed") return row;
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
    return this.getRequired(eventId);
  }

  manualDeadLetter(eventId: string, at = new Date()): EventRow {
    this.getRequired(eventId);
    this.db
      .prepare(`
        UPDATE events SET status = 'dead_letter', last_error_code = 'operator_dead_letter',
          last_error_message = 'Moved to dead letter by operator', updated_at = ? WHERE event_id = ?
      `)
      .run(at.toISOString(), eventId);
    return this.getRequired(eventId);
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

  private updateJob(
    jobId: string,
    from: JobStatus[],
    to: JobStatus,
    values: Record<string, string | null>,
  ): void {
    const timestamp = nowUtc();
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
    const timestamp = nowUtc();
    const assignments = [...Object.keys(values).map((key) => `${key} = ?`), "status = ?", "updated_at = ?"];
    const params = [...Object.values(values), to, timestamp, eventId, ...from];
    const placeholders = from.map(() => "?").join(", ");
    const changed = this.db
      .prepare(`UPDATE events SET ${assignments.join(", ")} WHERE event_id = ? AND status IN (${placeholders})`)
      .run(...params).changes;
    if (changed !== 1) throw new Error(`Invalid status transition for event ${eventId} to ${to}`);
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
