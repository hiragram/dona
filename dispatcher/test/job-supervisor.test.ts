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
    let promptTarget = "";
    let workerWakeCount = 0;
    const runtime: JobAgentRuntime = {
      async prepare() {
        await fs.mkdir(config.jobResultsDir, { recursive: true });
        return { herdrWorkspaceId: "1", herdrPaneId: "w1:p1" };
      },
      async get() { return ok("idle"); },
      async prompt(agentName, prompt) {
        promptCount += 1;
        promptTarget = agentName;
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
    assert.equal(promptTarget, job.agent_name);
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
    const steerTargets: string[] = [];
    const runtime: JobAgentRuntime = {
      async prepare() { throw new Error("not used"); },
      async get() { return ok("working"); },
      async prompt(agentName, text) { steerTargets.push(agentName); steers.push(text); return ok("working"); },
      async wait() { return { ...ok("working"), ok: false, timedOut: true, errorCode: "timeout" }; },
      async cancel() { return ok("idle"); },
    };
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => undefined);
    const result = await supervisor.steer(job.job_id, followUp.event_id, "追加条件");
    assert.equal(result.duplicate, false);
    assert.deepEqual(steers, ["追加条件"]);
    assert.deepEqual(steerTargets, [job.agent_name]);
    assert.equal(database.getJob(job.job_id)?.steer_state, "accepted");
    database.close();
  });

  test("uses the persisted agent name when monitoring a job after restart", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-resumed-agent-name")).row;
    const job = database.createJob(
      { source_event_id: source.event_id, objective: "実装する", workspace: { kind: "scratch" } },
      config.jobsWorkspaceRoot,
      config.jobResultsDir,
    ).row;
    database.beginJobPreparation(job.job_id);
    database.setJobRuntime(job.job_id, "1", "w1:p1");
    database.beginJobDispatch(job.job_id);
    database.markJobRunning(job.job_id);
    const waitTargets: string[] = [];
    const runtime: JobAgentRuntime = {
      async prepare() { throw new Error("not used"); },
      async get() { return ok("working"); },
      async prompt() { return ok("working"); },
      async wait(agentName) {
        waitTargets.push(agentName);
        return { ...ok("working"), ok: false, timedOut: true, errorCode: "timeout" };
      },
      async cancel() { return ok("idle"); },
    };
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => undefined);
    supervisor.start();
    await waitFor(() => waitTargets.length > 0);
    await supervisor.stop();

    assert.equal(waitTargets[0], job.agent_name);
    assert.equal(database.getJob(job.job_id)?.status, "running");
    database.close();
  });

  test("uses the persisted agent name when cancelling a running job", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-cancel-source")).row;
    const followUp = database.enqueue(eventEnvelope("Ev-cancel-follow-up")).row;
    const job = database.createJob(
      { source_event_id: source.event_id, objective: "修正する", workspace: { kind: "scratch" } },
      config.jobsWorkspaceRoot,
      config.jobResultsDir,
    ).row;
    database.beginJobPreparation(job.job_id);
    database.setJobRuntime(job.job_id, "1", "w1:p1");
    database.beginJobDispatch(job.job_id);
    database.markJobRunning(job.job_id);
    const cancelTargets: string[] = [];
    const runtime: JobAgentRuntime = {
      async prepare() { throw new Error("not used"); },
      async get() { return ok("working"); },
      async prompt() { return ok("working"); },
      async wait() { return ok("working"); },
      async cancel(agentName) { cancelTargets.push(agentName); return ok("idle"); },
    };
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => undefined);
    const result = await supervisor.cancel(job.job_id, followUp.event_id);

    assert.deepEqual(cancelTargets, [job.agent_name]);
    assert.equal(result.row.status, "cancelled");
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

  test("stalled promptは再送せず同一agentのsequence進行から監視へ移る", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    config.jobPromptReconcileMs = 100;
    const database = new DispatcherDatabase(config.databasePath);
    const job = createScratchJob(database, config, "Ev-stalled-progress");
    let prompts = 0;
    let gets = 0;
    const runtime = fakeRuntime({
      async prepare() {
        await fs.mkdir(config.jobResultsDir, { recursive: true });
        return { herdrWorkspaceId: "w1", herdrPaneId: "p1" };
      },
      async prompt() {
        prompts += 1;
        return failed("agent_prompt_stalled");
      },
      async get() {
        gets += 1;
        if (gets === 1) assert.equal(database.getJob(job.job_id)?.status, "preparing");
        return {
          ...ok(gets === 1 ? "idle" : "working"),
          agentIdentity: '["w1","p1","agent"]',
          stateChangeSeq: gets === 1 ? 10 : 11,
        };
      },
      async wait() {
        await fs.writeFile(job.result_path, JSON.stringify({
          schema_version: 1,
          job_id: job.job_id,
          status: "completed",
          summary: "完了",
          completed_at: new Date().toISOString(),
        }));
        return ok("done");
      },
    });
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => undefined);
    supervisor.start();
    await waitFor(() => ["completed", "needs_review"].includes(database.getJob(job.job_id)?.status ?? ""));
    await supervisor.stop();
    const updated = database.getJob(job.job_id)!;
    assert.equal(updated.status, "completed", `${updated.last_error_code}: ${updated.last_error_message}`);
    assert.equal(prompts, 1);
    assert.equal(gets, 2);
    assert.ok(database.getJob(job.job_id)?.prompt_accepted_at);
    database.close();
  });

  test("stalled promptのidentity差し替えは再送せずneeds_reviewにする", async () => {
    const { root, config } = await tempConfig(); roots.push(root); config.jobPromptReconcileMs = 100;
    const database = new DispatcherDatabase(config.databasePath);
    const job = createScratchJob(database, config, "Ev-stalled-swap");
    let prompts = 0;
    let gets = 0;
    const runtime = fakeRuntime({
      async prepare() { return { herdrWorkspaceId: "w1", herdrPaneId: "p1" }; },
      async prompt() { prompts += 1; return failed("agent_prompt_stalled"); },
      async get() {
        gets += 1;
        return { ...ok("idle"), agentIdentity: gets === 1 ? "old" : "new", stateChangeSeq: gets };
      },
    });
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => undefined);
    supervisor.start();
    await waitFor(() => database.getJob(job.job_id)?.status === "needs_review");
    await supervisor.stop();
    assert.equal(prompts, 1);
    assert.equal(database.getJob(job.job_id)?.last_error_code, "prompt_agent_identity_changed");
    assert.equal(database.getJob(job.job_id)?.prompt_accepted_at, null);
    database.close();
  });

  test("stalled prompt後の同一agentのblocked進行を受理済みとして保持する", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const job = createScratchJob(database, config, "Ev-stalled-blocked");
    let prompted = false;
    const identity = '["w1","p1","agent","session-1"]';
    const runtime = fakeRuntime({
      async prepare() { return { herdrWorkspaceId: "w1", herdrPaneId: "p1" }; },
      async prompt() { prompted = true; return failed("agent_prompt_stalled"); },
      async get() {
        return {
          ...ok(prompted ? "blocked" : "idle"),
          agentIdentity: identity,
          stateChangeSeq: prompted ? 2 : 1,
        };
      },
    });
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => undefined);
    supervisor.start();
    await waitFor(() => database.getJob(job.job_id)?.status === "blocked");
    await supervisor.stop();
    const updated = database.getJob(job.job_id)!;
    assert.ok(updated.prompt_accepted_at);
    assert.equal(updated.last_error_code, "agent_blocked");
    database.close();
  });

  test("stalled prompt後にResultが先行した場合はagentを待たず回収する", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    config.jobPromptReconcileMs = 100;
    const database = new DispatcherDatabase(config.databasePath);
    const job = createScratchJob(database, config, "Ev-stalled-result-first");
    let promptCount = 0;
    const runtime = fakeRuntime({
      async prepare() {
        await fs.mkdir(config.jobResultsDir, { recursive: true });
        return { herdrWorkspaceId: "w1", herdrPaneId: "p1" };
      },
      async prompt() {
        promptCount += 1;
        return { ...failed("agent_prompt_stalled"), agentIdentity: "agent", stateChangeSeq: 1 };
      },
      async get() {
        if (promptCount === 0) return { ...ok("idle"), agentIdentity: "agent", stateChangeSeq: 1 };
        await fs.writeFile(job.result_path, JSON.stringify({
          schema_version: 1,
          job_id: job.job_id,
          status: "completed",
          summary: "完了",
          completed_at: new Date().toISOString(),
        }));
        return { ...ok("idle"), agentIdentity: "agent", stateChangeSeq: 1 };
      },
    });
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => undefined);
    supervisor.start();
    await waitFor(() => ["completed", "needs_review"].includes(database.getJob(job.job_id)?.status ?? ""));
    await supervisor.stop();
    const updated = database.getJob(job.job_id)!;
    assert.equal(updated.status, "completed", `${updated.last_error_code}: ${updated.last_error_message}`);
    assert.equal(promptCount, 1);
    assert.ok(database.getJob(job.job_id)?.prompt_accepted_at);
    database.close();
  });

  test("stalled prompt後にidentityまたはsequenceの証明がなければneeds_reviewにする", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    config.jobPromptReconcileMs = 20;
    const database = new DispatcherDatabase(config.databasePath);
    const job = createScratchJob(database, config, "Ev-stalled-unchanged");
    let promptCount = 0;
    const runtime = fakeRuntime({
      async prepare() { return { herdrWorkspaceId: "w1", herdrPaneId: "p1" }; },
      async prompt() {
        promptCount += 1;
        return { ...failed("agent_prompt_stalled"), agentIdentity: "agent", stateChangeSeq: 1 };
      },
      async get() {
        return promptCount === 0
          ? { ...ok("idle"), agentIdentity: "agent", stateChangeSeq: 1 }
          : { ...ok("working"), stateChangeSeq: 2 };
      },
    });
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => undefined);
    supervisor.start();
    await waitFor(() => database.getJob(job.job_id)?.status === "needs_review");
    await supervisor.stop();
    const updated = database.getJob(job.job_id)!;
    assert.equal(promptCount, 1);
    assert.equal(updated.last_error_code, "prompt_acceptance_unproven");
    assert.equal(updated.prompt_accepted_at, null);
    database.close();
  });

  test("stalled prompt後のagent消失またはread timeoutはneeds_reviewにする", async () => {
    for (const [errorCode, timedOut, expected] of [
      ["agent_not_found", false, "agent_not_found"],
      ["timeout", true, "prompt_reconcile_timeout"],
    ] as const) {
      const { root, config } = await tempConfig();
      roots.push(root);
      const database = new DispatcherDatabase(config.databasePath);
      const job = createScratchJob(database, config, `Ev-stalled-${errorCode}`);
      let prompted = false;
      let reconcileTimeoutMs: number | undefined;
      const runtime = fakeRuntime({
        async prepare() { return { herdrWorkspaceId: "w1", herdrPaneId: "p1" }; },
        async prompt() { prompted = true; return failed("agent_prompt_stalled"); },
        async get(_agentName, _signal, timeoutMs) {
          if (prompted) reconcileTimeoutMs = timeoutMs;
          return prompted
            ? failed(errorCode, timedOut)
            : { ...ok("idle"), agentIdentity: "agent", stateChangeSeq: 1 };
        },
      });
      const supervisor = new JobSupervisor(database, runtime, config, logger, () => undefined);
      supervisor.start();
      await waitFor(() => database.getJob(job.job_id)?.status === "needs_review");
      await supervisor.stop();
      assert.equal(database.getJob(job.job_id)?.last_error_code, expected);
      assert.equal(database.getJob(job.job_id)?.prompt_accepted_at, null);
      assert.ok(reconcileTimeoutMs !== undefined && reconcileTimeoutMs <= config.jobPromptReconcileMs);
      database.close();
    }
  });

  test("stalled prompt後のread失敗直前に完成したResultを回収する", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const job = createScratchJob(database, config, "Ev-stalled-result-at-timeout");
    let prompted = false;
    const runtime = fakeRuntime({
      async prepare() {
        await fs.mkdir(config.jobResultsDir, { recursive: true });
        return { herdrWorkspaceId: "w1", herdrPaneId: "p1" };
      },
      async prompt() { prompted = true; return failed("agent_prompt_stalled"); },
      async get() {
        if (!prompted) return { ...ok("idle"), agentIdentity: "agent", stateChangeSeq: 1 };
        await fs.writeFile(job.result_path, JSON.stringify({
          schema_version: 1,
          job_id: job.job_id,
          status: "completed",
          summary: "完了",
          completed_at: new Date().toISOString(),
        }));
        return failed("timeout", true);
      },
    });
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => undefined);
    supervisor.start();
    await waitFor(() => database.getJob(job.job_id)?.status === "completed");
    await supervisor.stop();
    assert.ok(database.getJob(job.job_id)?.prompt_accepted_at);
    database.close();
  });

  test("stalled promptの再照合中断をdispatchingに残さない", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const job = createScratchJob(database, config, "Ev-stalled-stop");
    let prompted = false;
    const runtime = fakeRuntime({
      async prepare() { return { herdrWorkspaceId: "w1", herdrPaneId: "p1" }; },
      async prompt() { prompted = true; return failed("agent_prompt_stalled"); },
      async get(_agentName, signal) {
        if (!prompted) return { ...ok("idle"), agentIdentity: "agent", stateChangeSeq: 1 };
        if (signal?.aborted) return { ...failed("aborted"), aborted: true };
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        return { ...failed("aborted"), aborted: true };
      },
    });
    const supervisor = new JobSupervisor(database, runtime, config, logger, () => undefined);
    supervisor.start();
    await waitFor(() => database.getJob(job.job_id)?.status === "dispatching");
    await supervisor.stop();
    const updated = database.getJob(job.job_id)!;
    assert.equal(updated.status, "needs_review");
    assert.equal(updated.last_error_code, "prompt_interrupted");
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
