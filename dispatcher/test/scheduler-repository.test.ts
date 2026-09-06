import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import Database from "better-sqlite3";
import { envelopeFromRow } from "../src/prompt.js";
import { DispatcherDatabase } from "../src/database.js";
import { migrateJobRouting } from "../src/job-routing.js";
import { migrateScheduler } from "../src/scheduler/schema.js";
import type { Actor, RevisionInput, Run, SchedulerRepository } from "../src/scheduler/repository.js";
import { eventEnvelope } from "./helpers.js";

const now = "2026-09-05T00:00:00Z";
const due = "2026-09-05T00:01:00Z";
const later = "2026-09-06T00:01:00Z";
const afterLater = "2026-09-07T00:01:00Z";
const actor: Actor = { tenant_id: "T_TEST", actor_id: "U_TEST", role: "owner", source_event_id: null };
const input: RevisionInput = {
  recurrence_json: '{"interval":1,"kind":"daily","local_time":"00:01:00","start_date":"2026-09-05","timezone":"Asia/Tokyo","tzdb_version":"2025b","version":1}\n',
  policy_json: fs.readFileSync(new URL("../../docs/adr/fixtures/scheduler-v1/policy.json", import.meta.url), "utf8"),
  policy_version: 1, timezone: "Asia/Tokyo", tzdb_version: "2025b",
  authorization_id: "auth_test", authorization_revision: 1, approver_id: "U_TEST", approved_at: now, expires_at: "2026-09-30T00:00:00Z",
  action: "slack.reminder.post", target: { kind: "thread", workspace_id: "T_TEST", channel_id: "C_TEST", thread_ts: "1.000001" }, content: "非公開のリマインダー本文",
};
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dona-scheduler-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "test.sqlite");
  const dispatcher = new DispatcherDatabase(filename);
  const raw = new Database(filename); raw.pragma("foreign_keys = ON");
  cleanups.push(() => { raw.close(); dispatcher.close(); });
  return { filename, dispatcher, raw, repo: dispatcher.scheduler.withCodecs({
    // These test doubles accept only the two fixed ADR documents. Real #6 codec interoperability
    // is verified separately against its PR head; no parser is reimplemented in #7.
    recurrence: text => { assert.equal(text, input.recurrence_json); return text; },
    policy: text => { assert.equal(text, input.policy_json); return text; },
  }) };
}
const count = (raw: Database.Database, table: string): number => (raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
function startWork(repo: SchedulerRepository, dispatcher: DispatcherDatabase, raw: Database.Database, run: Run, at: string): void {
  const event = dispatcher.enqueue(eventEnvelope(`job-${run.run_id}`)).row;
  const job = dispatcher.createJob({ source_event_id: event.event_id, objective: "read only", workspace: { kind: "scratch" } }, "/tmp/test-scheduler-work", "/tmp/test-scheduler-results");
  raw.prepare("UPDATE jobs SET source_event_id = ? WHERE job_id = ?").run(run.event_id, job.row.job_id);
  repo.setRunState(run.run_id, "materialized", "started", actor, at, job.row.job_id);
}

test("新規DB、scheduler schema v1のexpand列、再open、WAL/FK", () => {
  const { raw, filename, dispatcher } = setup();
  const event = dispatcher.enqueue(eventEnvelope("legacy")).row;
  raw.exec(`DROP TABLE schedule_audit; DROP TABLE connector_outbox; DROP TABLE schedule_runs;
    DROP TABLE schedule_claims; DROP TABLE schedules; DROP TABLE schedule_revisions;
    DROP TABLE schedule_list_sequence; DROP TABLE scheduler_schema`);
  assert.equal(raw.pragma("user_version", { simple: true }), 2);
  const reopened = new DispatcherDatabase(filename);
  assert.equal(reopened.get(event.event_id)?.external_event_id, "legacy");
  assert.equal(raw.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(raw.pragma("foreign_keys", { simple: true }), 1);
  assert.equal((raw.prepare("SELECT version FROM scheduler_schema").get() as { version: number }).version, 1);
  assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'schedule_claims'").get());
  reopened.close();
  raw.exec("UPDATE scheduler_schema SET version = 3");
  assert.throws(() => new DispatcherDatabase(filename), /unsupported_scheduler_schema/);
});

test("extension migration失敗は全DDLをrollbackしcore versionを保持する", () => {
  const raw = new Database(":memory:");
  try {
    raw.exec("CREATE TABLE events(event_id TEXT PRIMARY KEY); CREATE TABLE jobs(job_id TEXT PRIMARY KEY); CREATE TABLE connector_outbox(x); PRAGMA user_version = 2");
    assert.throws(() => migrateScheduler(raw), /already exists/);
    assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'schedules'").get(), undefined);
    assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'scheduler_schema'").get(), undefined);
    assert.equal(raw.pragma("user_version", { simple: true }), 2);
  } finally { raw.close(); }
});

test("scheduler schema v1へ保持されるlist sequenceを追加する", () => {
  const raw = new Database(":memory:");
  try {
    raw.exec(`CREATE TABLE scheduler_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO scheduler_schema VALUES(1, 1);
      CREATE TABLE schedules(schedule_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL);
      CREATE TABLE schedule_revisions(schedule_id TEXT NOT NULL, revision INTEGER NOT NULL, recurrence_json TEXT NOT NULL,
        policy_json TEXT NOT NULL, action TEXT NOT NULL, target_json TEXT NOT NULL, content_hash TEXT NOT NULL);
      CREATE TABLE schedule_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id TEXT NOT NULL, operation TEXT NOT NULL);
      INSERT INTO schedules VALUES('legacy', 'T', 'U');
      INSERT INTO schedule_revisions VALUES('legacy', 1, '{}', '{}', 'work.read_only', '{"kind":"none"}', 'content');
      INSERT INTO schedule_audit(schedule_id, operation) VALUES('legacy', 'create');`);
    migrateScheduler(raw);
    assert.equal((raw.prepare("SELECT version FROM scheduler_schema").get() as { version: number }).version, 1);
    assert.equal((raw.prepare("SELECT list_sequence FROM schedules WHERE schedule_id = 'legacy'").get() as { list_sequence: number }).list_sequence, 1);
    assert.equal((raw.prepare("SELECT next_value FROM schedule_list_sequence").get() as { next_value: number }).next_value, 2);
    assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'schedule_claims'").get());
    assert.match((raw.prepare("SELECT create_payload_hash FROM schedules WHERE schedule_id = 'legacy'").get() as { create_payload_hash: string }).create_payload_hash, /^[a-f0-9]{64}$/);
  } finally { raw.close(); }
});

test("revision 1が欠落した既存DBへexpand列を不完全に追加しない", () => {
  const raw = new Database(":memory:");
  try {
    raw.exec(`CREATE TABLE scheduler_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO scheduler_schema VALUES(1, 1);
      CREATE TABLE schedules(schedule_id TEXT PRIMARY KEY);
      INSERT INTO schedules VALUES('missing-initial');
      CREATE TABLE schedule_revisions(schedule_id TEXT NOT NULL, revision INTEGER NOT NULL, recurrence_json TEXT NOT NULL,
        policy_json TEXT NOT NULL, action TEXT NOT NULL, target_json TEXT NOT NULL, content_hash TEXT NOT NULL);
      CREATE TABLE schedule_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id TEXT NOT NULL, operation TEXT NOT NULL);`);
    assert.throws(() => migrateScheduler(raw), /scheduler_create_payload_unrecoverable/);
    assert.equal((raw.prepare("SELECT version FROM scheduler_schema").get() as { version: number }).version, 1);
    assert.equal((raw.prepare("SELECT count(*) AS count FROM pragma_table_info('schedules') WHERE name = 'create_payload_hash'").get() as { count: number }).count, 0);
  } finally { raw.close(); }
});

test("createとauditがatomic、revision conflict・不正遷移・tenant越境を拒否", () => {
  const { repo, raw } = setup();
  assert.throws(() => repo.create("s_fail", input, due, { ...actor, source_event_id: "evt_missing" }, now), /FOREIGN KEY/);
  assert.equal(count(raw, "schedules"), 0); assert.equal(count(raw, "schedule_revisions"), 0);
  repo.create("s1", input, due, actor, now);
  assert.throws(() => repo.transition("s1", 1, "resume", actor, now), /invalid_transition/);
  assert.throws(() => repo.transition("s1", 1, "pause", { ...actor, tenant_id: "T_OTHER", role: "admin" }, now), /unauthorized/);
  const paused = repo.transition("s1", 1, "pause", actor, now); assert.equal(paused.revision, 2);
  assert.throws(() => repo.transition("s1", 1, "cancel", actor, now), /revision_conflict/);
  assert.throws(() => repo.transition("s1", 2, "resume", { ...actor, actor_id: "U_ADMIN", role: "admin" }, now), /unauthorized/);
  repo.update("s1", 2, { ...input, authorization_id: "auth_new", authorization_revision: 3, content: "変更後本文" }, later, actor, now);
  assert.equal(repo.get("s1")?.revision, 3);
  repo.transition("s1", 3, "pause", actor, now);
  assert.throws(() => repo.update("s1", 4, { ...input, authorization_revision: 5 }, later, actor, now), /authorization_revision_conflict/);
  assert.equal((raw.prepare("SELECT content FROM schedule_revisions WHERE revision = 1").get() as { content: string }).content, input.content);
  const audit = JSON.stringify(repo.auditHistory("s1"));
  assert.ok(!audit.includes(input.content)); assert.ok(!audit.includes("変更後本文")); assert.ok(!audit.includes("C_TEST"));
  assert.deepEqual((repo.auditHistory("s1") as { operation: string }[]).map(x => x.operation), ["create", "pause", "update", "pause"]);
  const updateAudit = (repo.auditHistory("s1") as { operation: string; before_json: string }[]).find(x => x.operation === "update")!;
  assert.deepEqual(JSON.parse(updateAudit.before_json), { state: "paused", revision: 2, next_due: due, high_watermark: null,
    action: input.action, policy_version: 1, tzdb_version: input.tzdb_version,
    content_hash: createHash("sha256").update(input.content).digest("hex"),
    recurrence_hash: createHash("sha256").update(input.recurrence_json).digest("hex") });
});

test("dueとoutboxを原子的に物化、duplicate wakeとrevision変更をまたぐ一意性", () => {
  const { repo, raw } = setup(); repo.create("s1", input, due, actor, now);
  assert.equal(repo.due(now).length, 0); assert.equal(repo.due(due).length, 1);
  const first = repo.materialize("s1", 1, due, later, due, actor);
  for (let i = 0; i < 5; i++) assert.equal(repo.materialize("s1", 1, due, later, due, actor).run.run_id, first.run.run_id);
  assert.equal(repo.materialize("s1", 1, due, later, "2026-09-07T00:00:00Z", actor).duplicate, true);
  assert.equal(count(raw, "schedule_runs"), 1); assert.equal(count(raw, "connector_outbox"), 1);
  repo.transition("s1", 1, "pause", actor, due);
  assert.equal(repo.materialize("s1", 1, due, later, due, actor).duplicate, true);
  assert.equal(repo.get("s1")?.high_watermark, due);
  assert.equal((raw.prepare("SELECT status FROM connector_outbox").get() as { status: string }).status, "cancelled");
});

test("物化途中のoutbox/audit失敗でrun、event、next_dueを巻き戻す", () => {
  const { repo, raw, dispatcher } = setup();
  repo.create("s1", input, due, actor, now);
  raw.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON connector_outbox BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => repo.materialize("s1", 1, due, later, due, actor), /injected/);
  assert.equal(count(raw, "schedule_runs"), 0); assert.equal(repo.get("s1")?.next_due, due);
  raw.exec("DROP TRIGGER fail_outbox");
  repo.create("s2", { ...input, action: "work.read_only" }, due, actor, now);
  raw.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON schedule_audit WHEN NEW.operation = 'materialize' BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => repo.materialize("s2", 1, due, later, due, actor), /injected/);
  assert.equal(count(raw, "schedule_runs"), 0); assert.equal(dispatcher.list().length, 0); assert.equal(repo.get("s2")?.high_watermark, null);
  raw.exec("DROP TRIGGER fail_audit");
  const first = repo.materialize("s2", 1, due, later, due, actor);
  assert.ok(first.run.event_id); assert.equal(dispatcher.list().length, 1);
  assert.equal(repo.materialize("s2", 1, due, later, due, actor).duplicate, true);
  assert.equal(dispatcher.list().length, 1); assert.equal(count(raw, "connector_outbox"), 0);
});

test("scheduled workをownerへ一意bindingしResultと通知状態を分離する", () => {
  const { repo, dispatcher, raw } = setup();
  const work={...input,action:"work.read_only" as const,target:{kind:"none" as const},content:"repositoryをread-onlyで調査する"};
  repo.create("scheduled",work,due,actor,now);
  const run=repo.materialize("scheduled",1,due,later,due,actor).run;
  const event=dispatcher.get(run.event_id!)!;
  assert.equal(dispatcher.nextAvailable()?.event_id,event.event_id);
  assert.throws(()=>dispatcher.createJob({source_event_id:event.event_id,objective:"差し替えた依頼",workspace:{kind:"scratch"}},"/tmp/jobs","/tmp/results",new Date(due)),/persisted read-only scope/);
  const created=dispatcher.createJob({source_event_id:event.event_id,objective:work.content,workspace:{kind:"scratch"}},"/tmp/jobs","/tmp/results",new Date(due));
  const duplicate=dispatcher.createJob({source_event_id:event.event_id,objective:work.content,workspace:{kind:"scratch"}},"/tmp/jobs","/tmp/results",new Date(due));
  assert.equal(duplicate.duplicate,true); assert.equal(duplicate.row.job_id,created.row.job_id);
  assert.equal(dispatcher.listOwnerJobs(event.event_id)[0]?.job_id,created.row.job_id);
  assert.throws(()=>dispatcher.appendQueuedJobInstruction(created.row.job_id,event.event_id,"変更"),/cannot be steered/);
  assert.equal(repo.getRun(run.run_id)?.status,"started");
  const other=dispatcher.enqueue(eventEnvelope("other-owner")).row;
  assert.throws(()=>dispatcher.beginJobSteer(created.row.job_id,other.event_id),/does not belong/);
  dispatcher.beginJobPreparation(created.row.job_id,new Date(due)); dispatcher.beginJobDispatch(created.row.job_id,new Date(due)); dispatcher.markJobRunning(created.row.job_id,new Date(due));
  dispatcher.saveJobResult(created.row.job_id,{schema_version:1,job_id:created.row.job_id,status:"completed",summary:"完了",output:{format:"markdown",text:"結果"},completed_at:"2026-09-05T00:02:00Z"},created.row.result_path,new Date("2026-09-05T00:02:00Z"));
  assert.equal(dispatcher.enqueueJobNotification(created.row.job_id,new Date("2026-09-05T00:02:00Z")).row.event_id,event.event_id);
  assert.equal(repo.getRun(run.run_id)?.status,"completed");
  const completion=raw.prepare("SELECT work_state,notification_state,notification_event_id FROM job_completion_results").get() as Record<string,unknown>;
  assert.deepEqual(completion,{work_state:"completed",notification_state:"none",notification_event_id:null});
});

test("scheduled jobのneeds_reviewをscheduleへ伝播しadmin reconciliationを監査する", () => {
  const { repo, dispatcher, raw } = setup();
  const objective = "曖昧なread-only作業";
  repo.create("review_work", { ...input, action: "work.read_only", target: { kind: "none" }, content: objective }, due, actor, now);
  const run = repo.materialize("review_work", 1, due, later, due, actor).run;
  const job = dispatcher.createJob({ source_event_id: run.event_id!, objective, workspace: { kind: "scratch" } }, "/tmp/jobs", "/tmp/results", new Date(due)).row;
  dispatcher.beginJobPreparation(job.job_id, new Date(due)); dispatcher.beginJobDispatch(job.job_id, new Date(due)); dispatcher.markJobRunning(job.job_id, new Date(due));
  dispatcher.markJobNeedsReview(job.job_id, "ambiguous_job_result", "結果の受理が不明");
  dispatcher.enqueueJobNotification(job.job_id, new Date(due));
  assert.equal(repo.getRun(run.run_id)?.status, "needs_review"); assert.equal(repo.get("review_work")?.state, "needs_review");
  assert.throws(() => repo.reconcileWorkRun(run.run_id, "failed", actor, due), /admin_required/);
  repo.reconcileWorkRun(run.run_id, "failed", { ...actor, role: "admin" }, due);
  assert.equal(repo.getRun(run.run_id)?.status, "failed");
  assert.ok((repo.auditHistory("review_work") as Array<{ operation: string }>).some(row => row.operation === "reconcile_work_failed"));
  assert.equal((raw.prepare("SELECT work_state FROM job_completion_results WHERE job_id=?").get(job.job_id) as {work_state:string}).work_state, "needs_review");
});

test("work result通知のdelivery stateと本文retentionをjob resultへ同期する", () => {
  const { repo, dispatcher, raw, filename } = setup();
  const objective = "通知付きread-only作業";
  repo.create("notify_work", { ...input, action: "work.read_only", content: objective }, due, actor, now);
  const run = repo.materialize("notify_work", 1, due, later, due, actor).run;
  const job = dispatcher.createJob({ source_event_id: run.event_id!, objective, workspace: { kind: "scratch" } }, path.dirname(filename), path.dirname(filename), new Date(due)).row;
  dispatcher.beginJobPreparation(job.job_id, new Date(due)); dispatcher.beginJobDispatch(job.job_id, new Date(due)); dispatcher.markJobRunning(job.job_id, new Date(due));
  dispatcher.saveJobResult(job.job_id, { schema_version: 1, job_id: job.job_id, status: "completed", summary: "完了", output: { format: "markdown", text: "結果" }, completed_at: due }, job.result_path, new Date(due));
  dispatcher.enqueueJobNotification(job.job_id, new Date(due));
  assert.equal((raw.prepare("SELECT notification_state FROM job_completion_results WHERE job_id=?").get(job.job_id) as {notification_state:string}).notification_state, "pending");
  const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
  repo.finishWrite(claim.outbox_id, claim.claim_token!, "sent", due, "1.000002");
  assert.equal((raw.prepare("SELECT notification_state FROM job_completion_results WHERE job_id=?").get(job.job_id) as {notification_state:string}).notification_state, "accepted");
  fs.writeFileSync(job.result_path,"sensitive result"); repo.purge("2026-09-12T00:01:01Z");
  assert.equal(fs.existsSync(job.result_path),false);
  assert.equal((raw.prepare("SELECT result_json FROM jobs WHERE job_id=?").get(job.job_id) as {result_json:string|null}).result_json,null);
  assert.equal((raw.prepare("SELECT result_file_deleted_at FROM job_completion_results WHERE job_id=?").get(job.job_id) as {result_file_deleted_at:string|null}).result_file_deleted_at,"2026-09-12T00:01:01Z");
  assert.equal((raw.prepare("SELECT objective FROM jobs WHERE job_id=?").get(job.job_id) as {objective:string}).objective,"[deleted]");
  assert.equal(JSON.parse((raw.prepare("SELECT payload_json FROM events WHERE event_id=?").get(run.event_id) as {payload_json:string}).payload_json).work.objective,"[deleted]");
});

test("job開始時の認可拒否はjobだけを戻してrun終端を確定する", () => {
  const { repo, dispatcher, raw } = setup(); const objective = "開始境界の調査";
  repo.create("start_fence", { ...input, action: "work.read_only", target: { kind: "none" }, content: objective }, due, actor, now);
  const run = repo.materialize("start_fence", 1, due, later, due, actor).run;
  raw.prepare("UPDATE schedules SET state='paused' WHERE schedule_id='start_fence'").run();
  assert.throws(() => dispatcher.createJob({ source_event_id: run.event_id!, objective, workspace: { kind: "scratch" } }, "/tmp/jobs", "/tmp/results", new Date(due)), /no longer authorized/);
  assert.equal(dispatcher.listJobs().length, 0); assert.equal(repo.getRun(run.run_id)?.status, "cancelled");
});

test("旧scheduled eventのbindingとwork payloadをmigrationで復元する", () => {
  const { repo, dispatcher, raw } = setup(); const objective = "旧eventの調査";
  repo.create("legacy_work", { ...input, action: "work.read_only", target: { kind: "none" }, content: objective }, due, actor, now);
  const run = repo.materialize("legacy_work", 1, due, later, due, actor).run;
  raw.prepare("DELETE FROM event_job_bindings WHERE event_id=?").run(run.event_id);
  raw.prepare("UPDATE events SET payload_json='{}' WHERE event_id=?").run(run.event_id);
  migrateJobRouting(raw);
  const payload = JSON.parse(dispatcher.get(run.event_id!)!.payload_json) as {work:{objective:string;scope:string}};
  assert.deepEqual(payload.work, { objective, scope: "read_only", allowed_external_writes: [], result_destination: { kind: "none" } });
  assert.equal(dispatcher.listOwnerJobs(run.event_id!).length, 0);
  raw.prepare("UPDATE events SET payload_json=json_set(payload_json,'$.work.objective','[deleted]') WHERE event_id=?").run(run.event_id);
  migrateJobRouting(raw);
  assert.equal((JSON.parse(dispatcher.get(run.event_id!)!.payload_json) as {work:{objective:string}}).work.objective,"[deleted]");
});

test("blockedとredaction拒否をneeds_reviewへ隔離し取消しを確定できる", () => {
  for (const mode of ["blocked", "redacted"] as const) {
    const { repo, dispatcher, raw } = setup(); const objective = `${mode}調査`;
    repo.create(mode, { ...input, action: "work.read_only", content: objective }, due, actor, now);
    const run = repo.materialize(mode, 1, due, later, due, actor).run;
    const job = dispatcher.createJob({ source_event_id: run.event_id!, objective, workspace: { kind: "scratch" } }, "/tmp/jobs", "/tmp/results", new Date(due)).row;
    dispatcher.beginJobPreparation(job.job_id, new Date(due)); dispatcher.beginJobDispatch(job.job_id, new Date(due)); dispatcher.markJobRunning(job.job_id, new Date(due));
    if (mode === "blocked") dispatcher.markJobBlocked(job.job_id, "入力待ち");
    else {
      assert.throws(()=>dispatcher.saveJobResult(job.job_id, {schema_version:1,job_id:job.job_id,status:"completed",summary:"secret: redacted",output:{format:"markdown",text:"結果"},completed_at:due},job.result_path),/content_requires_redaction/);
      dispatcher.markJobNeedsReview(job.job_id,"invalid_result","content_requires_redaction");
    }
    dispatcher.enqueueJobNotification(job.job_id, new Date(due));
    assert.equal(repo.getRun(run.run_id)?.status, "needs_review"); assert.equal(repo.get(mode)?.state, "needs_review");
    assert.equal((raw.prepare("SELECT notification_state FROM job_completion_results WHERE job_id=?").get(job.job_id) as {notification_state:string}).notification_state, "pending");
    const notice = repo.claim(due); assert.ok(notice); assert.equal(notice.kind, "slack.work_result.post");
    if (mode === "blocked") {
      dispatcher.beginJobCancellation(job.job_id, job.source_event_id); dispatcher.markJobCancelled(job.job_id, "取消し", new Date(due));
      dispatcher.enqueueJobNotification(job.job_id, new Date(due)); assert.equal(repo.getRun(run.run_id)?.status, "cancelled");
    }
  }
});

test("scheduled jobの3600秒deadlineを永続開始時刻から抽出する", () => {
  const { repo, dispatcher } = setup(); const objective = "deadline調査";
  repo.create("deadline", { ...input, action: "work.read_only", target: { kind: "none" }, content: objective }, due, actor, now);
  const run = repo.materialize("deadline", 1, due, later, due, actor).run;
  const job = dispatcher.createJob({ source_event_id: run.event_id!, objective, workspace: { kind: "scratch" } }, "/tmp/jobs", "/tmp/results", new Date(due)).row;
  dispatcher.beginJobPreparation(job.job_id, new Date(due)); dispatcher.beginJobDispatch(job.job_id, new Date(due)); dispatcher.markJobRunning(job.job_id, new Date(due));
  assert.equal(dispatcher.listOverdueScheduledJobs(new Date("2026-09-05T01:00:59Z")).length, 0);
  assert.equal(dispatcher.listOverdueScheduledJobs(new Date("2026-09-05T01:01:00Z"))[0]?.job_id, job.job_id);
  dispatcher.markJobBlocked(job.job_id,"入力待ち");
  assert.equal(dispatcher.listOverdueScheduledJobs(new Date("2026-09-05T01:01:00Z"))[0]?.job_id,job.job_id);
});

test("schedule cancelとexpiryは対応する実行jobをSupervisor取消対象へ出す", () => {
  const { repo, dispatcher } = setup(); const objective = "取消対象の調査";
  repo.create("cancel_job", { ...input, action: "work.read_only", content: objective }, due, actor, now);
  const run = repo.materialize("cancel_job", 1, due, later, due, actor).run;
  const job = dispatcher.createJob({ source_event_id: run.event_id!, objective, workspace: { kind: "scratch" } }, "/tmp/jobs", "/tmp/results", new Date(due)).row;
  dispatcher.beginJobPreparation(job.job_id, new Date(due)); dispatcher.beginJobDispatch(job.job_id, new Date(due)); dispatcher.markJobRunning(job.job_id, new Date(due));
  repo.transition("cancel_job",1,"cancel",actor,due);
  assert.equal(dispatcher.listScheduledJobsRequiringCancellation()[0]?.job_id,job.job_id);
  dispatcher.beginJobCancellation(job.job_id,job.source_event_id);
  dispatcher.markJobNeedsReview(job.job_id,"cancel_acceptance_unknown","取消応答が不明");
  dispatcher.enqueueJobNotification(job.job_id,new Date(due));
  assert.equal(repo.get("cancel_job")?.state,"needs_review");
  assert.equal(repo.claim(due)?.kind,"slack.work_result.post");

  repo.create("expiry_job", { ...input, action:"work.read_only",target:{kind:"none"},content:objective,
    expires_at:"2026-09-05T00:02:00Z" }, due, actor, now);
  const expiryRun=repo.materialize("expiry_job",1,due,"2026-09-06T00:01:00Z",due,actor).run;
  const expiryJob=dispatcher.createJob({source_event_id:expiryRun.event_id!,objective,workspace:{kind:"scratch"}},"/tmp/jobs","/tmp/results",new Date(due)).row;
  repo.update("expiry_job",1,{...input,action:"work.read_only",target:{kind:"none"},content:objective,
    authorization_id:"auth_renewed",authorization_revision:2,expires_at:"2026-09-30T00:00:00Z"},"2026-09-06T00:01:00Z",actor,due);
  assert.equal(dispatcher.listScheduledJobsRequiringCancellation(new Date("2026-09-05T00:02:00Z")).some(row=>row.job_id===expiryJob.job_id),true);
});

test("schedule eventのdelegation前terminal failureをrunへ原子的に反映する", () => {
  const { repo, dispatcher, raw } = setup();
  repo.create("dispatch_fail", { ...input, action: "work.read_only", content: "失敗境界" }, due, actor, now);
  const run = repo.materialize("dispatch_fail",1,due,later,due,actor).run;
  dispatcher.recordPreDispatchFailure(run.event_id!,"preflight_failed","失敗",1,new Date(due));
  assert.equal(dispatcher.get(run.event_id!)?.status,"dead_letter"); assert.equal(repo.getRun(run.run_id)?.status,"failed");
  assert.equal(repo.claim(due)?.kind,"slack.work_result.post");
  repo.create("dispatch_blocked", { ...input, action:"work.read_only",content:"確認境界" },due,actor,now);
  const blocked=repo.materialize("dispatch_blocked",1,due,later,due,actor).run;
  dispatcher.markBlocked(blocked.event_id!,"承認待ち",undefined,new Date(due));
  assert.equal(dispatcher.get(blocked.event_id!)?.status,"needs_review");
  assert.equal(repo.getRun(blocked.run_id)?.status,"needs_review");
  assert.equal(repo.claim(due)?.kind,"slack.work_result.post");
  repo.purge("2026-09-12T00:01:00Z");
  for(const eventId of [run.event_id!,blocked.event_id!]) {
    const payload=JSON.parse((raw.prepare("SELECT payload_json FROM events WHERE event_id=?").get(eventId) as {payload_json:string}).payload_json);
    assert.equal(payload.work.objective,"[deleted]");
  }
});

test("scheduled failed Resultを保存前にredactionし通常Slack Resultのretentionを変えない", () => {
  const { repo, dispatcher, raw } = setup(); const objective="失敗結果";
  repo.create("failed_secret",{...input,action:"work.read_only",content:objective},due,actor,now);
  const run=repo.materialize("failed_secret",1,due,later,due,actor).run;
  const scheduled=dispatcher.createJob({source_event_id:run.event_id!,objective,workspace:{kind:"scratch"}},"/tmp/jobs","/tmp/results",new Date(due)).row;
  dispatcher.beginJobPreparation(scheduled.job_id,new Date(due)); dispatcher.beginJobDispatch(scheduled.job_id,new Date(due)); dispatcher.markJobRunning(scheduled.job_id,new Date(due));
  assert.throws(()=>dispatcher.saveJobResult(scheduled.job_id,{schema_version:1,job_id:scheduled.job_id,status:"failed",summary:"token: secret",output:{format:"markdown",text:"失敗"},completed_at:due},scheduled.result_path),/content_requires_redaction/);
  assert.throws(()=>dispatcher.saveJobResult(scheduled.job_id,{schema_version:1,job_id:scheduled.job_id,status:"failed",summary:'{"password":"hunter2"}',completed_at:due},scheduled.result_path),/content_requires_redaction/);
  assert.throws(()=>dispatcher.saveJobResult(scheduled.job_id,{schema_version:1,job_id:scheduled.job_id,status:"failed",summary:"失敗",actions:[{detail:"https://files.slack.com/private?token=hidden"}],completed_at:due},scheduled.result_path),/content_requires_redaction/);
  assert.equal(dispatcher.getJob(scheduled.job_id)?.result_json,null);
  dispatcher.saveJobResult(scheduled.job_id,{schema_version:1,job_id:scheduled.job_id,status:"failed",summary:"安全な失敗",completed_at:due},scheduled.result_path,new Date(due));
  dispatcher.enqueueJobNotification(scheduled.job_id,new Date("2026-09-05T02:00:00Z"));
  const failedNotice=raw.prepare("SELECT created_at,status FROM connector_outbox WHERE run_id=?").get(run.run_id) as {created_at:string;status:string};
  assert.equal(failedNotice.created_at,due); assert.equal(failedNotice.status,"pending");
  assert.equal(repo.claim("2026-09-05T02:00:00Z"),undefined);
  assert.equal(repo.getOutbox((raw.prepare("SELECT outbox_id FROM connector_outbox WHERE run_id=?").get(run.run_id) as {outbox_id:string}).outbox_id,"2026-09-05T02:00:00Z")?.status,"failed");
  const event=dispatcher.enqueue(eventEnvelope("slack-retention"),new Date(due)).row;
  const slack=dispatcher.createJob({source_event_id:event.event_id,objective:"通常job",workspace:{kind:"scratch"}},"/tmp/jobs","/tmp/results",new Date(due)).row;
  dispatcher.beginJobPreparation(slack.job_id,new Date(due)); dispatcher.beginJobDispatch(slack.job_id,new Date(due)); dispatcher.markJobRunning(slack.job_id,new Date(due));
  dispatcher.saveJobResult(slack.job_id,{schema_version:1,job_id:slack.job_id,status:"completed",summary:"通常",output:{format:"markdown",text:"保持"},completed_at:due},slack.result_path);
  dispatcher.enqueueJobNotification(slack.job_id,new Date("2026-09-20T00:00:00Z")); repo.purge("2026-09-21T00:00:00Z");
  assert.notEqual((raw.prepare("SELECT result_json FROM jobs WHERE job_id=?").get(slack.job_id) as {result_json:string|null}).result_json,null);
});

test("claimは複数connection間で排他的、送信前lease切れは再claim、古いtokenは拒否", () => {
  const { repo, filename } = setup();
  const other = new DispatcherDatabase(filename); cleanups.push(() => other.close());
  repo.create("s1", input, due, actor, now); repo.materialize("s1", 1, due, later, due, actor);
  const claim = repo.claim(due, 1)!;
  assert.equal(other.scheduler.claim(due), undefined);
  const reclaimed = other.scheduler.claim("2026-09-05T00:01:01Z")!;
  assert.equal(reclaimed.outbox_id, claim.outbox_id); assert.notEqual(reclaimed.claim_token, claim.claim_token);
  assert.throws(() => repo.requestStarted(claim.outbox_id, claim.claim_token!, "2026-09-05T00:01:01Z"), /claim_conflict/);
  assert.equal(repo.requestStarted(reclaimed.outbox_id, reclaimed.claim_token!, "2026-09-05T00:01:01Z").attempt, 1);
});

test("request-started crashは再open後needs_reviewに永続化、reconcileは再送しない", () => {
  const { repo, filename, raw } = setup();
  repo.create("s1", input, due, actor, now); repo.materialize("s1", 1, due, later, due, actor);
  const claim = repo.claim(due, 1)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
  const reopened = new DispatcherDatabase(filename); cleanups.push(() => reopened.close());
  const recovery = "2026-09-05T00:01:01Z";
  assert.equal(reopened.scheduler.recover(recovery), 1);
  assert.equal(repo.getOutbox(claim.outbox_id, recovery)?.status, "needs_review");
  assert.equal(repo.get("s1")?.state, "needs_review"); assert.equal(repo.claim(recovery), undefined);
  assert.equal(repo.recover(recovery), 0);
  assert.throws(() => repo.finishWrite(claim.outbox_id, claim.claim_token!, "not_accepted", recovery), /claim_conflict/);
  repo.reconcile(claim.outbox_id, "sent", "receipt_123", { ...actor, actor_id: "U_ADMIN", role: "admin" }, recovery);
  assert.equal(repo.getOutbox(claim.outbox_id, recovery)?.status, "sent"); assert.equal(repo.claim(recovery), undefined);
  assert.equal(count(raw, "connector_outbox"), 1);
});

test("未受理の確証だけ3 attemptsと1秒/5秒・Retry-Afterを使用、曖昧結果は即隔離", () => {
  const { repo } = setup(); repo.create("s1", input, due, actor, now); repo.materialize("s1", 1, due, later, due, actor);
  let claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
  repo.finishWrite(claim.outbox_id, claim.claim_token!, "not_accepted", due, null, 2);
  assert.equal(repo.claim("2026-09-05T00:01:01Z"), undefined);
  claim = repo.claim("2026-09-05T00:01:02Z")!; repo.requestStarted(claim.outbox_id, claim.claim_token!, "2026-09-05T00:01:02Z");
  repo.finishWrite(claim.outbox_id, claim.claim_token!, "not_accepted", "2026-09-05T00:01:02Z");
  assert.equal(repo.claim("2026-09-05T00:01:06Z"), undefined);
  claim = repo.claim("2026-09-05T00:01:07Z")!; repo.requestStarted(claim.outbox_id, claim.claim_token!, "2026-09-05T00:01:07Z");
  assert.equal(repo.finishWrite(claim.outbox_id, claim.claim_token!, "not_accepted", "2026-09-05T00:01:07Z").status, "failed");
  assert.equal(repo.claim("2026-09-05T00:01:20Z"), undefined);
});

test("work結果retryは完了後900秒境界で長いRetry-Afterと停止復帰時に終端化", () => {
  const { repo, dispatcher, raw } = setup();
  for (const [name, retryAt, retryAfter] of [
    ["boundary", "2026-09-05T00:16:00Z", 0],
    ["retry_after", due, 901],
  ] as const) {
    repo.create(name, { ...input, action: "work.read_only" }, due, actor, now);
    const run = repo.materialize(name, 1, due, later, due, actor).run;
    startWork(repo, dispatcher, raw, run, due);
    repo.setRunState(run.run_id, "started", "completed", actor, due, null, "結果");
    const claim = repo.claim(retryAt)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, retryAt);
    const finished = repo.finishWrite(claim.outbox_id, claim.claim_token!, "not_accepted", retryAt, null, retryAfter);
    assert.equal(finished.status, "failed");
  }
  repo.create("recovery", { ...input, action: "work.read_only" }, due, actor, now);
  const run = repo.materialize("recovery", 1, due, later, due, actor).run;
  startWork(repo, dispatcher, raw, run, due);
  repo.setRunState(run.run_id, "started", "completed", actor, due, null, "結果");
  const stopped = repo.claim(due, 1)!;
  repo.recover("2026-09-05T00:16:01Z");
  assert.equal(repo.getOutbox(stopped.outbox_id, "2026-09-05T00:16:01Z")?.status, "failed");
});

test("cancelとrequest開始のraceでもreceiptとrequest-started fenceを消さない", () => {
  const { repo } = setup(); repo.create("s1", input, due, actor, now); repo.materialize("s1", 1, due, later, due, actor);
  const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
  repo.transition("s1", 1, "cancel", actor, due);
  assert.equal(repo.finishWrite(claim.outbox_id, claim.claim_token!, "sent", due, "C_TEST:1756722030.123456").status, "sent");
  assert.equal(repo.get("s1")?.state, "cancelled"); assert.equal(repo.getOutbox(claim.outbox_id, due)?.request_started_at, due);
  assert.equal(repo.getOutbox(claim.outbox_id, due)?.receipt_id, "C_TEST:1756722030.123456");
});

test("misfire 900秒境界、未決着overlap、expired auth、quotaを保存層で拒否/記録", () => {
  const { repo } = setup(); repo.create("s1", input, due, actor, now);
  assert.equal(repo.materialize("s1", 1, due, later, "2026-09-05T00:16:00Z", actor).run.status, "materialized");
  assert.equal(repo.materialize("s1", 1, later, afterLater, later, actor).run.reason, "overlap");
  repo.create("s2", input, due, actor, now);
  assert.equal(repo.materialize("s2", 1, due, later, "2026-09-05T00:16:01Z", actor).run.reason, "misfire");
  repo.create("s3", { ...input, expires_at: due }, due, actor, now);
  assert.throws(() => repo.materialize("s3", 1, due, later, due, actor), /authorization_expired/);
  for (let i = 4; i <= 20; i++) repo.create(`s${i}`, input, due, actor, now);
  assert.throws(() => repo.create("s21", input, due, actor, now), /quota_exceeded/);
});

test("FK、一意indexとdue/audit/claimのquery plan", () => {
  const { repo, raw } = setup(); repo.create("s1", input, due, actor, now); repo.materialize("s1", 1, due, later, due, actor);
  const run = raw.prepare("SELECT run_id FROM schedule_runs").get() as { run_id: string };
  assert.throws(() => repo.setRunState(run.run_id, "materialized", "started", actor, due, "missing"), /invalid_transition/);
  assert.throws(() => raw.prepare("UPDATE schedule_runs SET revision = 999").run(), /FOREIGN KEY/);
  assert.deepEqual(raw.pragma("foreign_key_check"), []);
  for (const [sql, index] of [
    ["SELECT * FROM schedules WHERE state = 'active' AND next_due <= 'x' ORDER BY next_due, schedule_id LIMIT 100", "schedules_due_idx"],
    ["SELECT * FROM connector_outbox WHERE status = 'pending' AND available_at <= 'x' ORDER BY available_at, outbox_id LIMIT 1", "connector_outbox_claim_idx"],
    ["SELECT * FROM schedule_audit WHERE schedule_id = 's1' ORDER BY sequence", "schedule_audit_order_idx"],
  ]) assert.match(JSON.stringify(raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()), new RegExp(index!));
});

test("本文retention、未決着fence保持、audit 90日、run purge後high-watermark", () => {
  const { repo, raw } = setup(); repo.create("s1", input, due, actor, now); repo.materialize("s1", 1, due, later, due, actor);
  const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
  repo.finishWrite(claim.outbox_id, claim.claim_token!, "ambiguous", due);
  const seven = "2026-09-12T00:01:00Z";
  assert.equal(repo.getOutbox(claim.outbox_id, seven)?.content, null);
  repo.purge(seven); assert.equal(repo.getOutbox(claim.outbox_id, seven)?.status, "needs_review");
  assert.equal(count(raw, "schedule_runs"), 1);
  repo.reconcile(claim.outbox_id, "failed", "proof_1", { ...actor, role: "admin" }, seven);
  repo.purge("2026-10-13T00:01:00Z"); assert.equal(count(raw, "schedule_runs"), 0);
  assert.equal(repo.get("s1")?.high_watermark, due);
  assert.ok(count(raw, "schedule_audit") > 0);
  repo.purge("2027-01-01T00:00:00Z"); assert.equal(count(raw, "schedule_audit"), 0);
});

test("work run状態とjob参照、生成結果outboxのatomic primitive", () => {
  const { repo, dispatcher, raw } = setup(); repo.create("s1", { ...input, action: "work.read_only" }, due, actor, now);
  const { run } = repo.materialize("s1", 1, due, later, due, actor);
  assert.throws(() => repo.setRunState(run.run_id, "materialized", "started", actor, due), /job_reference_required/);
  const job = dispatcher.createJob({ source_event_id: dispatcher.enqueue(eventEnvelope("job-fixture")).row.event_id, objective: "read only", workspace: { kind: "scratch" } }, "/tmp/test-scheduler-work", "/tmp/test-scheduler-results");
  // #11 owns scheduler-to-job routing. Supply only its persisted link for this repository test.
  raw.prepare("UPDATE jobs SET source_event_id = ? WHERE job_id = ?").run(run.event_id, job.row.job_id);
  repo.setRunState(run.run_id, "materialized", "started", actor, due, job.row.job_id);
  assert.throws(() => repo.setRunState(run.run_id, "materialized", "completed", actor, due), /run_conflict/);
  repo.setRunState(run.run_id, "started", "completed", actor, due, null, "調査結果");
  assert.equal(count(raw, "connector_outbox"), 1);
  assert.equal(repo.claim(due)?.kind, "slack.work_result.post");
});


test("redacted backupは本文・target・任意JSONを含まずfenceとhashを保持", () => {
  const { repo } = setup(); repo.create("s1", input, due, actor, now); repo.materialize("s1", 1, due, later, due, actor);
  const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
  repo.finishWrite(claim.outbox_id, claim.claim_token!, "ambiguous", due);
  const backup = JSON.stringify(repo.redactedBackup());
  assert.ok(!backup.includes(input.content)); assert.ok(!backup.includes("C_TEST"));
  assert.ok(!backup.includes("policy_json")); assert.ok(!backup.includes("recurrence_json"));
  assert.ok(backup.includes("needs_review")); assert.ok(backup.includes("request_started_at"));
  assert.ok(backup.includes("high_watermark")); assert.ok(backup.includes("content_hash"));
  assert.throws(() => repo.create("s2", { ...input, content: "token=confidential" }, due, actor, now), /content_requires_redaction/);
});

test("run単位の取消・失敗は未送信outboxを抑止する", () => {
  const { repo } = setup();
  for (const next of ["cancelled", "failed"] as const) {
    repo.create(next, input, due, actor, now);
    const { run } = repo.materialize(next, 1, due, later, due, actor);
    const claim = repo.claim(due)!;
    repo.setRunState(run.run_id, "materialized", next, actor, due);
    assert.equal(repo.getOutbox(claim.outbox_id, due)?.status, "cancelled");
    assert.ok((repo.auditHistory(next) as { operation: string }[]).some(x => x.operation === `outbox_run_${next}`));
    assert.throws(() => repo.requestStarted(claim.outbox_id, claim.claim_token!, due), /claim_conflict/);
    assert.equal(repo.claim("2026-09-05T00:02:00Z"), undefined);
  }
});

test("request開始後の取消で未受理が確定したrunはterminalになりretention可能", () => {
  const { repo, raw } = setup(); repo.create("s1", input, due, actor, now);
  const { run } = repo.materialize("s1", 1, due, later, due, actor);
  const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
  repo.transition("s1", 1, "cancel", actor, due);
  assert.equal(repo.finishWrite(claim.outbox_id, claim.claim_token!, "not_accepted", due).status, "cancelled");
  assert.equal(repo.getRun(run.run_id)?.status, "cancelled");
  assert.equal(repo.getRun(run.run_id)?.terminal_at, "2026-09-05T00:02:00Z");
  repo.purge("2026-10-06T00:00:00Z");
  assert.equal(count(raw, "schedule_runs"), 0); assert.equal(count(raw, "schedules"), 0);
});

test("曖昧write auditは実際のstate変更とoutbox fenceを記録する", () => {
  const { repo } = setup(); repo.create("s1", input, due, actor, now);
  repo.materialize("s1", 1, due, later, due, actor);
  const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
  repo.finishWrite(claim.outbox_id, claim.claim_token!, "ambiguous", due);
  const audit = (repo.auditHistory("s1") as { operation: string; before_json: string; after_json: string }[]).find(x => x.operation === "outbox_needs_review")!;
  assert.equal(JSON.parse(audit.before_json).state, "active");
  const after = JSON.parse(audit.after_json);
  assert.equal(after.state, "needs_review");
  assert.equal(after.outbox.outbox_id, claim.outbox_id);
  assert.equal(after.outbox.request_started_at, due);
  assert.equal(after.outbox.status, "needs_review");
});

test("grace超過の初回claimと送信開始直前の超過をterminal化し後続occurrenceを解放", () => {
  const { repo } = setup(); repo.create("late_claim", input, due, actor, now);
  const first = repo.materialize("late_claim", 1, due, later, due, actor).run;
  assert.equal(repo.claim("2026-09-05T00:16:01Z"), undefined);
  assert.equal(repo.getRun(first.run_id)?.status, "skipped"); assert.equal(repo.getRun(first.run_id)?.reason, "misfire");
  assert.equal(repo.materialize("late_claim", 1, later, afterLater, later, actor).run.status, "materialized");

  repo.create("late_start", input, due, actor, now);
  const second = repo.materialize("late_start", 1, due, later, due, actor).run;
  const claim = repo.claim("2026-09-05T00:15:00Z", 300)!;
  assert.equal(claim.run_id, second.run_id);
  assert.throws(() => repo.requestStarted(claim.outbox_id, claim.claim_token!, "2026-09-05T00:16:01Z"), /write_not_authorized/);
  assert.equal(repo.getOutbox(claim.outbox_id, "2026-09-05T00:16:01Z")?.status, "cancelled");
  assert.equal(repo.getRun(second.run_id)?.reason, "misfire");
  assert.equal(repo.recover("2026-09-05T00:20:00Z"), 0);
});

test("旧requestのreceiptは新revisionへ更新後も旧snapshot/hashに帰属", () => {
  const { repo, raw, dispatcher } = setup(); repo.create("s1", input, due, actor, now);
  repo.materialize("s1", 1, due, later, due, actor);
  const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
  repo.transition("s1", 1, "pause", actor, due);
  repo.update("s1", 2, { ...input, authorization_id: "new_auth", authorization_revision: 3, content: "別の本文" }, later, actor, due);
  repo.finishWrite(claim.outbox_id, claim.claim_token!, "sent", due, "receipt_old");
  const audit = (repo.auditHistory("s1") as { revision: number; operation: string; after_json: string }[]).find(x => x.operation === "outbox_sent")!;
  assert.equal(audit.revision, 1);
  const after = JSON.parse(audit.after_json);
  assert.equal(after.operation_revision, 1); assert.equal(after.revision, 3);
  assert.equal(after.content_hash, claim.content_hash); assert.equal(after.outbox.receipt_id, "receipt_old");
  assert.notEqual(after.content_hash, (raw.prepare("SELECT content_hash FROM schedule_revisions WHERE revision = 3").get() as { content_hash: string }).content_hash);
  repo.create("work_audit", { ...input, action: "work.read_only" }, due, actor, now);
  const oldRun = repo.materialize("work_audit", 1, due, later, due, actor).run;
  startWork(repo, dispatcher, raw, oldRun, due);
  repo.transition("work_audit", 1, "pause", actor, due);
  repo.update("work_audit", 2, { ...input, action: "work.read_only", authorization_id: "work_auth", authorization_revision: 3, content: "新objective" }, later, actor, due);
  repo.setRunState(oldRun.run_id, "started", "failed", actor, due);
  const runAudit = (repo.auditHistory("work_audit") as { revision: number; operation: string; after_json: string }[]).find(x => x.operation === "run_failed")!;
  assert.equal(runAudit.revision, 1); assert.equal(JSON.parse(runAudit.after_json).run.run_id, oldRun.run_id);

});

test("needs_reviewの未解決fenceを再承認で迂回できずadmin reconcile後だけ更新可能", () => {
  const { repo } = setup(); repo.create("s1", input, due, actor, now);
  repo.materialize("s1", 1, due, later, due, actor);
  const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
  repo.finishWrite(claim.outbox_id, claim.claim_token!, "ambiguous", due);
  const renewed = { ...input, authorization_id: "new_auth", authorization_revision: 2 };
  assert.throws(() => repo.update("s1", 1, renewed, later, actor, due), /reconcile_required/);
  assert.throws(() => repo.reconcile(claim.outbox_id, "failed", "proof", actor, due), /admin_required/);
  assert.throws(() => repo.reconcile(claim.outbox_id, "failed", "proof", { ...actor, role: "admin", tenant_id: "T_OTHER" }, due), /unauthorized/);
  const result = repo.reconcile(claim.outbox_id, "failed", "proof", { ...actor, role: "admin" }, due);
  assert.ok(!("content" in result)); assert.ok(!("target_json" in result)); assert.equal(repo.get("s1")?.state, "needs_review");
  repo.update("s1", 1, renewed, later, actor, due);
  assert.equal(repo.materialize("s1", 2, later, afterLater, later, actor).run.status, "materialized");
});

test("公開run遷移はreminderのstartedとcompletedを拒否しoutboxを保持", () => {
  const { repo, raw } = setup(); repo.create("reminder", input, due, actor, now);
  const run = repo.materialize("reminder", 1, due, later, due, actor).run;
  assert.throws(() => repo.setRunState(run.run_id, "materialized", "started", actor, due), /invalid_transition/);
  assert.throws(() => repo.setRunState(run.run_id, "materialized", "started", actor, "2026-09-05T00:16:01Z"), /invalid_transition/);
  assert.throws(() => repo.setRunState(run.run_id, "materialized", "completed", actor, due), /invalid_transition/);
  assert.equal(repo.getRun(run.run_id)?.status, "materialized");
  assert.equal((raw.prepare("SELECT status FROM connector_outbox WHERE run_id = ?").get(run.run_id) as { status: string }).status, "pending");
});

test("admin reconcileはdrained one-shotだけを監査後completedへ進めquotaとpurgeを解放", () => {
  const { dispatcher, raw } = setup();
  const once = { ...input, recurrence_json: `{"at":"${due}","kind":"once","version":1}\n`, timezone: null, tzdb_version: null };
  const repo = dispatcher.scheduler.withCodecs({ recurrence: text => text, policy: text => text });
  for (const outcome of ["sent", "failed"] as const) {
    const name = `once_${outcome}`; repo.create(name, once, due, actor, now); repo.materialize(name, 1, due, null, due, actor);
    const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
    repo.finishWrite(claim.outbox_id, claim.claim_token!, "ambiguous", due);
    repo.reconcile(claim.outbox_id, outcome, `receipt_${outcome}`, { ...actor, role: "admin" }, due);
    assert.equal(repo.get(name)?.state, "completed"); assert.equal(repo.get(name)?.terminal_at, due);
    assert.deepEqual((repo.auditHistory(name) as { operation: string }[]).slice(-2).map(x => x.operation), [`reconcile_${outcome}`, "complete"]);
  }
  repo.create("recurring", input, due, actor, now); repo.materialize("recurring", 1, due, later, due, actor);
  const recurring = repo.claim(due)!; repo.requestStarted(recurring.outbox_id, recurring.claim_token!, due);
  repo.finishWrite(recurring.outbox_id, recurring.claim_token!, "ambiguous", due);
  repo.reconcile(recurring.outbox_id, "sent", "receipt_recurring", { ...actor, role: "admin" }, due);
  assert.equal(repo.get("recurring")?.state, "needs_review");
  for (let i = 0; i < 19; i++) repo.create(`quota_reconcile_${i}`, once, due, actor, now);
  repo.purge("2026-10-06T00:00:00Z");
  assert.equal(repo.get("once_sent"), undefined); assert.equal(repo.get("once_failed"), undefined);
  assert.equal((raw.prepare("SELECT count(*) AS n FROM schedules WHERE schedule_id LIKE 'quota_reconcile_%'").get() as { n: number }).n, 19);
});

test("one-shotは最後のrun/outbox決着後に完了しquotaとretentionを解放", () => {
  const { dispatcher, raw } = setup();
  const once = { ...input, recurrence_json: `{"at":"${due}","kind":"once","version":1}\n`, timezone: null, tzdb_version: null };
  const repo = dispatcher.scheduler.withCodecs({ recurrence: text => { assert.equal(text, once.recurrence_json); return text; }, policy: text => text });
  repo.create("once", once, due, actor, now);
  repo.materialize("once", 1, due, null, due, actor);
  assert.equal(repo.get("once")?.state, "active");
  const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
  repo.finishWrite(claim.outbox_id, claim.claim_token!, "sent", due, "receipt");
  assert.equal(repo.get("once")?.state, "completed"); assert.equal(repo.get("once")?.terminal_at, due);
  for (let i = 0; i < 20; i++) repo.create(`quota_${i}`, once, due, actor, now);
  repo.purge("2026-10-06T00:00:00Z");
  assert.equal(repo.get("once"), undefined); assert.equal(count(raw, "schedules"), 20);
});

test("未送信one-shotのpauseは原子的にdrainしてcompletedとなりresumeできない", () => {
  const { dispatcher } = setup();
  const once = { ...input, recurrence_json: `{"at":"${due}","kind":"once","version":1}\n`, timezone: null, tzdb_version: null };
  const repo = dispatcher.scheduler.withCodecs({ recurrence: text => text, policy: text => text });
  repo.create("paused_once", once, due, actor, now); repo.materialize("paused_once", 1, due, null, due, actor);
  const result = repo.transition("paused_once", 1, "pause", actor, due);
  assert.equal(result.state, "completed"); assert.equal(result.terminal_at, due);
  assert.throws(() => repo.transition("paused_once", 2, "resume", actor, due), /invalid_transition/);
  assert.deepEqual((repo.auditHistory("paused_once") as { operation: string }[]).slice(-3).map(x => x.operation), ["outbox_cancelled", "pause", "complete"]);
});

test("recurring materializeは将来next_dueを必須にしてNULLを拒否", () => {
  const { repo, raw } = setup(); repo.create("recurring_null", input, due, actor, now);
  assert.throws(() => repo.materialize("recurring_null", 1, due, null, due, actor), /invalid_next_due/);
  assert.equal(count(raw, "schedule_runs"), 0); assert.equal(repo.get("recurring_null")?.next_due, due);
});

test("時計後退中のwork完了もrun・outbox・one-shot scheduleの終端時刻を開始前へ戻さない", () => {
  const { dispatcher, raw } = setup();
  const once = { ...input, action: "work.read_only" as const, recurrence_json: `{"at":"${due}","kind":"once","version":1}\n`, timezone: null, tzdb_version: null };
  const repo = dispatcher.scheduler.withCodecs({ recurrence: text => text, policy: text => text });
  repo.create("clock_work", once, due, actor, now); const run = repo.materialize("clock_work", 1, due, null, due, actor).run;
  startWork(repo, dispatcher, raw, run, due);
  repo.setRunState(run.run_id, "started", "completed", actor, "2026-09-05T00:00:30Z", null, "結果");
  const completed = repo.getRun(run.run_id)!; assert.equal(completed.terminal_at, due); assert.equal(completed.started_at, due);
  const outbox = repo.claim(due)!; assert.equal(outbox.created_at, due);
  repo.requestStarted(outbox.outbox_id, outbox.claim_token!, due); repo.finishWrite(outbox.outbox_id, outbox.claim_token!, "sent", due, "receipt");
  assert.equal(repo.get("clock_work")?.terminal_at, due);
});

test("one-shot workの結果通知と通知なし、graceでskipしたone-shotを完了可能", () => {
  const { dispatcher, raw } = setup();
  const once = { ...input, recurrence_json: `{"at":"${due}","kind":"once","version":1}\n`, timezone: null, tzdb_version: null };
  const repo = dispatcher.scheduler.withCodecs({ recurrence: text => text, policy: text => text });
  repo.create("silent", { ...once, action: "work.read_only", target: { kind: "none" } }, due, actor, now);
  const run = repo.materialize("silent", 1, due, null, due, actor).run;
  startWork(repo, dispatcher, raw, run, due);
  repo.setRunState(run.run_id, "started", "completed", actor, due);
  assert.equal(repo.get("silent")?.state, "completed");
  repo.create("result", { ...once, action: "work.read_only" }, due, actor, now);
  const notified = repo.materialize("result", 1, due, null, due, actor).run;
  startWork(repo, dispatcher, raw, notified, due);
  repo.setRunState(notified.run_id, "started", "completed", actor, due, null, "結果");
  assert.equal(repo.get("result")?.state, "active");
  const delayedResult = repo.claim("2026-09-05T00:16:01Z");
  assert.equal(delayedResult, undefined);
  assert.equal(repo.getRun(notified.run_id)?.status, "completed"); assert.equal(repo.get("result")?.state, "completed");
  repo.create("skipped", once, due, actor, now);
  repo.materialize("skipped", 1, due, null, "2026-09-05T00:16:01Z", actor);
  assert.equal(repo.get("skipped")?.state, "completed");
});

test("workの開始拒否を永続化し後続occurrenceを塞がない", () => {
  const { repo } = setup(); repo.create("work_late", { ...input, action: "work.read_only" }, due, actor, now);
  const run = repo.materialize("work_late", 1, due, later, due, actor).run;
  assert.throws(() => repo.setRunState(run.run_id, "materialized", "started", actor, "2026-09-05T00:16:01Z"), /run_not_authorized/);
  assert.equal(repo.getRun(run.run_id)?.status, "skipped"); assert.equal(repo.getRun(run.run_id)?.reason, "misfire");
  assert.equal(repo.materialize("work_late", 1, later, afterLater, later, actor).run.status, "materialized");
  repo.create("work_expired", { ...input, action: "work.read_only", expires_at: "2026-09-05T00:01:30Z" }, due, actor, now);
  const expired = repo.materialize("work_expired", 1, due, later, due, actor).run;
  assert.throws(() => repo.setRunState(expired.run_id, "materialized", "started", actor, "2026-09-05T00:01:30Z"), /run_not_authorized/);
  assert.equal(repo.getRun(expired.run_id)?.status, "cancelled"); assert.equal(repo.getRun(expired.run_id)?.reason, "authorization_expired");
  assert.equal(repo.get("work_expired")?.state, "expired");
});

test("物化前のauthorization失効はscheduleをexpiredへ移しdue scanから除く", () => {
  const { repo, raw } = setup(); repo.create("expired", { ...input, expires_at: due }, due, actor, now);
  raw.exec("CREATE TRIGGER fail_expire BEFORE INSERT ON schedule_audit WHEN NEW.operation = 'expire' BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => repo.materialize("expired", 1, due, later, due, actor), /injected/);
  assert.equal(repo.get("expired")?.state, "active");
  raw.exec("DROP TRIGGER fail_expire");
  assert.throws(() => repo.materialize("expired", 1, due, later, due, actor), /authorization_expired/);
  assert.equal(repo.get("expired")?.state, "expired"); assert.equal(repo.due(later).length, 0);
  assert.equal(count(raw, "schedule_runs"), 0);
  const audit = (repo.auditHistory("expired") as { operation: string; after_json: string }[]).find(x => x.operation === "expire")!;
  assert.equal(JSON.parse(audit.after_json).state, "expired");
  repo.update("expired", 1, { ...input, authorization_id: "renewed", authorization_revision: 2 }, later, actor, due);
  assert.equal(repo.get("expired")?.state, "active");
});

test("run取消・失敗後の未受理requestをpendingへ戻さない", () => {
  const { repo } = setup();
  for (const status of ["cancelled", "failed"] as const) {
    repo.create(status, input, due, actor, now);
    const run = repo.materialize(status, 1, due, later, due, actor).run;
    const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
    repo.setRunState(run.run_id, "materialized", status, actor, due);
    assert.equal(repo.finishWrite(claim.outbox_id, claim.claim_token!, "not_accepted", due).status, "cancelled");
    assert.equal(repo.getRun(run.run_id)?.status, status);
    assert.equal(repo.materialize(status, 1, later, afterLater, later, actor).run.status, "materialized");
  }
});

test("送信結果auditはrun更新後の終端statusを保持する", () => {
  const { repo } = setup(); repo.create("sent", input, due, actor, now);
  const run = repo.materialize("sent", 1, due, later, due, actor).run;
  const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
  repo.finishWrite(claim.outbox_id, claim.claim_token!, "sent", due, "receipt");
  const audit = (repo.auditHistory("sent") as { operation: string; after_json: string }[]).find(x => x.operation === "outbox_sent")!;
  assert.equal(JSON.parse(audit.after_json).run.status, "completed");
  assert.equal(JSON.parse(audit.after_json).run.run_id, run.run_id);
  repo.create("failure", input, due, actor, now); repo.materialize("failure", 1, due, later, due, actor);
  for (const timestamp of [due, "2026-09-05T00:01:01Z", "2026-09-05T00:01:06Z"]) {
    const attempt = repo.claim(timestamp)!; repo.requestStarted(attempt.outbox_id, attempt.claim_token!, timestamp);
    repo.finishWrite(attempt.outbox_id, attempt.claim_token!, "not_accepted", timestamp);
  }
  const last = (repo.auditHistory("failure") as { operation: string; after_json: string }[]).filter(x => x.operation === "outbox_not_accepted").at(-1)!;
  assert.equal(JSON.parse(last.after_json).run.status, "failed");
});

test("claimで検出したauthorization失効もscheduleへ反映し直接再承認可能", () => {
  const { repo } = setup(); const expiry = "2026-09-05T00:02:00Z";
  repo.create("s1", { ...input, expires_at: expiry }, due, actor, now);
  const run = repo.materialize("s1", 1, due, later, due, actor).run;
  assert.equal(repo.claim(expiry), undefined);
  assert.equal(repo.get("s1")?.state, "expired"); assert.equal(repo.getRun(run.run_id)?.reason, "authorization_expired");
  repo.update("s1", 1, { ...input, authorization_id: "new_auth", authorization_revision: 2 }, later, actor, expiry);
  assert.equal(repo.get("s1")?.state, "active");
});

test("run purge後もauditへmisfire/overlapのdecision codeを保持", () => {
  const { repo } = setup(); repo.create("misfire", input, due, actor, now);
  const misfire = repo.materialize("misfire", 1, due, later, "2026-09-05T00:16:01Z", actor).run;
  repo.create("overlap", input, due, actor, now); repo.materialize("overlap", 1, due, later, due, actor);
  const overlap = repo.materialize("overlap", 1, later, afterLater, later, actor).run;
  repo.purge("2026-10-10T00:00:00Z");
  assert.equal(repo.getRun(misfire.run_id), undefined); assert.equal(repo.getRun(overlap.run_id), undefined);
  for (const [name, run] of [["misfire", misfire], ["overlap", overlap]] as const) {
    const row = (repo.auditHistory(name) as { after_json: string }[]).map(x => JSON.parse(x.after_json)).find(x => x.run?.run_id === run.run_id)!;
    assert.equal(row.run.reason, name);
  }
});

test("長期利用revisionのmetadataは作成日ではなく終了から30日保持", () => {
  const { repo, raw } = setup();
  repo.create("s1", { ...input, expires_at: "2026-10-05T00:00:00Z" }, due, actor, now);
  const replaced = "2026-10-04T00:00:00Z";
  repo.transition("s1", 1, "pause", actor, replaced);
  repo.update("s1", 2, { ...input, authorization_id: "new_auth", authorization_revision: 3, approved_at: replaced,
    expires_at: "2026-11-03T00:00:00Z" }, "2026-10-05T00:01:00Z", actor, replaced);
  repo.purge("2026-10-11T00:00:00Z");
  const old = raw.prepare("SELECT content, terminal_at FROM schedule_revisions WHERE schedule_id = 's1' AND revision = 1").get() as { content: string | null; terminal_at: string };
  assert.equal(old.content, null); assert.equal(old.terminal_at, replaced);
  repo.purge("2026-11-02T23:59:59Z");
  assert.ok(raw.prepare("SELECT 1 FROM schedule_revisions WHERE schedule_id = 's1' AND revision = 1").get());
  repo.purge("2026-11-03T00:00:00Z");
  assert.equal(raw.prepare("SELECT 1 FROM schedule_revisions WHERE schedule_id = 's1' AND revision = 1").get(), undefined);
});

test("retire済みrevisionは時計後退でもterminalと削除期限を巻き戻さない", () => {
  const { repo, raw } = setup();
  repo.create("clock", input, due, actor, now);
  repo.transition("clock", 1, "pause", actor, "2026-09-05T00:00:30Z");
  const before = raw.prepare("SELECT terminal_at, content_delete_at FROM schedule_revisions WHERE schedule_id = 'clock' AND revision = 1").get();
  repo.update("clock", 2, { ...input, authorization_id: "clock_new", authorization_revision: 3 }, later, actor, "2026-09-05T00:00:10Z");
  const after = raw.prepare("SELECT terminal_at, content_delete_at FROM schedule_revisions WHERE schedule_id = 'clock' AND revision = 1").get();
  assert.deepEqual(after, before);
  const current = raw.prepare("SELECT created_at, terminal_at FROM schedule_revisions WHERE schedule_id = 'clock' AND revision = 2").get() as { created_at: string; terminal_at: string };
  assert.equal(current.terminal_at, current.created_at);
});

test("receiptの任意位置に埋め込まれたSlack tokenを保存前に拒否", () => {
  const { repo, raw } = setup(); repo.create("secret_receipt", input, due, actor, now); repo.materialize("secret_receipt", 1, due, later, due, actor);
  const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
  for (const receipt of ["proof:xoxb-secret", "prefix_xapp-secret"]) {
    assert.throws(() => repo.finishWrite(claim.outbox_id, claim.claim_token!, "sent", due, receipt), /invalid_receipt/);
    assert.throws(() => repo.reconcile(claim.outbox_id, "failed", receipt, { ...actor, role: "admin" }, due), /invalid_receipt/);
  }
  assert.equal((raw.prepare("SELECT receipt_id FROM connector_outbox WHERE outbox_id = ?").get(claim.outbox_id) as { receipt_id: string | null }).receipt_id, null);
});

test("authorization IDに埋め込まれたSlack tokenを保存前に拒否", () => {
  const { repo, raw } = setup();
  for (const authorization_id of ["xoxb-secret", "proof:xapp-secret"]) {
    assert.throws(() => repo.create(`secret_${authorization_id.length}`, { ...input, authorization_id }, due, actor, now), /invalid_authorization/);
  }
  assert.equal(count(raw, "schedules"), 0); assert.ok(!JSON.stringify(repo.redactedBackup()).includes("xox"));
});

test("needs_reviewのrevision本文/objectiveも7日で消去しfenceを保持", () => {
  const { repo, raw, dispatcher } = setup();
  for (const action of ["slack.reminder.post", "work.read_only"] as const) {
    const name = action === "work.read_only" ? "work" : "reminder";
    repo.create(name, { ...input, action }, due, actor, now);
    const run = repo.materialize(name, 1, due, later, due, actor).run;
    if (action === "work.read_only") {
      startWork(repo, dispatcher, raw, run, due);
      repo.setRunState(run.run_id, "started", "completed", actor, due, null, "結果");
    }
    const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
    repo.finishWrite(claim.outbox_id, claim.claim_token!, "ambiguous", due);
  }
  repo.purge("2026-09-12T00:01:00Z");
  assert.equal((raw.prepare("SELECT count(*) AS n FROM schedule_revisions WHERE content IS NOT NULL").get() as { n: number }).n, 0);
  assert.equal((raw.prepare("SELECT count(*) AS n FROM connector_outbox WHERE status = 'needs_review' AND request_started_at IS NOT NULL").get() as { n: number }).n, 2);
  assert.equal(count(raw, "schedule_runs"), 2);
});

test("dona_scheduleは#11 routingへ流しlegacy scheduler eventだけを除外する", () => {
  const { repo, dispatcher, raw } = setup(); repo.create("work", { ...input, action: "work.read_only" }, due, actor, now);
  const run = repo.materialize("work", 1, due, later, due, actor).run;
  assert.equal(dispatcher.get(run.event_id!)?.status, "queued");
  assert.equal(dispatcher.nextAvailable(new Date(due))?.event_id, run.event_id);
  raw.prepare("UPDATE events SET status='completed' WHERE event_id=?").run(run.event_id);
  const slack = dispatcher.enqueue(eventEnvelope("slack-after-scheduler"), new Date(due)).row;
  assert.equal(dispatcher.nextAvailable(new Date(due))?.event_id, slack.event_id);
  assert.equal(envelopeFromRow(dispatcher.nextAvailable(new Date(due))!).source, "slack");
  raw.prepare("INSERT INTO events(event_id,schema_version,source,external_event_id,event_type,occurred_at,subject_json,payload_json,status,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("evt_legacy_scheduler", 1, "scheduler", "legacy", "schedule_due", due, "{}", "{}", "queued", due, due, due);
  raw.prepare("UPDATE events SET sequence = 0 WHERE event_id = 'evt_legacy_scheduler'").run();
  assert.equal(dispatcher.nextAvailable(new Date(due))?.event_id, slack.event_id);
});

test("purgeはcurrent authorization失効とauditを原子的に反映する", () => {
  const { repo, raw } = setup();
  for (const id of ["active", "paused"]) {
    repo.create(id, { ...input, expires_at: due }, due, actor, now);
    if (id === "paused") repo.transition(id, 1, "pause", actor, now);
  }
  raw.exec("CREATE TRIGGER fail_purge BEFORE INSERT ON schedule_audit WHEN NEW.operation = 'expire' BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => repo.purge(due), /injected/);
  assert.equal(repo.get("active")?.state, "active"); assert.equal(repo.get("paused")?.state, "paused");
  raw.exec("DROP TRIGGER fail_purge"); repo.purge(due); repo.purge(due);
  for (const id of ["active", "paused"]) {
    assert.equal(repo.get(id)?.state, "expired");
    assert.equal((repo.auditHistory(id) as { operation: string }[]).filter(x => x.operation === "expire").length, 1);
  }
});

test("runのないcurrent expired revisionも30日後にscheduleと共にpurge", () => {
  const { repo, raw } = setup();
  repo.create("expired_empty", { ...input, expires_at: due }, due, actor, now);
  repo.purge(due);
  assert.equal(repo.get("expired_empty")?.state, "expired"); assert.equal(repo.get("expired_empty")?.terminal_at, due);
  repo.purge("2026-10-04T00:00:59Z");
  assert.ok(repo.get("expired_empty")); assert.ok(raw.prepare("SELECT 1 FROM schedule_revisions WHERE schedule_id = 'expired_empty'").get());
  repo.purge("2026-10-05T00:01:00Z");
  assert.equal(repo.get("expired_empty"), undefined); assert.equal(raw.prepare("SELECT 1 FROM schedule_revisions WHERE schedule_id = 'expired_empty'").get(), undefined);
});

test("purge起点の失効もdrained one-shotをcompletedへ進めquotaを即時解放", () => {
  const { dispatcher } = setup();
  const once = { ...input, recurrence_json: `{"at":"${due}","kind":"once","version":1}\n`, timezone: null, tzdb_version: null, expires_at: "2026-09-05T00:02:00Z" };
  const repo = dispatcher.scheduler.withCodecs({ recurrence: text => text, policy: text => text });
  repo.create("purge_once", once, due, actor, now); repo.materialize("purge_once", 1, due, null, due, actor);
  repo.purge(once.expires_at);
  assert.equal(repo.get("purge_once")?.state, "completed"); assert.equal(repo.get("purge_once")?.terminal_at, once.expires_at);
  assert.deepEqual((repo.auditHistory("purge_once") as { operation: string }[]).slice(-2).map(x => x.operation), ["expire", "complete"]);
  for (let i = 0; i < 20; i++) repo.create(`purge_quota_${i}`, once, due, actor, now);
});

test("送信応答時の失効をreceiptと共に保持し再承認可能にする", () => {
  const { repo } = setup(); const expiry = "2026-09-05T00:02:00Z";
  repo.create("s1", { ...input, expires_at: expiry }, due, actor, now);
  const run = repo.materialize("s1", 1, due, later, due, actor).run;
  const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
  assert.equal(repo.finishWrite(claim.outbox_id, claim.claim_token!, "sent", expiry, "receipt").status, "sent");
  assert.equal(repo.getRun(run.run_id)?.status, "completed"); assert.equal(repo.get("s1")?.state, "expired");
  repo.update("s1", 1, { ...input, authorization_id: "renewed", authorization_revision: 2 }, later, actor, expiry);
  assert.equal(repo.get("s1")?.state, "active");
});

test("時計後退中のfinishWriteとreconcileも保存済み時刻より前へ終端しない", () => {
  const { repo } = setup();
  for (const mode of ["finish", "reconcile"] as const) {
    repo.create(mode, input, due, actor, now); const run = repo.materialize(mode, 1, due, later, due, actor).run;
    const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
    if (mode === "finish") repo.finishWrite(claim.outbox_id, claim.claim_token!, "sent", "2026-09-05T00:00:30Z", "receipt_finish");
    else {
      repo.finishWrite(claim.outbox_id, claim.claim_token!, "ambiguous", due);
      repo.reconcile(claim.outbox_id, "sent", "receipt_reconcile", { ...actor, role: "admin" }, "2026-09-05T00:00:30Z");
    }
    assert.equal(repo.getRun(run.run_id)?.terminal_at, due);
    assert.equal(repo.getOutbox(claim.outbox_id, due)?.terminal_at, due);
  }
});

test("reconcileは後続schedule遷移時刻より前へ終端を戻さない", () => {
  const { repo } = setup();
  repo.create("reconcile_clock", input, due, actor, now);
  const run = repo.materialize("reconcile_clock", 1, due, later, due, actor).run;
  const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
  repo.finishWrite(claim.outbox_id, claim.claim_token!, "ambiguous", due);
  const cancelledAt = "2026-09-05T00:02:00Z";
  repo.transition("reconcile_clock", 1, "cancel", actor, cancelledAt);
  repo.reconcile(claim.outbox_id, "sent", "receipt_after_cancel", { ...actor, role: "admin" }, "2026-09-05T00:01:30Z");
  assert.equal(repo.getRun(run.run_id)?.terminal_at, cancelledAt);
  assert.equal(repo.getOutbox(claim.outbox_id, cancelledAt)?.terminal_at, cancelledAt);
});

test("recoverの曖昧化は後続schedule遷移時刻より前へ戻らない", () => {
  const { repo } = setup();
  repo.create("recover_clock", input, due, actor, now);
  repo.materialize("recover_clock", 1, due, later, due, actor);
  const claim = repo.claim(due, 1)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
  const pausedAt = "2026-09-05T00:02:00Z";
  repo.transition("recover_clock", 1, "pause", actor, pausedAt);
  repo.recover("2026-09-05T00:01:01Z");
  const recovered = repo.getOutbox(claim.outbox_id, pausedAt)!;
  assert.equal(recovered.updated_at, pausedAt);
  assert.equal(recovered.content_delete_at, "2026-09-12T00:02:00Z");
  assert.equal((repo.auditHistory("recover_clock") as { operation: string; created_at: string }[])
    .find(row => row.operation === "outbox_needs_review")?.created_at, pausedAt);
});

test("materializeは保存済みschedule時刻以上でrunとauditを作成する", () => {
  const { repo } = setup();
  repo.create("materialize_clock", input, due, actor, now);
  const advancedAt = "2026-09-05T00:02:00Z";
  repo.transition("materialize_clock", 1, "pause", actor, advancedAt);
  repo.transition("materialize_clock", 2, "resume", actor, "2026-09-05T00:01:30Z");
  const run = repo.materialize("materialize_clock", 3, due, later, "2026-09-05T00:01:30Z", actor).run;
  assert.equal(run.created_at, advancedAt);
  assert.equal(repo.get("materialize_clock")?.updated_at, advancedAt);
  assert.equal((repo.auditHistory("materialize_clock") as { operation: string; created_at: string }[])
    .find(row => row.operation === "materialize")?.created_at, advancedAt);
});

test("outbox送信直前の期限判定は保存済みschedule時刻を使用する", () => {
  const { repo } = setup();
  repo.create("outbox_clock", input, due, actor, now);
  const first = repo.materialize("outbox_clock", 1, due, later, due, actor).run;
  repo.materialize("outbox_clock", 1, later, afterLater, later, actor);
  assert.equal(repo.claim(due), undefined);
  assert.equal(repo.getRun(first.run_id)?.status, "skipped");
  assert.equal(repo.getRun(first.run_id)?.reason, "misfire");
});

test("時計後退中のrequestStartedはclaim時刻とaudit時刻を巻き戻さない", () => {
  const { repo, raw } = setup();
  repo.create("request_clock", input, due, actor, now);
  repo.materialize("request_clock", 1, due, later, due, actor);
  const claim = repo.claim(due)!;
  const started = repo.requestStarted(claim.outbox_id, claim.claim_token!, "2026-09-05T00:00:30Z");
  assert.equal(started.request_started_at, due);
  assert.equal(started.updated_at, due);
  assert.equal((raw.prepare("SELECT MAX(created_at) AS value FROM schedule_audit WHERE schedule_id = 'request_clock'").get() as { value: string }).value, due);
});

test("authorization失効はschedule時刻を戻さず未開始workへ専用reasonを一度だけ残す", () => {
  const { repo, raw } = setup();
  repo.create("expire_clock", { ...input, expires_at: due }, due, actor, now);
  assert.equal(repo.transition("expire_clock", 1, "pause", actor, "2026-09-05T00:02:00Z").state, "expired");
  repo.purge(due);
  assert.equal(repo.get("expire_clock")?.terminal_at, "2026-09-05T00:02:00Z");
  repo.create("cancel_expired", { ...input, expires_at: due }, due, actor, now);
  assert.equal(repo.transition("cancel_expired", 1, "cancel", actor, "2026-09-05T00:02:00Z").state, "cancelled");

  const expiry = "2026-09-05T00:02:00Z";
  repo.create("expire_work", { ...input, action: "work.read_only", expires_at: expiry }, due, actor, now);
  const run = repo.materialize("expire_work", 1, due, later, due, actor).run;
  repo.purge(expiry);
  assert.equal(repo.getRun(run.run_id)?.status, "cancelled");
  assert.equal(repo.getRun(run.run_id)?.reason, "authorization_expired");
  assert.equal((repo.auditHistory("expire_work") as { operation: string }[])
    .filter(row => row.operation === "outbox_authorization_expired").length, 0);

  repo.create("expire_reminder", { ...input, expires_at: expiry }, due, actor, now);
  repo.materialize("expire_reminder", 1, due, later, due, actor);
  assert.equal(repo.claim(expiry), undefined);
  assert.equal((repo.auditHistory("expire_reminder") as { operation: string }[])
    .filter(row => row.operation === "outbox_authorization_expired").length, 1);

  repo.create("late_expiry", { ...input, expires_at: expiry }, due, actor, now);
  repo.materialize("late_expiry", 1, due, later, due, actor);
  const lateOutbox = raw.prepare("SELECT outbox_id FROM connector_outbox JOIN schedule_runs USING(run_id) WHERE schedule_id = 'late_expiry'")
    .get() as { outbox_id: string };
  repo.purge("2026-09-20T00:00:00Z");
  assert.equal(repo.getOutbox(lateOutbox.outbox_id, "2026-09-20T00:00:00Z")?.content, null);
  assert.equal(repo.getOutbox(lateOutbox.outbox_id, "2026-09-20T00:00:00Z")?.content_delete_at, "2026-09-12T00:02:00Z");

  repo.create("started_expiry", { ...input, expires_at: expiry }, due, actor, now);
  repo.materialize("started_expiry", 1, due, later, due, actor);
  const started = repo.claim(due)!;
  repo.requestStarted(started.outbox_id, started.claim_token!, due);
  repo.purge("2026-09-20T00:00:00Z");
  const fenced = raw.prepare("SELECT status, claim_token, content, content_delete_at FROM connector_outbox WHERE outbox_id = ?")
    .get(started.outbox_id) as { status: string; claim_token: string | null; content: string | null; content_delete_at: string };
  assert.equal(fenced.status, "request_started");
  assert.equal(fenced.claim_token, started.claim_token);
  assert.equal(fenced.content, null);
  assert.equal(fenced.content_delete_at, "2026-09-12T00:02:00Z");
});

test("schedule時刻が進んだ後の時計後退では古いwork runを開始しない", () => {
  const { repo } = setup();
  repo.create("start_clock", { ...input, action: "work.read_only" }, due, actor, now);
  const first = repo.materialize("start_clock", 1, due, later, due, actor).run;
  repo.materialize("start_clock", 1, later, afterLater, later, actor);
  assert.throws(() => repo.setRunState(first.run_id, "materialized", "started", actor, due), /run_not_authorized/);
  assert.equal(repo.getRun(first.run_id)?.reason, "misfire");
});

test("outbox本文の7日保持は作成時でなく終端またはneeds_review遷移から数える", () => {
  const { repo } = setup();
  repo.create("retention_origin", { ...input, expires_at: "2026-09-30T00:00:00Z" }, due, actor, now);
  repo.materialize("retention_origin", 1, due, later, due, actor);
  const sixthDay = "2026-09-11T00:01:00Z";
  const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
  const reviewed = repo.finishWrite(claim.outbox_id, claim.claim_token!, "ambiguous", sixthDay);
  assert.equal(reviewed.content_delete_at, "2026-09-18T00:01:00Z");
  assert.equal(repo.getOutbox(claim.outbox_id, "2026-09-17T00:01:00Z")?.content, input.content);
  repo.reconcile(claim.outbox_id, "failed", "retention_proof", { ...actor, role: "admin" }, "2026-09-17T00:01:00Z");
  assert.equal(repo.getOutbox(claim.outbox_id, "2026-09-17T00:01:00Z")?.content_delete_at, "2026-09-18T00:01:00Z");
  assert.equal(repo.getOutbox(claim.outbox_id, "2026-09-19T00:01:00Z")?.content, null);
});

test("時計後退中のrun取消もoutbox終端と本文削除期限を単調化する", () => {
  const { repo, raw } = setup();
  repo.create("cancel_clock", input, due, actor, now);
  const run = repo.materialize("cancel_clock", 1, due, later, due, actor).run;
  repo.setRunState(run.run_id, "materialized", "cancelled", actor, "2026-09-05T00:00:30Z");
  assert.equal(repo.getRun(run.run_id)?.reason, "cancelled");
  assert.equal(repo.claim(due), undefined);
  const stored = raw.prepare("SELECT terminal_at, content_delete_at FROM connector_outbox WHERE run_id = ?")
    .get(run.run_id) as { terminal_at: string; content_delete_at: string };
  assert.equal(stored.terminal_at, due);
  assert.equal(stored.content_delete_at, "2026-09-12T00:01:00Z");
});

test("claimed outboxのrun取消はclaim時刻より前へ終端を戻さない", () => {
  const { repo, raw } = setup();
  repo.create("claimed_cancel", input, due, actor, now);
  const run = repo.materialize("claimed_cancel", 1, due, later, due, actor).run;
  repo.claim(due);
  repo.setRunState(run.run_id, "materialized", "cancelled", actor, "2026-09-05T00:00:30Z");
  const stored = raw.prepare("SELECT terminal_at, content_delete_at FROM connector_outbox WHERE run_id = ?")
    .get(run.run_id) as { terminal_at: string; content_delete_at: string };
  assert.equal(stored.terminal_at, "2026-09-05T00:02:00Z");
  assert.equal(stored.content_delete_at, "2026-09-12T00:02:00Z");
});

test("schedule遷移はclaimed outboxのlease時刻より前へ戻らない", () => {
  const { repo, raw } = setup();
  repo.create("transition_claimed", input, due, actor, now);
  repo.materialize("transition_claimed", 1, due, later, due, actor);
  repo.claim(due);
  const paused = repo.transition("transition_claimed", 1, "pause", actor, "2026-09-05T00:00:30Z");
  assert.equal(paused.updated_at, "2026-09-05T00:02:00Z");
  const outbox = raw.prepare("SELECT o.terminal_at, o.content_delete_at FROM connector_outbox o JOIN schedule_runs r USING(run_id) WHERE r.schedule_id = 'transition_claimed'")
    .get() as { terminal_at: string; content_delete_at: string };
  assert.equal(outbox.terminal_at, "2026-09-05T00:02:00Z");
  assert.equal(outbox.content_delete_at, "2026-09-12T00:02:00Z");
});

test("work結果通知の曖昧性とreconcileは完了済みrunを上書きしない", () => {
  const { repo, dispatcher, raw } = setup();
  repo.create("work_ambiguous", { ...input, action: "work.read_only" }, due, actor, now);
  const run = repo.materialize("work_ambiguous", 1, due, later, due, actor).run;
  startWork(repo, dispatcher, raw, run, due);
  repo.setRunState(run.run_id, "started", "completed", actor, due, null, "結果");
  const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
  repo.finishWrite(claim.outbox_id, claim.claim_token!, "ambiguous", due);
  assert.equal(repo.getRun(run.run_id)?.status, "completed");
  repo.reconcile(claim.outbox_id, "failed", "not_accepted", { ...actor, role: "admin" }, due);
  assert.equal(repo.getRun(run.run_id)?.status, "completed");
});

test("通知先があるworkの結果欠落は完了transactionを拒否する", () => {
  const { repo, raw, dispatcher } = setup();
  repo.create("work", { ...input, action: "work.read_only" }, due, actor, now);
  const run = repo.materialize("work", 1, due, later, due, actor).run;
  startWork(repo, dispatcher, raw, run, due);
  const auditCount = count(raw, "schedule_audit");
  assert.throws(() => repo.setRunState(run.run_id, "started", "completed", actor, due), /result_content_required/);
  assert.equal(repo.getRun(run.run_id)?.status, "started"); assert.equal(count(raw, "schedule_audit"), auditCount);
  assert.equal(count(raw, "connector_outbox"), 0);
  repo.setRunState(run.run_id, "started", "completed", actor, due, null, "完了結果");
  assert.equal(count(raw, "connector_outbox"), 1);
});

test("長いwork結果は1999 code pointsとellipsisへ短縮してrun完了を保持する", () => {
  const { repo, raw, dispatcher } = setup();
  repo.create("long_result", { ...input, action: "work.read_only" }, due, actor, now);
  const run = repo.materialize("long_result", 1, due, later, due, actor).run;
  startWork(repo, dispatcher, raw, run, due);
  repo.setRunState(run.run_id, "started", "completed", actor, due, null, "あ".repeat(2001));
  const stored = raw.prepare("SELECT content FROM connector_outbox WHERE run_id = ?").get(run.run_id) as { content: string };
  assert.equal([...stored.content].length, 2000);
  assert.ok(stored.content.endsWith("…"));
  assert.equal(repo.getRun(run.run_id)?.status, "completed");
});

test("時計後退後の再承認は時刻を戻さずnext_dueがhigh-watermarkを越える必要がある", () => {
  const { repo, raw } = setup(); repo.create("s1", input, due, actor, now);
  repo.materialize("s1", 1, due, later, due, actor); repo.transition("s1", 1, "pause", actor, due);
  const renewed = { ...input, authorization_id: "renewed", authorization_revision: 3 };
  assert.throws(() => repo.update("s1", 2, { ...renewed, expires_at: "2026-09-05T00:00:45Z" }, later, actor, now), /invalid_authorization/);
  assert.throws(() => repo.update("s1", 2, renewed, "2026-09-05T00:00:45Z", actor, now), /invalid_transition/);
  assert.throws(() => repo.update("s1", 2, renewed, due, actor, now), /invalid_transition/);
  assert.equal(repo.get("s1")?.revision, 2);
  repo.update("s1", 2, renewed, later, actor, now);
  assert.equal(repo.get("s1")?.next_due, later);
  assert.equal(repo.get("s1")?.updated_at, due);
  assert.equal((raw.prepare("SELECT created_at FROM schedule_revisions WHERE schedule_id = 's1' AND revision = 3").get() as { created_at: string }).created_at, due);
  assert.equal(repo.transition("s1", 3, "cancel", actor, now).terminal_at, due);
});

test("時計後退中のone-shot決着はschedule更新時刻より前へ完了時刻を戻さない", () => {
  const { dispatcher } = setup();
  const repo = dispatcher.scheduler.withCodecs({ recurrence: text => text, policy: text => text });
  const once = { ...input, recurrence_json: `{"at":"${due}","kind":"once","version":1}\n`, timezone: null, tzdb_version: null };
  repo.create("once_clock", once, due, actor, now);
  repo.materialize("once_clock", 1, due, null, due, actor);
  const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
  const pausedAt = "2026-09-05T00:02:00Z";
  repo.transition("once_clock", 1, "pause", actor, pausedAt);
  repo.finishWrite(claim.outbox_id, claim.claim_token!, "sent", "2026-09-05T00:00:30Z", "receipt_once_clock");
  assert.equal(repo.get("once_clock")?.state, "completed");
  assert.equal(repo.get("once_clock")?.terminal_at, pausedAt);
});

test("cancel時刻を単調化しcaller skip不一致とSlack credential本文を保存前に拒否", () => {
  const { repo, raw } = setup(); repo.create("clock_cancel", input, due, actor, now);
  const cancelled = repo.transition("clock_cancel", 1, "cancel", actor, "2025-09-05T00:00:00Z");
  assert.equal(cancelled.terminal_at, now); assert.equal(cancelled.updated_at, now);
  repo.create("bad_skip", input, due, actor, now);
  assert.throws(() => repo.materialize("bad_skip", 1, due, later, due, actor, "misfire"), /invalid_skip_reason/);
  assert.throws(() => repo.create("xapp_body", { ...input, content: "prefix xapp-secret" }, due, actor, now), /content_requires_redaction/);
  assert.throws(() => repo.create("webhook_body", { ...input, content: "https://hooks.slack.com/services/T/B/secret" }, due, actor, now), /content_requires_redaction/);
  for (const [index, token] of ["xoxe-secret", "xoxc-secret", "xoxd-secret"].entries()) {
    assert.throws(() => repo.create(`token_prefix_${index}`, { ...input, content: token }, due, actor, now), /content_requires_redaction/);
  }
  for (const [index, token] of ["ghp_1234567890abcdef", "github_pat_1234567890abcdef", "sk-proj-1234567890abcdef"].entries()) {
    assert.throws(() => repo.create(`external_token_${index}`, { ...input, content: token }, due, actor, now), /content_requires_redaction/);
  }
  for (const [index, content] of ["<!channel> 全体通知", "<!here> 通知", "<@U123> 個別通知", "<!subteam^S12345> グループ通知"].entries()) {
    assert.throws(() => repo.create(`mention_${index}`, { ...input, content }, due, actor, now), /content_requires_redaction/);
  }
  assert.throws(() => repo.create("target_token", { ...input,
    target: { kind: "thread", workspace_id: "T_TEST", channel_id: "xoxb-secret", thread_ts: "1.000001" } }, due, actor, now), /invalid_target/);
  assert.equal((raw.prepare("SELECT count(*) AS n FROM schedule_runs WHERE schedule_id = 'bad_skip'").get() as { n: number }).n, 0);
});

test("開始済みworkは失効・pause・再承認後も完了し通知だけを抑止", () => {
  const { repo, raw, dispatcher } = setup(); const expiry = "2026-09-05T00:02:00Z";
  for (const mode of ["expiry", "pause", "replace", "cancel"] as const) {
    repo.create(mode, { ...input, action: "work.read_only", expires_at: expiry }, due, actor, now);
    const run = repo.materialize(mode, 1, due, later, due, actor).run;
    startWork(repo, dispatcher, raw, run, due);
    if (mode === "pause") repo.transition(mode, 1, "pause", actor, "2026-09-05T00:01:30Z");
    if (mode === "replace") repo.transition(mode, 1, "pause", actor, due);
    if (mode === "cancel") repo.transition(mode, 1, "cancel", actor, due);
    if (mode === "replace") repo.update(mode, 2, { ...input, action: "work.read_only", authorization_id: "renewed", authorization_revision: 3 }, later, actor, due);
    repo.setRunState(run.run_id, "started", "completed", actor, mode === "expiry" ? expiry : mode === "pause" ? "2026-09-05T00:00:30Z" : due,
      null, mode === "pause" ? "https://hooks.slack.com/services/T/B/secret" : "結果");
    assert.equal(repo.getRun(run.run_id)?.status, "completed");
    assert.ok((repo.auditHistory(mode) as { operation: string }[]).some(x => x.operation.startsWith("work_result_suppressed_")));
    if (mode === "expiry") assert.ok((repo.auditHistory(mode) as { operation: string }[])
      .some(x => x.operation === "work_result_suppressed_authorization_expired"));
    if (mode === "pause") assert.equal((repo.auditHistory(mode) as { operation: string; created_at: string }[])
      .find(x => x.operation === "work_result_suppressed_cancelled")?.created_at, "2026-09-05T00:01:30Z");
    if (mode === "expiry") repo.update(mode, 1, { ...input, action: "work.read_only", authorization_id: "renewed", authorization_revision: 2 }, later, actor, expiry);
    if (mode === "replace" || mode === "expiry") assert.equal(repo.materialize(mode, mode === "replace" ? 3 : 2, later, afterLater, later, actor).run.status, "materialized");
  }
  assert.equal(count(raw, "connector_outbox"), 0);
});

test("期限を跨いだ配送済みone-shotはpurge順序によらずcompletedになる", () => {
  const { dispatcher } = setup(); const expiry = "2026-09-05T00:02:00Z";
  const repo = dispatcher.scheduler.withCodecs({ recurrence: x => x, policy: x => x });
  const once = { ...input, recurrence_json: `{"at":"${due}","kind":"once","version":1}\n`, timezone: null, tzdb_version: null, expires_at: expiry };
  for (const mode of ["direct", "purged"]) {
    repo.create(mode, once, due, actor, now); repo.materialize(mode, 1, due, null, due, actor);
    const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
    if (mode === "purged") repo.purge(expiry);
    assert.equal(repo.finishWrite(claim.outbox_id, claim.claim_token!, "sent", expiry, "receipt").status, "sent");
    assert.equal(repo.get(mode)?.state, "completed"); assert.equal(repo.get(mode)?.terminal_at, expiry);
  }
});

test("revision purge後もauditの固定actionを確認できる", () => {
  const { repo, raw } = setup();
  for (const action of ["work.read_only", "slack.reminder.post"] as const) {
    const name = action === "work.read_only" ? "work" : "reminder";
    repo.create(name, { ...input, action }, due, actor, now); repo.transition(name, 1, "cancel", actor, due);
    repo.purge("2026-10-06T00:00:00Z");
    assert.equal(raw.prepare("SELECT 1 FROM schedule_revisions WHERE schedule_id = ?").get(name), undefined);
    assert.ok((repo.auditHistory(name) as { after_json: string }[]).every(x => JSON.parse(x.after_json).action === action));
    assert.ok(repo.auditHistory(name).length > 0);
  }
});

test("redacted backupはclaimed/request_startedの書込みcapabilityを含まない", () => {
  const { repo } = setup(); repo.create("s1", input, due, actor, now); repo.materialize("s1", 1, due, later, due, actor);
  const claim = repo.claim(due)!;
  for (const started of [false, true]) {
    if (started) repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
    const backup = JSON.stringify(repo.redactedBackup());
    assert.ok(!backup.includes("claim_token")); assert.ok(!backup.includes(claim.claim_token!));
    assert.ok(!backup.includes("claim_owner"));
    assert.ok(backup.includes(claim.outbox_id)); assert.ok(backup.includes("lease_until")); assert.ok(backup.includes("request_started_at"));
  }
});

test("長期停止のcompact skipと直近occurrence物化はatomicかつidempotent", () => {
  const { repo, raw } = setup(); repo.create("s1", input, due, actor, now);
  const selected = "2026-09-09T00:01:00Z", wake = "2026-09-09T00:06:00Z", next = "2026-09-10T00:01:00Z";
  const skipped = { from: due, through: "2026-09-08T00:01:00Z", count: 4 };
  assert.throws(() => repo.materialize("s1", 1, selected, next, wake, actor), /compact_skip_required/);
  assert.throws(() => repo.materialize("s1", 1, selected, next, wake, actor, null, { ...skipped, through: selected }), /invalid_compact_skip/);
  raw.exec("CREATE TRIGGER fail_compact BEFORE INSERT ON schedule_audit WHEN NEW.operation = 'materialize' BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => repo.materialize("s1", 1, selected, next, wake, actor, null, skipped), /injected/);
  assert.equal(count(raw, "schedule_runs"), 0); assert.equal(count(raw, "connector_outbox"), 0); assert.equal(repo.get("s1")?.next_due, due);
  raw.exec("DROP TRIGGER fail_compact");
  const result = repo.materialize("s1", 1, selected, next, wake, actor, null, skipped);
  assert.equal(result.run.status, "materialized"); assert.equal(repo.get("s1")?.high_watermark, selected);
  assert.equal(repo.materialize("s1", 1, selected, next, wake, actor, null, skipped).duplicate, true);
  assert.equal(count(raw, "schedule_runs"), 1); assert.equal(count(raw, "connector_outbox"), 1);
  const audit = (repo.auditHistory("s1") as { operation: string; after_json: string }[]).filter(x => x.operation === "materialize");
  assert.equal(audit.length, 1); assert.deepEqual(JSON.parse(audit[0]!.after_json).compact_skip, { ...skipped, reason: "misfire" });
  assert.throws(() => repo.materialize("s1", 1, due, next, wake, actor), /invalid_occurrence/);
});
