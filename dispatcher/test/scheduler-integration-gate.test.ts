import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeJobRuntime, FakeSlack, SchedulerIntegrationHarness } from "./support/scheduler-integration-harness.js";
import { SchedulerService } from "../src/scheduler/service.js";

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
    const run = harness.repo.getRun(runId)!;
    assert.equal(run.status, "materialized");
    if (slice.action === "slack.reminder.post") {
      const slack = new FakeSlack([{ outcome: "accepted", receipt_id: "fake-receipt" }]);
      assert.equal(await harness.publisher(slack).publishOne(), true);
      assert.equal(slack.calls.length, 1);
      assert.equal(harness.repo.getRun(runId)?.status, "completed");
    } else {
      const runtime = new FakeJobRuntime();
      const event = harness.database.get(run.event_id!)!;
      const result = runtime.run(event.event_id, "inspect repository read-only");
      assert.equal(result.status, "completed");
      assert.equal(runtime.calls.length, 1);
      assert.equal(event.source, "dona_schedule");
      assert.equal(JSON.parse(event.payload_json).work.scope, "read_only");
    }
    assert.equal(new Set((harness.raw.prepare("SELECT occurrence_key FROM schedule_runs").all() as Array<{ occurrence_key: string }>).map(row => row.occurrence_key)).size, 1);
  } finally { harness.close(); }
});

test("restartとduplicate wakeでもrunとprovider callを一度だけにする", async () => {
  let harness = new SchedulerIntegrationHarness();
  try {
    const runId = harness.materialize("restart_duplicate", harness.input("slack.reminder.post", false, due), due);
    harness = harness.reopen();
    assert.equal(harness.raw.prepare("SELECT count(*) AS n FROM schedule_runs").pluck().get(), 1);
    const slack = new FakeSlack([{ outcome: "accepted", receipt_id: "fake-receipt" }]);
    await harness.publisher(slack).publishOne();
    await harness.publisher(slack).publishOne();
    assert.equal(slack.calls.length, 1);
    assert.equal(harness.repo.getRun(runId)?.status, "completed");
  } finally { harness.close(); }
});

test("transaction partial failureはrun/event/outbox/auditをまとめてrollbackする", () => {
  const harness = new SchedulerIntegrationHarness();
  try {
    const input = harness.input("slack.reminder.post", false, due);
    harness.repo.create("partial_failure", input, due, { tenant_id: "T_GATE", actor_id: "U_GATE", role: "owner", source_event_id: null }, harness.clock.now());
    harness.raw.exec("CREATE TRIGGER gate_fail_audit BEFORE INSERT ON schedule_audit WHEN NEW.operation='materialize' BEGIN SELECT RAISE(ABORT,'gate_injected'); END");
    harness.clock.set(due);
    const service = new SchedulerService(harness.repo, harness.clock, () => {}, { debug() {}, info() {}, warn() {}, error() {} }, { owner: "fault-instance" });
    assert.equal(service.runBatch(), 0);
    assert.equal(harness.raw.prepare("SELECT count(*) FROM schedule_runs").pluck().get(), 0);
    assert.equal(harness.raw.prepare("SELECT count(*) FROM connector_outbox").pluck().get(), 0);
    assert.equal(harness.raw.prepare("SELECT count(*) FROM events WHERE source='dona_schedule'").pluck().get(), 0);
    assert.equal(harness.repo.get("partial_failure")?.next_due, due);
  } finally { harness.close(); }
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
