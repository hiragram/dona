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
  const script = "process.stdout.write('token=secret-value\\n' + 'x'.repeat(4096)); process.stdout.write('[dispatcher-test] start test/job-runtime.test.ts\\n')";
  const result = await new ProcessRunner().run(process.execPath, ["-e", script], {
    timeoutMs: 1_000,
    outputLimitBytes: 1_024,
  });
  assert.equal(result.exit_code, 0);
  assert.equal(result.output_truncated, true);
  assert.equal(result.output_checkpoint, "[dispatcher-test] start test/job-runtime.test.ts");
  assert.equal(result.output_checkpoint.includes("secret-value"), false);
  assert.equal(Buffer.byteLength(result.stdout), 1_024);
});

test("ProcessRunner does not report truncation below the configured output limit", async () => {
  const result = await new ProcessRunner().run(process.execPath, ["-e", "process.stdout.write('x'.repeat(513))"], {
    timeoutMs: 1_000,
    outputLimitBytes: 1_024,
  });
  assert.equal(result.output_truncated, false);
  assert.equal(Buffer.byteLength(result.stdout), 513);
});
