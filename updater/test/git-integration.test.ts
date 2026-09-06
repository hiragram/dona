import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { RealGit } from "../src/adapters.js";
import type { UpdatePolicy } from "../src/policy.js";
import { removeTree, tempPolicy } from "./helpers.js";

const execute = promisify(execFile);

async function git(args: string[]): Promise<string> {
  const result = await execute("/usr/bin/git", args, { env: { PATH: "/usr/bin:/bin", LANG: "C" } });
  return result.stdout.trim();
}

test("RealGit uses an isolated fixed branch, exact SHA, FF-only ancestry, and detects a force-push race", async () => {
  const { root, policy } = await tempPolicy();
  try {
    const work = path.join(root, "source");
    const remote = path.join(root, "remote.git");
    await git(["init", "--initial-branch=main", work]);
    await git(["-C", work, "config", "user.name", "Dona Test"]);
    await git(["-C", work, "config", "user.email", "dona-test@example.invalid"]);
    await fs.mkdir(path.join(work, "config"));
    await fs.writeFile(path.join(work, "config", "release-compatibility.json"), JSON.stringify({
      schema_version: 1, protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 2,
      app_schema_write: 2, rollback_safe: true,
    }));
    await fs.writeFile(path.join(work, "config", "schema-rollout.json"), JSON.stringify({
      schema_version: 1, phase: "compatibility_bootstrap", database_schema: 2,
      multi_job_enabled: false, capabilities: ["safe_read_max_widening_planner"],
    }));
    await fs.writeFile(path.join(work, "version.txt"), "one\n");
    await git(["-C", work, "add", "version.txt", "config/release-compatibility.json", "config/schema-rollout.json"]);
    await git(["-C", work, "commit", "-m", "first"]);
    const first = await git(["-C", work, "rev-parse", "HEAD"]);
    await git(["clone", "--bare", work, remote]);
    await git(["-C", work, "remote", "add", "origin", remote]);
    await fs.writeFile(path.join(work, "version.txt"), "two\n");
    await git(["-C", work, "commit", "-am", "second"]);
    const second = await git(["-C", work, "rev-parse", "HEAD"]);
    await git(["-C", work, "push", "origin", "main"]);

    const isolatedPolicy = { ...policy, canonical_remote: remote, required_checks: [] } as unknown as UpdatePolicy;
    const adapter = new RealGit(isolatedPolicy);
    assert.deepEqual(await adapter.refresh(first), {
      current_sha: first,
      target_sha: second,
      target_reachable: true,
      ci_trusted: true,
      target_compatibility: { protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 2, app_schema_write: 2, rollback_safe: true },
      target_rollout: {
        schema_version: 1, phase: "compatibility_bootstrap", database_schema: 2,
        multi_job_enabled: false, capabilities: ["safe_read_max_widening_planner"],
      },
    });
    const stage = path.join(root, "stage");
    await fs.mkdir(stage);
    await adapter.stage(second, stage);
    assert.equal(await git(["-C", stage, "rev-parse", "HEAD"]), second);

    await git(["-C", work, "reset", "--hard", first]);
    await git(["-C", work, "push", "--force", "origin", "main"]);
    const raced = await adapter.refresh(second);
    assert.equal(raced.target_sha, first);
    assert.equal(raced.target_reachable, false);
  } finally {
    await removeTree(root);
  }
});
