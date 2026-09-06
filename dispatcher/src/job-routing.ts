import type Database from "better-sqlite3";
import { z } from "zod";
import type { EventRow } from "./types.js";
import { stableStringify } from "./validation.js";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const slack = z.strictObject({ kind: z.literal("slack_thread"), workspace_id: id, channel_id: id, thread_ts: z.string().regex(/^\d{1,20}\.\d{6}$/) });
const schedule = z.strictObject({ kind: z.literal("schedule"), tenant_id: id, owner_id: id, schedule_id: id, run_id: id, revision: z.number().int().positive() });
export const jobOwnerSchema = z.discriminatedUnion("kind", [slack, schedule]);
const target = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("thread"), workspace_id: id, channel_id: id, thread_ts: z.string().regex(/^\d{1,20}\.\d{6}$/) }),
  z.strictObject({ kind: z.literal("channel"), workspace_id: id, channel_id: id }),
  z.strictObject({ kind: z.literal("owner_dm"), workspace_id: id, channel_id: id, owner_id: id }),
]);
export const destinationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }), slack,
  z.strictObject({ kind: z.literal("slack"), action: z.literal("slack.work_result.post"), target }),
]);
export type JobBinding = { owner: z.infer<typeof jobOwnerSchema>; destination: z.infer<typeof destinationSchema> };

export function migrateJobRouting(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS job_routing_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS event_job_bindings(event_id TEXT PRIMARY KEY REFERENCES events(event_id),owner_json TEXT NOT NULL,destination_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_owner_bindings(job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),source_event_id TEXT NOT NULL REFERENCES event_job_bindings(event_id),owner_json TEXT NOT NULL,destination_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_completion_results(job_id TEXT NOT NULL REFERENCES jobs(job_id),job_status TEXT NOT NULL,source_event_id TEXT NOT NULL REFERENCES events(event_id),owner_json TEXT NOT NULL,destination_json TEXT NOT NULL,result_json TEXT,work_state TEXT NOT NULL,notification_state TEXT NOT NULL CHECK(notification_state IN ('none','pending','accepted','failed','needs_review')),notification_event_id TEXT REFERENCES events(event_id),materialized_at TEXT NOT NULL,PRIMARY KEY(job_id,job_status));
      CREATE INDEX IF NOT EXISTS job_owner_lookup_idx ON job_owner_bindings(owner_json);
      CREATE UNIQUE INDEX IF NOT EXISTS schedule_job_owner_idx ON event_job_bindings(json_extract(owner_json,'$.run_id')) WHERE json_extract(owner_json,'$.kind')='schedule';
      CREATE TRIGGER IF NOT EXISTS event_job_binding_immutable BEFORE UPDATE ON event_job_bindings BEGIN SELECT RAISE(ABORT,'event_job_binding_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS job_owner_binding_immutable BEFORE UPDATE ON job_owner_bindings BEGIN SELECT RAISE(ABORT,'job_owner_binding_immutable'); END;`);
    const marker = db.prepare("SELECT version FROM job_routing_schema WHERE singleton=1").get() as {version:number}|undefined;
    if (marker && marker.version !== 1) throw new Error("Unsupported job routing schema");
    const eventColumns=new Set((db.prepare("PRAGMA table_info(events)").all() as Array<{name:string}>).map(row=>row.name));
    if(eventColumns.has("source")&&eventColumns.has("reply_target_json")) for (const row of db.prepare("SELECT * FROM events WHERE source='slack'").all() as EventRow[]) {
      const binding=legacySlackBinding(row); if(binding) insertEventJobBinding(db,row.event_id,binding);
    }
    db.exec(`INSERT OR IGNORE INTO job_owner_bindings SELECT j.job_id,b.event_id,b.owner_json,b.destination_json FROM jobs j JOIN event_job_bindings b ON b.event_id=j.source_event_id`);
    db.prepare("INSERT OR IGNORE INTO job_routing_schema VALUES(1,1)").run();
  }).immediate();
}

export function legacySlackBinding(row:Pick<EventRow,"source"|"reply_target_json">):JobBinding|undefined {
  if(row.source!=="slack"||!row.reply_target_json) return undefined;
  try { const owner=slack.parse(JSON.parse(row.reply_target_json)); return {owner,destination:owner}; } catch { return undefined; }
}

export function insertEventJobBinding(db: Database.Database,eventId:string,input:JobBinding):void {
  const owner=jobOwnerSchema.parse(input.owner), destination=destinationSchema.parse(input.destination);
  if(owner.kind==="slack_thread"&&stableStringify(owner)!==stableStringify(destination)) throw new Error("Slack destination must match owner");
  if(owner.kind==="schedule"&&destination.kind==="slack"&&destination.target.workspace_id!==owner.tenant_id) throw new Error("Cross-tenant destination denied");
  const values=[stableStringify(owner),stableStringify(destination)] as const;
  const saved=db.prepare("SELECT owner_json,destination_json FROM event_job_bindings WHERE event_id=?").get(eventId) as {owner_json:string;destination_json:string}|undefined;
  if(saved){if(saved.owner_json!==values[0]||saved.destination_json!==values[1]) throw new Error("Event job binding conflict");return;}
  db.prepare("INSERT INTO event_job_bindings VALUES(?,?,?)").run(eventId,...values);
}
export function readEventJobBinding(db:Database.Database,eventId:string):JobBinding|undefined {
  const row=db.prepare("SELECT owner_json,destination_json FROM event_job_bindings WHERE event_id=?").get(eventId) as {owner_json:string;destination_json:string}|undefined;
  return row?{owner:jobOwnerSchema.parse(JSON.parse(row.owner_json)),destination:destinationSchema.parse(JSON.parse(row.destination_json))}:undefined;
}
