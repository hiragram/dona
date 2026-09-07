import fs from "node:fs/promises";
import path from "node:path";

import type { DispatcherConfig } from "./config.js";
import type { DispatcherDatabase } from "./database.js";
import type { HerdrClient, HerdrCommandResult } from "./herdr.js";
import type { Logger } from "./logger.js";
import { buildEventPrompt, envelopeFromRow } from "./prompt.js";
import { readResultEnvelope, ResultNotFoundError } from "./result.js";
import type { EventRow } from "./types.js";

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

const unavailableAgentErrors = new Set(["agent_not_found", "agent_not_running"]);

export class DispatcherWorker {
  private readonly wakeSignal = new WakeSignal();
  private readonly abortController = new AbortController();
  private running = false;
  private stopping = false;
  private quiescing = false;
  private loopPromise: Promise<void> | undefined;

  constructor(
    private readonly database: DispatcherDatabase,
    private readonly herdr: HerdrClient,
    private readonly config: DispatcherConfig,
    private readonly logger: Logger,
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.loopPromise) return;
    const recovered = this.database.recoverStaleDispatching();
    if (recovered > 0) {
      this.logger.warn("Recovered stale dispatching events as needs_review", { count: recovered });
    }
    this.running = true;
    this.loopPromise = this.loop()
      .catch((error: unknown) => {
        this.logger.error("Worker loop stopped unexpectedly", {
          error_code: "worker_crashed",
          error_message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      })
      .finally(() => {
        this.running = false;
      });
  }

  wake(): void {
    this.wakeSignal.wake();
  }

  quiesceAfterCurrent(): void {
    this.quiescing = true;
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abortController.abort();
    this.wake();
    await this.loopPromise;
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      if (this.quiescing) break;
      let handled = false;
      if (!this.database.hasBlockedEvent()) {
        const waiting = this.database.nextWaiting();
        if (waiting) {
          handled = true;
          await this.resumeWaiting(waiting);
        } else {
          const queued = this.database.nextAvailable();
          if (queued) {
            handled = true;
            await this.dispatch(queued);
          }
        }
      }
      if (this.quiescing) break;
      if (!handled || !this.stopping) await this.wakeSignal.wait(this.config.queuePollMs);
    }
  }

  private async dispatch(row: EventRow): Promise<void> {
    const started = Date.now();
    const preflight = await this.herdr.get(this.abortController.signal);
    if (this.stopping || preflight.aborted) return;
    if (!preflight.ok || !preflight.agentStatus) {
      const updated = this.database.recordPreDispatchFailure(
        row.event_id,
        preflight.errorCode ?? "herdr_unavailable",
        commandMessage(preflight),
        this.config.maxAttempts,
      );
      this.logTransition(row, updated, started);
      return;
    }
    if (preflight.agentStatus === "blocked") {
      this.database.markBlocked(row.event_id, "dona-main was blocked before prompt submission");
      this.logCurrentTransition(row, started);
      return;
    }
    if (!["idle", "done"].includes(preflight.agentStatus)) return;

    const resultPath = path.join(this.config.resultsDir, `${row.event_id}.json`);
    try {
      await fs.access(resultPath);
      const dispatching = this.database.beginDispatch(row.event_id, resultPath);
      this.database.markNeedsReview(
        row.event_id,
        "result_path_exists",
        "A result file already existed before prompt submission",
      );
      this.logCurrentTransition(dispatching, started);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const updated = this.database.recordPreDispatchFailure(
          row.event_id,
          "result_path_unavailable",
          error instanceof Error ? error.message : String(error),
          this.config.maxAttempts,
        );
        this.logTransition(row, updated, started);
        return;
      }
    }

    const dispatching = this.database.beginDispatch(row.event_id, resultPath);
    const prompt = buildEventPrompt(row.event_id, resultPath, envelopeFromRow(row));
    const prompted = await this.herdr.prompt(prompt, this.abortController.signal);
    if (prompted.aborted || this.stopping) {
      this.database.markNeedsReview(
        row.event_id,
        "prompt_interrupted",
        "Dispatcher stopped while prompt acceptance was unknown",
      );
      this.logCurrentTransition(dispatching, started);
      return;
    }
    if (!prompted.ok) {
      if (prompted.errorCode === "agent_blocked") {
        this.database.markBlocked(row.event_id, commandMessage(prompted), ["dispatching"]);
      } else if (["agent_not_found", "agent_not_running"].includes(prompted.errorCode ?? "")) {
        const updated = this.database.recordSafePromptFailure(
          row.event_id,
          prompted.errorCode ?? "agent_not_found",
          commandMessage(prompted),
          this.config.maxAttempts,
        );
        this.logTransition(dispatching, updated, started);
        return;
      } else {
        this.database.markNeedsReview(
          row.event_id,
          prompted.errorCode ?? (prompted.timedOut ? "prompt_timeout" : "prompt_unknown"),
          commandMessage(prompted),
        );
      }
      this.logCurrentTransition(dispatching, started);
      return;
    }

    this.database.markWaiting(row.event_id);
    const waiting = this.database.get(row.event_id)!;
    this.logTransition(dispatching, waiting, started);
    await this.resumeWaiting(waiting);
  }

  private async resumeWaiting(row: EventRow): Promise<void> {
    if (!row.result_path) {
      this.database.markNeedsReview(row.event_id, "missing_result_path", "waiting_agent event has no result path");
      return;
    }

    const existing = await this.tryComplete(row, false);
    if (existing) return;
    const started = Date.now();
    const waited = await this.herdr.wait(this.abortController.signal);
    if (waited.aborted || this.stopping) return;
    if (!waited.ok) {
      const errorCode = waited.errorCode ?? (waited.timedOut ? "agent_wait_timeout" : "agent_wait_failed");
      if (unavailableAgentErrors.has(errorCode)) {
        const unavailableSince = unavailableAgentErrors.has(row.last_error_code ?? "")
          ? Date.parse(row.updated_at)
          : Date.now();
        const unavailableDurationMs = Number.isFinite(unavailableSince)
          ? Date.now() - unavailableSince
          : 0;
        if (unavailableDurationMs >= this.config.agentMissingGraceMs) {
          this.database.markNeedsReview(
            row.event_id,
            "agent_unavailable_after_prompt",
            `Agent remained unavailable for ${unavailableDurationMs}ms after accepting the prompt; prompt was not resent`,
          );
          this.logCurrentTransition(row, started);
          return;
        }
        if (!unavailableAgentErrors.has(row.last_error_code ?? "")) {
          this.database.recordWaitingError(row.event_id, errorCode, commandMessage(waited));
        }
        this.logger.warn("Agent unavailable after prompt acceptance; waiting through grace period", {
          event_id: row.event_id,
          sequence: row.sequence,
          status_to: "waiting_agent",
          duration_ms: Date.now() - started,
          error_code: errorCode,
          grace_remaining_ms: Math.max(0, this.config.agentMissingGraceMs - unavailableDurationMs),
        });
        return;
      }
      this.database.recordWaitingError(row.event_id, errorCode, commandMessage(waited));
      this.logger.warn("Agent wait did not settle; prompt will not be resent", {
        event_id: row.event_id,
        sequence: row.sequence,
        status_to: "waiting_agent",
        duration_ms: Date.now() - started,
        error_code: errorCode,
      });
      return;
    }
    if (waited.agentStatus === "blocked") {
      this.database.markBlocked(row.event_id, "dona-main is waiting for human input", ["waiting_agent"]);
      this.logCurrentTransition(row, started);
      return;
    }
    if (!["idle", "done"].includes(waited.agentStatus ?? "")) {
      this.database.recordWaitingError(row.event_id, "unknown_agent_state", "Agent state could not be classified");
      return;
    }
    await this.tryComplete(row, true);
  }

  private async tryComplete(row: EventRow, terminalAgentState: boolean): Promise<boolean> {
    try {
      const result = await readResultEnvelope(row.result_path!, row.event_id);
      if (result.status === "completed") this.database.saveCompleted(row.event_id, result, row.result_path!);
      else this.database.saveFailedResult(row.event_id, result, row.result_path!);
      this.logCurrentTransition(row, Date.now());
      return true;
    } catch (error) {
      if (error instanceof ResultNotFoundError && !terminalAgentState) return false;
      this.database.markNeedsReview(
        row.event_id,
        error instanceof ResultNotFoundError ? "result_missing" : "invalid_result",
        error instanceof Error ? error.message : String(error),
      );
      this.logCurrentTransition(row, Date.now());
      return true;
    }
  }

  private logCurrentTransition(from: EventRow, started: number): void {
    const to = this.database.get(from.event_id);
    if (to) this.logTransition(from, to, started);
  }

  private logTransition(from: EventRow, to: EventRow, started: number): void {
    this.logger.info("Event status changed", {
      event_id: to.event_id,
      source: to.source,
      external_event_id: to.external_event_id,
      sequence: to.sequence,
      status_from: from.status,
      status_to: to.status,
      attempt_count: to.attempt_count,
      duration_ms: Date.now() - started,
      error_code: to.last_error_code,
    });
  }
}
