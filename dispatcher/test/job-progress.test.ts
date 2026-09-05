import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { JobProgressStore, parseJobProgress, safeProgressText } from "../src/job-progress.js";
import { jobProgressPath } from "../src/job-prompt.js";

const valid = { schema_version: 1 as const, job_id: "job_abc", sequence: 1, phase: "testing" as const,
  safe_summary: "テスト中", updated_at: "2026-09-05T00:00:00.000Z" };

test("progress schema binds the job and allowlisted phase", () => {
  assert.deepEqual(parseJobProgress(valid, "job_abc"), valid);
  assert.throws(() => parseJobProgress({ ...valid, job_id: "job_other" }, "job_abc"));
  assert.throws(() => parseJobProgress({ ...valid, phase: "shell" }, "job_abc"));
  assert.throws(() => parseJobProgress({ ...valid, destination: "C123" }, "job_abc"));
});

test("worker summary is never sent and phase is rendered as a fixed label", () => {
  assert.equal(safeProgressText({ ...valid, safe_summary: "  テスト\n実行中  " }), "テスト中");
  assert.equal(safeProgressText({ ...valid, safe_summary: "token=secret" }), "テスト中");
  assert.equal(safeProgressText({ ...valid, safe_summary: "https://example.com" }), "テスト中");
  assert.equal(safeProgressText({ ...valid, safe_summary: "xapp-real-secret" }), "テスト中");
  assert.equal(safeProgressText({ ...valid, safe_summary: "github_pat_real_secret" }), "テスト中");
  assert.equal(safeProgressText({ ...valid, safe_summary: "password=hunter2" }), "テスト中");
  assert.equal(safeProgressText({ ...valid, safe_summary: "api_key=secret" }), "テスト中");
  assert.equal(safeProgressText({ ...valid, safe_summary: "AKIAIOSFODNN7EXAMPLE" }), "テスト中");
});

test("scratch progress path stays fixed when the worker creates git metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-progress-git-"));
  try {
    const row = { workspace_path: root, workspace_json: JSON.stringify({ kind:"scratch" }) } as never;
    assert.equal(jobProgressPath(row), path.join(root, ".dona-job-progress.json"));
    await fs.mkdir(path.join(root, ".git"));
    assert.equal(jobProgressPath(row), path.join(root, ".dona-job-progress.json"));
  } finally { await fs.rm(root, { recursive: true }); }
});

test("definite pre-delivery failure returns to pending with backoff", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-progress-retry-"));
  const store = new JobProgressStore(path.join(root, "progress.sqlite3"));
  try {
    store.ingest(valid, new Date("2026-09-05T00:00:00Z")); store.begin("job_abc");
    store.retry("job_abc", "adapter unavailable", new Date("2026-09-05T00:00:00Z"), 30);
    assert.equal(store.get("job_abc")?.status, "pending");
    assert.equal(store.pending(new Date("2026-09-05T00:00:29Z")), undefined);
    assert.equal(store.pending(new Date("2026-09-05T00:00:30Z"))?.job_id, "job_abc");
  } finally { store.close(); await fs.rm(root, { recursive: true }); }
});

test("store is monotonic, coalesces pending updates, and fences unknown delivery", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-progress-"));
  const store = new JobProgressStore(path.join(root, "progress.sqlite3"));
  try {
    assert.equal(store.ingest(valid), true);
    assert.equal(store.ingest({ ...valid, safe_summary: "old" }), false);
    assert.equal(store.ingest({ ...valid, sequence: 2, phase: "reviewing", safe_summary: "PRをレビュー中" }), true);
    assert.equal(store.get("job_abc")?.safe_summary, "PRをレビュー中");
    assert.equal(store.pending()?.sequence, 2);
    store.begin("job_abc");
    store.unknown("job_abc", "acceptance unknown");
    assert.equal(store.ingest({ ...valid, sequence: 3 }), false);
    assert.equal(store.get("job_abc")?.status, "unknown");
  } finally { store.close(); await fs.rm(root, { recursive: true }); }
});

test("terminal fence suppresses an undelivered progress update", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-progress-terminal-"));
  const store = new JobProgressStore(path.join(root, "progress.sqlite3"));
  try { store.ingest(valid); store.terminal("job_abc"); store.markTerminalChecked("job_abc"); assert.equal(store.pending(), undefined); assert.deepEqual(store.recoverable(), []); }
  finally { store.close(); await fs.rm(root, { recursive: true }); }
});

test("restart fences a delivery that may have reached Slack", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-progress-recover-")); const file=path.join(root,"progress.sqlite3");
  let store = new JobProgressStore(file); store.ingest(valid); store.begin("job_abc"); store.close();
  store = new JobProgressStore(file);
  try { assert.equal(store.get("job_abc")?.status,"unknown"); assert.equal(store.pending(),undefined); }
  finally { store.close(); await fs.rm(root,{recursive:true}); }
});

test("migrates progress schema 1 with a terminal reconciliation marker", async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-progress-v1-")); const file=path.join(root,"progress.sqlite3");
  const legacy=new Database(file); legacy.exec("CREATE TABLE job_progress (job_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, phase TEXT NOT NULL, safe_summary TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL, available_at TEXT NOT NULL, delivered_at TEXT, last_error TEXT); PRAGMA user_version=1;"); legacy.close();
  const store=new JobProgressStore(file);
  try { const check=new Database(file,{readonly:true}); try { assert.equal(check.pragma("user_version",{simple:true}),2); } finally { check.close(); } }
  finally { store.close(); await fs.rm(root,{recursive:true}); }
});
