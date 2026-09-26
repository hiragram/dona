import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { DispatcherDatabase } from "../src/database.js";
import { createLegacyRecoveryPreflight } from "../src/legacy-offline-recovery.js";
import { eventEnvelope, tempConfig } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

test("offline preflight copies a consistent database and leaves legacy recovery fenced", async () => {
  const { root, config } = await tempConfig(); roots.push(root);
  const dispatcher = new DispatcherDatabase(config.databasePath);
  const event = dispatcher.enqueue(eventEnvelope("legacy-offline-preflight")).row;
  const job = dispatcher.createJob({ source_event_id: event.event_id, objective: "fixture",
    workspace: { kind: "scratch" } }, config.jobsWorkspaceRoot, config.jobResultsDir).row;
  dispatcher.close();
  const writer = new Database(config.databasePath);
  writer.prepare("UPDATE jobs SET status='needs_review',last_error_code='invalid_result' WHERE job_id=?").run(job.job_id);
  writer.close();
  await fs.mkdir(path.dirname(job.result_path), { recursive: true, mode: 0o700 });
  await fs.writeFile(job.result_path, JSON.stringify({ schema_version: 1, job_id: job.job_id,
    status: "completed", summary: "fixture", completed_at: "2026-09-25T00:00:00Z" }));
  const privateDir = path.join(root, "private");
  await fs.mkdir(privateDir, { mode: 0o700 });
  const backupPath = path.join(privateDir, "backup.sqlite3");
  const report = await createLegacyRecoveryPreflight(config.databasePath, backupPath);
  assert.equal(report.recovery_allowed, false);
  assert.equal(report.maintenance_fence, "unavailable");
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0]?.result.state, "valid");
  assert.equal(report.candidates[0]?.provisional_decision, "accept_valid_result");
  assert.equal((await fs.stat(backupPath)).mode & 0o777, 0o600);
  const after = new Database(config.databasePath, { readonly: true });
  assert.equal((after.prepare("SELECT status FROM jobs WHERE job_id=?").get(job.job_id) as {status:string}).status, "needs_review");
  after.close();
  await assert.rejects(createLegacyRecoveryPreflight(config.databasePath, backupPath), /legacy_backup_already_exists/);
  const occupiedPath = path.join(privateDir, "occupied.sqlite3");
  await fs.writeFile(`${occupiedPath}.tmp`, "another preflight owns this file");
  await assert.rejects(createLegacyRecoveryPreflight(config.databasePath, occupiedPath), /EEXIST/);
  assert.equal(await fs.readFile(`${occupiedPath}.tmp`, "utf8"), "another preflight owns this file");
});

test("offline preflight refuses a symlinked Result and does not publish a backup", async () => {
  const { root, config } = await tempConfig(); roots.push(root);
  const dispatcher = new DispatcherDatabase(config.databasePath);
  const event = dispatcher.enqueue(eventEnvelope("legacy-offline-symlink")).row;
  const job = dispatcher.createJob({ source_event_id: event.event_id, objective: "fixture",
    workspace: { kind: "scratch" } }, config.jobsWorkspaceRoot, config.jobResultsDir).row;
  dispatcher.close();
  const writer = new Database(config.databasePath);
  writer.prepare("UPDATE jobs SET status='needs_review' WHERE job_id=?").run(job.job_id);
  writer.close();
  await fs.mkdir(path.dirname(job.result_path), { recursive: true, mode: 0o700 });
  const target = path.join(root, "target.json");
  await fs.writeFile(target, "{}");
  await fs.symlink(target, job.result_path);
  const privateDir = path.join(root, "private"); await fs.mkdir(privateDir, { mode: 0o700 });
  const backupPath = path.join(privateDir, "backup.sqlite3");
  await assert.rejects(createLegacyRecoveryPreflight(config.databasePath, backupPath), /legacy_result_open_failed/);
  await assert.rejects(fs.stat(backupPath), { code: "ENOENT" });
});

test("offline preflight never deletes a source database whose name matches its temporary path", async () => {
  const { root } = await tempConfig(); roots.push(root);
  const sourcePath = path.join(root, "source.tmp");
  const dispatcher = new DispatcherDatabase(sourcePath);
  dispatcher.close();
  await assert.rejects(createLegacyRecoveryPreflight(sourcePath, path.join(root, "source")), /EEXIST/);
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  assert.equal(source.pragma("user_version", { simple: true }), 3);
  source.close();
});

test("offline preflight inventories missing, invalid, and oversized finals", async () => {
  const { root, config } = await tempConfig(); roots.push(root);
  const dispatcher = new DispatcherDatabase(config.databasePath);
  const jobs = [];
  for (const suffix of ["missing", "invalid", "oversize"]) {
    const event = dispatcher.enqueue(eventEnvelope(`legacy-offline-${suffix}`)).row;
    jobs.push(dispatcher.createJob({ source_event_id: event.event_id, objective: "fixture",
      workspace: { kind: "scratch" } }, config.jobsWorkspaceRoot, config.jobResultsDir).row);
  }
  dispatcher.close();
  const writer = new Database(config.databasePath);
  for (const job of jobs) writer.prepare("UPDATE jobs SET status='needs_review',last_error_code='invalid_result' WHERE job_id=?").run(job.job_id);
  writer.close();
  const invalid = jobs[1]!;
  await fs.mkdir(path.dirname(invalid.result_path), { recursive: true, mode: 0o700 });
  await fs.writeFile(invalid.result_path, "{ invalid JSON");
  const oversized = jobs[2]!;
  await fs.mkdir(path.dirname(oversized.result_path), { recursive: true, mode: 0o700 });
  await fs.writeFile(oversized.result_path, Buffer.alloc(1_048_577));
  const privateDir = path.join(root, "private"); await fs.mkdir(privateDir, { mode: 0o700 });
  const report = await createLegacyRecoveryPreflight(config.databasePath, path.join(privateDir, "backup.sqlite3"));
  const byId = new Map(report.candidates.map((candidate) => [candidate.job_id, candidate]));
  assert.equal(byId.get(jobs[0]!.job_id)?.result.state, "absent");
  assert.equal(byId.get(jobs[1]!.job_id)?.result.state, "invalid");
  assert.deepEqual(byId.get(jobs[2]!.job_id)?.result, {
    state: "invalid", reason: "oversize", sha256: null, bytes: 1_048_577,
    device: (await fs.stat(oversized.result_path)).dev, inode: (await fs.stat(oversized.result_path)).ino,
  });
  assert.equal(report.candidates.length, 3);
  assert.equal(report.recovery_allowed, false);
});
