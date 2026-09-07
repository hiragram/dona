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
  JobRow,
  JobStatus,
  ResultEnvelope,
} from "./types.js";
import { eventStatuses, jobStatuses } from "./types.js";
import { jobAgentName } from "./job-agent-name.js";
import { insertEventJobBinding, legacySlackBinding, migrateJobRouting, readEventJobBinding } from "./job-routing.js";
import { migrateScheduler } from "./scheduler/schema.js";
import { projectWorkResultContent, SchedulerRepository, validateWorkResultContent, validateWorkResultEnvelope } from "./scheduler/repository.js";
import { stableStringify } from "./validation.js";

const statusSql = eventStatuses.map((status) => `'${status}'`).join(", ");
const jobStatusSql = jobStatuses.map((status) => `'${status}'`).join(", ");
const retryDelaysMs = [5_000, 30_000, 120_000, 600_000] as const;

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

export class DispatcherDatabase {
  private readonly db: Database.Database;
  readonly scheduler: SchedulerRepository;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(databasePath), 0o700);
    this.db = new Database(databasePath);
    fs.chmodSync(databasePath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 2000");
    this.db.pragma("foreign_keys = ON");
    try {
      this.migrate();
      migrateScheduler(this.db);
      migrateJobRouting(this.db);
      this.db.exec("CREATE TABLE IF NOT EXISTS legacy_job_agents_to_stop(job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,stopped_at TEXT)");
      for(const row of this.db.prepare("SELECT job_id,result_path,status FROM jobs").all() as Array<{job_id:string;result_path:string;status:string}>) {
        if(path.basename(row.result_path)!==`${row.job_id}.json`) continue;
        if(row.status!=="queued") this.db.prepare("INSERT OR IGNORE INTO legacy_job_agents_to_stop(job_id) VALUES(?)").run(row.job_id);
        if(["retryable_failed","preparing","dispatching","running","blocked","needs_review","cancelling"].includes(row.status)) this.db.prepare(`UPDATE jobs SET status='needs_review',last_error_code='legacy_agent_sandbox_unknown',
          last_error_message='Legacy agent may retain the shared result-directory grant',updated_at=? WHERE job_id=?`).run(new Date().toISOString(),row.job_id);
        else if(row.status==="queued") this.db.prepare("UPDATE jobs SET result_path=? WHERE job_id=?").run(path.join(path.dirname(row.result_path),row.job_id,"result.json"),row.job_id);
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.scheduler = new SchedulerRepository(this.db, (event, at) => this.enqueue(event, at), undefined, (jobId,resultPath) => {
      const legacy=path.basename(resultPath)===`${jobId}.json`;
      const isolated=path.basename(resultPath)==="result.json"&&path.basename(path.dirname(resultPath))===jobId;
      if(!legacy&&!isolated) return false;
      try {
        if(isolated) fs.rmSync(path.dirname(resultPath),{recursive:true,force:true});
        else {
          const directory=path.dirname(resultPath), prefix=`${jobId}.json`;
          for(const name of fs.readdirSync(directory)) if(name===prefix||name.startsWith(`${prefix}.`)) fs.unlinkSync(path.join(directory,name));
        }
        return true;
      } catch(error) { return (error as NodeJS.ErrnoException).code==="ENOENT"; }
    });
  }

  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 2) throw new Error(`Database schema version ${version} is newer than supported version 2`);
    if (version < 1) this.db.exec(`
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
    if (version < 2) this.db.exec(`
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
    const sourceEvent = this.getRequired(request.source_event_id);
    const workspaceJson = stableStringify(request.workspace);
    const replyTarget = sourceEvent.reply_target_json
      ? JSON.parse(sourceEvent.reply_target_json) as Record<string, unknown>
      : {};
    const subject = JSON.parse(sourceEvent.subject_json) as Record<string, unknown>;
    const workspaceId = stringValue(replyTarget.workspace_id);
    const channelId = stringValue(replyTarget.channel_id);
    const threadTs = stringValue(replyTarget.thread_ts);
    const binding = readEventJobBinding(this.db, sourceEvent.event_id);
    if (!binding) throw new Error(`Event ${sourceEvent.event_id} does not have an authorized job owner`);
    if (binding.owner.kind === "schedule" && request.workspace.kind !== "scratch") {
      throw new Error("Scheduled work permits only a scratch workspace");
    }
    if (binding.owner.kind === "schedule") {
      const payload = JSON.parse(sourceEvent.payload_json) as { work?: { objective?: unknown; scope?: unknown; allowed_external_writes?: unknown } };
      if (typeof payload.work?.objective!=="string" || payload.work.objective !== request.objective || payload.work.scope !== "read_only" ||
        !Array.isArray(payload.work.allowed_external_writes) || payload.work.allowed_external_writes.length !== 0) {
        throw new Error("Scheduled work request does not match its persisted read-only scope");
      }
    }

    const created = this.db.transaction((): CreateJobResult | undefined => {
      const existing = this.db
        .prepare("SELECT * FROM jobs WHERE source_event_id = ?")
        .get(request.source_event_id) as JobRow | undefined;
      if (existing) {
        return {
          row: existing,
          duplicate: true,
          payloadMismatch: existing.objective !== request.objective || existing.workspace_json !== workspaceJson,
        };
      }
      if(binding.owner.kind==="schedule") {
        const payload=JSON.parse(sourceEvent.payload_json) as {work?:{authorization_target?:{workspace_id?:unknown;channel_id?:unknown}}};
        if(payload.work?.authorization_target) {
          const earliest=new Date(at.getTime()-120_000).toISOString();
          const consumed=this.db.prepare(`UPDATE events SET schedule_access_consumed_at=? WHERE event_id=? AND schedule_access_checked_at>=?
            AND schedule_access_checked_at<=? AND schedule_access_consumed_at IS NULL`).run(at.toISOString(),sourceEvent.event_id,earliest,at.toISOString()).changes;
          if(consumed!==1) throw new Error("Scheduled work current access receipt is missing or expired");
        }
      }

      const jobId = jobAgentName(`job_${ulid(at.getTime()).toLowerCase()}`, request.objective);
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
      const resultPath = path.join(resultDir, jobId, "result.json");
      const timestamp = at.toISOString();
      this.db.prepare(`
        INSERT INTO jobs (
          job_id, source_event_id, source, workspace_id, channel_id, thread_ts, actor_id,
          objective, workspace_json, status, available_at, workspace_path, result_path,
          agent_name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)
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
      return { row: this.getJobRequired(jobId), duplicate: false, payloadMismatch: false };
    }).immediate();
    if (!created) throw new Error("Schedule run is no longer authorized for job creation");
    return created;
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
    return this.db.prepare("SELECT j.* FROM jobs j JOIN legacy_job_agents_to_stop l USING(job_id) WHERE l.stopped_at IS NULL ORDER BY j.created_at,j.job_id").all() as JobRow[];
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
    if(!binding) throw new Error("Unknown job owner");
    return this.db.prepare(`SELECT j.* FROM jobs j JOIN job_owner_bindings b USING(job_id)
      WHERE b.owner_json=? ORDER BY j.created_at DESC LIMIT ?`).all(stableStringify(binding.owner),limit) as JobRow[];
  }

  listRunnableJobs(at = new Date(), limit = 100): JobRow[] {
    return this.db.prepare(`
      SELECT * FROM jobs
      WHERE (status IN ('queued', 'retryable_failed') AND available_at <= ?)
         OR status = 'running'
      ORDER BY created_at LIMIT ?
    `).all(at.toISOString(), limit) as JobRow[];
  }

  listOverdueScheduledJobs(at = new Date()): JobRow[] {
    const deadline = new Date(at.getTime() - 3_600_000).toISOString();
    return this.db.prepare(`SELECT j.* FROM jobs j JOIN job_owner_bindings b USING(job_id)
      WHERE j.status IN ('running','blocked','needs_review') AND COALESCE(j.prompt_accepted_at,j.dispatch_started_at)<=?
        AND (j.status!='needs_review' OR j.last_error_code IN ('ambiguous_prompt_acceptance','prompt_acceptance_unknown','prompt_interrupted','invalid_result','invalid_result_agent_stop_unknown','agent_wait_observation_unknown'))
        AND json_extract(b.owner_json,'$.kind')='schedule'
      ORDER BY COALESCE(j.prompt_accepted_at,j.dispatch_started_at),j.job_id`).all(deadline) as JobRow[];
  }

  listAmbiguousScheduledJobs():JobRow[] {
    return this.db.prepare(`SELECT j.* FROM jobs j JOIN job_owner_bindings b USING(job_id)
      WHERE j.status='needs_review' AND j.last_error_code IN ('ambiguous_prompt_acceptance','prompt_acceptance_unknown','prompt_interrupted','cancel_acceptance_unknown','cancel_exit_unknown','ambiguous_cancel_acceptance','agent_wait_observation_unknown')
        AND json_extract(b.owner_json,'$.kind')='schedule' ORDER BY j.updated_at,j.job_id`).all() as JobRow[];
  }

  settleAmbiguousCancellation(jobId:string,reason:string,at=new Date()):void {
    this.updateJob(jobId,["needs_review"],"cancelled",{completed_at:at.toISOString(),last_error_code:"cancelled",last_error_message:reason});
  }

  listScheduledJobsRequiringCancellation(at = new Date()): JobRow[] {
    return this.db.prepare(`SELECT j.* FROM jobs j JOIN job_owner_bindings b USING(job_id)
      JOIN schedules s ON s.schedule_id=json_extract(b.owner_json,'$.schedule_id')
      JOIN schedule_revisions r ON r.schedule_id=s.schedule_id AND r.revision=json_extract(b.owner_json,'$.revision')
      WHERE json_extract(b.owner_json,'$.kind')='schedule'
        AND (s.state IN ('cancelled','expired') OR julianday(r.expires_at)<=julianday(?))
        AND j.status IN ('queued','retryable_failed','preparing','dispatching','running','blocked','needs_review')
        AND (j.status!='needs_review' OR j.last_error_code IN ('ambiguous_prompt_acceptance','prompt_acceptance_unknown','prompt_interrupted','invalid_result','invalid_result_agent_stop_unknown','agent_wait_observation_unknown'))
      ORDER BY j.created_at,j.job_id`).all(at.toISOString()) as JobRow[];
  }

  listJobsNeedingNotification(limit = 100): JobRow[] {
    return this.db.prepare(`
      SELECT * FROM jobs
      WHERE status IN ('blocked', 'completed', 'failed', 'cancelled', 'needs_review')
        AND completion_event_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM job_completion_results c WHERE c.job_id=jobs.job_id AND c.job_status=jobs.status)
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

  recordInvalidResultAgentStopFailure(jobId:string,message:string):void {
    this.db.prepare("UPDATE jobs SET last_error_code='invalid_result_agent_stop_unknown',last_error_message=?,updated_at=? WHERE job_id=? AND status='needs_review'").run(message,nowUtc(),jobId);
  }
  recordInvalidResultAgentStopped(jobId:string):void {
    this.db.prepare("UPDATE jobs SET last_error_code='invalid_result_agent_stopped',last_error_message='Invalid Result was fenced and the agent exit was observed',updated_at=? WHERE job_id=? AND status='needs_review'").run(nowUtc(),jobId);
  }

  reconcileScheduledRun(runId:string,outcome:"failed"|"cancelled",at=new Date()):unknown {
    const row=this.db.prepare("SELECT s.tenant_id FROM schedule_runs r JOIN schedules s USING(schedule_id) WHERE r.run_id=?").get(runId) as {tenant_id:string}|undefined;
    if(!row) throw new Error(`Run ${runId} was not found`);
    return this.scheduler.reconcileWorkRun(runId,outcome,{tenant_id:row.tenant_id,actor_id:"dispatcher-admin",role:"admin",source_event_id:null},new Date(Math.floor(at.getTime()/1000)*1000).toISOString().replace(".000Z","Z"));
  }

  saveJobResult(jobId: string, result: JobResultEnvelope, resultPath: string, at = new Date()): void {
    const binding = readEventJobBinding(this.db, this.getJobRequired(jobId).source_event_id);
    if (binding?.owner.kind === "schedule") {
      validateWorkResultEnvelope(stableStringify(result));
      validateWorkResultContent(renderJobResult(result as unknown as Record<string,unknown>));
    }
    const status: JobStatus = result.status === "completed" ? "completed" : "failed";
    const completedAt = new Date(result.completed_at);
    if(binding?.owner.kind==="schedule"&&completedAt.getTime()>at.getTime()) throw new Error("completed_at_is_in_the_future");
    const job=this.getJobRequired(jobId);
    const recoverAmbiguous=job.status==="needs_review"&&(["ambiguous_prompt_acceptance","prompt_acceptance_unknown","prompt_interrupted","cancel_acceptance_unknown","cancel_exit_unknown","ambiguous_cancel_acceptance","agent_wait_observation_unknown"].includes(job.last_error_code??"")||
      (job.last_error_code==="legacy_agent_sandbox_unknown"&&this.isLegacySharedGrantAgentStopped(jobId)));
    if(binding?.owner.kind==="schedule"&&job.dispatch_started_at&&completedAt.getTime()<Date.parse(job.dispatch_started_at))
      throw new Error("completed_at_precedes_prompt_dispatch");
    this.db.transaction(()=>{
      if(recoverAmbiguous&&job.completion_event_id) {
        const prior=this.db.prepare("SELECT notification_state FROM job_completion_results WHERE notification_event_id=?").get(job.completion_event_id) as {notification_state:string}|undefined;
        if(prior&&prior.notification_state!=="pending") throw new Error("prior_notification_requires_reconciliation");
        this.db.prepare("UPDATE events SET status='completed',completed_at=?,updated_at=?,last_error_code='job_result_superseded',last_error_message=NULL WHERE event_id=? AND status IN ('queued','retryable_failed','dispatching','waiting_agent')").run(completedAt.toISOString(),completedAt.toISOString(),job.completion_event_id);
        this.db.prepare("UPDATE job_completion_results SET notification_state='none' WHERE notification_event_id=? AND notification_state='pending'").run(job.completion_event_id);
        this.db.prepare("UPDATE jobs SET completion_event_id=NULL WHERE job_id=?").run(jobId);
      }
      if(recoverAmbiguous&&binding?.owner.kind==="schedule") this.scheduler.recoverWorkRunForResult(binding.owner.run_id,jobId,job.source_event_id,new Date(Math.floor(completedAt.getTime()/1000)*1000).toISOString().replace(".000Z","Z"));
      this.updateJob(jobId, recoverAmbiguous?["needs_review"]:["running","cancelling"], status, {
        result_json: stableStringify(result), result_path: resultPath, completed_at: completedAt.toISOString(),
        last_error_code: result.status === "failed" ? "agent_reported_failure" : null,
        last_error_message: result.status === "failed" ? result.summary : null,
      });
      if(binding?.owner.kind==="schedule") this.materializeJobCompletion(jobId,completedAt);
    }).immediate();
  }

  appendQueuedJobInstruction(jobId: string, sourceEventId: string, instruction: string): JobRow {
    this.assertJobSourceMatchesThread(jobId, sourceEventId);
    this.assertJobSteerAllowed(jobId);
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
    this.assertJobSteerAllowed(jobId);
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
    if (!["queued", "retryable_failed", "preparing", "dispatching", "running", "blocked", "needs_review"].includes(row.status)) {
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
    return this.db.transaction(() => this.materializeJobCompletion(jobId, at)).immediate();
  }

  private materializeJobCompletion(jobId: string, at: Date): EnqueueResult {
    const job = this.getJobRequired(jobId);
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
    const workState=job.status==="completed"?"completed":job.status==="needs_review"?"needs_review":"failed";
    const notificationState=binding.destination.kind==="none"?"none":"pending";
    const completedAt=job.completed_at??job.updated_at;
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
        workspace: JSON.parse(job.workspace_json) as Record<string, unknown>,
        ...(result ? { result: binding.owner.kind==="schedule"
          ? {schema_version:result.schema_version,job_id:result.job_id,status:result.status,
              summary:projectWorkResultContent(renderJobResult(result)),completed_at:result.completed_at}
          : result } : {}),
        ...(job.last_error_code ? { error_code: job.last_error_code } : {}),
        ...(job.last_error_message ? { error_message: this.safeNotificationError(job.last_error_message,binding.owner.kind==="schedule") } : {}),
      },
          reply_target: binding.destination.kind==="slack"?binding.destination.target:binding.destination,
      trace: { job_id: job.job_id, source_event_id: job.source_event_id },
    };
    const enqueued = this.enqueue(envelope, at);
    this.db.prepare("UPDATE jobs SET completion_event_id = ?, updated_at = ? WHERE job_id = ?")
      .run(enqueued.row.event_id, at.toISOString(), jobId);
    this.db.prepare(`UPDATE job_completion_results SET notification_event_id=? WHERE job_id=? AND job_status=?`)
      .run(enqueued.row.event_id,jobId,job.status);
    return enqueued;
  }

  private safeNotificationError(message:string,scheduled:boolean):string {
    if(!scheduled) return message;
    try { return projectWorkResultContent(message); }
    catch { return "実行エラーの詳細は安全上省略されました"; }
  }

  private setNotificationState(eventId:string,state:"none"|"accepted"|"failed"|"needs_review",at:Date):void {
    const rows=this.db.prepare(`SELECT json_extract(c.owner_json,'$.run_id') AS run_id,c.materialized_at,r.created_at AS run_created_at,r.started_at,r.terminal_at,s.updated_at AS schedule_updated_at
      FROM job_completion_results c JOIN schedule_runs r ON r.run_id=json_extract(c.owner_json,'$.run_id') JOIN schedules s USING(schedule_id)
      WHERE c.notification_event_id=? AND json_extract(c.owner_json,'$.kind')='schedule'`).all(eventId) as Array<{run_id:string;materialized_at:string;run_created_at:string;started_at:string|null;terminal_at:string|null;schedule_updated_at:string}>;
    const requested=new Date(Math.floor(at.getTime()/1000)*1000).toISOString().replace(".000Z","Z");
    if(state==="failed"||state==="needs_review") for(const row of rows) this.scheduler.markWorkNotificationNeedsReview(row.run_id,[requested,row.materialized_at,row.run_created_at,row.started_at,row.terminal_at,row.schedule_updated_at].filter((value):value is string=>value!==null).sort().at(-1)!);
    this.db.prepare("UPDATE job_completion_results SET notification_state=? WHERE notification_event_id=?").run(state,eventId);
    for(const row of rows) this.scheduler.settleWorkNotification(row.run_id,[requested,row.materialized_at,row.run_created_at,row.started_at,row.terminal_at,row.schedule_updated_at].filter((value):value is string=>value!==null).sort().at(-1)!);
  }

  assertJobSourceMatchesThread(jobId: string, sourceEventId: string): void {
    const binding=readEventJobBinding(this.db,sourceEventId);
    const owner=this.db.prepare("SELECT owner_json FROM job_owner_bindings WHERE job_id=?").get(jobId) as {owner_json:string}|undefined;
    if(!binding||!owner||stableStringify(binding.owner)!==owner.owner_json) throw new Error(`Event ${sourceEventId} does not belong to job ${jobId}'s owner`);
  }

  private assertJobSteerAllowed(jobId:string):void {
    const row=this.db.prepare("SELECT owner_json FROM job_owner_bindings WHERE job_id=?").get(jobId) as {owner_json:string}|undefined;
    if(row&&(JSON.parse(row.owner_json) as {kind?:unknown}).kind==="schedule") throw new Error("Scheduled jobs cannot be steered");
  }

  hasBlockedEvent(): boolean {
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
      const rows=this.db.prepare(`SELECT e.event_id,c.notification_state FROM events e JOIN job_completion_results c ON c.notification_event_id=e.event_id
        JOIN schedules s ON s.schedule_id=json_extract(c.owner_json,'$.schedule_id')
        JOIN schedule_revisions r ON r.schedule_id=s.schedule_id AND r.revision=json_extract(c.owner_json,'$.revision')
        WHERE e.source='dona_job' AND e.status IN ('queued','retryable_failed','dispatching','waiting_agent') AND json_extract(c.owner_json,'$.kind')='schedule'
          AND (julianday(c.materialized_at,'+900 seconds')<julianday(?) OR s.state NOT IN ('active','needs_review')
            OR s.revision!=json_extract(c.owner_json,'$.revision') OR julianday(r.expires_at)<=julianday(?))`)
        .all(timestamp,timestamp) as Array<{event_id:string;notification_state:string}>;
      for(const row of rows) {
        if(row.notification_state==="needs_review") {
          this.db.prepare("UPDATE events SET status='needs_review',updated_at=?,last_error_code='notification_delivery_ambiguous',last_error_message=NULL WHERE event_id=? AND status IN ('queued','retryable_failed','dispatching','waiting_agent')").run(timestamp,row.event_id);
          this.setNotificationState(row.event_id,"needs_review",at);
          continue;
        }
        this.db.prepare(`UPDATE events SET status='completed',completed_at=?,updated_at=?,last_error_code='schedule_notification_suppressed',
          last_error_message=NULL WHERE event_id=? AND status IN ('queued','retryable_failed','dispatching','waiting_agent')`).run(timestamp,timestamp,row.event_id);
        this.setNotificationState(row.event_id,"none",at);
      }
    }).immediate();
  }

  authorizeJobNotification(eventId:string,at=new Date()):Record<string,unknown> {
    this.suppressUnauthorizedScheduledNotifications(at);
    return this.db.transaction(()=>{
      const timestamp=at.toISOString();
      const row=this.db.prepare(`SELECT e.status,c.owner_json,c.destination_json,c.notification_authorization_phase FROM events e
        JOIN job_completion_results c ON c.notification_event_id=e.event_id
        JOIN schedules s ON s.schedule_id=json_extract(c.owner_json,'$.schedule_id')
        JOIN schedule_revisions r ON r.schedule_id=s.schedule_id AND r.revision=json_extract(c.owner_json,'$.revision')
        WHERE e.event_id=? AND e.source='dona_job' AND e.status IN ('dispatching','waiting_agent')
          AND ((c.notification_state='pending' AND c.notification_authorization_phase='none') OR
            (c.notification_state='needs_review' AND c.notification_authorization_phase='preflight')) AND json_extract(c.owner_json,'$.kind')='schedule'
          AND julianday(c.materialized_at,'+900 seconds')>=julianday(?) AND s.state IN ('active','needs_review')
          AND s.revision=json_extract(c.owner_json,'$.revision') AND julianday(r.expires_at)>julianday(?)`).get(eventId,timestamp,timestamp) as
        {status:string;owner_json:string;destination_json:string;notification_authorization_phase:string}|undefined;
      if(!row) throw new Error("schedule_notification_not_authorized");
      if(row.status==="dispatching") this.markWaiting(eventId,at);
      const nextPhase=row.notification_authorization_phase==="none"?"preflight":"write";
      this.db.prepare("UPDATE job_completion_results SET notification_state='needs_review',notification_authorization_phase=? WHERE notification_event_id=?").run(nextPhase,eventId);
      const owner=JSON.parse(row.owner_json) as {owner_id:string;schedule_id:string;revision:number};
      return {authorized:true,event_id:eventId,owner_id:owner.owner_id,schedule_id:owner.schedule_id,revision:owner.revision,
        destination:JSON.parse(row.destination_json) as Record<string,unknown>};
    }).immediate();
  }

  recordScheduleJobAccess(eventId:string,receipt:{workspace_id:string;channel_id:string;user_id:string;issued_at:string;nonce:string},at=new Date()):Record<string,unknown> {
    return this.db.transaction(()=>{
      const event=this.getRequired(eventId),binding=readEventJobBinding(this.db,eventId);
      const payload=JSON.parse(event.payload_json) as {work?:{authorization_target?:{workspace_id?:unknown;channel_id?:unknown}}};
      const target=payload.work?.authorization_target;
      if(event.source!=="dona_schedule"||event.status!=="waiting_agent"||binding?.owner.kind!=="schedule"||receipt.user_id!==binding.owner.owner_id||
        receipt.workspace_id!==target?.workspace_id||receipt.channel_id!==target.channel_id||event.schedule_access_consumed_at!==null||Math.abs(at.getTime()-Date.parse(receipt.issued_at))>120_000) throw new Error("schedule_access_receipt_mismatch");
      const changed=this.db.prepare("UPDATE events SET schedule_access_checked_at=? WHERE event_id=? AND schedule_access_checked_at IS NULL").run(at.toISOString(),eventId).changes;
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
      if(current?.status==="completed"&&current.last_error_code==="schedule_notification_suppressed") return current;
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
        this.scheduler.settleUndelegatedWorkEvent(eventId,"failed",new Date(Math.floor(at.getTime()/1000)*1000).toISOString().replace(".000Z","Z"));
        this.setNotificationState(eventId,"failed",at);
      }
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

  private notificationDelivered(eventId:string,result:ResultEnvelope):{delivered:boolean;runId?:string} {
    const completion=this.db.prepare("SELECT owner_json,destination_json,notification_state,notification_authorization_phase FROM job_completion_results WHERE notification_event_id=?").get(eventId) as {owner_json:string;destination_json:string;notification_state:string;notification_authorization_phase:string}|undefined;
    if(!completion)return {delivered:false};
    const destination=JSON.parse(completion.destination_json) as {kind?:unknown;target?:Record<string,unknown>},target=destination.kind==="slack"?destination.target:undefined;
    const owner=JSON.parse(completion.owner_json) as {owner_id?:unknown;run_id?:string};
    const actions=(result.actions??[]).flatMap((action,index)=>action&&typeof action==="object"&&!Array.isArray(action)?[{index,value:action as Record<string,unknown>}]:[]);
    const ambiguousPost=actions.some(({value})=>typeof value.tool==="string"&&value.tool.endsWith(".post_message")&&value.ambiguous===true);
    const authorized=actions.find(({value})=>value.tool==="dona_dispatcher.authorize_job_notification"&&value.authorized===true&&value.event_id===eventId);
    const access=actions.find(({index,value})=>index>(authorized?.index??Number.MAX_SAFE_INTEGER)&&value.tool==="dona_slack.check_user_channel_access"&&value.authorized===true&&value.workspace_id===target?.workspace_id&&value.channel_id===target?.channel_id&&value.user_id===owner.owner_id);
    const reauthorized=actions.find(({index,value})=>index>(access?.index??Number.MAX_SAFE_INTEGER)&&value.tool==="dona_dispatcher.authorize_job_notification"&&value.authorized===true&&value.event_id===eventId);
    return {delivered:!ambiguousPost&&completion.notification_state==="needs_review"&&completion.notification_authorization_phase==="write"&&actions.some(({index,value})=>index>(reauthorized?.index??Number.MAX_SAFE_INTEGER)&&value.tool==="dona_slack.post_message"&&typeof value.workspace==="string"&&value.workspace===access?.value.workspace&&typeof value.message_ts==="string"&&value.channel_id===target?.channel_id&&(target?.kind==="thread"?(value.thread_ts===target.thread_ts&&value.reply_broadcast===false):value.thread_ts===undefined)),...(owner.run_id?{runId:owner.run_id}:{})};
  }

  saveCompleted(eventId: string, result: ResultEnvelope, resultPath: string): void {
    if(Date.parse(result.completed_at)>Date.now()) throw new Error("completed_at_is_in_the_future");
    this.db.transaction(()=>{
      const event=this.getRequired(eventId);
      if(event.status==="completed"&&event.last_error_code==="schedule_notification_suppressed") return;
      if(event.source==="dona_schedule") {
        const run=this.db.prepare("SELECT job_id,status FROM schedule_runs WHERE event_id=?").get(eventId) as {job_id:string|null;status:string}|undefined;
        if(!run?.job_id||run.status==="materialized") {
          this.transition(eventId,["waiting_agent"],"needs_review",{result_json:stableStringify(result),result_path:resultPath,
            completed_at:result.completed_at,last_error_code:"schedule_job_not_delegated",last_error_message:"Scheduled work completed without a bound job"});
          this.scheduler.settleUndelegatedWorkEvent(eventId,"needs_review",
            new Date(Math.floor(Date.parse(result.completed_at)/1000)*1000).toISOString().replace(".000Z","Z"));
          return;
        }
      }
      this.transition(eventId, ["waiting_agent"], "completed", {
        result_json: stableStringify(result), result_path: resultPath, completed_at: result.completed_at,
        last_error_code: null, last_error_message: null,
      });
      const delivery=this.notificationDelivered(eventId,result);
      if(delivery.runId) {
        this.setNotificationState(eventId,delivery.delivered?"accepted":"needs_review",new Date(result.completed_at));
      }
    }).immediate();
  }

  saveFailedResult(eventId: string, result: ResultEnvelope, resultPath: string): void {
    if(Date.parse(result.completed_at)>Date.now()) throw new Error("completed_at_is_in_the_future");
    this.db.transaction(()=>{
      const event=this.getRequired(eventId);
      if(event.status==="completed"&&event.last_error_code==="schedule_notification_suppressed") return;
      const delivery=this.notificationDelivered(eventId,result);
      if(delivery.delivered) {
        this.transition(eventId,["waiting_agent"],"completed",{result_json:stableStringify(result),result_path:resultPath,completed_at:result.completed_at,last_error_code:"agent_failed_after_delivery",last_error_message:result.summary??"Agent failed after confirmed delivery"});
        this.setNotificationState(eventId,"accepted",new Date(result.completed_at));return;
      }
      const ambiguous=(result.actions??[]).some(action=>action!==null&&typeof action==="object"&&!Array.isArray(action)&&
        typeof (action as Record<string,unknown>).tool==="string"&&String((action as Record<string,unknown>).tool).endsWith(".post_message")&&
        (action as Record<string,unknown>).ambiguous===true);
      this.transition(eventId, ["waiting_agent"], ambiguous?"needs_review":"dead_letter", {result_json: stableStringify(result),result_path: resultPath,
        completed_at: result.completed_at,last_error_code: ambiguous?"ambiguous_external_write":"agent_reported_failure",
        last_error_message: result.summary ?? "Agent reported failure"});
      this.scheduler.settleUndelegatedWorkEvent(eventId,ambiguous||event.source==="dona_schedule"?"needs_review":"failed",new Date(Math.floor(Date.parse(result.completed_at)/1000)*1000).toISOString().replace(".000Z","Z"));
      this.setNotificationState(eventId,ambiguous?"needs_review":"failed",new Date(result.completed_at));
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
    if(row.result_path) fs.rmSync(row.result_path,{force:true});
    this.db.transaction(()=>{
      this.db.prepare(`
        UPDATE events SET status = 'queued', attempt_count = 0, available_at = ?,
          dispatch_started_at = NULL, prompt_accepted_at = NULL, completed_at = NULL,
          result_json = NULL, result_path = NULL, last_error_code = NULL,
          last_error_message = NULL, updated_at = ? WHERE event_id = ?
      `).run(at.toISOString(), at.toISOString(), eventId);
      this.db.prepare("UPDATE job_completion_results SET notification_state='pending',notification_authorization_phase='none' WHERE notification_event_id=? AND notification_state='failed'").run(eventId);
    }).immediate();
    return this.getRequired(eventId);
  }

  manualComplete(eventId: string, at = new Date()): EventRow {
    const row = this.getRequired(eventId);
    const scheduledNotification=this.db.prepare(`SELECT 1 FROM job_completion_results WHERE notification_event_id=?
      AND json_extract(owner_json,'$.kind')='schedule' AND notification_state!='accepted'`).get(eventId);
    if(scheduledNotification) throw new Error("scheduled_notification_receipt_required");
    if (row.status === "completed") {
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
    this.setNotificationState(eventId,"accepted",at);
    return this.getRequired(eventId);
  }

  reconcileScheduledNotification(eventId:string,receipt:{workspace_id:string;channel_id:string;message_ts:string;thread_ts?:string},at=new Date()):EventRow {
    const row=this.getRequired(eventId);
    const completion=this.db.prepare(`SELECT destination_json,notification_state FROM job_completion_results
      WHERE notification_event_id=? AND json_extract(owner_json,'$.kind')='schedule'`).get(eventId) as {destination_json:string;notification_state:string}|undefined;
    if(!completion||!["failed","needs_review"].includes(completion.notification_state)) throw new Error("scheduled_notification_not_reconcilable");
    const destination=JSON.parse(completion.destination_json) as {kind?:string;target?:{kind?:string;workspace_id?:string;channel_id?:string;thread_ts?:string}};
    const target=destination.kind==="slack"?destination.target:undefined;
    if(!target||receipt.workspace_id!==target.workspace_id||receipt.channel_id!==target.channel_id||
      !/^\d{1,20}\.\d{6}$/.test(receipt.message_ts)||(target.kind==="thread"?receipt.thread_ts!==target.thread_ts:receipt.thread_ts!==undefined)) {
      throw new Error("scheduled_notification_receipt_mismatch");
    }
    const result:ResultEnvelope={schema_version:1,event_id:eventId,status:"completed",summary:"Operator reconciled a verified scheduled notification receipt",
      actions:[{tool:"operator.reconcile_job_notification",workspace_id:receipt.workspace_id,channel_id:receipt.channel_id,message_ts:receipt.message_ts,...(receipt.thread_ts?{thread_ts:receipt.thread_ts}:{})}],
      memory_candidates:[],completed_at:at.toISOString()};
    this.db.transaction(()=>{
      this.db.prepare(`UPDATE events SET status='completed',result_json=?,completed_at=?,last_error_code=NULL,last_error_message=NULL,updated_at=? WHERE event_id=?`)
        .run(stableStringify(result),at.toISOString(),at.toISOString(),eventId);
      this.setNotificationState(eventId,"accepted",at);
    }).immediate();
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
    this.setNotificationState(eventId,"failed",at);
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
