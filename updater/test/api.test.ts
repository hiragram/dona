import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { releaseUpdaterSocket, reserveUpdaterSocket, UpdaterApi } from "../src/api.js";
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

test("atomic writer lease prevents a second server from unlinking the active socket", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-updater-api-writer-"));
  const socketPath = path.join(root, "updater.sock");
  const database = new UpdateDatabase(path.join(root, "updater.sqlite3"));
  const service = { isRunning: () => true, wake() {} };
  const first = new UpdaterApi(socketPath, undefined as unknown as UpdateController, database, service, logger);
  const second = new UpdaterApi(path.join(root, "second", "updater.sock"), undefined as unknown as UpdateController, database, service, logger);
  try {
    await first.start();
    await assert.rejects(second.start(), /updater_writer_already_active/);
    await second.stop();
    assert.equal((await request(socketPath)).status, 200);
  } finally {
    await first.stop();
    await second.stop();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("startup lock serializes stale socket recovery between concurrent servers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-updater-api-startup-"));
  const socketPath = path.join(root, "updater.sock");
  await fs.writeFile(socketPath, "stale", { mode: 0o600 });
  const results = await Promise.allSettled([
    reserveUpdaterSocket(socketPath),
    reserveUpdaterSocket(socketPath),
  ]);
  const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof reserveUpdaterSocket>>> => result.status === "fulfilled");
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  try {
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(String(rejected[0]!.reason), /updater_startup_lock_(?:active|contended)/);
    assert.equal((await fs.lstat(socketPath)).isSocket(), true);
    assert.equal((await request(socketPath)).status, 503);
  } finally {
    if (fulfilled[0]) await releaseUpdaterSocket(fulfilled[0].value);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("startup acquisition serializes concurrent recovery of the same stale lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-updater-api-stale-race-"));
  const socketPath = path.join(root, "updater.sock");
  await fs.writeFile(path.join(root, "updater.start.lock"),
    JSON.stringify({ pid: 999_999_999, process_start: "stale", token: "stale" }), { mode: 0o600 });
  await fs.writeFile(socketPath, "stale", { mode: 0o600 });
  const results = await Promise.allSettled([reserveUpdaterSocket(socketPath), reserveUpdaterSocket(socketPath)]);
  const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof reserveUpdaterSocket>>> => result.status === "fulfilled");
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  try {
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(String(rejected[0]!.reason), /updater_startup_lock_(?:active|contended)/);
    assert.equal((await request(socketPath)).status, 503);
  } finally {
    if (fulfilled[0]) await releaseUpdaterSocket(fulfilled[0].value);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("startup lock fails closed when a live owner identity cannot be inspected", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-updater-api-identity-unknown-"));
  const socketPath = path.join(root, "updater.sock");
  const lockPath = path.join(root, "updater.start.lock");
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, process_start: "owner", token: "owner" }), { mode: 0o600 });
  let calls = 0;
  try {
    await assert.rejects(reserveUpdaterSocket(socketPath, {
      inspectProcess: () => ++calls === 1
        ? { status: "alive", identity: "self" }
        : { status: "unknown" },
    }), /updater_startup_identity_unavailable/);
    assert.match(await fs.readFile(lockPath, "utf8"), /"token":"owner"/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("startup lock rejects incomplete metadata and distinguishes a reused PID", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-updater-api-identity-"));
  const socketPath = path.join(root, "updater.sock");
  const lockPath = path.join(root, "updater.start.lock");
  try {
    await fs.writeFile(lockPath, "{", { mode: 0o600 });
    await assert.rejects(reserveUpdaterSocket(socketPath), /updater_startup_lock_invalid/);
    assert.equal(await fs.readFile(lockPath, "utf8"), "{");

    await fs.unlink(lockPath);
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, process_start: "reused-pid", token: "stale" }), { mode: 0o600 });
    await fs.writeFile(socketPath, "stale", { mode: 0o600 });
    const reservation = await reserveUpdaterSocket(socketPath);
    await releaseUpdaterSocket(reservation);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("startup recovery replaces a writer lease whose PID was reused", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-updater-api-writer-reused-pid-"));
  const socketPath = path.join(root, "updater.sock");
  const database = new UpdateDatabase(path.join(root, "updater.sqlite3"));
  database.acquireWriterLease("00000000-0000-4000-8000-000000000000", process.pid);
  const api = new UpdaterApi(socketPath, undefined as unknown as UpdateController, database,
    { isRunning: () => true, wake() {} }, logger);
  try {
    await api.start();
    assert.equal((await request(socketPath)).status, 200);
  } finally {
    await api.stop();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("startup recovery removes a crash-orphaned auxiliary hard link", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-updater-api-orphan-link-"));
  const socketPath = path.join(root, "updater.sock");
  const lockPath = path.join(root, "updater.start.lock");
  const orphanPath = `${lockPath}.00000000-0000-4000-8000-000000000000.tmp`;
  await fs.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, process_start: "stale", token: "stale" }), { mode: 0o600 });
  await fs.link(lockPath, orphanPath);
  await fs.writeFile(socketPath, "stale", { mode: 0o600 });
  const reservation = await reserveUpdaterSocket(socketPath);
  try {
    await assert.rejects(fs.lstat(orphanPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    assert.equal((await request(socketPath)).status, 503);
  } finally {
    await releaseUpdaterSocket(reservation);
    await fs.rm(root, { recursive: true, force: true });
  }
});
