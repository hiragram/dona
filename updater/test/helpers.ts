import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { UpdatePolicy } from "../src/policy.js";
import type { ReleaseManifest } from "../src/types.js";
import { canonicalJson } from "../src/validation.js";

export const currentSha = "1".repeat(40);
export const targetSha = "2".repeat(40);
export const olderSha = "0".repeat(40);

export async function tempPolicy(): Promise<{ root: string; policy: UpdatePolicy }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-updater-test-"));
  const base = path.join(root, "Dona");
  const runtime = path.join(base, "runtime");
  const releaseRoot = path.join(runtime, "releases");
  const controlRoot = path.join(base, "update-control");
  return {
    root,
    policy: {
      schema_version: 1,
      policy_version: "2026-09-02.1",
      repository: "hiragram/dona",
      canonical_remote: "https://github.com/hiragram/dona.git",
      default_branch: "main",
      control_root: controlRoot,
      release_root: releaseRoot,
      current_pointer: path.join(runtime, "current"),
      previous_pointer: path.join(runtime, "previous"),
      dispatcher_socket: path.join(base, "run", "dispatcher.sock"),
      slack_socket: path.join(base, "run", "slack.sock"),
      dispatcher_internal_token_file: path.join(controlRoot, "dispatcher.token"),
      launchd: { dispatcher_label: "dev.dona.dispatcher", slack_label: "dev.dona.slack-adapter" },
      executables: { git: "/usr/bin/git", npm: "/usr/bin/npm", node: "/usr/bin/node", launchctl: "/bin/launchctl", gh: "/usr/bin/gh" },
      timeouts: { command_ms: 5_000, health_ms: 100, drain_ms: 100, lease_ms: 1_000 },
      output_limit_bytes: 64 * 1024,
      disk_floor_bytes: 0,
      retain_successful: 2,
      required_checks: ["Verify dispatcher", "Verify sources/slack", "Verify updater"],
      require_verified_signature: false,
      compatibility: {
        protocol: 1,
        config: 1,
        app_schema_read_min: 2,
        app_schema_read_max: 2,
        app_schema_write: 2,
        rollback_safe: true,
      },
    },
  };
}

export function manifest(sha: string): ReleaseManifest {
  return {
    schema_version: 1,
    sha,
    repository: "hiragram/dona",
    policy_version: "2026-09-02.1",
    lock_hashes: { dispatcher: "a".repeat(64), "sources/slack": "b".repeat(64), updater: "c".repeat(64) },
    node_version: process.versions.node,
    npm_version: "11.0.0",
    built_at: "2026-09-02T00:00:00.000Z",
    compatibility: {
      protocol: 1,
      config: 1,
      app_schema_read_min: 2,
      app_schema_read_max: 2,
      app_schema_write: 2,
      rollback_safe: true,
    },
  };
}

export async function installRelease(policy: UpdatePolicy, sha: string): Promise<string> {
  const release = path.join(policy.release_root, sha);
  await fs.mkdir(release, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(release, "release-manifest.json"), `${canonicalJson(manifest(sha))}\n`, { mode: 0o600 });
  return release;
}

export async function installPointers(policy: UpdatePolicy): Promise<void> {
  const current = await installRelease(policy, currentSha);
  const previous = await installRelease(policy, olderSha);
  await fs.mkdir(path.dirname(policy.current_pointer), { recursive: true, mode: 0o700 });
  await fs.symlink(path.relative(path.dirname(policy.current_pointer), current), policy.current_pointer, "dir");
  await fs.symlink(path.relative(path.dirname(policy.previous_pointer), previous), policy.previous_pointer, "dir");
}

export const logger = { info() {}, warn() {}, error() {} };

export async function removeTree(root: string): Promise<void> {
  try {
    const stats = await fs.lstat(root);
    if (!stats.isSymbolicLink() && stats.isDirectory()) {
      await fs.chmod(root, 0o700);
      for (const child of await fs.readdir(root)) await removeTree(path.join(root, child));
    } else if (!stats.isSymbolicLink()) {
      await fs.chmod(root, 0o600);
    }
    await fs.rm(root, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
