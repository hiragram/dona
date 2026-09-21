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
import { createCaseCheckpointChannel } from "./case-checkpoint-channel.mjs";

const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

async function stopTestProcessGroup(child: ReturnType<typeof spawn>): Promise<string[]> {
  const signals: string[] = [];
  if (!child.pid) return signals;
  const groupExists = (): boolean => {
    try { process.kill(-child.pid!, 0); return true; } catch { return false; }
  };
  const send = (signal: NodeJS.Signals): void => {
    if (!groupExists()) return;
    process.kill(-child.pid!, signal);
    signals.push(signal);
  };
  send("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 100));
  send("SIGKILL");
  const deadline = Date.now() + 2_000;
  while (groupExists() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(groupExists(), false, "isolated test process group remained after SIGKILL");
  return signals;
}

function sanitizeNestedTestEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(environment)) if (name.startsWith("NODE_TEST_")) delete environment[name];
  delete environment.DONA_PROCESS_METRICS_SCOPE;
  delete environment.DONA_ORIGINAL_NODE_OPTIONS;
}

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
    assert.equal(process.env.DONA_CASE_CHECKPOINT_NONCE, undefined);
    const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts?: { test?: string };
    };
    assert.equal(packageJson.scripts?.test, "node ../scripts/run-scheduler-integration-gate.mjs && node test/run-tests.mjs");
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
    assert.match(runner, /case-checkpoint\.cjs/);
    assert.match(runner, /checkpoint-reporter\.mjs/);
    const caseCheckpoint = fs.readFileSync(new URL("./case-checkpoint.cjs", import.meta.url), "utf8");
    assert.match(caseCheckpoint, /NODE_TEST_CONTEXT === "child-v8"/);
    assert.match(caseCheckpoint, /metricsScope === 2/);
    assert.match(caseCheckpoint, /fs\.appendFileSync\(eventsPath,/);
    assert.match(caseCheckpoint, /case checkpoint parent acknowledgement timed out/);
    assert.match(caseCheckpoint, /nodeTest\.beforeEach\(\(context\) =>/);
    assert.match(caseCheckpoint, /nodeTest\.before = wrapLifecycleHook/);
    assert.match(caseCheckpoint, /nodeTest\.after = wrapLifecycleHook/);
    assert.match(caseCheckpoint, /marker\("case-start", identity, undefined, true\)/);
    assert.match(caseCheckpoint, /context\.passed === false \? "case-fail" : "case-terminal"/);
    assert.match(caseCheckpoint, /typeof context\.fullName === "string" \? context\.fullName : context\.name/);
    assert.match(caseCheckpoint, /generation !== afterGeneration/);
    assert.match(caseCheckpoint, /context\.after = function checkpointedAfter/);
    assert.doesNotMatch(caseCheckpoint, /nodeTest\.test\s*=/);
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
    assert.match(runner, /failureStdout/);
    assert.match(runner, /process\.stdout\.write\(failureStdout\)/);
    assert.match(runner, /process\.stderr\.write\(failureStderr\)/);
    assert.doesNotMatch(metrics, /\.pid|process\.argv|commandLine/);
    const markerSizes = fs.readdirSync(new URL("./", import.meta.url))
      .filter((name) => name.endsWith(".test.ts"))
      .sort()
      .map(name => Buffer.byteLength(`[dispatcher-test:${"a".repeat(32)}] file-start test/${name} load=0.000\n`));
    // Files accumulate, but the updater persists only the latest nonce-bound checkpoint.
    assert.ok(markerSizes.every(bytes => bytes <= 800), "one checkpoint exceeds the unchanged diagnostic budget");
  });

  test("同期無限loopへ入る前に親processへcase-startを出力する", async () => {
    const temporaryDirectory = fs.mkdtempSync(`${os.tmpdir()}/dona-checkpoint-reporter-`);
    const fixture = `${temporaryDirectory}/pending.test.mjs`;
    const readyPath = `${temporaryDirectory}/ready`;
    fs.writeFileSync(fixture, [
      'import fs from "node:fs";',
      'import { test } from "node:test";',
      'test("sync-loop", () => { process.on("SIGTERM", () => {}); fs.writeFileSync(process.env.DONA_FIXTURE_READY, "ready"); while (true) {} });',
    ].join("\n"));
    const nonce = "0123456789abcdef0123456789abcdef";
    const markers: string[] = [];
    const checkpointChannel = await createCaseCheckpointChannel({ nonce, file: "test/pending.test.ts", onMarker: (marker) => markers.push(marker) });
    const childEnvironment = { ...process.env };
    for (const name of Object.keys(childEnvironment)) {
      if (name.startsWith("NODE_TEST_")) delete childEnvironment[name];
    }
    delete childEnvironment.NODE_OPTIONS;
    delete childEnvironment.DONA_PROCESS_METRICS_NONCE;
    delete childEnvironment.DONA_ORIGINAL_NODE_OPTIONS;
    childEnvironment.DONA_DISPATCHER_TEST_FILE = "test/pending.test.ts";
    childEnvironment.DONA_CASE_CHECKPOINT_NONCE = nonce;
    childEnvironment.DONA_CASE_CHECKPOINT_DIR = checkpointChannel.directory;
    childEnvironment.DONA_PROCESS_METRICS_NONCE = nonce;
    childEnvironment.DONA_FIXTURE_READY = readyPath;
    sanitizeNestedTestEnvironment(childEnvironment);
    childEnvironment.NODE_OPTIONS = `--require=${JSON.stringify(fileURLToPath(new URL("./case-checkpoint.cjs", import.meta.url)))} --require=${JSON.stringify(fileURLToPath(new URL("./process-metrics.cjs", import.meta.url)))}`;
    let stderr = "";
    const child = spawn(tsx, [
      "--test",
      fixture,
    ], {
      env: childEnvironment,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const caseStartPattern = /\[dispatcher-test:[a-f0-9]{32}\] case-start test\/pending\.test\.ts:[a-f0-9]{12}#1/;
    let cleanupSignals: string[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("case-start marker was not emitted")), 2_000);
        const inspect = (): void => {
          if (!caseStartPattern.test(markers.join("\n")) || !fs.existsSync(readyPath)) return;
          clearTimeout(timeout);
          clearInterval(timer);
          resolve();
        };
        const timer = setInterval(inspect, 5);
        child.once("close", () => clearInterval(timer));
        child.once("error", reject);
      });
    } finally {
      cleanupSignals = await stopTestProcessGroup(child);
      await checkpointChannel.close();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    assert.match(markers.join("\n"), caseStartPattern);
    assert.deepEqual(cleanupSignals, ["SIGTERM", "SIGKILL"]);
  });

  test("停止する同期native callへ入る前にも親processがcase identityを確定する", async () => {
    const temporaryDirectory = fs.mkdtempSync(`${os.tmpdir()}/dona-checkpoint-native-`);
    const fixture = `${temporaryDirectory}/native.test.mjs`;
    fs.writeFileSync(fixture, [
      'import { test } from "node:test";',
      'test("native-wait", () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));',
    ].join("\n"));
    const nonce = "1123456789abcdef0123456789abcdef";
    const markers: string[] = [];
    const checkpointChannel = await createCaseCheckpointChannel({ nonce, file: "test/native.test.ts", onMarker: (marker) => markers.push(marker) });
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      DONA_DISPATCHER_TEST_FILE: "test/native.test.ts",
      DONA_CASE_CHECKPOINT_NONCE: nonce,
      DONA_CASE_CHECKPOINT_DIR: checkpointChannel.directory,
      DONA_PROCESS_METRICS_NONCE: nonce,
      NODE_OPTIONS: `--require=${JSON.stringify(fileURLToPath(new URL("./case-checkpoint.cjs", import.meta.url)))} --require=${JSON.stringify(fileURLToPath(new URL("./process-metrics.cjs", import.meta.url)))}`,
    };
    sanitizeNestedTestEnvironment(childEnvironment);
    const child = spawn(tsx, ["--test", fixture], { env: childEnvironment, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const pattern = /case-start test\/native\.test\.ts:[a-f0-9]{12}#1/;
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          clearInterval(poll);
          reject(new Error(`native case-start marker was not acknowledged: ${stderr.slice(-500)}`));
        }, 2_000);
        const poll = setInterval(() => {
          if (!pattern.test(markers.join("\n"))) return;
          clearTimeout(deadline); clearInterval(poll); resolve();
        }, 5);
        child.once("error", reject);
      });
    } finally {
      await stopTestProcessGroup(child);
      await checkpointChannel.close();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    assert.match(markers.join("\n"), pattern);
  });

  test("同名並列testのterminalをexact identityへ対応付ける", async () => {
    const temporaryDirectory = fs.mkdtempSync(`${os.tmpdir()}/dona-checkpoint-occurrence-`);
    const fixture = `${temporaryDirectory}/parallel.test.mjs`;
    fs.writeFileSync(fixture, [
      'import { describe, test } from "node:test";',
      'describe("parallel", { concurrency: true }, () => {',
      '  for (const index of [0, 1]) test("duplicate", async () => index === 0 ? new Promise(() => {}) : new Promise((resolve) => setTimeout(resolve, 50)));',
      '});',
    ].join("\n"));
    const nonce = "0123456789abcdef0123456789abcdef";
    const markers: string[] = [];
    const checkpointChannel = await createCaseCheckpointChannel({ nonce, file: "test/parallel.test.ts", onMarker: (marker) => markers.push(marker) });
    const childEnvironment = { ...process.env };
    for (const name of Object.keys(childEnvironment)) {
      if (name.startsWith("NODE_TEST_")) delete childEnvironment[name];
    }
    delete childEnvironment.NODE_OPTIONS;
    delete childEnvironment.DONA_PROCESS_METRICS_NONCE;
    delete childEnvironment.DONA_ORIGINAL_NODE_OPTIONS;
    childEnvironment.DONA_DISPATCHER_TEST_FILE = "test/parallel.test.ts";
    childEnvironment.DONA_CASE_CHECKPOINT_NONCE = nonce;
    childEnvironment.DONA_CASE_CHECKPOINT_DIR = checkpointChannel.directory;
    childEnvironment.DONA_PROCESS_METRICS_NONCE = nonce;
    sanitizeNestedTestEnvironment(childEnvironment);
    childEnvironment.NODE_OPTIONS = `--require=${JSON.stringify(fileURLToPath(new URL("./case-checkpoint.cjs", import.meta.url)))} --require=${JSON.stringify(fileURLToPath(new URL("./process-metrics.cjs", import.meta.url)))}`;
    let stderr = "";
    const child = spawn(tsx, [
      "--test",
      "--test-concurrency=1",
      fixture,
    ], { env: childEnvironment, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const completedSecond = /case-finish test\/parallel\.test\.ts:[a-f0-9]{12}#2/;
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("second terminal marker was not emitted")), 2_000);
        const timer = setInterval(() => {
          if (!completedSecond.test(markers.join("\n"))) return;
          clearTimeout(timeout);
          clearInterval(timer);
          resolve();
        }, 5);
        child.once("error", reject);
      });
    } finally {
      await stopTestProcessGroup(child);
      await checkpointChannel.close();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    const markerText = markers.join("\n");
    const starts = [...markerText.matchAll(/case-start test\/parallel\.test\.ts:([a-f0-9]{12})#(\d+)/g)];
    assert.deepEqual(starts.map((match) => match[2]), ["1", "2"]);
    assert.equal(starts[0]?.[1], starts[1]?.[1]);
    assert.match(markerText, completedSecond);
  });

  test("非同期pendingの後で未開始cancelになるcaseをunfinishedへ混ぜない", async () => {
    const temporaryDirectory = fs.mkdtempSync(`${os.tmpdir()}/dona-checkpoint-cancel-`);
    const fixture = `${temporaryDirectory}/cancel.test.mjs`;
    fs.writeFileSync(fixture, [
      'import { describe, test } from "node:test";',
      'describe("serial", { concurrency: 1 }, () => {',
      '  test("pending", async () => new Promise(() => {}));',
      '  test("never-started", () => {});',
      '});',
    ].join("\n"));
    const nonce = "2123456789abcdef0123456789abcdef";
    const markers: string[] = [];
    const checkpointChannel = await createCaseCheckpointChannel({ nonce, file: "test/cancel.test.ts", onMarker: (marker) => markers.push(marker) });
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      DONA_DISPATCHER_TEST_FILE: "test/cancel.test.ts",
      DONA_CASE_CHECKPOINT_NONCE: nonce,
      DONA_CASE_CHECKPOINT_DIR: checkpointChannel.directory,
      DONA_PROCESS_METRICS_NONCE: nonce,
      NODE_OPTIONS: `--require=${JSON.stringify(fileURLToPath(new URL("./case-checkpoint.cjs", import.meta.url)))} --require=${JSON.stringify(fileURLToPath(new URL("./process-metrics.cjs", import.meta.url)))}`,
    };
    sanitizeNestedTestEnvironment(childEnvironment);
    const child = spawn(tsx, ["--test", fixture], { env: childEnvironment, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    try {
      const deadline = Date.now() + 2_000;
      while (markers.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(markers.filter((marker) => marker.includes(" case-start ")).length, 1);
      assert.equal(markers.some((marker) => marker.includes("case-finish") || marker.includes("case-fail") || marker.includes("case-terminal")), false);
    } finally {
      await stopTestProcessGroup(child);
      await checkpointChannel.close();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("checkpoint前後のchild crashとchannel切断をfail closedにする", async () => {
    const runCrash = async (source: string, file: string, nonce: string) => {
      const temporaryDirectory = fs.mkdtempSync(`${os.tmpdir()}/dona-checkpoint-crash-`);
      const fixture = `${temporaryDirectory}/crash.test.mjs`;
      fs.writeFileSync(fixture, source);
      const markers: string[] = [];
      const checkpointChannel = await createCaseCheckpointChannel({ nonce, file, onMarker: (marker) => markers.push(marker) });
      const childEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        DONA_DISPATCHER_TEST_FILE: file,
        DONA_CASE_CHECKPOINT_NONCE: nonce,
        DONA_CASE_CHECKPOINT_DIR: checkpointChannel.directory,
        DONA_PROCESS_METRICS_NONCE: nonce,
        NODE_OPTIONS: `--require=${JSON.stringify(fileURLToPath(new URL("./case-checkpoint.cjs", import.meta.url)))} --require=${JSON.stringify(fileURLToPath(new URL("./process-metrics.cjs", import.meta.url)))}`,
      };
      sanitizeNestedTestEnvironment(childEnvironment);
      const child = spawn(tsx, ["--test", fixture], { env: childEnvironment, stdio: ["ignore", "ignore", "ignore"] });
      const status = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      await checkpointChannel.close();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      return { status, markers };
    };
    const before = await runCrash('process.exit(23);\n', "test/crash-before.test.ts", "3123456789abcdef0123456789abcdef");
    assert.notEqual(before.status, 0);
    assert.equal(before.markers.length, 0);
    const after = await runCrash('import { test } from "node:test";\ntest("crash", () => process.exit(24));\n', "test/crash-after.test.ts", "4123456789abcdef0123456789abcdef");
    assert.notEqual(after.status, 0);
    assert.equal(after.markers.filter((marker) => marker.includes(" case-start ")).length, 1);

    const disconnected = await createCaseCheckpointChannel({ nonce: "5123456789abcdef0123456789abcdef", file: "test/disconnected.test.ts" });
    const staleDirectory = disconnected.directory;
    await disconnected.close();
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      DONA_DISPATCHER_TEST_FILE: "test/disconnected.test.ts",
      DONA_CASE_CHECKPOINT_NONCE: "5123456789abcdef0123456789abcdef",
      DONA_CASE_CHECKPOINT_DIR: staleDirectory,
      DONA_PROCESS_METRICS_NONCE: "5123456789abcdef0123456789abcdef",
      NODE_OPTIONS: `--require=${JSON.stringify(fileURLToPath(new URL("./case-checkpoint.cjs", import.meta.url)))} --require=${JSON.stringify(fileURLToPath(new URL("./process-metrics.cjs", import.meta.url)))}`,
    };
    sanitizeNestedTestEnvironment(environment);
    const fixtureDirectory = fs.mkdtempSync(`${os.tmpdir()}/dona-checkpoint-disconnected-`);
    const fixture = `${fixtureDirectory}/disconnected.test.mjs`;
    const canary = `${fixtureDirectory}/body-ran`;
    fs.writeFileSync(fixture, `import fs from "node:fs";\nimport { test } from "node:test";\ntest("never", () => fs.writeFileSync(${JSON.stringify(canary)}, "ran"));\n`);
    const result = spawnSync(tsx, ["--test", fixture], { env: environment, encoding: "utf8" });
    assert.equal(fs.existsSync(canary), false);
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
    assert.notEqual(result.status, 0);
  });

  test("before・beforeEach・afterEach・test.before・test.after・t.afterの同期停止を実行中identityとして保持する", async () => {
    const runStalledHook = async (hook: "before" | "beforeEach" | "afterEach" | "staticBefore" | "staticAfter" | "contextAfter", nonce: string) => {
      const temporaryDirectory = fs.mkdtempSync(`${os.tmpdir()}/dona-checkpoint-hook-`);
      const fixture = `${temporaryDirectory}/hook.test.mjs`;
      const source = hook === "contextAfter" ? [
        'import { test } from "node:test";',
        'test("hook-stall", (t) => { t.after(() => { process.on("SIGTERM", () => {}); while (true) {} }); });',
      ] : hook === "staticBefore" || hook === "staticAfter" ? [
        'import { test } from "node:test";',
        `test.${hook === "staticBefore" ? "before" : "after"}(() => { process.on("SIGTERM", () => {}); while (true) {} });`,
        'test("hook-stall", () => {});',
      ] : [
        `import { ${hook}, test } from "node:test";`,
        `${hook}(() => { process.on("SIGTERM", () => {}); while (true) {} });`,
        'test("hook-stall", () => {});',
      ];
      fs.writeFileSync(fixture, source.join("\n"));
      const markers: string[] = [];
      const checkpointChannel = await createCaseCheckpointChannel({ nonce, file: `test/${hook}.test.ts`, onMarker: (marker) => markers.push(marker) });
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        DONA_DISPATCHER_TEST_FILE: `test/${hook}.test.ts`,
        DONA_CASE_CHECKPOINT_NONCE: nonce,
        DONA_CASE_CHECKPOINT_DIR: checkpointChannel.directory,
        DONA_PROCESS_METRICS_NONCE: nonce,
        NODE_OPTIONS: `--require=${JSON.stringify(fileURLToPath(new URL("./case-checkpoint.cjs", import.meta.url)))} --require=${JSON.stringify(fileURLToPath(new URL("./process-metrics.cjs", import.meta.url)))}`,
      };
      sanitizeNestedTestEnvironment(environment);
      const child = spawn(tsx, ["--test", fixture], { env: environment, detached: true, stdio: ["ignore", "ignore", "ignore"] });
      try {
        const expectedStarts = hook === "staticAfter" ? 2 : 1;
        const deadline = Date.now() + 2_000;
        while (markers.filter((marker) => marker.includes(" case-start ")).length < expectedStarts && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const starts = markers.filter((marker) => marker.includes(" case-start "));
        const terminals = markers.filter((marker) => marker.includes(" case-finish ") || marker.includes(" case-fail ") || marker.includes(" case-terminal "));
        assert.equal(starts.length, expectedStarts, markers.join("\n"));
        assert.equal(terminals.length, hook === "staticAfter" ? 1 : 0, markers.join("\n"));
      } finally {
        await stopTestProcessGroup(child);
        await checkpointChannel.close();
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    };
    await runStalledHook("before", "5123456789abcdef0123456789abcdef");
    await runStalledHook("beforeEach", "6123456789abcdef0123456789abcdef");
    await runStalledHook("afterEach", "7123456789abcdef0123456789abcdef");
    await runStalledHook("contextAfter", "8123456789abcdef0123456789abcdef");
    await runStalledHook("staticBefore", "9123456789abcdef0123456789abcdef");
    await runStalledHook("staticAfter", "a123456789abcdef0123456789abcdef");
  });

  test("callbackとTestContext subtestを保ち元のsource位置を報告する", async () => {
    const temporaryDirectory = fs.mkdtempSync(`${os.tmpdir()}/dona-checkpoint-api-`);
    const fixture = `${temporaryDirectory}/source.test.mjs`;
    fs.writeFileSync(fixture, [
      'import { afterEach, describe, test } from "node:test";',
      'test("callback", (_t, done) => done());',
      'test("parent", async (t) => { await t.test("child", () => {}); });',
      'test("source-location", () => { throw new Error("expected fixture failure"); });',
      'describe("hook failure", () => {',
      '  afterEach(() => { throw new Error("expected afterEach failure"); });',
      '  test("hook-failure", () => {});',
      '});',
    ].join("\n"));
    const nonce = "9123456789abcdef0123456789abcdef";
    const markers: string[] = [];
    const checkpointChannel = await createCaseCheckpointChannel({ nonce, file: "test/source.test.ts", onMarker: (marker) => markers.push(marker) });
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      DONA_DISPATCHER_TEST_FILE: "test/source.test.ts",
      DONA_CASE_CHECKPOINT_NONCE: nonce,
      DONA_CASE_CHECKPOINT_DIR: checkpointChannel.directory,
      DONA_PROCESS_METRICS_NONCE: nonce,
      NODE_OPTIONS: `--require=${JSON.stringify(fileURLToPath(new URL("./case-checkpoint.cjs", import.meta.url)))} --require=${JSON.stringify(fileURLToPath(new URL("./process-metrics.cjs", import.meta.url)))}`,
    };
    sanitizeNestedTestEnvironment(environment);
    const child = spawn(tsx, ["--test", fixture], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { output += chunk; });
    const status = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    await checkpointChannel.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    assert.notEqual(status, 0);
    assert.match(output, /✔ callback/);
    assert.match(output, /source\.test\.mjs:4:\d+/);
    assert.doesNotMatch(output, /test at .*case-checkpoint\.cjs/);
    assert.equal(markers.filter((marker) => marker.includes(" case-start ")).length, 5);
    assert.equal(markers.filter((marker) => marker.includes(" case-finish ") || marker.includes(" case-fail ")).length, 5);
    assert.equal(markers.filter((marker) => marker.includes(" case-fail ")).length, 2);
  });

  test("file wrapper停止をleaf caseとして記録しない", async () => {
    const temporaryDirectory = fs.mkdtempSync(`${os.tmpdir()}/dona-checkpoint-wrapper-`);
    const fixture = `${temporaryDirectory}/wrapper.test.mjs`;
    fs.writeFileSync(fixture, "await new Promise(() => {});\n");
    const nonce = "0123456789abcdef0123456789abcdef";
    const markers: string[] = [];
    const checkpointChannel = await createCaseCheckpointChannel({ nonce, file: "test/wrapper.test.ts", onMarker: (marker) => markers.push(marker) });
    const childEnvironment = { ...process.env };
    for (const name of Object.keys(childEnvironment)) {
      if (name.startsWith("NODE_TEST_")) delete childEnvironment[name];
    }
    delete childEnvironment.NODE_OPTIONS;
    delete childEnvironment.DONA_PROCESS_METRICS_NONCE;
    delete childEnvironment.DONA_ORIGINAL_NODE_OPTIONS;
    childEnvironment.DONA_DISPATCHER_TEST_FILE = "test/wrapper.test.ts";
    childEnvironment.DONA_CASE_CHECKPOINT_NONCE = nonce;
    childEnvironment.DONA_CASE_CHECKPOINT_DIR = checkpointChannel.directory;
    childEnvironment.DONA_PROCESS_METRICS_NONCE = nonce;
    delete childEnvironment.DONA_PROCESS_METRICS_SCOPE;
    childEnvironment.NODE_OPTIONS = `--require=${JSON.stringify(fileURLToPath(new URL("./case-checkpoint.cjs", import.meta.url)))} --require=${JSON.stringify(fileURLToPath(new URL("./process-metrics.cjs", import.meta.url)))}`;
    let stderr = "";
    const child = spawn(tsx, [
      "--test",
      fixture,
    ], { env: childEnvironment, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await stopTestProcessGroup(child);
      await checkpointChannel.close();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    assert.equal(markers.length, 0);
  });

  test("suite後のleaf terminalも記録する", async () => {
    const temporaryDirectory = fs.mkdtempSync(`${os.tmpdir()}/dona-checkpoint-sibling-`);
    const fixture = `${temporaryDirectory}/sibling.test.mjs`;
    fs.writeFileSync(fixture, [
      'import { describe, test } from "node:test";',
      'describe("empty suite", () => {});',
      'test("after suite", () => {});',
    ].join("\n"));
    const nonce = "0123456789abcdef0123456789abcdef";
    const markers: string[] = [];
    const checkpointChannel = await createCaseCheckpointChannel({ nonce, file: "test/sibling.test.ts", onMarker: (marker) => markers.push(marker) });
    const childEnvironment = { ...process.env };
    for (const name of Object.keys(childEnvironment)) {
      if (name.startsWith("NODE_TEST_")) delete childEnvironment[name];
    }
    delete childEnvironment.NODE_OPTIONS;
    delete childEnvironment.DONA_PROCESS_METRICS_NONCE;
    delete childEnvironment.DONA_ORIGINAL_NODE_OPTIONS;
    childEnvironment.DONA_DISPATCHER_TEST_FILE = "test/sibling.test.ts";
    childEnvironment.DONA_CASE_CHECKPOINT_NONCE = nonce;
    childEnvironment.DONA_CASE_CHECKPOINT_DIR = checkpointChannel.directory;
    childEnvironment.DONA_PROCESS_METRICS_NONCE = nonce;
    delete childEnvironment.DONA_PROCESS_METRICS_SCOPE;
    childEnvironment.NODE_OPTIONS = `--require=${JSON.stringify(fileURLToPath(new URL("./case-checkpoint.cjs", import.meta.url)))} --require=${JSON.stringify(fileURLToPath(new URL("./process-metrics.cjs", import.meta.url)))}`;
    try {
      const child = spawn(tsx, [
        "--test",
        fixture,
      ], { env: childEnvironment, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const status = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      await checkpointChannel.close();
      assert.equal(status, 0, stderr);
      const markerText = markers.join("\n");
      const start = /case-start test\/sibling\.test\.ts:([a-f0-9]{12})#1/.exec(markerText);
      assert.ok(start);
      assert.match(markerText, new RegExp(`case-finish test/sibling\\.test\\.ts:${start[1]}#1`));
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
