import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import Database from "better-sqlite3";

import { DispatcherDatabase } from "../src/database.js";
import type { Logger } from "../src/logger.js";
import { FakeClock } from "../src/scheduler/clock.js";
import type { Actor, RevisionInput } from "../src/scheduler/repository.js";
import { SchedulerService } from "../src/scheduler/service.js";

const policy = fs.readFileSync(new URL("../../docs/adr/fixtures/scheduler-v1/policy.json", import.meta.url), "utf8");
const actor: Actor = { tenant_id: "T_TEST", actor_id: "U_TEST", role: "owner", source_event_id: null };
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function setup(now = "2026-09-05T00:00:00Z") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dona-scheduler-service-"));
  const filename = path.join(root, "db.sqlite");
  const database = new DispatcherDatabase(filename);
  const raw = new Database(filename);
  cleanups.push(() => { raw.close(); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const repo = database.scheduler.withCodecs({ recurrence: text => text, policy: text => text });
  return { filename, database, raw, repo, clock: new FakeClock(now) };
}

function once(at: string): RevisionInput {
  return {
    recurrence_json: `${JSON.stringify({ at, kind: "once", version: 1 })}\n`,
    policy_json: policy,
    policy_version: 1,
    timezone: null,
    tzdb_version: null,
    authorization_id: `auth_${at.replace(/\W/g, "")}`,
    authorization_revision: 1,
    approver_id: actor.actor_id,
    approved_at: "2026-09-05T00:00:00Z",
    expires_at: "2026-09-30T00:00:00Z",
    action: "work.read_only",
    target: { kind: "none" },
    content: "read only",
  };
}

function daily(first: string): RevisionInput {
  return {
    ...once(first),
    recurrence_json: `${JSON.stringify({ version: 1, kind: "daily", start_date: "2026-09-05", local_time: "09:01:00", timezone: "Asia/Tokyo", tzdb_version: "2025b", interval: 1 })}\n`,
    timezone: "Asia/Tokyo",
    tzdb_version: "2025b",
  };
}

test("FakeClockのbefore/exact/afterとduplicate wakeで一度だけrun/eventを物化する", () => {
  const { repo, raw, clock } = setup();
  const due = "2026-09-05T00:01:00Z";
  repo.create("exact", once(due), due, actor, clock.now());
  const service = new SchedulerService(repo, clock, () => {}, logger, { owner: "scheduler_a" });
  assert.equal(service.runBatch(), 0);
  clock.set(due);
  assert.equal(service.runBatch(), 1);
  assert.equal(service.runBatch(), 0);
  clock.set("2026-09-05T00:02:00Z");
  assert.equal(service.runBatch(), 0);
  assert.equal((raw.prepare("SELECT count(*) n FROM schedule_runs").get() as { n: number }).n, 1);
  const event = raw.prepare("SELECT source, external_event_id FROM events").get() as { source: string; external_event_id: string };
  assert.deepEqual(event, { source: "dona_schedule", external_event_id: `schedule:v1:exact:${due}` });
});

test("multiple dueをbounded batchで処理しqueueのsequence順を保持する", () => {
  const { repo, database, raw, clock } = setup();
  const due = "2026-09-05T00:01:00Z";
  for (const id of ["a", "b", "c"]) repo.create(id, once(due), due, actor, clock.now());
  const slack = database.enqueue({ schema_version: 1, source: "slack", external_event_id: "slack_first", type: "message",
    occurred_at: clock.now(), subject: {}, payload: {}, reply_target: null }, new Date(clock.now())).row;
  clock.set(due);
  const service = new SchedulerService(repo, clock, () => {}, logger, { owner: "scheduler_a", batchSize: 2 });
  assert.equal(service.runBatch(), 2);
  assert.equal((raw.prepare("SELECT count(*) n FROM schedule_runs").get() as { n: number }).n, 2);
  assert.equal(database.nextAvailable(new Date(due))?.event_id, slack.event_id);
  assert.equal(service.runBatch(), 1);
});

test("2 instance競合、stale lease recovery、owner token/fenceを強制する", () => {
  const { repo, clock } = setup();
  const due = "2026-09-05T00:01:00Z";
  repo.create("leased", once(due), due, actor, clock.now());
  clock.set(due);
  const first = repo.claimDue("scheduler_a", due, 1)!;
  assert.equal(repo.claimDue("scheduler_b", due, 1), undefined);
  const recoveredAt = "2026-09-05T00:01:02Z";
  const second = repo.claimDue("scheduler_b", recoveredAt, 60)!;
  const definition = repo.materializationDefinition(second.schedule_id, second.revision);
  assert.throws(() => repo.materialize("leased", 1, due, null, recoveredAt, { ...actor, role: "admin", actor_id: "scheduler" }, null, undefined,
    { owner: "scheduler_a", fence: first.claim_fence, occurrenceKey: JSON.stringify(["leased", due]) }), /claim_conflict/);
  assert.equal(repo.materialize("leased", 1, due, null, recoveredAt, { ...actor, role: "admin", actor_id: "scheduler" }, null, undefined,
    { owner: "scheduler_b", fence: second.claim_fence, occurrenceKey: JSON.stringify([definition.schedule_id, due]) }).duplicate, false);
});

test("claim後のpauseとauthorization expiryをclaim時にも再確認する", () => {
  const { repo, clock } = setup();
  const due = "2026-09-05T00:01:00Z";
  repo.create("paused", once(due), due, actor, clock.now());
  clock.set(due);
  const claim = repo.claimDue("scheduler_a", due)!;
  repo.transition("paused", 1, "pause", actor, due);
  assert.throws(() => repo.materialize("paused", 1, due, null, due, { ...actor, role: "admin", actor_id: "scheduler" }, null, undefined,
    { owner: "scheduler_a", fence: claim.claim_fence, occurrenceKey: JSON.stringify(["paused", due]) }), /revision_conflict/);

  const expiryDue = "2026-09-05T00:02:00Z";
  repo.create("expired", { ...once(expiryDue), expires_at: expiryDue }, expiryDue, actor, "2026-09-05T00:01:00Z");
  const expiryClaim = repo.claimDue("scheduler_a", expiryDue)!;
  assert.throws(() => repo.materialize("expired", 1, expiryDue, null, expiryDue, { ...actor, role: "admin", actor_id: "scheduler" }, null, undefined,
    { owner: "scheduler_a", fence: expiryClaim.claim_fence, occurrenceKey: JSON.stringify(["expired", expiryDue]) }), /authorization_expired/);
  assert.equal(repo.get("expired")?.state, "expired");
});

test("stable ID mismatchはevent/run/next_due transaction全体をrollbackする", () => {
  const { repo, database, raw, clock } = setup();
  const due = "2026-09-05T00:01:00Z";
  repo.create("mismatch", once(due), due, actor, clock.now());
  database.enqueue({ schema_version: 1, source: "dona_schedule", external_event_id: `schedule:v1:mismatch:${due}`,
    type: "schedule_due", occurred_at: due, subject: { bad: true }, payload: {}, reply_target: null });
  clock.set(due);
  const service = new SchedulerService(repo, clock, () => {}, logger, { owner: "scheduler_a" });
  assert.equal(service.runBatch(), 0);
  assert.equal((raw.prepare("SELECT count(*) n FROM schedule_runs").get() as { n: number }).n, 0);
  assert.equal(repo.get("mismatch")?.next_due, due);
});

test("shutdown releaseは自instanceのleaseだけを解放しrestartで永続runを重複させない", async () => {
  const { repo, raw, clock } = setup();
  const due = "2026-09-05T00:01:00Z";
  repo.create("restart", once(due), due, actor, clock.now());
  clock.set(due);
  const service = new SchedulerService(repo, clock, () => {}, logger, { owner: "scheduler_a", pollMilliseconds: 60_000 });
  service.start();
  await service.stop();
  const restarted = new SchedulerService(repo, clock, () => {}, logger, { owner: "scheduler_b" });
  restarted.runBatch();
  assert.equal((raw.prepare("SELECT count(*) n FROM schedule_runs").get() as { n: number }).n, 1);
});

test("system clock rewindとlarge jump後も同じoccurrenceを再物化しない", () => {
  const { repo, raw, clock } = setup();
  const first = "2026-09-05T00:01:00Z";
  repo.create("clock_jump", daily(first), first, actor, clock.now());
  const service = new SchedulerService(repo, clock, () => {}, logger, { owner: "scheduler_a", batchSize: 10 });
  clock.set("2026-09-08T00:01:00Z");
  assert.equal(service.runBatch(), 1);
  clock.set("2026-09-04T00:00:00Z");
  assert.equal(service.runBatch(), 0);
  clock.set("2026-09-08T00:01:00Z");
  service.runBatch();
  service.runBatch();
  service.runBatch();
  const rows = raw.prepare("SELECT occurrence_key FROM schedule_runs ORDER BY scheduled_for").all() as Array<{ occurrence_key: string }>;
  assert.equal(rows.length, new Set(rows.map((row) => row.occurrence_key)).size);
  assert.equal(rows.length, 1);
});
