import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterEach, describe, test } from "node:test";

import { DispatcherDatabase } from "../src/database.js";
import type { DispatcherConfig } from "../src/config.js";
import type { HerdrCommandResult } from "../src/herdr.js";
import type { JobAgentRuntime } from "../src/job-runtime.js";
import { JobSupervisor } from "../src/job-supervisor.js";
import type { Logger } from "../src/logger.js";
import type { JobRow } from "../src/types.js";
import { eventEnvelope, tempConfig, waitFor } from "./helpers.js";

const roots: string[] = [];
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const ok = (agentStatus: "idle" | "done" | "working" | "blocked"): HerdrCommandResult => ({
  ok: true,
  stdout: "{}",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  aborted: false,
  agentStatus,
});
const failed = (errorCode: string, timedOut = false): HerdrCommandResult => ({
  ok: false,
  stdout: "",
  stderr: errorCode,
  exitCode: 1,
  timedOut,
  aborted: false,
  errorCode,
});

function createScratchJob(
  database: DispatcherDatabase,
  config: DispatcherConfig,
  externalEventId: string,
): JobRow {
  const source = database.enqueue(eventEnvelope(externalEventId)).row;
  return database.createJob(
    { source_event_id: source.event_id, objective: "調査する", workspace: { kind: "scratch" } },
    config.jobsWorkspaceRoot,
    config.jobResultsDir,
  ).row;
}

function createKeyedScratchJobs(
  database: DispatcherDatabase,
  config: DispatcherConfig,
  externalEventId: string,
  count: number,
  startOffsetMs: number,
): { sourceEventId: string; jobs: JobRow[] } {
  const source = database.enqueue(
    eventEnvelope(externalEventId),
    new Date(Date.UTC(2026, 8, 5, 0, 0, 0, startOffsetMs)),
  ).row;
  const jobs = Array.from({ length: count }, (_, index) => database.createJob(
    {
      source_event_id: source.event_id,
      job_key: `job.${index + 1}`,
      objective: `objective ${index + 1}`,
      workspace: { kind: "scratch" },
    },
    config.jobsWorkspaceRoot,
    config.jobResultsDir,
    new Date(Date.UTC(2026, 8, 5, 0, 0, 0, startOffsetMs + index)),
  ).row);
  return { sourceEventId: source.event_id, jobs };
}

function waitUntilAbort(signal?: AbortSignal): Promise<HerdrCommandResult> {
  return new Promise((resolve) => {
    const aborted = (): void => resolve({ ...ok("working"), aborted: true });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

function markRunning(database: DispatcherDatabase, jobId: string): void {
  database.beginJobPreparation(jobId);
  database.setJobRuntime(jobId, "1", "w1:p1");
  database.beginJobDispatch(jobId);
  database.markJobRunning(jobId);
}

function fakeRuntime(overrides: Partial<JobAgentRuntime>): JobAgentRuntime {
  return {
    async prepare() { throw new Error("must not prepare"); },
    async get() { throw new Error("must not get"); },
    async prompt() { throw new Error("must not prompt"); },
    async wait() { throw new Error("must not wait"); },
    async cancel() { throw new Error("must not cancel"); },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("JobSupervisor", () => {
  test("fills global slots round-robin without exceeding the per-event limit", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    config.jobConcurrency = 4;
    config.jobConcurrencyPerEvent = 2;
    const database = new DispatcherDatabase(config.databasePath);
    const first = createKeyedScratchJobs(database, config, "Ev-fair-first", 8, 0);
    const second = createKeyedScratchJobs(database, config, "Ev-fair-second", 2, 100);
    const sourceByJob = new Map(
      [...first.jobs, ...second.jobs].map((row) => [row.job_id, row.source_event_id]),
    );
    const prompted: string[] = [];
    const schedulerStates: Array<Record<string, unknown>> = [];
    const schedulerLogger: Logger = {
      debug(message, fields) {
        if (message === "Job scheduler state changed") schedulerStates.push(fields ?? {});
      },
      info() {}, warn() {}, error() {},
    };
    const runtime = fakeRuntime({
      async prepare() { return { herdrWorkspaceId: "1", herdrPaneId: "w1:p1" }; },
      async prompt(jobId) { prompted.push(jobId); return ok("working"); },
      async wait(_jobId, signal) { return waitUntilAbort(signal); },
    });
    const supervisor = new JobSupervisor(database, runtime, config, schedulerLogger, () => undefined);

    supervisor.start();
    await waitFor(() => prompted.length === 4);
    const promptedSources = prompted.map((jobId) => sourceByJob.get(jobId));
    assert.equal(promptedSources.filter((sourceEventId) => sourceEventId === first.sourceEventId).length, 2);
    assert.equal(promptedSources.filter((sourceEventId) => sourceEventId === second.sourceEventId).length, 2);
    assert.equal(new Set(prompted).size, 4);
    assert.ok(schedulerStates.some((fields) =>
      fields.active_jobs === 4 && fields.active_max_per_event === 2 && fields.queued_jobs === 6
    ));
    assert.equal(JSON.stringify(schedulerStates).includes("source_event_id"), false);
    assert.equal(JSON.stringify(schedulerStates).includes("objective 1"), false);
    await supervisor.stop();
    assert.equal(prompted.length, 4);
    assert.equal(database.listJobs("queued").length, 6);
    database.close();
  });

  test("advances the fair cursor so an older event cannot starve a later event", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    config.jobConcurrency = 1;
    config.jobConcurrencyPerEvent = 1;
    const database = new DispatcherDatabase(config.databasePath);
    const first = createKeyedScratchJobs(database, config, "Ev-fair-cursor-first", 3, 0);
    const second = createKeyedScratchJobs(database, config, "Ev-fair-cursor-second", 1, 100);
    const sourceByJob = new Map(
      [...first.jobs, ...second.jobs].map((row) => [row.job_id, row.source_event_id]),
    );
    const prompted: string[] = [];
    const waiters = new Map<string, (result: HerdrCommandResult) => void>();
    const runtime = fakeRuntime({
      async prepare() { return { herdrWorkspaceId: "1", herdrPaneId: "w1:p1" }; },
      async prompt(jobId) { prompted.push(jobId); return ok("working"); },
      async wait(jobId, signal) {
        return new Promise((resolve) => {
          waiters.set(jobId, resolve);
          signal?.addEventListener("abort", () => resolve({ ...ok("working"), aborted: true }), { once: true });
          if (signal?.aborted) resolve({ ...ok("working"), aborted: true });
        });
      },
    });
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => undefined);

    supervisor.start();
    await waitFor(() => prompted.length === 1 && waiters.has(prompted[0]!));
    assert.equal(sourceByJob.get(prompted[0]!), first.sourceEventId);
    waiters.get(prompted[0]!)!(ok("done"));
    await waitFor(() => prompted.length === 2);
    assert.equal(sourceByJob.get(prompted[1]!), second.sourceEventId);
    await supervisor.stop();
    database.close();
  });

  test("keeps cursor order when the cursor event is temporarily at its active limit", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    config.jobConcurrency = 2;
    config.jobConcurrencyPerEvent = 1;
    const database = new DispatcherDatabase(config.databasePath);
    const first = createKeyedScratchJobs(database, config, "Ev-full-ring-first", 2, 0);
    const second = createKeyedScratchJobs(database, config, "Ev-full-ring-second", 2, 100);
    const third = createKeyedScratchJobs(database, config, "Ev-full-ring-third", 1, 200);
    const sourceByJob = new Map(
      [...first.jobs, ...second.jobs, ...third.jobs].map((row) => [row.job_id, row.source_event_id]),
    );
    const prompted: string[] = [];
    const waiters = new Map<string, (result: HerdrCommandResult) => void>();
    const runtime = fakeRuntime({
      async prepare() { return { herdrWorkspaceId: "1", herdrPaneId: "w1:p1" }; },
      async prompt(jobId) { prompted.push(jobId); return ok("working"); },
      async wait(jobId, signal) {
        return new Promise((resolve) => {
          waiters.set(jobId, resolve);
          signal?.addEventListener("abort", () => resolve({ ...ok("working"), aborted: true }), { once: true });
          if (signal?.aborted) resolve({ ...ok("working"), aborted: true });
        });
      },
    });
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => undefined);

    supervisor.start();
    await waitFor(() => prompted.length === 2 && waiters.size === 2);
    assert.deepEqual(
      new Set(prompted.map((jobId) => sourceByJob.get(jobId))),
      new Set([first.sourceEventId, second.sourceEventId]),
    );
    const firstActiveJob = prompted.find((jobId) => sourceByJob.get(jobId) === first.sourceEventId)!;
    waiters.get(firstActiveJob)!(ok("done"));
    await waitFor(() => prompted.length === 3);
    assert.equal(sourceByJob.get(prompted[2]!), third.sourceEventId);
    await supervisor.stop();
    database.close();
  });

  test("does not aggregate the full queue on every scheduler poll", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    config.jobConcurrency = 1;
    const database = new DispatcherDatabase(config.databasePath);
    createKeyedScratchJobs(database, config, "Ev-stats-throttle", 2, 0);
    const originalJobQueueStats = database.jobQueueStats.bind(database);
    let statsQueries = 0;
    database.jobQueueStats = (excludedJobIds?: string[]) => {
      statsQueries += 1;
      return originalJobQueueStats(excludedJobIds);
    };
    const runtime = fakeRuntime({
      async prepare() { return { herdrWorkspaceId: "1", herdrPaneId: "w1:p1" }; },
      async prompt() { return ok("working"); },
      async wait(_jobId, signal) {
        return new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve({ ...ok("working"), aborted: true }), { once: true });
          if (signal?.aborted) resolve({ ...ok("working"), aborted: true });
        });
      },
    });
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => undefined);

    supervisor.start();
    await waitFor(() => statsQueries === 1);
    await new Promise((resolve) => setTimeout(resolve, config.queuePollMs * 5));
    assert.equal(statsQueries, 1);
    await supervisor.stop();
    database.close();
  });

  test("does not rescan a retry backlog before its earliest backoff expires", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    config.jobConcurrency = 2;
    const database = new DispatcherDatabase(config.databasePath);
    const jobs = [
      ...createKeyedScratchJobs(database, config, "Ev-backoff-first", 1, 0).jobs,
      ...createKeyedScratchJobs(database, config, "Ev-backoff-second", 1, 100).jobs,
    ];
    const failureAt = new Date();
    for (const job of jobs) {
      database.beginJobPreparation(job.job_id, failureAt);
      database.recordJobPreparationFailure(job.job_id, "worker_start_failed", "offline", 2, failureAt);
    }
    const originalNextRunnableJob = database.nextRunnableJob.bind(database);
    const originalNextWaitingJobAt = database.nextWaitingJobAt.bind(database);
    let runnableQueries = 0;
    let retryTimeQueries = 0;
    database.nextRunnableJob = (...args): JobRow | undefined => {
      runnableQueries += 1;
      return originalNextRunnableJob(...args);
    };
    database.nextWaitingJobAt = (...args): Date | undefined => {
      retryTimeQueries += 1;
      return originalNextWaitingJobAt(...args);
    };
    const supervisor = new JobSupervisor(database, fakeRuntime({}), config, logger, () => undefined);

    supervisor.start();
    await waitFor(() => retryTimeQueries === 1);
    await new Promise((resolve) => setTimeout(resolve, config.queuePollMs * 5));
    assert.equal(runnableQueries, 1);
    assert.equal(retryTimeQueries, 1);
    await supervisor.stop();
    database.close();
  });

  test("counts recovered running jobs before starting queued work", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    config.jobConcurrency = 2;
    config.jobConcurrencyPerEvent = 1;
    const database = new DispatcherDatabase(config.databasePath);
    const recovered = createKeyedScratchJobs(database, config, "Ev-recovered-running", 1, 0);
    const next = createKeyedScratchJobs(database, config, "Ev-recovered-next", 1, 100);
    const queued = createKeyedScratchJobs(database, config, "Ev-recovered-queued", 1, 200);
    markRunning(database, recovered.jobs[0]!.job_id);
    const waited: string[] = [];
    const prompted: string[] = [];
    const runtime = fakeRuntime({
      async prepare() { return { herdrWorkspaceId: "1", herdrPaneId: "w1:p1" }; },
      async prompt(jobId) { prompted.push(jobId); return ok("working"); },
      async wait(jobId, signal) { waited.push(jobId); return waitUntilAbort(signal); },
    });
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => undefined);

    supervisor.start();
    await waitFor(() => waited.length === 2);
    assert.deepEqual(prompted, [next.jobs[0]!.job_id]);
    assert.equal(database.getJob(queued.jobs[0]!.job_id)?.status, "queued");
    await supervisor.stop();
    database.close();
  });

  test("releases a slot after worker start failure and retries after transient DB busy", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    config.jobConcurrency = 1;
    config.jobConcurrencyPerEvent = 1;
    config.maxAttempts = 1;
    const database = new DispatcherDatabase(config.databasePath);
    const first = createKeyedScratchJobs(database, config, "Ev-start-failure", 1, 0);
    const second = createKeyedScratchJobs(database, config, "Ev-after-failure", 1, 100);
    const originalNextRunnableJob = database.nextRunnableJob.bind(database);
    let queryCount = 0;
    database.nextRunnableJob = (
      at?: Date,
      afterSourceEventId?: string,
      excludedSourceEventIds?: string[],
      excludedJobIds?: string[],
    ): JobRow | undefined => {
      queryCount += 1;
      if (queryCount === 1) {
        const error = new Error("database is busy") as Error & { code?: string };
        error.code = "SQLITE_BUSY";
        throw error;
      }
      return originalNextRunnableJob(at, afterSourceEventId, excludedSourceEventIds, excludedJobIds);
    };
    const warnings: Array<Record<string, unknown>> = [];
    const busyLogger: Logger = {
      debug() {}, info() {}, error() {},
      warn(message, fields) {
        if (message === "Job scheduling cycle failed") warnings.push(fields ?? {});
      },
    };
    const prompted: string[] = [];
    const runtime = fakeRuntime({
      async prepare(row) {
        if (row.job_id === first.jobs[0]!.job_id) throw new Error("worker start failed");
        return { herdrWorkspaceId: "1", herdrPaneId: "w1:p1" };
      },
      async prompt(jobId) { prompted.push(jobId); return ok("working"); },
      async wait(_jobId, signal) { return waitUntilAbort(signal); },
    });
    const supervisor = new JobSupervisor(database, runtime, config, busyLogger, () => undefined);

    supervisor.start();
    await waitFor(() => prompted.includes(second.jobs[0]!.job_id));
    assert.equal(database.getJob(first.jobs[0]!.job_id)?.status, "failed");
    assert.deepEqual(warnings.map((fields) => fields.error_code), ["SQLITE_BUSY"]);
    await supervisor.stop();
    database.close();
  });

  test("does not start a queued sibling during a running-job cancel and drain race", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    config.jobConcurrency = 1;
    config.jobConcurrencyPerEvent = 1;
    const database = new DispatcherDatabase(config.databasePath);
    const running = createKeyedScratchJobs(database, config, "Ev-cancel-drain-running", 1, 0);
    const queued = createKeyedScratchJobs(database, config, "Ev-cancel-drain-queued", 1, 100);
    const cancellation = database.enqueue(eventEnvelope("Ev-cancel-drain-request")).row;
    const prompted: string[] = [];
    const runtime = fakeRuntime({
      async prepare() { return { herdrWorkspaceId: "1", herdrPaneId: "w1:p1" }; },
      async prompt(jobId) { prompted.push(jobId); return ok("working"); },
      async wait(_jobId, signal) { return waitUntilAbort(signal); },
      async cancel() { return ok("idle"); },
    });
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => undefined);

    supervisor.start();
    await waitFor(() => database.getJob(running.jobs[0]!.job_id)?.status === "running");
    await supervisor.cancel(running.jobs[0]!.job_id, cancellation.event_id, "cancel before drain");
    await supervisor.stop();

    assert.deepEqual(prompted, [running.jobs[0]!.job_id]);
    assert.equal(database.getJob(running.jobs[0]!.job_id)?.status, "cancelled");
    assert.equal(database.getJob(queued.jobs[0]!.job_id)?.status, "queued");
    database.close();
  });

  test("runs a background job and queues a dona_job completion event", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-background")).row;
    const job = database.createJob(
      { source_event_id: source.event_id, objective: "調査する", workspace: { kind: "scratch" } },
      config.jobsWorkspaceRoot,
      config.jobResultsDir,
    ).row;
    let promptCount = 0;
    let workerWakeCount = 0;
    const runtime: JobAgentRuntime = {
      async prepare() {
        await fs.mkdir(config.jobResultsDir, { recursive: true });
        return { herdrWorkspaceId: "1", herdrPaneId: "w1:p1" };
      },
      async get() { return ok("idle"); },
      async prompt(_jobId, prompt) {
        promptCount += 1;
        assert.match(prompt, /\[DONA_JOB_BEGIN\]/);
        const result = {
          schema_version: 1,
          job_id: job.job_id,
          status: "completed",
          summary: "調査完了",
          output: { format: "markdown", text: "結果です" },
          completed_at: new Date().toISOString(),
        };
        await fs.writeFile(`${job.result_path}.tmp`, JSON.stringify(result));
        await fs.rename(`${job.result_path}.tmp`, job.result_path);
        return ok("working");
      },
      async wait() { return ok("done"); },
      async cancel() { return ok("idle"); },
    };
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => {
      workerWakeCount += 1;
    });
    supervisor.start();
    await waitFor(() => database.getJob(job.job_id)?.completion_event_id !== null);
    await supervisor.stop();
    assert.equal(database.getJob(job.job_id)?.status, "completed");
    assert.equal(promptCount, 1);
    assert.ok(workerWakeCount >= 1);
    const notification = database.get(database.getJob(job.job_id)!.completion_event_id!);
    assert.equal(notification?.source, "dona_job");
    assert.equal(notification?.event_type, "job_completed");
    database.close();
  });

  test("sends a same-thread follow-up to a running worker as steer", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-steer-source")).row;
    const followUp = database.enqueue(eventEnvelope("Ev-steer-follow-up")).row;
    const job = database.createJob(
      { source_event_id: source.event_id, objective: "長い作業", workspace: { kind: "scratch" } },
      config.jobsWorkspaceRoot,
      config.jobResultsDir,
    ).row;
    database.beginJobPreparation(job.job_id);
    database.setJobRuntime(job.job_id, "1", "w1:p1");
    database.beginJobDispatch(job.job_id);
    database.markJobRunning(job.job_id);
    const steers: string[] = [];
    const runtime: JobAgentRuntime = {
      async prepare() { throw new Error("not used"); },
      async get() { return ok("working"); },
      async prompt(_jobId, text) { steers.push(text); return ok("working"); },
      async wait() { return { ...ok("working"), ok: false, timedOut: true, errorCode: "timeout" }; },
      async cancel() { return ok("idle"); },
    };
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => undefined);
    const result = await supervisor.steer(job.job_id, followUp.event_id, "追加条件");
    assert.equal(result.duplicate, false);
    assert.deepEqual(steers, ["追加条件"]);
    assert.equal(database.getJob(job.job_id)?.steer_state, "accepted");
    database.close();
  });

  test("requires review when initial prompt acceptance times out instead of retrying", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const job = createScratchJob(database, config, "Ev-prompt-timeout");
    let promptCount = 0;
    const runtime = fakeRuntime({
      async prepare() {
        return { herdrWorkspaceId: "1", herdrPaneId: "w1:p1" };
      },
      async prompt() {
        promptCount += 1;
        return failed("timeout", true);
      },
    });
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => undefined);
    supervisor.start();
    await waitFor(() => database.getJob(job.job_id)?.completion_event_id !== null);
    await supervisor.stop();

    const updated = database.getJob(job.job_id)!;
    assert.equal(updated.status, "needs_review");
    assert.equal(updated.last_error_code, "timeout");
    assert.equal(promptCount, 1);
    assert.equal(database.get(updated.completion_event_id!)?.event_type, "job_needs_review");
    database.close();
  });

  test("requires review when a terminal worker does not publish a result", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const job = createScratchJob(database, config, "Ev-result-missing");
    markRunning(database, job.job_id);
    let waitCount = 0;
    const runtime = fakeRuntime({
      async wait() {
        waitCount += 1;
        return ok("done");
      },
    });
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => undefined);
    supervisor.start();
    await waitFor(() => database.getJob(job.job_id)?.completion_event_id !== null);
    await supervisor.stop();

    const updated = database.getJob(job.job_id)!;
    assert.equal(updated.status, "needs_review");
    assert.equal(updated.last_error_code, "result_missing");
    assert.equal(waitCount, 1);
    assert.equal(database.get(updated.completion_event_id!)?.event_type, "job_needs_review");
    database.close();
  });

  test("rejects a result envelope belonging to another job before waiting", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const job = createScratchJob(database, config, "Ev-cross-job-result");
    markRunning(database, job.job_id);
    await fs.mkdir(config.jobResultsDir, { recursive: true });
    await fs.writeFile(job.result_path, JSON.stringify({
      schema_version: 1,
      job_id: "job_01m1f3zzzzzzzzzzzzzzzzzzzz",
      status: "completed",
      summary: "wrong job",
      completed_at: new Date().toISOString(),
    }));
    let waitCount = 0;
    const runtime = fakeRuntime({
      async wait() {
        waitCount += 1;
        return ok("done");
      },
    });
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => undefined);
    supervisor.start();
    await waitFor(() => database.getJob(job.job_id)?.completion_event_id !== null);
    await supervisor.stop();

    const updated = database.getJob(job.job_id)!;
    assert.equal(updated.status, "needs_review");
    assert.equal(updated.last_error_code, "invalid_result");
    assert.match(updated.last_error_message ?? "", /job_id does not match/);
    assert.equal(waitCount, 0);
    database.close();
  });

  test("preserves a worker-reported failure and emits a job_failed notification", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const job = createScratchJob(database, config, "Ev-reported-failure");
    markRunning(database, job.job_id);
    await fs.mkdir(config.jobResultsDir, { recursive: true });
    await fs.writeFile(job.result_path, JSON.stringify({
      schema_version: 1,
      job_id: job.job_id,
      status: "failed",
      summary: "検証に失敗した",
      output: { format: "markdown", text: "再実行には確認が必要" },
      completed_at: new Date().toISOString(),
    }));
    const supervisor = new JobSupervisor(database, fakeRuntime({}), config, logger, () => undefined);
    supervisor.start();
    await waitFor(() => database.getJob(job.job_id)?.completion_event_id !== null);
    await supervisor.stop();

    const updated = database.getJob(job.job_id)!;
    assert.equal(updated.status, "failed");
    assert.equal(updated.last_error_code, "agent_reported_failure");
    assert.equal(updated.last_error_message, "検証に失敗した");
    const notification = database.get(updated.completion_event_id!)!;
    assert.equal(notification.event_type, "job_failed");
    const payload = JSON.parse(notification.payload_json) as Record<string, unknown>;
    assert.equal(payload.job_status, "failed");
    assert.equal((payload.result as Record<string, unknown>).summary, "検証に失敗した");
    database.close();
  });

  test("requires review when running-job cancellation acceptance times out", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const job = createScratchJob(database, config, "Ev-cancel-source");
    const cancellation = database.enqueue(eventEnvelope("Ev-cancel-request")).row;
    markRunning(database, job.job_id);
    let cancelCount = 0;
    const runtime = fakeRuntime({
      async cancel() {
        cancelCount += 1;
        return failed("timeout", true);
      },
    });
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => undefined);

    await assert.rejects(
      supervisor.cancel(job.job_id, cancellation.event_id, "利用者が中止を依頼"),
      /cancellation requires review/,
    );
    const updated = database.getJob(job.job_id)!;
    assert.equal(updated.status, "needs_review");
    assert.equal(updated.last_error_code, "timeout");
    assert.equal(cancelCount, 1);
    database.close();
  });
});
