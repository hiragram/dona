import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { CanonicalBuild, RealGit, trustedMainPushRunId } from "../src/adapters.js";
import { parsePolicy } from "../src/policy.js";
import type { ProcessRunner, RunOptions } from "../src/process.js";
import type { CommandResult } from "../src/types.js";
import { removeTree, targetSha, tempPolicy } from "./helpers.js";

const checks = ["Verify dispatcher", "Verify sources/slack", "Verify updater", "Verify self-hosted macOS"];
const success: CommandResult = { exit_code: 0, stdout: "", stderr: "", timed_out: false, output_truncated: false };
const fixture = (runId = 42) => ({ total_count: checks.length, check_runs: checks.map((name, index) => ({
  name, status: "completed", conclusion: "success", head_sha: targetSha,
  app: { slug: "github-actions" },
  details_url: `https://github.com/hiragram/dona/actions/runs/${runId}/job/${index + 1}`,
})) });

test("CI trust requires all exact checks from one successful main push", async () => {
  const { root, policy } = await tempPolicy();
  try {
    assert.equal(trustedMainPushRunId(fixture(), targetSha, checks), 42);
    const rejected = [
      (value: ReturnType<typeof fixture>) => { value.check_runs[3]!.conclusion = "skipped"; },
      (value: ReturnType<typeof fixture>) => { value.check_runs[3]!.conclusion = "failure"; },
      (value: ReturnType<typeof fixture>) => { value.check_runs[3]!.status = "in_progress"; },
      (value: ReturnType<typeof fixture>) => { value.check_runs[3]!.head_sha = "0".repeat(40); },
      (value: ReturnType<typeof fixture>) => { value.check_runs[3]!.details_url = value.check_runs[3]!.details_url.replace("/42/", "/43/"); },
      (value: ReturnType<typeof fixture>) => { value.check_runs.pop(); value.total_count--; },
    ];
    for (const mutate of rejected) {
      const value = fixture();
      mutate(value);
      assert.equal(trustedMainPushRunId(value, targetSha, checks), null);
    }
    assert.throws(() => parsePolicy({ ...policy, required_checks: checks.slice(0, 3) }), /required_checks/);
    for (const overrides of [
      {},
      { event: "pull_request" }, { head_branch: "feature" }, { head_sha: "0".repeat(40) },
      { status: "in_progress" }, { conclusion: "failure" },
    ]) {
      const calls: readonly string[][] = [];
      const runner = { run: async (_command: string, args: readonly string[]) => {
        (calls as string[][]).push([...args]);
        return { ...success, stdout: JSON.stringify(args[3]?.includes("check-runs") ? fixture() : {
          id: 42, event: "push", head_branch: "main", head_sha: targetSha,
          status: "completed", conclusion: "success", name: "CI", ...overrides,
        }) };
      } } as unknown as ProcessRunner;
      const git = new RealGit(policy, runner);
      assert.equal(await (git as unknown as { verifyTrust(sha: string): Promise<boolean> }).verifyTrust(targetSha), Object.keys(overrides).length === 0);
      assert.equal(calls.length, 2);
    }
  } finally { await removeTree(root); }
});

test("pre-activation installs, typechecks and builds each component without running tests", async () => {
  const { root, policy } = await tempPolicy();
  const calls: Array<{ args: readonly string[]; options: RunOptions }> = [];
  const runner = { run: async (_command: string, args: readonly string[], options: RunOptions) => {
    calls.push({ args, options });
    return { ...success, stdout: args[0] === "--version" ? "11.0.0" : "" };
  } } as unknown as ProcessRunner;
  try {
    for (const component of ["dispatcher", "sources/slack", "updater"]) {
      const directory = path.join(root, component);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ engines: { node: ">=24.0.0" } }));
      await fs.writeFile(path.join(directory, "package-lock.json"), "{}");
    }
    await fs.mkdir(path.join(root, "config"));
    await fs.writeFile(path.join(root, "config", "release-compatibility.json"), JSON.stringify({ schema_version: 1, ...policy.compatibility }));
    await new CanonicalBuild(policy, runner).buildRelease(root);
    assert.deepEqual(calls.filter(call => call.args[0] !== "--version").map(call => [
      path.relative(root, call.options.cwd!), ...call.args,
    ]), [
      ["dispatcher", "ci"], ["dispatcher", "run", "typecheck"], ["dispatcher", "run", "build"],
      ["sources/slack", "ci"], ["sources/slack", "run", "typecheck"], ["sources/slack", "run", "build"],
      ["updater", "ci"], ["updater", "run", "typecheck"], ["updater", "run", "build"],
    ]);
  } finally { await removeTree(root); }
});
