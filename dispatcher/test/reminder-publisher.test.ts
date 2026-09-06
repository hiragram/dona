import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { DispatcherDatabase } from "../src/database.js";
import type { Logger } from "../src/logger.js";
import { FakeClock } from "../src/scheduler/clock.js";
import { ReminderPublisher, type ReminderDelivery, type SlackReminderCommand } from "../src/scheduler/reminder-publisher.js";
import type { Actor, RevisionInput } from "../src/scheduler/repository.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const at = "2026-09-06T00:00:00Z";
const actor: Actor = { tenant_id: "T1", actor_id: "U1", role: "owner", source_event_id: null };
function setup(outcomes: (ReminderDelivery | Promise<ReminderDelivery>)[], overrides: Partial<RevisionInput> = {}, nextDue: string | null = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dona-reminder-")); roots.push(root);
  const database = new DispatcherDatabase(path.join(root, "db.sqlite"));
  const repo = database.scheduler.withCodecs({ recurrence: value => value, policy: value => value });
  const input: RevisionInput = {
    recurrence_json: `{"at":"${at}","kind":"once","version":1}\n`, policy_json: "{}", policy_version: 1,
    timezone: null, tzdb_version: null, authorization_id: "auth1", authorization_revision: 1,
    approver_id: "U1", approved_at: "2026-09-05T00:00:00Z", expires_at: "2026-09-07T00:00:00Z",
    action: "slack.reminder.post", target: { kind: "thread", workspace_id: "T1", channel_id: "C1", thread_ts: "1.000001" }, content: "確認してください", ...overrides,
  };
  repo.create("s1", input, at, actor, "2026-09-05T00:00:00Z");
  const run = repo.materialize("s1", 1, at, nextDue, at, actor).run;
  const commands: SlackReminderCommand[] = [];
  const publisher = new ReminderPublisher(repo, {
    async preflight() { return { outcome: "prepared" }; },
    async deliver(command) { commands.push(command); return await outcomes.shift()!; },
  }, new FakeClock(at), logger);
  return { database, repo, run, commands, publisher, input };
}

test("typed commandを1回送信してrun/outbox/auditを完了する", async () => {
  const { database, repo, run, commands, publisher } = setup([{ outcome: "accepted", receipt_id: "1.000002" }]);
  assert.equal(await publisher.publishOne(), true);
  assert.equal(commands.length, 1); assert.equal(commands[0]?.action, "slack.reminder.post");
  assert.equal(repo.getRun(run.run_id)?.status, "completed");
  assert.deepEqual((repo.auditHistory("s1") as { operation: string }[]).slice(-3).map(x => x.operation), ["outbox_request_started", "outbox_sent", "complete"]);
  assert.equal(await publisher.publishOne(), false); database.close();
});

test("429/5xx before-sendだけをretryし、曖昧writeは再送しない", async () => {
  for (const first of [
    { outcome: "not_accepted", code: "rate_limited", retry_after_seconds: 1 },
    { outcome: "not_accepted", code: "slack_server_error_before_send", retry_after_seconds: 1 },
  ] satisfies ReminderDelivery[]) {
    const state = setup([first]); await state.publisher.publishOne();
    const outbox = state.repo.claim(at); assert.equal(outbox, undefined); // retry is delayed
    state.database.close();
  }
  for (const code of ["timeout_after_send", "connection_reset"] as const) {
    const state = setup([{ outcome: "acceptance_unknown", code }]); await state.publisher.publishOne();
    assert.equal(state.repo.getRun(state.run.run_id)?.status, "needs_review");
    assert.equal(await state.publisher.publishOne(), false); state.database.close();
  }
});

test("claim後のpauseでconnectorを呼ばずoutboxを抑止する", async () => {
  const state = setup([{ outcome: "accepted", receipt_id: "1.000002" }]);
  state.repo.transition("s1", 1, "pause", actor, at);
  assert.equal(await state.publisher.publishOne(), false); assert.equal(state.commands.length, 0); state.database.close();
});

test("connector前のlocal command検証失敗はambiguousにしない", async () => {
  const state = setup([{ outcome: "accepted", receipt_id: "1.000002" }]);
  state.repo.reminderConstraints = () => undefined;
  assert.equal(await state.publisher.publishOne(), true);
  assert.equal(state.commands.length, 0);
  assert.equal(state.repo.getRun(state.run.run_id)?.status, "failed");
  assert.equal(state.repo.getRun(state.run.run_id)?.reason, null);
  state.database.close();
});

test("独立reminderをbounded concurrencyで配送開始する", async () => {
  let finishFirst!: (value: ReminderDelivery) => void;
  let finishSecond!: (value: ReminderDelivery) => void;
  const first = new Promise<ReminderDelivery>((resolve) => void (finishFirst = resolve));
  const second = new Promise<ReminderDelivery>((resolve) => void (finishSecond = resolve));
  const state = setup([first, second]);
  state.repo.create("s2", { ...state.input, authorization_id: "auth2" }, at, actor, "2026-09-05T00:00:00Z");
  state.repo.materialize("s2", 1, at, null, at, actor);
  state.publisher.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.commands.length, 2);
  finishFirst({ outcome: "accepted", receipt_id: "1.000002" });
  finishSecond({ outcome: "accepted", receipt_id: "1.000003" });
  await state.publisher.stop();
  state.database.close();
});

test("read-only preflight完了後までrequest-started fenceを立てない", async () => {
  const state = setup([]);
  let finishPreflight!: (value: ReminderDelivery) => void;
  let finishWrite!: (value: ReminderDelivery) => void;
  const preflight = new Promise<ReminderDelivery>((resolve) => void (finishPreflight = resolve));
  const write = new Promise<ReminderDelivery>((resolve) => void (finishWrite = resolve));
  const publisher = new ReminderPublisher(state.repo, { async preflight() { return await preflight; }, async deliver() { return await write; } }, new FakeClock(at), logger);
  const publishing = publisher.publishOne();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((state.repo.auditHistory("s1") as { operation: string }[]).some(row => row.operation === "outbox_request_started"), false);
  finishPreflight({ outcome: "prepared" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((state.repo.auditHistory("s1") as { operation: string }[]).some(row => row.operation === "outbox_request_started"), true);
  finishWrite({ outcome: "accepted", receipt_id: "1.000002" });
  await publishing;
  state.database.close();
});

test("認可preflight中の通常pauseでauthorizationをretireしない", async () => {
  const state = setup([], {
    recurrence_json: '{"interval":1,"kind":"daily","local_time":"09:00:00","start_date":"2026-09-06","timezone":"Asia/Tokyo","tzdb_version":"2025b","version":1}\n',
    timezone: "Asia/Tokyo", tzdb_version: "2025b",
  }, "2026-09-07T00:00:00Z");
  const publisher = new ReminderPublisher(state.repo, {
    async preflight() {
      state.repo.transition("s1", 1, "pause", actor, at);
      return { outcome: "authorization_unavailable", code: "authorization_check_failed", retry_after_seconds: 1 };
    },
    async deliver() { throw new Error("write must not run"); },
  }, new FakeClock(at), logger);
  await publisher.publishOne();
  assert.equal(state.repo.get("s1")?.state, "paused");
  assert.doesNotThrow(() => state.repo.transition("s1", state.repo.get("s1")!.revision, "resume", actor, at));
  state.database.close();
});

test("preflight決着の永続状態とauditにwrite fenceを残さない", async () => {
  const state = setup([]);
  const publisher = new ReminderPublisher(state.repo, {
    async preflight() { return { outcome: "authorization_unavailable", code: "authorization_check_failed", retry_after_seconds: 1 }; },
    async deliver() { throw new Error("write must not run"); },
  }, new FakeClock(at), logger);
  await publisher.publishOne();
  const audit = state.repo.auditHistory("s1") as { operation: string; after_json: string }[];
  assert.equal(audit.some(row => row.operation === "outbox_request_started"), false);
  const settled = audit.filter(row => row.operation === "outbox_authorization_unavailable").at(-1)!;
  assert.equal(JSON.parse(settled.after_json).outbox.request_started_at, null);
  state.database.close();
});

test("認可preflight中のpause後も確定revocationを継承する", async () => {
  const state = setup([], {
    recurrence_json: '{"interval":1,"kind":"daily","local_time":"09:00:00","start_date":"2026-09-06","timezone":"Asia/Tokyo","tzdb_version":"2025b","version":1}\n',
    timezone: "Asia/Tokyo", tzdb_version: "2025b",
  }, "2026-09-07T00:00:00Z");
  const publisher = new ReminderPublisher(state.repo, {
    async preflight() {
      state.repo.transition("s1", 1, "pause", actor, at);
      state.repo.transition("s1", state.repo.get("s1")!.revision, "resume", actor, at);
      return { outcome: "revoked", code: "owner_not_authorized" };
    },
    async deliver() { throw new Error("write must not run"); },
  }, new FakeClock(at), logger);
  await publisher.publishOne();
  assert.throws(() => state.repo.transition("s1", state.repo.get("s1")!.revision, "resume", actor, at), /authorization_expired/);
  state.database.close();
});
