import { randomUUID } from "node:crypto";

import type { Logger } from "../logger.js";
import { nextOccurrence, previewOccurrences } from "./calculator.js";
import { DAY_MS, MAX_YEAR } from "./calendar.js";
import type { Clock } from "./clock.js";
import type { ScheduleDefinition } from "./domain.js";
import type { Actor, SchedulerRepository } from "./repository.js";

class WakeSignal {
  private pending = false;
  private resolver: (() => void) | undefined;

  wake(): void {
    this.pending = true;
    this.resolver?.();
    this.resolver = undefined;
  }

  wait(milliseconds: number): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.resolver = undefined;
        resolve();
      }, milliseconds);
      this.resolver = () => {
        clearTimeout(timer);
        this.pending = false;
        resolve();
      };
    });
  }
}

export interface SchedulerServiceOptions {
  batchSize?: number;
  leaseSeconds?: number;
  pollMilliseconds?: number;
  owner?: string;
}

export function nextPersistedOccurrence(definition: ScheduleDefinition, after: string): ReturnType<typeof nextOccurrence> {
  let cursor = after;
  const last = Date.parse(`${MAX_YEAR}-12-31T23:59:59Z`);
  while (Date.parse(cursor) < last) {
    const occurrence = nextOccurrence(definition, cursor);
    if (occurrence) return occurrence;
    const advanced = Math.min(Date.parse(cursor) + 366 * DAY_MS, last);
    if (advanced <= Date.parse(cursor)) break;
    cursor = new Date(advanced).toISOString().replace(".000Z", "Z");
  }
  return null;
}

export class SchedulerService {
  private readonly wakeSignal = new WakeSignal();
  private readonly owner: string;
  private readonly batchSize: number;
  private readonly leaseSeconds: number;
  private readonly pollMilliseconds: number;
  private running = false;
  private stopping = false;
  private loopPromise: Promise<void> | undefined;

  constructor(
    private readonly repository: SchedulerRepository,
    private readonly clock: Clock,
    private readonly wakeEventWorker: () => void,
    private readonly logger: Logger,
    options: SchedulerServiceOptions = {},
  ) {
    this.owner = options.owner ?? `scheduler_${randomUUID()}`;
    this.batchSize = options.batchSize ?? 10;
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.pollMilliseconds = options.pollMilliseconds ?? 1_000;
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 100) throw new Error("invalid_batch_size");
    if (!Number.isInteger(this.pollMilliseconds) || this.pollMilliseconds < 1 || this.pollMilliseconds > 60_000) throw new Error("invalid_poll_interval");
  }

  isRunning(): boolean { return this.running; }

  start(): void {
    if (this.loopPromise) return;
    this.stopping = false;
    this.running = true;
    this.loopPromise = this.loop().catch((error: unknown) => {
      this.logger.error("Scheduler loop stopped unexpectedly", {
        error_code: "scheduler_crashed",
        error_message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }).finally(() => { this.running = false; });
  }

  wake(): void { this.wakeSignal.wake(); }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake();
    await this.loopPromise;
    this.repository.releaseClaims(this.owner, this.clock.now());
    this.running = false;
  }

  runBatch(): number {
    let materialized = 0;
    const visited: string[] = [];
    this.repository.expireDue(this.clock.now(), this.batchSize);
    for (let index = 0; index < this.batchSize && !this.stopping; index++) {
      const now = this.clock.now();
      const claim = this.repository.claimDue(this.owner, now, this.leaseSeconds, visited);
      if (!claim) break;
      visited.push(claim.schedule_id);
      try {
        const definition = this.repository.materializationDefinition(claim.schedule_id, claim.revision);
        const firstDue = claim.next_due!;
        const occurrences = previewOccurrences(definition, {
          after: new Date(Date.parse(firstDue) - 86_400_000).toISOString().replace(".000Z", "Z"),
          before_or_equal: now,
          limit: 100,
        }).occurrences.filter(({ occurrence_at }) => occurrence_at >= firstDue);
        const occurrence = occurrences.at(-1);
        if (!occurrence || occurrences[0]?.occurrence_at !== firstDue) throw new Error("next_due_definition_mismatch");
        const scheduledFor = occurrence.occurrence_at;
        const next = definition.recurrence.kind === "once" ? null : nextPersistedOccurrence(definition, scheduledFor);
        const compactSkip = occurrences.length > 1
          ? { from: firstDue, through: occurrences.at(-2)!.occurrence_at, count: occurrences.length - 1 }
          : undefined;
        this.repository.materialize(
          claim.schedule_id,
          claim.revision,
          scheduledFor,
          next?.occurrence_at ?? null,
          now,
          this.actor(claim.tenant_id),
          null,
          compactSkip,
          { owner: this.owner, fence: claim.claim_fence, occurrenceKey: occurrence.key },
        );
        materialized++;
      } catch (error) {
        this.logger.warn("Due schedule could not be materialized", {
          schedule_id: claim.schedule_id,
          error_code: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (materialized > 0) this.wakeEventWorker();
    return materialized;
  }

  private actor(tenantId: string): Actor {
    return { tenant_id: tenantId, actor_id: "scheduler", role: "admin", source_event_id: null };
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      this.runBatch();
      if (!this.stopping) await this.wakeSignal.wait(this.pollMilliseconds);
    }
  }
}
