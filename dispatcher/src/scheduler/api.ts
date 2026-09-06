import { createHash } from "node:crypto";
import { z } from "zod";
import type { DispatcherDatabase } from "../database.js";
import type { EventRow } from "../types.js";
import { nextOccurrence, previewOccurrences } from "./calculator.js";
import { parseDefinition, validateCreation } from "./domain.js";
import { FakeClock } from "./clock.js";
import { encodePolicy, defaultPolicy } from "./policy.js";
import { encodeRecurrence, parseRecurrence } from "./recurrence.js";
import type { Actor, RevisionInput, Schedule, ScheduleView, Target } from "./repository.js";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_:-]+$/);
const eventId = z.string().regex(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/i);
const content = (max: number) => z.string().min(1).refine(value => [...value].length <= max);
const action = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("reminder"), body: content(2000) }),
  z.strictObject({ kind: z.literal("work"), objective: content(4000), notify: z.enum(["origin_thread", "none"]) }),
]);
const definition = z.strictObject({ recurrence: z.unknown(), action });
const previewInput = z.strictObject({ source_event_id: eventId, definition, after: z.string(), before_or_equal: z.string(), limit: z.number().int().min(1).max(100) });
const createInput = z.strictObject({ source_event_id: eventId, idempotency_key: id, definition });
const updateInput = z.strictObject({ source_event_id: eventId, expected_revision: z.number().int().positive(), definition });
const transitionInput = z.strictObject({ source_event_id: eventId, expected_revision: z.number().int().positive() });

export class ScheduleApiError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) { super(message); }
}
const second = (value: string): string => new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const codecs = { recurrence: (text: string) => encodeRecurrence(JSON.parse(text)), policy: (text: string) => encodePolicy(JSON.parse(text)) };

export class ScheduleApiService {
  constructor(private readonly database: DispatcherDatabase, private readonly now: () => Date = () => new Date()) {}

  private context(sourceEventId: string): { event: EventRow; actor: Actor; target: Target } {
    const event = this.database.get(sourceEventId);
    if (!event || event.source !== "slack") throw new ScheduleApiError(403, "unauthorized");
    const subject = JSON.parse(event.subject_json) as Record<string, unknown>;
    const reply = event.reply_target_json ? JSON.parse(event.reply_target_json) as Record<string, unknown> : null;
    const tenant = subject.workspace_id; const owner = subject.actor_id;
    if (typeof tenant !== "string" || typeof owner !== "string" || !reply || reply.workspace_id !== tenant ||
      typeof reply.channel_id !== "string" || typeof reply.thread_ts !== "string") throw new ScheduleApiError(403, "unauthorized");
    return { event, actor: { tenant_id: tenant, actor_id: owner, role: "owner", source_event_id: sourceEventId },
      target: { kind: "thread", workspace_id: tenant, channel_id: reply.channel_id, thread_ts: reply.thread_ts } };
  }

  private built(raw: z.infer<typeof definition>, context: ReturnType<ScheduleApiService["context"]>, scheduleId: string, revision: number) {
    const recurrence = parseRecurrence(raw.recurrence); const policy = defaultPolicy();
    const target = raw.action.kind === "work" && raw.action.notify === "none" ? { kind: "none" as const } : context.target;
    const parsed = parseDefinition({ schedule_id: scheduleId, revision, tenant_id: context.actor.tenant_id, owner_id: context.actor.actor_id,
      recurrence, policy, action: raw.action.kind === "reminder"
        ? { kind: "reminder", action: "slack.reminder.post", target, body: raw.action.body }
        : { kind: "work", action: "work.read_only", objective: raw.action.objective,
          notification: target.kind === "none" ? { kind: "none" } : { kind: "slack", action: "slack.work_result.post", target } } });
    const approved = second(context.event.occurred_at);
    const expires = second(new Date(Date.parse(approved) + 30 * 86400000).toISOString());
    const input: RevisionInput = { recurrence_json: encodeRecurrence(recurrence), policy_json: encodePolicy(policy), policy_version: 1,
      timezone: recurrence.kind === "once" ? null : recurrence.timezone, tzdb_version: recurrence.kind === "once" ? null : recurrence.tzdb_version,
      authorization_id: `${context.event.event_id}:${revision}`, authorization_revision: revision, approver_id: context.actor.actor_id,
      approved_at: approved, expires_at: expires, action: parsed.action.action, target,
      content: raw.action.kind === "reminder" ? raw.action.body : raw.action.objective };
    return { parsed, input, expires };
  }

  private assertBinding(row: ScheduleView, context: ReturnType<ScheduleApiService["context"]>): void {
    const bindingEventId = row.authorization_id.replace(/:\d+$/, "");
    const binding = this.context(bindingEventId);
    if (JSON.stringify(binding.target) !== JSON.stringify(context.target)) throw new ScheduleApiError(403, "unauthorized");
  }

  preview(input: unknown) {
    const value = previewInput.parse(input); const context = this.context(value.source_event_id);
    const built = this.built(value.definition, context, "preview", 1);
    return { schema_version: 1, preview: previewOccurrences(built.parsed, value), policy: built.parsed.policy,
      target: built.input.target, authorization_expires_at: built.expires };
  }

  create(input: unknown) {
    const value = createInput.parse(input); const context = this.context(value.source_event_id);
    const scheduleId = `sch_${hash(`${context.actor.tenant_id}\0${context.actor.actor_id}\0${JSON.stringify(context.target)}\0${value.idempotency_key}`).slice(0, 32)}`;
    const built = this.built(value.definition, context, scheduleId, 1); const at = second(this.now().toISOString());
    const existing = this.database.scheduler.getAuthorized(scheduleId, context.actor);
    if (existing) {
      this.assertBinding(existing, context);
      if (existing.recurrence_json !== built.input.recurrence_json || existing.policy_json !== built.input.policy_json ||
        existing.action !== built.input.action || JSON.stringify(existing.target) !== JSON.stringify(built.input.target) ||
        existing.content_hash !== hash(built.input.content)) throw new ScheduleApiError(409, "idempotency_conflict");
      return { schema_version: 1, duplicate: true, schedule: this.project(existing) };
    }
    validateCreation(built.parsed, new FakeClock(at));
    const occurrence = nextOccurrence(built.parsed, at); if (!occurrence) throw new ScheduleApiError(400, "no_occurrence_in_horizon");
    try { const row = this.database.scheduler.withCodecs(codecs).create(scheduleId, built.input, occurrence.occurrence_at, context.actor, at); return { schema_version: 1, duplicate: false, schedule: this.project(this.database.scheduler.getAuthorized(row.schedule_id, context.actor)!) }; }
    catch (error) { throw this.map(error); }
  }

  get(scheduleId: string, sourceEventId: string) { const c = this.context(sourceEventId); const row = this.database.scheduler.getAuthorized(scheduleId, c.actor); if (!row) throw new ScheduleApiError(404, "schedule_not_found"); this.assertBinding(row, c); return { schema_version: 1, schedule: this.project(row) }; }
  list(sourceEventId: string, limit: number, cursor?: string) { const c = this.context(sourceEventId); let decoded: { created_at: string; schedule_id: string } | undefined; if (cursor) { const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)\|(sch_[a-f0-9]{32})$/.exec(cursor); if (!match) throw new ScheduleApiError(400, "invalid_cursor"); decoded = { created_at: match[1]!, schedule_id: match[2]! }; } const candidates = this.database.scheduler.listAuthorized(c.actor, limit, decoded); const rows = candidates.filter(row => { try { this.assertBinding(row, c); return true; } catch { return false; } }); const last = candidates.at(-1); return { schema_version: 1, schedules: rows.map(row => this.project(row)), next_cursor: candidates.length === limit && last ? `${last.created_at}|${last.schedule_id}` : null }; }
  update(scheduleId: string, input: unknown) { const value = updateInput.parse(input); const c = this.context(value.source_event_id); const current = this.database.scheduler.getAuthorized(scheduleId, c.actor); if (!current) throw new ScheduleApiError(404, "schedule_not_found"); this.assertBinding(current, c); const built = this.built(value.definition, c, scheduleId, value.expected_revision + 1); const at = second(this.now().toISOString()); const occurrence = nextOccurrence(built.parsed, at); if (!occurrence) throw new ScheduleApiError(400, "no_occurrence_in_horizon"); try { const row = this.database.scheduler.withCodecs(codecs).update(scheduleId, value.expected_revision, built.input, occurrence.occurrence_at, c.actor, at); return { schema_version: 1, schedule: this.project(this.database.scheduler.getAuthorized(row.schedule_id, c.actor)!) }; } catch (error) { throw this.map(error); } }
  transition(scheduleId: string, operation: "pause"|"resume"|"cancel", input: unknown) { const value = transitionInput.parse(input); const c = this.context(value.source_event_id); const current = this.database.scheduler.getAuthorized(scheduleId, c.actor); if (!current) throw new ScheduleApiError(404, "schedule_not_found"); this.assertBinding(current, c); const desired = operation === "pause" ? "paused" : operation === "resume" ? "active" : "cancelled"; const exactRetry = current.revision === value.expected_revision + 1 && this.database.scheduler.lastAuditOperation(scheduleId) === operation; if (current.state === desired && (current.revision === value.expected_revision || exactRetry)) return { schema_version: 1, duplicate: true, materialized_runs_affected: 0, schedule: this.project(current) }; const before = this.database.scheduler.pendingMaterializedCount(scheduleId); try { const row = this.database.scheduler.transition(scheduleId, value.expected_revision, operation, c.actor, second(this.now().toISOString())); const after = this.database.scheduler.pendingMaterializedCount(scheduleId); return { schema_version: 1, duplicate: false, materialized_runs_affected: before - after, schedule: this.project(this.database.scheduler.getAuthorized(row.schedule_id, c.actor)!) }; } catch (error) { throw this.map(error); } }
  history(scheduleId: string, sourceEventId: string, limit: number, cursor?: string) { const c = this.context(sourceEventId); const current = this.database.scheduler.getAuthorized(scheduleId, c.actor); if (!current) throw new ScheduleApiError(404, "schedule_not_found"); this.assertBinding(current, c); let decoded: { scheduled_for: string; run_id: string } | undefined; if (cursor) { const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)\|(run_[0-9a-f-]{36})$/.exec(cursor); if (!match) throw new ScheduleApiError(400, "invalid_cursor"); decoded = { scheduled_for: match[1]!, run_id: match[2]! }; } const rows = this.database.scheduler.runHistory(scheduleId, c.actor, limit, decoded); const last = rows.at(-1); return { schema_version: 1, runs: rows.map(row => ({ ...row, status: row.status === "materialized" ? "scheduled" : row.status === "skipped" && row.reason === "misfire" ? "misfired" : row.status })), next_cursor: rows.length === limit && last ? `${last.scheduled_for}|${last.run_id}` : null }; }

  private project(row: Schedule | ScheduleView) { const { schedule_id, state, revision, next_due, created_at, updated_at, terminal_at } = row; return { schedule_id, state, revision, next_due, created_at, updated_at, terminal_at, ...( "action" in row ? { action: row.action, target: row.target, timezone: row.timezone, tzdb_version: row.tzdb_version, authorization_expires_at: row.expires_at } : {}) }; }
  private map(error: unknown): ScheduleApiError { const code = error instanceof Error ? error.message : "scheduler_error"; return new ScheduleApiError(code === "schedule_not_found" ? 404 : code.includes("conflict") ? 409 : code === "unauthorized" ? 403 : 400, code); }
}
