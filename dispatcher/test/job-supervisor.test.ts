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
        assert.match(prompt, /"job_key":"legacy-default"/);
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

  test("emits progress without completing a running sibling after the source group is sealed", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-group-progress")).row;
    database.beginDispatch(source.event_id, `${config.resultsDir}/${source.event_id}.json`);
    database.markWaiting(source.event_id);
    const completed = database.createJob({
      source_event_id: source.event_id,
      job_key: "completed",
      objective: "finish first",
      workspace: { kind: "scratch" },
    }, config.jobsWorkspaceRoot, config.jobResultsDir).row;
    const running = database.createJob({
      source_event_id: source.event_id,
      job_key: "running",
      objective: "keep running",
      workspace: { kind: "scratch" },
    }, config.jobsWorkspaceRoot, config.jobResultsDir).row;
    for (const job of [completed, running]) markRunning(database, job.job_id);
    database.saveJobResult(completed.job_id, {
      schema_version: 1,
      job_id: completed.job_id,
      status: "completed",
      summary: "first done",
      completed_at: "2026-09-05T04:00:00.000Z",
    }, completed.result_path);
    database.saveCompleted(source.event_id, {
      schema_version: 1,
      event_id: source.event_id,
      status: "completed",
      completed_at: "2026-09-05T04:01:00.000Z",
    }, `${config.resultsDir}/${source.event_id}.json`);
    let wakeCount = 0;
    const supervisor = new JobSupervisor(database, fakeRuntime({
      async wait() { return { ...ok("working"), ok: false, timedOut: true, errorCode: "timeout" }; },
    }), config, logger, () => { wakeCount += 1; });
    supervisor.start();
    await waitFor(() => database.getJob(completed.job_id)?.completion_event_id !== null);
    await supervisor.stop();

    const notification = database.get(database.getJob(completed.job_id)!.completion_event_id!)!;
    const group = JSON.parse(notification.payload_json).group as Record<string, unknown>;
    assert.equal(group.transition, "progress");
    assert.equal(group.pending, 1);
    assert.equal(database.getJob(running.job_id)?.status, "running");
    assert.equal(database.getJob(running.job_id)?.completion_event_id, null);
    assert.equal(database.getJobGroup(source.event_id)?.attention_event_id, null);
    assert.equal(database.getJobGroup(source.event_id)?.all_terminal_event_id, null);
    assert.ok(wakeCount >= 1);
    database.close();
  });

  test("claims exactly one all-terminal event for concurrently observable successful siblings", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-group-successes")).row;
    database.beginDispatch(source.event_id, `${config.resultsDir}/${source.event_id}.json`);
    database.markWaiting(source.event_id);
    const jobs = ["one", "two"].map((jobKey) => database.createJob({
      source_event_id: source.event_id,
      job_key: jobKey,
      objective: `finish ${jobKey}`,
      workspace: { kind: "scratch" },
    }, config.jobsWorkspaceRoot, config.jobResultsDir).row);
    for (const job of jobs) {
      markRunning(database, job.job_id);
      database.saveJobResult(job.job_id, {
        schema_version: 1,
        job_id: job.job_id,
        status: "completed",
        summary: `${job.job_key} done`,
        completed_at: "2026-09-05T05:00:00.000Z",
      }, job.result_path);
    }
    database.saveCompleted(source.event_id, {
      schema_version: 1,
      event_id: source.event_id,
      status: "completed",
      completed_at: "2026-09-05T05:01:00.000Z",
    }, `${config.resultsDir}/${source.event_id}.json`);
    const supervisor = new JobSupervisor(database, fakeRuntime({}), config, logger, () => undefined);
    supervisor.start();
    await waitFor(() => jobs.every((job) => database.getJob(job.job_id)?.completion_event_id !== null));
    await supervisor.stop();

    const notifications = jobs.map((job) => database.get(database.getJob(job.job_id)!.completion_event_id!)!);
    const transitions = notifications.map((row) => (JSON.parse(row.payload_json).group as Record<string, unknown>).transition);
    assert.deepEqual(transitions.sort(), ["all_terminal", "progress"]);
    const owner = notifications.find((row) => (JSON.parse(row.payload_json).group as Record<string, unknown>).transition === "all_terminal")!;
    assert.equal(database.getJobGroup(source.event_id)?.all_terminal_event_id, owner.event_id);
    assert.equal(database.getJobGroup(source.event_id)?.attention_event_id, null);
    database.close();
  });

  test("claims one attention event for mixed failed, blocked, and needs-review siblings", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-group-attention-mix")).row;
    database.beginDispatch(source.event_id, `${config.resultsDir}/${source.event_id}.json`);
    database.markWaiting(source.event_id);
    const jobs = ["failed", "blocked", "needs-review"].map((jobKey) => database.createJob({
      source_event_id: source.event_id,
      job_key: jobKey,
      objective: `attention ${jobKey}`,
      workspace: { kind: "scratch" },
    }, config.jobsWorkspaceRoot, config.jobResultsDir).row);
    for (const job of jobs) markRunning(database, job.job_id);
    database.saveJobResult(jobs[0]!.job_id, {
      schema_version: 1,
      job_id: jobs[0]!.job_id,
      status: "failed",
      summary: "reported failure",
      completed_at: "2026-09-05T06:00:00.000Z",
    }, jobs[0]!.result_path);
    database.markJobBlocked(jobs[1]!.job_id, "approval required");
    database.markJobNeedsReview(jobs[2]!.job_id, "acceptance_unknown", "manual review required");
    database.saveCompleted(source.event_id, {
      schema_version: 1,
      event_id: source.event_id,
      status: "completed",
      completed_at: "2026-09-05T06:01:00.000Z",
    }, `${config.resultsDir}/${source.event_id}.json`);
    const supervisor = new JobSupervisor(database, fakeRuntime({}), config, logger, () => undefined);
    supervisor.start();
    await waitFor(() => jobs.every((job) => database.getJob(job.job_id)?.completion_event_id !== null));
    await supervisor.stop();

    const notifications = jobs.map((job) => database.get(database.getJob(job.job_id)!.completion_event_id!)!);
    const transitions = notifications.map((row) => (JSON.parse(row.payload_json).group as Record<string, unknown>).transition);
    assert.equal(transitions.filter((transition) => transition === "attention").length, 1);
    assert.equal(transitions.filter((transition) => transition === "progress").length, 2);
    assert.equal(database.getJobGroup(source.event_id)?.all_terminal_event_id, null);
    const attentionOwner = notifications.find((row) => (JSON.parse(row.payload_json).group as Record<string, unknown>).transition === "attention")!;
    assert.equal(database.getJobGroup(source.event_id)?.attention_event_id, attentionOwner.event_id);
    assert.deepEqual(
      (JSON.parse(attentionOwner.payload_json).group as Record<string, unknown>).status_counts,
      { blocked: 1, failed: 1, needs_review: 1 },
    );
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
