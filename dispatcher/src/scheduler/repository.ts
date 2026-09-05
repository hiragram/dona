import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { EnqueueResult, EventEnvelope } from "../types.js";

export type ScheduleState = "active" | "paused" | "expired" | "needs_review" | "cancelled" | "completed";
export type Action = "slack.reminder.post" | "work.read_only";
export type Target = { kind: "none" }
  | { kind: "thread"; workspace_id: string; channel_id: string; thread_ts: string }
  | { kind: "channel"; workspace_id: string; channel_id: string }
  | { kind: "owner_dm"; workspace_id: string; channel_id: string; owner_id: string };
export interface StorageCodecs {
  recurrence(text: string): string;
  policy(text: string): string;
}
export interface Actor { tenant_id: string; actor_id: string; role: "owner" | "admin"; source_event_id: string | null }
// #6 owns parsing/normalization and recurrence calculation. These are its prepared storage values,
// not an API accepting untrusted JSON. No recurrence parser or calendar implementation lives here.
export interface RevisionInput {
  recurrence_json: string; policy_json: string; policy_version: 1;
  timezone: string | null; tzdb_version: string | null;
  authorization_id: string; authorization_revision: number; approver_id: string; approved_at: string; expires_at: string;
  action: Action; target: Target; content: string;
}
export interface Schedule {
  schedule_id: string; tenant_id: string; owner_id: string; state: ScheduleState;
  revision: number; next_due: string | null; high_watermark: string | null;
  created_at: string; updated_at: string; terminal_at: string | null;
}
export interface Run {
  run_id: string; schedule_id: string; revision: number; occurrence_key: string; scheduled_for: string;
  status: "materialized" | "started" | "completed" | "failed" | "cancelled" | "skipped" | "needs_review";
  reason: string | null; event_id: string | null; job_id: string | null; created_at: string;
  started_at: string | null; terminal_at: string | null;
}
export interface Outbox {
  outbox_id: string; run_id: string; kind: "slack.reminder.post" | "slack.work_result.post";
  idempotency_key: string; target_json: string; content: string | null; content_hash: string;
  status: "pending" | "claimed" | "request_started" | "sent" | "failed" | "cancelled" | "needs_review";
  attempt: number; available_at: string; claim_token: string | null; lease_until: string | null;
  request_started_at: string | null; receipt_id: string | null; created_at: string; updated_at: string;
  terminal_at: string | null; content_delete_at: string | null;
}
interface Revision extends Omit<RevisionInput, "target" | "content"> {
  schedule_id: string; revision: number; target_json: string; content: string | null;
  content_scope: "fixed_body" | "fixed_objective_redacted_result"; content_hash: string; recurrence_hash: string; content_delete_at: string | null;
}
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const add = (now: string, seconds: number): string => new Date(Date.parse(now) + seconds * 1000).toISOString().replace(".000Z", "Z");
function utc(value: string): void {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) || !Number.isFinite(Date.parse(value)) || add(value, 0) !== value) throw new Error("invalid_timestamp");
}
function id(value: string): void { if (!/^[A-Za-z0-9_:-]{1,160}$/.test(value)) throw new Error("invalid_identity"); }
function validateReceipt(value: string): void {
  // Slack message timestamps contain a decimal point; URLs and bodies are not receipt IDs.
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(value) || /^xox[baprs]-|^xapp-/i.test(value)) throw new Error("invalid_receipt");
}
function safeContent(value: string, limit: number): void {
  if (!value || [...value].length > limit || /xox[baprs]-|(?:token|password|secret)\s*[:=]|https?:\/\/[^\s]*(?:token=|signature=|files.slack.com)/i.test(value)) throw new Error("content_requires_redaction");
}

export class SchedulerRepository {
  constructor(private readonly db: Database.Database, private readonly enqueue: (event: EventEnvelope, at: Date) => EnqueueResult,
    private readonly codecs?: StorageCodecs) {}

  withCodecs(codecs: StorageCodecs): SchedulerRepository {
    return new SchedulerRepository(this.db, this.enqueue, codecs);
  }

  get(scheduleId: string): Schedule | undefined {
    return this.db.prepare("SELECT * FROM schedules WHERE schedule_id = ?").get(scheduleId) as Schedule | undefined;
  }
  getRun(runId: string): Run | undefined { return this.db.prepare("SELECT * FROM schedule_runs WHERE run_id = ?").get(runId) as Run | undefined; }
  getOutbox(outboxId: string, now: string): Outbox | undefined {
    utc(now);
    const row = this.db.prepare("SELECT * FROM connector_outbox WHERE outbox_id = ?").get(outboxId) as Outbox | undefined;
    if (row && row.content_delete_at && now >= row.content_delete_at) row.content = null;
    return row;
  }
  due(now: string, limit = 100): Schedule[] {
    utc(now); if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_limit");
    return this.db.prepare("SELECT * FROM schedules WHERE state = 'active' AND next_due <= ? ORDER BY next_due, schedule_id LIMIT ?").all(now, limit) as Schedule[];
  }
  private revision(schedule: Pick<Schedule, "schedule_id" | "revision">): Revision {
    return this.db.prepare("SELECT * FROM schedule_revisions WHERE schedule_id = ? AND revision = ?").get(schedule.schedule_id, schedule.revision) as Revision;
  }
  private checked(scheduleId: string, revision: number, actor?: Actor, ownerOnly = false): Schedule {
    const row = this.get(scheduleId);
    if (!row) throw new Error("schedule_not_found");
    if (row.revision !== revision) throw new Error("revision_conflict");
    if (actor) {
      id(actor.actor_id); id(actor.tenant_id);
      if (actor.source_event_id !== null) id(actor.source_event_id);
      if (actor.tenant_id !== row.tenant_id || (actor.actor_id !== row.owner_id && (ownerOnly || actor.role !== "admin"))) throw new Error("unauthorized");
    }
    return row;
  }
  private quota(tenant: string, owner: string): void {
    const row = this.db.prepare(`SELECT count(*) AS tenant, sum(owner_id = ?) AS owner FROM schedules
      WHERE tenant_id = ? AND state NOT IN ('cancelled','completed')`).get(owner, tenant) as { tenant: number; owner: number | null };
    if (row.tenant >= 100 || (row.owner ?? 0) >= 20) throw new Error("quota_exceeded");
  }
  private validateRevision(input: RevisionInput, owner: string, tenant: string, now: string): void {
    utc(now); utc(input.approved_at); utc(input.expires_at); id(input.authorization_id); id(input.approver_id);
    if (!Number.isSafeInteger(input.authorization_revision) || input.authorization_revision < 1) throw new Error("invalid_authorization");
    if (input.policy_version !== 1 || input.approver_id !== owner || input.approved_at > now || input.expires_at <= now ||
        Date.parse(input.expires_at) - Date.parse(input.approved_at) > 2592000000) throw new Error("invalid_authorization");
    if (input.action !== "slack.reminder.post" && input.action !== "work.read_only") throw new Error("invalid_action");
    safeContent(input.content, input.action === "work.read_only" ? 4000 : 2000);
    if (input.target.kind === "none") { if (input.action !== "work.read_only") throw new Error("invalid_target"); }
    else {
      if (!["thread", "channel", "owner_dm"].includes(input.target.kind)) throw new Error("invalid_target");
      id(input.target.workspace_id); id(input.target.channel_id);
      if (input.target.workspace_id !== tenant || (input.target.kind === "thread" && !/^\d{1,20}\.\d{6}$/.test(input.target.thread_ts)) || (input.target.kind === "owner_dm" && input.target.owner_id !== owner)) throw new Error("invalid_target");
    }
    if (!this.codecs) throw new Error("domain_codecs_required");
    if (this.codecs.recurrence(input.recurrence_json) !== input.recurrence_json ||
        this.codecs.policy(input.policy_json) !== input.policy_json) throw new Error("noncanonical_domain_document");
    // Parsing here only projects metadata from the canonical result of #6; validation belongs to its codecs.
    const recurrence = JSON.parse(input.recurrence_json) as { kind: string; timezone?: string; tzdb_version?: string };
    if (input.timezone !== (recurrence.timezone ?? null) || input.tzdb_version !== (recurrence.tzdb_version ?? null)) throw new Error("domain_metadata_conflict");
  }
  private insertRevision(scheduleId: string, revision: number, input: RevisionInput, now: string): void {
    const target = input.target.kind === "none" ? { kind: "none" } : {
      kind: input.target.kind, workspace_id: input.target.workspace_id, channel_id: input.target.channel_id,
      ...(input.target.kind === "thread" ? { thread_ts: input.target.thread_ts } : {}),
      ...(input.target.kind === "owner_dm" ? { owner_id: input.target.owner_id } : {}),
    };
    this.db.prepare(`INSERT INTO schedule_revisions (schedule_id, revision, recurrence_json, recurrence_hash,
      policy_json, policy_version, timezone, tzdb_version, authorization_id, authorization_revision, content_scope, approver_id, approved_at, expires_at,
      action, target_json, content, content_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      scheduleId, revision, input.recurrence_json, digest(input.recurrence_json), input.policy_json, input.policy_version,
      input.timezone, input.tzdb_version, input.authorization_id, input.authorization_revision, input.action === "slack.reminder.post" ? "fixed_body" : "fixed_objective_redacted_result", input.approver_id, input.approved_at, input.expires_at,
      input.action, JSON.stringify(target), input.content, digest(input.content), now);
  }
  private audit(before: Schedule | undefined, after: Schedule, operation: string, actor: Actor, now: string, outbox?: Outbox, run?: Run): void {
    // Explicit allowlist: no caller-provided before/after JSON, targets, bodies or error text.
    const auditRun = outbox ? this.getRun(outbox.run_id)! : run;
    const snapshot = this.revision(auditRun ?? after);
    const metadata = (row: Schedule) => ({ state: row.state, revision: row.revision, next_due: row.next_due, high_watermark: row.high_watermark });
    this.db.prepare(`INSERT INTO schedule_audit(schedule_id, revision, tenant_id, actor_id, source_event_id,
      operation, before_json, after_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(after.schedule_id, snapshot.revision,
      after.tenant_id, actor.actor_id, actor.source_event_id, operation, before ? JSON.stringify(metadata(before)) : null,
      JSON.stringify({ ...metadata(after), operation_revision: snapshot.revision, policy_version: snapshot.policy_version, tzdb_version: snapshot.tzdb_version, content_hash: outbox?.content_hash ?? snapshot.content_hash, recurrence_hash: snapshot.recurrence_hash,
        ...(auditRun ? { run: { run_id: auditRun.run_id, revision: auditRun.revision, status: auditRun.status, reason: auditRun.reason, event_id: auditRun.event_id, job_id: auditRun.job_id } } : {}),
        ...(outbox ? { outbox: { outbox_id: outbox.outbox_id, run_id: outbox.run_id, kind: outbox.kind, status: outbox.status,
          attempt: outbox.attempt, request_started_at: outbox.request_started_at, receipt_id: outbox.receipt_id } } : {}) }), now);
  }
  create(scheduleId: string, input: RevisionInput, nextDue: string, actor: Actor, now: string): Schedule {
    id(scheduleId); id(actor.actor_id); id(actor.tenant_id); utc(nextDue); utc(now);
    if (actor.source_event_id !== null) id(actor.source_event_id);
    if (actor.role !== "owner" || nextDue <= now) throw new Error("invalid_creation");
    this.validateRevision(input, actor.actor_id, actor.tenant_id, now);
    if (input.authorization_revision !== 1) throw new Error("authorization_revision_conflict");
    return this.db.transaction(() => {
      this.quota(actor.tenant_id, actor.actor_id);
      this.db.prepare(`INSERT INTO schedules(schedule_id, tenant_id, owner_id, state, revision, next_due, created_at, updated_at)
        VALUES (?,?,?,'active',1,?,?,?)`).run(scheduleId, actor.tenant_id, actor.actor_id, nextDue, now, now);
      this.insertRevision(scheduleId, 1, input, now);
      const row = this.get(scheduleId)!; this.audit(undefined, row, "create", actor, now); return row;
    }).immediate();
  }
  private suppress(scheduleId: string, now: string, reason: "cancelled" | "revision_replaced"): void {
    this.db.prepare(`UPDATE connector_outbox SET status = 'cancelled', terminal_at = ?, content_delete_at = MIN(COALESCE(content_delete_at, ?), ?), updated_at = ?,
      claim_token = NULL, lease_until = NULL WHERE run_id IN (SELECT run_id FROM schedule_runs WHERE schedule_id = ?)
      AND status IN ('pending','claimed')`).run(now, add(now, 604800), add(now, 604800), now, scheduleId);
    this.db.prepare(`UPDATE schedule_runs SET status = 'cancelled', reason = ?, terminal_at = ?
      WHERE schedule_id = ? AND status = 'materialized' AND NOT EXISTS
      (SELECT 1 FROM connector_outbox o WHERE o.run_id = schedule_runs.run_id AND o.status IN ('request_started','needs_review','sent'))`).run(reason, now, scheduleId);
  }
  update(scheduleId: string, expectedRevision: number, input: RevisionInput, nextDue: string, actor: Actor, now: string): Schedule {
    utc(now); utc(nextDue);
    return this.db.transaction(() => {
      const before = this.checked(scheduleId, expectedRevision, actor, true);
      if (!["paused", "expired", "needs_review"].includes(before.state) || nextDue <= now) throw new Error("invalid_transition");
      if (before.high_watermark !== null && nextDue <= before.high_watermark) throw new Error("invalid_next_due");
      if (this.db.prepare(`SELECT 1 FROM schedule_runs r WHERE r.schedule_id = ? AND (r.status = 'needs_review' OR
        EXISTS (SELECT 1 FROM connector_outbox o WHERE o.run_id = r.run_id AND o.status = 'needs_review')) LIMIT 1`).get(scheduleId)) throw new Error("reconcile_required");
      this.validateRevision(input, before.owner_id, before.tenant_id, now);
      if (input.authorization_revision !== expectedRevision + 1 || input.authorization_id === this.revision(before).authorization_id) throw new Error("authorization_revision_conflict");
      this.suppress(scheduleId, now, "revision_replaced");
      this.retireRevisions(scheduleId, now, expectedRevision);
      this.insertRevision(scheduleId, expectedRevision + 1, input, now);
      this.db.prepare("UPDATE schedules SET revision = revision + 1, state = 'active', next_due = ?, updated_at = ? WHERE schedule_id = ?")
        .run(nextDue, now, scheduleId);
      const after = this.get(scheduleId)!; this.audit(before, after, "update", actor, now); return after;
    }).immediate();
  }
  transition(scheduleId: string, expectedRevision: number, operation: "pause" | "resume" | "cancel", actor: Actor, now: string): Schedule {
    utc(now);
    if (!["pause", "resume", "cancel"].includes(operation)) throw new Error("invalid_transition");
    return this.db.transaction(() => {
      const before = this.checked(scheduleId, expectedRevision, actor, operation === "resume");
      if ((operation === "pause" && before.state !== "active") || (operation === "resume" && before.state !== "paused") ||
          (operation === "cancel" && ["cancelled", "completed"].includes(before.state))) throw new Error("invalid_transition");
      const old = this.revision(before);
      if (operation === "resume" && (old.expires_at <= now || old.content === null || (old.content_delete_at !== null && old.content_delete_at <= now))) throw new Error("authorization_expired");
      // Every mutation advances the concurrency revision; copying a paused snapshot never extends its authorization.
      const revision = expectedRevision + 1;
      this.db.prepare(`INSERT INTO schedule_revisions SELECT schedule_id, ?, recurrence_json, recurrence_hash, policy_json,
        policy_version, timezone, tzdb_version, authorization_id, authorization_revision, content_scope, approver_id, approved_at, expires_at, action, target_json,
        content, content_hash, content_delete_at, ?, terminal_at FROM schedule_revisions WHERE schedule_id = ? AND revision = ?`).run(revision, now, scheduleId, expectedRevision);
      this.retireRevisions(scheduleId, now, expectedRevision);
      const state = operation === "pause" ? "paused" : operation === "resume" ? "active" : "cancelled";
      this.db.prepare("UPDATE schedules SET state = ?, revision = ?, updated_at = ?, terminal_at = ? WHERE schedule_id = ?")
        .run(state, revision, now, state === "cancelled" ? now : null, scheduleId);
      if (operation !== "resume") this.suppress(scheduleId, now, "cancelled");
      if (operation === "cancel") this.retireRevisions(scheduleId, now);
      const after = this.get(scheduleId)!; this.audit(before, after, operation, actor, now); return after;
    }).immediate();
  }
  materialize(scheduleId: string, expectedRevision: number, scheduledFor: string, nextDue: string | null,
    now: string, actor: Actor, skip: "misfire" | "overlap" | null = null): { run: Run; duplicate: boolean } {
    utc(now); utc(scheduledFor); if (nextDue !== null) utc(nextDue);
    const result = this.db.transaction(() => {
      // An old caller may retry after the scheduler revision advanced. Identity/authorization still
      // apply, but an already persisted occurrence wins over its stale expected revision.
      const current = this.get(scheduleId);
      if (!current) throw new Error("schedule_not_found");
      const before = this.checked(scheduleId, current.revision, actor);
      const existing = this.db.prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? AND scheduled_for = ?").get(scheduleId, scheduledFor) as Run | undefined;
      if (existing) return { run: existing, duplicate: true };
      if (before.revision !== expectedRevision) throw new Error("revision_conflict");
      if (nextDue !== null && (nextDue <= scheduledFor || nextDue <= now)) throw new Error("invalid_next_due");
      if (before.state !== "active" || scheduledFor > now || scheduledFor !== before.next_due || (before.high_watermark !== null && scheduledFor <= before.high_watermark)) throw new Error("invalid_occurrence");
      const revision = this.revision(before);
      if (revision.expires_at <= now || revision.content === null) {
        this.expireSchedule(before, actor, now);
        return undefined;
      }
      const unresolved = this.db.prepare(`SELECT 1 FROM schedule_runs r WHERE r.schedule_id = ? AND
        (r.status IN ('materialized','started','needs_review') OR EXISTS
          (SELECT 1 FROM connector_outbox o WHERE o.run_id = r.run_id AND o.status IN ('pending','claimed','request_started','needs_review'))) LIMIT 1`).get(scheduleId);
      const reason = Date.parse(now) - Date.parse(scheduledFor) > 900000 ? "misfire" : skip ?? (unresolved ? "overlap" : null);
      const runId = `run_${randomUUID()}`;
      this.db.prepare(`INSERT INTO schedule_runs(run_id, schedule_id, revision, occurrence_key, scheduled_for, status, reason, created_at, terminal_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(runId, scheduleId, expectedRevision, scheduledFor, scheduledFor, reason ? "skipped" : "materialized", reason, now, reason ? now : null);
      if (!reason && revision.action === "slack.reminder.post") this.insertOutbox(runId, "slack.reminder.post", revision.target_json, revision.content!, now);
      if (!reason && revision.action === "work.read_only") {
        const result = this.enqueue({ schema_version: 1, source: "scheduler", external_event_id: `scheduler:${scheduleId}:${scheduledFor}`,
          type: "schedule_due", occurred_at: scheduledFor,
          subject: { tenant_id: before.tenant_id, owner_id: before.owner_id, schedule_id: scheduleId },
          payload: { run_id: runId, revision: expectedRevision }, reply_target: null }, new Date(now));
        if (result.duplicate) throw new Error("event_idempotency_conflict");
        this.db.prepare("UPDATE schedule_runs SET event_id = ? WHERE run_id = ?").run(result.row.event_id, runId);
      }
      this.db.prepare("UPDATE schedules SET high_watermark = ?, next_due = ?, updated_at = ? WHERE schedule_id = ?")
        .run(scheduledFor, nextDue, now, scheduleId);
      this.audit(before, this.get(scheduleId)!, "materialize", actor, now, undefined, this.getRun(runId)!);
      this.completeIfDrained(scheduleId, now);
      return { run: this.getRun(runId)!, duplicate: false };
    }).immediate();
    if (!result) throw new Error("authorization_expired");
    return result;
  }
  setRunState(runId: string, expected: Run["status"], next: "started" | "completed" | "failed" | "cancelled",
    actor: Actor, now: string, jobId: string | null = null, resultContent: string | null = null): Run {
    utc(now); if (jobId !== null) id(jobId); if (resultContent !== null) safeContent(resultContent, 2000);
    const result = this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run || run.status !== expected) throw new Error("run_conflict");
      const current = this.get(run.schedule_id)!;
      this.checked(current.schedule_id, current.revision, actor);
      const valid = expected === "materialized" ? ["started", "cancelled", "failed"] : expected === "started" ? ["completed", "failed", "cancelled"] : [];
      if (!valid.includes(next)) throw new Error("invalid_transition");
      if (next === "started") {
        const revision = this.revision(current);
        const reason = current.state !== "active" || current.revision !== run.revision ? "cancelled"
          : revision.expires_at <= now ? "authorization_expired"
          : Date.parse(now) - Date.parse(run.scheduled_for) > 900000 ? "misfire" : null;
        if (reason !== null) {
          if (reason === "authorization_expired") this.expireSchedule(current, actor, now);
          const status = reason === "misfire" ? "skipped" : "cancelled";
          this.db.prepare("UPDATE schedule_runs SET status = ?, reason = ?, terminal_at = ? WHERE run_id = ?").run(status, reason, now, runId);
          this.db.prepare(`UPDATE connector_outbox SET status = 'cancelled', terminal_at = ?, updated_at = ?,
            content_delete_at = COALESCE(content_delete_at, ?), claim_token = NULL, lease_until = NULL
            WHERE run_id = ? AND status IN ('pending','claimed')`).run(now, now, add(now, 604800), runId);
          this.audit(current, this.get(current.schedule_id)!, `run_${status}`, actor, now, undefined, this.getRun(runId)!);
          this.completeIfDrained(run.schedule_id, now);
          return undefined;
        }
      }
      if (jobId !== null) {
        const job = this.db.prepare("SELECT source_event_id FROM jobs WHERE job_id = ?").get(jobId) as { source_event_id: string } | undefined;
        if (!job || job.source_event_id !== run.event_id || (run.job_id !== null && run.job_id !== jobId)) throw new Error("job_reference_conflict");
      }
      const runSnapshot = this.revision(run);
      if (next === "completed" && runSnapshot.action === "work.read_only" &&
          (JSON.parse(runSnapshot.target_json) as Target).kind !== "none" && resultContent === null) throw new Error("result_content_required");
      if (resultContent !== null) {
        if (next !== "completed" || current.state !== "active" || current.revision !== run.revision) throw new Error("result_not_authorized");
        const revision = this.revision(current);
        if (revision.action !== "work.read_only" || revision.expires_at <= now) throw new Error("result_not_authorized");
        const target = JSON.parse(revision.target_json) as Target;
        if (target.kind !== "none") this.insertOutbox(runId, "slack.work_result.post", revision.target_json, resultContent, now);
      }
      if (next === "cancelled" || next === "failed") {
        this.db.prepare(`UPDATE connector_outbox SET status = 'cancelled', terminal_at = ?, updated_at = ?,
          content_delete_at = COALESCE(content_delete_at, ?), claim_token = NULL, lease_until = NULL
          WHERE run_id = ? AND status IN ('pending','claimed')`).run(now, now, add(now, 604800), runId);
      }
      this.db.prepare(`UPDATE schedule_runs SET status = ?, job_id = COALESCE(?, job_id), started_at =
        CASE WHEN ? = 'started' THEN ? ELSE started_at END, terminal_at = ? WHERE run_id = ?`)
        .run(next, jobId, next, now, next === "started" ? null : now, runId);
      this.audit(current, current, `run_${next}`, actor, now, undefined, this.getRun(runId)!);
      this.completeIfDrained(run.schedule_id, now);
      return this.getRun(runId)!;
    }).immediate();
    if (!result) throw new Error("run_not_authorized");
    return result;
  }
  reconcile(outboxId: string, outcome: "sent" | "failed", receiptId: string, actor: Actor, now: string): Outbox {
    utc(now); validateReceipt(receiptId);
    if (actor.role !== "admin") throw new Error("admin_required");
    if (outcome !== "sent" && outcome !== "failed") throw new Error("invalid_outcome");
    return this.db.transaction(() => {
      const row = this.getOutbox(outboxId, now);
      if (!row || row.status !== "needs_review") throw new Error("invalid_transition");
      const run = this.getRun(row.run_id)!; const schedule = this.get(run.schedule_id)!;
      this.checked(schedule.schedule_id, schedule.revision, actor);
      this.db.prepare(`UPDATE connector_outbox SET status = ?, receipt_id = ?, terminal_at = ?, updated_at = ?,
        claim_token = NULL, lease_until = NULL WHERE outbox_id = ?`).run(outcome, receiptId, now, now, outboxId);
      this.db.prepare("UPDATE schedule_runs SET status = ?, terminal_at = ? WHERE run_id = ? AND status = 'needs_review'")
        .run(outcome === "sent" ? "completed" : "failed", now, run.run_id);
      this.audit(schedule, schedule, `reconcile_${outcome}`, actor, now, this.getOutbox(outboxId, now)!);
      // Admin reconciliation returns metadata, never the owner's body.
      return { ...this.getOutbox(outboxId, now)!, content: null };
    }).immediate();
  }
  private retireRevisions(scheduleId: string, now: string, revision?: number): void {
    const rows = this.db.prepare("SELECT revision, expires_at, terminal_at, content_delete_at FROM schedule_revisions WHERE schedule_id = ?" +
      (revision === undefined ? "" : " AND revision = ?")).all(...(revision === undefined ? [scheduleId] : [scheduleId, revision])) as
      { revision: number; expires_at: string; terminal_at: string | null; content_delete_at: string | null }[];
    for (const row of rows) {
      const endedAt = [row.expires_at, row.terminal_at ?? now, now].sort()[0]!;
      const deadline = add(endedAt, 604800);
      this.db.prepare("UPDATE schedule_revisions SET terminal_at = ?, content_delete_at = ? WHERE schedule_id = ? AND revision = ?")
        .run(endedAt, row.content_delete_at !== null && row.content_delete_at < deadline ? row.content_delete_at : deadline, scheduleId, row.revision);
    }
  }
  private expireSchedule(before: Schedule, actor: Actor, now: string): void {
    this.suppress(before.schedule_id, now, "cancelled");
    this.db.prepare("UPDATE schedules SET state = 'expired', updated_at = ? WHERE schedule_id = ?").run(now, before.schedule_id);
    this.retireRevisions(before.schedule_id, now, before.revision);
    this.audit(before, this.get(before.schedule_id)!, "expire", actor, now);
  }
  private runCanSend(row: Outbox, run: Run): boolean {
    return row.kind === "slack.reminder.post" ? ["materialized", "started"].includes(run.status) : run.status === "completed";
  }
  private completeIfDrained(scheduleId: string, now: string): void {
    const before = this.get(scheduleId)!;
    if (before.state !== "active" || before.next_due !== null || before.high_watermark === null ||
        (JSON.parse(this.revision(before).recurrence_json) as { kind: string }).kind !== "once") return;
    const unsettled = this.db.prepare(`SELECT 1 FROM schedule_runs r WHERE r.schedule_id = ? AND
      (r.status IN ('materialized','started','needs_review') OR EXISTS (SELECT 1 FROM connector_outbox o
        WHERE o.run_id = r.run_id AND o.status IN ('pending','claimed','request_started','needs_review'))) LIMIT 1`).get(scheduleId);
    if (unsettled) return;
    this.db.prepare("UPDATE schedules SET state = 'completed', terminal_at = ?, updated_at = ? WHERE schedule_id = ?").run(now, now, scheduleId);
    this.retireRevisions(scheduleId, now);
    this.audit(before, this.get(scheduleId)!, "complete", { tenant_id: before.tenant_id, actor_id: "scheduler", role: "admin", source_event_id: null }, now);
  }
  private expireUnsent(row: Outbox, now: string): boolean {
    if (row.status !== "pending" && row.status !== "claimed") return false;
    const run = this.getRun(row.run_id)!; const schedule = this.get(run.schedule_id)!;
    const snapshot = this.revision(run);
    const ageOrigin = row.kind === "slack.reminder.post" ? run.scheduled_for : run.terminal_at;
    const reason = schedule.state !== "active" || schedule.revision !== run.revision || !this.runCanSend(row, run) ? "cancelled"
      : snapshot.expires_at <= now ? "authorization_expired"
      : ageOrigin === null || Date.parse(now) - Date.parse(ageOrigin) > 900000 ? "misfire"
      : row.content === null || (row.content_delete_at !== null && row.content_delete_at <= now) ? "cancelled"
      : null;
    if (reason === null) return false;
    if (reason === "authorization_expired") this.expireSchedule(schedule,
      { tenant_id: schedule.tenant_id, actor_id: "scheduler", role: "admin", source_event_id: null }, now);
    this.db.prepare(`UPDATE connector_outbox SET status = 'cancelled', terminal_at = ?, updated_at = ?,
      content_delete_at = COALESCE(content_delete_at, ?), claim_token = NULL, lease_until = NULL WHERE outbox_id = ?`)
      .run(now, now, add(now, 604800), row.outbox_id);
    if (row.kind === "slack.reminder.post" && ["materialized", "started"].includes(run.status)) this.db.prepare(`UPDATE schedule_runs SET status = ?, reason = ?, terminal_at = ?
      WHERE run_id = ?`).run(reason === "misfire" ? "skipped" : "cancelled", reason, now, row.run_id);
    this.auditOutbox(row, `outbox_${reason}`, now);
    this.completeIfDrained(run.schedule_id, now);
    return true;
  }
  private insertOutbox(runId: string, kind: Outbox["kind"], targetJson: string, content: string, now: string): void {
    this.db.prepare(`INSERT INTO connector_outbox(outbox_id, run_id, kind, idempotency_key, target_json, content, content_hash,
      status, available_at, created_at, updated_at, content_delete_at) VALUES (?,?,?,?,?,?,?,'pending',?,?,?,?)`).run(
      `outbox_${randomUUID()}`, runId, kind, `${runId}:${kind}`, targetJson, content, digest(content), now, now, now, add(now, 604800));
  }
  claim(now: string, leaseSeconds = 60): Outbox | undefined {
    utc(now); if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) throw new Error("invalid_lease");
    return this.db.transaction(() => {
      this.recover(now);
      const row = this.db.prepare(`SELECT o.* FROM connector_outbox o JOIN schedule_runs r USING(run_id)
        JOIN schedules s ON s.schedule_id = r.schedule_id JOIN schedule_revisions v ON v.schedule_id = r.schedule_id AND v.revision = r.revision
        WHERE o.status = 'pending' AND o.available_at <= ? AND o.content IS NOT NULL AND s.state = 'active'
        AND ((o.kind = 'slack.reminder.post' AND r.status IN ('materialized','started'))
          OR (o.kind = 'slack.work_result.post' AND r.status = 'completed'))
        AND s.revision = r.revision AND v.expires_at > ? AND (o.content_delete_at IS NULL OR o.content_delete_at > ?)
        ORDER BY o.available_at, o.outbox_id LIMIT 1`).get(now, now, now) as Outbox | undefined;
      if (!row) return undefined;
      this.db.prepare("UPDATE connector_outbox SET status = 'claimed', claim_token = ?, lease_until = ?, updated_at = ? WHERE outbox_id = ?")
        .run(randomUUID(), add(now, leaseSeconds), now, row.outbox_id);
      return this.getOutbox(row.outbox_id, now);
    }).immediate();
  }
  requestStarted(outboxId: string, token: string, now: string): Outbox {
    utc(now);
    const result = this.db.transaction(() => {
      const row = this.getOutbox(outboxId, now);
      if (!row || row.status !== "claimed" || row.claim_token !== token || row.lease_until! <= now) throw new Error("claim_conflict");
      // Commit the terminal decision before reporting refusal to the sender.
      if (this.expireUnsent(row, now)) return undefined;
      const run = this.getRun(row.run_id)!;
      if (!this.runCanSend(row, run)) throw new Error("write_not_authorized");
      if (row.attempt >= 3) throw new Error("attempt_limit");
      this.db.prepare("UPDATE connector_outbox SET status = 'request_started', request_started_at = ?, attempt = attempt + 1, updated_at = ? WHERE outbox_id = ?")
        .run(now, now, outboxId);
      this.auditOutbox(row, "outbox_request_started", now);
      return this.getOutbox(outboxId, now)!;
    }).immediate();
    if (!result) throw new Error("write_not_authorized");
    return result;
  }
  recover(now: string): number {
    utc(now);
    return this.db.transaction(() => {
      const ambiguous = this.db.prepare("SELECT * FROM connector_outbox WHERE status = 'request_started' AND lease_until <= ?").all(now) as Outbox[];
      for (const row of ambiguous) this.markAmbiguous(row, now);
      const result = this.db.prepare(`UPDATE connector_outbox SET status = 'pending', claim_token = NULL, lease_until = NULL,
        updated_at = ? WHERE status = 'claimed' AND lease_until <= ? AND request_started_at IS NULL`).run(now, now);
      let expired = 0;
      const unsent = this.db.prepare("SELECT * FROM connector_outbox WHERE status IN ('pending','claimed')").all() as Outbox[];
      for (const row of unsent) if (this.expireUnsent(row, now)) expired++;
      return result.changes + ambiguous.length + expired;
    }).immediate();
  }
  private auditOutbox(row: Outbox, operation: string, now: string, before?: Schedule): void {
    const run = this.getRun(row.run_id)!;
    const schedule = this.get(run.schedule_id)!;
    this.audit(before ?? schedule, schedule, operation, { tenant_id: schedule.tenant_id, actor_id: "scheduler", role: "admin", source_event_id: null }, now, this.getOutbox(row.outbox_id, now)!);
  }
  private markAmbiguous(row: Outbox, now: string): void {
    this.db.prepare("UPDATE connector_outbox SET status = 'needs_review', content_delete_at = COALESCE(content_delete_at, ?), updated_at = ? WHERE outbox_id = ?")
      .run(add(now, 604800), now, row.outbox_id);
    const run = this.getRun(row.run_id)!;
    const before = this.get(run.schedule_id)!;
    this.suppress(run.schedule_id, now, "cancelled");
    this.db.prepare("UPDATE schedule_runs SET status = 'needs_review', reason = 'ambiguous_write' WHERE run_id = ?").run(run.run_id);
    this.db.prepare("UPDATE schedules SET state = 'needs_review', updated_at = ? WHERE schedule_id = ? AND state NOT IN ('cancelled','completed')").run(now, run.schedule_id);
    this.retireRevisions(run.schedule_id, now);
    this.auditOutbox(row, "outbox_needs_review", now, before);
  }
  finishWrite(outboxId: string, token: string, outcome: "sent" | "not_accepted" | "ambiguous", now: string, receiptId: string | null = null, retryAfterSeconds = 0): Outbox {
    utc(now); if (receiptId !== null) validateReceipt(receiptId);
    if (!["sent", "not_accepted", "ambiguous"].includes(outcome)) throw new Error("invalid_outcome");
    if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 0 || retryAfterSeconds > 2592000) throw new Error("invalid_retry_after");
    return this.db.transaction(() => {
      const row = this.getOutbox(outboxId, now);
      if (!row || row.status !== "request_started" || row.claim_token !== token) throw new Error("claim_conflict");
      if (outcome === "ambiguous") this.markAmbiguous(row, now);
      else {
        if (outcome === "sent" && receiptId === null) throw new Error("receipt_required");
        const run = this.getRun(row.run_id)!;
        const schedule = this.get(run.schedule_id)!;
        const authorized = this.runCanSend(row, run) && schedule.state === "active" && schedule.revision === run.revision && this.revision(schedule).expires_at > now;
        const retry = outcome === "not_accepted" && row.attempt < 3 && authorized;
        const status = outcome === "sent" ? "sent" : retry ? "pending" : authorized ? "failed" : "cancelled";
        this.db.prepare(`UPDATE connector_outbox SET status = ?, available_at = ?, request_started_at = ?, receipt_id = ?,
          claim_token = NULL, lease_until = NULL, terminal_at = ?, content_delete_at = ?, updated_at = ? WHERE outbox_id = ?`).run(
          status, add(now, Math.max(retryAfterSeconds, row.attempt === 1 ? 1 : 5)), retry ? null : row.request_started_at,
          receiptId, retry ? null : now, row.content_delete_at === null ? add(now, 604800) : row.content_delete_at, now, outboxId);
      }
      if (outcome !== "ambiguous") {
        this.expireUnsent(this.getOutbox(outboxId, now)!, now);
        const finished = this.getOutbox(outboxId, now)!;
        if (row.kind === "slack.reminder.post" && finished.terminal_at !== null) {
          this.db.prepare("UPDATE schedule_runs SET status = ?, reason = ?, terminal_at = ? WHERE run_id = ? AND status IN ('materialized','started')")
            .run(finished.status === "sent" ? "completed" : finished.status === "cancelled" ? "cancelled" : "failed",
              finished.status === "cancelled" ? "cancelled" : null, now, row.run_id);
        }
        this.auditOutbox(row, `outbox_${outcome}`, now);
      }
      const current = this.get(this.getRun(row.run_id)!.schedule_id)!;
      if (["active", "paused"].includes(current.state) && this.revision(current).expires_at <= now) {
        this.expireSchedule(current, { tenant_id: current.tenant_id, actor_id: "scheduler", role: "admin", source_event_id: null }, now);
      }
      this.completeIfDrained(current.schedule_id, now);
      return this.getOutbox(outboxId, now)!;
    }).immediate();
  }
  redactedBackup(): Record<string, unknown[]> {
    return this.db.transaction(() => ({
      schedules: this.db.prepare("SELECT * FROM schedules").all(),
      revisions: this.db.prepare(`SELECT schedule_id, revision, policy_version, timezone, tzdb_version,
        authorization_id, authorization_revision, approver_id, approved_at, expires_at, action, content_scope,
        content_hash, recurrence_hash, content_delete_at, created_at, terminal_at FROM schedule_revisions`).all(),
      runs: this.db.prepare("SELECT * FROM schedule_runs").all(),
      outbox: this.db.prepare(`SELECT outbox_id, run_id, kind, idempotency_key, content_hash, status, attempt,
        available_at, claim_token, lease_until, request_started_at, receipt_id, created_at, updated_at, terminal_at, content_delete_at
        FROM connector_outbox`).all(),
      audit: this.db.prepare("SELECT * FROM schedule_audit ORDER BY sequence").all(),
    }))();
  }
  auditHistory(scheduleId: string): unknown[] {
    return this.db.prepare("SELECT * FROM schedule_audit WHERE schedule_id = ? ORDER BY sequence").all(scheduleId);
  }
  purge(now: string): void {
    utc(now);
    this.db.transaction(() => {
      const currentExpired = this.db.prepare(`SELECT s.* FROM schedules s JOIN schedule_revisions r
        ON r.schedule_id = s.schedule_id AND r.revision = s.revision
        WHERE s.state IN ('active','paused') AND r.expires_at <= ?`).all(now) as Schedule[];
      for (const row of currentExpired) this.expireSchedule(row,
        { tenant_id: row.tenant_id, actor_id: "scheduler", role: "admin", source_event_id: null }, now);
      const expired = this.db.prepare("SELECT schedule_id, revision FROM schedule_revisions WHERE expires_at <= ? AND terminal_at IS NULL")
        .all(now) as { schedule_id: string; revision: number }[];
      for (const row of expired) this.retireRevisions(row.schedule_id, now, row.revision);
      this.db.prepare("UPDATE schedule_revisions SET content = NULL WHERE content_delete_at <= ? OR expires_at <= ?").run(now, add(now, -604800));
      this.db.prepare("UPDATE connector_outbox SET content = NULL WHERE content_delete_at <= ?").run(now);
      this.db.prepare("DELETE FROM schedule_audit WHERE created_at <= ?").run(add(now, -7776000));
      // Unresolved fences and references survive metadata retention. No deletion can resurrect a wake:
      // each schedule retains its high-watermark independently of its run ledger.
      this.db.prepare(`DELETE FROM schedule_runs WHERE terminal_at <= ? AND NOT EXISTS
        (SELECT 1 FROM connector_outbox o WHERE o.run_id = schedule_runs.run_id AND (o.terminal_at IS NULL OR o.terminal_at > ?))`)
        .run(add(now, -2592000), add(now, -2592000));
      this.db.prepare(`DELETE FROM schedules WHERE terminal_at <= ? AND NOT EXISTS
        (SELECT 1 FROM schedule_runs r WHERE r.schedule_id = schedules.schedule_id)`).run(add(now, -2592000));
      this.db.prepare(`DELETE FROM schedule_revisions WHERE content IS NULL AND terminal_at <= ? AND NOT EXISTS
        (SELECT 1 FROM schedules s WHERE s.schedule_id = schedule_revisions.schedule_id AND s.revision = schedule_revisions.revision)
        AND NOT EXISTS (SELECT 1 FROM schedule_runs r WHERE r.schedule_id = schedule_revisions.schedule_id AND r.revision = schedule_revisions.revision)`)
        .run(add(now, -2592000));
    }).immediate();
  }
}
