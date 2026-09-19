import { spawnSync } from "node:child_process";

const expected = 49;
const child = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-reporter=spec",
  "test/scheduler-integration-gate.test.ts", "test/scheduler.test.ts"], {
  cwd: new URL("../dispatcher/", import.meta.url), encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" },
});
process.stdout.write(child.stdout);
process.stderr.write(child.stderr);
if (child.status !== 0) process.exit(child.status ?? 1);
const summary = Object.fromEntries([...child.stdout.matchAll(/^ℹ (tests|pass|fail|skipped) (\d+)$/gm)].map(match => [match[1], Number(match[2])]));
if (summary.tests !== expected || summary.pass !== expected || summary.fail !== 0 || (summary.skipped ?? 0) !== 0) {
  console.error(`scheduler integration gate count mismatch: ${JSON.stringify(summary)}`);
  process.exit(1);
}
