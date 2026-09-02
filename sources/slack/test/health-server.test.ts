import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { SlackHealthServer } from "../src/health-server.js";
import type { SlackLogger } from "../src/logger.js";

const roots: string[] = [];
const logger: SlackLogger = { debug() {}, info() {}, warn() {}, error() {} };
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function request(socketPath: string, route: string, method = "GET", body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      path: route,
      method,
      headers: encoded ? { "content-type": "application/json", "content-length": encoded.length } : undefined,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      }));
    });
    req.once("error", reject);
    req.end(encoded);
  });
}

describe("SlackHealthServer", () => {
  test("separates liveness from Socket Mode and Dispatcher readiness", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-slack-health-"));
    roots.push(root);
    const socketPath = path.join(root, "run", "slack.sock");
    let socketReady = false;
    let dispatcherReady = false;
    const server = new SlackHealthServer(
      socketPath,
      {
        isSocketReady: () => socketReady,
        isStopping: () => false,
        connectionStates: () => ({ company: socketReady ? "connected" : "disconnected" }),
        async quiesce() {},
        drainStatus: () => ({ quiescing: false, drained: false, in_flight: 0, unsafe_states: [] }),
      },
      { healthReady: async () => dispatcherReady },
      logger,
    );
    await server.start();
    assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o600);
    assert.equal((await request(socketPath, "/health/live")).status, 200);
    assert.equal((await request(socketPath, "/health/ready")).status, 503);
    socketReady = true;
    dispatcherReady = true;
    assert.equal((await request(socketPath, "/health/ready")).status, 200);
    const version = await request(socketPath, "/health/version");
    assert.equal(version.status, 200);
    assert.equal(version.body.build_sha, "development");
    await server.stop();
  });

  test("quiesces ingress through a typed request and reports bounded drain state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-slack-health-"));
    roots.push(root);
    const socketPath = path.join(root, "run", "slack.sock");
    let quiescing = false;
    const server = new SlackHealthServer(
      socketPath,
      {
        isSocketReady: () => !quiescing,
        isStopping: () => quiescing,
        connectionStates: () => ({ company: quiescing ? "disconnected" : "connected" }),
        async quiesce() { quiescing = true; },
        drainStatus: () => ({ quiescing, drained: quiescing, in_flight: 0, unsafe_states: [] }),
      },
      { healthReady: async () => true },
      logger,
      "2".repeat(40),
    );
    await server.start();
    const response = await request(socketPath, "/v1/admin/quiesce", "POST", {
      schema_version: 1,
      protocol: 1,
      operation_id: "upd_01m1es03xy5cf8d9pm5cwx4srv",
      target_sha: "2".repeat(40),
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.drained, true);
    assert.equal((await request(socketPath, "/health/version")).status, 503);
    await server.stop();
  });
});
