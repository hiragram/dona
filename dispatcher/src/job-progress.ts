import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";

import type { DispatcherConfig } from "./config.js";
import type { DispatcherDatabase } from "./database.js";
import type { Logger } from "./logger.js";
import { jobProgressPhases, type JobProgressEnvelope, type JobRow } from "./types.js";
import { readPrivateToken } from "./private-token.js";
import { jobProgressPath } from "./job-prompt.js";

const terminalStatuses = new Set(["blocked", "completed", "failed", "cancelled", "needs_review"]);
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
    typeof value.safe_summary !== "string" || value.safe_summary.length < 1 || value.safe_summary.length > 80 ||
    /[\u0000-\u001f\u007f]/u.test(value.safe_summary) || typeof value.updated_at !== "string" ||
    !Number.isFinite(Date.parse(value.updated_at))) throw new Error("progress is invalid");
  return value as unknown as JobProgressEnvelope;
}

export function safeProgressText(progress: JobProgressEnvelope): string {
  return phaseLabels[progress.phase];
}

interface ProgressRow { job_id: string; sequence: number; phase: JobProgressEnvelope["phase"]; safe_summary: string; status: "pending"|"delivering"|"delivered"|"unknown"; available_at: string; }

export class JobProgressStore {
  private readonly db: Database.Database;
  constructor(databasePath: string) {
    fsSync.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    fsSync.chmodSync(path.dirname(databasePath), 0o700);
    this.db = new Database(databasePath);
    fsSync.chmodSync(databasePath, 0o600);
    this.db.pragma("journal_mode = WAL"); this.db.pragma("synchronous = FULL"); this.db.pragma("busy_timeout = 2000");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 2) throw new Error(`Job progress schema ${version} is newer than supported schema 2`);
    if (version === 0) this.db.transaction(() => this.db.exec(`
      CREATE TABLE job_progress (
        job_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, phase TEXT NOT NULL, safe_summary TEXT NOT NULL,
        updated_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','delivering','delivered','unknown')),
        available_at TEXT NOT NULL, delivered_at TEXT, last_error TEXT, terminal_checked INTEGER NOT NULL DEFAULT 0
      );
      PRAGMA user_version = 2;
    `))();
    if (version === 1) this.db.transaction(() => this.db.exec("ALTER TABLE job_progress ADD COLUMN terminal_checked INTEGER NOT NULL DEFAULT 0; PRAGMA user_version = 2;"))();
    this.db.exec("CREATE INDEX IF NOT EXISTS job_progress_pending_idx ON job_progress(status,available_at)");
    this.db.prepare("UPDATE job_progress SET status='unknown',last_error='recovered ambiguous delivery' WHERE status='delivering'").run();
  }
  close(): void { this.db.close(); }
  ingest(progress: JobProgressEnvelope, at = new Date()): boolean {
    const existing = this.get(progress.job_id);
    if (existing && progress.sequence <= existing.sequence) return false;
    const timestamp = at.toISOString();
    this.db.prepare(`INSERT INTO job_progress(job_id,sequence,phase,safe_summary,updated_at,status,available_at)
      VALUES(?,?,?,?,?,'pending',?) ON CONFLICT(job_id) DO UPDATE SET sequence=excluded.sequence,phase=excluded.phase,
      safe_summary=excluded.safe_summary,updated_at=excluded.updated_at,status='pending',available_at=excluded.available_at,
      delivered_at=NULL,last_error=NULL,terminal_checked=0 WHERE excluded.sequence > job_progress.sequence AND job_progress.status NOT IN ('unknown','delivering')`)
      .run(progress.job_id, progress.sequence, progress.phase, progress.safe_summary, progress.updated_at, timestamp);
    return this.get(progress.job_id)?.sequence === progress.sequence;
  }
  get(jobId: string): ProgressRow | undefined { return this.db.prepare("SELECT * FROM job_progress WHERE job_id=?").get(jobId) as ProgressRow|undefined; }
  all(): ProgressRow[] { return this.db.prepare("SELECT * FROM job_progress ORDER BY job_id").all() as ProgressRow[]; }
  recoverable(): ProgressRow[] { return this.db.prepare("SELECT * FROM job_progress WHERE terminal_checked=0 ORDER BY job_id").all() as ProgressRow[]; }
  pending(at = new Date()): ProgressRow | undefined { return this.db.prepare("SELECT * FROM job_progress WHERE status='pending' AND available_at<=? ORDER BY available_at LIMIT 1").get(at.toISOString()) as ProgressRow|undefined; }
  begin(jobId: string): void { this.db.prepare("UPDATE job_progress SET status='delivering' WHERE job_id=? AND status='pending'").run(jobId); }
  delivered(jobId: string, at = new Date()): void { this.db.prepare("UPDATE job_progress SET status='delivered',delivered_at=? WHERE job_id=? AND status='delivering'").run(at.toISOString(),jobId); }
  unknown(jobId: string, error: string): void { this.db.prepare("UPDATE job_progress SET status='unknown',last_error=? WHERE job_id=? AND status='delivering'").run(error.slice(0,500),jobId); }
  retry(jobId: string, error: string, at = new Date(), retryAfterSeconds = 5): void { this.db.prepare("UPDATE job_progress SET status='pending',available_at=?,last_error=? WHERE job_id=? AND status='delivering'").run(new Date(at.getTime()+Math.max(5,retryAfterSeconds)*1_000).toISOString(),error.slice(0,500),jobId); }
  terminal(jobId: string): void {
    this.db.prepare("UPDATE job_progress SET status='unknown',last_error='job terminated during delivery' WHERE job_id=? AND status='delivering'").run(jobId);
    this.db.prepare("UPDATE job_progress SET status='delivered' WHERE job_id=? AND status='pending'").run(jobId);
    this.db.prepare("UPDATE job_progress SET terminal_checked=1 WHERE job_id=?").run(jobId);
  }
  requeueLatest(jobIds: string[], at = new Date()): void {
    if (jobIds.length === 0) return;
    const placeholders = jobIds.map(() => "?").join(",");
    const latest = this.db.prepare(`SELECT job_id FROM job_progress WHERE job_id IN (${placeholders}) AND status='delivered' ORDER BY delivered_at DESC,job_id DESC LIMIT 1`).get(...jobIds) as {job_id:string}|undefined;
    if (latest) this.db.prepare("UPDATE job_progress SET status='pending',available_at=? WHERE job_id=? AND status='delivered'").run(at.toISOString(),latest.job_id);
  }
}

export class JobProgressCoordinator {
  private readonly deliveryClaims = new Map<string,string>();
  constructor(private readonly jobs: DispatcherDatabase, private readonly store: JobProgressStore,
    private readonly config: DispatcherConfig, private readonly logger: Logger) {}
  async ingest(row: JobRow): Promise<void> {
    if (terminalStatuses.has(row.status)) {
      this.store.terminal(row.job_id);
      await fs.unlink(jobProgressPath(row)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") this.logger.warn("Job progress cleanup failed", { job_id: row.job_id, error_code: "job_progress_cleanup_failed" }); });
      const runningSiblings = this.jobs.listEventJobs(row.source_event_id).filter((item) => !terminalStatuses.has(item.status)).map((item) => item.job_id);
      this.store.requeueLatest(runningSiblings);
      return;
    }
    try {
      const progressPath = jobProgressPath(row);
      const stats = await fs.lstat(progressPath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 4096) throw new Error("progress file must be a bounded regular file");
      const handle = await fs.open(progressPath, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW | fsSync.constants.O_NONBLOCK);
      let text: string;
      try { const opened=await handle.stat(); if(!opened.isFile() || opened.size>4096) throw new Error("opened progress must be a bounded regular file"); const buffer=Buffer.alloc(4097); const read=await handle.read(buffer,0,buffer.length,0); if(read.bytesRead>4096) throw new Error("progress file too large"); text=buffer.subarray(0,read.bytesRead).toString("utf8"); }
      finally { await handle.close(); }
      this.store.ingest(parseJobProgress(JSON.parse(text), row.job_id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.logger.warn("Job progress ignored", { job_id: row.job_id, error_code: "invalid_job_progress" });
    }
  }
  async recover(): Promise<void> {
    for (const progress of this.store.recoverable()) {
      const job = this.jobs.getJob(progress.job_id);
      if (job && terminalStatuses.has(job.status)) await this.ingest(job);
    }
  }
  async report(): Promise<void> {
    const progress = this.store.pending(); if (!progress) return;
    const job = this.jobs.getJob(progress.job_id);
    if (!job || terminalStatuses.has(job.status) || !job.workspace_id || !job.channel_id || !job.thread_ts) { this.store.terminal(progress.job_id); return; }
    this.store.begin(progress.job_id);
    let requestStarted = false;
    try {
      const token = await readPrivateToken(this.config.updateInternalTokenPath);
      if (!token) { this.store.retry(progress.job_id, "missing internal token"); return; }
      const progressId = `${job.job_id}:${progress.sequence}`;
      const deliveryToken = randomBytes(32).toString("hex");
      this.deliveryClaims.set(progressId, deliveryToken);
      const body = Buffer.from(JSON.stringify({ schema_version:1, progress_id:progressId, delivery_token:deliveryToken }));
      await new Promise<void>((resolve,reject) => { let settled=false; const chunks:Buffer[]=[]; let responseSize=0; const finish=(error?:Error)=>{if(settled)return;settled=true;error?reject(error):resolve();}; const request=http.request({socketPath:this.config.slackAdapterSocketPath,path:"/v1/internal/job-progress",method:"POST",headers:{"content-type":"application/json","content-length":String(body.length),"x-dona-update-token":token}},response=>{ requestStarted=true; response.on("data",(chunk:Buffer)=>{responseSize+=chunk.length;if(responseSize<=4096)chunks.push(chunk);}); response.once("aborted",()=>finish(Object.assign(new Error("response aborted"),{acceptanceUnknown:true}))); response.once("error",error=>finish(Object.assign(error,{acceptanceUnknown:true}))); response.once("end",()=>{let retryAfterSeconds:number|undefined;try{const parsed=JSON.parse(Buffer.concat(chunks).toString()) as {retry_after_seconds?:unknown};if(typeof parsed.retry_after_seconds==="number")retryAfterSeconds=parsed.retry_after_seconds;}catch{} response.statusCode===200?finish():finish(Object.assign(new Error(`HTTP ${response.statusCode}`),{definitelyUnsent:[400,401,403,429].includes(response.statusCode??0),retryAfterSeconds}));});}); request.setTimeout(this.config.jobCommandTimeoutMs,()=>request.destroy(Object.assign(new Error("timeout"),{acceptanceUnknown:true}))); request.once("socket",socket=>socket.once("connect",()=>{requestStarted=true;})); request.once("error",error=>finish(error)); request.end(body); });
      this.store.delivered(progress.job_id);
      this.deliveryClaims.delete(`${job.job_id}:${progress.sequence}`);
    } catch (error) {
      const detail = error as Error & { code?: string; definitelyUnsent?: boolean; acceptanceUnknown?: boolean; retryAfterSeconds?:number };
      const definitelyUnsent = detail.definitelyUnsent || (!requestStarted && ["ENOENT","ECONNREFUSED"].includes(detail.code ?? ""));
      this.deliveryClaims.delete(`${job.job_id}:${progress.sequence}`);
      if (definitelyUnsent) this.store.retry(progress.job_id, detail.message, new Date(), detail.retryAfterSeconds);
      else this.store.unknown(progress.job_id, detail.message);
    }
  }

  resolveDelivery(progressId: string, deliveryToken: string): { progress_id:string; workspace_id:string; channel_id:string; thread_ts:string; status:string } | undefined {
    const match = /^(job_[0-9a-z]+):(\d+)$/.exec(progressId);
    if (!match) return undefined;
    const progress = this.store.get(match[1]!);
    const job = this.jobs.getJob(match[1]!);
    if (this.deliveryClaims.get(progressId) !== deliveryToken || !progress || progress.status !== "delivering" || progress.sequence !== Number(match[2]) || !job ||
      terminalStatuses.has(job.status) || !job.workspace_id || !job.channel_id || !job.thread_ts) return undefined;
    const siblings = this.jobs.listEventJobs(job.source_event_id);
    const group = this.jobs.getJobGroup(job.source_event_id);
    if (group?.notification_mode === "grouped" && !group.sealed_at) return undefined;
    const index = siblings.findIndex((item) => item.job_id === job.job_id) + 1;
    return { progress_id:progressId, workspace_id:job.workspace_id, channel_id:job.channel_id, thread_ts:job.thread_ts,
      status:siblings.length > 1 ? `${siblings.length}件中${index}件目: ${phaseLabels[progress.phase]}` : phaseLabels[progress.phase] };
  }
}
