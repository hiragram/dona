import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { ulid } from "ulid";

import type { EnqueueResult, EventEnvelope, EventRow, EventStatus, ResultEnvelope } from "./types.js";
import { eventStatuses } from "./types.js";
import { stableStringify } from "./validation.js";

const statusSql = eventStatuses.map((status) => `'${status}'`).join(", ");
const retryDelaysMs = [5_000, 30_000, 120_000, 600_000] as const;

function nowUtc(): string {
  return new Date().toISOString();
}

function retryAt(attemptCount: number, now: Date): string {
  const delay = retryDelaysMs[Math.min(Math.max(attemptCount - 1, 0), retryDelaysMs.length - 1)]!;
  return new Date(now.getTime() + delay).toISOString();
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
    this.migrate();
  }

  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 1) throw new Error(`Database schema version ${version} is newer than supported version 1`);
    if (version === 1) return;

    this.db.exec(`
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
        WHERE status IN ('queued', 'retryable_failed')
        ORDER BY sequence LIMIT 1
      `)
      .get() as EventRow | undefined;
    return head && head.available_at <= at.toISOString() ? head : undefined;
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
