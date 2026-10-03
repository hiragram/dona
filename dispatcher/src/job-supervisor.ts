import { readCheckpoint } from "./task-checkpoint.js";
import { TaskProjector, githubQuery } from "./task-github.js";
import { taskRecoveryReason, type TaskRow } from "./task-execution.js";
import { jobSnapshot, publicObservation, type WorkerObservation } from "./job-handoff.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { DispatcherConfig } from "./config.js";
import type { DispatcherDatabase } from "./database.js";
import type { HerdrCommandResult } from "./herdr.js";
import { PreparedWorkspaceCleanupError, type JobAgentRuntime } from "./job-runtime.js";
import { buildJobPrompt, jobProgressPath } from "./job-prompt.js";
import { JobResultNotFoundError, readJobResultEnvelope } from "./job-result.js";
import type { Logger } from "./logger.js";
import type { JobRow } from "./types.js";
import type { JobProgressCoordinator } from "./job-progress.js";
import { buildLiveSessionReceipt, expectedLiveSessionIdentity, type LiveSessionReceiptProjection } from "./live-session.js";

class WakeSignal {
  private resolver: (() => void) | undefined;

  wake(): void {
    this.resolver?.();
    this.resolver = undefined;
  }

  wait(milliseconds: number, unref = false): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.resolver = undefined;
        resolve();
      }, milliseconds);
      if(unref)timer.unref();
      this.resolver = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

function commandMessage(result: HerdrCommandResult): string {
  if (result.aborted) return "Herdr command was interrupted during shutdown";
  if (result.timedOut) return "Herdr command timed out";
  return (result.stderr || result.stdout || "Herdr command failed").slice(0, 2_000);
}

function errorCode(error: unknown): string {
  const code = (error as Error & { code?: string }).code;
  return code ?? "job_preparation_failed";
}

function maximumCount(counts: Iterable<number>): number {
  let maximum = 0;
  for (const count of counts) maximum = Math.max(maximum, count);
  return maximum;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); }
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function directoryNames(parent: string): Promise<string[]> {
  try {
    return (await fs.readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

const schedulerStatsIntervalMs = 60_000;

function terminalAgentAbsentFromList(result:HerdrCommandResult,agentName:string):boolean {
  if(!result.ok||result.timedOut||result.aborted)return false;
  try {
    const parsed=JSON.parse(result.stdout) as {result?:{type?:unknown;agents?:unknown}};
    return parsed.result?.type==="agent_list"&&Array.isArray(parsed.result.agents)&&
      parsed.result.agents.every((item:unknown)=>item!==null&&typeof item==="object"&&
        typeof (item as {name?:unknown}).name==="string"&&
        (item as {name:string}).name!==agentName);
  } catch { return false; }
}

export interface JobControlResult {
  row: JobRow;
  duplicate: boolean;
}

interface ActiveJob {
  sourceEventId: string;
  operation: Promise<void>;
}

interface SupervisorClock {
  now(): number;
  delay(milliseconds: number, signal: AbortSignal): Promise<void>;
}

const systemClock: SupervisorClock = {
  now: () => performance.now(),
  delay: abortableDelay,
};

export class JobSupervisor {
  private readonly liveSessionBootId=`boot_${randomUUID().replaceAll("-","")}`;
  private readonly wakeSignal = new WakeSignal();
  private readonly abortController = new AbortController();
  private readonly active = new Map<string, ActiveJob>();
  private readonly controls = new Map<string, Promise<unknown>>();
  private fairCursorSourceEventId: string | undefined;
  private fairCycleEndSourceEventId: string | undefined;
  private lastSchedulerState: string | undefined;
  private nextRunnableScanAt = 0;
  private nextSchedulerStatsAt = 0;
  private loopPromise: Promise<void> | undefined;
  private progressLoopPromise: Promise<void> | undefined;
  private readonly cancelledWorkerCleanups = new Set<Promise<void>>();
  private readonly cancelledCleanupWake = new WakeSignal();
  private cancelledCleanupRecovery: Promise<void> | undefined;
  private taskProjection:Promise<void>|undefined;
  private running = false;
  private stopping = false;
  private staleJobsRecovered = false;
  private terminalStopProofCursor = "";
  private terminalCleanupCursor = "";
  private terminalCleanupOperation:Promise<void>|undefined;

  private async reconcileTerminalCleanup(job:JobRow,outcome:"pending"|"attempting",claimedAgentName:string|null):Promise<void> {
    // Herdrへの制御は不変のjob名で宛先を指定する。sessionとpaneは送信条件にしない。
    const agentName=job.job_id;
    if(outcome==="pending") {
      if(job.agent_name!==agentName||!this.runtime.listAgents) {
        this.database.finishTerminalWorkerCleanup(job.job_id,"pending","rejected");
        return;
      }
      const byName=await this.runtime.get(agentName,this.abortController.signal,Math.min(2_000,this.config.jobCommandTimeoutMs));
      if(!byName.ok) {
        const absent=!byName.timedOut&&!byName.aborted&&
          ["agent_not_found","agent_not_running"].includes(byName.errorCode??"");
        if(!absent) return;
        const listed=absent?await this.runtime.listAgents(this.abortController.signal,Math.min(2_000,this.config.jobCommandTimeoutMs)):undefined;
        if(listed&&terminalAgentAbsentFromList(listed,agentName))
          this.database.finishTerminalWorkerCleanup(job.job_id,"pending","stopped");
        return;
      }
      if(this.database.getJob(job.job_id)?.agent_name!==agentName) {
        this.database.finishTerminalWorkerCleanup(job.job_id,"pending","rejected");
        return;
      }
      if(!["idle","done"].includes(byName.agentStatus??"")) return;
      if(!this.database.claimTerminalWorkerCleanup(job.job_id,agentName)) return;
      // The durable claim precedes the only control write. A crash or timeout never causes a resend.
      try {
        await this.runtime.cancel(agentName,this.abortController.signal);
      } catch { /* An ambiguous send is reconciled by read only. */ }
    } else if(!claimedAgentName||job.agent_name!==agentName) {
      this.database.finishTerminalWorkerCleanup(job.job_id,"attempting","unknown");
      return;
    }
    const deadline=Date.now()+Math.min(2_000,this.config.jobCommandTimeoutMs);
    do {
      const observed=await this.runtime.get(agentName,this.abortController.signal,Math.min(2_000,this.config.jobCommandTimeoutMs));
      if(!observed.ok&&!observed.timedOut&&!observed.aborted&&["agent_not_found","agent_not_running"].includes(observed.errorCode??"")) {
        const listed=await this.runtime.listAgents?.(this.abortController.signal,Math.min(2_000,this.config.jobCommandTimeoutMs));
        if(listed&&terminalAgentAbsentFromList(listed,agentName)) {
          this.database.finishTerminalWorkerCleanup(job.job_id,"attempting","stopped");
          return;
        }
      }
      if(!observed.ok||this.stopping) break;
      await abortableDelay(100,this.abortController.signal);
    } while(Date.now()<deadline);
    this.database.finishTerminalWorkerCleanup(job.job_id,"attempting","unknown");
  }

  constructor(
    private readonly database: DispatcherDatabase,
    private readonly runtime: JobAgentRuntime,
    private readonly config: DispatcherConfig,
    private readonly logger: Logger,
    private readonly wakeEventWorker: () => void,
    private progress?: JobProgressCoordinator,
    private readonly clock: SupervisorClock = systemClock,
  ) {}

  isRunning(): boolean {
    return this.running && !this.stopping;
  }

  private async observeWorker(job: JobRow): Promise<WorkerObservation> {
    let observation: WorkerObservation = this.runtime.observeWorker
      ? await this.runtime.observeWorker(job, this.abortController.signal)
      : {state:"unknown",reason:"runtime_observation_unavailable",observed_at:new Date().toISOString(),process_ids:[],process_groups:[]};
    const prior = this.database.getWorkerObservation(job);
    if (observation.state === "unknown" && prior && this.runtime.workerRetired &&
        await this.runtime.workerRetired(job, prior, this.abortController.signal))
      observation = { ...prior, state: "stopped", reason: "recorded_processes_and_pane_absent", observed_at: new Date().toISOString() };
    this.database.recordWorkerObservation(job, observation);
    return observation;
  }


  async reconcileTasks(): Promise<void> {
    for (const task of this.database.tasks.candidates().slice(0,1)) {
      if(this.stopping) return;
      await this.serialized(task.current_attempt_id, async()=>{
        try { await this.reconcileTask(task); }
        catch { this.database.tasks.wait(task,"external_effect_unknown"); }
      });
    }
  }

  private async reconcileTask(snapshot:TaskRow):Promise<void> {
    let task=this.database.tasks.get(snapshot.task_id)!;
    if(task.revision!==snapshot.revision||task.current_attempt_id!==snapshot.current_attempt_id)return;
    const job=this.database.getJob(task.current_attempt_id)!;
    if(task.wait_reason==="steer_acceptance_unknown"&&job.steer_state==="accepted"&&job.steer_event_id&&task.steer_pending_event_id===job.steer_event_id) {
      this.database.tasks.finishSteer(task.task_id,job.steer_event_id);return;
    }
    // A result is evidence belonging to this attempt, never to its successor.
    try {
      const result=await readJobResultEnvelope(job.result_path,job.job_id);
      this.database.saveJobResult(job.job_id,result,job.result_path);return;
    } catch(error) {
      if(!(error instanceof JobResultNotFoundError)) {this.database.tasks.wait(task,"result_conflict");return;}
    }
    if(task.wait_reason==="steer_acceptance_unknown") {this.database.tasks.wait(task,"steer_acceptance_unknown",60_000);return;}
    const checkpoint=await readCheckpoint(job,task.task_id);
    let capacityWait=false;
    if(checkpoint) {
      this.database.tasks.checkpoint(job,checkpoint);
      if(task.desired_state==="running"&&["human_input","external_effect_unknown"].includes(checkpoint.waiting)&&!this.database.tasks.checkpointAnswered(job,checkpoint)) {this.database.tasks.wait(task,checkpoint.waiting);return;}
      capacityWait=checkpoint.waiting==="usage_limit"&&!this.database.tasks.checkpointAnswered(job,checkpoint);
      if(task.desired_state==="running"&&capacityWait&&checkpoint.retry_after&&Date.parse(checkpoint.retry_after)>Date.now()) {
        this.database.tasks.wait(task,"capacity_wait",Math.min(Date.parse(checkpoint.retry_after)-Date.now(),86_400_000));return;
      }
    }
    if(task.stop_state==="stopped") {this.database.tasks.replaceStopped(task.task_id,this.config.jobResultsDir);this.wake();return;}
    if(task.desired_state==="running"&&task.stop_state==="none") {
      const reason=taskRecoveryReason(job);
      if(reason!=="observation_unknown"&&task.wait_reason!=="resume_requested"&&!capacityWait) {this.database.tasks.wait(task,reason);return;}
    }
    if(!this.runtime.observeWorker||!this.runtime.retireWorker||!this.runtime.workerRetired){this.database.tasks.wait(task,"observation_unknown");return;}
    if(task.stop_state==="none"||task.stop_state==="not_sent") {
      const observed=await this.observeWorker(job);
      if(observed.state==="working"&&task.desired_state==="running") {this.database.tasks.reconnect(task);return;}
      if(observed.state==="waiting"&&task.desired_state==="running") {this.database.tasks.wait(task,capacityWait?"capacity_wait":"human_input",capacityWait?task.retry_delay_ms:30_000);return;}
      if(observed.state==="unknown") {this.database.tasks.wait(task,"observation_unknown");return;}
      if(this.database.getJob(job.job_id)?.updated_at!==job.updated_at)return;
      if(task.stop_state==="none"&&task.desired_state==="running") {
        const fresh=await this.observeWorker(job);
        if(!["inactive","stopped"].includes(fresh.state)||JSON.stringify(fresh.process_ids)!==JSON.stringify(observed.process_ids)||JSON.stringify(fresh.process_groups)!==JSON.stringify(observed.process_groups)) {
          this.database.tasks.wait(task,"observation_unknown");return;
        }
      }
      if(task.stop_state==="none")task=this.database.tasks.claimStop(task,this.database.getWorkerObservation(job)??observed);
      // Last observation before the only control write; current desired state is checked by CAS.
      if(observed.state!=="stopped"&&this.database.tasks.beginStop(task)) {
        try {await this.runtime.retireWorker(job,this.abortController.signal);}catch{/* reconcile without resending */}
      }
    }
    const evidence=JSON.parse(task.stop_evidence_json!) as WorkerObservation;
    if(!await this.runtime.workerRetired(job,evidence,this.abortController.signal)){this.database.tasks.wait(task,"worker_stop_pending");return;}
    this.database.tasks.stopped(task,evidence);
    this.database.tasks.replaceStopped(task.task_id,this.config.jobResultsDir);
    this.wake();
  }

  async inspectWorker(jobId: string, sourceEventId: string): Promise<Record<string, unknown>> {
    this.database.assertHandoffOwner(jobId, sourceEventId);
    const before = this.database.getJob(jobId)!;
    let observation = await this.observeWorker(before);
    this.database.assertHandoffOwner(jobId, sourceEventId);
    if (jobSnapshot(this.database.getJob(jobId)!) !== jobSnapshot(before))
      observation = { ...observation, state: "unknown", reason: "job_changed_during_observation", process_ids: [], process_groups: [] };
    const handoff = this.database.getJobHandoff(jobId);
    return { schema_version: 1, job_id: jobId, durable_status: this.database.getJob(jobId)!.status,
      worker: publicObservation(observation), handoff: handoff ? { state: handoff.state, retirement_state: handoff.retirement_state, successor_job_id: handoff.successor_job_id } : null };
  }

  resumeJob(jobId: string, sourceEventId: string, instruction: string): Promise<Record<string, unknown>> {
    if(this.database.tasks.forAttempt(jobId))return Promise.reject(new Error("task_control_required"));
    return this.serialized(jobId, async () => {
      this.database.assertHandoffOwner(jobId, sourceEventId);
      let record = this.database.getJobHandoff(jobId);
      if (record && record.instruction !== instruction) throw new Error("handoff_instruction_conflict");
      if (record?.successor_job_id) return { schema_version: 1, outcome: "reused", predecessor_job_id: jobId, job_id: record.successor_job_id };
      if (!this.runtime.observeWorker || !this.runtime.retireWorker || !this.runtime.workerRetired) throw new Error("handoff_runtime_unavailable");
      if (!record) {
        const before = this.database.getJob(jobId)!;
        if (!["running", "blocked", "needs_review"].includes(before.status)) throw new Error("handoff_job_not_resumable");
        try { await fs.lstat(before.result_path); throw new Error("handoff_result_requires_reconciliation"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const observation = await this.observeWorker(before);
        if (!["inactive", "stopped"].includes(observation.state)) return { schema_version: 1, outcome: "not_resumed", job_id: jobId, worker: publicObservation(observation) };
        // Recheck immediately before reserving the handoff.
        const fresh = await this.observeWorker(before);
        if (!["inactive", "stopped"].includes(fresh.state) || (JSON.stringify(fresh.process_ids) !== JSON.stringify(observation.process_ids) || JSON.stringify(fresh.process_groups) !== JSON.stringify(observation.process_groups)))
          return { schema_version: 1, outcome: "not_resumed", job_id: jobId, worker: publicObservation(fresh) };
        this.database.assertHandoffAdmission(before, sourceEventId, instruction, this.config.jobsWorkspaceRoot, this.config.jobResultsDir);
        record = this.database.claimJobHandoff(before, sourceEventId, instruction, fresh);
      }
      const old = JSON.parse(record.expected_job_json) as JobRow;
      const evidence = JSON.parse(record.observation_json) as WorkerObservation;
      if (record.retirement_state === "not_sent") {
        // A crash after claim is recoverable. Only an atomic unsent -> attempting
        // receipt permits a write; an ambiguous attempt is never sent again.
        const fresh = await this.observeWorker(old);
        if (!["inactive", "stopped"].includes(fresh.state) || JSON.stringify(fresh.process_ids) !== JSON.stringify(evidence.process_ids) ||
            JSON.stringify(fresh.process_groups) !== JSON.stringify(evidence.process_groups))
          return { schema_version: 1, outcome: "not_resumed", job_id: jobId, worker: publicObservation(fresh) };
        this.database.assertHandoffAdmission(old, sourceEventId, instruction, this.config.jobsWorkspaceRoot, this.config.jobResultsDir);
        if (fresh.state !== "stopped" && this.database.beginHandoffRetirement(jobId, sourceEventId)) {
          try { await this.runtime.retireWorker(old, this.abortController.signal); }
          catch { /* Read-only reconciliation below establishes the actual outcome. */ }
        }
      }
      let stopped = await this.runtime.workerRetired(old, evidence, this.abortController.signal);
      const deadline = Date.now() + 2_000;
      while (!stopped && !this.stopping && Date.now() < deadline) {
        await abortableDelay(100, this.abortController.signal);
        stopped = await this.runtime.workerRetired(old, evidence, this.abortController.signal);
      }
      if (!stopped) return { schema_version: 1, outcome: "retirement_pending", job_id: jobId };
      const successor = this.database.finishJobHandoff(jobId, sourceEventId, this.config.jobsWorkspaceRoot, this.config.jobResultsDir);
      this.wake();
      return { schema_version: 1, outcome: "created", predecessor_job_id: jobId, job_id: successor.job_id };
    });
  }

  async observeLiveSession(jobId:string,sourceEventId?:string):Promise<LiveSessionReceiptProjection> {
    const before=this.database.getJob(jobId);
    if(!before)throw new Error(`Job ${jobId} was not found`);
    const startedAt=new Date().toISOString();
    const storedIdentity=this.database.getJobLiveSessionIdentity(jobId);
    const expectedIdentity=expectedLiveSessionIdentity(before,storedIdentity);
    let result:HerdrCommandResult|undefined;
    if(expectedIdentity){
      try { result=await this.runtime.get(before.agent_name,this.abortController.signal,this.config.jobCommandTimeoutMs); }
      catch { result={ok:false,stdout:"",stderr:"",exitCode:null,timedOut:false,aborted:false,errorCode:"transport_unavailable"}; }
    }
    const after=this.database.getJob(jobId);
    if(!after)throw new Error(`Job ${jobId} disappeared during live observation`);
    const storedIdentityAfter=this.database.getJobLiveSessionIdentity(jobId);
    const identityGenerationKey=(identity:typeof storedIdentity):string=>JSON.stringify(identity?[identity.job_id,identity.identity_version,
      identity.herdr_agent_session_id,identity.herdr_workspace_id,identity.herdr_pane_id,identity.agent_name,identity.recorded_at]:null);
    const identityGenerationChanged=identityGenerationKey(storedIdentityAfter)!==identityGenerationKey(storedIdentity)
      || expectedLiveSessionIdentity(after,storedIdentityAfter)!==expectedIdentity;
    const completedAt=new Date().toISOString();
    const previousStateChangeSeq=storedIdentity&&!identityGenerationChanged
      ? this.database.latestLiveSessionStateChangeSeq(jobId,storedIdentity)
      : undefined;
    const receipt=buildLiveSessionReceipt({before,after,bootId:this.liveSessionBootId,startedAt,completedAt,
      ...(sourceEventId?{sourceEventId}:{}),...(expectedIdentity?{expectedIdentity}:{}),
      ...(identityGenerationChanged?{identityGenerationChanged:true}:{}),
      ...(previousStateChangeSeq===undefined?{}:{previousStateChangeSeq}),...(result?{result}:{})});
    return this.database.appendLiveSessionReceipt(sourceEventId,receipt,startedAt,identityGenerationChanged?undefined:storedIdentity);
  }

  getLiveSessionReceipt(jobId:string,receiptId:string):LiveSessionReceiptProjection|undefined {
    return this.database.getLiveSessionReceipt(jobId,receiptId);
  }

  start(): void {
    if (this.loopPromise) return;
    this.recoverStaleJobs();
    this.trackRecoveredCancelledWorkerCleanups();
    this.running = true;
    this.loopPromise = this.stopLegacySharedGrantAgents().then(()=>this.loop()).catch((error: unknown) => {
      this.logger.error("Job supervisor stopped unexpectedly", {
        error_code: "job_supervisor_crashed",
        error_message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
    if (this.progress) this.progressLoopPromise = this.progressLoop();
  }

  recoverStaleJobs(): void {
    if (this.staleJobsRecovered) return;
    this.staleJobsRecovered = true;
    const recovered = this.database.recoverStaleJobs();
    if (recovered.retryable || recovered.needsReview) {
      this.logger.warn("Recovered stale jobs", {
        retryable_count: recovered.retryable,
        needs_review_count: recovered.needsReview,
      });
    }
  }

  async disableProgress(): Promise<void> {
    this.progress = undefined; this.runtime.disableProgress?.();
    try {
      for await(const progressDir of this.progressDirectories()){
        await fs.rm(progressDir,{recursive:true,force:true}).catch(()=>{
          this.logger.warn("Disabled job progress cleanup failed",{error_code:"job_progress_disable_cleanup_failed"});
        });
      }
    } catch (error) {
      this.logger.warn("Disabled job progress cleanup stopped", { error_code:"job_progress_disable_cleanup_stopped", error_message:error instanceof Error?error.message:String(error) });
    }
  }

  private async stopLegacySharedGrantAgents():Promise<void> {
    for(const job of this.database.listLegacySharedGrantJobs()) {
      const stopped=await this.runtime.cancel(job.agent_name,this.abortController.signal);
      if(!stopped.ok&&["agent_not_found","agent_not_running"].includes(stopped.errorCode??"")) {
        this.database.markLegacySharedGrantAgentStopped(job.job_id);
        const current = this.database.getJob(job.job_id)!;
        if (!["completed","failed","cancelled"].includes(current.status))
          await this.tryComplete(current,false);
        continue;
      }
      if(!stopped.ok) throw new Error(`Legacy agent ${job.agent_name} could not be stopped before isolated jobs start`);
      if(!this.runtime.closeAgent) throw new Error(`Legacy agent ${job.agent_name} cannot be closed by this runtime`);
      const closed=await this.runtime.closeAgent(job.agent_name,this.abortController.signal);
      if(!closed.ok&&!['agent_not_found','agent_not_running'].includes(closed.errorCode??"")) throw new Error(`Legacy agent ${job.agent_name} could not be closed before isolated jobs start`);
      const deadline=Date.now()+this.config.jobCommandTimeoutMs;
      let exited=false;
      while(Date.now()<deadline) {
        const observed=await this.runtime.get(job.agent_name,this.abortController.signal);
        if(!observed.ok&&["agent_not_found","agent_not_running"].includes(observed.errorCode??"")) {exited=true;break;}
        if(!observed.ok) throw new Error(`Legacy agent ${job.agent_name} exit could not be observed`);
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      if(!exited) throw new Error(`Legacy agent ${job.agent_name} exit was not observed`);
      this.database.markLegacySharedGrantAgentStopped(job.job_id);
      const current = this.database.getJob(job.job_id)!;
      if (!["completed","failed","cancelled"].includes(current.status))
        await this.tryComplete(current,false);
    }
  }

  wake(): void {
    this.nextRunnableScanAt = 0;
    this.wakeSignal.wake();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const progressStop=this.progress?.stop();
    this.abortController.abort();
    this.wake();
    this.cancelledCleanupWake.wake();
    await this.loopPromise;
    await this.terminalCleanupOperation;
    await this.taskProjection;
    await this.progressLoopPromise;
    await progressStop;
    await Promise.allSettled([...this.controls.values()]);
    await Promise.allSettled([...this.active.values()].map(({ operation }) => operation));
    await Promise.allSettled([...this.cancelledWorkerCleanups]);
    this.running = false;
  }

  steer(jobId: string, sourceEventId: string, instruction: string): Promise<JobControlResult> {
    return this.serialized(jobId, async () => {
      const current = this.database.getJob(jobId);
      if (!current) throw new Error(`Job ${jobId} was not found`);
      if (["queued", "retryable_failed"].includes(current.status)) {
        const result = this.database.appendQueuedJobInstruction(jobId, sourceEventId, instruction);
        this.wake();
        return result;
      }
      const begun = this.database.beginJobSteer(jobId, sourceEventId);
      if (begun.duplicate) return begun;
      // Steer acceptance is the CLI submission response, not a later worker state change.
      const prompted = await this.runtime.prompt(begun.row.agent_name, instruction, this.abortController.signal, undefined, true);
      if (prompted.ok) {
        this.database.markJobSteerAccepted(jobId, sourceEventId);
        return { row: this.database.getJob(jobId)!, duplicate: false };
      }
      if (!prompted.timedOut && prompted.errorCode === "agent_blocked") {
        this.database.clearJobSteer(jobId, sourceEventId);
        this.database.markJobBlocked(jobId, "Background agent is waiting for approval or human input");
        this.wake();
        throw new Error(`Job ${jobId} is blocked and could not accept steer input`);
      }
      if (!prompted.timedOut && ["agent_not_found", "agent_not_running"].includes(prompted.errorCode ?? "")) {
        this.database.clearJobSteer(jobId, sourceEventId);
        const current = this.database.getJob(jobId);
        if (current && ["completed", "failed", "cancelled"].includes(current.status) &&
          current.last_error_code === "terminal_steer_worker_unverified") {
          // The name may have been rebound. Keep the terminal stop fence.
        } else {
          this.database.markJobNeedsReview(jobId, prompted.errorCode!, commandMessage(prompted));
        }
        this.wake();
        throw new Error(commandMessage(prompted));
      }
      this.database.markJobNeedsReview(jobId, prompted.errorCode ?? "steer_acceptance_unknown", commandMessage(prompted));
      this.wake();
      throw new Error(`Job ${jobId} steer acceptance is unknown and requires review`);
    });
  }

  cancel(jobId: string, sourceEventId: string, reason = "Cancelled by Dona"): Promise<JobControlResult> {
    return this.serialized(jobId, async () => {
      const before = this.database.getJob(jobId);
      if (!before) throw new Error(`Job ${jobId} was not found`);
      this.database.assertJobSourceMatchesThread(jobId, sourceEventId);
      if (before.status === "cancelled") return { row: before, duplicate: true };
      const cancelling = this.database.beginJobCancellation(jobId, sourceEventId);
      if (before.status === "retryable_failed" && before.last_error_code === "stale_preparing") {
        let absent = false;
        let observedAgent = false;
        try {
          const observed = await this.runtime.get(cancelling.agent_name, this.abortController.signal);
          absent = !observed.ok && !observed.timedOut &&
            ["agent_not_found", "agent_not_running"].includes(observed.errorCode ?? "");
          observedAgent = observed.ok;
        } catch {
          // A failed read is not evidence that the preparation agent is absent.
        }
        if (!absent && (!observedAgent || before.herdr_workspace_id === null)) {
          this.database.markJobNeedsReview(jobId, "stale_preparing_agent_unverified",
            "Cancellation cannot establish the preparation agent state");
          this.wake();
          throw new Error(`Job ${jobId} cancellation requires review`);
        }
        if (absent) {
          this.database.markJobCancelled(jobId, reason);
          this.wake();
          return { row: this.database.getJob(jobId)!, duplicate: false };
        }
      }
      if (before.status === "queued" ||
          (before.status === "retryable_failed" && before.last_error_code !== "stale_preparing")) {
        this.database.markJobCancelled(jobId, reason);
        this.wake();
        return { row: this.database.getJob(jobId)!, duplicate: false };
      }
      if (["preparing", "dispatching"].includes(before.status)) await this.active.get(jobId)?.operation;
      if(before.last_error_code==="legacy_agent_sandbox_unknown"&&this.database.isLegacySharedGrantAgentStopped(jobId)) {
        this.database.markJobCancelled(jobId,reason); this.wake();
        return {row:this.database.getJob(jobId)!,duplicate:false};
      }
      const cancelled = await this.runtime.cancel(cancelling.agent_name, this.abortController.signal);
      if((before.status==="preparing" || ["stale_preparing", "stale_preparing_agent_unverified"].includes(before.last_error_code ?? "")) &&
          !cancelled.timedOut && ["agent_not_found","agent_not_running"].includes(cancelled.errorCode??"")) {
        this.database.markJobCancelled(jobId,reason); this.wake();
        return {row:this.database.getJob(jobId)!,duplicate:false};
      }
      if (!cancelled.ok && !cancelled.timedOut &&
          ["agent_not_found","agent_not_running"].includes(cancelled.errorCode??"")) {
        if (await this.tryComplete(cancelling,false)) {
          return { row: this.database.getJob(jobId)!, duplicate:false };
        }
        this.database.markJobCancelled(jobId,reason); this.wake();
        return { row:this.database.getJob(jobId)!, duplicate:false };
      }
      if (!cancelled.ok) {
        this.database.markJobNeedsReview(
          jobId,
          "cancel_acceptance_unknown",
          commandMessage(cancelled),
        );
        this.wake();
        throw new Error(`Job ${cancelling.job_id} cancellation requires review`);
      }
      const deadline=Date.now()+this.config.jobCommandTimeoutMs;
      let stopped=false;
      while(Date.now()<deadline) {
        const observed=await this.runtime.get(cancelling.agent_name,this.abortController.signal);
        if((observed.ok&&["idle","done"].includes(observed.agentStatus??""))||
          (!observed.ok&&["agent_not_found","agent_not_running"].includes(observed.errorCode??""))) {stopped=true;break;}
        if(!observed.ok) break;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      if(!stopped) {
        this.database.markJobNeedsReview(jobId,"cancel_exit_unknown","Agent exit was not observed after cancellation acceptance");
        this.wake(); throw new Error(`Job ${cancelling.job_id} cancellation requires review`);
      }
      if(await this.tryComplete(cancelling,false)) {
        return {row:this.database.getJob(jobId)!,duplicate:false};
      }
      this.database.markJobCancelled(jobId, reason);
      this.trackCancelledWorkerCleanup(cancelling);
      this.wake();
      return { row: this.database.getJob(jobId)!, duplicate: false };
    });
  }

  private trackCancelledWorkerCleanup(_row:JobRow):void {
    this.trackRecoveredCancelledWorkerCleanups();
    this.cancelledCleanupWake.wake();
  }

  private trackRecoveredCancelledWorkerCleanups():void {
    if(this.cancelledCleanupRecovery)return;
    const recovery=(async()=>{
      while(!this.stopping){
        for await(const progressDir of this.progressDirectories()){
          if(this.stopping)return;
          const jobId=path.basename(progressDir);
          const row=this.database.getJob(jobId);
          if(!row||!["cancelled","needs_review"].includes(row.status)||path.dirname(jobProgressPath(row))!==progressDir)continue;
          try {
            const waited=await this.runtime.wait(row.agent_name,this.abortController.signal);
            if(waited.aborted||this.stopping)return;
            const terminal=(waited.ok&&(waited.agentStatus==="idle"||waited.agentStatus==="done"))||(!waited.ok&&!waited.timedOut&&(waited.errorCode==="agent_not_found"||waited.errorCode==="agent_not_running"));
            if(terminal)await fs.rm(progressDir,{recursive:true,force:true});
          } catch(error) {
            if(this.stopping)return;
            this.logger.warn("Cancelled worker progress cleanup attempt failed",{job_id:row.job_id,error_code:"job_progress_cancelled_worker_cleanup_failed",error_message:error instanceof Error?error.message:String(error)});
          }
        }
        if(this.stopping)return;
        await this.cancelledCleanupWake.wait(this.config.queuePollMs,true);
      }
    })();
    this.cancelledCleanupRecovery=recovery;
    this.cancelledWorkerCleanups.add(recovery);void recovery.finally(()=>{this.cancelledWorkerCleanups.delete(recovery);if(this.cancelledCleanupRecovery===recovery)this.cancelledCleanupRecovery=undefined;}).catch(()=>undefined);
  }

  private async *progressDirectories():AsyncGenerator<string> {
    const scratchRoot=path.join(this.config.jobsWorkspaceRoot,"scratch",".dona-progress");
    for(const jobId of await directoryNames(scratchRoot))yield path.join(scratchRoot,jobId);
    const githubRoot=path.join(this.config.jobsWorkspaceRoot,"github");
    for(const owner of await directoryNames(githubRoot)){
      for(const repository of await directoryNames(path.join(githubRoot,owner))){
        const progressRoot=path.join(githubRoot,owner,repository,"worktrees",".dona-progress");
        for(const jobId of await directoryNames(progressRoot))yield path.join(progressRoot,jobId);
      }
    }
  }

  private launchTerminalCleanup():void {
    if(this.terminalCleanupOperation||this.stopping)return;
    let candidates=this.database.listTerminalWorkerCleanupCandidates(this.terminalCleanupCursor,1);
    if(candidates.length===0&&this.terminalCleanupCursor) {
      this.terminalCleanupCursor="";
      candidates=this.database.listTerminalWorkerCleanupCandidates("",1);
    }
    const candidate=candidates[0];
    if(!candidate)return;
    this.terminalCleanupCursor=candidate.job.job_id;
    const operation=this.reconcileTerminalCleanup(candidate.job,candidate.outcome,candidate.identity_json)
      .catch((error:unknown)=>{
        // Before a send, pending remains retryable. After a durable claim,
        // attempting is recovered by observation without another send.
        this.logger.warn("Terminal worker cleanup observation failed",{job_id:candidate.job.job_id,
          error_message:error instanceof Error?error.message:String(error)});
      })
      .finally(()=>{if(this.terminalCleanupOperation===operation)this.terminalCleanupOperation=undefined;});
    this.terminalCleanupOperation=operation;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      this.launchTerminalCleanup();
      if(!this.taskProjection) {
        const task=this.database.tasks.projectCandidates()[0];
        if(task) this.taskProjection=new TaskProjector(this.database,githubQuery(this.config.ghPath)).sync(task)
          .catch(()=>{}).finally(()=>{this.taskProjection=undefined;});
      }
      for(const job of this.database.listAmbiguousScheduledJobs()) try {
        if(await this.reconcileAmbiguousScheduledJob(job)) continue;
        if(!["cancel_acceptance_unknown","cancel_exit_unknown","ambiguous_cancel_acceptance"].includes(job.last_error_code??"")) continue;
        const observed=await this.runtime.get(job.agent_name,this.abortController.signal);
        if((observed.ok&&["idle","done"].includes(observed.agentStatus??""))||
          (!observed.ok&&["agent_not_found","agent_not_running"].includes(observed.errorCode??""))) {
          if(await this.tryComplete(job,false)) continue;
          this.database.settleAmbiguousCancellation(job.job_id,"Agent termination was confirmed after ambiguous cancellation");
        }
      } catch(error) {
        this.logger.warn("Scheduled job reconciliation requires review",{job_id:job.job_id,error_message:error instanceof Error?error.message:String(error)});
      }
      for (const job of this.database.listScheduledJobsRequiringCancellation()) {
        await this.tryComplete(job,false);
        const current=this.database.getJob(job.job_id);
        if(["completed","failed"].includes(current?.status??"")) continue;
        if(current?.status==="needs_review"&&["invalid_result","invalid_result_agent_stop_unknown"].includes(current.last_error_code??"")) {await this.stopInvalidResultAgent(job);continue;}
        try { await this.cancel(job.job_id, job.source_event_id, "Schedule was cancelled or its authorization expired"); }
        catch (error) { this.logger.warn("Scheduled job cancellation requires review", { job_id: job.job_id,
          error_message: error instanceof Error ? error.message : String(error) }); }
      }
      for (const job of this.database.listOverdueScheduledJobs()) {
        await this.tryComplete(job,false);
        const current=this.database.getJob(job.job_id);
        if(["completed","failed"].includes(current?.status??"")) continue;
        if(current?.status==="needs_review"&&["invalid_result","invalid_result_agent_stop_unknown"].includes(current.last_error_code??"")) {await this.stopInvalidResultAgent(job);continue;}
        try { await this.cancel(job.job_id, job.source_event_id, "Scheduled work exceeded its 3600 second execution deadline"); }
        catch (error) { this.logger.warn("Scheduled job deadline cancellation requires review", { job_id: job.job_id,
          error_message: error instanceof Error ? error.message : String(error) }); }
      }
      for (const job of this.database.listTerminalScheduledJobsNeedingCleanup()) {
        try {
          if (!this.runtime.cleanup) continue;
          const cleaned = await this.runtime.cleanup(job, this.abortController.signal);
          if (!cleaned.ok) throw new Error(commandMessage(cleaned));
          this.database.markJobRuntimeCleaned(job.job_id);
        } catch (error) {
          this.logger.warn("Terminal scheduled job cleanup will be retried", {
            job_id: job.job_id,
            error_message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      // A name-based Herdr read, including idle/done or agent_not_found, does not
      // prove that the saved agent session was stopped. Keep terminal workers in
      // the update drain gate until an exact-identity stop receipt is available.
      await this.reconcileTasks();
      this.publishNotifications();
      try {
        this.scheduleRunnableJobs();
      } catch (error) {
        this.logger.warn("Job scheduling cycle failed", {
          error_code: (error as Error & { code?: string }).code ?? "job_scheduler_query_failed",
          error_message: error instanceof Error ? error.message : String(error),
        });
      }
      await this.wakeSignal.wait(this.config.queuePollMs);
    }
  }

  private async reconcileAmbiguousScheduledJob(job:JobRow):Promise<boolean> {
    if(job.last_error_code==="invalid_result") {await this.stopInvalidResultAgent(job);return true;}
    if(job.last_error_code!=="invalid_result_agent_stop_unknown") return this.tryComplete(job,false);
    const observed=await this.runtime.get(job.agent_name,this.abortController.signal);
    if((observed.ok&&["idle","done"].includes(observed.agentStatus??"")&&await this.closeAndConfirmInvalidResultAgent(job))||
      (!observed.ok&&["agent_not_found","agent_not_running"].includes(observed.errorCode??""))) {
      this.database.recordInvalidResultAgentStopped(job.job_id);
      if(await this.tryComplete(job,false)) return true;
    }
    return true;
  }

  private async stopInvalidResultAgent(job:JobRow):Promise<void> {
    const stopped=await this.runtime.cancel(job.agent_name,this.abortController.signal);
    if(!stopped.ok&&! ["agent_not_found","agent_not_running"].includes(stopped.errorCode??"")) {this.database.recordInvalidResultAgentStopFailure(job.job_id,commandMessage(stopped));return;}
    if(!stopped.ok) {this.database.recordInvalidResultAgentStopped(job.job_id);await this.tryRecoverStoppedInvalidResult(job.job_id);return;}
    const deadline=Date.now()+this.config.jobCommandTimeoutMs;
    while(Date.now()<deadline) {
      const observed=await this.runtime.get(job.agent_name,this.abortController.signal);
      if(!observed.ok&&["agent_not_found","agent_not_running"].includes(observed.errorCode??"")) {this.database.recordInvalidResultAgentStopped(job.job_id);await this.tryRecoverStoppedInvalidResult(job.job_id);return;}
      if(!observed.ok) break;
      if(["idle","done"].includes(observed.agentStatus??"")) {
        if(await this.closeAndConfirmInvalidResultAgent(job)) {this.database.recordInvalidResultAgentStopped(job.job_id);await this.tryRecoverStoppedInvalidResult(job.job_id);return;}
        break;
      }
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    this.database.recordInvalidResultAgentStopFailure(job.job_id,"Agent exit was not observed after invalid Result");
  }

  private async closeAndConfirmInvalidResultAgent(job:JobRow):Promise<boolean> {
    if(!this.runtime.closeAgent)return false;
    const closed=await this.runtime.closeAgent(job.agent_name,this.abortController.signal);
    if(!closed.ok&&! ["agent_not_found","agent_not_running"].includes(closed.errorCode??""))return false;
    const absent=await this.runtime.get(job.agent_name,this.abortController.signal);
    return !absent.ok&&["agent_not_found","agent_not_running"].includes(absent.errorCode??"");
  }

  private async tryRecoverStoppedInvalidResult(jobId:string):Promise<void> {
    const stopped=this.database.getJob(jobId);
    if(stopped?.last_error_code!=="invalid_result_agent_stopped") return;
    try {
      const result=await readJobResultEnvelope(stopped.result_path,stopped.job_id);
      this.database.saveJobResult(stopped.job_id,result,stopped.result_path);
    } catch {
      // The invalid/missing Result remains fenced for operator review after the worker is stopped.
    }
  }

  private async progressLoop(): Promise<void> {
    while (!this.stopping) {
      const failedProgress=this.progress;
      try { await failedProgress?.report(); }
      catch (error) {
        this.logger.warn("Job progress reporting cycle failed", {
          error_code: "job_progress_cycle_failed",
          error_message: error instanceof Error ? error.message : String(error),
        });
        if(failedProgress){await failedProgress.drainDeliveries();if(this.progress===failedProgress)await this.disableProgress();}
      }
      await abortableDelay(this.config.queuePollMs, this.abortController.signal);
    }
  }

  private scheduleRunnableJobs(): void {
    for (const row of this.database.listRunningJobs()) {
      if (!this.active.has(row.job_id)&&this.database.tasks.canRun(row)) this.launch(row);
    }

    const availableSlots = Math.max(0, this.config.jobConcurrency - this.active.size);
    const effectivePerEventLimit = Math.min(
      this.config.jobConcurrency,
      this.config.jobConcurrencyPerEvent,
    );
    const activeCounts = new Map<string, number>();
    for (const active of this.active.values()) {
      activeCounts.set(active.sourceEventId, (activeCounts.get(active.sourceEventId) ?? 0) + 1);
    }
    const at = new Date();
    for (
      let selected = 0;
      selected < availableSlots && at.getTime() >= this.nextRunnableScanAt;
      selected += 1
    ) {
      const excludedSourceEventIds = [...activeCounts]
        .filter(([, count]) => count >= effectivePerEventLimit)
        .map(([sourceEventId]) => sourceEventId);
      const excludedJobIds = [...this.active.keys()];
      let row = this.fairCycleEndSourceEventId === undefined
        ? undefined
        : this.database.nextRunnableJob(
            at,
            this.fairCursorSourceEventId,
            excludedSourceEventIds,
            excludedJobIds,
            this.fairCycleEndSourceEventId,
          );
      if (!row) {
        this.fairCursorSourceEventId = undefined;
        this.fairCycleEndSourceEventId = this.database.beginRunnableCycle(at);
        row = this.fairCycleEndSourceEventId === undefined
          ? undefined
          : this.database.nextRunnableJob(
              at,
              this.fairCursorSourceEventId,
              excludedSourceEventIds,
              excludedJobIds,
              this.fairCycleEndSourceEventId,
            );
      }
      if (!row) {
        this.nextRunnableScanAt = this.database.nextWaitingJobAt(
          at,
          excludedSourceEventIds,
          excludedJobIds,
        )?.getTime() ?? Number.POSITIVE_INFINITY;
        break;
      }
      if(!this.database.tasks.canRun(row)) { this.nextRunnableScanAt=Date.now()+this.config.queuePollMs; break; }
      this.launch(row);
      activeCounts.set(row.source_event_id, (activeCounts.get(row.source_event_id) ?? 0) + 1);
      this.fairCursorSourceEventId = row.source_event_id;
    }
    this.logSchedulerState();
  }

  private logSchedulerState(): void {
    const now = Date.now();
    if (now < this.nextSchedulerStatsAt) return;
    this.nextSchedulerStatsAt = now + schedulerStatsIntervalMs;
    const queue = this.database.jobQueueStats([...this.active.keys()]);
    const activeCounts = new Map<string, number>();
    for (const active of this.active.values()) {
      activeCounts.set(active.sourceEventId, (activeCounts.get(active.sourceEventId) ?? 0) + 1);
    }
    const fields = {
      queued_jobs: queue.queuedJobs,
      queued_source_events: queue.queuedSourceEvents,
      queued_max_per_event: queue.queuedMaxPerEvent,
      active_jobs: this.active.size,
      active_source_events: activeCounts.size,
      active_max_per_event: maximumCount(activeCounts.values()),
      global_limit: this.config.jobConcurrency,
      per_event_limit: Math.min(this.config.jobConcurrency, this.config.jobConcurrencyPerEvent),
    };
    const state = JSON.stringify(fields);
    if (state === this.lastSchedulerState) return;
    this.lastSchedulerState = state;
    this.logger.debug("Job scheduler state changed", fields);
  }

  private publishNotifications(): void {
    for (const job of this.database.listJobsNeedingNotification()) {
      if(!this.database.tasks.mayNotify(job))continue;
      if (this.progress && job.source !== "dona_schedule") {
        try {
          if (!this.progress.notificationReady(job)) {
            const failedProgress=this.progress;
            void failedProgress.reconcileTerminal(job).then(()=>this.wake(),async(error)=>{this.logger.warn("Terminal progress reconciliation failed",{job_id:job.job_id,error_code:"job_progress_terminal_reconcile_failed",error_message:error instanceof Error?error.message:String(error)});await failedProgress.drainDeliveries();if(this.progress===failedProgress)await this.disableProgress();this.wake();});
            continue;
          }
        } catch (error) {
          this.logger.warn("Job progress disabled after notification gate failure", { job_id:job.job_id, error_code:"job_progress_notification_gate_failed", error_message:error instanceof Error?error.message:String(error) });
          const failedProgress=this.progress;
          void failedProgress.drainDeliveries().then(async()=>{if(this.progress===failedProgress)await this.disableProgress();this.wake();});
          continue;
        }
      }
      try {
        const event = this.database.enqueueJobNotification(job.job_id);
        if (event.row.source !== "dona_job") {
          this.logger.info("Job completion persisted without a Dona notification event", { job_id: job.job_id, job_status: job.status });
          continue;
        }
        this.logger.info("Job notification event enqueued", {
          job_id: job.job_id,
          job_status: job.status,
          event_id: event.row.event_id,
          sequence: event.row.sequence,
          duplicate: event.duplicate,
        });
        this.wakeEventWorker();
      } catch (error) {
        this.logger.error("Job notification could not be enqueued", {
          job_id: job.job_id,
          job_status: job.status,
          error_code: "job_notification_failed",
          error_message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private launch(row: JobRow): void {
    const operation = (row.status === "running" ? this.monitor(row) : this.startJob(row))
      .catch((error: unknown) => {
        this.logger.error("Job operation failed unexpectedly", {
          job_id: row.job_id,
          job_status: row.status,
          error_code: "job_operation_failed",
          error_message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(async () => {
        const finalStatus=this.database.getJob(row.job_id)?.status;
        if(this.progress&&finalStatus==="needs_review")this.trackCancelledWorkerCleanup(row);
        else if (!this.progress || (finalStatus!==undefined&&["blocked","completed","failed","cancelled"].includes(finalStatus))) await fs.rm(path.dirname(jobProgressPath(row)), { recursive:true, force:true }).catch(() => {
          this.logger.warn("Disabled job progress terminal cleanup failed", { job_id:row.job_id, error_code:"job_progress_disabled_terminal_cleanup_failed" });
        });
        this.active.delete(row.job_id);
        this.wake();
      });
    this.active.set(row.job_id, { sourceEventId: row.source_event_id, operation });
  }

  private async startJob(row: JobRow): Promise<void> {
    if(!this.database.tasks.canRun(row))return;
    if(this.database.tasks.forAttempt(row.job_id)&&!this.runtime.observeWorker) {
      this.database.markJobNeedsReview(row.job_id,"worker_identity_unverified","Runtime cannot record a worker identity");return;
    }
    try {
      await fs.access(row.result_path);
      this.database.markJobNeedsReview(row.job_id, "result_path_exists", "A job result file existed before prompt submission");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (this.stopping) return;

    const preparing = this.database.beginJobPreparation(row.job_id);
    let prepared;
    try {
      prepared = await this.runtime.prepare(preparing, this.abortController.signal);
    } catch (error) {
      if(error instanceof PreparedWorkspaceCleanupError) {
        this.database.setJobRuntime(row.job_id,error.herdrWorkspaceId,error.herdrPaneId);
        this.database.markJobNeedsReview(row.job_id,"workspace_cleanup_failed",error.message);
        return;
      }
      if (this.stopping) return;
      if (this.database.getJob(row.job_id)?.status !== "preparing") return;
      if (row.last_error_code === "stale_preparing") {
        // The previous attempt may have left an agent, even when its workspace
        // identity was recorded. A later preparation failure does not stop it.
        this.database.markJobNeedsReview(row.job_id, "stale_preparing_agent_unverified",
          "A previous preparation may have left an agent without verified termination");
        return;
      }
      const updated = this.database.recordJobPreparationFailure(
        row.job_id,
        errorCode(error),
        error instanceof Error ? error.message : String(error),
        this.config.maxAttempts,
      );
      this.logTransition(preparing, updated);
      return;
    }
    this.database.setJobRuntime(row.job_id, prepared.herdrWorkspaceId, prepared.herdrPaneId, prepared.herdrAgentSessionId);
    // Capture the shell/worker tree before the first prompt, for later exit verification.
    if (this.runtime.observeWorker && row.source !== "dona_schedule") {
      try {
        const evidence=await this.observeWorker(this.database.getJob(row.job_id)!);
        if(this.database.tasks.forAttempt(row.job_id)&&!evidence.process_ids.length) {
          this.database.markJobNeedsReview(row.job_id,"worker_identity_unverified","Worker process identity must be recorded before execution");return;
        }
      }
      catch { this.logger.warn("Worker process observation unavailable", {job_id:row.job_id}); }
    }
    if (this.database.getJob(row.job_id)?.status !== "preparing") return;
    const promptBaseline = await this.readPromptBaseline(preparing);
    if (this.stopping) return;
    if (this.database.getJob(row.job_id)?.status !== "preparing") return;
    if(!this.database.tasks.canRun(this.database.getJob(row.job_id)!)) {
      this.database.markJobNeedsReview(row.job_id,"task_control_pending","Task was paused or cancelled before prompt submission");return;
    }
    const dispatching = this.database.beginJobDispatch(row.job_id);
    const prompted = await this.runtime.prompt(
      dispatching.agent_name,
      buildJobPrompt(dispatching, this.progress !== undefined),
      this.abortController.signal,
      this.config.jobPromptTimeoutMs,
    );
    if (this.database.getJob(row.job_id)?.status !== "dispatching") return;
    if (prompted.aborted || this.stopping) {
      this.database.markJobNeedsReview(row.job_id, "prompt_interrupted", "Dispatcher stopped while job prompt acceptance was unknown");
      return;
    }
    if (!prompted.ok) {
      if (prompted.timedOut || prompted.errorCode === "agent_prompt_stalled") {
        if (row.source === "dona_schedule") {
          this.database.markJobNeedsReview(row.job_id,"prompt_acceptance_unknown",commandMessage(prompted));
          return;
        }
        await this.reconcileStalledPrompt(dispatching, promptBaseline ?? prompted);
        return;
      }
      if (!prompted.timedOut && ["agent_not_found", "agent_not_running"].includes(prompted.errorCode ?? "")) {
        const updated = this.database.recordJobSafePromptFailure(
          row.job_id,
          prompted.errorCode!,
          commandMessage(prompted),
          this.config.maxAttempts,
        );
        this.logTransition(dispatching, updated);
        return;
      }
      if (!prompted.timedOut && prompted.errorCode === "agent_blocked") {
        this.database.markJobBlocked(row.job_id, commandMessage(prompted), ["dispatching"]);
        return;
      }
      this.database.markJobNeedsReview(
        row.job_id,
        row.source === "dona_schedule"
          ? "prompt_acceptance_unknown"
          : prompted.errorCode ?? (prompted.timedOut ? "prompt_timeout" : "prompt_acceptance_unknown"),
        commandMessage(prompted),
      );
      return;
    }
    this.database.markJobRunning(row.job_id);
    const running = this.database.getJob(row.job_id)!;
    this.logTransition(dispatching, running);
    await this.monitor(running);
  }

  private async readPromptBaseline(row: JobRow): Promise<HerdrCommandResult | undefined> {
    try {
      const observed = await this.runtime.get(row.agent_name, this.abortController.signal);
      return observed.ok ? observed : undefined;
    } catch (error) {
      this.logger.warn("Could not read the Herdr agent before prompt submission", {
        job_id: row.job_id,
        error_code: errorCode(error),
      });
      return undefined;
    }
  }

  private async reconcileStalledPrompt(row: JobRow, initial: HerdrCommandResult): Promise<void> {
    const startedAt = this.clock.now();
    const deadline = startedAt + this.config.jobPromptReconcileMs;
    let nextTick = startedAt;
    const transientReasons = new Set<string>();
    while (!this.stopping && this.clock.now() < deadline) {
      const waitMs = nextTick - this.clock.now();
      if (waitMs > 0) await this.clock.delay(waitMs, this.abortController.signal);
      if (this.stopping || this.clock.now() >= deadline) break;
      if (await this.tryCompleteAfterUnknownAcceptance(row)) return;
      nextTick += this.config.jobPromptReconcilePollMs;
      const remainingMs = Math.max(1, deadline - this.clock.now());
      let observed: HerdrCommandResult;
      try {
        observed = await this.runtime.get(
          row.agent_name,
          this.abortController.signal,
          Math.min(this.config.jobPromptReconcilePollMs, remainingMs),
        );
      } catch {
        if (await this.tryCompleteAfterUnknownAcceptance(row)) return;
        if (this.stopping || this.abortController.signal.aborted) break;
        transientReasons.add("transport_failure");
        continue;
      }
      if (observed.aborted || this.stopping) {
        if (await this.tryCompleteAfterUnknownAcceptance(row)) return;
        this.database.markJobNeedsReview(row.job_id, "prompt_interrupted", "Dispatcher stopped while prompt reconciliation was incomplete");
        return;
      }
      if (!observed.ok) {
        if (await this.tryCompleteAfterUnknownAcceptance(row)) return;
        if (["invalid_response", "malformed_response", "response_too_large", "output_too_large"].includes(observed.errorCode ?? "")) {
          this.database.markJobNeedsReview(row.job_id, "prompt_reconcile_invalid_response", "Herdr agent status response was not safe to reconcile");
          return;
        }
        const reason = observed.timedOut || observed.errorCode === "timeout"
          ? "timeout"
          : ["agent_not_found", "agent_not_running"].includes(observed.errorCode ?? "")
            ? "agent_not_found"
            : "transport_failure";
        transientReasons.add(reason);
        continue;
      }
      if (initial.agentIdentity && observed.agentIdentity && initial.agentIdentity !== observed.agentIdentity) {
        if (await this.tryCompleteAfterUnknownAcceptance(row)) return;
        this.database.markJobNeedsReview(row.job_id, "prompt_agent_identity_changed", "Herdr agent identity changed during prompt reconciliation");
        return;
      }
      if (initial.agentIdentity && !observed.agentIdentity) {
        if (await this.tryCompleteAfterUnknownAcceptance(row)) return;
        this.database.markJobNeedsReview(row.job_id, "prompt_reconcile_invalid_response", "Herdr agent status omitted the expected identity");
        return;
      }
      if (initial.stateChangeSeq !== undefined && observed.stateChangeSeq === undefined) {
        if (await this.tryCompleteAfterUnknownAcceptance(row)) return;
        this.database.markJobNeedsReview(row.job_id, "prompt_reconcile_invalid_response", "Herdr agent status omitted the expected sequence");
        return;
      }
      if (initial.stateChangeSeq !== undefined && observed.stateChangeSeq !== undefined && observed.stateChangeSeq < initial.stateChangeSeq) {
        if (await this.tryCompleteAfterUnknownAcceptance(row)) return;
        this.database.markJobNeedsReview(row.job_id, "prompt_state_sequence_rollback", "Herdr agent state sequence moved backwards during prompt reconciliation");
        return;
      }
      const sameAgent = initial.agentIdentity !== undefined
        && observed.agentIdentity !== undefined
        && initial.agentIdentity === observed.agentIdentity;
      const progressed = sameAgent
        && initial.stateChangeSeq !== undefined
        && observed.stateChangeSeq !== undefined
        && observed.stateChangeSeq > initial.stateChangeSeq;
      if (progressed && ["working", "idle", "done", "blocked"].includes(observed.agentStatus ?? "")) {
        this.database.markJobRunning(row.job_id);
        if (observed.agentStatus === "blocked") {
          this.database.markJobBlocked(row.job_id, "Background agent is waiting for approval or human input");
          return;
        }
        await this.monitor(this.database.getJob(row.job_id)!);
        return;
      }
    }
    if (await this.tryCompleteAfterUnknownAcceptance(row)) return;
    const terminalCode = transientReasons.size > 1
      ? "prompt_reconcile_transient_failures"
      : transientReasons.has("timeout")
        ? "prompt_reconcile_timeout"
        : transientReasons.has("agent_not_found")
          ? "agent_not_found"
          : transientReasons.has("transport_failure")
            ? "prompt_reconcile_transport_failure"
            : "prompt_acceptance_unproven";
    this.database.markJobNeedsReview(
      row.job_id,
      this.stopping ? "prompt_interrupted" : terminalCode,
      this.stopping
        ? "Dispatcher stopped while prompt reconciliation was incomplete"
        : "Herdr prompt acceptance could not be proven without resubmission",
    );
  }

  private async tryCompleteAfterUnknownAcceptance(row: JobRow): Promise<boolean> {
    try {
      const result = await readJobResultEnvelope(row.result_path, row.job_id);
      this.database.markJobRunning(row.job_id);
      this.database.saveJobResult(row.job_id, result, row.result_path);
      return true;
    } catch (error) {
      if (error instanceof JobResultNotFoundError) return false;
      this.database.markJobNeedsReview(row.job_id, "invalid_result", error instanceof Error ? error.message : String(error));
      return true;
    }
  }

  private async monitor(row: JobRow): Promise<void> {
    if (this.database.getJob(row.job_id)?.status !== "running") return;
    const initialProgress=this.progress;
    try { await initialProgress?.ingest(this.database.getJob(row.job_id) ?? row); }
    catch (error) { await this.failOpenProgress(initialProgress,row.job_id,"job_progress_initial_ingest_failed",error); }
    if (await this.tryComplete(row, false)) return;
    if(this.database.tasks.forAttempt(row.job_id))await this.observeWorker(this.database.getJob(row.job_id)!);
    let keepPolling = true;
    const pollAbort = new AbortController();
    const stopPoll = (): void => pollAbort.abort();
    this.abortController.signal.addEventListener("abort", stopPoll, { once: true });
    const pollProgress = (async () => {
      while (keepPolling && !this.stopping) {
        await abortableDelay(this.config.queuePollMs, pollAbort.signal);
        if (keepPolling && !this.stopping) {
          try {
            const current = this.database.getJob(row.job_id) ?? row;
            if (["blocked", "completed", "failed", "cancelled", "needs_review"].includes(current.status)) {
              break;
            }
            await this.progress?.ingest(current);
          }
          catch (error) { await this.failOpenProgress(this.progress,row.job_id,"job_progress_poll_failed",error); }
        }
      }
    })();
    let waited:HerdrCommandResult;
    try { waited = await this.runtime.wait(row.agent_name, this.abortController.signal); }
    finally { keepPolling = false; pollAbort.abort(); await pollProgress; this.abortController.signal.removeEventListener("abort", stopPoll); }
    if (waited.aborted || this.stopping) return;
    if (this.database.getJob(row.job_id)?.status !== "running") return;
    if (!waited.ok) {
      if (waited.timedOut || waited.errorCode === "timeout") {
        this.logger.debug("Background job remains active", {
          job_id: row.job_id,
          job_status: "running",
        });
        return;
      }
      this.database.markJobNeedsReview(
        row.job_id,
        row.source === "dona_schedule" ? "agent_wait_observation_unknown" : waited.errorCode ?? "agent_wait_failed",
        commandMessage(waited),
      );
      return;
    }
    if (waited.agentStatus === "blocked") {
      this.database.markJobBlocked(row.job_id, "Background agent is waiting for approval or human input");
      return;
    }
    if (["idle", "done"].includes(waited.agentStatus ?? "")) {
      await this.tryComplete(row, true);
    }
  }

  private async failOpenProgress(progress:JobProgressCoordinator|undefined,jobId:string,errorCode:string,error:unknown):Promise<void> {
    this.logger.warn("Job progress disabled after worker polling failure",{job_id:jobId,error_code:errorCode,error_message:error instanceof Error?error.message:String(error)});
    if(!progress)return;
    await progress.drainDeliveries();
    if(this.progress===progress)await this.disableProgress();
  }

  private async tryComplete(row: JobRow, terminalAgentState: boolean): Promise<boolean> {
    let completed: JobRow;
    try {
      const result = await readJobResultEnvelope(row.result_path, row.job_id);
      this.database.saveJobResult(row.job_id, result, row.result_path);
      completed = this.database.getJob(row.job_id)!;
    } catch (error) {
      if (error instanceof JobResultNotFoundError && !terminalAgentState) return false;
      if (this.database.getJob(row.job_id)?.status === "cancelled") return true;
      this.database.markJobNeedsReview(
        row.job_id,
        error instanceof JobResultNotFoundError ? "result_missing" : "invalid_result",
        error instanceof Error ? error.message : String(error),
      );
      completed = this.database.getJob(row.job_id)!;
    }
    this.logTransition(row, completed);
    return true;
  }

  private logTransition(from: JobRow, to: JobRow): void {
    this.logger.info("Job status changed", {
      job_id: to.job_id,
      source_event_id: to.source_event_id,
      status_from: from.status,
      status_to: to.status,
      attempt_count: to.attempt_count,
      error_code: to.last_error_code,
    });
  }

  private serialized<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.controls.get(jobId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.controls.set(jobId, current);
    void current.finally(() => {
      if (this.controls.get(jobId) === current) this.controls.delete(jobId);
    }).catch(() => undefined);
    return current;
  }
}
