import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { UpdaterApi } from "../src/api.js";
import type { UpdateController } from "../src/controller.js";
import { UpdateDatabase } from "../src/database.js";
import type { Logger } from "../src/ports.js";

const logger: Logger = { info() {}, warn() {}, error() {} };

function request(socketPath: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const operation = http.request({ socketPath, path: "/health/version", method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      }));
    });
    operation.once("error", reject);
    operation.end();
  });
}

test("Updater version health requires both the service loop and writable persistence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-updater-api-"));
  const socketPath = path.join(root, "updater.sock");
  const database = new UpdateDatabase(path.join(root, "updater.sqlite3"));
  let running = true;
  const api = new UpdaterApi(
    socketPath,
    undefined as unknown as UpdateController,
    database,
    { isRunning: () => running, wake() {} },
    logger,
    "2".repeat(40),
  );
  try {
    await api.start();
    let response = await request(socketPath);
    assert.equal(response.status, 200);
    assert.equal(response.body.build_sha, "2".repeat(40));
    assert.equal(response.body.update_schema, 3);
    running = false;
    assert.equal((await request(socketPath)).status, 503);
    running = true;
    database.close();
    response = await request(socketPath);
    assert.equal(response.status, 503);
  } finally {
    await api.stop();
    try {
      database.close();
    } catch {
      // The test deliberately closes persistence before the final health probe.
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
