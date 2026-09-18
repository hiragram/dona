import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const testDirectory = path.resolve("test");
const testFiles = (await fs.readdir(testDirectory))
  .filter((name) => name.endsWith(".test.ts"))
  .sort();
const tsx = path.resolve("node_modules", ".bin", "tsx");
const checkpointReporter = path.resolve("test", "checkpoint-reporter.mjs");
const forwardedArguments = process.argv.slice(2);

for (const name of testFiles) {
  const relative = path.posix.join("test", name);
  const checkpointNonce = randomBytes(16).toString("hex");
  process.stderr.write(`[dispatcher-test:${checkpointNonce}] file-start ${relative}\n`);
  const exitCode = await new Promise((resolve, reject) => {
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
        DONA_CHECKPOINT_REPORTER_NONCE: checkpointNonce,
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  if (exitCode !== 0) {
    process.stderr.write(`[dispatcher-test:${checkpointNonce}] file-fail ${relative}\n`);
    process.exit(exitCode);
  }
  process.stderr.write(`[dispatcher-test:${checkpointNonce}] file-finish ${relative}\n`);
}
