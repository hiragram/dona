import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { insertEventJobBinding } from "../job-routing.js";
import type { EnqueueResult, EventEnvelope } from "../types.js";
import type { ScheduleDefinition } from "./domain.js";
import { definitionFingerprint } from "./fingerprint.js";

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
export interface CompactSkip { from: string; through: string; count: number }
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
  list_sequence: number; idempotency_key_hash: string | null; create_payload_hash: string;
}
export interface ScheduleClaim extends Schedule { claim_owner: string; claim_until: string; claim_fence: number }
export type MaterializationDefinition = ScheduleDefinition;
export interface Run {
  run_id: string; schedule_id: string; revision: number; occurrence_key: string; scheduled_for: string;
  status: "materialized" | "started" | "completed" | "failed" | "cancelled" | "skipped" | "needs_review";
  reason: string | null; event_id: string | null; job_id: string | null; created_at: string;
  started_at: string | null; terminal_at: string | null;
}
export interface ScheduleView extends Schedule {
  action: Action; target: Target; timezone: string | null; tzdb_version: string | null;
  expires_at: string; recurrence_json: string; policy_json: string; content_hash: string; authorization_id: string;
}
export interface ListedSchedule { schedule: ScheduleView; sequence: number }
export interface Outbox {
  outbox_id: string; run_id: string; kind: "slack.reminder.post" | "slack.work_result.post";
  idempotency_key: string; target_json: string; content: string | null; content_hash: string;
  status: "pending" | "claimed" | "request_started" | "sent" | "failed" | "cancelled" | "needs_review";
  attempt: number; available_at: string; claim_token: string | null; lease_until: string | null;
  request_started_at: string | null; receipt_id: string | null; created_at: string; updated_at: string;
  terminal_at: string | null; content_delete_at: string | null;
}
export type ReconciledOutbox = Pick<Outbox, "outbox_id" | "run_id" | "kind" | "idempotency_key" | "content_hash" |
  "status" | "attempt" | "available_at" | "lease_until" | "request_started_at" | "receipt_id" | "created_at" |
  "updated_at" | "terminal_at" | "content_delete_at">;
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
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(value) || hasCredentialPattern(value)) throw new Error("invalid_receipt");
}
function hasCredentialPattern(value: string): boolean {
  return /xox[a-z]-|xapp-|https?:\/\/hooks\.slack\.com\/services\/|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{8,}/i.test(value);
}
function safeContent(value: string, limit: number): void {
  if (!value || [...value].length > limit || hasCredentialPattern(value) || /<!(?:channel|here|everyone)>|<!subteam\^[A-Z0-9]+(?:\|[^>]+)?>|<@[A-Z0-9]+>|(?:token|password|secret)\s*[:=]|https?:\/\/[^\s]*(?:token=|signature=|files.slack.com)/i.test(value)) throw new Error("content_requires_redaction");
}
function truncateResultContent(value: string): string {
  if (!value || hasCredentialPattern(value) || /<!(?:channel|here|everyone)>|<!subteam\^[A-Z0-9]+(?:\|[^>]+)?>|<@[A-Z0-9]+>|(?:token|password|secret)\s*[:=]|https?:\/\/[^\s]*(?:token=|signature=|files.slack.com)/i.test(value)) throw new Error("content_requires_redaction");
  const points = [...value];
  return points.length <= 2000 ? value : `${points.slice(0, 1999).join("")}…`;
}
export function validateWorkResultContent(value: string): void { truncateResultContent(value); }

export class SchedulerRepository {
  constructor(private readonly db: Database.Database, private readonly enqueue: (event: EventEnvelope, at: Date) => EnqueueResult,
    private readonly codecs?: StorageCodecs, private readonly deleteJobResult?: (jobId:string,resultPath:string)=>boolean) {}

  withCodecs(codecs: StorageCodecs): SchedulerRepository {
    return new SchedulerRepository(this.db, this.enqueue, codecs, this.deleteJobResult);
  }

  get(scheduleId: string): Schedule | undefined {
    return this.db.prepare("SELECT * FROM schedules WHERE schedule_id = ?").get(scheduleId) as Schedule | undefined;
  }
  getAuthorized(scheduleId: string, actor: Actor): ScheduleView | undefined {
    const row = this.get(scheduleId);
    if (!row) return undefined;
    this.checked(scheduleId, row.revision, actor);
    const revision = this.revision(row);
    return this.view(row, revision);
  }
  private view(row: Schedule, revision: Revision): ScheduleView {
    return { ...row, action: revision.action, target: JSON.parse(revision.target_json) as Target,
      timezone: revision.timezone, tzdb_version: revision.tzdb_version, expires_at: revision.expires_at,
      recurrence_json: revision.recurrence_json, policy_json: revision.policy_json, content_hash: revision.content_hash,
      authorization_id: revision.authorization_id };
  }
  listAuthorized(actor: Actor, limit: number, afterSequence = 0): ListedSchedule[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_limit");
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("invalid_cursor");
    id(actor.tenant_id); id(actor.actor_id);
    const rows = this.db.prepare(`SELECT * FROM schedules WHERE tenant_id = ? AND owner_id = ?
      AND list_sequence > ? ORDER BY list_sequence LIMIT ?`)
      .all(actor.tenant_id, actor.actor_id, afterSequence, limit) as Schedule[];
    return rows.map(row => ({ schedule: this.getAuthorized(row.schedule_id, actor)!, sequence: row.list_sequence }));
  }
  runHistory(scheduleId: string, actor: Actor, limit: number, cursor?: { scheduled_for: string; run_id: string }): Run[] {
    const schedule = this.get(scheduleId);
    if (!schedule) throw new Error("schedule_not_found");
    this.checked(scheduleId, schedule.revision, actor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_limit");
    const scheduledFor = cursor?.scheduled_for ?? ""; const runId = cursor?.run_id ?? "";
    return this.db.prepare(`SELECT * FROM schedule_runs WHERE schedule_id = ? AND
      (scheduled_for > ? OR (scheduled_for = ? AND run_id > ?))
      ORDER BY scheduled_for, run_id LIMIT ?`).all(scheduleId, scheduledFor, scheduledFor, runId, limit) as Run[];
  }
  pendingMaterializedCount(scheduleId: string): number {
    return (this.db.prepare("SELECT count(*) AS count FROM schedule_runs WHERE schedule_id = ? AND status = 'materialized'")
      .get(scheduleId) as { count: number }).count;
  }
  hasAuditOperation(scheduleId: string, revision: number, operation: string, sourceEventId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM schedule_audit WHERE schedule_id = ? AND revision = ?
      AND operation = ? AND source_event_id = ? LIMIT 1`).get(scheduleId, revision, operation, sourceEventId) !== undefined;
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
  claimDue(owner: string, now: string, leaseSeconds = 60, excludedScheduleIds: readonly string[] = []): ScheduleClaim | undefined {
    id(owner); utc(now);
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) throw new Error("invalid_lease");
    if (excludedScheduleIds.length > 100) throw new Error("invalid_limit");
    for (const scheduleId of excludedScheduleIds) id(scheduleId);
    return this.db.transaction(() => {
      const exclusion = excludedScheduleIds.length > 0 ? `AND s.schedule_id NOT IN (${excludedScheduleIds.map(() => "?").join(",")})` : "";
      const row = this.db.prepare(`SELECT s.schedule_id FROM schedules s LEFT JOIN schedule_claims c USING(schedule_id)
        WHERE s.state = 'active' AND s.next_due <= ? AND (c.claim_until IS NULL OR c.claim_until <= ?)
        ${exclusion} ORDER BY s.next_due, s.schedule_id LIMIT 1`).get(now, now, ...excludedScheduleIds) as { schedule_id: string } | undefined;
      if (!row) return undefined;
      this.db.prepare(`INSERT INTO schedule_claims(schedule_id, claim_owner, claim_until, claim_fence) VALUES(?,?,?,1)
        ON CONFLICT(schedule_id) DO UPDATE SET claim_owner = excluded.claim_owner, claim_until = excluded.claim_until,
          claim_fence = schedule_claims.claim_fence + 1 WHERE schedule_claims.claim_until IS NULL OR schedule_claims.claim_until <= ?`)
        .run(row.schedule_id, owner, add(now, leaseSeconds), now);
      const claim = this.db.prepare("SELECT * FROM schedule_claims WHERE schedule_id = ? AND claim_owner = ?").get(row.schedule_id, owner) as
        { claim_owner: string; claim_until: string; claim_fence: number } | undefined;
      return claim ? { ...this.get(row.schedule_id)!, ...claim } : undefined;
    }).immediate();
  }
  releaseClaims(owner: string, now: string): number {
    id(owner); utc(now);
    return this.db.prepare("UPDATE schedule_claims SET claim_owner = NULL, claim_until = NULL WHERE claim_owner = ?").run(owner).changes;
  }
  expireDue(now: string, limit = 100): number {
    utc(now); if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_limit");
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT s.* FROM schedules s JOIN schedule_revisions v
        ON v.schedule_id = s.schedule_id AND v.revision = s.revision
        WHERE s.state = 'active' AND s.next_due <= ? AND v.expires_at <= ? ORDER BY s.next_due, s.schedule_id LIMIT ?`)
        .all(now, now, limit) as Schedule[];
      for (const row of rows) this.expireSchedule(row,
        { tenant_id: row.tenant_id, actor_id: "scheduler", role: "admin", source_event_id: null }, now);
      return rows.length;
    }).immediate();
  }
  materializationDefinition(scheduleId: string, revision: number): MaterializationDefinition {
    const schedule = this.checked(scheduleId, revision);
    const snapshot = this.revision(schedule);
    if (snapshot.content === null) throw new Error("schedule_content_unavailable");
    const target = JSON.parse(snapshot.target_json) as Target;
    const action = snapshot.action === "slack.reminder.post"
      ? { kind: "reminder" as const, action: "slack.reminder.post" as const, target: target as Exclude<Target, { kind: "none" }>, body: snapshot.content }
      : { kind: "work" as const, action: "work.read_only" as const, objective: snapshot.content,
          notification: target.kind === "none" ? { kind: "none" as const } : { kind: "slack" as const, action: "slack.work_result.post" as const, target } };
    return {
      schedule_id: schedule.schedule_id, revision: schedule.revision, tenant_id: schedule.tenant_id, owner_id: schedule.owner_id,
      action, recurrence: JSON.parse(snapshot.recurrence_json), policy: JSON.parse(snapshot.policy_json),
    };
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
    if (hasCredentialPattern(input.authorization_id)) throw new Error("invalid_authorization");
    if (!Number.isSafeInteger(input.authorization_revision) || input.authorization_revision < 1) throw new Error("invalid_authorization");
    if (input.policy_version !== 1 || input.approver_id !== owner || input.approved_at > now || input.expires_at <= now ||
        Date.parse(input.expires_at) - Date.parse(input.approved_at) > 2592000000) throw new Error("invalid_authorization");
    if (input.action !== "slack.reminder.post" && input.action !== "work.read_only") throw new Error("invalid_action");
    safeContent(input.content, input.action === "work.read_only" ? 4000 : 2000);
    if (input.target.kind === "none") { if (input.action !== "work.read_only") throw new Error("invalid_target"); }
    else {
      if (!["thread", "channel", "owner_dm"].includes(input.target.kind)) throw new Error("invalid_target");
      id(input.target.workspace_id); id(input.target.channel_id);
      if (hasCredentialPattern(input.target.workspace_id) || hasCredentialPattern(input.target.channel_id) ||
          (input.target.kind === "owner_dm" && hasCredentialPattern(input.target.owner_id)) ||
          input.target.workspace_id !== tenant || (input.target.kind === "thread" && !/^\d{1,20}\.\d{6}$/.test(input.target.thread_ts)) ||
          (input.target.kind === "owner_dm" && input.target.owner_id !== owner)) throw new Error("invalid_target");
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
  private audit(before: Schedule | undefined, after: Schedule, operation: string, actor: Actor, now: string, outbox?: Outbox, run?: Run, compactSkip?: CompactSkip): void {
    // Explicit allowlist: no caller-provided before/after JSON, targets, bodies or error text.
    const auditRun = outbox ? this.getRun(outbox.run_id)! : run;
    const snapshot = this.revision(auditRun ?? after);
    const metadata = (row: Schedule) => ({ state: row.state, revision: row.revision, next_due: row.next_due, high_watermark: row.high_watermark });
    const revisionMetadata = (revision: Revision) => ({ action: revision.action, policy_version: revision.policy_version,
      tzdb_version: revision.tzdb_version, content_hash: revision.content_hash, recurrence_hash: revision.recurrence_hash });
    this.db.prepare(`INSERT INTO schedule_audit(schedule_id, revision, tenant_id, actor_id, source_event_id,
      operation, before_json, after_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(after.schedule_id, snapshot.revision,
      after.tenant_id, actor.actor_id, actor.source_event_id, operation,
      before ? JSON.stringify({ ...metadata(before), ...revisionMetadata(this.revision(before)) }) : null,
      JSON.stringify({ ...metadata(after), operation_revision: snapshot.revision, action: snapshot.action, policy_version: snapshot.policy_version, tzdb_version: snapshot.tzdb_version, content_hash: outbox?.content_hash ?? snapshot.content_hash, recurrence_hash: snapshot.recurrence_hash,
        ...(compactSkip ? { compact_skip: { from: compactSkip.from, through: compactSkip.through, count: compactSkip.count, reason: "misfire" } } : {}),
        ...(auditRun ? { run: { run_id: auditRun.run_id, revision: auditRun.revision, status: auditRun.status, reason: auditRun.reason, event_id: auditRun.event_id, job_id: auditRun.job_id } } : {}),
        ...(outbox ? { outbox: { outbox_id: outbox.outbox_id, run_id: outbox.run_id, kind: outbox.kind, status: outbox.status,
          attempt: outbox.attempt, request_started_at: outbox.request_started_at, receipt_id: outbox.receipt_id } } : {}) }), now);
  }
  create(scheduleId: string, input: RevisionInput, nextDue: string, actor: Actor, now: string,
    idempotencyKeyHash: string | null = null): Schedule {
    id(scheduleId); id(actor.actor_id); id(actor.tenant_id); utc(nextDue); utc(now);
    if (actor.source_event_id !== null) id(actor.source_event_id);
    if (actor.role !== "owner" || nextDue <= now) throw new Error("invalid_creation");
    this.validateRevision(input, actor.actor_id, actor.tenant_id, now);
    if (input.authorization_revision !== 1) throw new Error("authorization_revision_conflict");
    return this.db.transaction(() => {
      this.quota(actor.tenant_id, actor.actor_id);
      const sequence = (this.db.prepare("SELECT next_value FROM schedule_list_sequence WHERE singleton = 1").get() as { next_value: number }).next_value;
      this.db.prepare("UPDATE schedule_list_sequence SET next_value = next_value + 1 WHERE singleton = 1").run();
      const targetJson = JSON.stringify(input.target.kind === "none" ? { kind: "none" } : input.target);
      const createPayloadHash = definitionFingerprint({ recurrence_json: input.recurrence_json, policy_json: input.policy_json,
        action: input.action, target_json: targetJson, content_hash: digest(input.content) });
      this.db.prepare(`INSERT INTO schedules(schedule_id, tenant_id, owner_id, state, revision, next_due, created_at, updated_at,
        list_sequence, idempotency_key_hash, create_payload_hash) VALUES (?,?,?,'active',1,?,?,?,?,?,?)`)
        .run(scheduleId, actor.tenant_id, actor.actor_id, nextDue, now, now, sequence, idempotencyKeyHash, createPayloadHash);
      this.insertRevision(scheduleId, 1, input, now);
      const row = this.get(scheduleId)!; this.audit(undefined, row, "create", actor, now); return row;
    }).immediate();
  }
  private suppress(scheduleId: string, now: string, reason: "cancelled" | "revision_replaced" | "authorization_expired"): void {
    const suppressed = this.db.prepare(`SELECT o.* FROM connector_outbox o JOIN schedule_runs r USING(run_id)
      WHERE r.schedule_id = ? AND o.status IN ('pending','claimed')`).all(scheduleId) as Outbox[];
    this.db.prepare(`UPDATE connector_outbox SET status = 'cancelled', terminal_at = ?, content_delete_at = ?, updated_at = ?,
      claim_token = NULL, lease_until = NULL WHERE run_id IN (SELECT run_id FROM schedule_runs WHERE schedule_id = ?)
      AND status IN ('pending','claimed')`).run(now, add(now, 604800), now, scheduleId);
    if (reason === "authorization_expired") {
      const expiring = this.db.prepare(`SELECT o.* FROM connector_outbox o JOIN schedule_runs r USING(run_id)
        WHERE r.schedule_id = ? AND o.status IN ('cancelled','request_started')`).all(scheduleId) as Outbox[];
      for (const row of expiring) {
        const deadline = add(this.revision(this.getRun(row.run_id)!).expires_at, 604800);
        this.db.prepare(`UPDATE connector_outbox SET content_delete_at = MIN(COALESCE(content_delete_at, ?), ?)
          WHERE outbox_id = ?`).run(deadline, deadline, row.outbox_id);
      }
    }
    this.db.prepare(`UPDATE schedule_runs SET status = 'cancelled', reason = ?, terminal_at = ?
      WHERE schedule_id = ? AND status = 'materialized' AND NOT EXISTS
      (SELECT 1 FROM connector_outbox o WHERE o.run_id = schedule_runs.run_id AND o.status IN ('request_started','needs_review','sent'))`).run(reason, now, scheduleId);
    for (const row of suppressed) this.auditOutbox(row, `outbox_${reason}`, now);
  }
  update(scheduleId: string, expectedRevision: number, input: RevisionInput, nextDue: string, actor: Actor, now: string): Schedule {
    utc(now); utc(nextDue);
    return this.db.transaction(() => {
      const before = this.checked(scheduleId, expectedRevision, actor, true);
      const previousRevision = this.revision(before);
      const updateAt = [now, before.created_at, before.updated_at, before.terminal_at ?? before.created_at].sort().at(-1)!;
      if (!["active", "paused", "expired", "needs_review"].includes(before.state) || nextDue <= updateAt) throw new Error("invalid_transition");
      if (before.high_watermark !== null && nextDue <= before.high_watermark) throw new Error("invalid_next_due");
      if (this.db.prepare(`SELECT 1 FROM schedule_runs r WHERE r.schedule_id = ? AND (r.status = 'needs_review' OR
        EXISTS (SELECT 1 FROM connector_outbox o WHERE o.run_id = r.run_id AND o.status = 'needs_review')) LIMIT 1`).get(scheduleId)) throw new Error("reconcile_required");
      this.validateRevision(input, before.owner_id, before.tenant_id, updateAt);
      const sourceEventId = input.authorization_id.replace(/:\d+$/, "");
      const reusedAuthorization = this.db.prepare(`SELECT 1 FROM schedule_revisions
        WHERE schedule_id = ? AND (authorization_id = ? OR authorization_id GLOB ?) LIMIT 1`)
        .get(scheduleId, sourceEventId, `${sourceEventId}:*`);
      if (input.authorization_revision !== expectedRevision + 1 || reusedAuthorization) throw new Error("authorization_revision_conflict");
      this.suppress(scheduleId, updateAt, "revision_replaced");
      this.retireRevisions(scheduleId, updateAt, expectedRevision);
      this.insertRevision(scheduleId, expectedRevision + 1, input, updateAt);
      this.db.prepare("UPDATE schedules SET revision = revision + 1, state = 'active', next_due = ?, updated_at = ? WHERE schedule_id = ?")
        .run(nextDue, updateAt, scheduleId);
      this.db.prepare("UPDATE schedules SET terminal_at = NULL WHERE schedule_id = ?").run(scheduleId);
      const after = this.get(scheduleId)!; this.audit(before, after, "update", actor, updateAt); return after;
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
      const runs = this.db.prepare("SELECT created_at, started_at, terminal_at FROM schedule_runs WHERE schedule_id = ?").all(scheduleId) as
        { created_at: string; started_at: string | null; terminal_at: string | null }[];
      const outboxes = this.db.prepare(`SELECT o.created_at, o.updated_at, o.request_started_at, o.terminal_at, o.lease_until
        FROM connector_outbox o JOIN schedule_runs r USING(run_id) WHERE r.schedule_id = ?`).all(scheduleId) as
        { created_at: string; updated_at: string; request_started_at: string | null; terminal_at: string | null; lease_until: string | null }[];
      const transitionAt = [now, before.created_at, before.updated_at, before.terminal_at ?? before.created_at,
        ...runs.flatMap(row => [row.created_at, row.started_at ?? row.created_at, row.terminal_at ?? row.created_at]),
        ...outboxes.flatMap(row => [row.created_at, row.updated_at, row.request_started_at ?? row.created_at,
          row.terminal_at ?? row.created_at, row.lease_until ?? row.created_at])].sort().at(-1)!;
      if (operation === "resume" && (old.expires_at <= transitionAt || old.content === null || (old.content_delete_at !== null && old.content_delete_at <= transitionAt))) throw new Error("authorization_expired");
      const unusable = old.expires_at <= transitionAt || old.content === null || (old.content_delete_at !== null && old.content_delete_at <= transitionAt);
      if (operation === "cancel" && unusable) {
        this.suppress(scheduleId, transitionAt, "cancelled");
        this.db.prepare("UPDATE schedules SET state = 'cancelled', updated_at = ?, terminal_at = ? WHERE schedule_id = ?")
          .run(transitionAt, transitionAt, scheduleId);
        this.retireRevisions(scheduleId, transitionAt);
        this.audit(before, this.get(scheduleId)!, "cancel", actor, transitionAt);
        this.completeIfDrained(scheduleId, transitionAt);
        return this.get(scheduleId)!;
      }
      if (unusable) {
        this.expireSchedule(before, actor, transitionAt);
        return this.get(scheduleId)!;
      }
      // Every mutation advances the concurrency revision; copying a paused snapshot never extends its authorization.
      const revision = expectedRevision + 1;
      this.db.prepare(`INSERT INTO schedule_revisions SELECT schedule_id, ?, recurrence_json, recurrence_hash, policy_json,
        policy_version, timezone, tzdb_version, authorization_id, authorization_revision, content_scope, approver_id, approved_at, expires_at, action, target_json,
        content, content_hash, content_delete_at, ?, terminal_at FROM schedule_revisions WHERE schedule_id = ? AND revision = ?`).run(revision, transitionAt, scheduleId, expectedRevision);
      this.retireRevisions(scheduleId, transitionAt, expectedRevision);
      const state = operation === "pause" ? "paused" : operation === "resume" ? "active" : "cancelled";
      this.db.prepare("UPDATE schedules SET state = ?, revision = ?, updated_at = ?, terminal_at = ? WHERE schedule_id = ?")
        .run(state, revision, transitionAt, state === "cancelled" ? transitionAt : null, scheduleId);
      this.db.prepare("UPDATE schedule_claims SET claim_owner = NULL, claim_until = NULL WHERE schedule_id = ?").run(scheduleId);
      if (operation !== "resume") this.suppress(scheduleId, transitionAt, "cancelled");
      if (operation === "cancel") this.retireRevisions(scheduleId, transitionAt);
      const after = this.get(scheduleId)!; this.audit(before, after, operation, actor, transitionAt);
      this.completeIfDrained(scheduleId, transitionAt);
      return this.get(scheduleId)!;
    }).immediate();
  }
  materialize(scheduleId: string, expectedRevision: number, scheduledFor: string, nextDue: string | null,
    now: string, actor: Actor, skip: "misfire" | "overlap" | null = null, compactSkip?: CompactSkip,
    claim?: { owner: string; fence: number; occurrenceKey: string }): { run: Run; duplicate: boolean } {
    utc(now); utc(scheduledFor); if (nextDue !== null) utc(nextDue);
    const result = this.db.transaction(() => {
      // An old caller may retry after the scheduler revision advanced. Identity/authorization still
      // apply, but an already persisted occurrence wins over its stale expected revision.
      const current = this.get(scheduleId);
      if (!current) throw new Error("schedule_not_found");
      const before = this.checked(scheduleId, current.revision, actor);
      const materializedAt = [now, before.created_at, before.updated_at, before.terminal_at ?? before.created_at].sort().at(-1)!;
      if (claim) {
        const storedClaim = this.db.prepare("SELECT * FROM schedule_claims WHERE schedule_id = ?").get(scheduleId) as
          { claim_owner: string | null; claim_until: string | null; claim_fence: number } | undefined;
        if (!storedClaim || storedClaim.claim_owner !== claim.owner || storedClaim.claim_fence !== claim.fence ||
            storedClaim.claim_until === null || storedClaim.claim_until <= now) throw new Error("claim_conflict");
      }
      const existing = this.db.prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? AND scheduled_for = ?").get(scheduleId, scheduledFor) as Run | undefined;
      if (existing) {
        if (claim) this.db.prepare("UPDATE schedule_claims SET claim_owner = NULL, claim_until = NULL WHERE schedule_id = ?").run(scheduleId);
        return { run: existing, duplicate: true };
      }
      if (before.revision !== expectedRevision) throw new Error("revision_conflict");
      if (nextDue !== null && (nextDue <= scheduledFor || nextDue <= materializedAt)) throw new Error("invalid_next_due");
      if (before.state !== "active" || scheduledFor > materializedAt || (before.next_due === null || scheduledFor < before.next_due) || (before.high_watermark !== null && scheduledFor <= before.high_watermark)) throw new Error("invalid_occurrence");
      const revision = this.revision(before);
      if (nextDue === null && (JSON.parse(revision.recurrence_json) as { kind: string }).kind !== "once") throw new Error("invalid_next_due");
      if (scheduledFor !== before.next_due) {
        if (!compactSkip || (JSON.parse(revision.recurrence_json) as { kind: string }).kind === "once") throw new Error("compact_skip_required");
        utc(compactSkip.from); utc(compactSkip.through);
        if (compactSkip.from !== before.next_due || compactSkip.through < compactSkip.from || compactSkip.through >= scheduledFor ||
            Date.parse(materializedAt) - Date.parse(compactSkip.through) <= 900000 || !Number.isSafeInteger(compactSkip.count) || compactSkip.count < 1) throw new Error("invalid_compact_skip");
      } else if (compactSkip) throw new Error("invalid_compact_skip");
      if (revision.expires_at <= materializedAt || revision.content === null) {
        this.expireSchedule(before, actor, materializedAt);
        return undefined;
      }
      const unresolved = this.db.prepare(`SELECT 1 FROM schedule_runs r WHERE r.schedule_id = ? AND
        (r.status IN ('materialized','started','needs_review') OR EXISTS
          (SELECT 1 FROM connector_outbox o WHERE o.run_id = r.run_id AND o.status IN ('pending','claimed','request_started','needs_review'))) LIMIT 1`).get(scheduleId);
      const reason = Date.parse(materializedAt) - Date.parse(scheduledFor) > 900000 ? "misfire" : unresolved ? "overlap" : null;
      if (skip !== null && skip !== reason) throw new Error("invalid_skip_reason");
      const runId = `run_${randomUUID()}`;
      const occurrenceKey = claim?.occurrenceKey ?? scheduledFor;
      this.db.prepare(`INSERT INTO schedule_runs(run_id, schedule_id, revision, occurrence_key, scheduled_for, status, reason, created_at, terminal_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(runId, scheduleId, expectedRevision, occurrenceKey, scheduledFor, reason ? "skipped" : "materialized", reason, materializedAt, reason ? materializedAt : null);
      if (!reason && revision.action === "slack.reminder.post") this.insertOutbox(runId, "slack.reminder.post", revision.target_json, revision.content!, materializedAt);
      if (!reason && revision.action === "work.read_only") {
        const result = this.enqueue({ schema_version: 1, source: "dona_schedule", external_event_id: `schedule:v1:${scheduleId}:${scheduledFor}`,
          type: "schedule_due", occurred_at: scheduledFor,
          subject: { tenant_id: before.tenant_id, owner_id: before.owner_id, schedule_id: scheduleId },
          payload: { run_id: runId, revision: expectedRevision, occurrence_key: occurrenceKey,
            work: { objective: revision.content, scope: "read_only", allowed_external_writes: [], result_destination: JSON.parse(revision.target_json) } }, reply_target: null,
          trace: { schedule_id: scheduleId, run_id: runId } }, new Date(materializedAt));
        if (result.duplicate || result.payloadMismatch) throw new Error("event_idempotency_conflict");
        this.db.prepare("UPDATE schedule_runs SET event_id = ? WHERE run_id = ?").run(result.row.event_id, runId);
        const target=JSON.parse(revision.target_json) as Target;
        insertEventJobBinding(this.db,result.row.event_id,{
          owner:{kind:"schedule",tenant_id:before.tenant_id,owner_id:before.owner_id,schedule_id:scheduleId,run_id:runId,revision:expectedRevision},
          destination:target.kind==="none"?{kind:"none"}:{kind:"slack",action:"slack.work_result.post",target},
        });
      }
      this.db.prepare("UPDATE schedules SET high_watermark = ?, next_due = ?, updated_at = ? WHERE schedule_id = ?")
        .run(scheduledFor, nextDue, materializedAt, scheduleId);
      if (claim) this.db.prepare("UPDATE schedule_claims SET claim_owner = NULL, claim_until = NULL WHERE schedule_id = ?").run(scheduleId);
      this.audit(before, this.get(scheduleId)!, "materialize", actor, materializedAt, undefined, this.getRun(runId)!, compactSkip);
      this.completeIfDrained(scheduleId, materializedAt);
      return { run: this.getRun(runId)!, duplicate: false };
    }).immediate();
    if (!result) throw new Error("authorization_expired");
    return result;
  }
  setRunState(runId: string, expected: Run["status"], next: "started" | "completed" | "failed" | "cancelled",
    actor: Actor, now: string, jobId: string | null = null, resultContent: string | null = null): Run {
    utc(now); if (jobId !== null) id(jobId);
    const result = this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run || run.status !== expected) throw new Error("run_conflict");
      const current = this.get(run.schedule_id)!;
      this.checked(current.schedule_id, current.revision, actor);
      const valid = expected === "materialized" ? ["started", "cancelled", "failed"] : expected === "started" ? ["completed", "failed", "cancelled"] : [];
      if (!valid.includes(next)) throw new Error("invalid_transition");
      const runSnapshot = this.revision(run);
      const transitionAt = [now, run.created_at, run.started_at ?? run.created_at, run.terminal_at ?? run.created_at,
        current.created_at, current.updated_at, current.terminal_at ?? current.created_at].sort().at(-1)!;
      if (["started", "completed"].includes(next) && runSnapshot.action !== "work.read_only") throw new Error("invalid_transition");
      if (next === "started") {
        const reason = current.state !== "active" || current.revision !== run.revision ? "cancelled"
          : runSnapshot.expires_at <= transitionAt ? "authorization_expired"
          : Date.parse(transitionAt) - Date.parse(run.scheduled_for) > 900000 ? "misfire" : null;
        if (reason !== null) {
          if (reason === "authorization_expired") this.expireSchedule(current, actor, now);
          const status = reason === "misfire" ? "skipped" : "cancelled";
          this.db.prepare("UPDATE schedule_runs SET status = ?, reason = ?, terminal_at = ? WHERE run_id = ?").run(status, reason, transitionAt, runId);
          this.db.prepare(`UPDATE connector_outbox SET status = 'cancelled', terminal_at = ?, updated_at = ?,
            content_delete_at = ?, claim_token = NULL, lease_until = NULL
            WHERE run_id = ? AND status IN ('pending','claimed')`).run(transitionAt, transitionAt, add(transitionAt, 604800), runId);
          this.audit(current, this.get(current.schedule_id)!, `run_${status}`, actor, transitionAt, undefined, this.getRun(runId)!);
          this.completeIfDrained(run.schedule_id, transitionAt);
          return undefined;
        }
      }
      if (jobId !== null) {
        const job = this.db.prepare("SELECT source_event_id FROM jobs WHERE job_id = ?").get(jobId) as { source_event_id: string } | undefined;
        if (!job || job.source_event_id !== run.event_id || (run.job_id !== null && run.job_id !== jobId)) throw new Error("job_reference_conflict");
      }
      if (next === "started" && jobId === null) throw new Error("job_reference_required");
      const notificationReason = runSnapshot.expires_at <= transitionAt ? "authorization_expired"
        : current.state !== "active" ? "cancelled"
        : current.revision !== run.revision ? "revision_replaced"
        : null;
      const workCompletion = next === "completed" && runSnapshot.action === "work.read_only";
      const hasTarget = (JSON.parse(runSnapshot.target_json) as Target).kind !== "none";
      if (resultContent !== null && !workCompletion) throw new Error("result_not_authorized");
      if (workCompletion && hasTarget && notificationReason === null) {
        if (resultContent === null) throw new Error("result_content_required");
        this.insertOutbox(runId, "slack.work_result.post", runSnapshot.target_json, truncateResultContent(resultContent), transitionAt);
      }
      const suppressed = next === "cancelled" || next === "failed"
        ? this.db.prepare("SELECT * FROM connector_outbox WHERE run_id = ? AND status IN ('pending','claimed')").all(runId) as Outbox[] : [];
      const operationAt = [transitionAt, ...suppressed.flatMap(row =>
        [row.created_at, row.updated_at, row.lease_until ?? row.created_at])].sort().at(-1)!;
      if (suppressed.length > 0) {
        this.db.prepare(`UPDATE connector_outbox SET status = 'cancelled', terminal_at = ?, updated_at = ?,
          content_delete_at = ?, claim_token = NULL, lease_until = NULL
          WHERE run_id = ? AND status IN ('pending','claimed')`).run(operationAt, operationAt, add(operationAt, 604800), runId);
      }
      this.db.prepare(`UPDATE schedule_runs SET status = ?, reason = CASE WHEN ? = 'cancelled' THEN 'cancelled' ELSE reason END,
        job_id = COALESCE(?, job_id), started_at = CASE WHEN ? = 'started' THEN ? ELSE started_at END,
        terminal_at = ? WHERE run_id = ?`)
        .run(next, next, jobId, next, operationAt, next === "started" ? null : operationAt, runId);
      for (const row of suppressed) this.auditOutbox(row, `outbox_run_${next}`, operationAt);
      this.audit(current, current, `run_${next}`, actor, operationAt, undefined, this.getRun(runId)!);
      if (workCompletion && hasTarget && notificationReason !== null) {
        this.audit(current, current, `work_result_suppressed_${notificationReason}`, actor, operationAt, undefined, this.getRun(runId)!);
      }
      if (["active", "paused"].includes(current.state) && this.revision(current).expires_at <= operationAt) this.expireSchedule(current, actor, operationAt);
      this.completeIfDrained(run.schedule_id, operationAt);
      return this.getRun(runId)!;
    }).immediate();
    if (!result) throw new Error("run_not_authorized");
    return result;
  }
  markWorkRunNeedsReview(runId: string, jobId: string, now: string, sourceEventId: string): Run {
    utc(now); id(jobId); id(sourceEventId);
    return this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run || run.status !== "started" || run.job_id !== jobId || run.event_id !== sourceEventId) throw new Error("job_reference_conflict");
      const before = this.get(run.schedule_id)!;
      const at = [now, run.created_at, run.started_at ?? run.created_at, before.created_at, before.updated_at].sort().at(-1)!;
      this.db.prepare("UPDATE schedule_runs SET status='needs_review', reason='ambiguous_write' WHERE run_id=?").run(runId);
      this.suppress(run.schedule_id, at, "cancelled");
      this.db.prepare("UPDATE schedules SET state='needs_review', updated_at=? WHERE schedule_id=? AND state NOT IN ('cancelled','completed')").run(at, run.schedule_id);
      const snapshot = this.revision(run); const target = JSON.parse(snapshot.target_json) as Target;
      if (target.kind !== "none" && !this.db.prepare("SELECT 1 FROM connector_outbox WHERE run_id=? AND kind='slack.work_result.post'").get(runId)) {
        this.insertOutbox(runId, "slack.work_result.post", snapshot.target_json, "scheduled workの結果は確認が必要です", at);
      }
      this.retireRevisions(run.schedule_id, at);
      this.audit(before, this.get(run.schedule_id)!, "work_result_needs_review",
        {tenant_id:before.tenant_id,actor_id:"scheduler",role:"admin",source_event_id:sourceEventId}, at, undefined, this.getRun(runId)!);
      return this.getRun(runId)!;
    }).immediate();
  }

  settleUndelegatedWorkEvent(eventId: string, outcome: "failed" | "needs_review", now: string): void {
    utc(now); id(eventId);
    this.db.transaction(() => {
      const run = this.db.prepare("SELECT * FROM schedule_runs WHERE event_id=?").get(eventId) as Run | undefined;
      if (!run || run.status !== "materialized" || run.job_id !== null) return;
      const before = this.get(run.schedule_id)!;
      const settledAt=[now,run.created_at,before.created_at,before.updated_at].sort().at(-1)!;
      this.db.prepare("UPDATE schedule_runs SET status=?,reason=?,terminal_at=? WHERE run_id=?")
        .run(outcome, outcome === "needs_review" ? "ambiguous_write" : null, outcome === "failed" ? settledAt : null, run.run_id);
      if (outcome === "needs_review") {
        this.db.prepare("UPDATE schedules SET state='needs_review',updated_at=? WHERE schedule_id=?").run(settledAt, run.schedule_id);
        this.retireRevisions(run.schedule_id, settledAt);
      }
      this.audit(before, this.get(run.schedule_id)!, `event_${outcome}`,
        {tenant_id:before.tenant_id,actor_id:"scheduler",role:"admin",source_event_id:eventId},settledAt,undefined,this.getRun(run.run_id)!);
      this.completeIfDrained(run.schedule_id, settledAt);
    }).immediate();
  }

  reconcileWorkRun(runId: string, outcome: "failed" | "cancelled", actor: Actor, now: string): Run {
    utc(now); if (actor.role !== "admin") throw new Error("admin_required");
    return this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run || run.status !== "needs_review") throw new Error("invalid_transition");
      const before = this.get(run.schedule_id)!;
      this.checked(before.schedule_id, before.revision, actor);
      const at = [now, run.created_at, run.started_at ?? run.created_at, before.created_at, before.updated_at].sort().at(-1)!;
      this.db.prepare("UPDATE schedule_runs SET status=?, reason=?, terminal_at=? WHERE run_id=?")
        .run(outcome, outcome === "cancelled" ? "cancelled" : null, at, runId);
      this.audit(before, this.get(run.schedule_id)!, `reconcile_work_${outcome}`, actor, at, undefined, this.getRun(runId)!);
      this.completeIfDrained(run.schedule_id, at);
      return this.getRun(runId)!;
    }).immediate();
  }
  reconcile(outboxId: string, outcome: "sent" | "failed", receiptId: string, actor: Actor, now: string): ReconciledOutbox {
    utc(now); validateReceipt(receiptId);
    if (actor.role !== "admin") throw new Error("admin_required");
    if (outcome !== "sent" && outcome !== "failed") throw new Error("invalid_outcome");
    return this.db.transaction(() => {
      const row = this.getOutbox(outboxId, now);
      if (!row || row.status !== "needs_review") throw new Error("invalid_transition");
      const run = this.getRun(row.run_id)!; const schedule = this.get(run.schedule_id)!;
      const reconciledAt = [now, row.created_at, row.updated_at, row.request_started_at ?? row.created_at,
        row.terminal_at ?? row.created_at, run.created_at, run.started_at ?? run.created_at,
        schedule.created_at, schedule.updated_at, schedule.terminal_at ?? schedule.created_at].sort().at(-1)!;
      this.checked(schedule.schedule_id, schedule.revision, actor);
      this.db.prepare(`UPDATE connector_outbox SET status = ?, receipt_id = ?, terminal_at = ?, updated_at = ?,
        content_delete_at = MIN(COALESCE(content_delete_at, ?), ?), claim_token = NULL, lease_until = NULL WHERE outbox_id = ?`)
        .run(outcome, receiptId, reconciledAt, reconciledAt, add(reconciledAt, 604800), add(reconciledAt, 604800), outboxId);
      this.db.prepare("UPDATE schedule_runs SET status = ?, terminal_at = ? WHERE run_id = ? AND status = 'needs_review'")
        .run(outcome === "sent" ? "completed" : "failed", reconciledAt, run.run_id);
      this.audit(schedule, schedule, `reconcile_${outcome}`, actor, reconciledAt, this.getOutbox(outboxId, reconciledAt)!);
      this.completeIfDrained(run.schedule_id, reconciledAt);
      // Admin reconciliation returns allowlisted metadata, never owner content or a private target.
      const result = this.getOutbox(outboxId, reconciledAt)!;
      return { outbox_id: result.outbox_id, run_id: result.run_id, kind: result.kind, idempotency_key: result.idempotency_key,
        content_hash: result.content_hash, status: result.status, attempt: result.attempt, available_at: result.available_at,
        lease_until: result.lease_until, request_started_at: result.request_started_at, receipt_id: result.receipt_id,
        created_at: result.created_at, updated_at: result.updated_at, terminal_at: result.terminal_at,
        content_delete_at: result.content_delete_at };
    }).immediate();
  }
  private retireRevisions(scheduleId: string, now: string, revision?: number): void {
    const rows = this.db.prepare("SELECT revision, expires_at, created_at, terminal_at, content_delete_at FROM schedule_revisions WHERE schedule_id = ?" +
      (revision === undefined ? "" : " AND revision = ?")).all(...(revision === undefined ? [scheduleId] : [scheduleId, revision])) as
      { revision: number; expires_at: string; created_at: string; terminal_at: string | null; content_delete_at: string | null }[];
    for (const row of rows) {
      const candidate = [row.expires_at, now].sort()[0]!;
      const endedAt = row.terminal_at ?? (candidate < row.created_at ? row.created_at : candidate);
      const deadline = add(endedAt, 604800);
      this.db.prepare("UPDATE schedule_revisions SET terminal_at = ?, content_delete_at = ? WHERE schedule_id = ? AND revision = ?")
        .run(endedAt, row.content_delete_at !== null && row.content_delete_at < deadline ? row.content_delete_at : deadline, scheduleId, row.revision);
    }
  }
  private expireSchedule(before: Schedule, actor: Actor, now: string): void {
    const expiredAt = [now, before.created_at, before.updated_at, before.terminal_at ?? before.created_at].sort().at(-1)!;
    this.suppress(before.schedule_id, expiredAt, "authorization_expired");
    this.db.prepare("UPDATE schedules SET state = 'expired', updated_at = ?, terminal_at = COALESCE(terminal_at, ?) WHERE schedule_id = ?")
      .run(expiredAt, expiredAt, before.schedule_id);
    this.retireRevisions(before.schedule_id, expiredAt, before.revision);
    this.audit(before, this.get(before.schedule_id)!, "expire", actor, expiredAt);
    this.completeIfDrained(before.schedule_id, expiredAt);
  }
  private runCanSend(row: Outbox, run: Run): boolean {
    return row.kind === "slack.reminder.post" ? ["materialized", "started"].includes(run.status) : ["completed", "needs_review"].includes(run.status);
  }
  private completeIfDrained(scheduleId: string, now: string): void {
    const before = this.get(scheduleId)!;
    if (!["active", "paused", "expired", "needs_review"].includes(before.state) || before.next_due !== null || before.high_watermark === null ||
        (JSON.parse(this.revision(before).recurrence_json) as { kind: string }).kind !== "once") return;
    const unsettled = this.db.prepare(`SELECT 1 FROM schedule_runs r WHERE r.schedule_id = ? AND
      (r.status IN ('materialized','started','needs_review') OR EXISTS (SELECT 1 FROM connector_outbox o
        WHERE o.run_id = r.run_id AND o.status IN ('pending','claimed','request_started','needs_review'))) LIMIT 1`).get(scheduleId);
    if (unsettled) return;
    const runTerminal = (this.db.prepare("SELECT MAX(terminal_at) AS value FROM schedule_runs WHERE schedule_id = ?").get(scheduleId) as { value: string | null }).value;
    const completedAt = [now, before.created_at, before.updated_at, before.terminal_at ?? before.created_at,
      runTerminal ?? before.created_at].sort().at(-1)!;
    this.db.prepare("UPDATE schedules SET state = 'completed', terminal_at = ?, updated_at = ? WHERE schedule_id = ?").run(completedAt, completedAt, scheduleId);
    this.retireRevisions(scheduleId, completedAt);
    this.audit(before, this.get(scheduleId)!, "complete", { tenant_id: before.tenant_id, actor_id: "scheduler", role: "admin", source_event_id: null }, completedAt);
  }
  private expireUnsent(row: Outbox, now: string): boolean {
    if (row.status !== "pending" && row.status !== "claimed") return false;
    const run = this.getRun(row.run_id)!; const schedule = this.get(run.schedule_id)!;
    const terminalAt = [now, row.created_at, row.updated_at, row.request_started_at ?? row.created_at,
      run.created_at, run.started_at ?? run.created_at, schedule.created_at, schedule.updated_at].sort().at(-1)!;
    const snapshot = this.revision(run);
    const ageOrigin = run.scheduled_for;
    const workRetryExpired = row.kind === "slack.work_result.post" && Date.parse(terminalAt) - Date.parse(row.created_at) > 900000;
    const reviewNotification = row.kind === "slack.work_result.post" && run.status === "needs_review" && schedule.state === "needs_review";
    const reason = (!reviewNotification && schedule.state !== "active") || schedule.revision !== run.revision || !this.runCanSend(row, run) ? "cancelled"
      : snapshot.expires_at <= terminalAt ? "authorization_expired"
      : workRetryExpired ? "retry_expired"
      : row.kind === "slack.reminder.post" && Date.parse(terminalAt) - Date.parse(ageOrigin) > 900000 ? "misfire"
      : row.content === null || (row.content_delete_at !== null && row.content_delete_at <= terminalAt) ? "cancelled"
      : null;
    if (reason === null) return false;
    if (reason === "authorization_expired") {
      this.expireSchedule(schedule,
        { tenant_id: schedule.tenant_id, actor_id: "scheduler", role: "admin", source_event_id: null }, terminalAt);
      return true;
    }
    this.db.prepare(`UPDATE connector_outbox SET status = ?, terminal_at = ?, updated_at = ?,
      content_delete_at = ?, claim_token = NULL, lease_until = NULL WHERE outbox_id = ?`)
      .run(reason === "retry_expired" ? "failed" : "cancelled", terminalAt, terminalAt, add(terminalAt, 604800), row.outbox_id);
    if (row.kind === "slack.reminder.post" && ["materialized", "started"].includes(run.status)) this.db.prepare(`UPDATE schedule_runs SET status = ?, reason = ?, terminal_at = ?
      WHERE run_id = ?`).run(reason === "misfire" ? "skipped" : "cancelled", reason, terminalAt, row.run_id);
    this.auditOutbox(row, `outbox_${reason}`, terminalAt);
    this.completeIfDrained(run.schedule_id, terminalAt);
    return true;
  }
  private insertOutbox(runId: string, kind: Outbox["kind"], targetJson: string, content: string, now: string): void {
    this.db.prepare(`INSERT INTO connector_outbox(outbox_id, run_id, kind, idempotency_key, target_json, content, content_hash,
      status, available_at, created_at, updated_at, content_delete_at) VALUES (?,?,?,?,?,?,?,'pending',?,?,?,NULL)`).run(
      `outbox_${randomUUID()}`, runId, kind, `${runId}:${kind}`, targetJson, content, digest(content), now, now, now);
  }
  claim(now: string, leaseSeconds = 60): Outbox | undefined {
    utc(now); if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) throw new Error("invalid_lease");
    return this.db.transaction(() => {
      this.recover(now);
      const row = this.db.prepare(`SELECT o.* FROM connector_outbox o JOIN schedule_runs r USING(run_id)
        JOIN schedules s ON s.schedule_id = r.schedule_id JOIN schedule_revisions v ON v.schedule_id = r.schedule_id AND v.revision = r.revision
        WHERE o.status = 'pending' AND o.available_at <= ? AND o.content IS NOT NULL
        AND (s.state = 'active' OR (o.kind = 'slack.work_result.post' AND s.state = 'needs_review' AND r.status = 'needs_review'))
        AND ((o.kind = 'slack.reminder.post' AND r.status IN ('materialized','started'))
          OR (o.kind = 'slack.work_result.post' AND r.status IN ('completed','needs_review')))
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
      const startedAt = [now, row.created_at, row.updated_at, row.request_started_at ?? row.created_at].sort().at(-1)!;
      this.db.prepare("UPDATE connector_outbox SET status = 'request_started', request_started_at = ?, attempt = attempt + 1, updated_at = ? WHERE outbox_id = ?")
        .run(startedAt, startedAt, outboxId);
      this.auditOutbox(row, "outbox_request_started", startedAt);
      return this.getOutbox(outboxId, startedAt)!;
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
    const run = this.getRun(row.run_id)!;
    const before = this.get(run.schedule_id)!;
    const ambiguousAt = [now, row.created_at, row.updated_at, row.request_started_at ?? row.created_at,
      run.created_at, run.started_at ?? run.created_at, before.created_at, before.updated_at,
      before.terminal_at ?? before.created_at].sort().at(-1)!;
    this.db.prepare("UPDATE connector_outbox SET status = 'needs_review', content_delete_at = ?, updated_at = ? WHERE outbox_id = ?")
      .run(add(ambiguousAt, 604800), ambiguousAt, row.outbox_id);
    this.suppress(run.schedule_id, ambiguousAt, "cancelled");
    if (row.kind === "slack.reminder.post") {
      this.db.prepare("UPDATE schedule_runs SET status = 'needs_review', reason = 'ambiguous_write' WHERE run_id = ?").run(run.run_id);
    }
    this.db.prepare("UPDATE schedules SET state = 'needs_review', updated_at = ? WHERE schedule_id = ? AND state NOT IN ('cancelled','completed')").run(ambiguousAt, run.schedule_id);
    this.retireRevisions(run.schedule_id, ambiguousAt);
    this.auditOutbox(row, "outbox_needs_review", ambiguousAt, before);
  }
  finishWrite(outboxId: string, token: string, outcome: "sent" | "not_accepted" | "ambiguous", now: string, receiptId: string | null = null, retryAfterSeconds = 0): Outbox {
    utc(now); if (receiptId !== null) validateReceipt(receiptId);
    if (!["sent", "not_accepted", "ambiguous"].includes(outcome)) throw new Error("invalid_outcome");
    if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 0 || retryAfterSeconds > 2592000) throw new Error("invalid_retry_after");
    return this.db.transaction(() => {
      const row = this.getOutbox(outboxId, now);
      if (!row || row.status !== "request_started" || row.claim_token !== token) throw new Error("claim_conflict");
      const run = this.getRun(row.run_id)!;
      const schedule = this.get(run.schedule_id)!;
      const finishedAt = [now, row.created_at, row.updated_at, row.request_started_at ?? row.created_at,
        row.terminal_at ?? row.created_at, schedule.created_at, schedule.updated_at,
        schedule.terminal_at ?? schedule.created_at].sort().at(-1)!;
      if (outcome === "ambiguous") this.markAmbiguous(row, finishedAt);
      else {
        if (outcome === "sent" && receiptId === null) throw new Error("receipt_required");
        const reviewNotification = row.kind === "slack.work_result.post" && run.status === "needs_review" && schedule.state === "needs_review";
        const authorized = this.runCanSend(row, run) && (schedule.state === "active" || reviewNotification) &&
          schedule.revision === run.revision && this.revision(schedule).expires_at > now;
        const retryDelay = Math.max(retryAfterSeconds, row.attempt === 1 ? 1 : 5);
        const withinWorkRetryDeadline = row.kind !== "slack.work_result.post" || Date.parse(add(now, retryDelay)) <= Date.parse(add(row.created_at, 900));
        const retry = outcome === "not_accepted" && row.attempt < 3 && authorized && withinWorkRetryDeadline;
        const status = outcome === "sent" ? "sent" : retry ? "pending" : authorized ? "failed" : "cancelled";
        this.db.prepare(`UPDATE connector_outbox SET status = ?, available_at = ?, request_started_at = ?, receipt_id = ?,
          claim_token = NULL, lease_until = NULL, terminal_at = ?, content_delete_at = ?, updated_at = ? WHERE outbox_id = ?`).run(
          status, add(finishedAt, retryDelay), retry ? null : row.request_started_at,
          receiptId, retry ? null : finishedAt, retry ? null : add(finishedAt, 604800), finishedAt, outboxId);
      }
      if (outcome !== "ambiguous") {
        this.expireUnsent(this.getOutbox(outboxId, finishedAt)!, finishedAt);
        const finished = this.getOutbox(outboxId, finishedAt)!;
        if (row.kind === "slack.reminder.post" && finished.terminal_at !== null) {
          this.db.prepare("UPDATE schedule_runs SET status = ?, reason = ?, terminal_at = ? WHERE run_id = ? AND status IN ('materialized','started')")
            .run(finished.status === "sent" ? "completed" : finished.status === "cancelled" ? "cancelled" : "failed",
              finished.status === "cancelled" ? "cancelled" : null, finishedAt, row.run_id);
        }
        this.auditOutbox(row, `outbox_${outcome}`, finishedAt);
      }
      this.completeIfDrained(this.getRun(row.run_id)!.schedule_id, finishedAt);
      const current = this.get(this.getRun(row.run_id)!.schedule_id)!;
      if (["active", "paused"].includes(current.state) && this.revision(current).expires_at <= finishedAt) {
        this.expireSchedule(current, { tenant_id: current.tenant_id, actor_id: "scheduler", role: "admin", source_event_id: null }, finishedAt);
      }
      this.completeIfDrained(current.schedule_id, finishedAt);
      return this.getOutbox(outboxId, finishedAt)!;
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
        available_at, lease_until, request_started_at, receipt_id, created_at, updated_at, terminal_at, content_delete_at
        FROM connector_outbox`).all(),
      audit: this.db.prepare("SELECT * FROM schedule_audit ORDER BY sequence").all(),
    }))();
  }
  auditHistory(scheduleId: string): unknown[] {
    return this.db.prepare("SELECT * FROM schedule_audit WHERE schedule_id = ? ORDER BY sequence").all(scheduleId);
  }
  purge(now: string): void {
    utc(now);
    const resultFiles=this.db.prepare(`SELECT j.job_id,j.result_path FROM jobs j JOIN job_completion_results c USING(job_id)
      WHERE c.content_delete_at<=? AND json_extract(c.owner_json,'$.kind')='schedule' AND c.result_file_deleted_at IS NULL`).all(now) as Array<{job_id:string;result_path:string}>;
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
      this.db.prepare(`UPDATE jobs SET result_json = NULL,
        last_error_message = CASE WHEN last_error_code='agent_reported_failure' THEN NULL ELSE last_error_message END
        WHERE job_id IN (SELECT job_id FROM job_completion_results WHERE content_delete_at <= ?
          AND json_extract(owner_json,'$.kind')='schedule')`).run(now);
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
    if(this.deleteJobResult) for(const row of resultFiles) if(this.deleteJobResult(row.job_id,row.result_path)) {
      this.db.prepare("UPDATE job_completion_results SET result_file_deleted_at=? WHERE job_id=? AND result_file_deleted_at IS NULL").run(now,row.job_id);
    }
  }
}
