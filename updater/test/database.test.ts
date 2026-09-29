import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import Database from "better-sqlite3";

import { UpdateDatabase } from "../src/database.js";
import { currentSha, targetSha, tempPolicy } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

const sourceEventId = "evt_01M1ES03XY5CF8D9PM5CWX4SRV";
const approvalEventId = "evt_01M1ES03XY5CF8D9PM5CWX4SRX";
const replyTarget = { kind: "slack_thread" as const, workspace_id: "T_TEST", channel_id: "C_TEST", thread_ts: "1756722030.123456" };
const inventory = { schema_version: 1 as const, control_plane_build_sha: targetSha, dispatcher_schema: 2, app_schema: 2, dispatcher_protocol: 1, policy_version: "2026-09-03.2", launchd: { dispatcher_registered: true, slack_registered: true, identity_digest: "a".repeat(64) }, workers: { classes: {}, exception_digest: "b".repeat(64) }, pending: { updates: 0, update_notifications: 0, events: 0, jobs: 0, schedules: 0, notifications: 0, digest: "c".repeat(64) } };
const compatibility = { protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 2, app_schema_write: 2, rollback_safe: true };

describe("UpdateDatabase", () => {
  test("retains release evidence until a successful update notification is reported", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    const db = new UpdateDatabase(path.join(policy.control_root, "updater.sqlite3"));
    const created = db.createPlan({ source_event_id: sourceEventId, reply_target: replyTarget }, {
      current_sha: currentSha, target_sha: targetSha, previous_sha: null,
      policy_version: policy.policy_version, compatibility, rollback_compatible: true, inventory,
    }, new Date("2026-09-02T00:00:00.000Z"));
    assert.deepEqual(db.retentionProtectedReleaseShas(), new Set([currentSha, targetSha]));
    const raw = new Database(path.join(policy.control_root, "updater.sqlite3"));
    raw.prepare("UPDATE update_requests SET state='succeeded',completed_at=? WHERE request_id=?")
      .run("2026-09-02T00:01:00.000Z", created.row.request_id);
    raw.prepare(`INSERT INTO update_outbox(outbox_id,request_id,external_event_id,payload_json,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run("outbox_test",created.row.request_id,"update:test:terminal","{}","pending",
        "2026-09-02T00:01:00.000Z","2026-09-02T00:01:00.000Z");
    assert.deepEqual(db.retentionProtectedReleaseShas(), new Set([currentSha, targetSha]));
    raw.prepare("UPDATE update_outbox SET status='delivered',slack_reported_at=? WHERE outbox_id='outbox_test'")
      .run("2026-09-02T00:02:00.000Z");
    assert.deepEqual(db.retentionProtectedReleaseShas(), new Set());
    raw.prepare("UPDATE update_requests SET state='rolled_back' WHERE request_id=?").run(created.row.request_id);
    assert.deepEqual(db.retentionProtectedReleaseShas(new Date("2026-09-20")), new Set([currentSha, targetSha]));
    assert.deepEqual(db.retentionProtectedReleaseShas(new Date("2026-10-20")), new Set());
    raw.close();
    db.close();
  });

  test("persists the exact inventory and rejects expired approval while retaining terminal evidence", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    const databasePath = path.join(policy.control_root, "updater.sqlite3");
    let db = new UpdateDatabase(databasePath);
    const at = new Date("2026-09-02T00:00:00.000Z");
    const material = { current_sha: currentSha, target_sha: targetSha, previous_sha: null,
      policy_version: policy.policy_version, compatibility, rollback_compatible: true, inventory };
    const created = db.createPlan({ source_event_id: sourceEventId, reply_target: replyTarget }, material, at);
    const originalHash = created.plan.plan_hash;
    db.close();
    db = new UpdateDatabase(databasePath);
    assert.equal(db.createPlan({ source_event_id: sourceEventId, reply_target: replyTarget }, material, at).plan.plan_hash, originalHash);
    assert.equal(db.get(created.row.request_id)?.inventory_revision, created.plan.inventory_revision);
    const approval = { source_event_id: approvalEventId, reply_target: replyTarget,
      plan_id: created.plan.plan_id, plan_hash: originalHash, approval_id: "explicit-intent" };
    assert.throws(() => db.approve(approval, new Date("2026-09-02T00:15:00.000Z")), /exact_plan_expired/);
    assert.equal(db.get(created.row.request_id)?.state, "failed");
    assert.equal(db.get(created.row.request_id)?.last_error_code, "exact_plan_expired");
    assert.equal(db.outboxFor(created.row.request_id)?.status, "pending");
    assert.throws(() => db.approve(approval, new Date("2026-09-02T00:14:59.000Z")), /exact_plan_expired/);
    db.close();
  });

  test("expires an unapproved plan once and permits a new plan after terminal notification settles", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    const db = new UpdateDatabase(path.join(policy.control_root, "updater.sqlite3"));
    const material = { current_sha: currentSha, target_sha: targetSha, previous_sha: null,
      policy_version: policy.policy_version, compatibility, rollback_compatible: true, inventory };
    const first = db.createPlan({ source_event_id: sourceEventId, reply_target: replyTarget }, material,
      new Date("2026-09-02T00:00:00.000Z"));
    assert.equal(db.expireAwaitingApproval(new Date("2026-09-02T00:15:00.000Z")), 1);
    assert.equal(db.expireAwaitingApproval(new Date("2026-09-02T00:15:01.000Z")), 0);
    assert.equal(db.nonTerminalCount(), 0);
    assert.equal(db.get(first.row.request_id)?.fence, 0);
    const secondEventId = "evt_01M1ES03XY5CF8D9PM5CWX4SRY";
    assert.throws(() => db.createPlan({ source_event_id: secondEventId, reply_target: replyTarget }, material,
      new Date("2026-09-02T00:15:02.000Z")), /terminal notification is not settled/);
    const outbox = db.markOutboxDelivering(db.outboxFor(first.row.request_id)!.outbox_id);
    db.markOutboxDelivered(outbox.outbox_id, "evt_expired_terminal");
    db.markOutboxReported(outbox.outbox_id);
    const second = db.createPlan({ source_event_id: secondEventId, reply_target: replyTarget }, material,
      new Date("2026-09-02T00:15:03.000Z"));
    assert.equal(second.duplicate, false);
    db.close();
  });

  test("旧schema由来でinventory期限がない承認待ちplanをterminal化する", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    const databasePath = path.join(policy.control_root, "updater.sqlite3");
    const db = new UpdateDatabase(databasePath);
    const created = db.createPlan({ source_event_id: sourceEventId, reply_target: replyTarget }, {
      current_sha: currentSha, target_sha: targetSha, previous_sha: null,
      policy_version: policy.policy_version, compatibility, rollback_compatible: true, inventory,
    }, new Date("2026-09-02T00:00:00.000Z"));
    const raw = new Database(databasePath);
    raw.prepare("UPDATE update_requests SET inventory_json = NULL, inventory_revision = NULL, approval_expires_at = NULL WHERE request_id = ?")
      .run(created.row.request_id);
    raw.close();
    assert.equal(db.expireAwaitingApproval(new Date("2026-09-02T00:00:01.000Z")), 1);
    assert.equal(db.get(created.row.request_id)?.last_error_code, "exact_plan_inventory_unavailable");
    assert.equal(db.nonTerminalCount(), 0);
    assert.equal(db.outboxFor(created.row.request_id)?.status, "pending");
    db.close();
  });

  test("emits a fence-zero terminal event when an awaiting plan is cancelled before claim", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    const db = new UpdateDatabase(path.join(policy.control_root, "updater.sqlite3"));
    const created = db.createPlan({ source_event_id: sourceEventId, reply_target: replyTarget }, {
      current_sha: currentSha, target_sha: targetSha, previous_sha: null,
      policy_version: policy.policy_version, compatibility, rollback_compatible: true, inventory,
    }, new Date("2026-09-02T00:00:00.000Z"));
    const cancelled = db.requestCancellation(
      created.row.request_id,
      approvalEventId,
      replyTarget,
      "operator cancelled",
      new Date("2026-09-02T00:00:01.000Z"),
    );
    assert.throws(() => db.approve({ source_event_id: approvalEventId, reply_target: replyTarget,
      plan_id: created.plan.plan_id, plan_hash: created.plan.plan_hash, approval_id: "late-intent" },
    new Date("2026-09-02T00:00:02.000Z")), /cancelled_plan_cannot_be_approved/);
    const outbox = db.outboxFor(cancelled.request_id)!;
    const envelope = JSON.parse(outbox.payload_json) as Record<string, any>;
    assert.equal(cancelled.fence, 0);
    assert.equal(outbox.external_event_id, `update:${cancelled.request_id}:terminal:0`);
    assert.equal(envelope.type, "update_cancelled");
    assert.equal(envelope.payload.update_status, "cancelled");
    assert.equal(envelope.payload.active_sha, null);
    assert.equal(envelope.payload.error.code, "cancelled_by_operator");
    db.close();
  });

  test("atomically migrates the released schema 1 database through schema 8", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    const databasePath = path.join(policy.control_root, "updater.sqlite3");
    await fs.mkdir(policy.control_root, { recursive: true });
    const raw = new Database(databasePath);
    raw.exec(`
      CREATE TABLE update_requests (
        request_id TEXT PRIMARY KEY,
        state TEXT NOT NULL
      );
      CREATE TABLE update_outbox (
        outbox_id TEXT PRIMARY KEY
      );
      PRAGMA user_version = 1;
    `);
    raw.close();

    const db = new UpdateDatabase(databasePath);
    db.assertReadableWritable();
    assert.equal(db.nonTerminalCount(), 0);
    db.close();
    const migrated = new Database(databasePath, { readonly: true });
    const requestColumns = migrated.pragma("table_info(update_requests)") as Array<{ name: string }>;
    const outboxColumns = migrated.pragma("table_info(update_outbox)") as Array<{ name: string }>;
    assert.ok(requestColumns.some((column) => column.name === "observed_active_sha"));
    assert.ok(outboxColumns.some((column) => column.name === "superseded_by_outbox_id"));
    assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_operations'").get());
    assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'update_diagnostic_logs'").get());
    assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'updater_writer_lease'").get());
    const diagnosticColumns = migrated.pragma("table_info(update_diagnostic_logs)") as Array<{ name: string }>;
    assert.ok(diagnosticColumns.some((column) => column.name === "content_sha256"));
    assert.equal(migrated.pragma("user_version", { simple: true }), 8);
    migrated.close();
  });

  test("opens legacy databases read-only without applying forward migrations", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    const databasePath = path.join(policy.control_root, "updater.sqlite3");
    await fs.mkdir(policy.control_root, { recursive: true });
    const raw = new Database(databasePath);
    raw.exec(`
      CREATE TABLE update_requests (request_id TEXT PRIMARY KEY, state TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
    raw.close();

    const reader = new UpdateDatabase(databasePath, { readonly: true });
    assert.equal(reader.accessMode(), "read_only");
    assert.deepEqual(reader.diagnosticLogs("upd_01m1es03xy5cf8d9pm5cwx4srv"), []);
    assert.deepEqual(reader.runtimeOperations("upd_01m1es03xy5cf8d9pm5cwx4srv"), []);
    assert.throws(() => reader.assertReadableWritable(), /readonly|read-only/i);
    reader.close();

    const unchanged = new Database(databasePath, { readonly: true });
    assert.equal(unchanged.pragma("user_version", { simple: true }), 1);
    assert.equal(unchanged.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'update_diagnostic_logs'").get(), undefined);
    unchanged.close();
  });

  test("read-only open rejects a database schema newer than this binary", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    const databasePath = path.join(policy.control_root, "updater.sqlite3");
    await fs.mkdir(policy.control_root, { recursive: true });
    const raw = new Database(databasePath);
    raw.pragma("user_version = 9");
    raw.close();
    assert.throws(() => new UpdateDatabase(databasePath, { readonly: true }), /newer than supported schema 8/);
  });

  test("binds idempotent approval to the exact plan and detects payload mismatch", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    const db = new UpdateDatabase(path.join(policy.control_root, "updater.sqlite3"));
    const created = db.createPlan({ source_event_id: sourceEventId, reply_target: replyTarget }, {
      current_sha: currentSha, target_sha: targetSha, previous_sha: null,
      policy_version: policy.policy_version, compatibility, rollback_compatible: true, inventory,
    }, new Date("2026-09-02T00:00:00.000Z"));
    const duplicate = db.createPlan({ source_event_id: sourceEventId, reply_target: replyTarget }, {
      current_sha: currentSha, target_sha: targetSha, previous_sha: null,
      policy_version: policy.policy_version, compatibility, rollback_compatible: true, inventory,
    }, new Date("2026-09-02T00:00:01.000Z"));
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.row.request_id, created.row.request_id);
    assert.throws(() => db.createPlan({ source_event_id: sourceEventId, reply_target: { ...replyTarget, channel_id: "C_OTHER" } }, {
      current_sha: currentSha, target_sha: targetSha, previous_sha: null,
      policy_version: policy.policy_version, compatibility, rollback_compatible: true, inventory,
    }));
    assert.throws(() => db.approve({
      source_event_id: sourceEventId, reply_target: replyTarget, plan_id: created.plan.plan_id, plan_hash: "f".repeat(64), approval_id: "approval-1",
    }, new Date("2026-09-02T00:00:01.000Z")));
    const approved = db.approve({
      source_event_id: approvalEventId, reply_target: replyTarget, plan_id: created.plan.plan_id, plan_hash: created.plan.plan_hash, approval_id: "approval-1",
    }, new Date("2026-09-02T00:00:02.000Z"));
    assert.equal(approved.row.state, "approved");
    assert.equal(approved.row.approval_event_id, approvalEventId);
    assert.equal(db.approve({
      source_event_id: approvalEventId, reply_target: replyTarget, plan_id: created.plan.plan_id, plan_hash: created.plan.plan_hash, approval_id: "approval-1",
    }, new Date("2026-09-02T00:00:03.000Z")).duplicate, true);
    db.close();
  });

  test("enforces single-flight, lease expiry, monotonic fence, stale mutation rejection, and durable outbox", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    const db = new UpdateDatabase(path.join(policy.control_root, "updater.sqlite3"));
    const make = (event: string, offset: number) => {
      const created = db.createPlan({ source_event_id: event, reply_target: replyTarget }, {
        current_sha: currentSha, target_sha: targetSha, previous_sha: null,
        policy_version: policy.policy_version, compatibility, rollback_compatible: true, inventory,
      }, new Date(1_788_307_200_000 + offset));
      db.approve({ source_event_id: event, reply_target: replyTarget, plan_id: created.plan.plan_id, plan_hash: created.plan.plan_hash, approval_id: `approval-${offset}` }, new Date(1_788_307_200_000 + offset + 1));
      return created.row.request_id;
    };
    const first = make(sourceEventId, 0);
    const secondEventId = "evt_01M1ES03XY5CF8D9PM5CWX4SRW";
    assert.throws(() => make(secondEventId, 10), /still open/);
    assert.equal(db.nonTerminalCount(), 1);
    const now = new Date("2026-09-02T00:00:00.000Z");
    const claimed = db.claim(first, "controller-a", 1_000, now)!;
    assert.equal(claimed.fence, 1);
    assert.equal(claimed.state, "preparing");
    db.prepareRuntimeOperation(first, claimed.fence, "stop_slack", "slack_adapter", currentSha, null);
    const reclaimed = db.claim(first, "controller-b", 1_000, new Date("2026-09-02T00:00:02.000Z"))!;
    assert.equal(reclaimed.fence, 2);
    assert.throws(
      () => db.recordRuntimeOperation(first, claimed.fence, "stop_slack", "observed", null, {}),
      /fencing token/,
    );
    assert.throws(
      () => db.prepareRuntimeOperation(first, claimed.fence, "stop_dispatcher", "dispatcher", currentSha, null),
      /fencing token/,
    );
    db.recordRuntimeOperation(first, reclaimed.fence, "stop_slack", "observed", null, {});
    assert.throws(() => db.assertLease(first, 1, "controller-a", new Date("2026-09-02T00:00:02.000Z")), /fencing token/);
    db.assertLease(first, 2, "controller-b", new Date("2026-09-02T00:00:02.500Z"));
    assert.throws(() => db.transition(first, 1, "staged", "stale"), /stale fencing/);
    db.transition(first, 2, "staged", "release_staged");
    db.transition(first, 2, "quiescing", "quiesce");
    db.transition(first, 2, "activating", "activate");
    db.transition(first, 2, "restarting", "restart");
    db.transition(first, 2, "verifying", "verify", {
      last_error_code: "transient_observation_timeout",
      last_error_message: "the runtime was still starting",
    });
    const succeeded = db.terminal(first, 2, "succeeded", "done");
    assert.equal(succeeded.last_error_code, null);
    assert.equal(succeeded.last_error_message, null);
    assert.equal(db.outboxFor(first)?.external_event_id, `update:${first}:terminal:2`);
    assert.throws(() => make(secondEventId, 10), /terminal notification is not settled/);
    const firstOutbox = db.markOutboxDelivering(db.outboxFor(first)!.outbox_id);
    db.markOutboxDelivered(firstOutbox.outbox_id, "evt_first_terminal");
    assert.equal(db.hasUnreportedTerminalNotification(), true);
    db.markOutboxReported(firstOutbox.outbox_id);
    assert.equal(db.hasUnreportedTerminalNotification(), false);
    const second = make(secondEventId, 10);
    assert.equal(db.claim(second, "controller-b", 1_000, new Date("2026-09-02T00:00:03.000Z"))?.state, "preparing");
    const cancelled = db.requestCancellation(second, secondEventId, replyTarget, "operator cancelled", new Date("2026-09-02T00:00:03.500Z"));
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.lease_owner, null);
    assert.equal(cancelled.observed_active_sha, null);
    assert.equal(db.hasUnreportedTerminalNotification(), true);
    assert.equal(db.outboxFor(second)?.status, "pending");
    assert.equal(db.nonTerminalCount(), 0);
    assert.ok(db.auditRows(first).length >= 8);
    db.close();
  });

  test("commits a needs-review evidence correction and its replacement outbox atomically", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    const db = new UpdateDatabase(path.join(policy.control_root, "updater.sqlite3"));
    const created = db.createPlan({ source_event_id: sourceEventId, reply_target: replyTarget }, {
      current_sha: currentSha,
      target_sha: targetSha,
      previous_sha: null,
      policy_version: policy.policy_version,
      compatibility,
      rollback_compatible: true,
      inventory,
    });
    db.approve({
      source_event_id: approvalEventId,
      reply_target: replyTarget,
      plan_id: created.plan.plan_id,
      plan_hash: created.plan.plan_hash,
      approval_id: "approval-correction",
    });
    let row = db.claim(created.row.request_id, "controller", 10_000)!;
    row = db.transition(row.request_id, row.fence, "staged", "staged");
    row = db.transition(row.request_id, row.fence, "quiescing", "quiescing");
    row = db.transition(row.request_id, row.fence, "activating", "activating");
    row = db.transition(row.request_id, row.fence, "restarting", "restarting");
    row = db.transition(row.request_id, row.fence, "verifying", "verifying");
    db.terminal(row.request_id, row.fence, "needs_review", "start_target_dispatcher_health_unavailable", {
      last_error_code: "start_target_dispatcher_health_unavailable",
      last_error_message: "unknown",
    });
    assert.deepEqual(db.reconcilableNeedsReview().map((candidate) => candidate.request_id), [row.request_id]);
    const originalOutbox = db.outboxFor(row.request_id)!;
    assert.equal(db.terminalOutboxSettledForCorrection(row.request_id), true);
    db.markOutboxDelivering(originalOutbox.outbox_id);
    assert.equal(db.terminalOutboxSettledForCorrection(row.request_id), false);
    assert.throws(
      () => db.completeEvidenceReconcile(row.request_id, "rolled_back", currentSha),
      /notification acceptance is not settled/,
    );
    db.markOutboxPending(originalOutbox.outbox_id, "Dispatcher authoritatively reported the event absent");
    assert.equal(db.terminalOutboxSettledForCorrection(row.request_id), false);
    db.markOutboxNeedsReview(originalOutbox.outbox_id, "Dispatcher definitively rejected the notification");
    assert.equal(db.terminalOutboxSettledForCorrection(row.request_id), true);
    const corrected = db.completeEvidenceReconcile(row.request_id, "rolled_back", currentSha);
    assert.equal(corrected.state, "rolled_back");
    assert.equal(corrected.fence, 2);
    assert.equal(corrected.observed_active_sha, currentSha);
    assert.equal(corrected.last_error_code, null);
    assert.equal(db.outboxFor(row.request_id)?.external_event_id, `update:${row.request_id}:terminal:2`);
    assert.deepEqual(db.pendingOutbox().map((outbox) => outbox.external_event_id), [
      `update:${row.request_id}:terminal:2`,
    ]);
    assert.equal(db.metrics().outbox_pending, 1);
    db.close();
  });
});
