import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { describe, test } from "node:test";
import { promisify } from "node:util";

import {
  jobResourceDefaults,
  jobResourceHardLimits,
  expandHome,
  loadConfig,
} from "../src/config.js";

describe("job resource config", () => {
  test("process計測はchild_process overloadと限定envを維持する", async () => {
    assert.throws(() => spawn(process.execPath, [], { stdio: "invalid" as never }), /stdio/);
    assert.throws(() => spawnSync("/bin/true", [], 5 as never), { code: "ERR_INVALID_ARG_TYPE" });
    assert.throws(() => execFileSync("/bin/true", [], 5 as never), { code: "ERR_INVALID_ARG_TYPE" });
    assert.throws(() => execFile("/bin/true", [], 5 as never, () => {}), { code: "ERR_INVALID_ARG_TYPE" });
    const omittedArgs = spawnSync("/usr/bin/env", undefined, {
      env: { ONLY_WITH_OMITTED_ARGS: "yes" },
      encoding: "utf8",
    });
    assert.match(String(omittedArgs.stdout), /^ONLY_WITH_OMITTED_ARGS=yes$/m);
    assert.doesNotMatch(String(omittedArgs.stdout), /^HOME=/m);
    const child = spawn("/usr/bin/env", { env: { ONLY_FOR_CHILD: "yes" }, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.match(output, /^ONLY_FOR_CHILD=yes$/m);
    assert.doesNotMatch(output, /^HOME=/m);

    const promise = promisify(execFile)(process.execPath, ["-e", ""]);
    assert.ok("child" in promise);
    await promise;
  });

  test("pre-activationでもDispatcher test fileを逐次実行する", () => {
    assert.equal(process.env.DONA_CHECKPOINT_REPORTER_NONCE, undefined);
    const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts?: { test?: string };
    };
    assert.equal(packageJson.scripts?.test, "node test/run-tests.mjs");
    const runner = fs.readFileSync(new URL("./run-tests.mjs", import.meta.url), "utf8");
    assert.match(runner, /--test-concurrency=1/);
    assert.match(runner, /\[dispatcher-test:\$\{checkpointNonce\}\] file-start/);
    assert.match(runner, /\[dispatcher-test:\$\{checkpointNonce\}\] file-finish/);
    assert.match(runner, /checkpoint-reporter\.mjs/);
    assert.match(runner, /test-reporter-destination=stderr/);
    const reporter = fs.readFileSync(new URL("./checkpoint-reporter.mjs", import.meta.url), "utf8");
    assert.match(reporter, /event\.type === "test:start"/);
    assert.match(reporter, /event\.data\.details\?\.type === "suite"/);
    assert.match(reporter, /\[dispatcher-test:\$\{nonce\}\] case-start/);
    assert.match(reporter, /"case-finish"/);
    assert.match(reporter, /`\\n\[dispatcher-test:\$\{nonce\}\]/);
    assert.match(runner, /process\.argv\.slice\(2\)/);
    assert.match(runner, /process-metrics\.cjs/);
    const metrics = fs.readFileSync(new URL("./process-metrics.cjs", import.meta.url), "utf8");
    assert.match(metrics, /const markerLimit = 2048/);
    assert.match(metrics, /\["node", "git", "shell", "other"\]/);
    assert.match(metrics, /childProcess\.fork = function instrumentedFork/);
    assert.match(metrics, /active \+= 1;[\s\S]*originalSpawnSync/);
    assert.match(runner, /--require=\$\{JSON\.stringify\(processMetrics\)\}/);
    assert.match(runner, /DONA_ORIGINAL_NODE_OPTIONS: process\.env\.NODE_OPTIONS/);
    assert.match(metrics, /process\.env\.NODE_OPTIONS = originalNodeOptions/);
    assert.ok(metrics.indexOf('name.includes("fake-git")') < metrics.indexOf('name.endsWith(".mjs")'));
    assert.match(reporter, /event\.type === "test:stderr"/);
    assert.match(reporter, /metrics scope=2/);
    assert.doesNotMatch(metrics, /\.pid|process\.argv|commandLine/);
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
