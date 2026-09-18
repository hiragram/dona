import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { describe, test } from "node:test";

import {
  jobResourceDefaults,
  jobResourceHardLimits,
  expandHome,
  loadConfig,
} from "../src/config.js";

describe("job resource config", () => {
  test("pre-activationでもDispatcher test fileを逐次実行する", () => {
    const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts?: { test?: string };
    };
    assert.equal(packageJson.scripts?.test, "node test/run-tests.mjs");
    const runner = fs.readFileSync(new URL("./run-tests.mjs", import.meta.url), "utf8");
    assert.match(runner, /--test-concurrency=1/);
    assert.match(runner, /\[dispatcher-test\] file-start/);
    assert.match(runner, /\[dispatcher-test\] file-finish/);
    assert.match(runner, /checkpoint-hooks\.mjs/);
    const hooks = fs.readFileSync(new URL("./checkpoint-hooks.mjs", import.meta.url), "utf8");
    assert.match(hooks, /beforeEach/);
    assert.match(hooks, /afterEach/);
    assert.match(hooks, /\[dispatcher-test\] case-start/);
    assert.match(hooks, /\[dispatcher-test\] case-finish/);
    assert.match(hooks, /createHash\("sha256"\)/);
    assert.match(runner, /process\.argv\.slice\(2\)/);
  });

  test("expands documented home-relative paths consistently", () => {
    assert.equal(expandHome("~/Library/Application Support/Dona/release-manifest.json"),
      `${os.homedir()}/Library/Application Support/Dona/release-manifest.json`);
  });
  test("loads safe defaults and allows the scheduler to apply the smaller concurrency limit", () => {
    const defaults = loadConfig({});
    assert.equal(defaults.jobsPerEventMax, jobResourceDefaults.jobsPerEventMax);
    assert.equal(defaults.jobObjectiveTotalMaxBytes, jobResourceDefaults.jobObjectiveTotalMaxBytes);
    assert.equal(defaults.jobConcurrency, 4);
    assert.equal(defaults.jobConcurrencyPerEvent, jobResourceDefaults.jobConcurrencyPerEvent);
    assert.equal(defaults.jobCommandTimeoutMs, 10_000);
    assert.equal(defaults.jobPromptTimeoutMs, 30_000);
    assert.equal(defaults.jobPromptReconcileMs, 30_000);
    assert.equal(defaults.jobPromptReconcilePollMs, 5_000);

    const configured = loadConfig({
      DONA_JOBS_PER_EVENT_MAX: "32",
      DONA_JOB_OBJECTIVE_TOTAL_MAX_BYTES: "1",
      DONA_JOB_CONCURRENCY: "1",
      DONA_JOB_CONCURRENCY_PER_EVENT: "2",
    });
    assert.equal(configured.jobsPerEventMax, jobResourceHardLimits.jobsPerEventMax);
    assert.equal(configured.jobObjectiveTotalMaxBytes, 1);
    assert.equal(configured.jobConcurrency, 1);
    assert.equal(configured.jobConcurrencyPerEvent, 2);
  });

  test("prompt専用timeoutとbounded reconcile設定を検証する", () => {
    const configured = loadConfig({
      DONA_JOB_COMMAND_TIMEOUT_MS: "7000",
      DONA_JOB_PROMPT_TIMEOUT_MS: "31000",
      DONA_JOB_PROMPT_RECONCILE_MS: "32000",
      DONA_JOB_PROMPT_RECONCILE_POLL_MS: "4000",
    });
    assert.equal(configured.jobCommandTimeoutMs, 7_000);
    assert.equal(configured.jobPromptTimeoutMs, 31_000);
    assert.equal(configured.jobPromptReconcileMs, 32_000);
    assert.equal(configured.jobPromptReconcilePollMs, 4_000);
    for (const name of [
      "DONA_JOB_PROMPT_TIMEOUT_MS",
      "DONA_JOB_PROMPT_RECONCILE_MS",
      "DONA_JOB_PROMPT_RECONCILE_POLL_MS",
    ]) {
      assert.throws(() => loadConfig({ [name]: "0" }), /positive integer/);
      assert.throws(() => loadConfig({ [name]: "-1" }), /positive integer/);
    }
    assert.throws(
      () => loadConfig({ DONA_JOB_PROMPT_RECONCILE_MS: "4999" }),
      /must be at most DONA_JOB_PROMPT_RECONCILE_MS/,
    );
  });

  test("rejects non-positive, non-integer, and hard-bound violations at startup", () => {
    for (const value of ["0", "-1", "1.5", "not-a-number"]) {
      assert.throws(() => loadConfig({ DONA_JOBS_PER_EVENT_MAX: value }), /positive integer/);
      assert.throws(() => loadConfig({ DONA_JOB_OBJECTIVE_TOTAL_MAX_BYTES: value }), /positive integer/);
      assert.throws(() => loadConfig({ DONA_JOB_CONCURRENCY_PER_EVENT: value }), /positive integer/);
    }
    assert.throws(
      () => loadConfig({ DONA_JOBS_PER_EVENT_MAX: String(jobResourceHardLimits.jobsPerEventMax + 1) }),
      /at most 32/,
    );
    assert.throws(
      () => loadConfig({ DONA_JOB_CONCURRENCY_PER_EVENT: String(jobResourceHardLimits.jobConcurrencyPerEvent + 1) }),
      /at most 32/,
    );
  });
});
