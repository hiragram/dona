import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { inventoryJobArtifacts } from "../src/job-artifact-inventory.js";
import type { DispatcherConfig } from "../src/config.js";
import type { JobRow } from "../src/types.js";

test("job artifact inventory measures only contract paths and reports unsafe entries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-artifact-inventory-"));
  try {
    const job_id = "job_01m3p6jrm2g3rsjbadbmpzmend";
    const config = { jobsWorkspaceRoot: path.join(root, "workspaces"),
      jobResultsDir: path.join(root, "results") } as DispatcherConfig;
    const workspace_path = path.join(config.jobsWorkspaceRoot, "scratch", job_id);
    const result_path = path.join(config.jobResultsDir, job_id, "result.json");
    const row = { job_id, workspace_json: JSON.stringify({ kind: "scratch" }), workspace_path,
      result_path, status: "completed", created_at: "2026-09-01T00:00:00Z",
      completed_at: "2026-09-02T00:00:00Z" } as JobRow;
    await fs.mkdir(workspace_path, { recursive: true });
    await fs.writeFile(path.join(workspace_path, "work.txt"), "safe");
    await fs.mkdir(path.dirname(result_path), { recursive: true });
    await fs.writeFile(result_path, "{}");
    const first = await inventoryJobArtifacts(row, config);
    assert.deepEqual(first.protection_reasons, ["notification_unverified", "retention_expiry_unverified"]);
    assert.equal(first.artifacts[0]?.cleanup_state, "present");
    assert.equal(first.artifacts[1]?.cleanup_state, "missing");
    assert.equal(first.artifacts[2]?.cleanup_state, "present");
    assert.equal(typeof first.artifacts[0]?.allocated_bytes, "number");
    await fs.symlink(root, path.join(workspace_path, "escape"));
    const unsafe = await inventoryJobArtifacts(row, config);
    assert.equal(unsafe.artifacts[0]?.cleanup_state, "unsafe");
    assert.equal(unsafe.artifacts[0]?.allocated_bytes, null);
    const mismatch = await inventoryJobArtifacts({ ...row, result_path: path.join(root, "outside") }, config);
    assert.equal(mismatch.artifacts[2]?.cleanup_state, "contract_mismatch");
    await fs.rename(config.jobsWorkspaceRoot, path.join(root, "moved-workspaces"));
    await fs.symlink(path.join(root, "moved-workspaces"), config.jobsWorkspaceRoot);
    const redirected = await inventoryJobArtifacts(row, config);
    assert.equal(redirected.artifacts[0]?.cleanup_state, "unsafe");
    assert.equal(redirected.artifacts[1]?.cleanup_state, "unsafe");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
