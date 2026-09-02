import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { UpdateDatabase } from "../src/database.js";
import { currentSha, targetSha, tempPolicy } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

const sourceEventId = "evt_01M1ES03XY5CF8D9PM5CWX4SRV";
const approvalEventId = "evt_01M1ES03XY5CF8D9PM5CWX4SRX";
const replyTarget = { kind: "slack_thread" as const, workspace_id: "T_TEST", channel_id: "C_TEST", thread_ts: "1756722030.123456" };
const compatibility = { protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 2, app_schema_write: 2, rollback_safe: true };

describe("UpdateDatabase", () => {
  test("binds idempotent approval to the exact plan and detects payload mismatch", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    const db = new UpdateDatabase(path.join(policy.control_root, "updater.sqlite3"));
    const created = db.createPlan({ source_event_id: sourceEventId, reply_target: replyTarget }, {
      current_sha: currentSha, target_sha: targetSha, previous_sha: null,
      policy_version: policy.policy_version, compatibility, rollback_compatible: true,
    }, new Date("2026-09-02T00:00:00.000Z"));
    const duplicate = db.createPlan({ source_event_id: sourceEventId, reply_target: replyTarget }, {
      current_sha: currentSha, target_sha: targetSha, previous_sha: null,
      policy_version: policy.policy_version, compatibility, rollback_compatible: true,
    }, new Date("2026-09-02T00:00:01.000Z"));
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.row.request_id, created.row.request_id);
    assert.throws(() => db.createPlan({ source_event_id: sourceEventId, reply_target: { ...replyTarget, channel_id: "C_OTHER" } }, {
      current_sha: currentSha, target_sha: targetSha, previous_sha: null,
      policy_version: policy.policy_version, compatibility, rollback_compatible: true,
    }));
    assert.throws(() => db.approve({
      source_event_id: sourceEventId, reply_target: replyTarget, plan_id: created.plan.plan_id, plan_hash: "f".repeat(64), approval_id: "approval-1",
    }));
    const approved = db.approve({
      source_event_id: approvalEventId, reply_target: replyTarget, plan_id: created.plan.plan_id, plan_hash: created.plan.plan_hash, approval_id: "approval-1",
    });
    assert.equal(approved.row.state, "approved");
    assert.equal(approved.row.approval_event_id, approvalEventId);
    assert.equal(db.approve({
      source_event_id: approvalEventId, reply_target: replyTarget, plan_id: created.plan.plan_id, plan_hash: created.plan.plan_hash, approval_id: "approval-1",
    }).duplicate, true);
    db.close();
  });

  test("enforces single-flight, lease expiry, monotonic fence, stale mutation rejection, and durable outbox", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    const db = new UpdateDatabase(path.join(policy.control_root, "updater.sqlite3"));
    const make = (event: string, offset: number) => {
      const created = db.createPlan({ source_event_id: event, reply_target: replyTarget }, {
        current_sha: currentSha, target_sha: targetSha, previous_sha: null,
        policy_version: policy.policy_version, compatibility, rollback_compatible: true,
      }, new Date(1_788_307_200_000 + offset));
      db.approve({ source_event_id: event, reply_target: replyTarget, plan_id: created.plan.plan_id, plan_hash: created.plan.plan_hash, approval_id: `approval-${offset}` });
      return created.row.request_id;
    };
    const first = make(sourceEventId, 0);
    const secondEventId = "evt_01M1ES03XY5CF8D9PM5CWX4SRW";
    const second = make(secondEventId, 10);
    const now = new Date("2026-09-02T00:00:00.000Z");
    const claimed = db.claim(first, "controller-a", 1_000, now)!;
    assert.equal(claimed.fence, 1);
    assert.equal(claimed.state, "preparing");
    assert.equal(db.claim(second, "controller-b", 1_000, now), undefined);
    const reclaimed = db.claim(first, "controller-b", 1_000, new Date("2026-09-02T00:00:02.000Z"))!;
    assert.equal(reclaimed.fence, 2);
    assert.throws(() => db.assertLease(first, 1, "controller-a", new Date("2026-09-02T00:00:02.000Z")), /fencing token/);
    db.assertLease(first, 2, "controller-b", new Date("2026-09-02T00:00:02.500Z"));
    assert.throws(() => db.transition(first, 1, "staged", "stale"), /stale fencing/);
    db.transition(first, 2, "staged", "release_staged");
    db.transition(first, 2, "quiescing", "quiesce");
    db.transition(first, 2, "activating", "activate");
    db.transition(first, 2, "restarting", "restart");
    db.transition(first, 2, "verifying", "verify");
    db.terminal(first, 2, "succeeded", "done");
    assert.equal(db.outboxFor(first)?.external_event_id, `update:${first}:terminal:2`);
    assert.equal(db.claim(second, "controller-b", 1_000, new Date("2026-09-02T00:00:03.000Z"))?.state, "preparing");
    const cancelled = db.requestCancellation(second, secondEventId, replyTarget, "operator cancelled", new Date("2026-09-02T00:00:03.500Z"));
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.lease_owner, null);
    assert.equal(db.outboxFor(second)?.status, "pending");
    assert.ok(db.auditRows(first).length >= 8);
    db.close();
  });
});
