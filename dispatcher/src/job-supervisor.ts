import fs from "node:fs/promises";

import type { DispatcherConfig } from "./config.js";
import type { DispatcherDatabase } from "./database.js";
import type { HerdrCommandResult } from "./herdr.js";
import type { JobAgentRuntime } from "./job-runtime.js";
import { buildJobPrompt } from "./job-prompt.js";
import { JobResultNotFoundError, readJobResultEnvelope } from "./job-result.js";
import type { Logger } from "./logger.js";
import type { JobRow } from "./types.js";
import type { JobProgressCoordinator } from "./job-progress.js";

class WakeSignal {
  private resolver: (() => void) | undefined;

  wake(): void {
    this.resolver?.();
    this.resolver = undefined;
  }

  wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.resolver = undefined;
        resolve();
      }, milliseconds);
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

const schedulerStatsIntervalMs = 60_000;

export interface JobControlResult {
  row: JobRow;
  duplicate: boolean;
}

interface ActiveJob {
  sourceEventId: string;
  operation: Promise<void>;
}

export class JobSupervisor {
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
  private running = false;
  private stopping = false;
  private staleJobsRecovered = false;

  constructor(
    private readonly database: DispatcherDatabase,
    private readonly runtime: JobAgentRuntime,
    private readonly config: DispatcherConfig,
    private readonly logger: Logger,
    private readonly wakeEventWorker: () => void,
    private progress?: JobProgressCoordinator,
  ) {}

  isRunning(): boolean {
    return this.running && !this.stopping;
  }

  start(): void {
    if (this.loopPromise) return;
    this.recoverStaleJobs();
    this.running = true;
    this.loopPromise = this.loop().catch((error: unknown) => {
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

  disableProgress(): void { this.progress = undefined; }

  wake(): void {
    this.nextRunnableScanAt = 0;
    this.wakeSignal.wake();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abortController.abort();
    this.wake();
    await this.loopPromise;
    await this.progressLoopPromise;
    await Promise.allSettled([...this.controls.values()]);
    await Promise.allSettled([...this.active.values()].map(({ operation }) => operation));
    this.running = false;
  }

  steer(jobId: string, sourceEventId: string, instruction: string): Promise<JobControlResult> {
    return this.serialized(jobId, async () => {
      const current = this.database.getJob(jobId);
      if (!current) throw new Error(`Job ${jobId} was not found`);
      if (["queued", "retryable_failed"].includes(current.status)) {
        const row = this.database.appendQueuedJobInstruction(jobId, sourceEventId, instruction);
        this.wake();
        return { row, duplicate: current.steer_event_id === sourceEventId && current.steer_state === "accepted" };
      }
      const begun = this.database.beginJobSteer(jobId, sourceEventId);
      if (begun.duplicate) return begun;
      const prompted = await this.runtime.prompt(begun.row.agent_name, instruction, this.abortController.signal);
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
        this.database.markJobNeedsReview(jobId, prompted.errorCode!, commandMessage(prompted));
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
      if (["queued", "retryable_failed"].includes(before.status)) {
        this.database.markJobCancelled(jobId, reason);
        this.wake();
        return { row: this.database.getJob(jobId)!, duplicate: false };
      }
      const cancelled = await this.runtime.cancel(cancelling.agent_name, this.abortController.signal);
      if (!cancelled.ok) {
        this.database.markJobNeedsReview(
          jobId,
          cancelled.errorCode ?? "cancel_acceptance_unknown",
          commandMessage(cancelled),
        );
        this.wake();
        throw new Error(`Job ${cancelling.job_id} cancellation requires review`);
      }
      this.database.markJobCancelled(jobId, reason);
      this.wake();
      return { row: this.database.getJob(jobId)!, duplicate: false };
    });
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
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

  private async progressLoop(): Promise<void> {
    while (!this.stopping) {
      try { await this.progress?.report(); }
      catch (error) {
        this.logger.warn("Job progress reporting cycle failed", {
          error_code: "job_progress_cycle_failed",
          error_message: error instanceof Error ? error.message : String(error),
        });
      }
      await abortableDelay(this.config.queuePollMs, this.abortController.signal);
    }
  }

  private scheduleRunnableJobs(): void {
    for (const row of this.database.listRunningJobs()) {
      if (!this.active.has(row.job_id)) this.launch(row);
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
      if (this.progress) {
        try {
          if (!this.progress.notificationReady(job)) {
            void this.progress.reconcileTerminal(job).then(()=>this.wake(),(error)=>this.logger.warn("Terminal progress reconciliation failed",{job_id:job.job_id,error_code:"job_progress_terminal_reconcile_failed",error_message:error instanceof Error?error.message:String(error)}));
            continue;
          }
        } catch (error) {
          this.logger.warn("Job progress disabled after notification gate failure", { job_id:job.job_id, error_code:"job_progress_notification_gate_failed", error_message:error instanceof Error?error.message:String(error) });
          const failedProgress=this.progress;
          void failedProgress.drainDeliveries().then(()=>{if(this.progress===failedProgress)this.progress=undefined;this.wake();});
          continue;
        }
      }
      try {
        const event = this.database.enqueueJobNotification(job.job_id);
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
      .finally(() => {
        this.active.delete(row.job_id);
        this.wake();
      });
    this.active.set(row.job_id, { sourceEventId: row.source_event_id, operation });
  }

  private async startJob(row: JobRow): Promise<void> {
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
      if (this.stopping) return;
      const updated = this.database.recordJobPreparationFailure(
        row.job_id,
        errorCode(error),
        error instanceof Error ? error.message : String(error),
        this.config.maxAttempts,
      );
      this.logTransition(preparing, updated);
      return;
    }
    if (this.stopping) return;
    this.database.setJobRuntime(row.job_id, prepared.herdrWorkspaceId, prepared.herdrPaneId);
    const dispatching = this.database.beginJobDispatch(row.job_id);
    const prompted = await this.runtime.prompt(dispatching.agent_name, buildJobPrompt(dispatching), this.abortController.signal);
    if (prompted.aborted || this.stopping) {
      this.database.markJobNeedsReview(row.job_id, "prompt_interrupted", "Dispatcher stopped while job prompt acceptance was unknown");
      return;
    }
    if (!prompted.ok) {
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
        prompted.errorCode ?? (prompted.timedOut ? "prompt_timeout" : "prompt_acceptance_unknown"),
        commandMessage(prompted),
      );
      return;
    }
    this.database.markJobRunning(row.job_id);
    const running = this.database.getJob(row.job_id)!;
    this.logTransition(dispatching, running);
    await this.monitor(running);
  }

  private async monitor(row: JobRow): Promise<void> {
    await this.progress?.ingest(this.database.getJob(row.job_id) ?? row);
    if (await this.tryComplete(row, false)) return;
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
              await this.updateTerminalProgress(row.job_id);
              break;
            }
            await this.progress?.ingest(current);
          }
          catch (error) { this.logger.warn("Job progress polling failed", { job_id: row.job_id, error_code: "job_progress_poll_failed", error_message: error instanceof Error ? error.message : String(error) }); }
        }
      }
    })();
    const waited = await this.runtime.wait(row.agent_name, this.abortController.signal);
    keepPolling = false;
    pollAbort.abort();
    await pollProgress;
    this.abortController.signal.removeEventListener("abort", stopPoll);
    if (waited.aborted || this.stopping) return;
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
        waited.errorCode ?? "agent_wait_failed",
        commandMessage(waited),
      );
      await this.updateTerminalProgress(row.job_id);
      return;
    }
    if (waited.agentStatus === "blocked") {
      this.database.markJobBlocked(row.job_id, "Background agent is waiting for approval or human input");
      await this.updateTerminalProgress(row.job_id);
      return;
    }
    if (["idle", "done"].includes(waited.agentStatus ?? "")) {
      await this.tryComplete(row, true);
    }
  }

  private async updateTerminalProgress(jobId: string): Promise<void> {
    try { await this.progress?.ingest(this.database.getJob(jobId)!); }
    catch (error) { this.logger.warn("Terminal job progress update failed", { job_id:jobId, error_code:"job_progress_terminal_failed", error_message:error instanceof Error ? error.message : String(error) }); }
  }

  private async tryComplete(row: JobRow, terminalAgentState: boolean): Promise<boolean> {
    let completed: JobRow;
    try {
      const result = await readJobResultEnvelope(row.result_path, row.job_id);
      this.database.saveJobResult(row.job_id, result, row.result_path);
      completed = this.database.getJob(row.job_id)!;
    } catch (error) {
      if (error instanceof JobResultNotFoundError && !terminalAgentState) return false;
      this.database.markJobNeedsReview(
        row.job_id,
        error instanceof JobResultNotFoundError ? "result_missing" : "invalid_result",
        error instanceof Error ? error.message : String(error),
      );
      completed = this.database.getJob(row.job_id)!;
    }
    try { await this.progress?.ingest(completed); }
    catch (error) { this.logger.warn("Terminal job progress update failed", { job_id: row.job_id, error_code: "job_progress_terminal_failed", error_message: error instanceof Error ? error.message : String(error) }); }
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
