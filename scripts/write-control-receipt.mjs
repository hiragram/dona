#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { controlUpdaterTreeDigest } from "./control-updater-tree.mjs";

const [attemptDirectory, output, expectedSha, controlUpdaterRoot] = process.argv.slice(2);
if (!path.isAbsolute(attemptDirectory ?? "") || !path.isAbsolute(output ?? "") ||
    !path.isAbsolute(controlUpdaterRoot ?? "") ||
    !/^[0-9a-f]{40}$/.test(expectedSha ?? "") ||
    !/^[0-9a-f]{40}\.[A-Za-z0-9]+$/.test(path.basename(attemptDirectory))) {
  throw new Error("control receipt arguments are invalid");
}
const attemptFile = path.join(attemptDirectory, "attempt.json");
const attemptStats = fs.lstatSync(attemptFile);
if (!attemptStats.isFile() || attemptStats.isSymbolicLink() || attemptStats.uid !== process.getuid() ||
    attemptStats.nlink !== 1 || (attemptStats.mode & 0o077) !== 0) {
  throw new Error("control attempt ledger is not owner-private");
}
const bytes = fs.readFileSync(attemptFile);
const attempt = JSON.parse(bytes.toString("utf8"));
if (attempt.schema_version !== 1 || attempt.phase !== "verified" || attempt.new_build_sha !== expectedSha ||
    !/^[0-9a-f]{64}$/.test(attempt.db_backup_sha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(attempt.restore_rehearsal_sha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(attempt.release_tree_sha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(attempt.new_policy_sha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(attempt.new_plist_sha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(attempt.new_dispatcher_plist_sha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(attempt.old_updater_tree_sha256 ?? "")) {
  throw new Error("control attempt is not verified");
}
const newUpdaterTreeSha256 = controlUpdaterTreeDigest(controlUpdaterRoot);
if (!/^[0-9a-f]{64}$/.test(attempt.new_updater_tree_sha256 ?? "") ||
    newUpdaterTreeSha256 !== attempt.new_updater_tree_sha256) {
  throw new Error("installed updater differs from the verified release");
}
const oldUpdaterTreeSha256 = controlUpdaterTreeDigest(path.join(attemptDirectory, "updater.previous"));
if (oldUpdaterTreeSha256 !== attempt.old_updater_tree_sha256) {
  throw new Error("restore updater differs from the saved control attempt");
}
const receipt = {
  schema_version: 1,
  build_sha: expectedSha,
  schema_migration_capability: "dispatcher_v2_to_v3_online_backup_v1",
  attempt_id: path.basename(attemptDirectory),
  attempt_sha256: createHash("sha256").update(bytes).digest("hex"),
  old_build_sha: attempt.old_build_sha,
  policy_sha256: attempt.new_policy_sha256,
  plist_sha256: attempt.new_plist_sha256,
  dispatcher_plist_sha256: attempt.new_dispatcher_plist_sha256,
  db_backup_sha256: attempt.db_backup_sha256,
  release_tree_sha256: attempt.release_tree_sha256,
  control_updater_tree_sha256: newUpdaterTreeSha256,
  old_updater_tree_sha256: oldUpdaterTreeSha256,
  restore_rehearsal_sha256: attempt.restore_rehearsal_sha256,
  verified_at: new Date().toISOString(),
};
const fd = fs.openSync(output, "wx", 0o600);
try {
  fs.writeFileSync(fd, `${JSON.stringify(receipt)}\n`);
  fs.fsyncSync(fd);
} finally {
  fs.closeSync(fd);
}
