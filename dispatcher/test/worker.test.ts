import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { DispatcherDatabase, JobCreationError } from "../src/database.js";
import type { HerdrClient, HerdrCommandResult } from "../src/herdr.js";
import type { Logger } from "../src/logger.js";
import { DispatcherWorker } from "../src/worker.js";
import { eventEnvelope, tempConfig, waitFor } from "./helpers.js";

const roots: string[] = [];
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const ok = (agentStatus: "idle" | "done" | "blocked" | "working"): HerdrCommandResult => ({
  ok: true,
  stdout: "{}",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  aborted: false,
  agentStatus,
});
const failed = (errorCode: string): HerdrCommandResult => ({
  ok: false,
  stdout: "",
  stderr: errorCode,
  exitCode: 1,
  timedOut: false,
  aborted: false,
  errorCode,
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function promptFields(prompt: string): { eventId: string; resultPath: string } {
  const eventId = /^event_id: (.+)$/m.exec(prompt)?.[1];
  const resultPath = /^result_path: (.+)$/m.exec(prompt)?.[1];
  if (!eventId || !resultPath) throw new Error("Prompt boundaries were missing");
  return { eventId, resultPath };
}

describe("DispatcherWorker", () => {
  test("prompts and completes events one at a time in sequence order", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    await fs.mkdir(config.resultsDir, { recursive: true });
    const database = new DispatcherDatabase(config.databasePath);
    const first = database.enqueue(eventEnvelope("Ev-1")).row;
    const second = database.enqueue(eventEnvelope("Ev-2")).row;
    const prompted: string[] = [];
    const herdr: HerdrClient = {
      async get() {
        return ok("idle");
      },
      async prompt(prompt) {
        const fields = promptFields(prompt);
        prompted.push(fields.eventId);
        const result = {
          schema_version: 1,
          event_id: fields.eventId,
          status: "completed",
          completed_at: new Date().toISOString(),
          actions: [],
          memory_candidates: [],
        };
        await fs.writeFile(`${fields.resultPath}.tmp`, JSON.stringify(result));
        await fs.rename(`${fields.resultPath}.tmp`, fields.resultPath);
        return ok("working");
      },
      async wait() {
        return ok("done");
      },
    };
    const worker = new DispatcherWorker(database, herdr, config, logger);
    worker.start();
    await waitFor(() => database.get(second.event_id)?.status === "completed");
    await worker.stop();
    assert.deepEqual(prompted, [first.event_id, second.event_id]);
    database.close();
  });

  test("atomically seals a delegated group when its source event completes and wakes the job supervisor", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    await fs.mkdir(config.resultsDir, { recursive: true });
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-group-seal-worker")).row;
    let wakeCount = 0;
    const herdr: HerdrClient = {
      async get() { return ok("idle"); },
      async prompt(prompt) {
        const fields = promptFields(prompt);
        database.createJob({
          source_event_id: fields.eventId,
          job_key: "one",
          objective: "first",
          workspace: { kind: "scratch" },
        }, config.jobsWorkspaceRoot, config.jobResultsDir);
        database.createJob({
          source_event_id: fields.eventId,
          job_key: "two",
          objective: "second",
          workspace: { kind: "scratch" },
        }, config.jobsWorkspaceRoot, config.jobResultsDir);
        await fs.writeFile(fields.resultPath, JSON.stringify({
          schema_version: 1,
          event_id: fields.eventId,
          status: "completed",
          completed_at: "2026-09-05T07:00:00.000Z",
        }));
        return ok("working");
      },
      async wait() { return ok("done"); },
    };
    const worker = new DispatcherWorker(database, herdr, config, logger, () => { wakeCount += 1; });
    worker.start();
    await waitFor(() => database.get(source.event_id)?.status === "completed");
    await worker.stop();

    assert.notEqual(database.getJobGroup(source.event_id)?.sealed_at, null);
    assert.ok(wakeCount >= 1);
    assert.throws(
      () => database.createJob({
        source_event_id: source.event_id,
        job_key: "three",
        objective: "too late",
        workspace: { kind: "scratch" },
      }, config.jobsWorkspaceRoot, config.jobResultsDir),
      (error) => error instanceof JobCreationError && error.code === "job_group_closed",
    );
    assert.equal(
      database.createJob({
        source_event_id: source.event_id,
        job_key: "one",
        objective: "first",
        workspace: { kind: "scratch" },
      }, config.jobsWorkspaceRoot, config.jobResultsDir).outcome,
      "reused",
    );
    database.close();
  });

  test("does not resend a prompt after an agent wait timeout", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    await fs.mkdir(config.resultsDir, { recursive: true });
    const database = new DispatcherDatabase(config.databasePath);
    const event = database.enqueue(eventEnvelope("Ev-1")).row;
    let promptCount = 0;
    let waitCount = 0;
    let fields: { eventId: string; resultPath: string } | undefined;
    const herdr: HerdrClient = {
      async get() {
        return ok("idle");
      },
      async prompt(prompt) {
        promptCount += 1;
        fields = promptFields(prompt);
        return ok("working");
      },
      async wait() {
        waitCount += 1;
        if (waitCount === 1) {
          return {
            ok: false,
            stdout: "",
            stderr: "timeout",
            exitCode: 1,
            timedOut: true,
            aborted: false,
            errorCode: "timeout",
          };
        }
        const result = {
          schema_version: 1,
          event_id: fields!.eventId,
          status: "completed",
          completed_at: new Date().toISOString(),
        };
        await fs.writeFile(fields!.resultPath, JSON.stringify(result));
        return ok("done");
      },
    };
    const worker = new DispatcherWorker(database, herdr, config, logger);
    worker.start();
    await waitFor(() => database.get(event.event_id)?.status === "completed");
    await worker.stop();
    assert.equal(promptCount, 1);
    assert.ok(waitCount >= 2);
    database.close();
  });

  test("quiesces after the accepted event completes without dispatching the next queued event", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    await fs.mkdir(config.resultsDir, { recursive: true });
    const database = new DispatcherDatabase(config.databasePath);
    const first = database.enqueue(eventEnvelope("Ev-drain-1")).row;
    const second = database.enqueue(eventEnvelope("Ev-drain-2")).row;
    let releasePrompt!: () => void;
    const promptMayFinish = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const prompted: string[] = [];
    let fields: { eventId: string; resultPath: string } | undefined;
    const herdr: HerdrClient = {
      async get() {
        return ok("idle");
      },
      async prompt(prompt) {
        fields = promptFields(prompt);
        prompted.push(fields.eventId);
        await promptMayFinish;
        await fs.writeFile(fields.resultPath, JSON.stringify({
          schema_version: 1,
          event_id: fields.eventId,
          status: "completed",
          completed_at: new Date().toISOString(),
          actions: [],
          memory_candidates: [],
        }));
        return ok("working");
      },
      async wait() {
        return ok("done");
      },
    };
    const worker = new DispatcherWorker(database, herdr, config, logger);
    worker.start();
    await waitFor(() => prompted.length === 1);
    worker.quiesceAfterCurrent();
    releasePrompt();
    await waitFor(() => !worker.isRunning());
    assert.equal(database.get(first.event_id)?.status, "completed");
    assert.equal(database.get(second.event_id)?.status, "queued");
    assert.deepEqual(prompted, [first.event_id]);
    await worker.stop();
    database.close();
  });

  test("moves a waiting event to needs_review when the accepted agent stays unavailable", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    config.agentMissingGraceMs = 25;
    await fs.mkdir(config.resultsDir, { recursive: true });
    const database = new DispatcherDatabase(config.databasePath);
    const event = database.enqueue(eventEnvelope("Ev-missing-agent")).row;
    let promptCount = 0;
    let waitCount = 0;
    const herdr: HerdrClient = {
      async get() {
        return ok("idle");
      },
      async prompt() {
        promptCount += 1;
        return ok("working");
      },
      async wait() {
        waitCount += 1;
        return failed("agent_not_found");
      },
    };
    const worker = new DispatcherWorker(database, herdr, config, logger);
    worker.start();
    await waitFor(() => database.get(event.event_id)?.status === "needs_review");
    await worker.stop();
    assert.equal(promptCount, 1);
    assert.ok(waitCount >= 2);
    assert.equal(database.get(event.event_id)?.last_error_code, "agent_unavailable_after_prompt");
    database.close();
  });

  test("keeps waiting when the accepted agent returns within the grace period", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    config.agentMissingGraceMs = 200;
    await fs.mkdir(config.resultsDir, { recursive: true });
    const database = new DispatcherDatabase(config.databasePath);
    const event = database.enqueue(eventEnvelope("Ev-agent-returned")).row;
    let promptCount = 0;
    let waitCount = 0;
    let fields: { eventId: string; resultPath: string } | undefined;
    const herdr: HerdrClient = {
      async get() {
        return ok("idle");
      },
      async prompt(prompt) {
        promptCount += 1;
        fields = promptFields(prompt);
        return ok("working");
      },
      async wait() {
        waitCount += 1;
        if (waitCount === 1) return failed("agent_not_running");
        const result = {
          schema_version: 1,
          event_id: fields!.eventId,
          status: "completed",
          completed_at: new Date().toISOString(),
        };
        await fs.writeFile(fields!.resultPath, JSON.stringify(result));
        return ok("done");
      },
    };
    const worker = new DispatcherWorker(database, herdr, config, logger);
    worker.start();
    await waitFor(() => database.get(event.event_id)?.status === "completed");
    await worker.stop();
    assert.equal(promptCount, 1);
    assert.equal(waitCount, 2);
    database.close();
  });

  test("moves the first event to blocked and leaves following events queued", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const first = database.enqueue(eventEnvelope("Ev-1")).row;
    const second = database.enqueue(eventEnvelope("Ev-2")).row;
    const herdr: HerdrClient = {
      async get() {
        return ok("blocked");
      },
      async prompt() {
        throw new Error("must not prompt");
      },
      async wait() {
        throw new Error("must not wait");
      },
    };
    const worker = new DispatcherWorker(database, herdr, config, logger);
    worker.start();
    await waitFor(() => database.get(first.event_id)?.status === "blocked");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await worker.stop();
    assert.equal(database.get(second.event_id)?.status, "queued");
    database.close();
  });

  test("publishes result paths only inside the configured results directory", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const event = database.enqueue(eventEnvelope("Ev-1")).row;
    database.beginDispatch(event.event_id, path.join(config.resultsDir, `${event.event_id}.json`));
    assert.equal(database.get(event.event_id)?.result_path?.startsWith(`${config.resultsDir}${path.sep}`), true);
    database.close();
  });
});
