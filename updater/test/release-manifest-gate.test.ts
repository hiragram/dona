import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

test("non-rollback migration cannot produce a deployable release manifest", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-release-gate-"));
  try {
    await fs.mkdir(path.join(root, "config"));
    await fs.copyFile(new URL("../../config/release-compatibility.json", import.meta.url), path.join(root, "config/release-compatibility.json"));
    const result = promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../../scripts/write-release-manifest.mjs", import.meta.url)),
      root, "a".repeat(40), "test", "test-policy",
    ]);
    await assert.rejects(result, /non_rollback_migration_requires_release_workflow/);
    await assert.rejects(fs.access(path.join(root, "release-manifest.json")), { code: "ENOENT" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
