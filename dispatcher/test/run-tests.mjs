import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const testDirectory = path.resolve("test");
const testFiles = (await fs.readdir(testDirectory))
  .filter((name) => name.endsWith(".test.ts"))
  .sort();
const tsx = path.resolve("node_modules", ".bin", "tsx");
const forwardedArguments = process.argv.slice(2);

for (const name of testFiles) {
  const relative = path.posix.join("test", name);
  process.stdout.write(`[dispatcher-test] start ${relative}\n`);
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(tsx, ["--test", "--test-concurrency=1", ...forwardedArguments, relative], {
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  if (exitCode !== 0) {
    process.stderr.write(`[dispatcher-test] failed ${relative}\n`);
    process.exit(exitCode);
  }
  process.stdout.write(`[dispatcher-test] complete ${relative}\n`);
}
