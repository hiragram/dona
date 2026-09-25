import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ProcessCheckpointTracker } from "../src/process-checkpoint.js";
import { ProcessRunner } from "../src/process.js";
import type { DiagnosticLogStore } from "../src/diagnostic-log.js";

async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await fs.access(filePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

function checkpoint(...chunks: string[]): ProcessCheckpointTracker {
  const tracker = new ProcessCheckpointTracker();
  for (const chunk of chunks) tracker.inspect(Buffer.from(chunk));
  return tracker;
}

test("ProcessRunner bounds output and times out without invoking a shell", async () => {
  const result = await new ProcessRunner().run("/usr/bin/yes", [], { timeoutMs: 30, outputLimitBytes: 1_024 });
  assert.equal(result.timed_out, true);
  assert.equal(result.output_truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 1_024);
  assert.ok(Buffer.byteLength(result.stderr) <= 1_024);
});

test("ProcessRunner bounds a fixture readiness handshake independently", () => {
  assert.throws(
    () => new ProcessRunner().run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 50,
      outputLimitBytes: 1_024,
      timeoutStartAfter: Promise.resolve(),
    }),
    /timeoutAfterReadyMs is required/,
  );
});

test("ProcessRunner reports readiness failure separately from timeout", async () => {
  const result = await new ProcessRunner().run(process.execPath, ["-e", `
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  `], {
    timeoutMs: 5_000,
    outputLimitBytes: 1_024,
    timeoutStartAfter: Promise.reject(new Error("fixture failed before ready")),
    timeoutAfterReadyMs: 50,
  });
  assert.equal(result.timed_out, false);
  assert.equal(result.spawn_error, "readiness_failed");
  assert.match(result.cleanup_status ?? "", /^term=group-sent,kill=(?:group-sent|unavailable),closed=yes$/);
});

test("ProcessRunner waits for process-group SIGKILL cleanup after timeout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-process-cleanup-"));
  const pidPath = path.join(root, "child.pid");
  const readyPath = path.join(root, "child.ready");
  try {
    const grandchildScript = `
      const fs = require("node:fs");
      process.on("SIGTERM", () => {});
      fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
      setInterval(() => {}, 1000);
    `;
    const script = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      process.on("SIGTERM", () => {});
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" });
      fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
      setInterval(() => {}, 1000);
    `;
    const result = await new ProcessRunner().run(process.execPath, ["-e", script], {
      timeoutMs: 5_000,
      outputLimitBytes: 1_024,
      timeoutStartAfter: waitForFile(readyPath),
      timeoutAfterReadyMs: 50,
    });
    assert.equal(result.timed_out, true);
    assert.equal(result.spawn_error, undefined);
    const childPid = Number(await fs.readFile(pidPath, "utf8"));
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ProcessRunner preserves only a safe terminal checkpoint after exact-limit truncation", async () => {
  const script = "process.stdout.write('token=secret-value\\n' + 'x'.repeat(4096)); process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-start test/job-runtime.test.ts\\n[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-start test/job-runtime.test.ts:012345abcdef#9\\n')";
  const result = await new ProcessRunner().run(process.execPath, ["-e", script], {
    timeoutMs: 1_000,
    outputLimitBytes: 1_024,
  });
  assert.equal(result.exit_code, 0);
  assert.equal(result.output_truncated, true);
  assert.equal(result.output_checkpoint, "file=file-start test/job-runtime.test.ts; last_finish=none; unfinished=test/job-runtime.test.ts:012345abcdef#9");
  assert.equal(result.output_checkpoint.includes("secret-value"), false);
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 1_024);
  assert.ok(Buffer.byteLength(result.stdout) > 512);
});

test("ProcessRunner reserves stdout capacity when control stderr reaches its quota", async () => {
  const script = `
    process.stderr.write('c'.repeat(4096));
    process.stdout.write('assertion failed');
  `;
  const result = await new ProcessRunner().run(process.execPath, ["-e", script], {
    timeoutMs: 1_000,
    outputLimitBytes: 1_024,
  });
  assert.equal(Buffer.byteLength(result.stderr), 1_008);
  assert.equal(result.stdout, "assertion failed");
  assert.equal(result.output_truncated, true);
});

test("ProcessRunner reallocates an unused stderr quota to stdout", async () => {
  const result = await new ProcessRunner().run(process.execPath, ["-e", "process.stdout.write('x'.repeat(800))"], {
    timeoutMs: 1_000,
    outputLimitBytes: 1_024,
  });
  assert.equal(Buffer.byteLength(result.stdout), 800);
  assert.equal(result.output_truncated, false);
});

test("ProcessRunner prioritizes the unfinished case and cleanup result on timeout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-process-timeout-"));
  const readyPath = path.join(root, "child.ready");
  try {
    const script = `
    const fs = require("node:fs");
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-start test/api.test.ts\\n');
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-start test/api.test.ts:012345abcdef#1\\n');
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-finish test/api.test.ts:012345abcdef#1\\n');
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-start test/api.test.ts:fedcba543210#1\\n');
    process.stdout.write('token=secret-value\\n' + 'x'.repeat(4096));
    process.on('SIGTERM', () => {});
    fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');
    setInterval(() => {}, 1000);
  `;
    const result = await new ProcessRunner().run(process.execPath, ["-e", script], {
      timeoutMs: 5_000,
      outputLimitBytes: 1_024,
      timeoutStartAfter: waitForFile(readyPath),
      timeoutAfterReadyMs: 50,
    });
    assert.equal(result.timed_out, true);
    assert.equal(result.spawn_error, undefined);
    assert.equal(result.output_truncated, true);
    assert.equal(
      result.output_checkpoint,
      "file=file-start test/api.test.ts; last_finish=case-finish test/api.test.ts:012345abcdef#1; timeout=test/api.test.ts:fedcba543210#1",
    );
    assert.equal(result.exit_signal, "SIGKILL");
    assert.equal(result.cleanup_status, "term=group-sent,kill=group-sent,closed=yes");
    assert.equal(result.output_checkpoint.includes("secret-value"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Dispatcher test hang records bounded process observations before and after cleanup", async () => {
  const records: string[] = [];
  const store = { start: () => ({
    write: (_stream: string, chunk: Buffer) => { records.push(chunk.toString("utf8")); },
    finish: () => undefined,
  }) } as unknown as DiagnosticLogStore;
  const result = await new ProcessRunner().run(process.execPath, ["-e", `
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-start test/api.test.ts\\n');
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-start test/api.test.ts:012345abcdef#1\\n');
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `], {
    timeoutMs: 1_000,
    outputLimitBytes: 1024,
    diagnostic: { store, identity: { request_id: "upd_01m1es03xy5cf8d9pm5cwx4srv", attempt: 1, step: "dispatcher:npm-test" } },
  });
  assert.equal(result.timed_out, true);
  const observations = records.filter((record) => record.startsWith("[preflight-observation]"));
  assert.ok(observations.some((record) => record.includes("phase=checkpoint_25") && record.includes("test/api.test.ts:012345abcdef#1")));
  assert.ok(observations.some((record) => record.includes("phase=timeout") && record.includes("process_tree=observed")));
  assert.ok(observations.some((record) => record.includes("phase=cleanup")));
  assert.ok(observations.every((record) => !record.includes("setInterval") && record.length < 6000));
});

test("successful Dispatcher test does not persist a diagnostic capture", async () => {
  const records: string[] = [];
  let failed: boolean | undefined;
  const store = { start: () => ({
    write: (_stream: string, chunk: Buffer) => { records.push(chunk.toString("utf8")); },
    finish: (commandFailed: boolean) => { failed = commandFailed; return undefined; },
  }) } as unknown as DiagnosticLogStore;
  const result = await new ProcessRunner().run(process.execPath, ["-e", "process.stdout.write('ok')"], {
    timeoutMs: 2_000,
    outputLimitBytes: 1024,
    diagnostic: { store, identity: { request_id: "upd_01m1es03xy5cf8d9pm5cwx4srv", attempt: 1, step: "dispatcher:npm-test" } },
  });
  assert.equal(result.exit_code, 0);
  assert.equal(failed, false);
  assert.ok(records.some((record) => record.includes("phase=exit")));
  assert.equal(result.diagnostic_log, undefined);
});

test("ProcessCheckpointTracker keeps the exact remaining concurrent case identity", () => {
  const tracker = checkpoint(
    "[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-start test/api.test.ts\n",
    "[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-start test/api.test.ts:012345abcdef#1\n",
    "[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-start test/api.test.ts:012345abcdef#2\n",
    "[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-finish test/api.test.ts:012345abcdef#1\n",
  );
  assert.match(tracker.freezeTimeout(), /timeout=test\/api\.test\.ts:012345abcdef#2/);
});

test("ProcessCheckpointTracker recognizes a dedicated checkpoint after partial test output", () => {
  const tracker = checkpoint(
    "[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-start test/api.test.ts\nother-partial-without-newline",
    "\n[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-start test/api.test.ts:fedcba543210#7\n",
  );
  assert.equal(tracker.freezeTimeout(), "file=file-start test/api.test.ts; last_finish=none; timeout=test/api.test.ts:fedcba543210#7");
});

test("ProcessCheckpointTracker freezes the timeout identity during cleanup output", () => {
  const tracker = checkpoint(
    "[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-start test/api.test.ts\n",
    "[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-start test/api.test.ts:fedcba543210#2\n",
  );
  const timeout = tracker.freezeTimeout();
  tracker.inspect(Buffer.from(
    "[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-finish test/api.test.ts:fedcba543210#2\n" +
    "[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-fail test/api.test.ts\n",
  ));
  assert.equal(tracker.checkpoint(), timeout);
});

test("ProcessCheckpointTracker ignores marker-shaped output without the bound nonce", () => {
  const tracker = checkpoint(
    "[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-start test/api.test.ts\n",
    "[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-start test/api.test.ts:012345abcdef#1\n",
    "[dispatcher-test:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb] file-finish test/api.test.ts\n",
  );
  assert.equal(tracker.freezeTimeout(), "file=file-start test/api.test.ts; last_finish=none; timeout=test/api.test.ts:012345abcdef#1");
});

test("ProcessCheckpointTracker preserves the failed case when the file failure follows", () => {
  const tracker = checkpoint(
    "[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-start test/api.test.ts\n",
    "[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-start test/api.test.ts:012345abcdef#1\n",
    "[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-fail test/api.test.ts:012345abcdef#1\n",
    "[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-fail test/api.test.ts\n",
  );
  assert.equal(
    tracker.checkpoint(),
    "file=file-fail test/api.test.ts; last_finish=case-fail test/api.test.ts:012345abcdef#1; unfinished=none",
  );
});

test("ProcessCheckpointTracker preserves an unfinished crash identity after file-fail", () => {
  const tracker = checkpoint(
    "[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-start test/api.test.ts\n",
    "[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-start test/api.test.ts:fedcba543210#3\n",
    "[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-fail test/api.test.ts elapsed_ms=9\n",
  );
  assert.equal(
    tracker.checkpoint(),
    "file=file-fail test/api.test.ts elapsed_ms=9; last_finish=file-fail test/api.test.ts elapsed_ms=9; unfinished=test/api.test.ts:fedcba543210#3",
  );
});

test("ProcessCheckpointTracker binds the next file nonce after the previous file finishes", () => {
  const tracker = checkpoint(
    "[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-start test/api.test.ts\n",
    "[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-finish test/api.test.ts\n",
    "[dispatcher-test:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb] file-start test/job-runtime.test.ts\n",
    "[dispatcher-test:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb] case-start test/job-runtime.test.ts:012345abcdef#1\n",
  );
  assert.equal(
    tracker.freezeTimeout(),
    "file=file-start test/job-runtime.test.ts; last_finish=file-finish test/api.test.ts; timeout=test/job-runtime.test.ts:012345abcdef#1",
  );
});

test("ProcessRunner does not report truncation below the configured output limit", async () => {
  const result = await new ProcessRunner().run(process.execPath, ["-e", "process.stdout.write('x'.repeat(511))"], {
    timeoutMs: 1_000,
    outputLimitBytes: 1_024,
  });
  assert.equal(result.output_truncated, false);
  assert.equal(Buffer.byteLength(result.stdout), 511);
});

test("ProcessCheckpointTracker keeps bounded process metrics and load without raw process data", () => {
  const nonce = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const tracker = checkpoint(
    `[dispatcher-test:${nonce}] file-start test/job-runtime.test.ts load=0.625\n`,
    `[dispatcher-test:${nonce}] metrics scope=2;node=2/41,git=17/931,shell=1/8,other=0/0;active=3;overhead_us=72\n`,
    `[dispatcher-test:${nonce}] case-start test/job-runtime.test.ts:012345abcdef#1\n`,
  );
  const result = tracker.freezeTimeout();
  assert.equal(
    result,
    "file=file-start test/job-runtime.test.ts load=0.625; last_finish=none; timeout=test/job-runtime.test.ts:012345abcdef#1; metrics=node=2/41,git=17/931,shell=1/8,other=0/0;active=3;overhead_us=72",
  );
  assert.equal(result.includes("pid="), false);
  assert.equal(Buffer.byteLength(result), 192);
});

test("ProcessCheckpointTracker clears metrics when the next file starts", () => {
  const first = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const second = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const tracker = checkpoint(
    `[dispatcher-test:${first}] file-start test/api.test.ts load=0.125\n`,
    `[dispatcher-test:${first}] metrics scope=2;node=1/10,git=9/900,shell=0/0,other=0/0;active=0;overhead_us=5\n`,
    `[dispatcher-test:${first}] file-finish test/api.test.ts elapsed_ms=1000 load=0.125\n`,
    `[dispatcher-test:${second}] file-start test/worker.test.ts load=0.250\n`,
  );
  assert.equal(
    tracker.freezeTimeout(),
    "file=file-start test/worker.test.ts load=0.250; last_finish=file-finish test/api.test.ts elapsed_ms=1000 load=0.125; timeout=test/worker.test.ts",
  );
});
