import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";

import { inventoryJobArtifacts, inventorySizeIsComplete, readJobArtifactInventoryPage } from "../src/job-artifact-inventory.js";
import type { DispatcherConfig } from "../src/config.js";
import type { JobRow } from "../src/types.js";

test("job artifact inventory observes only contract paths and reports unsafe entries", async () => {
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
    assert.equal(first.artifacts[0]?.cleanup_state, "unmeasured_directory");
    assert.equal(first.artifacts[1]?.cleanup_state, "missing");
    assert.equal(first.artifacts[2]?.cleanup_state, "unmeasured_directory");
    assert.equal(first.artifacts[0]?.allocated_bytes, null);
    assert.equal(first.artifacts[2]?.allocated_bytes, null);
    assert.equal(inventorySizeIsComplete([first]), false);
    const legacyResult = path.join(config.jobResultsDir, `${job_id}.json`);
    await fs.writeFile(legacyResult, "{}");
    const legacy = await inventoryJobArtifacts({ ...row, result_path: legacyResult }, config);
    assert.equal(legacy.artifacts[2]?.cleanup_state, "unmeasured_file");
    await fs.rename(path.dirname(result_path), path.join(root, "moved-result"));
    await fs.symlink(path.join(root, "moved-result"), path.dirname(result_path));
    const unsafe = await inventoryJobArtifacts(row, config);
    assert.equal(unsafe.artifacts[2]?.cleanup_state, "unsafe");
    assert.equal(unsafe.artifacts[2]?.allocated_bytes, null);
    await fs.unlink(path.dirname(result_path));
    await fs.rename(path.join(root, "moved-result"), path.dirname(result_path));
    await fs.unlink(result_path);
    await fs.writeFile(`${result_path}.tmp`, "{}");
    const pending = await inventoryJobArtifacts(row, config);
    assert.equal(pending.artifacts[2]?.cleanup_state, "unmeasured_directory");
    await fs.rm(path.dirname(result_path), { recursive: true });
    await fs.writeFile(path.dirname(result_path), "wrong type");
    const wrongResult = await inventoryJobArtifacts(row, config);
    assert.equal(wrongResult.artifacts[2]?.cleanup_state, "contract_mismatch");
    await fs.unlink(path.dirname(result_path));
    await fs.rename(workspace_path, path.join(root, "moved-worktree"));
    await fs.writeFile(workspace_path, "wrong type");
    const wrongWorktree = await inventoryJobArtifacts(row, config);
    assert.equal(wrongWorktree.artifacts[0]?.cleanup_state, "contract_mismatch");
    await fs.unlink(workspace_path);
    await fs.rename(path.join(root, "moved-worktree"), workspace_path);
    const mismatch = await inventoryJobArtifacts({ ...row, result_path: path.join(root, "outside") }, config);
    assert.equal(mismatch.artifacts[2]?.cleanup_state, "contract_mismatch");
    const malformed = await inventoryJobArtifacts({ ...row, workspace_json: "{" }, config);
    assert.ok(malformed.artifacts.every((artifact) => artifact.cleanup_state === "contract_mismatch"));
    const invalidId = await inventoryJobArtifacts({ ...row, job_id: "../outside" }, config);
    assert.ok(invalidId.artifacts.every((artifact) => artifact.cleanup_state === "contract_mismatch"));
    await fs.rename(config.jobsWorkspaceRoot, path.join(root, "moved-workspaces"));
    await fs.symlink(path.join(root, "moved-workspaces"), config.jobsWorkspaceRoot);
    const redirected = await inventoryJobArtifacts(row, config);
    assert.equal(redirected.artifacts[0]?.cleanup_state, "unsafe");
    assert.equal(redirected.artifacts[1]?.cleanup_state, "unsafe");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("artifact inventory pages jobs through a read-only database handle", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-artifact-page-"));
  try {
    const databasePath = path.join(root, "jobs.sqlite3");
    const db = new Database(databasePath);
    db.exec("CREATE TABLE jobs(job_id TEXT PRIMARY KEY, workspace_json TEXT, workspace_path TEXT, result_path TEXT, status TEXT, created_at TEXT, completed_at TEXT)");
    const insert = db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?)");
    for (const jobId of ["../malformed", "job_01m3p6jrm2g3rsjbadbmpzmend", "job_01m3p6jrm2g3rsjbadbmpzmenf"])
      insert.run(jobId, '{"kind":"scratch"}', "workspace", "result", "completed", "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z");
    db.close();
    const first = readJobArtifactInventoryPage(databasePath, "", 1);
    assert.equal(first.length, 1);
    assert.equal(first[0]?.job_id, "../malformed");
    const second = readJobArtifactInventoryPage(databasePath, String(first[0]!.artifact_cursor), 1);
    assert.equal(second[0]?.job_id, "job_01m3p6jrm2g3rsjbadbmpzmend");
    assert.equal(readJobArtifactInventoryPage(databasePath, String(second[0]!.artifact_cursor), 1)[0]?.job_id,
      "job_01m3p6jrm2g3rsjbadbmpzmenf");
    assert.throws(() => readJobArtifactInventoryPage(databasePath, "invalid", 1), /cursor_or_limit_invalid/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
