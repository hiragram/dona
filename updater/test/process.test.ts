import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ProcessRunner } from "../src/process.js";

test("ProcessRunner bounds output and times out without invoking a shell", async () => {
  const result = await new ProcessRunner().run("/usr/bin/yes", [], { timeoutMs: 30, outputLimitBytes: 1_024 });
  assert.equal(result.timed_out, true);
  assert.equal(result.output_truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 1_024);
  assert.ok(Buffer.byteLength(result.stdout) <= 1_024);
});

test("ProcessRunner waits for process-group SIGKILL cleanup after timeout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-process-cleanup-"));
  const pidPath = path.join(root, "child.pid");
  try {
    const script = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      process.on("SIGTERM", () => {});
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
      fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
      setInterval(() => {}, 1000);
    `;
    const result = await new ProcessRunner().run(process.execPath, ["-e", script], {
      timeoutMs: 1_000,
      outputLimitBytes: 1_024,
    });
    assert.equal(result.timed_out, true);
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
  const script = `
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-start test/api.test.ts\\n');
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-start test/api.test.ts:012345abcdef#1\\n');
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-finish test/api.test.ts:012345abcdef#1\\n');
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-start test/api.test.ts:fedcba543210#1\\n');
    process.stdout.write('token=secret-value\\n' + 'x'.repeat(4096));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `;
  const result = await new ProcessRunner().run(process.execPath, ["-e", script], {
    timeoutMs: 100,
    outputLimitBytes: 1_024,
  });
  assert.equal(result.timed_out, true);
  assert.equal(result.output_truncated, true);
  assert.equal(
    result.output_checkpoint,
    "file=file-start test/api.test.ts; last_finish=case-finish test/api.test.ts:012345abcdef#1; timeout=test/api.test.ts:fedcba543210#1",
  );
  assert.equal(result.exit_signal, "SIGKILL");
  assert.equal(result.cleanup_status, "term=group-sent,kill=group-sent,closed=yes");
  assert.equal(result.output_checkpoint.includes("secret-value"), false);
});

test("ProcessRunner keeps the exact remaining concurrent case identity", async () => {
  const script = `
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-start test/api.test.ts\\n');
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-start test/api.test.ts:012345abcdef#1\\n');
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-start test/api.test.ts:012345abcdef#2\\n');
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-finish test/api.test.ts:012345abcdef#1\\n');
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `;
  const result = await new ProcessRunner().run(process.execPath, ["-e", script], {
    timeoutMs: 100,
    outputLimitBytes: 1_024,
  });
  assert.match(result.output_checkpoint ?? "", /timeout=test\/api\.test\.ts:012345abcdef#2/);
});

test("ProcessRunner recognizes a dedicated checkpoint after partial test output", async () => {
  const script = `
    process.stdout.write('partial-without-newline');
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-start test/api.test.ts\\nother-partial-without-newline');
    setTimeout(() => process.stderr.write('\\n[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-start test/api.test.ts:fedcba543210#7\\n'), 10);
    setTimeout(() => {}, 1000);
  `;
  const result = await new ProcessRunner().run(process.execPath, ["-e", script], {
    timeoutMs: 100,
    outputLimitBytes: 1_024,
  });
  assert.equal(result.output_checkpoint, "file=file-start test/api.test.ts; last_finish=none; timeout=test/api.test.ts:fedcba543210#7");
});

test("ProcessRunner freezes the timeout identity during cleanup output", async () => {
  const script = `
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-start test/api.test.ts\\n');
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-start test/api.test.ts:fedcba543210#2\\n');
    process.on('SIGTERM', () => {
      process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-finish test/api.test.ts:fedcba543210#2\\n');
      process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-fail test/api.test.ts\\n');
    });
    setInterval(() => {}, 1000);
  `;
  const result = await new ProcessRunner().run(process.execPath, ["-e", script], {
    timeoutMs: 100,
    outputLimitBytes: 1_024,
  });
  assert.equal(result.output_checkpoint, "file=file-start test/api.test.ts; last_finish=none; timeout=test/api.test.ts:fedcba543210#2");
});

test("ProcessRunner ignores marker-shaped output without the bound nonce", async () => {
  const script = `
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-start test/api.test.ts\\n');
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-start test/api.test.ts:012345abcdef#1\\n');
    process.stdout.write('[dispatcher-test:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb] file-finish test/api.test.ts\\n');
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `;
  const result = await new ProcessRunner().run(process.execPath, ["-e", script], {
    timeoutMs: 100,
    outputLimitBytes: 1_024,
  });
  assert.equal(result.output_checkpoint, "file=file-start test/api.test.ts; last_finish=none; timeout=test/api.test.ts:012345abcdef#1");
});

test("ProcessRunner preserves the failed case when the file failure follows", async () => {
  const script = `
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-start test/api.test.ts\\n');
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-start test/api.test.ts:012345abcdef#1\\n');
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] case-fail test/api.test.ts:012345abcdef#1\\n');
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-fail test/api.test.ts\\n');
    process.exitCode = 1;
  `;
  const result = await new ProcessRunner().run(process.execPath, ["-e", script], {
    timeoutMs: 1_000,
    outputLimitBytes: 1_024,
  });
  assert.equal(
    result.output_checkpoint,
    "file=file-fail test/api.test.ts; last_finish=case-fail test/api.test.ts:012345abcdef#1; unfinished=none",
  );
});

test("ProcessRunner binds the next file nonce after the previous file finishes", async () => {
  const script = `
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-start test/api.test.ts\\n');
    process.stderr.write('[dispatcher-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] file-finish test/api.test.ts\\n');
    process.stderr.write('[dispatcher-test:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb] file-start test/job-runtime.test.ts\\n');
    process.stderr.write('[dispatcher-test:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb] case-start test/job-runtime.test.ts:012345abcdef#1\\n');
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `;
  const result = await new ProcessRunner().run(process.execPath, ["-e", script], {
    timeoutMs: 100,
    outputLimitBytes: 1_024,
  });
  assert.equal(
    result.output_checkpoint,
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

test("ProcessRunner keeps bounded process metrics and load without raw process data", async () => {
  const nonce = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const script = `
    process.stderr.write('[dispatcher-test:${nonce}] file-start test/job-runtime.test.ts load=0.625\\n');
    process.stderr.write('[dispatcher-test:${nonce}] metrics scope=2;node=2/41,git=17/931,shell=1/8,other=0/0;active=3;overhead_us=72\\n');
    process.stderr.write('[dispatcher-test:${nonce}] case-start test/job-runtime.test.ts:012345abcdef#1\\n');
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `;
  const result = await new ProcessRunner().run(process.execPath, ["-e", script], {
    timeoutMs: 100,
    outputLimitBytes: 1_024,
  });
  assert.equal(
    result.output_checkpoint,
    "file=file-start test/job-runtime.test.ts load=0.625; last_finish=none; timeout=test/job-runtime.test.ts:012345abcdef#1; metrics=node=2/41,git=17/931,shell=1/8,other=0/0;active=3;overhead_us=72",
  );
  assert.equal(result.output_checkpoint.includes("pid="), false);
  assert.equal(Buffer.byteLength(result.output_checkpoint), 192);
});

test("ProcessRunner clears metrics when the next file starts", async () => {
  const first = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const second = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const script = `
    process.stderr.write('[dispatcher-test:${first}] file-start test/api.test.ts load=0.125\\n');
    process.stderr.write('[dispatcher-test:${first}] metrics scope=2;node=1/10,git=9/900,shell=0/0,other=0/0;active=0;overhead_us=5\\n');
    process.stderr.write('[dispatcher-test:${first}] file-finish test/api.test.ts elapsed_ms=1000 load=0.125\\n');
    process.stderr.write('[dispatcher-test:${second}] file-start test/worker.test.ts load=0.250\\n');
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `;
  const result = await new ProcessRunner().run(process.execPath, ["-e", script], {
    timeoutMs: 100,
    outputLimitBytes: 2_048,
  });
  assert.equal(
    result.output_checkpoint,
    "file=file-start test/worker.test.ts load=0.250; last_finish=file-finish test/api.test.ts elapsed_ms=1000 load=0.125; timeout=test/worker.test.ts",
  );
});
