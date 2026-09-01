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

function request(socketPath: string, route: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method: "GET" }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end();
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
      },
      { healthReady: async () => dispatcherReady },
      logger,
    );
    await server.start();
    assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o600);
    assert.equal(await request(socketPath, "/health/live"), 200);
    assert.equal(await request(socketPath, "/health/ready"), 503);
    socketReady = true;
    dispatcherReady = true;
    assert.equal(await request(socketPath, "/health/ready"), 200);
    await server.stop();
  });
});
