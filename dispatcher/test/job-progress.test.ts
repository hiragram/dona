import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { JobProgressCoordinator, JobProgressStore, parseJobProgress, safeProgressText } from "../src/job-progress.js";
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
    const expected=path.join(path.dirname(root),".dona-progress",path.basename(root),"progress.json");
    assert.equal(jobProgressPath(row), expected);
    await fs.mkdir(path.join(root, ".git"));
    assert.equal(jobProgressPath(row), expected);
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

test("workspace Retry-After deadline is durable and defers other pending jobs", async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-progress-workspace-throttle-")); const file=path.join(root,"progress.sqlite3");
  let store=new JobProgressStore(file);
  try {
    const start=new Date("2026-09-05T00:00:00Z"); store.ingest(valid,start); store.ingest({...valid,job_id:"job_other"},start);
    const deadline=new Date("2026-09-05T00:00:30Z"); store.deferWorkspace("T1",deadline); store.defer("job_other",deadline); store.close();
    store=new JobProgressStore(file); assert.equal(store.workspaceAvailableAt("T1")?.toISOString(),deadline.toISOString());
    assert.equal(store.pending(new Date("2026-09-05T00:00:29Z"))?.job_id,"job_abc");
    assert.equal(store.get("job_other")?.available_at,deadline.toISOString());
  } finally {store.close();await fs.rm(root,{recursive:true});}
});

test("terminal sibling requeue preserves the per-job delivery interval", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-progress-requeue-"));
  const store = new JobProgressStore(path.join(root, "progress.sqlite3"));
  try {
    store.ingest(valid, new Date("2026-09-05T00:00:00Z"));
    store.begin("job_abc");
    store.delivered("job_abc", new Date("2026-09-05T00:00:10Z"));
    store.requeueLatest(["job_abc"], new Date("2026-09-05T00:00:20Z"));
    assert.equal(store.pending(new Date("2026-09-05T00:00:39Z")), undefined);
    assert.equal(store.pending(new Date("2026-09-05T00:00:40Z"))?.job_id, "job_abc");
  } finally { store.close(); await fs.rm(root, { recursive: true }); }
});

test("terminal sibling without progress receives a fixed preparing fallback", async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-progress-fallback-")); const store=new JobProgressStore(path.join(root,"progress.sqlite3"));
  try {
    store.requeueLatestAndMarkTerminal("job_done",["job_next"],new Date("2026-09-05T00:00:00Z"));
    const next=store.pending(); assert.equal(next?.job_id,"job_next"); assert.equal(next?.sequence,0); assert.equal(next?.phase,"preparing");
  } finally {store.close();await fs.rm(root,{recursive:true});}
});

test("an attention-claimed group rejects later progress delivery", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-progress-attention-"));
  const store = new JobProgressStore(path.join(root, "progress.sqlite3"));
  try {
    store.ingest(valid); store.begin("job_abc");
    const job = { job_id:"job_abc", source_event_id:"evt_abc", status:"running", workspace_id:"T1", channel_id:"C1", thread_ts:"1.1" };
    const jobs = {
      getJob: () => job,
      listEventJobs: () => [job],
      getJobGroup: () => ({ notification_mode:"grouped", sealed_at:"2026-09-05T00:00:00Z", attention_event_id:"evt_attention" }),
    };
    const coordinator = new JobProgressCoordinator(jobs as never, store, {} as never, {} as never);
    const progressId = "job_abc:1";
    (coordinator as unknown as { deliveryClaims:Map<string,string> }).deliveryClaims.set(progressId,"capability");
    assert.equal(coordinator.resolveDelivery(progressId,"capability"), undefined);
  } finally { store.close(); await fs.rm(root, { recursive: true }); }
});

test("an unsealed group reports delivery as deferred rather than permanent", async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-progress-deferred-")); const store=new JobProgressStore(path.join(root,"progress.sqlite3"));
  try {
    store.ingest(valid); store.begin("job_abc");
    const job={ job_id:"job_abc",source_event_id:"evt_abc",status:"running",workspace_id:"T1",channel_id:"C1",thread_ts:"1.1" };
    const jobs={ getJob:()=>job,listEventJobs:()=>[job],getJobGroup:()=>({notification_mode:"grouped",sealed_at:null,attention_event_id:null}) };
    const coordinator=new JobProgressCoordinator(jobs as never,store,{} as never,{} as never); const progressId="job_abc:1";
    (coordinator as unknown as {deliveryClaims:Map<string,string>}).deliveryClaims.set(progressId,"capability");
    assert.equal(coordinator.resolveDelivery(progressId,"capability"),undefined);
    assert.equal(coordinator.deliveryDeferred(progressId,"capability"),true);
  } finally { store.close(); await fs.rm(root,{recursive:true}); }
});

test("reporter suppresses pending progress after group attention is claimed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-progress-attention-pending-"));
  const store = new JobProgressStore(path.join(root, "progress.sqlite3"));
  try {
    store.ingest(valid);
    const job = { job_id:"job_abc", source_event_id:"evt_abc", status:"running", workspace_id:"T1", channel_id:"C1", thread_ts:"1.1" };
    const jobs = {
      getJob: () => job,
      getJobGroup: () => ({ notification_mode:"grouped", sealed_at:"2026-09-05T00:00:00Z", attention_event_id:"evt_attention" }),
    };
    const coordinator = new JobProgressCoordinator(jobs as never, store, {} as never, {} as never);
    await coordinator.report();
    assert.equal(store.get("job_abc")?.status, "delivered");
    assert.equal(store.pending(), undefined);
  } finally { store.close(); await fs.rm(root, { recursive: true }); }
});

test("store is monotonic, coalesces pending updates, and fences unknown delivery", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-progress-"));
  const store = new JobProgressStore(path.join(root, "progress.sqlite3"));
  try {
    assert.equal(store.ingest(valid), true);
    assert.equal(store.ingest({ ...valid, safe_summary: "old" }), false);
    assert.equal(store.ingest({ ...valid, sequence: 2, phase: "reviewing", safe_summary: "PRをレビュー中" }), true);
    assert.equal(store.get("job_abc")?.safe_summary, "レビュー中");
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

test("terminal ingest removes the job-bound progress directory", async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-progress-terminal-cleanup-")); const store=new JobProgressStore(path.join(root,"progress.sqlite3"));
  try {
    const row={job_id:"job_abc",source_event_id:"evt_abc",status:"completed",workspace_path:path.join(root,"job_abc"),workspace_json:JSON.stringify({kind:"scratch"})};
    const progressFile=jobProgressPath(row as never); await fs.mkdir(path.dirname(progressFile),{recursive:true}); await fs.writeFile(progressFile,"{}");
    const jobs={listEventJobs:()=>[row]}; const logger={warn(){}};
    await new JobProgressCoordinator(jobs as never,store,{} as never,logger as never).ingest(row as never);
    await assert.rejects(fs.access(path.dirname(progressFile)),{code:"ENOENT"});
  } finally {store.close();await fs.rm(root,{recursive:true});}
});

test("restart fences a delivery that may have reached Slack", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-progress-recover-")); const file=path.join(root,"progress.sqlite3");
  let store = new JobProgressStore(file); store.ingest(valid); store.begin("job_abc"); store.close();
  store = new JobProgressStore(file);
  store.recoverDeliveries();
  try { assert.equal(store.get("job_abc")?.status,"unknown"); assert.equal(store.pending(),undefined); }
  finally { store.close(); await fs.rm(root,{recursive:true}); }
});

test("migrates progress schema 1 with a terminal reconciliation marker", async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-progress-v1-")); const file=path.join(root,"progress.sqlite3");
  const legacy=new Database(file); legacy.exec("CREATE TABLE job_progress (job_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, phase TEXT NOT NULL, safe_summary TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL, available_at TEXT NOT NULL, delivered_at TEXT, last_error TEXT); PRAGMA user_version=1;"); legacy.close();
  const store=new JobProgressStore(file);
  try { const check=new Database(file,{readonly:true}); try { assert.equal(check.pragma("user_version",{simple:true}),2); assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='job_progress_terminal_idx'").get()); } finally { check.close(); } }
  finally { store.close(); await fs.rm(root,{recursive:true}); }
});
