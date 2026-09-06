import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { DispatcherApi } from "../src/api.js";
import { DispatcherDatabase } from "../src/database.js";
import type { Logger } from "../src/logger.js";
import { UpdaterClientError } from "../src/updater-client.js";
import { stableStringify } from "../src/validation.js";
import { eventEnvelope, tempConfig, waitFor } from "./helpers.js";

const roots: string[] = [];
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const jobs = {
  isRunning: () => true,
  wake() {},
  async steer() { throw new Error("not used"); },
  async cancel() { throw new Error("not used"); },
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function request(
  socketPath: string,
  method: string,
  route: string,
  body?: unknown,
  contentType = "application/json",
  extraHeaders: Record<string, string> = {},
) {
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method,
        path: route,
        headers: { ...extraHeaders, ...(encoded ? { "content-type": contentType, "content-length": String(encoded.length) } : {}) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
          }),
        );
      },
    );
    req.once("error", reject);
    req.end(encoded);
  });
}

describe("DispatcherApi", () => {
  test("persists before returning 202 and returns the same event for duplicates", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    let wakeCount = 0;
    const api = new DispatcherApi(
      database,
      { isRunning: () => true, wake: () => void (wakeCount += 1) },
      jobs,
      config,
      logger,
    );
    await api.start();
    const first = await request(config.socketPath, "POST", "/v1/events", eventEnvelope("Ev-1"));
    assert.equal(first.status, 202);
    assert.equal(database.list().length, 1);
    const duplicate = await request(config.socketPath, "POST", "/v1/events", eventEnvelope("Ev-1"));
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.event_id, first.body.event_id);
    assert.equal(database.list().length, 1);
    assert.equal(wakeCount, 2);
    assert.equal((await fs.stat(config.socketPath)).mode & 0o777, 0o600);
    assert.equal((await request(config.socketPath, "GET", "/health/ready")).status, 200);
    await api.stop();
    database.close();
  });

  test("rejects invalid media types and oversized bodies", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    config.requestMaxBytes = 20;
    const database = new DispatcherDatabase(config.databasePath);
    const api = new DispatcherApi(database, { isRunning: () => true, wake() {} }, jobs, config, logger);
    await api.start();
    assert.equal(
      (await request(config.socketPath, "POST", "/v1/events", eventEnvelope("Ev-1"), "text/plain")).status,
      415,
    );
    assert.equal((await request(config.socketPath, "POST", "/v1/events", eventEnvelope("Ev-1"))).status, 413);
    await api.stop();
    database.close();
  });

  test("creates and reads a durable background job over UDS", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    let jobWakeCount = 0;
    const jobController = { ...jobs, wake: () => void (jobWakeCount += 1) };
    const api = new DispatcherApi(
      database,
      { isRunning: () => true, wake() {} },
      jobController,
      config,
      logger,
    );
    await api.start();
    const accepted = await request(config.socketPath, "POST", "/v1/events", eventEnvelope("Ev-job-api"));
    const created = await request(config.socketPath, "POST", "/v1/jobs", {
      source_event_id: accepted.body.event_id,
      objective: "リポジトリを調査する",
      workspace: { kind: "github", repository: "owner/repo" },
    });
    assert.equal(created.status, 202);
    const job = created.body.job as Record<string, unknown>;
    assert.match(String(job.job_id), /^job_/);
    assert.equal(jobWakeCount, 1);
    const shown = await request(config.socketPath, "GET", `/v1/jobs/${job.job_id}`);
    assert.equal(shown.status, 200);
    assert.equal((shown.body.job as Record<string, unknown>).source_event_id, accepted.body.event_id);
    const listed = await request(
      config.socketPath,
      "GET",
      "/v1/jobs?workspace_id=T_TEST&channel_id=C_TEST&thread_ts=1756722030.123456",
    );
    assert.equal(listed.status, 200);
    assert.equal((listed.body.jobs as unknown[]).length, 1);
    await api.stop();
    database.close();
  });

  test("separates external events from authenticated dona_update injection and deduplicates completion", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    await fs.mkdir(path.dirname(config.updateInternalTokenPath), { recursive: true, mode: 0o700 });
    const token = "a".repeat(64);
    await fs.writeFile(config.updateInternalTokenPath, token, { mode: 0o600 });
    const database = new DispatcherDatabase(config.databasePath);
    const api = new DispatcherApi(database, { isRunning: () => true, wake() {} }, jobs, config, logger);
    await api.start();
    const envelope = {
      schema_version: 1,
      source: "dona_update",
      external_event_id: "update:upd_01m1es03xy5cf8d9pm5cwx4srv:terminal:1",
      type: "update_succeeded",
      occurred_at: "2026-09-02T00:00:00.000Z",
      subject: { request_id: "upd_01m1es03xy5cf8d9pm5cwx4srv" },
      payload: {
        request_id: "upd_01m1es03xy5cf8d9pm5cwx4srv",
        update_status: "succeeded",
        current_sha: "1".repeat(40),
        target_sha: "2".repeat(40),
        previous_sha: null,
        plan_hash: "a".repeat(64),
        policy_version: "2026-09-02.1",
        rollback_compatible: true,
        active_sha: "2".repeat(40),
        error: null,
      },
      reply_target: { kind: "slack_thread", workspace_id: "T_TEST", channel_id: "C_TEST", thread_ts: "1756722030.123456" },
    };
    assert.equal((await request(config.socketPath, "POST", "/v1/events", envelope)).status, 400);
    assert.equal((await request(config.socketPath, "POST", "/v1/internal/update-events", envelope)).status, 403);
    const first = await request(config.socketPath, "POST", "/v1/internal/update-events", envelope, "application/json", { "x-dona-update-token": token });
    const duplicate = await request(config.socketPath, "POST", "/v1/internal/update-events", envelope, "application/json", { "x-dona-update-token": token });
    assert.equal(first.status, 202);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.event_id, first.body.event_id);
    const mismatched = structuredClone(envelope);
    mismatched.payload.active_sha = "3".repeat(40);
    assert.equal((await request(
      config.socketPath,
      "POST",
      "/v1/internal/update-events",
      mismatched,
      "application/json",
      { "x-dona-update-token": token },
    )).status, 409);
    const payloadSha256 = createHash("sha256").update(stableStringify(envelope)).digest("hex");
    const lookup = await request(
      config.socketPath,
      "GET",
      `/v1/internal/update-events/lookup?external_event_id=${encodeURIComponent(envelope.external_event_id)}&payload_sha256=${payloadSha256}`,
      undefined,
      "application/json",
      { "x-dona-update-token": token },
    );
    assert.equal(lookup.body.exists, true);
    assert.equal((await request(
      config.socketPath,
      "GET",
      `/v1/internal/update-events/lookup?external_event_id=${encodeURIComponent(envelope.external_event_id)}&payload_sha256=${"f".repeat(64)}`,
      undefined,
      "application/json",
      { "x-dona-update-token": token },
    )).status, 409);
    await fs.chmod(config.updateInternalTokenPath, 0o644);
    assert.equal((await request(
      config.socketPath,
      "GET",
      `/v1/internal/update-events/lookup?external_event_id=${encodeURIComponent(envelope.external_event_id)}&payload_sha256=${payloadSha256}`,
      undefined,
      "application/json",
      { "x-dona-update-token": token },
    )).status, 403);
    await api.stop();
    database.close();
  });

  test("binds self-update planning to persisted event context and exposes terminal and quiesce barriers", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    let workerRunning = true;
    let jobsRunning = true;
    let finishQuiesce!: () => void;
    const quiesceMayFinish = new Promise<void>((resolve) => {
      finishQuiesce = resolve;
    });
    const calls: unknown[] = [];
    const updates = {
      async plan(input: unknown) { calls.push(input); return { schema_version: 1, plan: {} }; },
      async apply(input: unknown) { calls.push({ apply: input }); return { schema_version: 1, accepted: true }; },
      async status() { return { schema_version: 1, updates: [] }; },
      async cancel() { return { schema_version: 1, state: "cancelled" }; },
    };
    const api = new DispatcherApi(
      database,
      { isRunning: () => workerRunning, wake() {} },
      { ...jobs, isRunning: () => jobsRunning },
      config,
      logger,
      updates,
      { async quiesce() { await quiesceMayFinish; workerRunning = false; jobsRunning = false; } },
    );
    await api.start();
    const accepted = await request(config.socketPath, "POST", "/v1/events", eventEnvelope("Ev-update-plan"));
    const eventId = accepted.body.event_id as string;
    assert.equal((await request(config.socketPath, "GET", `/v1/events/${eventId}/terminal`)).body.terminal, false);
    assert.equal((await request(config.socketPath, "POST", "/v1/self-update/plan", { source_event_id: eventId })).status, 200);
    assert.deepEqual(calls, [{
      source_event_id: eventId,
      reply_target: { kind: "slack_thread", workspace_id: "T_TEST", channel_id: "C_TEST", thread_ts: "1756722030.123456" },
    }]);
    database.manualComplete(eventId);
    assert.equal((await request(config.socketPath, "GET", `/v1/events/${eventId}/terminal`)).body.terminal, true);
    assert.equal((await request(config.socketPath, "POST", "/v1/self-update/apply", {
      source_event_id: eventId,
      plan_id: "plan_01m1es03xy5cf8d9pm5cwx4srw",
      plan_hash: "a".repeat(64),
      approval_id: "approval-1",
    })).status, 202);
    assert.deepEqual(calls[1], { apply: {
      source_event_id: eventId,
      plan_id: "plan_01m1es03xy5cf8d9pm5cwx4srw",
      plan_hash: "a".repeat(64),
      approval_id: "approval-1",
      reply_target: { kind: "slack_thread", workspace_id: "T_TEST", channel_id: "C_TEST", thread_ts: "1756722030.123456" },
    } });
    const quiesced = await request(config.socketPath, "POST", "/v1/admin/quiesce", {
      schema_version: 1,
      protocol: 1,
      operation_id: "upd_01m1es03xy5cf8d9pm5cwx4srv",
      target_sha: "2".repeat(40),
    });
    assert.equal(quiesced.status, 202);
    assert.equal(quiesced.body.drained, false);
    finishQuiesce();
    await waitFor(() => !workerRunning && !jobsRunning);
    const drained = await request(config.socketPath, "GET", "/v1/admin/drain-status");
    assert.equal(drained.status, 200);
    assert.equal(drained.body.drained, true);
    assert.equal((await request(config.socketPath, "GET", "/health/version")).status, 503);
    assert.equal((await request(config.socketPath, "POST", "/v1/self-update/apply", {
      source_event_id: eventId,
      plan_id: "plan_01m1es03xy5cf8d9pm5cwx4srw",
      plan_hash: "a".repeat(64),
      approval_id: "approval-1",
    })).status, 503);
    await api.stop();
    database.close();
  });

  test("preserves structured Updater planning rejections", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const updates = {
      async plan() {
        throw new UpdaterClientError(409, "request_failed", "target_does_not_pass_fixed_ci_trust_gate");
      },
      async apply() { return { schema_version: 1 }; },
      async status() { return { schema_version: 1, updates: [] }; },
      async cancel() { return { schema_version: 1 }; },
    };
    const api = new DispatcherApi(
      database,
      { isRunning: () => true, wake() {} },
      jobs,
      config,
      logger,
      updates,
    );
    await api.start();
    const accepted = await request(config.socketPath, "POST", "/v1/events", eventEnvelope("Ev-update-rejected"));
    const rejected = await request(config.socketPath, "POST", "/v1/self-update/plan", {
      source_event_id: accepted.body.event_id,
    });
    assert.equal(rejected.status, 409);
    assert.deepEqual(rejected.body, {
      schema_version: 1,
      error: { code: "request_failed", message: "target_does_not_pass_fixed_ci_trust_gate" },
    });
    await api.stop();
    database.close();
  });

  test("exposes preview, CRUD and transition contracts over UDS", async () => {
    const { root, config } = await tempConfig(); roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const api = new DispatcherApi(database, { isRunning: () => true, wake() {} }, jobs, config, logger);
    await api.start();
    const event = await request(config.socketPath, "POST", "/v1/events", eventEnvelope("Ev-schedule-uds"));
    const definition = { recurrence: { version: 1, kind: "once", at: "2026-09-08T00:00:00Z" }, action: { kind: "reminder", body: "UDS確認" } };
    const preview = await request(config.socketPath, "POST", "/v1/schedules/preview", { source_event_id: event.body.event_id, definition, after: "2026-09-06T00:00:00Z", before_or_equal: "2026-09-09T00:00:00Z", limit: 10 });
    assert.equal(preview.status, 200);
    const invalid = await request(config.socketPath, "POST", "/v1/schedules/preview", { source_event_id: event.body.event_id, definition: { ...definition, recurrence: { version: 1, kind: "daily", start_date: "2026-09-01", local_time: "09:00:00", timezone: "Invalid/Zone", tzdb_version: "2025b", interval: 1 } }, after: "2026-09-06T00:00:00Z", before_or_equal: "2026-09-09T00:00:00Z", limit: 10 });
    assert.equal(invalid.status, 400);
    assert.equal((invalid.body.error as { code: string }).code, "invalid_timezone");
    const created = await request(config.socketPath, "POST", "/v1/schedules", { source_event_id: event.body.event_id, idempotency_key: "uds-create", definition });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const schedule = created.body.schedule as { schedule_id: string; revision: number };
    assert.equal((await request(config.socketPath, "GET", `/v1/schedules/${schedule.schedule_id}?source_event_id=${event.body.event_id}`)).status, 200);
    assert.equal((await request(config.socketPath, "GET", `/v1/schedules?source_event_id=${event.body.event_id}&limit=10`)).status, 200);
    assert.equal((await request(config.socketPath, "POST", `/v1/schedules/${schedule.schedule_id}/pause`, { source_event_id: event.body.event_id, expected_revision: 1 })).status, 200);
    assert.equal((await request(config.socketPath, "GET", `/v1/schedules/${schedule.schedule_id}/runs?source_event_id=${event.body.event_id}&limit=10`)).status, 200);
    assert.equal((await request(config.socketPath, "GET", `/v1/schedules/%ZZ?source_event_id=${event.body.event_id}`)).status, 400);
    await api.stop(); database.close();
  });
});
