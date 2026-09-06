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
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value.updated_at) ||
    !Number.isFinite(Date.parse(value.updated_at))) throw new Error("progress is invalid");
  return value as unknown as JobProgressEnvelope;
}

export function safeProgressText(progress: JobProgressEnvelope): string {
  return phaseLabels[progress.phase];
}

interface ProgressRow { job_id: string; sequence: number; phase: JobProgressEnvelope["phase"]; safe_summary: string; status: "pending"|"delivering"|"delivered"|"unknown"; available_at: string; delivered_at?:string; terminal_checked:number; }

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
      CREATE TABLE job_progress_throttles (workspace_id TEXT PRIMARY KEY, available_at TEXT NOT NULL);
      PRAGMA user_version = 2;
    `))();
    if (version === 1) this.db.transaction(() => this.db.exec(`ALTER TABLE job_progress ADD COLUMN terminal_checked INTEGER NOT NULL DEFAULT 0; UPDATE job_progress SET safe_summary=CASE phase WHEN 'preparing' THEN '準備中' WHEN 'implementing' THEN '実装中' WHEN 'testing' THEN 'テスト中' WHEN 'reviewing' THEN 'レビュー中' WHEN 'waiting_ci' THEN 'CI待ち' WHEN 'reconciling' THEN '状態を照合中' ELSE '準備中' END, updated_at='1970-01-01T00:00:00.000Z'; PRAGMA user_version = 2;`))();
    this.db.exec("CREATE TABLE IF NOT EXISTS job_progress_throttles (workspace_id TEXT PRIMARY KEY, available_at TEXT NOT NULL)");
    this.db.exec("CREATE INDEX IF NOT EXISTS job_progress_pending_idx ON job_progress(status,available_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS job_progress_terminal_idx ON job_progress(terminal_checked,job_id)");
  }
  recoverDeliveries(): void { this.db.prepare("UPDATE job_progress SET status='unknown',last_error='recovered ambiguous delivery' WHERE status='delivering'").run(); }
  hasDelivering(): boolean { return this.db.prepare("SELECT 1 FROM job_progress WHERE status='delivering' LIMIT 1").get() !== undefined; }
  close(): void { this.db.close(); }
  ingest(progress: JobProgressEnvelope, at = new Date()): boolean {
    const existing = this.get(progress.job_id);
    if (existing && progress.sequence <= existing.sequence) return false;
    if (existing?.phase === progress.phase) {
      if (existing.status !== "delivering" && existing.status !== "unknown") this.db.prepare("UPDATE job_progress SET sequence=?,safe_summary=?,updated_at=? WHERE job_id=?").run(progress.sequence,phaseLabels[progress.phase],progress.updated_at,progress.job_id);
      return false;
    }
    const timestamp = at.toISOString();
    const availableAt = existing?.delivered_at
      ? new Date(Math.max(at.getTime(), Date.parse(existing.delivered_at) + 30_000)).toISOString()
      : timestamp;
    this.db.prepare(`INSERT INTO job_progress(job_id,sequence,phase,safe_summary,updated_at,status,available_at)
      VALUES(?,?,?,?,?,'pending',?) ON CONFLICT(job_id) DO UPDATE SET sequence=excluded.sequence,phase=excluded.phase,
      safe_summary=excluded.safe_summary,updated_at=excluded.updated_at,status='pending',available_at=CASE WHEN job_progress.status='pending' AND job_progress.available_at>excluded.available_at THEN job_progress.available_at ELSE excluded.available_at END,
      delivered_at=NULL,last_error=NULL,terminal_checked=0 WHERE excluded.sequence > job_progress.sequence AND job_progress.status NOT IN ('unknown','delivering')`)
      .run(progress.job_id, progress.sequence, progress.phase, phaseLabels[progress.phase], progress.updated_at, availableAt);
    return this.get(progress.job_id)?.sequence === progress.sequence;
  }
  get(jobId: string): ProgressRow | undefined { return this.db.prepare("SELECT * FROM job_progress WHERE job_id=?").get(jobId) as ProgressRow|undefined; }
  all(): ProgressRow[] { return this.db.prepare("SELECT * FROM job_progress ORDER BY job_id").all() as ProgressRow[]; }
  recoverable(afterJobId="",limit=500): ProgressRow[] { return this.db.prepare("SELECT * FROM job_progress WHERE terminal_checked=0 AND job_id>? ORDER BY job_id LIMIT ?").all(afterJobId,limit) as ProgressRow[]; }
  pending(at = new Date()): ProgressRow | undefined { return this.db.prepare("SELECT * FROM job_progress WHERE status='pending' AND available_at<=? ORDER BY available_at LIMIT 1").get(at.toISOString()) as ProgressRow|undefined; }
  begin(jobId: string): void { this.db.prepare("UPDATE job_progress SET status='delivering' WHERE job_id=? AND status='pending'").run(jobId); }
  delivered(jobId: string, at = new Date()): void { this.db.prepare("UPDATE job_progress SET status='delivered',delivered_at=? WHERE job_id=? AND status='delivering'").run(at.toISOString(),jobId); }
  unknown(jobId: string, error: string): void { this.db.prepare("UPDATE job_progress SET status='unknown',last_error=? WHERE job_id=? AND status='delivering'").run(error.slice(0,500),jobId); }
  retry(jobId: string, error: string, at = new Date(), retryAfterSeconds = 5): void { this.db.prepare("UPDATE job_progress SET status='pending',available_at=?,last_error=? WHERE job_id=? AND status='delivering'").run(new Date(at.getTime()+Math.max(5,retryAfterSeconds)*1_000).toISOString(),error.slice(0,500),jobId); }
  defer(jobId:string,availableAt:Date):void { this.db.prepare("UPDATE job_progress SET available_at=? WHERE job_id=? AND status='pending' AND available_at<?").run(availableAt.toISOString(),jobId,availableAt.toISOString()); }
  deferJobs(jobIds:string[],availableAt:Date):void {const timestamp=availableAt.toISOString();for(let offset=0;offset<jobIds.length;offset+=500){const batch=jobIds.slice(offset,offset+500);const placeholders=batch.map(()=>"?").join(",");this.db.prepare(`UPDATE job_progress SET available_at=? WHERE job_id IN (${placeholders}) AND status='pending' AND available_at<?`).run(timestamp,...batch,timestamp);}}
  deferWorkspace(workspaceId:string,availableAt:Date):void { this.db.prepare(`INSERT INTO job_progress_throttles(workspace_id,available_at) VALUES(?,?) ON CONFLICT(workspace_id) DO UPDATE SET available_at=CASE WHEN available_at<excluded.available_at THEN excluded.available_at ELSE available_at END`).run(workspaceId,availableAt.toISOString()); }
  workspaceAvailableAt(workspaceId:string):Date|undefined { const row=this.db.prepare("SELECT available_at FROM job_progress_throttles WHERE workspace_id=?").get(workspaceId) as {available_at:string}|undefined; return row?new Date(row.available_at):undefined; }
  terminal(jobId: string): void {
    this.db.prepare("UPDATE job_progress SET status='unknown',last_error='job terminated during delivery' WHERE job_id=? AND status='delivering'").run(jobId);
    this.db.prepare("UPDATE job_progress SET status='delivered' WHERE job_id=? AND status='pending'").run(jobId);
  }
  markTerminalChecked(jobId: string): void { const timestamp=new Date().toISOString(); this.db.prepare(`INSERT INTO job_progress(job_id,sequence,phase,safe_summary,updated_at,status,available_at,terminal_checked) VALUES(?,0,'preparing','準備中',?,'delivered',?,1) ON CONFLICT(job_id) DO UPDATE SET terminal_checked=1`).run(jobId,timestamp,timestamp); }
  requeueLatestAndMarkTerminal(jobId: string, jobIds: string[], at = new Date()): void {
    this.db.transaction(() => {
      if (jobIds.length > 0) {
        const placeholders=jobIds.map(()=>"?").join(",");
        const pending=this.db.prepare(`SELECT 1 FROM job_progress WHERE job_id IN (${placeholders}) AND status='pending' LIMIT 1`).get(...jobIds);
        if (!pending && !this.requeueLatest(jobIds,at)) this.queuePreparing(jobIds[0]!,at);
      }
      this.markTerminalChecked(jobId);
    })();
  }
  requeueLatest(jobIds: string[], at = new Date()): boolean {
    if (jobIds.length === 0) return false;
    const placeholders = jobIds.map(() => "?").join(",");
    const latest = this.db.prepare(`SELECT job_id,delivered_at FROM job_progress WHERE job_id IN (${placeholders}) AND status='delivered' ORDER BY delivered_at DESC,job_id DESC LIMIT 1`).get(...jobIds) as {job_id:string;delivered_at?:string}|undefined;
    if (latest) {
      const availableAt = latest.delivered_at
        ? new Date(Math.max(at.getTime(), Date.parse(latest.delivered_at) + 30_000)).toISOString()
        : at.toISOString();
      this.db.prepare("UPDATE job_progress SET status='pending',available_at=? WHERE job_id=? AND status='delivered'").run(availableAt,latest.job_id);
    }
    return latest !== undefined;
  }
  private queuePreparing(jobId:string,at:Date):void { const timestamp=at.toISOString(); this.db.prepare(`INSERT INTO job_progress(job_id,sequence,phase,safe_summary,updated_at,status,available_at,terminal_checked) VALUES(?,0,'preparing','準備中',?,'pending',?,0) ON CONFLICT(job_id) DO UPDATE SET phase='preparing',safe_summary='準備中',updated_at=excluded.updated_at,status='pending',available_at=excluded.available_at,delivered_at=NULL,last_error=NULL,terminal_checked=0 WHERE job_progress.status='unknown'`).run(jobId,timestamp,timestamp); }
}

export class JobProgressCoordinator {
  private readonly deliveryClaims = new Map<string,string>();
  private readonly deliveryOperations = new Map<string,Promise<void>>();
  private readonly terminalReconciliations = new Map<string,Promise<void>>();
  private readonly invalidProgressWarnings = new Map<string,string>();
  private readonly drainAbort = new AbortController();
  constructor(private readonly jobs: DispatcherDatabase, private readonly store: JobProgressStore,
    private readonly config: DispatcherConfig, private readonly logger: Logger) {}
  async ingest(row: JobRow): Promise<void> {
    if (terminalStatuses.has(row.status)) {
      this.invalidProgressWarnings.delete(row.job_id);
      const siblings=this.jobs.listEventJobs(row.source_event_id);
      await this.drainDeliveries(siblings.map((item)=>item.job_id));
      if(siblings.some((item)=>this.store.get(item.job_id)?.status==="delivering"))return;
      this.store.terminal(row.job_id);
      await fs.rm(path.dirname(jobProgressPath(row)),{recursive:true,force:true}).catch(() => { this.logger.warn("Job progress cleanup failed", { job_id: row.job_id, error_code: "job_progress_cleanup_failed" }); });
      const runningSiblings = siblings.filter((item) => !terminalStatuses.has(item.status)).map((item) => item.job_id);
      this.store.requeueLatestAndMarkTerminal(row.job_id,runningSiblings);
      return;
    }
    let parsed:JobProgressEnvelope;
    try {
      const progressPath = jobProgressPath(row);
      const stats = await fs.lstat(progressPath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 4096) throw new Error("progress file must be a bounded regular file");
      const handle = await fs.open(progressPath, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW | fsSync.constants.O_NONBLOCK);
      let text: string;
      try { const opened=await handle.stat(); if(!opened.isFile() || opened.size>4096) throw new Error("opened progress must be a bounded regular file"); const buffer=Buffer.alloc(4097); const read=await handle.read(buffer,0,buffer.length,0); if(read.bytesRead>4096) throw new Error("progress file too large"); text=buffer.subarray(0,read.bytesRead).toString("utf8"); }
      finally { await handle.close(); }
      parsed=parseJobProgress(JSON.parse(text), row.job_id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.invalidProgressWarnings.delete(row.job_id);
      } else {
        const stats=await fs.lstat(jobProgressPath(row)).catch(()=>undefined);
        const fingerprint=`${error instanceof Error?error.message:String(error)}:${stats?.size??"missing"}:${stats?.mtimeMs??"missing"}`;
        if(this.invalidProgressWarnings.get(row.job_id)!==fingerprint){
          this.invalidProgressWarnings.set(row.job_id,fingerprint);
          this.logger.warn("Job progress ignored", { job_id: row.job_id, error_code: "invalid_job_progress" });
        }
      }
      return;
    }
    this.store.ingest(parsed);
    this.invalidProgressWarnings.delete(row.job_id);
  }
  async recover(): Promise<void> {
    if(this.store.hasDelivering()&&!await this.drainAdapterUntilSettled("startup"))return;
    this.store.recoverDeliveries();
    let after="";for(;;){const batch=this.store.recoverable(after,500);for(const progress of batch){const job=this.jobs.getJob(progress.job_id);if(job&&terminalStatuses.has(job.status))await this.ingest(job);}if(batch.length<500)break;after=batch.at(-1)!.job_id;}
  }
  async report(): Promise<void> {
    const progress = this.store.pending(); if (!progress) return;
    const job = this.jobs.getJob(progress.job_id);
    if (!job || terminalStatuses.has(job.status) || !job.workspace_id || !job.channel_id || !job.thread_ts) { this.store.terminal(progress.job_id); return; }
    const workspaceAvailableAt=this.store.workspaceAvailableAt(job.workspace_id);
    if(workspaceAvailableAt&&workspaceAvailableAt.getTime()>Date.now()){
      let after="";for(;;){const batch=this.jobs.listNonterminalWorkspaceJobIds(job.workspace_id,after,500);this.store.deferJobs(batch,workspaceAvailableAt);if(batch.length<500)break;after=batch.at(-1)!;}return;
    }
    const group = this.jobs.getJobGroup(job.source_event_id);
    if (group?.notification_mode === "grouped" && group.attention_event_id !== null) { this.store.terminal(progress.job_id); return; }
    this.store.begin(progress.job_id);
    let finishDelivery!: () => void;
    const deliveryOperation = new Promise<void>((resolve) => { finishDelivery = resolve; });
    this.deliveryOperations.set(progress.job_id, deliveryOperation);
    let requestStarted = false;
    try {
      const token = await readPrivateToken(this.config.updateInternalTokenPath);
      if (!token) { this.store.retry(progress.job_id, "missing internal token"); return; }
      const progressId = `${job.job_id}:${progress.sequence}`;
      const deliveryToken = randomBytes(32).toString("hex");
      this.deliveryClaims.set(progressId, deliveryToken);
      const body = Buffer.from(JSON.stringify({ schema_version:1, progress_id:progressId, delivery_token:deliveryToken }));
      await new Promise<void>((resolve,reject) => { let settled=false; const chunks:Buffer[]=[]; let responseSize=0; const finish=(error?:Error)=>{if(settled)return;settled=true;error?reject(error):resolve();}; const request=http.request({socketPath:this.config.slackAdapterSocketPath,path:"/v1/internal/job-progress",method:"POST",headers:{"content-type":"application/json","content-length":String(body.length),"x-dona-update-token":token}},response=>{ requestStarted=true; response.on("data",(chunk:Buffer)=>{responseSize+=chunk.length;if(responseSize<=4096)chunks.push(chunk);}); response.once("aborted",()=>finish(Object.assign(new Error("response aborted"),{acceptanceUnknown:true}))); response.once("error",error=>finish(Object.assign(error,{acceptanceUnknown:true}))); response.once("end",()=>{let retryAfterSeconds:number|undefined;try{const parsed=JSON.parse(Buffer.concat(chunks).toString()) as {retry_after_seconds?:unknown};if(typeof parsed.retry_after_seconds==="number")retryAfterSeconds=parsed.retry_after_seconds;}catch{} response.statusCode===200?finish():finish(Object.assign(new Error(`HTTP ${response.statusCode}`),{definitelyUnsent:[400,401,403,404,429].includes(response.statusCode??0),retryAfterSeconds}));});}); request.setTimeout(Math.max(this.config.jobCommandTimeoutMs,30_000),()=>request.destroy(Object.assign(new Error("timeout"),{acceptanceUnknown:true}))); request.once("socket",socket=>socket.once("connect",()=>{requestStarted=true;})); request.once("error",error=>finish(error)); request.end(body); });
      this.store.delivered(progress.job_id);
      this.deliveryClaims.delete(`${job.job_id}:${progress.sequence}`);
    } catch (error) {
      const detail = error as Error & { code?: string; definitelyUnsent?: boolean; acceptanceUnknown?: boolean; retryAfterSeconds?:number };
      const definitelyUnsent = detail.definitelyUnsent || (!requestStarted && ["ENOENT","ECONNREFUSED"].includes(detail.code ?? ""));
      this.deliveryClaims.delete(`${job.job_id}:${progress.sequence}`);
      if (definitelyUnsent) {
        const at=new Date();
        if(detail.retryAfterSeconds!==undefined)this.store.deferWorkspace(job.workspace_id,new Date(at.getTime()+Math.max(5,detail.retryAfterSeconds)*1_000));
        this.store.retry(progress.job_id, detail.message, at, detail.retryAfterSeconds);
      }
      else { if(await this.drainAdapterUntilSettled(progress.job_id))this.store.unknown(progress.job_id, detail.message); }
    } finally {
      finishDelivery();
      this.deliveryOperations.delete(progress.job_id);
    }
  }

  notificationReady(job:JobRow): boolean {
    const siblings=this.jobs.listEventJobs(job.source_event_id).map((item)=>this.jobs.getJob(item.job_id)!).filter(Boolean);
    if (siblings.every((item)=>terminalStatuses.has(item.status))) return siblings.every((item)=>this.jobNotificationReady(item.job_id));
    return this.jobNotificationReady(job.job_id) && siblings.every((item)=>!this.deliveryOperations.has(item.job_id));
  }

  reconcileTerminal(job:JobRow): Promise<void> {
    const existing=this.terminalReconciliations.get(job.source_event_id); if(existing)return existing;
    const operation=(async()=>{const items=this.jobs.listEventJobs(job.source_event_id);await this.drainDeliveries(items.map((item)=>item.job_id));for(const item of items){const row=this.jobs.getJob(item.job_id);if(row&&terminalStatuses.has(row.status)&&!this.jobNotificationReady(row.job_id))await this.ingest(row);}})();
    this.terminalReconciliations.set(job.source_event_id,operation);
    void operation.finally(()=>this.terminalReconciliations.delete(job.source_event_id)).catch(()=>undefined);
    return operation;
  }

  private jobNotificationReady(jobId:string):boolean { const row=this.store.get(jobId);return row!==undefined&&row.terminal_checked===1&&!this.deliveryOperations.has(jobId); }
  async drainDeliveries(jobIds?:string[]):Promise<void> { const operations=jobIds?jobIds.flatMap((jobId)=>{const operation=this.deliveryOperations.get(jobId);return operation?[operation]:[]}):[...this.deliveryOperations.values()];await Promise.allSettled(operations); }
  async stop():Promise<void> {this.drainAbort.abort();await Promise.allSettled([...this.terminalReconciliations.values()]);await this.drainDeliveries();}

  private async drainAdapter():Promise<void> {
    const token=await readPrivateToken(this.config.updateInternalTokenPath); if(!token)throw new Error("missing internal token for progress drain");
    await new Promise<void>((resolve,reject)=>{const request=http.request({socketPath:this.config.slackAdapterSocketPath,path:"/v1/internal/job-progress/drain",method:"POST",headers:{"content-length":"0","x-dona-update-token":token}},response=>{response.resume();response.once("end",()=>response.statusCode===200||[404,503].includes(response.statusCode??0)?resolve():reject(new Error(`progress drain HTTP ${response.statusCode}`)));});const abort=()=>request.destroy(Object.assign(new Error("progress drain aborted"),{name:"AbortError"}));this.drainAbort.signal.addEventListener("abort",abort,{once:true});request.once("close",()=>this.drainAbort.signal.removeEventListener("abort",abort));request.once("error",(error:NodeJS.ErrnoException)=>["ENOENT","ECONNREFUSED"].includes(error.code??"")?resolve():reject(error));request.end();});
  }

  private async drainAdapterUntilSettled(jobId:string):Promise<boolean> {
    for(;;){
      if(this.drainAbort.signal.aborted)return false;
      try {await this.drainAdapter();return true;}
      catch {if(this.drainAbort.signal.aborted)return false;this.logger.warn("Ambiguous progress drain will be retried",{job_id:jobId,error_code:"job_progress_drain_retry"});await new Promise<void>((resolve)=>{let settled=false;const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);this.drainAbort.signal.removeEventListener("abort",finish);resolve();};const timer=setTimeout(finish,5_000);this.drainAbort.signal.addEventListener("abort",finish,{once:true});});}
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
    if (group?.notification_mode === "grouped" && (!group.sealed_at || group.attention_event_id !== null)) return undefined;
    const index = siblings.findIndex((item) => item.job_id === job.job_id) + 1;
    return { progress_id:progressId, workspace_id:job.workspace_id, channel_id:job.channel_id, thread_ts:job.thread_ts,
      status:siblings.length > 1 ? `${siblings.length}件中${index}件目: ${phaseLabels[progress.phase]}` : phaseLabels[progress.phase] };
  }

  deliveryDeferred(progressId:string, deliveryToken:string):boolean {
    const match = /^(job_[0-9a-z]+):(\d+)$/.exec(progressId); if(!match)return false;
    const progress=this.store.get(match[1]!); const job=this.jobs.getJob(match[1]!);
    if(this.deliveryClaims.get(progressId)!==deliveryToken||!progress||progress.status!=="delivering"||progress.sequence!==Number(match[2])||!job)return false;
    const group=this.jobs.getJobGroup(job.source_event_id);
    return group?.notification_mode==="grouped"&&!group.sealed_at&&group.attention_event_id===null;
  }
}
