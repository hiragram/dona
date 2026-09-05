import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { DispatcherApi } from "../src/api.js";
import { DispatcherDatabase } from "../src/database.js";
import type { Logger } from "../src/logger.js";
import { canonicalJobPayloadSha256, parseCreateJobRequest, stableStringify } from "../src/validation.js";
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

function requestAndDropResponseBody(socketPath: string, route: string, body: unknown): Promise<void> {
  const encoded = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method: "POST",
        path: route,
        headers: { "content-type": "application/json", "content-length": String(encoded.length) },
      },
      (response) => {
        response.once("error", () => {});
        response.destroy();
        resolve();
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
    assert.equal(created.body.outcome, "created");
    assert.equal(created.body.duplicate, false);
    const job = created.body.job as Record<string, unknown>;
    assert.match(String(job.job_id), /^job_/);
    assert.equal(job.job_key, "legacy-default");
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
    const reconciled = await request(
      config.socketPath,
      "GET",
      `/v1/events/${accepted.body.event_id}/jobs?job_key=legacy-default`,
    );
    assert.equal(reconciled.status, 200);
    assert.equal((reconciled.body.jobs as Array<Record<string, unknown>>)[0]?.job_id, job.job_id);
    assert.equal(JSON.stringify(reconciled.body).includes(config.jobsWorkspaceRoot), false);
    assert.equal(JSON.stringify(reconciled.body).includes("リポジトリを調査する"), false);
    await api.stop();
    database.close();
  });

  test("converges concurrent keyed creates and exposes stable conflict and closed-group errors", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    let jobWakeCount = 0;
    const api = new DispatcherApi(
      database,
      { isRunning: () => true, wake() {} },
      { ...jobs, wake: () => void (jobWakeCount += 1) },
      config,
      logger,
    );
    await api.start();
    const accepted = await request(config.socketPath, "POST", "/v1/events", eventEnvelope("Ev-keyed-job-api"));
    const sourceEventId = String(accepted.body.event_id);
    const createBody = {
      source_event_id: sourceEventId,
      job_key: "report.daily",
      objective: "  prepare report  ",
      workspace: { kind: "scratch", ignored: true },
      ignored: true,
    };
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () => request(config.socketPath, "POST", "/v1/jobs", createBody)),
    );
    assert.deepEqual(attempts.map(({ status }) => status).sort(), [200, 200, 200, 200, 202]);
    assert.deepEqual(new Set(attempts.map(({ body }) => (body.job as Record<string, unknown>).job_id)).size, 1);
    assert.deepEqual(new Set(attempts.map(({ body }) => body.outcome)), new Set(["created", "reused"]));
    assert.equal(database.listEventJobs(sourceEventId).length, 1);
    assert.equal(jobWakeCount, 5);

    const conflict = await request(config.socketPath, "POST", "/v1/jobs", {
      ...createBody,
      objective: "different report",
    });
    assert.equal(conflict.status, 409);
    assert.equal((conflict.body.error as Record<string, unknown>).code, "job_idempotency_conflict");
    assert.equal(database.listEventJobs(sourceEventId).length, 1);

    const second = await request(config.socketPath, "POST", "/v1/jobs", {
      ...createBody,
      job_key: "report.secondary",
      objective: "prepare another report",
    });
    assert.equal(second.status, 202);
    assert.notEqual(
      (second.body.job as Record<string, unknown>).job_id,
      (attempts[0]!.body.job as Record<string, unknown>).job_id,
    );
    const allJobs = await request(config.socketPath, "GET", `/v1/events/${sourceEventId}/jobs`);
    assert.equal((allJobs.body.jobs as unknown[]).length, 2);
    const trimmedLookup = await request(
      config.socketPath,
      "GET",
      `/v1/events/${sourceEventId}/jobs?job_key=%20report.daily%20`,
    );
    assert.equal((trimmedLookup.body.jobs as Array<Record<string, unknown>>)[0]?.job_key, "report.daily");

    database.sealJobGroup(sourceEventId);
    const reusedAfterSeal = await request(config.socketPath, "POST", "/v1/jobs", {
      source_event_id: sourceEventId,
      job_key: "report.daily",
      objective: "prepare report",
      workspace: { kind: "scratch" },
    });
    assert.equal(reusedAfterSeal.status, 200);
    assert.equal(reusedAfterSeal.body.outcome, "reused");
    const closed = await request(config.socketPath, "POST", "/v1/jobs", {
      ...createBody,
      job_key: "report.after-seal",
    });
    assert.equal(closed.status, 409);
    assert.equal((closed.body.error as Record<string, unknown>).code, "job_group_closed");
    assert.equal((await request(config.socketPath, "POST", "/v1/jobs", {
      ...createBody,
      job_key: "legacy-default",
    })).status, 400);
    await api.stop();
    database.close();
  });

  test("returns a stable quota error and logs only bounded resource fields", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    config.jobsPerEventMax = 1;
    const database = new DispatcherDatabase(config.databasePath, {
      jobsPerEventMax: config.jobsPerEventMax,
      jobObjectiveTotalMaxBytes: config.jobObjectiveTotalMaxBytes,
    });
    const warnings: Array<Record<string, unknown>> = [];
    const quotaLogger: Logger = {
      debug() {}, info() {}, error() {},
      warn(message, fields) {
        if (message === "Job creation rejected by resource limit") warnings.push(fields ?? {});
      },
    };
    const api = new DispatcherApi(
      database,
      { isRunning: () => true, wake() {} },
      jobs,
      config,
      quotaLogger,
    );
    await api.start();
    const accepted = await request(config.socketPath, "POST", "/v1/events", eventEnvelope("Ev-job-quota-api"));
    const sourceEventId = String(accepted.body.event_id);
    const requestBody = {
      source_event_id: sourceEventId,
      job_key: "private.key",
      objective: "private objective",
      workspace: { kind: "scratch" },
    };
    assert.equal((await request(config.socketPath, "POST", "/v1/jobs", requestBody)).status, 202);
    assert.equal((await request(config.socketPath, "POST", "/v1/jobs", requestBody)).status, 200);
    const rejected = await request(config.socketPath, "POST", "/v1/jobs", {
      ...requestBody,
      job_key: "private.second",
    });

    assert.equal(rejected.status, 409);
    assert.equal((rejected.body.error as Record<string, unknown>).code, "job_group_limit_exceeded");
    assert.deepEqual(warnings, [{
      error_code: "job_group_limit_exceeded",
      resource: "jobs_per_event",
      current_value: 1,
      attempted_value: 2,
      limit_value: 1,
    }]);
    assert.equal(JSON.stringify(warnings).includes("private"), false);
    assert.equal(database.listEventJobs(sourceEventId).length, 1);
    await api.stop();
    database.close();
  });

  test("recovers a committed job after the create response body is lost without resending the write", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    let jobWakeCount = 0;
    const api = new DispatcherApi(
      database,
      { isRunning: () => true, wake() {} },
      { ...jobs, wake: () => void (jobWakeCount += 1) },
      config,
      logger,
    );
    await api.start();
    const accepted = await request(config.socketPath, "POST", "/v1/events", eventEnvelope("Ev-lost-job-response"));
    const sourceEventId = String(accepted.body.event_id);

    const createBody = {
      source_event_id: sourceEventId,
      job_key: "response.lost",
      objective: "recover through read-only lookup",
      workspace: { kind: "scratch" },
    };
    await requestAndDropResponseBody(config.socketPath, "/v1/jobs", createBody);
    const persisted = database.listEventJobs(sourceEventId, "response.lost");
    assert.equal(persisted.length, 1);
    assert.equal(jobWakeCount, 1);

    const reconciled = await request(
      config.socketPath,
      "GET",
      `/v1/events/${sourceEventId}/jobs?job_key=response.lost&canonical_payload_sha256=${
        canonicalJobPayloadSha256(parseCreateJobRequest(createBody))
      }`,
    );
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.reconciliation, "matched");
    assert.equal((reconciled.body.jobs as Array<Record<string, unknown>>)[0]?.job_id, persisted[0]?.job_id);
    const conflict = await request(
      config.socketPath,
      "GET",
      `/v1/events/${sourceEventId}/jobs?job_key=response.lost&canonical_payload_sha256=${"0".repeat(64)}`,
    );
    assert.equal(conflict.body.reconciliation, "conflict");
    const notFound = await request(
      config.socketPath,
      "GET",
      `/v1/events/${sourceEventId}/jobs?job_key=missing&canonical_payload_sha256=${"0".repeat(64)}`,
    );
    assert.equal(notFound.body.reconciliation, "not_found");
    assert.equal((await request(
      config.socketPath,
      "GET",
      `/v1/events/${sourceEventId}/jobs?canonical_payload_sha256=${"0".repeat(64)}`,
    )).status, 400);
    assert.equal(database.listEventJobs(sourceEventId).length, 1);
    assert.equal(jobWakeCount, 1);
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
    const version = await request(config.socketPath, "GET", "/health/version");
    assert.deepEqual(
      {
        app_schema: version.body.app_schema,
        app_schema_read_min: version.body.app_schema_read_min,
        app_schema_read_max: version.body.app_schema_read_max,
        app_schema_write: version.body.app_schema_write,
      },
      { app_schema: 3, app_schema_read_min: 2, app_schema_read_max: 3, app_schema_write: 3 },
    );
    assert.equal(JSON.stringify(version.body).includes(config.databasePath), false);
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
});
