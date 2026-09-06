import fs from "node:fs/promises";

import type { DispatcherConfig } from "./config.js";
import type { DispatcherDatabase } from "./database.js";
import type { HerdrCommandResult } from "./herdr.js";
import type { JobAgentRuntime } from "./job-runtime.js";
import { buildJobPrompt } from "./job-prompt.js";
import { JobResultNotFoundError, readJobResultEnvelope } from "./job-result.js";
import type { Logger } from "./logger.js";
import type { JobRow } from "./types.js";

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

export interface JobControlResult {
  row: JobRow;
  duplicate: boolean;
}

export class JobSupervisor {
  private readonly wakeSignal = new WakeSignal();
  private readonly abortController = new AbortController();
  private readonly active = new Map<string, Promise<void>>();
  private readonly controls = new Map<string, Promise<unknown>>();
  private loopPromise: Promise<void> | undefined;
  private running = false;
  private stopping = false;

  constructor(
    private readonly database: DispatcherDatabase,
    private readonly runtime: JobAgentRuntime,
    private readonly config: DispatcherConfig,
    private readonly logger: Logger,
    private readonly wakeEventWorker: () => void,
  ) {}

  isRunning(): boolean {
    return this.running && !this.stopping;
  }

  start(): void {
    if (this.loopPromise) return;
    const recovered = this.database.recoverStaleJobs();
    if (recovered.retryable || recovered.needsReview) {
      this.logger.warn("Recovered stale jobs", {
        retryable_count: recovered.retryable,
        needs_review_count: recovered.needsReview,
      });
    }
    this.running = true;
    this.loopPromise = this.loop().catch((error: unknown) => {
      this.logger.error("Job supervisor stopped unexpectedly", {
        error_code: "job_supervisor_crashed",
        error_message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
  }

  wake(): void {
    this.wakeSignal.wake();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abortController.abort();
    this.wake();
    await this.loopPromise;
    await Promise.allSettled(this.active.values());
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
      if (before.status === "cancelled") return { row: before, duplicate: true };
      const cancelling = this.database.beginJobCancellation(jobId, sourceEventId);
      if (["queued", "retryable_failed"].includes(before.status)) {
        this.database.markJobCancelled(jobId, reason);
        this.wake();
        return { row: this.database.getJob(jobId)!, duplicate: false };
      }
      if (["preparing", "dispatching"].includes(before.status)) await this.active.get(jobId);
      const cancelled = await this.runtime.cancel(cancelling.agent_name, this.abortController.signal);
      if(before.status==="preparing"&&!cancelled.timedOut&&["agent_not_found","agent_not_running"].includes(cancelled.errorCode??"")) {
        this.database.markJobCancelled(jobId,reason); this.wake();
        return {row:this.database.getJob(jobId)!,duplicate:false};
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
      this.database.markJobCancelled(jobId, reason);
      this.wake();
      return { row: this.database.getJob(jobId)!, duplicate: false };
    });
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      for (const job of this.database.listScheduledJobsRequiringCancellation()) {
        try { await this.cancel(job.job_id, job.source_event_id, "Schedule was cancelled or its authorization expired"); }
        catch (error) { this.logger.warn("Scheduled job cancellation requires review", { job_id: job.job_id,
          error_message: error instanceof Error ? error.message : String(error) }); }
      }
      for (const job of this.database.listOverdueScheduledJobs()) {
        try { await this.cancel(job.job_id, job.source_event_id, "Scheduled work exceeded its 3600 second execution deadline"); }
        catch (error) { this.logger.warn("Scheduled job deadline cancellation requires review", { job_id: job.job_id,
          error_message: error instanceof Error ? error.message : String(error) }); }
      }
      this.publishNotifications();
      const availableSlots = Math.max(0, this.config.jobConcurrency - this.active.size);
      const rows = this.database.listRunnableJobs().filter((row) => !this.active.has(row.job_id));
      for (const row of rows.slice(0, availableSlots)) this.launch(row);
      await this.wakeSignal.wait(this.config.queuePollMs);
    }
  }

  private publishNotifications(): void {
    for (const job of this.database.listJobsNeedingNotification()) {
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
      .finally(() => {
        this.active.delete(row.job_id);
        this.wake();
      });
    this.active.set(row.job_id, operation);
  }

  private async startJob(row: JobRow): Promise<void> {
    try {
      await fs.access(row.result_path);
      this.database.markJobNeedsReview(row.job_id, "result_path_exists", "A job result file existed before prompt submission");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const preparing = this.database.beginJobPreparation(row.job_id);
    let prepared;
    try {
      prepared = await this.runtime.prepare(preparing, this.abortController.signal);
    } catch (error) {
      if (this.stopping) return;
      if (this.database.getJob(row.job_id)?.status !== "preparing") return;
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
    if (this.database.getJob(row.job_id)?.status !== "preparing") return;
    this.database.setJobRuntime(row.job_id, prepared.herdrWorkspaceId, prepared.herdrPaneId);
    const dispatching = this.database.beginJobDispatch(row.job_id);
    const prompted = await this.runtime.prompt(dispatching.agent_name, buildJobPrompt(dispatching), this.abortController.signal);
    if (this.database.getJob(row.job_id)?.status !== "dispatching") return;
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
    if (this.database.getJob(row.job_id)?.status !== "running") return;
    if (await this.tryComplete(row, false)) return;
    const waited = await this.runtime.wait(row.agent_name, this.abortController.signal);
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
        waited.errorCode ?? "agent_wait_failed",
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

  private async tryComplete(row: JobRow, terminalAgentState: boolean): Promise<boolean> {
    try {
      const result = await readJobResultEnvelope(row.result_path, row.job_id);
      this.database.saveJobResult(row.job_id, result, row.result_path);
      this.logTransition(row, this.database.getJob(row.job_id)!);
      return true;
    } catch (error) {
      if (["cancelling","cancelled"].includes(this.database.getJob(row.job_id)?.status ?? "")) return true;
      if (error instanceof JobResultNotFoundError && !terminalAgentState) return false;
      this.database.markJobNeedsReview(
        row.job_id,
        error instanceof JobResultNotFoundError ? "result_missing" : "invalid_result",
        error instanceof Error ? error.message : String(error),
      );
      return true;
    }
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
