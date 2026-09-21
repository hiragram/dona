import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { DispatcherDatabase, JobCreationError } from "../../src/database.js";
import { tempConfig } from "../helpers.js";

const owner = { instance_id: "instance", tenant_id: "tenant", principal_id: "principal" };
const input = (key: string, objective = "web command") => ({ ...owner, idempotency_key: key, objective, workspace: { kind: "scratch" as const } });

test("web submitはreply-free sourceから既存queue・Result pathへ一度だけadmitし再起動後もreuseする", async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  let db = new DispatcherDatabase(config.databasePath); const key = "a".repeat(64);
  const created = db.createWebJob(input(key), config.jobsWorkspaceRoot, config.jobResultsDir);
  assert.equal(created.outcome, "created"); assert.equal(created.row.source, "web"); assert.equal(created.row.status, "queued");
  assert.equal(created.row.channel_id, null); assert.equal(created.row.thread_ts, null); assert.equal(created.row.actor_id, owner.principal_id);
  assert.ok(created.row.result_path.startsWith(config.jobResultsDir));
  const source = db.get(created.row.source_event_id)!; assert.equal(source.source, "web"); assert.equal(source.reply_target_json, null); assert.equal(source.status, "completed");
  assert.equal(db.createWebJob(input(key), config.jobsWorkspaceRoot, config.jobResultsDir).outcome, "reused");
  assert.throws(() => db.createWebJob(input(key, "different private token"), config.jobsWorkspaceRoot, config.jobResultsDir),
    (error: unknown) => error instanceof JobCreationError && error.code === "job_idempotency_conflict" && !error.message.includes("private token"));
  db.close(); db = new DispatcherDatabase(config.databasePath);
  assert.equal(db.createWebJob(input(key), config.jobsWorkspaceRoot, config.jobResultsDir).outcome, "reused");
  db.beginWebJobCancellation(created.row.job_id, owner); db.markJobCancelled(created.row.job_id, "fixture");
  const notification = db.enqueueJobNotification(created.row.job_id);
  assert.equal(notification.row.event_id, source.event_id); assert.equal(db.getJob(created.row.job_id)!.completion_event_id, source.event_id);
  db.close();
});

test("web submitはowner quota、canonical concurrency、owner-bound cancel receiptをdurableにする", async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = new DispatcherDatabase(config.databasePath, { jobsPerEventMax: 1, jobObjectiveTotalMaxBytes: 400000 });
  const first = db.createWebJob(input("b".repeat(64)), config.jobsWorkspaceRoot, config.jobResultsDir);
  const peer = new DispatcherDatabase(config.databasePath, { jobsPerEventMax: 1, jobObjectiveTotalMaxBytes: 400000 });
  assert.equal(peer.createWebJob(input("b".repeat(64)), config.jobsWorkspaceRoot, config.jobResultsDir).outcome, "reused");
  assert.throws(() => db.createWebJob(input("c".repeat(64)), config.jobsWorkspaceRoot, config.jobResultsDir),
    (error: unknown) => error instanceof JobCreationError && error.code === "job_group_limit_exceeded");
  assert.throws(() => db.assertWebJobOwner(first.row.job_id, { ...owner, principal_id: "other" }), /web_job_owner_mismatch/);
  const cancelling = db.beginWebJobCancellation(first.row.job_id, owner); assert.equal(cancelling.status, "cancelling");
  db.markJobCancelled(first.row.job_id, "fixture"); const receiptId = "web_cancel_" + "d".repeat(64), payload = "e".repeat(64);
  const receipt = db.recordWebCancelReceipt(receiptId, payload, owner, first.row.job_id);
  assert.equal(db.getWebCommandReceipt(receiptId, owner)?.job_id, first.row.job_id);
  assert.equal(db.recordWebCancelReceipt(receiptId, payload, owner, first.row.job_id).receipt_id, receipt.receipt_id);
  assert.equal(db.getWebCommandReceipt(receiptId, { ...owner, principal_id: "other" }), undefined);
  peer.close(); db.close();
});
