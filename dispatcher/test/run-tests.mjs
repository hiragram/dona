import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const testDirectory = path.resolve("test");
const testFiles = [
  ...(await fs.readdir(testDirectory)).filter((name) => name.endsWith(".test.ts") && name !== "security.test.ts").map((name) => path.posix.join("test", name)),
  ...(await fs.readdir(path.join(testDirectory, "approval"))).filter((name) => name.endsWith(".ts")).map((name) => path.posix.join("test", "approval", name)),
  ...(await fs.readdir(path.join(testDirectory, "audit"))).filter((name) => name.endsWith(".ts")).map((name) => path.posix.join("test", "audit", name)),
].sort();
const tsx = path.resolve("node_modules", ".bin", "tsx");
const forwardedArguments = process.argv.slice(2);
const failureOutputLimitBytes = 64 * 1024;

function appendFailureOutput(current, chunk) {
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= failureOutputLimitBytes
    ? combined
    : combined.subarray(combined.length - failureOutputLimitBytes);
}

for (const name of testFiles) {
  const relative = name;
  const startedAt = performance.now();
  process.stdout.write(`[dispatcher-test] start ${relative}\n`);
  let failureOutput = Buffer.alloc(0);
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(tsx, ["--test", "--test-concurrency=1", ...forwardedArguments, relative], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      failureOutput = appendFailureOutput(failureOutput, chunk);
    });
    child.stderr.on("data", (chunk) => {
      failureOutput = appendFailureOutput(failureOutput, chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  if (exitCode !== 0) {
    process.stderr.write(`[dispatcher-test] failed ${relative} elapsed_ms=${Math.round(performance.now() - startedAt)}\n`);
    if (failureOutput.length > 0) process.stderr.write(failureOutput);
    process.exitCode = exitCode;
    break;
  }
  process.stdout.write(`[dispatcher-test] complete ${relative} elapsed_ms=${Math.round(performance.now() - startedAt)}\n`);
}
