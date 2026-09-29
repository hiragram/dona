import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { ReleaseStore } from "../src/release-store.js";
import type { UpdateRow } from "../src/types.js";
import { currentSha, installPointers, installRelease, manifest, removeTree, targetSha, tempPolicy } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeTree)));

function row(): UpdateRow {
  return {
    request_id: "upd_01m1es03xy5cf8d9pm5cwx4srv", source_event_id: "evt_01M1ES03XY5CF8D9PM5CWX4SRV",
    reply_target_json: "{}", state: "activating", current_sha: currentSha, target_sha: targetSha, previous_sha: null,
    plan_id: "plan_01m1es03xy5cf8d9pm5cwx4srw", plan_hash: "a".repeat(64), policy_version: "2026-09-02.1",
    compatibility_json: "{}", rollback_compatible: 1, approval_id: "approval", approval_event_id: "evt_01M1ES03XY5CF8D9PM5CWX4SRV",
    attempt: 1, activation_generation: 0,
    restart_attempts: 0, lease_owner: "controller", lease_expires_at: "2026-09-02T00:00:10.000Z", fence: 1,
    cancellation_requested: 0, cancellation_event_id: null, last_error_code: null, last_error_message: null,
    created_at: "2026-09-02T00:00:00.000Z", updated_at: "2026-09-02T00:00:00.000Z", completed_at: null,
    reconcile_after: null, reconcile_deadline: null, last_reconciled_at: null, observed_active_sha: null,
  };
}

describe("ReleaseStore", () => {
  test("isolates an invalid release while planning and cleaning a bounded batch", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    await installPointers(policy);
    const store = new ReleaseStore(policy);
    const invalidSha = "1".repeat(40);
    const invalid = await installRelease(policy, invalidSha);
    await fs.symlink("/tmp", path.join(invalid, "outside"));
    const candidates = Array.from({ length: 11 }, (_, index) => (index + 3).toString(16).repeat(40));
    for (const sha of candidates) await installRelease(policy, sha);
    const protectedShas = new Set([currentSha, "0".repeat(40), ...candidates.slice(-2)]);
    const plan = await store.cleanupPlan(protectedShas);
    assert.equal(plan.length, 8);
    assert.equal(plan.includes(invalidSha), false);
    const removed = await store.cleanup(protectedShas);
    assert.equal(removed.length, 8);
    assert.equal((await store.cleanup(protectedShas)).length, 1);
    assert.equal((await store.observe()).current_sha, currentSha);
    assert.equal((await store.observe()).previous_sha, "0".repeat(40));
    assert.equal((await fs.lstat(invalid)).isDirectory(), true);
  });

  test("accepts symlinks and hardlinks contained in a published release", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    await installPointers(policy);
    const store = new ReleaseStore(policy);
    const candidateSha = "3".repeat(40);
    const release = await installRelease(policy, candidateSha);
    await fs.writeFile(path.join(release, "binary"), "release", { mode: 0o600 });
    await fs.link(path.join(release, "binary"), path.join(release, "binary-alias"));
    await fs.symlink("binary", path.join(release, "binary-link"));
    await fs.utimes(release, new Date("2020-01-01"), new Date("2020-01-01"));
    for (const sha of ["4".repeat(40), "5".repeat(40), "6".repeat(40)]) await installRelease(policy, sha);
    const protectedShas = new Set([currentSha, "0".repeat(40), "5".repeat(40), "6".repeat(40)]);
    assert.ok((await store.cleanupPlan(protectedShas)).includes(candidateSha));
    assert.ok((await store.cleanup(protectedShas)).includes(candidateSha));
    await assert.rejects(fs.lstat(release), { code: "ENOENT" });
  });

  test("continues past invalid cleanup windows after restart", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    await installPointers(policy);
    for (const sha of ["e".repeat(40), "f".repeat(40)]) await installRelease(policy, sha);
    for (let index = 1; index <= 17; index++) {
      const sha = index.toString(16).padStart(40, "0");
      const candidate = await installRelease(policy, sha);
      await fs.symlink("/tmp", path.join(candidate, "outside"));
      const date = new Date(Date.UTC(2020, 0, index));
      await fs.utimes(candidate, date, date);
    }
    const safeSha = "d".repeat(40);
    const safe = await installRelease(policy, safeSha);
    await fs.utimes(safe, new Date("2019-01-01"), new Date("2019-01-01"));
    const protectedShas = new Set([currentSha, "0".repeat(40), "e".repeat(40), "f".repeat(40)]);
    assert.deepEqual(await new ReleaseStore(policy).cleanup(protectedShas), []);
    assert.ok((await new ReleaseStore(policy).cleanup(protectedShas)).includes(safeSha));
    await assert.rejects(fs.lstat(safe), { code: "ENOENT" });
  });

  test("rejects an oversized manifest before parsing cleanup candidates", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    await installPointers(policy);
    const sha = "a".repeat(40);
    const candidate = await installRelease(policy, sha);
    await fs.writeFile(path.join(candidate, "release-manifest.json"), "x".repeat(65_537));
    const store = new ReleaseStore(policy);
    await assert.rejects(store.releaseManifest(sha), /release_manifest_size_or_type_invalid/);
    assert.deepEqual(await store.cleanupPlan(new Set([currentSha, "0".repeat(40)])), []);
  });

  test("publishes an immutable release and atomically activates and rolls it back", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    await installPointers(policy);
    const store = new ReleaseStore(policy);
    const staging = await store.prepareStaging(row().request_id, 1);
    await fs.writeFile(path.join(staging, "app.js"), "export {};\n", { mode: 0o600 });
    const release = await store.publish(staging, manifest(targetSha));
    assert.equal((await fs.stat(release)).mode & 0o777, 0o500);
    const receipt = await store.activate(row(), release);
    assert.equal(receipt.to_sha, targetSha);
    assert.equal((await store.observe()).current_sha, targetSha);
    const rollbackReceipt = await store.rollback({ ...row(), activation_generation: receipt.generation });
    assert.equal(rollbackReceipt.to_sha, currentSha);
    const observed = await store.observe();
    assert.equal(observed.current_sha, currentSha);
    assert.equal(observed.previous_sha, targetSha);
  });

  test("allows hardlinks only when every link is contained in the staging tree", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    await installPointers(policy);
    const store = new ReleaseStore(policy);
    const staging = await store.prepareStaging(row().request_id, 1);
    const binary = path.join(staging, "binary");
    const alias = path.join(staging, "binary-alias");
    await fs.writeFile(binary, "built artifact\n", { mode: 0o700 });
    await fs.link(binary, alias);

    const release = await store.publish(staging, manifest(targetSha));
    const [binaryStats, aliasStats] = await Promise.all([
      fs.stat(path.join(release, "binary")),
      fs.stat(path.join(release, "binary-alias")),
    ]);
    assert.equal(binaryStats.ino, aliasStats.ino);
    assert.equal(binaryStats.nlink, 2);
    assert.equal(binaryStats.mode & 0o777, 0o400);
  });

  test("rejects generated path traversal, symlink escape, and unsafe permissions", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    await installPointers(policy);
    const store = new ReleaseStore(policy);
    await assert.rejects(store.prepareStaging("../escape", 1), /generated_path_escape/);
    const symlinkStage = await store.prepareStaging(row().request_id, 2);
    await fs.symlink("/tmp", path.join(symlinkStage, "escape"));
    await assert.rejects(store.publish(symlinkStage, manifest(targetSha)), /symlink_escape/);
    const permissionStage = await store.prepareStaging(row().request_id, 3);
    await fs.writeFile(path.join(permissionStage, "unsafe"), "x", { mode: 0o666 });
    await fs.chmod(path.join(permissionStage, "unsafe"), 0o666);
    await assert.rejects(store.publish(permissionStage, manifest(targetSha)), /permissions/);

    const externalHardlinkStage = await store.prepareStaging(row().request_id, 4);
    const stagedFile = path.join(externalHardlinkStage, "linked-outside");
    await fs.writeFile(stagedFile, "x", { mode: 0o600 });
    await fs.link(stagedFile, path.join(root, "outside-staging"));
    await assert.rejects(
      store.publish(externalHardlinkStage, manifest(targetSha)),
      /staging_owner_permissions_or_hardlink_invalid/,
    );
  });

  test("rejects a malformed or extended activation receipt instead of trusting a cast", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    await installPointers(policy);
    const store = new ReleaseStore(policy);
    await fs.mkdir(policy.control_root, { recursive: true });
    await fs.writeFile(path.join(policy.control_root, "activation-receipt.json"), JSON.stringify({
      schema_version: 1,
      request_id: row().request_id,
      fence: 1,
      generation: 1,
      from_sha: currentSha,
      to_sha: targetSha,
      pointer_switched_at: "2026-09-03T00:00:00.000Z",
      untrusted_extension: true,
    }));
    await assert.rejects(store.observe(), /unsupported fields/);
  });

  test("resumes a rollback after only the current pointer was durably switched", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    await installPointers(policy);
    const store = new ReleaseStore(policy);
    const staging = await store.prepareStaging(row().request_id, 1);
    await fs.writeFile(path.join(staging, "app.js"), "export {};\n", { mode: 0o600 });
    const release = await store.publish(staging, manifest(targetSha));
    const activation = await store.activate(row(), release);

    await fs.unlink(policy.current_pointer);
    await fs.symlink(path.join(policy.release_root, currentSha), policy.current_pointer);
    const partial = await store.observe();
    assert.equal(partial.current_sha, currentSha);
    assert.equal(partial.previous_sha, currentSha);
    assert.equal(partial.receipt?.to_sha, targetSha);

    const rollback = await store.rollback({ ...row(), state: "rolling_back", activation_generation: activation.generation });
    assert.equal(rollback.generation, activation.generation + 1);
    const observed = await store.observe();
    assert.equal(observed.current_sha, currentSha);
    assert.equal(observed.previous_sha, targetSha);
    assert.equal(observed.receipt?.to_sha, currentSha);
  });
});
