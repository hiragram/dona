import type Database from "better-sqlite3";
import { z } from "zod";

import type { EventRow, JobRow } from "./types.js";
import { stableStringify } from "./validation.js";

const identifier = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/);
const slackOwner = z.object({
  kind: z.literal("slack_thread"), workspace_id: identifier,
  channel_id: identifier, thread_ts: z.string().regex(/^\d+\.\d+$/),
}).strict();
const providerOwner = z.object({
  kind: z.literal("provider_resource"), source: identifier,
  connection_id: identifier, resource_id: identifier,
}).strict().refine((value) => !["slack", "dona_job", "dona_update"].includes(value.source));
export const eventOwnerSchema = z.discriminatedUnion("kind", [slackOwner, providerOwner]);
export type EventOwner = z.infer<typeof eventOwnerSchema>;
export type ProviderOwner = z.infer<typeof providerOwner>;
export const completionDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(), slackOwner,
]);
export type CompletionDestination = z.infer<typeof completionDestinationSchema>;
export const executionPolicySchema = z.object({
  background_job: z.boolean(),
  workspace: z.literal("scratch"),
}).strict();
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;
export interface EventBinding {
  owner: EventOwner;
  execution: ExecutionPolicy;
  destination: CompletionDestination;
}

// payload/subject/trace は認証済み owner の供給経路ではない。
export function legacySlackBinding(row: Pick<EventRow, "source" | "reply_target_json">): EventBinding | undefined {
  if (row.source !== "slack" || !row.reply_target_json) return undefined;
  let parsed;
  try { parsed = slackOwner.safeParse(JSON.parse(row.reply_target_json)); } catch { return undefined; }
  if (!parsed.success) return undefined;
  return { owner: parsed.data, destination: parsed.data, execution: { background_job: true, workspace: "scratch" } };
}

/** jobs/group schema を変更しない独立した additive migration。v2/v3 の両方へ適用可能。 */
export function migrateEventRouting(db: Database.Database, hook: () => void = () => {}): void {
  const migrated = () => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'event_routing_migrations' AND type = 'table'").get()) return false;
    const row = db.prepare("SELECT version FROM event_routing_migrations").get() as { version: number } | undefined;
    if (row && row.version !== 1) throw new Error("Unsupported event routing schema");
    return row !== undefined;
  };
  if (migrated()) return;
  db.transaction(() => {
    if (migrated()) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS event_routing_migrations (version INTEGER PRIMARY KEY CHECK(version = 1));
      CREATE TABLE IF NOT EXISTS provider_execution_policies (
        source TEXT NOT NULL, connection_id TEXT NOT NULL, resource_id TEXT NOT NULL,
        event_type TEXT NOT NULL, policy_json TEXT NOT NULL,
        PRIMARY KEY (source, connection_id, resource_id, event_type)
      );
      CREATE TABLE IF NOT EXISTS event_bindings (
        event_id TEXT PRIMARY KEY REFERENCES events(event_id),
        owner_json TEXT NOT NULL, execution_json TEXT NOT NULL, destination_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_bindings (
        job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),
        event_id TEXT NOT NULL REFERENCES event_bindings(event_id),
        owner_json TEXT NOT NULL, execution_json TEXT NOT NULL, destination_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_completions (
        job_id TEXT NOT NULL REFERENCES jobs(job_id),
        event_id TEXT NOT NULL REFERENCES events(event_id),
        owner_json TEXT NOT NULL, destination_json TEXT NOT NULL,
        result_json TEXT, job_status TEXT NOT NULL, materialized_at TEXT NOT NULL,
        notification_state TEXT NOT NULL CHECK(notification_state IN ('none', 'pending', 'accepted', 'needs_review')),
        notification_event_id TEXT REFERENCES events(event_id),
        notification_result_json TEXT,
        PRIMARY KEY (job_id, job_status)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS job_completion_notification_idx
        ON job_completions(notification_event_id) WHERE notification_event_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS job_binding_owner_idx ON job_bindings(owner_json);
      CREATE TRIGGER IF NOT EXISTS completion_notification_projection AFTER UPDATE OF status, result_json ON events
        BEGIN UPDATE job_completions SET
          notification_state = CASE WHEN NEW.status = 'completed' THEN 'accepted'
            WHEN NEW.status IN ('needs_review', 'dead_letter', 'blocked') THEN 'needs_review' ELSE notification_state END,
          notification_result_json = NEW.result_json
        WHERE notification_event_id = NEW.event_id; END;
      CREATE TRIGGER IF NOT EXISTS event_binding_immutable BEFORE UPDATE ON event_bindings
        BEGIN SELECT RAISE(ABORT, 'event_binding_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS completion_projection_immutable
        BEFORE UPDATE OF job_id, event_id, owner_json, destination_json, result_json, job_status, materialized_at ON job_completions
        BEGIN SELECT RAISE(ABORT, 'completion_projection_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS job_binding_immutable BEFORE UPDATE ON job_bindings
        BEGIN SELECT RAISE(ABORT, 'job_binding_immutable'); END;
    `);
    hook();
    for (const row of db.prepare("SELECT e.* FROM events e WHERE e.source = 'slack' AND NOT EXISTS (SELECT 1 FROM event_bindings b WHERE b.event_id = e.event_id)").all() as EventRow[]) {
      const binding = legacySlackBinding(row);
      if (binding) insertBinding(db, row.event_id, binding);
    }
    db.exec(`INSERT OR IGNORE INTO job_bindings
      SELECT j.job_id, b.event_id, b.owner_json, b.execution_json, b.destination_json
      FROM jobs j JOIN event_bindings b ON b.event_id = j.source_event_id WHERE j.source = 'slack'`);
    const completions = db.prepare(`SELECT j.*, b.owner_json, b.destination_json,
      e.source AS notification_source, e.subject_json AS notification_subject,
      e.reply_target_json AS notification_destination, e.status AS notification_status,
      e.result_json AS notification_result, e.created_at AS notification_created_at
      FROM jobs j JOIN job_bindings b ON b.job_id = j.job_id
      JOIN events e ON e.event_id = j.completion_event_id
      WHERE NOT EXISTS (SELECT 1 FROM job_completions c WHERE c.job_id = j.job_id AND c.job_status = j.status)`)
      .all() as Array<JobRow & { owner_json: string; destination_json: string; notification_source: string;
        notification_subject: string; notification_destination: string | null; notification_status: string;
        notification_result: string | null; notification_created_at: string }>;
    for (const row of completions) {
      const subject = JSON.parse(row.notification_subject) as Record<string, unknown>;
      if (row.notification_source !== "dona_job" || subject.job_id !== row.job_id ||
        subject.source_event_id !== row.source_event_id || row.notification_destination !== row.destination_json) {
        throw new Error("Legacy completion owner mismatch");
      }
      const notificationState = row.notification_status === "completed" ? "accepted"
        : ["blocked", "dead_letter", "needs_review"].includes(row.notification_status) ? "needs_review" : "pending";
      db.prepare(`INSERT INTO job_completions
        (job_id, event_id, owner_json, destination_json, result_json, job_status, materialized_at,
          notification_state, notification_event_id, notification_result_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.job_id, row.source_event_id, row.owner_json, row.destination_json, row.result_json, row.status,
          row.notification_created_at, notificationState, row.completion_event_id, row.notification_result);
    }
    db.prepare("INSERT INTO event_routing_migrations VALUES (1)").run();
  }).immediate();
}

export function insertBinding(db: Database.Database, eventId: string, binding: EventBinding): void {
  const owner = eventOwnerSchema.parse(binding.owner);
  const destination = completionDestinationSchema.parse(binding.destination);
  const execution = executionPolicySchema.parse(binding.execution);
  if (owner.kind === "provider_resource" && destination.kind !== "none") throw new Error("Provider outbound capability is not configured");
  if (owner.kind === "slack_thread" && stableStringify(owner) !== stableStringify(destination)) throw new Error("Slack destination must match its owner");
  const values = [stableStringify(owner), stableStringify(execution), stableStringify(destination)] as const;
  const existing = db.prepare("SELECT owner_json, execution_json, destination_json FROM event_bindings WHERE event_id = ?").get(eventId) as BindingRow | undefined;
  if (existing) {
    if (existing.owner_json !== values[0] || existing.execution_json !== values[1] || existing.destination_json !== values[2]) throw new Error("Event binding conflict");
    return;
  }
  db.prepare("INSERT INTO event_bindings VALUES (?, ?, ?, ?)").run(eventId, ...values);
}
interface BindingRow { owner_json: string; execution_json: string; destination_json: string }
export function readBinding(db: Database.Database, eventId: string): EventBinding | undefined {
  const row = db.prepare("SELECT * FROM event_bindings WHERE event_id = ?").get(eventId) as BindingRow | undefined;
  return row ? {
    owner: eventOwnerSchema.parse(JSON.parse(row.owner_json)),
    execution: executionPolicySchema.parse(JSON.parse(row.execution_json)),
    destination: completionDestinationSchema.parse(JSON.parse(row.destination_json)),
  } : undefined;
}
