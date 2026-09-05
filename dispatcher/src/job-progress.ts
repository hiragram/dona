import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import Database from "better-sqlite3";

import type { DispatcherConfig } from "./config.js";
import type { DispatcherDatabase } from "./database.js";
import type { Logger } from "./logger.js";
import { jobProgressPhases, type JobProgressEnvelope, type JobRow } from "./types.js";
import { readPrivateToken } from "./private-token.js";

const terminalStatuses = new Set(["blocked", "completed", "failed", "cancelled", "needs_review"]);
const secretLike = /(?:xox[baprs]-|xapp-|gh[pousr]_|github_pat_|bearer\s+|token\s*[=:]|-----BEGIN|https?:\/\/|\/[A-Za-z0-9._-]+\/)/iu;
const phaseLabels: Record<JobProgressEnvelope["phase"], string> = {
  preparing: "準備中", implementing: "実装中", testing: "テスト中", reviewing: "レビュー中",
  waiting_ci: "CI待ち", reconciling: "状態を照合中",
};

export function parseJobProgress(input: unknown, expectedJobId: string): JobProgressEnvelope {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("progress must be an object");
  const value = input as Record<string, unknown>;
  const keys = ["schema_version", "job_id", "sequence", "phase", "safe_summary", "updated_at"];
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value)) ||
    value.schema_version !== 1 || value.job_id !== expectedJobId || !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 || !jobProgressPhases.includes(value.phase as never) ||
    typeof value.safe_summary !== "string" || typeof value.updated_at !== "string" ||
    !Number.isFinite(Date.parse(value.updated_at))) throw new Error("progress is invalid");
  return value as unknown as JobProgressEnvelope;
}

export function safeProgressText(progress: JobProgressEnvelope): string {
  const normalized = progress.safe_summary.normalize("NFKC").replace(/[\r\n\t]+/gu, " ")
    .replace(/[\u0000-\u001f\u007f]/gu, "").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 80 || secretLike.test(normalized)) return phaseLabels[progress.phase];
  return normalized;
}

interface ProgressRow { job_id: string; sequence: number; phase: JobProgressEnvelope["phase"]; safe_summary: string; status: "pending"|"delivering"|"delivered"|"unknown"; available_at: string; }

export class JobProgressStore {
  private readonly db: Database.Database;
  constructor(databasePath: string) {
    fsSync.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL"); this.db.pragma("synchronous = FULL"); this.db.pragma("busy_timeout = 2000");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 1) throw new Error(`Job progress schema ${version} is newer than supported schema 1`);
    if (version === 0) this.db.transaction(() => this.db.exec(`
      CREATE TABLE job_progress (
        job_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, phase TEXT NOT NULL, safe_summary TEXT NOT NULL,
        updated_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','delivering','delivered','unknown')),
        available_at TEXT NOT NULL, delivered_at TEXT, last_error TEXT
      );
      PRAGMA user_version = 1;
    `))();
  }
  close(): void { this.db.close(); }
  ingest(progress: JobProgressEnvelope, at = new Date()): boolean {
    const existing = this.get(progress.job_id);
    if (existing && progress.sequence <= existing.sequence) return false;
    const timestamp = at.toISOString();
    this.db.prepare(`INSERT INTO job_progress(job_id,sequence,phase,safe_summary,updated_at,status,available_at)
      VALUES(?,?,?,?,?,'pending',?) ON CONFLICT(job_id) DO UPDATE SET sequence=excluded.sequence,phase=excluded.phase,
      safe_summary=excluded.safe_summary,updated_at=excluded.updated_at,status='pending',available_at=excluded.available_at,
      delivered_at=NULL,last_error=NULL WHERE excluded.sequence > job_progress.sequence AND job_progress.status != 'unknown'`)
      .run(progress.job_id, progress.sequence, progress.phase, safeProgressText(progress), progress.updated_at, timestamp);
    return this.get(progress.job_id)?.sequence === progress.sequence;
  }
  get(jobId: string): ProgressRow | undefined { return this.db.prepare("SELECT * FROM job_progress WHERE job_id=?").get(jobId) as ProgressRow|undefined; }
  pending(at = new Date()): ProgressRow | undefined { return this.db.prepare("SELECT * FROM job_progress WHERE status='pending' AND available_at<=? ORDER BY available_at LIMIT 1").get(at.toISOString()) as ProgressRow|undefined; }
  begin(jobId: string): void { this.db.prepare("UPDATE job_progress SET status='delivering' WHERE job_id=? AND status='pending'").run(jobId); }
  delivered(jobId: string, at = new Date()): void { this.db.prepare("UPDATE job_progress SET status='delivered',delivered_at=? WHERE job_id=? AND status='delivering'").run(at.toISOString(),jobId); }
  unknown(jobId: string, error: string): void { this.db.prepare("UPDATE job_progress SET status='unknown',last_error=? WHERE job_id=? AND status='delivering'").run(error.slice(0,500),jobId); }
  retry(jobId: string, error: string, at = new Date()): void { this.db.prepare("UPDATE job_progress SET status='pending',available_at=?,last_error=? WHERE job_id=? AND status='delivering'").run(new Date(at.getTime()+5_000).toISOString(),error.slice(0,500),jobId); }
  terminal(jobId: string): void { this.db.prepare("UPDATE job_progress SET status='delivered' WHERE job_id=? AND status IN ('pending','delivering')").run(jobId); }
}

export class JobProgressCoordinator {
  constructor(private readonly jobs: DispatcherDatabase, private readonly store: JobProgressStore,
    private readonly config: DispatcherConfig, private readonly logger: Logger) {}
  async ingest(row: JobRow): Promise<void> {
    if (terminalStatuses.has(row.status)) { this.store.terminal(row.job_id); return; }
    try {
      const text = await fs.readFile(`${row.result_path}.progress.json`, "utf8");
      if (text.length > 4096) throw new Error("progress file too large");
      this.store.ingest(parseJobProgress(JSON.parse(text), row.job_id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.logger.warn("Job progress ignored", { job_id: row.job_id, error_code: "invalid_job_progress" });
    }
  }
  async report(): Promise<void> {
    const progress = this.store.pending(); if (!progress) return;
    const job = this.jobs.getJob(progress.job_id);
    if (!job || terminalStatuses.has(job.status) || !job.workspace_id || !job.channel_id || !job.thread_ts) { this.store.terminal(progress.job_id); return; }
    const siblings = this.jobs.listEventJobs(job.source_event_id);
    const index = siblings.findIndex((item) => item.job_id === job.job_id) + 1;
    const status = siblings.length > 1 ? `${siblings.length}件中${index}件目: ${progress.safe_summary}` : progress.safe_summary;
    this.store.begin(progress.job_id);
    let requestStarted = false;
    try {
      const token = await readPrivateToken(this.config.updateInternalTokenPath);
      if (!token) { this.store.retry(progress.job_id, "missing internal token"); return; }
      const body = Buffer.from(JSON.stringify({ schema_version:1, progress_id:`${job.job_id}:${progress.sequence}`, workspace_id:job.workspace_id, channel_id:job.channel_id, thread_ts:job.thread_ts, status }));
      await new Promise<void>((resolve,reject) => { const request=http.request({socketPath:this.config.slackAdapterSocketPath,path:"/v1/internal/job-progress",method:"POST",headers:{"content-type":"application/json","content-length":String(body.length),"x-dona-update-token":token}},response=>{ requestStarted=true; const chunks:Buffer[]=[]; response.on("data",(chunk:Buffer)=>chunks.push(chunk)); response.on("end",()=>response.statusCode===200?resolve():reject(Object.assign(new Error(`HTTP ${response.statusCode}`),{definitelyUnsent:[400,401,403].includes(response.statusCode??0)})));}); request.setTimeout(this.config.jobCommandTimeoutMs,()=>request.destroy(Object.assign(new Error("timeout"),{acceptanceUnknown:true}))); request.once("socket",socket=>socket.once("connect",()=>{requestStarted=true;})); request.once("error",reject); request.end(body); });
      this.store.delivered(progress.job_id);
    } catch (error) {
      const detail = error as Error & { code?: string; definitelyUnsent?: boolean; acceptanceUnknown?: boolean };
      const definitelyUnsent = detail.definitelyUnsent || (!requestStarted && ["ENOENT","ECONNREFUSED"].includes(detail.code ?? ""));
      if (definitelyUnsent) this.store.retry(progress.job_id, detail.message);
      else this.store.unknown(progress.job_id, detail.message);
    }
  }
}
