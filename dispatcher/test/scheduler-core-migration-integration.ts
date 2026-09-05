// 第1引数: fan-out exact checkoutのdispatcher/src/database.ts。
// 他Issueのmigrationを複製せず、実exportを使って双方向の導入順を検証する。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { DispatcherDatabase } from "../src/database.js";
import { migrateScheduler } from "../src/scheduler/schema.js";
import { eventEnvelope } from "./helpers.js";
if (!process.argv[2]) throw new Error("fan-outのdispatcher/src/database.tsを指定してください");
const { migrateDispatcherDatabase } = await import(pathToFileURL(path.resolve(process.argv[2])).href);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-migration-test-"));
const filename = path.join(root, "db.sqlite");
const db = new DispatcherDatabase(filename);
const raw = new Database(filename); raw.pragma("foreign_keys = ON");
try {
  const event = db.enqueue(eventEnvelope("v3-probe")).row;
  const job = db.createJob({ source_event_id: event.event_id, objective: "probe", workspace: { kind: "scratch" } }, root, root).row;
  raw.transaction(() => {
    raw.exec(`INSERT INTO schedules VALUES ('s','T','U','active',1,NULL,NULL,'n','n',NULL);
      INSERT INTO schedule_revisions VALUES ('s',1,'{}','hash','{}',1,NULL,NULL,'a',1,'fixed_objective_redacted_result','U','a','b','work.read_only','{}',NULL,'hash',NULL,'n',NULL)`);
    raw.prepare(`INSERT INTO schedule_runs(run_id,schedule_id,revision,occurrence_key,scheduled_for,status,event_id,job_id,created_at)
      VALUES ('r','s',1,'t','t','started',?,?,'n')`).run(event.event_id, job.job_id);
  })();
  for (const stop of ["jobs_copied", "indexes_recreated", "groups_backfilled"]) {
    assert.throws(() => migrateDispatcherDatabase(raw, (step: string) => { if (step === stop) throw new Error("injected"); }), /injected/);
    assert.equal(raw.pragma("user_version", { simple: true }), 2);
    assert.equal((raw.prepare("SELECT job_id FROM schedule_runs").get() as { job_id: string }).job_id, job.job_id);
    assert.deepEqual(raw.pragma("foreign_key_check"), []);
  }
  migrateDispatcherDatabase(raw); migrateScheduler(raw);
  assert.equal(raw.pragma("user_version", { simple: true }), 3);
  assert.equal((raw.prepare("SELECT job_id FROM schedule_runs").get() as { job_id: string }).job_id, job.job_id);
  assert.deepEqual(raw.pragma("foreign_key_check"), []);
  assert.throws(() => new DispatcherDatabase(filename), /newer than supported version 2/);
  const fresh = new Database(":memory:");
  try {
    fresh.pragma("foreign_keys = ON"); migrateDispatcherDatabase(fresh); migrateScheduler(fresh);
    assert.equal(fresh.pragma("user_version", { simple: true }), 3);
    assert.deepEqual(fresh.pragma("foreign_key_check"), []);
  } finally { fresh.close(); }
  console.log("実fan-out migration: v2+scheduler→v3、各phase rollback、新規v3→scheduler、旧core拒否を確認");
} finally { raw.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); }
