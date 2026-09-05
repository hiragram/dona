import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";
import Database from "better-sqlite3";
import { DispatcherDatabase } from "../src/database.js";
import { completionDestinationSchema, eventOwnerSchema, migrateEventRouting } from "../src/event-routing.js";
import type { ProviderOwner } from "../src/event-routing.js";
import { externalEventSource, scopedExternalEventId } from "../src/ingress.js";
import { envelopeFromRow } from "../src/prompt.js";
import { DispatcherWorker } from "../src/worker.js";
import { JobSupervisor } from "../src/job-supervisor.js";
import type { HerdrCommandResult } from "../src/herdr.js";
import type { JobAgentRuntime } from "../src/job-runtime.js";
import type { EventEnvelope } from "../src/types.js";
import { eventEnvelope, tempConfig, waitFor } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
const owner: ProviderOwner = { kind: "provider_resource", source: "test_provider", connection_id: "connection-1", resource_id: "resource-1" };
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const ok: HerdrCommandResult = { ok: true, stdout: "", stderr: "", exitCode: 0, timedOut: false, aborted: false, agentStatus: "done" };
function envelope(id = "delivery-1", binding = owner): EventEnvelope {
  const source = externalEventSource(binding.source);
  return { schema_version: 1, source, external_event_id: scopedExternalEventId(source, binding.connection_id, id),
    type: "changed", occurred_at: "2026-09-05T00:00:00Z", subject: {}, payload: {}, reply_target: null };
}
async function setup(allow = true) {
  const { root, config } = await tempConfig(); roots.push(root);
  const database = new DispatcherDatabase(config.databasePath);
  database.setProviderExecutionPolicy(owner, "changed", { background_job: allow, workspace: "scratch" });
  const source = database.enqueueProvider(envelope(), owner).row;
  const create = () => database.createJob({ source_event_id: source.event_id, objective: "読み取り調査", workspace: { kind: "scratch" } }, config.jobsWorkspaceRoot, config.jobResultsDir);
  return { root, config, database, source, create };
}

test("closed owner/destination unions reject unknown kinds and provider outbound", () => {
  for (const value of [{ kind: "unknown" }, { ...owner, kind: "slack_thread" }, { ...owner, source: "dona_update" }, { ...owner, destination: "slack" }]) {
    assert.equal(eventOwnerSchema.safeParse(value).success, false);
  }
  assert.equal(completionDestinationSchema.safeParse({ kind: "none" }).success, true);
  assert.equal(completionDestinationSchema.safeParse({ kind: "provider_comment", resource_id: "r" }).success, false);
});

test("persisted capability is bound at admission; payload and later policy cannot escalate it", async () => {
  const { database, create, config, source } = await setup(false);
  assert.throws(create, /capability denied/);
  database.setProviderExecutionPolicy(owner, "changed", { background_job: true, workspace: "scratch" });
  assert.equal(database.enqueueProvider(envelope(), owner).row.event_id, source.event_id);
  assert.throws(create, /capability denied/);
  const supplied = envelope("payload-escalation"); supplied.payload = { background_job: true, connection_id: owner.connection_id, resource_id: owner.resource_id };
  const unknown = database.enqueue(supplied).row;
  assert.throws(() => database.createJob({ source_event_id: unknown.event_id, objective: "調査", workspace: { kind: "scratch" } }, config.jobsWorkspaceRoot, config.jobResultsDir), /authenticated provider owner/);
  for (const binding of [{ ...owner, connection_id: "other" }, { ...owner, resource_id: "other" }]) {
    const event = database.enqueueProvider(envelope("policy-test", binding), binding).row;
    assert.equal(database.getEventBinding(event.event_id)?.execution.background_job, false);
  }
  database.close();
});

test("owner query/steer/cancel reject cross-source, connection, resource and unknown ownership", async () => {
  const { database, create } = await setup();
  const job = create().row;
  assert.deepEqual(database.listOwnerJobs(job.source_event_id).map((j) => j.job_id), [job.job_id]);
  for (const other of [{ ...owner, connection_id: "other" }, { ...owner, resource_id: "other" }, { ...owner, source: "other" }]) {
    const event = database.enqueueProvider(envelope("other", other), other).row;
    assert.deepEqual(database.listOwnerJobs(event.event_id), []);
    assert.throws(() => database.appendQueuedJobInstruction(job.job_id, event.event_id, "変更"), /does not belong/);
    assert.throws(() => database.beginJobCancellation(job.job_id, event.event_id), /does not belong/);
  }
  assert.throws(() => database.listOwnerJobs("missing"), /Unknown/);
  assert.equal(job.workspace_id, null); assert.equal(job.channel_id, null); assert.equal(job.thread_ts, null);
  assert.equal(envelopeFromRow(database.get(job.source_event_id)!).reply_target, null);
  database.close();
});

test("duplicate creates across database handles retain one runtime identity and immutable binding", async () => {
  const { database, create, config, source } = await setup();
  const second = new DispatcherDatabase(config.databasePath);
  const job = create().row;
  const duplicate = second.createJob({ source_event_id: source.event_id, objective: "読み取り調査", workspace: { kind: "scratch" } }, config.jobsWorkspaceRoot, config.jobResultsDir);
  assert.equal(duplicate.row.job_id, job.job_id); assert.equal(duplicate.duplicate, true);
  assert.equal(database.listJobs().length, 1);
  const raw = new Database(config.databasePath);
  assert.throws(() => raw.prepare("UPDATE event_bindings SET owner_json = '{}' WHERE event_id = ?").run(source.event_id), /immutable/);
  assert.throws(() => raw.prepare("UPDATE job_bindings SET owner_json = '{}' WHERE job_id = ?").run(job.job_id), /immutable/);
  raw.close(); second.close(); database.close();
});

for (const mode of ["no-op", "sync", "job"] as const) test(`fake provider → ${mode} → durable Result without Slack coordinates`, async () => {
  const { database, config, source, create } = await setup();
  await fs.mkdir(config.resultsDir, { recursive: true });
  let jobId: string | undefined;
  let prompts = 0;
  const worker = new DispatcherWorker(database, {
    async get() { return ok; }, async wait() { return ok; },
    async prompt(prompt) {
      prompts++;
      assert.match(prompt, /trigger-only/); assert.doesNotMatch(prompt, /"slack_thread"/);
      if (mode === "job") jobId = create().row.job_id;
      const resultPath = /^result_path: (.+)$/m.exec(prompt)![1]!;
      const result = { schema_version: 1, event_id: source.event_id, status: "completed", summary: mode, actions: [], completed_at: new Date().toISOString() };
      await fs.writeFile(`${resultPath}.tmp`, JSON.stringify(result)); await fs.rename(`${resultPath}.tmp`, resultPath);
      return ok;
    },
  }, config, logger);
  worker.start(); await waitFor(() => database.get(source.event_id)?.status === "completed"); await worker.stop();
  assert.equal(prompts, 1);
  const saved = database.get(source.event_id)!;
  assert.deepEqual(JSON.parse(await fs.readFile(saved.result_path!, "utf8")), JSON.parse(saved.result_json!));
  if (jobId) {
    const job = database.getJob(jobId)!;
    assert.notEqual(job.result_path, saved.result_path);
    let executions = 0; let notifications = 0;
    const runtime: JobAgentRuntime = {
      async prepare() { await fs.mkdir(config.jobResultsDir, { recursive: true }); return { herdrWorkspaceId: "isolated", herdrPaneId: "isolated:p1" }; },
      async get() { return ok; }, async wait() { return ok; }, async cancel() { throw new Error("unexpected cancel"); },
      async prompt() {
        executions++;
        await fs.writeFile(job.result_path, JSON.stringify({ schema_version: 1, job_id: job.job_id, status: "completed", summary: "完了", completed_at: new Date().toISOString() }));
        return ok;
      },
    };
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => { notifications++; });
    supervisor.start(); await waitFor(() => !!database.getJobCompletion(job.job_id)); await supervisor.stop();
    assert.equal(executions, 1); assert.equal(notifications, 0);
    const completion = database.getJobCompletion(job.job_id)!;
    assert.equal(completion.notification_state, "none"); assert.equal(completion.notification_event_id, null);
    assert.equal(completion.result_json, database.getJob(job.job_id)!.result_json);
    assert.equal(database.getJob(job.job_id)!.herdr_workspace_id, "isolated");
    assert.equal(database.enqueueJobNotification(job.job_id), undefined);
    assert.equal(database.list().length, 1);
    database.close();
    const restarted = new DispatcherDatabase(config.databasePath);
    assert.equal(restarted.enqueueJobNotification(job.job_id), undefined);
    assert.deepEqual(restarted.getJobCompletion(job.job_id), completion);
    restarted.close();
  } else { assert.equal(database.listJobs().length, 0); database.close(); }
});

for (const fault of ["missing", "invalid", "cross-job", "prompt-unknown"] as const) test(`fake runtime ${fault} never blindly retries`, async () => {
  const { database, config, create } = await setup();
  const job = create().row;
  let executions = 0;
  const supervisor = new JobSupervisor(database, {
    async prepare() { await fs.mkdir(config.jobResultsDir, { recursive: true }); return { herdrWorkspaceId: "isolated", herdrPaneId: "p1" }; },
    async get() { return ok; }, async wait() { return ok; }, async cancel() { throw new Error("unexpected"); },
    async prompt() {
      executions++;
      if (fault === "invalid") await fs.writeFile(job.result_path, "invalid");
      if (fault === "cross-job") await fs.writeFile(job.result_path, JSON.stringify({ schema_version: 1, job_id: "other", status: "completed", summary: "x", completed_at: new Date().toISOString() }));
      return fault === "prompt-unknown" ? { ...ok, ok: false, timedOut: true } : ok;
    },
  }, config, logger, () => { throw new Error("No Slack notification permitted"); });
  supervisor.start(); await waitFor(() => !!database.getJobCompletion(job.job_id)); await supervisor.stop();
  assert.equal(database.getJob(job.job_id)!.status, "needs_review");
  assert.equal(executions, 1); assert.deepEqual(database.listRunnableJobs(), []);
  database.close();
  const restarted = new DispatcherDatabase(config.databasePath); restarted.recoverStaleJobs();
  assert.deepEqual(restarted.listRunnableJobs(), []); assert.deepEqual(restarted.listJobsNeedingNotification(), []);
  restarted.close();
});

test("additive routing migration preserves v2 Slack rows and rolls back on fault", async () => {
  const { root, config } = await tempConfig(); roots.push(root);
  const database = new DispatcherDatabase(config.databasePath);
  const source = database.enqueue(eventEnvelope("legacy")).row;
  const job = database.createJob({ source_event_id: source.event_id, objective: "調査", workspace: { kind: "scratch" } }, config.jobsWorkspaceRoot, config.jobResultsDir).row;
  database.beginJobPreparation(job.job_id); database.setJobRuntime(job.job_id, "w", "p"); database.beginJobDispatch(job.job_id); database.markJobRunning(job.job_id);
  database.saveJobResult(job.job_id, { schema_version: 1, job_id: job.job_id, status: "completed", summary: "結果", completed_at: new Date().toISOString() }, job.result_path);
  database.enqueueJobNotification(job.job_id);
  const before = database.getJob(job.job_id); database.close();
  const raw = new Database(config.databasePath);
  const snapshots = raw.prepare("SELECT * FROM events").all();
  raw.exec("DELETE FROM event_routing_migrations");
  assert.throws(() => migrateEventRouting(raw, () => { throw new Error("migration crash"); }), /migration crash/);
  migrateEventRouting(raw);
  assert.deepEqual(raw.prepare("SELECT * FROM events").all(), snapshots);
  assert.deepEqual(raw.prepare("SELECT * FROM jobs").get(), before);
  assert.equal(raw.pragma("user_version", { simple: true }), 2);
  assert.equal(raw.pragma("integrity_check", { simple: true }), "ok"); assert.deepEqual(raw.pragma("foreign_key_check"), []);
  raw.close();
});

test("routing migration on real #46 job_key/group schema preserves runtime, results, completion and groups", async () => {
  const { root, config } = await tempConfig(); roots.push(root);
  const db = new DispatcherDatabase(config.databasePath);
  const event = db.enqueue(eventEnvelope("v3-legacy")).row;
  const job = db.createJob({ source_event_id: event.event_id, objective: "既存", workspace: { kind: "scratch" } }, config.jobsWorkspaceRoot, config.jobResultsDir).row;
  db.beginJobPreparation(job.job_id); db.setJobRuntime(job.job_id, "legacy-workspace", "legacy-pane"); db.beginJobDispatch(job.job_id); db.markJobRunning(job.job_id);
  db.saveJobResult(job.job_id, { schema_version: 1, job_id: job.job_id, status: "completed", summary: "既存結果", completed_at: new Date().toISOString() }, job.result_path);
  db.enqueueJobNotification(job.job_id); db.close();
  const raw = new Database(config.databasePath);
  // #46 先行の状態を作るため、#49 の追加テーブルだけを除いて元のmigration SQLを適用。
  raw.exec("DROP TABLE event_routing_migrations; DROP TRIGGER completion_notification_projection; DROP TABLE job_completions; DROP TABLE job_bindings; DROP TABLE event_bindings; DROP TABLE provider_execution_policies;");
  raw.exec(await fs.readFile(new URL("./fixtures/jobs-v3.sql", import.meta.url), "utf8"));
  const jobs = raw.prepare("SELECT * FROM jobs").all();
  const groups = raw.prepare("SELECT * FROM job_groups").all();
  const events = raw.prepare("SELECT * FROM events").all();
  assert.throws(() => migrateEventRouting(raw, () => { throw new Error("injected migration fault"); }), /injected/);
  assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'event_bindings'").get(), undefined);
  migrateEventRouting(raw);
  assert.deepEqual(raw.prepare("SELECT * FROM jobs").all(), jobs);
  assert.deepEqual(raw.prepare("SELECT * FROM job_groups").all(), groups);
  assert.deepEqual(raw.prepare("SELECT * FROM events").all(), events);
  const projection = raw.prepare("SELECT * FROM job_completions").get() as Record<string, unknown>;
  assert.equal(projection.result_json, (jobs[0] as Record<string, unknown>).result_json);
  assert.equal(projection.notification_event_id, (jobs[0] as Record<string, unknown>).completion_event_id);
  assert.equal(projection.notification_state, "pending");
  assert.equal(raw.pragma("user_version", { simple: true }), 3);
  assert.equal(raw.pragma("integrity_check", { simple: true }), "ok"); assert.deepEqual(raw.pragma("foreign_key_check"), []);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM job_bindings").get() as { n: number }).n, 1);
  raw.close();
});

test("completion commit/restart and notification acceptance unknown preserve job result without re-materialization", async () => {
  const { root, config } = await tempConfig(); roots.push(root);
  const db = new DispatcherDatabase(config.databasePath);
  const event = db.enqueue(eventEnvelope("notification-unknown")).row;
  const job = db.createJob({ source_event_id: event.event_id, objective: "調査", workspace: { kind: "scratch" } }, config.jobsWorkspaceRoot, config.jobResultsDir).row;
  db.beginJobPreparation(job.job_id); db.beginJobDispatch(job.job_id); db.markJobRunning(job.job_id);
  db.saveJobResult(job.job_id, { schema_version: 1, job_id: job.job_id, status: "completed", summary: "結果", completed_at: new Date().toISOString() }, job.result_path);
  const materialized = db.enqueueJobNotification(job.job_id)!;
  const jobResult = db.getJob(job.job_id)!.result_json;
  db.close(); // completion commit の直後にprocessが消失した境界。
  const restarted = new DispatcherDatabase(config.databasePath);
  assert.equal(restarted.enqueueJobNotification(job.job_id)!.row.event_id, materialized.row.event_id);
  restarted.beginDispatch(materialized.row.event_id, "notification-result");
  restarted.close(); // notification prompt の受付結果不明。
  const recovered = new DispatcherDatabase(config.databasePath);
  recovered.recoverStaleDispatching();
  assert.equal(recovered.get(materialized.row.event_id)!.status, "needs_review");
  assert.equal(recovered.getJobCompletion(job.job_id)!.notification_state, "needs_review");
  assert.equal(recovered.getJob(job.job_id)!.result_json, jobResult);
  assert.deepEqual(recovered.listJobsNeedingNotification(), []);
  assert.equal(recovered.enqueueJobNotification(job.job_id)!.row.event_id, materialized.row.event_id);
  assert.equal(recovered.list().filter((row) => row.source === "dona_job").length, 1);
  recovered.close();
});

test("simultaneous processes admit one provider event/job and materialize one completion", async () => {
  const { database, config, source, create } = await setup();
  const run = promisify(execFile);
  const moduleUrl = new URL("../src/database.ts", import.meta.url).href;
  const script = `import { DispatcherDatabase } from ${JSON.stringify(moduleUrl)};
    const db = new DispatcherDatabase(process.argv[1]);
    const event = db.enqueueProvider(JSON.parse(process.argv[5]), JSON.parse(process.argv[6])).row;
    const job = db.createJob({source_event_id:event.event_id, objective:"読み取り調査", workspace:{kind:"scratch"}}, process.argv[3], process.argv[4]).row;
    console.log(JSON.stringify({event_id:event.event_id,job_id:job.job_id})); db.close();`;
  const args = ["--import", "tsx", "--input-type=module", "-e", script, config.databasePath, source.event_id, config.jobsWorkspaceRoot, config.jobResultsDir, JSON.stringify(envelope()), JSON.stringify(owner)];
  const admitted = await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, args)));
  const ids = admitted.map((value) => JSON.parse(value.stdout) as { event_id: string; job_id: string });
  assert.equal(new Set(ids.map((value) => value.event_id)).size, 1);
  assert.equal(new Set(ids.map((value) => value.job_id)).size, 1);
  const job = create().row;
  const claimScript = `import { DispatcherDatabase } from ${JSON.stringify(moduleUrl)};
    const db = new DispatcherDatabase(process.argv[1]);
    try { db.beginJobPreparation(process.argv[2]); console.log("claimed"); } catch { console.log("already-claimed"); } db.close();`;
  const claims = await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", claimScript, config.databasePath, job.job_id])));
  assert.equal(claims.filter((claim) => claim.stdout.trim() === "claimed").length, 1);
  database.beginJobDispatch(job.job_id); database.markJobRunning(job.job_id);
  database.saveJobResult(job.job_id, { schema_version: 1, job_id: job.job_id, status: "completed", summary: "完了", completed_at: new Date().toISOString() }, job.result_path);
  const completeScript = `import { DispatcherDatabase } from ${JSON.stringify(moduleUrl)};
    const db = new DispatcherDatabase(process.argv[1]); db.enqueueJobNotification(process.argv[2]); db.close();`;
  await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", completeScript, config.databasePath, job.job_id])));
  const raw = new Database(config.databasePath);
  assert.equal((raw.prepare("SELECT count(*) AS n FROM job_completions").get() as { n: number }).n, 1);
  assert.equal(database.listJobs().length, 1); assert.equal(database.list().length, 1);
  raw.close(); database.close();
});

for (const notificationState of ["queued", "completed", "needs_review"] as const) test(`legacy completion migration restores ${notificationState} notification and job Result`, async () => {
  const { root, config } = await tempConfig(); roots.push(root);
  const db = new DispatcherDatabase(config.databasePath);
  const event = db.enqueue(eventEnvelope(`legacy-${notificationState}`)).row;
  const job = db.createJob({ source_event_id: event.event_id, objective: "既存", workspace: { kind: "scratch" } }, config.jobsWorkspaceRoot, config.jobResultsDir).row;
  db.beginJobPreparation(job.job_id); db.beginJobDispatch(job.job_id); db.markJobRunning(job.job_id);
  db.saveJobResult(job.job_id, { schema_version: 1, job_id: job.job_id, status: "completed", summary: "job結果", completed_at: new Date().toISOString() }, job.result_path);
  const notification = db.enqueueJobNotification(job.job_id)!.row;
  if (notificationState !== "queued") {
    db.beginDispatch(notification.event_id, "notification-result");
    if (notificationState === "needs_review") db.markNeedsReview(notification.event_id, "acceptance_unknown", "照合待ち");
    else {
      db.markWaiting(notification.event_id);
      db.saveCompleted(notification.event_id, { schema_version: 1, event_id: notification.event_id, status: "completed", summary: "通知結果", actions: [], completed_at: new Date().toISOString() }, "notification-result");
    }
  }
  const expectedJob = db.getJob(job.job_id)!;
  const expectedNotification = db.get(notification.event_id)!;
  db.close();
  const legacy = new Database(config.databasePath);
  legacy.exec("DELETE FROM job_completions; DELETE FROM event_routing_migrations");
  legacy.close();
  const migrated = new DispatcherDatabase(config.databasePath);
  const projection = migrated.getJobCompletion(job.job_id)!;
  assert.equal(projection.result_json, expectedJob.result_json);
  assert.equal(projection.notification_result_json, expectedNotification.result_json);
  assert.equal(projection.notification_event_id, notification.event_id);
  assert.equal(projection.notification_state, notificationState === "completed" ? "accepted" : notificationState === "queued" ? "pending" : "needs_review");
  assert.deepEqual(migrated.getJob(job.job_id), expectedJob);
  assert.deepEqual(migrated.get(notification.event_id), expectedNotification);
  assert.deepEqual(migrated.listJobsNeedingNotification(), []);
  migrated.close();
});

test("completed migration reopens while another process holds the write lock without rescanning history", async () => {
  const { database, config } = await setup(); database.close();
  const writer = new Database(config.databasePath);
  const reader = new Database(config.databasePath); reader.pragma("busy_timeout = 1");
  writer.exec("BEGIN IMMEDIATE");
  try { migrateEventRouting(reader, () => { throw new Error("Migration must not run twice"); }); }
  finally { writer.exec("ROLLBACK"); reader.close(); writer.close(); }
});
