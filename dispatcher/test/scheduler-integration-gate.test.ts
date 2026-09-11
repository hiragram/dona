import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";

import { DispatcherApi } from "../src/api.js";
import { DispatcherApiClient } from "../src/client.js";
import { FakeJobRuntime, FakeSlack, SchedulerIntegrationHarness } from "./support/scheduler-integration-harness.js";
import { SchedulerService } from "../src/scheduler/service.js";
import { tempConfig } from "./helpers.js";

const due = "2026-09-05T00:01:00Z";
const slices = [
  { id: "one-shot reminder", action: "slack.reminder.post", recurring: false },
  { id: "recurring reminder", action: "slack.reminder.post", recurring: true },
  { id: "one-shot work", action: "work.read_only", recurring: false },
  { id: "recurring work", action: "work.read_only", recurring: true },
] as const;

for (const slice of slices) test(`vertical slice: ${slice.id}`, async () => {
  const harness = new SchedulerIntegrationHarness();
  try {
    const runId = harness.materialize(slice.id.replaceAll(" ", "_"), harness.input(slice.action, slice.recurring, due), due);
    const scheduleId = harness.scheduleIds.get(slice.id.replaceAll(" ", "_"))!;
    const run = harness.repo.getRun(runId)!;
    assert.equal(run.status, "materialized");
    const exercise = async (currentRunId: string): Promise<void> => {
      const currentRun = harness.repo.getRun(currentRunId)!;
      if (slice.action === "slack.reminder.post") {
      const slack = new FakeSlack([{ outcome: "accepted", receipt_id: "fake-receipt" }]);
      assert.equal(await harness.publisher(slack).publishOne(), true);
      assert.equal(slack.calls.length, 1);
      assert.equal(harness.repo.getRun(currentRunId)?.status, "completed");
      } else {
        const runtime = new FakeJobRuntime();
        const event = harness.database.get(currentRun.event_id!)!;
        const result = runtime.run(harness, event.event_id, "inspect repository read-only");
        assert.equal(result.status, "completed");
        assert.equal(runtime.calls.length, 1);
        assert.equal(runtime.slack.workCalls.length, 1);
        assert.equal(harness.database.getJob(result.job_id)?.status, "completed");
        assert.equal(harness.repo.getRun(currentRunId)?.status, "completed");
        assert.equal(harness.database.get(event.event_id)?.status, "completed");
        const notification = harness.raw.prepare("SELECT notification_event_id,notification_state FROM job_completion_results WHERE job_id=?")
          .get(result.job_id) as { notification_event_id: string; notification_state: string };
        assert.equal(notification.notification_state, "accepted");
        assert.equal(harness.database.get(notification.notification_event_id)?.status, "completed");
        assert.equal(event.source, "dona_schedule");
        assert.equal(JSON.parse(event.payload_json).work.scope, "read_only");
      }
    };
    await exercise(runId);
    if (!slice.recurring) {
      const schedule = harness.repo.get(scheduleId);
      assert.equal(schedule?.state, "completed");
      assert.equal(schedule?.next_due, null);
    }
    if (slice.recurring) {
      const nextDue = harness.repo.get(scheduleId)?.next_due;
      assert.equal(nextDue, "2026-09-06T00:01:00Z");
      harness.clock.set(nextDue!);
      const service = new SchedulerService(harness.repo, harness.clock, () => {}, { debug() {}, info() {}, warn() {}, error() {} }, { owner: "second-instance" });
      assert.equal(service.runBatch(), 1);
      const secondRun = (harness.raw.prepare("SELECT run_id FROM schedule_runs WHERE schedule_id=? ORDER BY scheduled_for DESC LIMIT 1")
        .get(scheduleId) as { run_id: string }).run_id;
      assert.notEqual(secondRun, runId);
      await exercise(secondRun);
    }
    const keys = (harness.raw.prepare("SELECT occurrence_key FROM schedule_runs").all() as Array<{ occurrence_key: string }>).map(row => row.occurrence_key);
    assert.equal(new Set(keys).size, slice.recurring ? 2 : 1);
  } finally { harness.close(); }
});

test("restartとduplicate wakeでもrunとprovider callを一度だけにする", async () => {
  let harness = new SchedulerIntegrationHarness();
  try {
    const runId = harness.materialize("restart_duplicate", harness.input("slack.reminder.post", false, due), due);
    harness = harness.reopen();
    const restarted = new SchedulerService(harness.repo, harness.clock, () => {}, { debug() {}, info() {}, warn() {}, error() {} }, { owner: "restart-instance" });
    assert.equal(restarted.runBatch(), 0);
    assert.equal(restarted.runBatch(), 0);
    assert.equal(harness.raw.prepare("SELECT count(*) AS n FROM schedule_runs").pluck().get(), 1);
    assert.equal(harness.raw.prepare("SELECT count(*) AS n FROM events WHERE source='dona_schedule'").pluck().get(), 0);
    assert.equal(harness.raw.prepare("SELECT count(*) AS n FROM connector_outbox").pluck().get(), 1);
    const slack = new FakeSlack([{ outcome: "accepted", receipt_id: "fake-receipt" }]);
    await harness.publisher(slack).publishOne();
    await harness.publisher(slack).publishOne();
    assert.equal(slack.calls.length, 1);
    assert.equal(harness.repo.getRun(runId)?.status, "completed");
  } finally { harness.close(); }
});

test("transaction partial failureはreminder/workのrun/event/outbox/binding/auditをまとめてrollbackする", () => {
  for (const action of ["slack.reminder.post", "work.read_only"] as const) {
    const harness = new SchedulerIntegrationHarness();
    try {
      const scheduleId = `partial_failure_${action.replaceAll(".", "_")}`;
      harness.repo.create(scheduleId, harness.input(action, false, due), due, { tenant_id: "T_GATE", actor_id: "U_GATE", role: "owner", source_event_id: null }, harness.clock.now());
      harness.raw.exec("CREATE TRIGGER gate_fail_audit BEFORE INSERT ON schedule_audit WHEN NEW.operation='materialize' BEGIN SELECT RAISE(ABORT,'gate_injected'); END");
      harness.clock.set(due);
      const service = new SchedulerService(harness.repo, harness.clock, () => {}, { debug() {}, info() {}, warn() {}, error() {} }, { owner: "fault-instance" });
      assert.equal(service.runBatch(), 0);
      assert.equal(harness.raw.prepare("SELECT count(*) FROM schedule_runs").pluck().get(), 0);
      assert.equal(harness.raw.prepare("SELECT count(*) FROM connector_outbox").pluck().get(), 0);
      assert.equal(harness.raw.prepare("SELECT count(*) FROM events WHERE source='dona_schedule'").pluck().get(), 0);
      assert.equal(harness.raw.prepare("SELECT count(*) FROM event_job_bindings WHERE json_extract(owner_json,'$.kind')='schedule'").pluck().get(), 0);
      assert.equal(harness.repo.get(scheduleId)?.next_due, due);
    } finally { harness.close(); }
  }
});

test("shared harness self-testはclock進行、failure point、外部call countを観測する", async () => {
  const harness = new SchedulerIntegrationHarness();
  try {
    harness.clock.advance(60);
    assert.equal(harness.clock.now(), due);
    harness.fault.arm("before_provider_write");
    assert.throws(() => harness.fault.hit("before_provider_write"), /injected:before_provider_write/);
    assert.equal(harness.fault.count("before_provider_write"), 1);
    const slack = new FakeSlack([{ outcome: "accepted", receipt_id: "fake" }]);
    await slack.deliver({ schema_version: 1, action: "slack.reminder.post", outbox_id: "outbox", run_id: "run",
      idempotency_key: "key", owner_id: "U_GATE", expires_at: "2026-09-30T00:00:00Z", misfire_at: due,
      lease_until: "2026-09-05T00:05:00Z", target: { kind: "thread", workspace_id: "T_GATE", channel_id: "C_GATE", thread_ts: "1.000001" }, text: "fixture" });
    assert.equal(slack.calls.length, 1);
  } finally { harness.close(); }
});

test("provider timeout after sendはneeds_reviewとなりblind retryしない", async () => {
  const harness = new SchedulerIntegrationHarness();
  try {
    const runId = harness.materialize("ambiguous_write", harness.input("slack.reminder.post", false, due), due);
    const slack = new FakeSlack([{ outcome: "acceptance_unknown", code: "timeout_after_send" }]);
    await harness.publisher(slack).publishOne();
    assert.equal(harness.repo.getRun(runId)?.status, "needs_review");
    assert.equal(await harness.publisher(slack).publishOne(), false);
    assert.equal(slack.calls.length, 1);
  } finally { harness.close(); }
});

test("署名済みaccess receiptはDispatcher UDSとcurrent Slack確認を通過してからworkを許可する", async () => {
  const liveNow = new Date(Math.floor(Date.now() / 1000) * 1000);
  const liveDue = new Date(liveNow.getTime() + 1000).toISOString().replace(".000Z", "Z");
  const harness = new SchedulerIntegrationHarness(liveNow.toISOString().replace(".000Z", "Z"));
  const { root, config } = await tempConfig();
  const token = "gate-internal-token-32-bytes-minimum";
  let api: DispatcherApi | undefined;
  let slack: http.Server | undefined;
  try {
    const runId = harness.materialize("signed_access", harness.input("work.read_only", false, liveDue), liveDue);
    const eventId = harness.repo.getRun(runId)!.event_id!;
    harness.database.beginDispatch(eventId, path.join(harness.root, "event-results", `${eventId}.json`), new Date(harness.clock.now()));
    fs.mkdirSync(path.dirname(config.updateInternalTokenPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(config.updateInternalTokenPath, token, { mode: 0o600 });
    fs.mkdirSync(path.dirname(config.slackAdapterSocketPath), { recursive: true, mode: 0o700 });
    slack = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        assert.equal(request.url, "/v1/internal/schedule-access-confirmations");
        assert.equal(request.headers["x-dona-update-token"], token);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ schema_version: 1, authorized: true, event_id: body.event_id,
          workspace_id: body.workspace_id, channel_id: body.channel_id, user_id: body.user_id }));
      });
    });
    await new Promise<void>((resolve, reject) => { slack!.once("error", reject); slack!.listen(config.slackAdapterSocketPath, resolve); });
    api = new DispatcherApi(harness.database, { isRunning: () => true, wake() {} },
      { isRunning: () => true, wake() {}, async steer() { throw new Error("unused"); }, async cancel() { throw new Error("unused"); } },
      config, { debug() {}, info() {}, warn() {}, error() {} });
    await api.start();
    const claims = { event_id: eventId, workspace_id: "T_GATE", channel_id: "C_GATE", user_id: "U_GATE",
      issued_at: new Date().toISOString(), nonce: `signed_${eventId}` };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const receipt = `${payload}.${createHmac("sha256", token).update(payload).digest("base64url")}`;
    const client = new DispatcherApiClient(config.socketPath);
    const authorized = await client.recordScheduleJobAccess(eventId, receipt);
    assert.equal(authorized.authorized, true);
    assert.equal(harness.database.get(eventId)?.status, "waiting_agent");
    const created = await client.createJob({ source_event_id: eventId, objective: "inspect repository read-only", workspace: { kind: "scratch" } });
    const job = created.job as { job_id: string };
    assert.ok(job.job_id);
    await assert.rejects(client.recordScheduleJobAccess(eventId, receipt), /schedule_access_receipt_mismatch/);
    harness.database.beginJobPreparation(job.job_id, new Date());
    harness.database.beginJobDispatch(job.job_id, new Date());
    harness.database.markJobRunning(job.job_id, new Date());
    harness.database.saveCompleted(eventId, { schema_version: 1, event_id: eventId, status: "completed", summary: "job delegated",
      actions: [], completed_at: new Date().toISOString() }, path.join(harness.root, "event-results", `${eventId}.json`), new Date());
    harness.database.saveJobResult(job.job_id, { schema_version: 1, job_id: job.job_id, status: "completed", summary: "read-only work completed",
      output: { format: "markdown", text: "fixture result" }, actions: [], completed_at: new Date().toISOString() },
      harness.database.getJob(job.job_id)!.result_path, new Date());
    const notification = harness.database.enqueueJobNotification(job.job_id, new Date()).row;
    harness.database.beginDispatch(notification.event_id, path.join(harness.root, "event-results", `${notification.event_id}.json`), new Date());
    assert.equal((await client.authorizeJobNotification(notification.event_id)).authorized, true);
    const notificationClaims = { ...claims, event_id: notification.event_id, issued_at: new Date().toISOString(), nonce: `notify_${notification.event_id}` };
    const notificationPayload = Buffer.from(JSON.stringify(notificationClaims)).toString("base64url");
    const notificationReceipt = `${notificationPayload}.${createHmac("sha256", token).update(notificationPayload).digest("base64url")}`;
    assert.equal((await client.authorizeJobNotification(notification.event_id, notificationReceipt)).authorized, true);
    const fakeSlack = new FakeSlack([]);
    const posted = fakeSlack.postWorkResult(notification.event_id, "read-only work completed");
    assert.equal(posted.event_id, notification.event_id);
    assert.equal(fakeSlack.workCalls.length, 1);
  } finally {
    if (api) await api.stop();
    if (slack?.listening) await new Promise<void>((resolve, reject) => slack!.close(error => error ? reject(error) : resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    harness.close();
  }
});
