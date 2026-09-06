import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, test } from "node:test";
import { DispatcherDatabase } from "../src/database.js";
import { ScheduleApiError, ScheduleApiService } from "../src/scheduler/api.js";
import { eventEnvelope, tempConfig } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))));
const recurrence = { version: 1, kind: "daily", start_date: "2026-09-02", local_time: "09:00:00", timezone: "Asia/Tokyo", tzdb_version: "2025b", interval: 1 };
const definition = (body = "確認してください") => ({ recurrence, action: { kind: "reminder", body } });

async function fixture() {
  const { root, config } = await tempConfig(); roots.push(root);
  const database = new DispatcherDatabase(config.databasePath);
  const first = database.enqueue(eventEnvelope("schedule-api-owner")).row;
  const otherEnvelope = eventEnvelope("schedule-api-other"); otherEnvelope.subject.actor_id = "U_OTHER";
  const other = database.enqueue(otherEnvelope).row;
  const otherThreadEnvelope = eventEnvelope("schedule-api-other-thread");
  otherThreadEnvelope.subject.thread_ts = "1756722031.123456";
  otherThreadEnvelope.reply_target = { kind: "slack_thread", workspace_id: "T_TEST", channel_id: "C_TEST", thread_ts: "1756722031.123456" };
  const otherThread = database.enqueue(otherThreadEnvelope).row;
  return { root, config, database, first, other, otherThread, api: new ScheduleApiService(database, () => new Date("2026-09-02T00:00:00Z")) };
}

test("preview/create/read/listはevent contextへ固定しsecret本文を投影しない", async () => {
  const { database, first, api } = await fixture();
  const preview = api.preview({ source_event_id: first.event_id, definition: definition(), after: "2026-09-02T00:00:00Z", before_or_equal: "2026-09-10T00:00:00Z", limit: 3 });
  assert.equal(preview.preview.occurrences.length, 3);
  assert.deepEqual(preview.target, { kind: "thread", workspace_id: "T_TEST", channel_id: "C_TEST", thread_ts: "1756722030.123456" });
  const created = api.create({ source_event_id: first.event_id, idempotency_key: "request-1", definition: definition() });
  assert.equal(created.duplicate, false);
  assert.equal(JSON.stringify(created).includes("確認してください"), false);
  const schedule = created.schedule as { schedule_id: string; revision: number };
  assert.equal((api.get(schedule.schedule_id, first.event_id).schedule as { revision: number }).revision, 1);
  assert.equal(api.list(first.event_id, 1).schedules.length, 1);
  assert.equal(api.create({ source_event_id: first.event_id, idempotency_key: "request-1", definition: definition() }).duplicate, true);
  assert.throws(() => api.create({ source_event_id: first.event_id, idempotency_key: "request-1", definition: definition("別本文") }), (error: unknown) => error instanceof ScheduleApiError && error.code === "idempotency_conflict");
  database.close();
});

test("別actorを拒否しrevision conflictと冪等transitionを区別する", async () => {
  const { database, first, other, otherThread, api } = await fixture();
  const created = api.create({ source_event_id: first.event_id, idempotency_key: "request-2", definition: definition() });
  const id = (created.schedule as { schedule_id: string }).schedule_id;
  assert.throws(() => api.get(id, other.event_id), /unauthorized/);
  assert.throws(() => api.get(id, otherThread.event_id), /unauthorized/);
  const paused = api.transition(id, "pause", { source_event_id: first.event_id, expected_revision: 1 });
  assert.equal(paused.duplicate, false);
  assert.equal(api.transition(id, "pause", { source_event_id: first.event_id, expected_revision: 1 }).duplicate, true);
  assert.throws(() => api.transition(id, "resume", { source_event_id: first.event_id, expected_revision: 1 }), (error: unknown) => error instanceof ScheduleApiError && error.code === "revision_conflict");
  api.update(id, { source_event_id: first.event_id, expected_revision: 2, definition: definition("更新後") });
  assert.throws(() => api.transition(id, "resume", { source_event_id: first.event_id, expected_revision: 2 }), (error: unknown) => error instanceof ScheduleApiError && error.code === "revision_conflict");
  database.close();
});

test("更新・pagination上限・DB reopen後の永続読取を検証する", async () => {
  const { config, database, first, api } = await fixture();
  const created = api.create({ source_event_id: first.event_id, idempotency_key: "request-3", definition: definition() });
  const id = (created.schedule as { schedule_id: string }).schedule_id;
  const updated = api.update(id, { source_event_id: first.event_id, expected_revision: 1, definition: definition("更新本文") });
  assert.equal((updated.schedule as { revision: number }).revision, 2);
  assert.throws(() => api.list(first.event_id, 101), /invalid_limit/);
  database.close();
  const reopened = new DispatcherDatabase(config.databasePath);
  const reopenedApi = new ScheduleApiService(reopened, () => new Date("2026-09-02T00:00:00Z"));
  assert.equal((reopenedApi.get(id, first.event_id).schedule as { revision: number }).revision, 2);
  reopened.close();
});

test("失効したsource event authorizationではwriteを拒否する", async () => {
  const { database, first } = await fixture();
  const api = new ScheduleApiService(database, () => new Date("2026-10-02T00:00:00Z"));
  assert.throws(() => api.create({ source_event_id: first.event_id, idempotency_key: "expired", definition: { ...definition(), recurrence: { ...recurrence, start_date: "2026-10-02" } } }), (error: unknown) => error instanceof ScheduleApiError && error.code === "invalid_authorization");
  database.close();
});

test("古いrecurrence anchorをcreate時に拒否し本文上限をcode pointで数える", async () => {
  const { database, first, api } = await fixture();
  assert.throws(() => api.create({ source_event_id: first.event_id, idempotency_key: "old-anchor", definition: { ...definition(), recurrence: { ...recurrence, start_date: "2026-09-01" } } }), /invalid_creation_time/);
  const created = api.create({ source_event_id: first.event_id, idempotency_key: "emoji", definition: definition("😀".repeat(1500)) });
  assert.equal(created.duplicate, false);
  database.close();
});
