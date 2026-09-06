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
      CREATE TABLE IF NOT EXISTS job_owner_bindings(job_id TEXT PRIMARY KEY,source_event_id TEXT NOT NULL REFERENCES event_job_bindings(event_id),owner_json TEXT NOT NULL,destination_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_completion_results(job_id TEXT NOT NULL,job_status TEXT NOT NULL,source_event_id TEXT NOT NULL REFERENCES events(event_id),owner_json TEXT NOT NULL,destination_json TEXT NOT NULL,work_state TEXT NOT NULL,notification_state TEXT NOT NULL CHECK(notification_state IN ('none','pending','accepted','failed','needs_review')),notification_event_id TEXT REFERENCES events(event_id),materialized_at TEXT NOT NULL,content_delete_at TEXT NOT NULL,result_file_deleted_at TEXT,PRIMARY KEY(job_id,job_status));
      CREATE INDEX IF NOT EXISTS job_owner_lookup_idx ON job_owner_bindings(owner_json);
      CREATE UNIQUE INDEX IF NOT EXISTS schedule_job_owner_idx ON event_job_bindings(json_extract(owner_json,'$.run_id')) WHERE json_extract(owner_json,'$.kind')='schedule';
      CREATE TRIGGER IF NOT EXISTS event_job_binding_immutable BEFORE UPDATE ON event_job_bindings BEGIN SELECT RAISE(ABORT,'event_job_binding_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS job_owner_binding_immutable BEFORE UPDATE ON job_owner_bindings BEGIN SELECT RAISE(ABORT,'job_owner_binding_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS job_completion_outbox_insert AFTER INSERT ON connector_outbox
      WHEN NEW.kind='slack.work_result.post' BEGIN
        UPDATE job_completion_results SET notification_state='pending'
        WHERE job_id=(SELECT job_id FROM schedule_runs WHERE run_id=NEW.run_id);
      END;
      CREATE TRIGGER IF NOT EXISTS job_completion_outbox_update AFTER UPDATE OF status ON connector_outbox
      WHEN NEW.kind='slack.work_result.post' BEGIN
        UPDATE job_completion_results SET notification_state=CASE NEW.status
          WHEN 'sent' THEN 'accepted' WHEN 'failed' THEN 'failed' WHEN 'needs_review' THEN 'needs_review'
          WHEN 'cancelled' THEN 'none' ELSE 'pending' END
        WHERE job_id=(SELECT job_id FROM schedule_runs WHERE run_id=NEW.run_id);
      END;`);
    const marker = db.prepare("SELECT version FROM job_routing_schema WHERE singleton=1").get() as {version:number}|undefined;
    if (marker && marker.version !== 1) throw new Error("Unsupported job routing schema");
    const completionColumns=new Set((db.prepare("PRAGMA table_info(job_completion_results)").all() as Array<{name:string}>).map(row=>row.name));
    if(!completionColumns.has("result_file_deleted_at")) db.exec("ALTER TABLE job_completion_results ADD COLUMN result_file_deleted_at TEXT");
    const eventColumns=new Set((db.prepare("PRAGMA table_info(events)").all() as Array<{name:string}>).map(row=>row.name));
    if(eventColumns.has("source")&&eventColumns.has("reply_target_json")) for (const row of db.prepare("SELECT * FROM events WHERE source='slack'").all() as EventRow[]) {
      const binding=legacySlackBinding(row); if(binding) insertEventJobBinding(db,row.event_id,binding);
    }
    if(eventColumns.has("source")) for(const row of db.prepare(`SELECT e.event_id,e.subject_json,r.run_id,r.revision,r.occurrence_key,v.target_json,v.content
      FROM events e JOIN schedule_runs r ON r.event_id=e.event_id JOIN schedule_revisions v ON v.schedule_id=r.schedule_id AND v.revision=r.revision
      WHERE e.source='dona_schedule' AND v.action='work.read_only'`).all() as Array<{event_id:string;subject_json:string;run_id:string;revision:number;occurrence_key:string;target_json:string;content:string|null}>){
      const subject=JSON.parse(row.subject_json) as {tenant_id:string;owner_id:string;schedule_id:string};
      const rawTarget=JSON.parse(row.target_json) as Record<string,unknown>;
      const destination:z.infer<typeof destinationSchema>=rawTarget.kind==="none"
        ? {kind:"none"}
        : {kind:"slack",action:"slack.work_result.post",target:target.parse(rawTarget)};
      insertEventJobBinding(db,row.event_id,{owner:{kind:"schedule",...subject,run_id:row.run_id,revision:row.revision},destination});
      if(row.content!==null) db.prepare("UPDATE events SET payload_json=? WHERE event_id=?").run(stableStringify({run_id:row.run_id,revision:row.revision,
        occurrence_key:row.occurrence_key,work:{objective:row.content,scope:"read_only",allowed_external_writes:[],result_destination:rawTarget}}),row.event_id);
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
