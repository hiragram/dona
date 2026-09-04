import assert from "node:assert/strict";
import { test } from "node:test";

import { ProcessRunner } from "../src/process.js";

test("ProcessRunner bounds output and times out without invoking a shell", async () => {
  const result = await new ProcessRunner().run("/usr/bin/yes", [], { timeoutMs: 30, outputLimitBytes: 1_024 });
  assert.equal(result.timed_out, true);
  assert.equal(result.output_truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 1_024);
});
