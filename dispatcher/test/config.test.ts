import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
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
    assert.throws(() => execFile("/bin/true", [], {}, 5 as never), { code: "ERR_INVALID_ARG_TYPE" });
    assert.throws(() => execFile("/bin/true", {}, 5 as never), { code: "ERR_INVALID_ARG_TYPE" });
    const undefinedCallbackChild = execFile("/usr/bin/true", {}, undefined as never);
    const nullCallbackChild = execFile(process.execPath, ["-e", ""], {}, null as never);
    const undefinedArgsChild = execFile("/usr/bin/true", undefined as never, { env: {} });
    const nullArgsChild = execFile("/usr/bin/true", null as never, { env: {} });
    await Promise.all([undefinedCallbackChild, nullCallbackChild, undefinedArgsChild, nullArgsChild].map((candidate) => new Promise<void>((resolve, reject) => {
      candidate.once("error", reject);
      candidate.once("close", () => resolve());
    })));
    const omittedArgs = spawnSync("/usr/bin/env", undefined, {
      env: { ONLY_WITH_OMITTED_ARGS: "yes" },
      encoding: "utf8",
    });
    assert.match(String(omittedArgs.stdout), /^ONLY_WITH_OMITTED_ARGS=yes$/m);
    assert.doesNotMatch(String(omittedArgs.stdout), /^HOME=/m);
    assert.doesNotMatch(String(omittedArgs.stdout), /^DONA_/m);
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
    assert.doesNotMatch(output, /^DONA_/m);

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
    assert.match(runner, /\[dispatcher-test\] start/);
    assert.match(runner, /failureOutputLimitBytes = 64 \* 1024/);
    assert.match(runner, /stdio: \["ignore", "pipe", "pipe"\]/);
    assert.match(runner, /\[dispatcher-test\] complete/);
    assert.match(runner, /elapsed_ms=/);
    assert.match(runner, /process\.exitCode = exitCode/);
    assert.doesNotMatch(runner, /process\.exit\(exitCode\)/);
    assert.match(runner, /\[dispatcher-test:\$\{checkpointNonce\}\] file-start/);
    assert.match(runner, /\[dispatcher-test:\$\{checkpointNonce\}\] file-finish/);
    assert.match(runner, /checkpoint-reporter\.mjs/);
    assert.match(runner, /test-reporter-destination=stderr/);
    const reporter = fs.readFileSync(new URL("./checkpoint-reporter.mjs", import.meta.url), "utf8");
    assert.match(reporter, /event\.type === "test:dequeue"/);
    assert.match(reporter, /event\.type === "test:complete"/);
    assert.match(reporter, /completed = new Set/);
    assert.match(reporter, /"test:pass"/);
    assert.match(reporter, /event\.data\.nesting === 0 && event\.data\.name === event\.data\.file/);
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
    assert.match(metrics, /if \(scope >= 2\) return options/);
    assert.ok(metrics.indexOf('name.includes("fake-git")') < metrics.indexOf('name.endsWith(".mjs")'));
    assert.match(reporter, /event\.type === "test:stderr"/);
    assert.match(reporter, /metrics scope=2/);
    assert.match(runner, /failureStdout/);
    assert.match(runner, /process\.stdout\.write\(failureStdout\)/);
    assert.match(runner, /process\.stderr\.write\(failureStderr\)/);
    assert.doesNotMatch(metrics, /\.pid|process\.argv|commandLine/);
    const markerBytes = fs.readdirSync(new URL("./", import.meta.url))
      .filter((name) => name.endsWith(".test.ts"))
      .sort()
      .reduce((total, name) => total + Buffer.byteLength(`[dispatcher-test] start test/${name}\n`), 0);
    assert.ok(markerBytes <= 800, `start markers exceed the legacy diagnostic budget: ${markerBytes}`);
  });

  test("停止するtestでもbody実行前にcase-startを出力する", async () => {
    const temporaryDirectory = fs.mkdtempSync(`${os.tmpdir()}/dona-checkpoint-reporter-`);
    const fixture = `${temporaryDirectory}/pending.test.mjs`;
    fs.writeFileSync(fixture, [
      'import test from "node:test";',
      'test("/tmp/real-case", async () => new Promise(() => {}));',
    ].join("\n"));
    const nonce = "0123456789abcdef0123456789abcdef";
    const reporter = fileURLToPath(new URL("./checkpoint-reporter.mjs", import.meta.url));
    const childEnvironment = { ...process.env };
    for (const name of Object.keys(childEnvironment)) {
      if (name.startsWith("NODE_TEST_")) delete childEnvironment[name];
    }
    delete childEnvironment.NODE_OPTIONS;
    delete childEnvironment.DONA_PROCESS_METRICS_NONCE;
    delete childEnvironment.DONA_ORIGINAL_NODE_OPTIONS;
    childEnvironment.DONA_DISPATCHER_TEST_FILE = "test/pending.test.ts";
    childEnvironment.DONA_CHECKPOINT_REPORTER_NONCE = nonce;
    childEnvironment.DONA_PROCESS_METRICS_NONCE = nonce;
    childEnvironment.DONA_PROCESS_METRICS_SCOPE = "2";
    childEnvironment.NODE_OPTIONS = `--require=${JSON.stringify(fileURLToPath(new URL("./process-metrics.cjs", import.meta.url)))}`;
    let stderr = "";
    const child = spawn(process.execPath, [
      "--test",
      `--test-reporter=${reporter}`,
      "--test-reporter-destination=stderr",
      fixture,
    ], {
      env: childEnvironment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const caseStartPattern = /\[dispatcher-test:[a-f0-9]{32}\] case-start test\/pending\.test\.ts:78b3a018be04#1/;
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("case-start marker was not emitted")), 2_000);
        const inspect = (): void => {
          if (!caseStartPattern.test(stderr)) return;
          clearTimeout(timeout);
          resolve();
        };
        child.stderr.on("data", inspect);
        child.once("error", reject);
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
        child.kill("SIGKILL");
        await closed;
      }
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    assert.match(stderr, caseStartPattern);
  });

  test("同名並列testのterminalをactive countへ対応付ける", async () => {
    const temporaryDirectory = fs.mkdtempSync(`${os.tmpdir()}/dona-checkpoint-occurrence-`);
    const fixture = `${temporaryDirectory}/parallel.test.mjs`;
    fs.writeFileSync(fixture, [
      'import { describe, test } from "node:test";',
      'describe("parallel", { concurrency: true }, () => {',
      '  for (const index of [0, 1]) test("duplicate", async () => index === 0 ? new Promise(() => {}) : new Promise((resolve) => setTimeout(resolve, 50)));',
      '});',
    ].join("\n"));
    const nonce = "0123456789abcdef0123456789abcdef";
    const reporter = fileURLToPath(new URL("./checkpoint-reporter.mjs", import.meta.url));
    const childEnvironment = { ...process.env };
    for (const name of Object.keys(childEnvironment)) {
      if (name.startsWith("NODE_TEST_")) delete childEnvironment[name];
    }
    delete childEnvironment.NODE_OPTIONS;
    delete childEnvironment.DONA_PROCESS_METRICS_NONCE;
    delete childEnvironment.DONA_ORIGINAL_NODE_OPTIONS;
    childEnvironment.DONA_DISPATCHER_TEST_FILE = "test/parallel.test.ts";
    childEnvironment.DONA_CHECKPOINT_REPORTER_NONCE = nonce;
    childEnvironment.DONA_PROCESS_METRICS_NONCE = nonce;
    childEnvironment.DONA_PROCESS_METRICS_SCOPE = "2";
    childEnvironment.NODE_OPTIONS = `--require=${JSON.stringify(fileURLToPath(new URL("./process-metrics.cjs", import.meta.url)))}`;
    let stderr = "";
    const child = spawn(process.execPath, [
      "--test",
      "--test-concurrency=1",
      `--test-reporter=${reporter}`,
      "--test-reporter-destination=stderr",
      fixture,
    ], { env: childEnvironment, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const digest = "e24a5a32c9b8";
    const completedSecond = new RegExp(`case-finish test/parallel\\.test\\.ts:${digest}#1`);
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("second terminal marker was not emitted")), 2_000);
        child.stderr.on("data", () => {
          if (!completedSecond.test(stderr)) return;
          clearTimeout(timeout);
          resolve();
        });
        child.once("error", reject);
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
        child.kill("SIGKILL");
        await closed;
      }
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    assert.match(stderr, new RegExp(`case-start test/parallel\\.test\\.ts:${digest}#1`));
    assert.match(stderr, new RegExp(`case-start test/parallel\\.test\\.ts:${digest}#2`));
    assert.match(stderr, completedSecond);
  });

  test("Node 20 fallbackで未開始cancelがactive caseを完了扱いしない", async () => {
    const nonce = "0123456789abcdef0123456789abcdef";
    process.env.DONA_DISPATCHER_TEST_FILE = "test/fallback.test.ts";
    process.env.DONA_CHECKPOINT_REPORTER_NONCE = nonce;
    try {
      const { default: createReporter } = await import(`./checkpoint-reporter.mjs?fallback-cancel=${Date.now()}`);
      const reporter = createReporter();
      let output = "";
      reporter.setEncoding("utf8");
      reporter.on("data", (chunk: string) => { output += chunk; });
      reporter.write({ type: "test:enqueue", data: { nesting: 0, name: "duplicate", type: "test" } });
      reporter.write({ type: "test:dequeue", data: { nesting: 0, name: "duplicate", file: "/tmp/fallback.test.mjs" } });
      reporter.write({ type: "test:enqueue", data: { nesting: 0, name: "duplicate", type: "test" } });
      reporter.write({
        type: "test:fail",
        data: {
          nesting: 0,
          name: "duplicate",
          details: { type: "test", duration_ms: 0, error: { failureType: "cancelledByParent" } },
        },
      });
      reporter.end();
      await new Promise<void>((resolve, reject) => {
        reporter.once("end", resolve);
        reporter.once("error", reject);
      });
      assert.match(output, /case-start test\/fallback\.test\.ts:e24a5a32c9b8#1/);
      assert.doesNotMatch(output, /case-fail/);
    } finally {
      delete process.env.DONA_DISPATCHER_TEST_FILE;
      delete process.env.DONA_CHECKPOINT_REPORTER_NONCE;
    }
  });

  test("file wrapper停止をleaf caseとして記録しない", async () => {
    const temporaryDirectory = fs.mkdtempSync(`${os.tmpdir()}/dona-checkpoint-wrapper-`);
    const fixture = `${temporaryDirectory}/wrapper.test.mjs`;
    fs.writeFileSync(fixture, "await new Promise(() => {});\n");
    const nonce = "0123456789abcdef0123456789abcdef";
    const reporter = fileURLToPath(new URL("./checkpoint-reporter.mjs", import.meta.url));
    const childEnvironment = { ...process.env };
    for (const name of Object.keys(childEnvironment)) {
      if (name.startsWith("NODE_TEST_")) delete childEnvironment[name];
    }
    delete childEnvironment.NODE_OPTIONS;
    delete childEnvironment.DONA_PROCESS_METRICS_NONCE;
    delete childEnvironment.DONA_ORIGINAL_NODE_OPTIONS;
    childEnvironment.DONA_DISPATCHER_TEST_FILE = "test/wrapper.test.ts";
    childEnvironment.DONA_CHECKPOINT_REPORTER_NONCE = nonce;
    childEnvironment.DONA_PROCESS_METRICS_NONCE = nonce;
    childEnvironment.DONA_PROCESS_METRICS_SCOPE = "2";
    childEnvironment.NODE_OPTIONS = `--require=${JSON.stringify(fileURLToPath(new URL("./process-metrics.cjs", import.meta.url)))}`;
    let stderr = "";
    const child = spawn(process.execPath, [
      "--test",
      `--test-reporter=${reporter}`,
      "--test-reporter-destination=stderr",
      fixture,
    ], { env: childEnvironment, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
        child.kill("SIGKILL");
        await closed;
      }
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    assert.doesNotMatch(stderr, /case-start/);
  });

  test("suite後のleaf terminalも記録する", () => {
    const temporaryDirectory = fs.mkdtempSync(`${os.tmpdir()}/dona-checkpoint-sibling-`);
    const fixture = `${temporaryDirectory}/sibling.test.mjs`;
    fs.writeFileSync(fixture, [
      'import { describe, test } from "node:test";',
      'describe("empty suite", () => {});',
      'test("after suite", () => {});',
    ].join("\n"));
    const nonce = "0123456789abcdef0123456789abcdef";
    const reporter = fileURLToPath(new URL("./checkpoint-reporter.mjs", import.meta.url));
    const childEnvironment = { ...process.env };
    for (const name of Object.keys(childEnvironment)) {
      if (name.startsWith("NODE_TEST_")) delete childEnvironment[name];
    }
    delete childEnvironment.NODE_OPTIONS;
    delete childEnvironment.DONA_PROCESS_METRICS_NONCE;
    delete childEnvironment.DONA_ORIGINAL_NODE_OPTIONS;
    childEnvironment.DONA_DISPATCHER_TEST_FILE = "test/sibling.test.ts";
    childEnvironment.DONA_CHECKPOINT_REPORTER_NONCE = nonce;
    childEnvironment.DONA_PROCESS_METRICS_NONCE = nonce;
    childEnvironment.DONA_PROCESS_METRICS_SCOPE = "2";
    childEnvironment.NODE_OPTIONS = `--require=${JSON.stringify(fileURLToPath(new URL("./process-metrics.cjs", import.meta.url)))}`;
    try {
      const result = spawnSync(process.execPath, [
        "--test",
        `--test-reporter=${reporter}`,
        "--test-reporter-destination=stderr",
        fixture,
      ], { env: childEnvironment, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /case-start test\/sibling\.test\.ts:8b23e8e9336e#1/);
      assert.match(result.stderr, /case-finish test\/sibling\.test\.ts:8b23e8e9336e#1/);
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
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
