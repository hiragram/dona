import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import Database from "better-sqlite3";

import { DispatcherDatabase } from "../src/database.js";
import type { Logger } from "../src/logger.js";
import type { EventEnvelope } from "../src/types.js";
import {
  renderUpdateNotification,
  type SlackNotificationPort,
  UpdateNotificationDatabase,
  UpdateNotificationWorker,
} from "../src/update-notification.js";
import { tempConfig, waitFor } from "./helpers.js";

const roots: string[] = [];
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function updateEnvelope(status: "succeeded" | "needs_review" = "succeeded", fence = 1): EventEnvelope {
  const requestId = "upd_01m1es03xy5cf8d9pm5cwx4srv";
  return {
    schema_version: 1,
    source: "dona_update",
    external_event_id: `update:${requestId}:terminal:${fence}`,
    type: `update_${status}`,
    occurred_at: "2026-09-03T00:00:00.000Z",
    subject: { request_id: requestId },
    payload: {
      request_id: requestId,
      update_status: status,
      current_sha: "1".repeat(40),
      target_sha: "2".repeat(40),
      previous_sha: null,
      plan_hash: "a".repeat(64),
      policy_version: "2026-09-03.2",
      rollback_compatible: true,
      active_sha: status === "succeeded" ? "2".repeat(40) : null,
      error: status === "needs_review" ? { code: "ambiguous_runtime_observation", message: null } : null,
    },
    reply_target: {
      kind: "slack_thread",
      workspace_id: "T_TEST",
      channel_id: "C_TEST",
      thread_ts: "1756722030.123456",
    },
  };
}

describe("UpdateNotificationWorker", () => {
  test("reports unhealthy when its notification database is no longer writable", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const events = new DispatcherDatabase(config.databasePath);
    const notifications = new UpdateNotificationDatabase(config.updateNotificationDatabasePath);
    const worker = new UpdateNotificationWorker(events, notifications, {
      async deliver() {
        return { outcome: "retryable", code: "unused", message: "unused" };
      },
    }, config, logger);
    assert.equal(worker.isHealthy(), true);
    notifications.close();
    assert.equal(worker.isHealthy(), false);
    events.close();
  });

  test("renders a correction after evidence reconciliation and rejects an inconsistent active SHA", () => {
    const rendered = renderUpdateNotification(updateEnvelope("succeeded", 2));
    assert.match(rendered.text, /確認の結果/);
    assert.equal(rendered.desiredSessionStatus, "active");
    const failed = updateEnvelope();
    failed.type = "update_failed";
    failed.payload.update_status = "failed";
    failed.payload.active_sha = "1".repeat(40);
    failed.payload.error = { code: "main_agent_blocked", message: null };
    const failedRendered = renderUpdateNotification(failed);
    assert.match(failedRendered.text, new RegExp("1{40}"));
    assert.equal(failedRendered.desiredSessionStatus, "suspended");
    const invalid = updateEnvelope();
    invalid.payload.active_sha = "1".repeat(40);
    assert.throws(() => renderUpdateNotification(invalid), /confirmed active SHA/);
    const cancelled = updateEnvelope("needs_review");
    cancelled.type = "update_cancelled";
    cancelled.payload.update_status = "cancelled";
    cancelled.payload.error = { code: "cancelled_by_operator", message: null };
    assert.match(renderUpdateNotification(cancelled).text, /稼働SHAの確認を伴わない/);
  });

  test("reports dona_update without sending it to the serial main-agent queue and publishes a Result Envelope", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const events = new DispatcherDatabase(config.databasePath);
    const notifications = new UpdateNotificationDatabase(config.updateNotificationDatabasePath);
    const event = events.enqueue(updateEnvelope()).row;
    assert.equal(events.nextAvailable(), undefined);
    const delivered: Record<string, unknown>[] = [];
    const slack: SlackNotificationPort = {
      async deliver(input) {
        delivered.push(input);
        return {
          outcome: "reported",
          receipt: {
            notification_id: input.notification_id as string,
            workspace_id: input.workspace_id as string,
            channel_id: input.channel_id as string,
            thread_ts: input.thread_ts as string,
            message_ts: "1788390700.384279",
            post_status: "created",
            session_status: "active",
          },
        };
      },
    };
    const worker = new UpdateNotificationWorker(events, notifications, slack, config, logger);
    worker.start();
    await waitFor(() => events.get(event.event_id)?.status === "completed");
    await worker.stop();
    assert.equal(delivered.length, 1);
    assert.equal(notifications.get(event.event_id)?.status, "reported");
    const result = JSON.parse(await fs.readFile(path.join(config.resultsDir, `${event.event_id}.json`), "utf8")) as Record<string, unknown>;
    assert.equal(result.status, "completed");
    assert.equal((result.actions as unknown[]).length, 2);
    events.close();
    notifications.close();
  });

  test("finishes a persisted Slack receipt after restart without posting again", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const events = new DispatcherDatabase(config.databasePath);
    const notifications = new UpdateNotificationDatabase(config.updateNotificationDatabasePath);
    const event = events.enqueue(updateEnvelope()).row;
    notifications.ensure(event, new Date("2026-09-03T00:00:01.000Z"));
    notifications.beginDelivery(event.event_id, new Date("2026-09-03T00:00:02.000Z"));
    notifications.markPosted(event.event_id, {
      notification_id: updateEnvelope().external_event_id,
      workspace_id: "T_TEST",
      channel_id: "C_TEST",
      thread_ts: "1756722030.123456",
      message_ts: "1788390700.384279",
      post_status: "created",
      session_status: "active",
    }, new Date("2026-09-03T00:00:03.000Z"));
    let calls = 0;
    const worker = new UpdateNotificationWorker(events, notifications, {
      async deliver() {
        calls += 1;
        return { outcome: "retryable", code: "must_not_call", message: "must not call" };
      },
    }, config, logger);
    worker.start();
    await waitFor(() => events.get(event.event_id)?.status === "completed");
    await worker.stop();
    assert.equal(calls, 0);
    const result = JSON.parse(await fs.readFile(path.join(config.resultsDir, `${event.event_id}.json`), "utf8")) as Record<string, unknown>;
    assert.equal(result.completed_at, "2026-09-03T00:00:03.000Z");
    events.close();
    notifications.close();
  });

  test("persists a permanent reporter rejection as needs_review with a failed Result Envelope", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const events = new DispatcherDatabase(config.databasePath);
    const notifications = new UpdateNotificationDatabase(config.updateNotificationDatabasePath);
    const event = events.enqueue(updateEnvelope("needs_review")).row;
    const worker = new UpdateNotificationWorker(events, notifications, {
      async deliver() {
        return { outcome: "permanent", code: "unknown_workspace", message: "Workspace is not configured" };
      },
    }, config, logger);
    worker.start();
    await waitFor(() => events.get(event.event_id)?.status === "needs_review");
    await worker.stop();
    assert.equal(notifications.get(event.event_id)?.status, "needs_review");
    assert.equal(events.get(event.event_id)?.last_error_code, "unknown_workspace");
    const result = JSON.parse(await fs.readFile(path.join(config.resultsDir, `${event.event_id}.json`), "utf8")) as Record<string, unknown>;
    assert.equal(result.status, "failed");
    events.close();
    notifications.close();
  });

  test("keeps a confirmed partial Slack receipt when metadata persistence fails", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const events = new DispatcherDatabase(config.databasePath);
    const notifications = new UpdateNotificationDatabase(config.updateNotificationDatabasePath);
    const event = events.enqueue(updateEnvelope()).row;
    const worker = new UpdateNotificationWorker(events, notifications, {
      async deliver(input) {
        return {
          outcome: "permanent",
          code: "metadata_not_persisted",
          message: "Slack omitted metadata",
          receipt: {
            notification_id: input.notification_id as string,
            workspace_id: input.workspace_id as string,
            channel_id: input.channel_id as string,
            thread_ts: input.thread_ts as string,
            message_ts: "1788390700.384279",
            post_status: "created",
            session_status: "active",
          },
        };
      },
    }, config, logger);
    worker.start();
    await waitFor(() => events.get(event.event_id)?.status === "needs_review");
    await worker.stop();
    const row = notifications.get(event.event_id)!;
    assert.equal(row.message_ts, "1788390700.384279");
    assert.equal(row.post_status, "created");
    const result = JSON.parse(await fs.readFile(path.join(config.resultsDir, `${event.event_id}.json`), "utf8")) as Record<string, unknown>;
    assert.equal(result.status, "failed");
    assert.equal((result.actions as unknown[]).length, 2);
    events.close();
    notifications.close();
  });

  test("recovers an unexpected ambiguous delivery and reconciles it before retrying", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const events = new DispatcherDatabase(config.databasePath);
    const notifications = new UpdateNotificationDatabase(config.updateNotificationDatabasePath);
    const event = events.enqueue(updateEnvelope()).row;
    let calls = 0;
    const worker = new UpdateNotificationWorker(events, notifications, {
      async deliver(input) {
        calls += 1;
        if (calls === 1) throw new Error("connection lost after possible post");
        return {
          outcome: "reported",
          receipt: {
            notification_id: input.notification_id as string,
            workspace_id: input.workspace_id as string,
            channel_id: input.channel_id as string,
            thread_ts: input.thread_ts as string,
            message_ts: "1788390700.384279",
            post_status: "existing",
            session_status: "active",
          },
        };
      },
    }, config, logger);
    worker.start();
    await waitFor(() => events.get(event.event_id)?.status === "completed");
    await worker.stop();
    assert.equal(calls, 2);
    assert.equal(notifications.get(event.event_id)?.status, "reported");
    events.close();
    notifications.close();
  });

  test("atomically migrates the notification database from schema 1", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const raw = new Database(config.updateNotificationDatabasePath);
    raw.exec(`
      CREATE TABLE update_notifications (
        event_id TEXT PRIMARY KEY,
        notification_id TEXT NOT NULL UNIQUE,
        request_id TEXT NOT NULL,
        terminal_fence INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        reply_target_json TEXT NOT NULL,
        rendered_text TEXT NOT NULL,
        desired_session_status TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        post_started_at TEXT,
        message_ts TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      PRAGMA user_version = 1;
    `);
    raw.close();

    const notifications = new UpdateNotificationDatabase(config.updateNotificationDatabasePath);
    notifications.close();
    const migrated = new Database(config.updateNotificationDatabasePath, { readonly: true });
    const columns = migrated.pragma("table_info(update_notifications)") as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "post_status"));
    assert.equal(migrated.pragma("user_version", { simple: true }), 2);
    migrated.close();
  });
});
