import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { ReleaseStore } from "../src/release-store.js";
import type { UpdateRow } from "../src/types.js";
import { currentSha, installPointers, manifest, removeTree, targetSha, tempPolicy } from "./helpers.js";

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
  };
}

describe("ReleaseStore", () => {
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
});
