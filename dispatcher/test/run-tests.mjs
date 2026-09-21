import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { createCaseCheckpointChannel } from "./case-checkpoint-channel.mjs";

const testDirectory = path.resolve("test");
const testFiles = (await fs.readdir(testDirectory))
  .filter((name) => name.endsWith(".test.ts"))
  .sort();
const tsx = path.resolve("node_modules", ".bin", "tsx");
const checkpointReporter = path.resolve("test", "checkpoint-reporter.mjs");
const caseCheckpoint = path.resolve("test", "case-checkpoint.cjs");
const processMetrics = path.resolve("test", "process-metrics.cjs");
const forwardedArguments = process.argv.slice(2);
const failureOutputLimitBytes = 64 * 1024;
const failureStreamLimitBytes = failureOutputLimitBytes / 2;

function appendFailureOutput(current, chunk) {
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= failureStreamLimitBytes
    ? combined
    : combined.subarray(combined.length - failureStreamLimitBytes);
}

for (const name of testFiles) {
  const relative = path.posix.join("test", name);
  const startedAt = performance.now();
  process.stdout.write(`[dispatcher-test] start ${relative}\n`);
  let failureStdout = Buffer.alloc(0);
  let failureStderr = Buffer.alloc(0);
  const checkpointNonce = randomBytes(16).toString("hex");
  const checkpointChannel = await createCaseCheckpointChannel({ nonce: checkpointNonce, file: relative });
  const startLoad = os.loadavg()[0] / Math.max(1, os.cpus().length);
  process.stderr.write(`[dispatcher-test:${checkpointNonce}] file-start ${relative} load=${startLoad.toFixed(3)}\n`);
  let exitCode = 1;
  let spawnFailure;
  try {
    exitCode = await new Promise((resolve, reject) => {
      const child = spawn(tsx, [
        "--test",
        "--test-concurrency=1",
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        `--test-reporter=${checkpointReporter}`,
        "--test-reporter-destination=stderr",
        ...forwardedArguments,
        relative,
      ], {
        env: {
          ...process.env,
          DONA_DISPATCHER_TEST_FILE: relative,
          DONA_CASE_CHECKPOINT_NONCE: checkpointNonce,
          DONA_CASE_CHECKPOINT_DIR: checkpointChannel.directory,
          DONA_PROCESS_METRICS_NONCE: checkpointNonce,
          DONA_ORIGINAL_NODE_OPTIONS: process.env.NODE_OPTIONS ?? "",
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ""}--require=${JSON.stringify(caseCheckpoint)} --require=${JSON.stringify(processMetrics)}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk) => {
        failureStdout = appendFailureOutput(failureStdout, chunk);
      });
      child.stderr.on("data", (chunk) => {
        failureStderr = appendFailureOutput(failureStderr, chunk);
        process.stderr.write(chunk);
      });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } catch (error) {
    spawnFailure = error;
  }
  try {
    await checkpointChannel.close();
  } catch (error) {
    process.stderr.write(`[dispatcher-test] case checkpoint channel failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    exitCode = 1;
  }
  if (spawnFailure) throw spawnFailure;
  if (exitCode !== 0) {
    process.stderr.write(`[dispatcher-test:${checkpointNonce}] file-fail ${relative} elapsed_ms=${Math.round(performance.now() - startedAt)} load=${(os.loadavg()[0] / Math.max(1, os.cpus().length)).toFixed(3)}\n`);
    process.stderr.write(`[dispatcher-test] failed ${relative} elapsed_ms=${Math.round(performance.now() - startedAt)}\n`);
    if (failureStdout.length > 0) process.stdout.write(failureStdout);
    if (failureStderr.length > 0) process.stderr.write(failureStderr);
    process.exitCode = exitCode;
    break;
  }
  process.stderr.write(`[dispatcher-test:${checkpointNonce}] file-finish ${relative} elapsed_ms=${Math.round(performance.now() - startedAt)} load=${(os.loadavg()[0] / Math.max(1, os.cpus().length)).toFixed(3)}\n`);
  process.stdout.write(`[dispatcher-test] complete ${relative} elapsed_ms=${Math.round(performance.now() - startedAt)}\n`);
}
