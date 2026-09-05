import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import Database from "better-sqlite3";
import { DispatcherDatabase } from "../src/database.js";
import { migrateScheduler } from "../src/scheduler/schema.js";
import type { Actor, RevisionInput } from "../src/scheduler/repository.js";
import { eventEnvelope } from "./helpers.js";

const now = "2026-09-05T00:00:00Z";
const due = "2026-09-05T00:01:00Z";
const later = "2026-09-06T00:01:00Z";
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

test("新規DB、v2既存データ、再open、WAL/FK、unknown extension version", () => {
  const { raw, filename, dispatcher } = setup();
  const event = dispatcher.enqueue(eventEnvelope("legacy")).row;
  raw.exec(`DROP TABLE schedule_audit; DROP TABLE connector_outbox; DROP TABLE schedule_runs;
    DROP TABLE schedules; DROP TABLE schedule_revisions; DROP TABLE scheduler_schema`);
  assert.equal(raw.pragma("user_version", { simple: true }), 2);
  const reopened = new DispatcherDatabase(filename);
  assert.equal(reopened.get(event.event_id)?.external_event_id, "legacy");
  assert.equal(raw.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(raw.pragma("foreign_keys", { simple: true }), 1);
  assert.equal((raw.prepare("SELECT version FROM scheduler_schema").get() as { version: number }).version, 1);
  reopened.close();
  raw.exec("UPDATE scheduler_schema SET version = 2");
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
  assert.equal((raw.prepare("SELECT content FROM schedule_revisions WHERE revision = 1").get() as { content: string }).content, input.content);
  const audit = JSON.stringify(repo.auditHistory("s1"));
  assert.ok(!audit.includes(input.content)); assert.ok(!audit.includes("変更後本文")); assert.ok(!audit.includes("C_TEST"));
  assert.deepEqual((repo.auditHistory("s1") as { operation: string }[]).map(x => x.operation), ["create", "pause", "update"]);
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

test("cancelとrequest開始のraceでもreceiptとrequest-started fenceを消さない", () => {
  const { repo } = setup(); repo.create("s1", input, due, actor, now); repo.materialize("s1", 1, due, later, due, actor);
  const claim = repo.claim(due)!; repo.requestStarted(claim.outbox_id, claim.claim_token!, due);
  repo.transition("s1", 1, "cancel", actor, due);
  assert.equal(repo.finishWrite(claim.outbox_id, claim.claim_token!, "sent", due, "receipt_1").status, "sent");
  assert.equal(repo.get("s1")?.state, "cancelled"); assert.equal(repo.getOutbox(claim.outbox_id, due)?.request_started_at, due);
});

test("misfire 900秒境界、未決着overlap、expired auth、quotaを保存層で拒否/記録", () => {
  const { repo } = setup(); repo.create("s1", input, due, actor, now);
  assert.equal(repo.materialize("s1", 1, due, later, "2026-09-05T00:16:00Z", actor).run.status, "materialized");
  assert.equal(repo.materialize("s1", 1, later, null, later, actor).run.reason, "overlap");
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
  assert.throws(() => repo.setRunState(run.run_id, "materialized", "started", actor, due, "missing"), /job_reference_conflict/);
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
  assert.equal(repo.getRun(run.run_id)?.terminal_at, due);
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
  assert.equal(repo.materialize("late_claim", 1, later, null, later, actor).run.status, "materialized");

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
  const { repo, raw } = setup(); repo.create("s1", input, due, actor, now);
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
  repo.setRunState(oldRun.run_id, "materialized", "started", actor, due);
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
  assert.equal(result.content, null); assert.equal(repo.get("s1")?.state, "needs_review");
  repo.update("s1", 1, renewed, later, actor, due);
  assert.equal(repo.materialize("s1", 2, later, null, later, actor).run.status, "materialized");
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

test("one-shot workの結果通知と通知なし、graceでskipしたone-shotを完了可能", () => {
  const { dispatcher } = setup();
  const once = { ...input, recurrence_json: `{"at":"${due}","kind":"once","version":1}\n`, timezone: null, tzdb_version: null };
  const repo = dispatcher.scheduler.withCodecs({ recurrence: text => text, policy: text => text });
  repo.create("silent", { ...once, action: "work.read_only", target: { kind: "none" } }, due, actor, now);
  const run = repo.materialize("silent", 1, due, null, due, actor).run;
  repo.setRunState(run.run_id, "materialized", "started", actor, due);
  repo.setRunState(run.run_id, "started", "completed", actor, due);
  assert.equal(repo.get("silent")?.state, "completed");
  repo.create("result", { ...once, action: "work.read_only" }, due, actor, now);
  const notified = repo.materialize("result", 1, due, null, due, actor).run;
  repo.setRunState(notified.run_id, "materialized", "started", actor, due);
  repo.setRunState(notified.run_id, "started", "completed", actor, due, null, "結果");
  assert.equal(repo.get("result")?.state, "active");
  assert.equal(repo.claim("2026-09-05T00:16:01Z"), undefined);
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
  assert.equal(repo.materialize("work_late", 1, later, null, later, actor).run.status, "materialized");
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
    assert.equal(repo.materialize(status, 1, later, null, later, actor).run.status, "materialized");
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
