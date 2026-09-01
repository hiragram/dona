import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { afterEach, describe, test } from "node:test";

import { DispatcherApi } from "../src/api.js";
import { DispatcherDatabase } from "../src/database.js";
import type { Logger } from "../src/logger.js";
import { eventEnvelope, tempConfig } from "./helpers.js";

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

function request(socketPath: string, method: string, route: string, body?: unknown, contentType = "application/json") {
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method,
        path: route,
        headers: encoded ? { "content-type": contentType, "content-length": encoded.length } : undefined,
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
});
