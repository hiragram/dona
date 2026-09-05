// #6 の独立PRをmergeせず、exact checkoutの実codecでstorage portを検証する。
// 第1引数: #6 checkoutのdispatcher/src/scheduler。統合後は引数省略で同じsourceを使用できる。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { DispatcherDatabase } from "../src/database.js";
import type { Actor, RevisionInput } from "../src/scheduler/repository.js";
const domainRoot = process.argv[2] ?? fileURLToPath(new URL("../src/scheduler", import.meta.url));
const recurrence = await import(pathToFileURL(path.resolve(domainRoot, "recurrence.ts")).href);
const policy = await import(pathToFileURL(path.resolve(domainRoot, "policy.ts")).href);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-codec-test-"));
const filename = path.join(root, "db.sqlite");
const db = new DispatcherDatabase(filename);
const raw = new Database(filename);
try {
  const repo = db.scheduler.withCodecs({
    recurrence: text => recurrence.encodeRecurrence(recurrence.decodeRecurrence(text)),
    policy: text => policy.encodePolicy(policy.decodePolicy(text)),
  });
  const now = "2026-09-05T00:00:00Z";
  const due = "2026-09-05T00:01:00Z";
  const actor: Actor = { tenant_id: "T_TEST", actor_id: "U_TEST", role: "owner", source_event_id: null };
  const input: RevisionInput = {
    recurrence_json: recurrence.encodeRecurrence({ kind: "once", version: 1, at: due }),
    policy_json: fs.readFileSync(new URL("../../docs/adr/fixtures/scheduler-v1/policy.json", import.meta.url), "utf8"),
    policy_version: 1, timezone: null, tzdb_version: null,
    authorization_id: "auth_1", authorization_revision: 1, approver_id: "U_TEST", approved_at: now,
    expires_at: "2026-09-06T00:00:00Z", action: "slack.reminder.post",
    target: { kind: "owner_dm", workspace_id: "T_TEST", channel_id: "D_TEST", owner_id: "U_TEST" }, content: "接続確認",
  };
  assert.throws(() => db.scheduler.create("missing_codec", input, due, actor, now), /domain_codecs_required/);
  for (const bad of [input.recurrence_json.replace('"version":1', '"version":2'), '{"kind":"once","kind":"daily"}', '{}']) {
    assert.throws(() => repo.create("invalid", { ...input, recurrence_json: bad }, due, actor, now));
  }
  assert.throws(() => repo.create("invalid", { ...input, policy_json: input.policy_json.replace('"max_attempts":3', '"max_attempts":4') }, due, actor, now));
  repo.create("real_codec", input, due, actor, now);
  const stored = raw.prepare("SELECT recurrence_json, policy_json, target_json FROM schedule_revisions").get() as Record<string, string>;
  assert.equal(stored.recurrence_json, input.recurrence_json);
  assert.equal(stored.policy_json, input.policy_json);
  assert.deepEqual(JSON.parse(stored.target_json!), input.target);
  const first = repo.materialize("real_codec", 1, due, null, due, actor);
  assert.equal(repo.materialize("real_codec", 1, due, null, due, actor).run.run_id, first.run.run_id);
  assert.equal((raw.prepare("SELECT count(*) AS n FROM schedules").get() as { n: number }).n, 1);
  console.log("実codec接続: canonical bytes/未知version/重複key/policy改変/owner_dm/物化一意性を確認");
} finally { raw.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); }
