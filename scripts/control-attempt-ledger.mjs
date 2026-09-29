#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { controlUpdaterTreeDigest } from "./control-updater-tree.mjs";
import { execFileSync } from "node:child_process";

const phases = ["prepared", "updater_stop_intent", "updater_stopped", "backup_verified", "dispatcher_stop_intent", "dispatcher_stopped", "dispatcher_start_intent", "dispatcher_started", "control_swapped", "updater_start_intent", "updater_started", "verified", "restore_required", "restored", "needs_review"];
const nextPhase = new Map([
  ["prepared", "updater_stop_intent"], ["updater_stop_intent", "updater_stopped"],
  ["updater_stopped", "backup_verified"], ["backup_verified", "dispatcher_stop_intent"],
  ["dispatcher_stop_intent", "dispatcher_stopped"], ["dispatcher_stopped", "dispatcher_start_intent"],
  ["dispatcher_start_intent", "dispatcher_started"], ["dispatcher_started", "control_swapped"],
  ["control_swapped", "updater_start_intent"], ["updater_start_intent", "updater_started"],
  ["updater_started", "verified"], ["restore_required", "restored"],
]);
const sha = (value) => /^[0-9a-f]{40}$/.test(value ?? "");
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const entryExists = (file) => {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
};

function assertPrivateDirectory(directory) {
  const stats = fs.lstatSync(directory);
  if (!path.isAbsolute(directory) ||
      !stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== process.getuid() || (stats.mode & 0o077) !== 0) {
    throw new Error("control attempt directory is not owner-private");
  }
}

function assertPrivateFile(file) {
  const stats = fs.lstatSync(file);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== process.getuid() ||
      stats.nlink !== 1 || (stats.mode & 0o077) !== 0) {
    throw new Error("control attempt file is not owner-private");
  }
}

function publish(file, value, writeFile = fs.writeFileSync) {
  const temporary = `${file}.tmp`;
  const bytes = `${JSON.stringify(value)}\n`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    writeFile(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  const dir = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

export function createAttempt(directory, oldSha, newSha, oldPolicy, newPolicy, oldPlist, newPlist,
  releaseDigest, oldUpdaterTree, newUpdaterTree, oldDispatcherPlist, newDispatcherPlist, oldReceipt) {
  assertPrivateDirectory(directory);
  if (!sha(oldSha) || !sha(newSha) || !/^[0-9a-f]{64}$/.test(releaseDigest ?? "")) {
    throw new Error("control attempt SHA or release digest is invalid");
  }
  const file = path.join(directory, "attempt.json");
  if (fs.existsSync(file) || fs.existsSync(`${file}.tmp`)) throw new Error("control attempt already exists or publish is ambiguous");
  assertPrivateFile(oldPolicy);
  assertPrivateFile(oldPlist);
  assertPrivateFile(oldDispatcherPlist);
  assertPrivateFile(newDispatcherPlist);
  if (oldReceipt !== "-") assertPrivateFile(oldReceipt);
  publish(file, {
    schema_version: 1, old_build_sha: oldSha, new_build_sha: newSha,
    release_tree_sha256: releaseDigest,
    old_policy_sha256: digest(oldPolicy), new_policy_sha256: digest(newPolicy),
    old_plist_sha256: digest(oldPlist), new_plist_sha256: digest(newPlist),
    old_updater_tree_sha256: controlUpdaterTreeDigest(oldUpdaterTree),
    new_updater_tree_sha256: controlUpdaterTreeDigest(newUpdaterTree, 0o500),
    old_dispatcher_plist_sha256: digest(oldDispatcherPlist),
    new_dispatcher_plist_sha256: digest(newDispatcherPlist),
    old_receipt_sha256: oldReceipt === "-" ? null : digest(oldReceipt),
    phase: "prepared", sequence: 1, db_backup_sha256: null, restore_rehearsal_sha256: null, launchd_operations: [],
    updated_at: new Date().toISOString(),
  });
}

export function verifyRestoredControl(directory, policy, plist, updaterTree, database, receipt, databaseMode) {
  if (!["copied", "live"].includes(databaseMode)) throw new Error("control restore database mode is invalid");
  assertPrivateDirectory(directory);
  assertPrivateFile(path.join(directory, "attempt.json"));
  const attempt = JSON.parse(fs.readFileSync(path.join(directory, "attempt.json"), "utf8"));
  if (attempt.phase !== "restore_required" || !/^[0-9a-f]{64}$/.test(attempt.old_updater_tree_sha256 ?? "") ||
      !/^[0-9a-f]{64}$/.test(attempt.old_dispatcher_plist_sha256 ?? "")) {
    throw new Error("control restore identity is unavailable");
  }
  assertPrivateFile(policy);
  assertPrivateFile(plist);
  if (digest(policy) !== attempt.old_policy_sha256 || digest(plist) !== attempt.old_plist_sha256 ||
      controlUpdaterTreeDigest(updaterTree) !== attempt.old_updater_tree_sha256) {
    throw new Error("restored control artifacts differ from the saved attempt");
  }
  if (attempt.db_backup_sha256 !== null) {
    const backup = path.join(directory, "updater.previous.sqlite3");
    assertPrivateFile(backup);
    assertPrivateFile(database);
    if (digest(backup) !== attempt.db_backup_sha256 ||
        (databaseMode === "copied" && digest(database) !== attempt.db_backup_sha256)) {
      throw new Error("restored control database differs from the verified backup");
    }
    const rehearsal = path.join(directory, "restore-rehearsal.json");
    assertPrivateFile(rehearsal);
    if (digest(rehearsal) !== attempt.restore_rehearsal_sha256) {
      throw new Error("control restore rehearsal differs from the saved attempt");
    }
    if (databaseMode === "live") {
      execFileSync("/usr/bin/python3", [fileURLToPath(new URL("./backup-control-db.py", import.meta.url)),
        "--verify-pair", database, backup], { timeout: 30_000, stdio: ["ignore", "ignore", "pipe"] });
    }
  }
  if (attempt.old_receipt_sha256 === null) {
    if (entryExists(receipt) || entryExists(path.join(directory, "control-plane-receipt.previous.json"))) {
      throw new Error("restored control receipt differs from the saved absence");
    }
  } else {
    const backupReceipt = path.join(directory, "control-plane-receipt.previous.json");
    assertPrivateFile(backupReceipt);
    assertPrivateFile(receipt);
    if (digest(backupReceipt) !== attempt.old_receipt_sha256 || digest(receipt) !== attempt.old_receipt_sha256) {
      throw new Error("restored control receipt differs from the saved attempt");
    }
  }
}

export function verifyRestoredDispatcher(directory, plist) {
  assertPrivateDirectory(directory);
  assertPrivateFile(path.join(directory, "attempt.json"));
  const attempt = JSON.parse(fs.readFileSync(path.join(directory, "attempt.json"), "utf8"));
  const backup = path.join(directory, "dev.dona.dispatcher.previous.plist");
  assertPrivateFile(plist);
  if (entryExists(backup)) assertPrivateFile(backup);
  if (attempt.phase !== "restore_required" || !/^[0-9a-f]{64}$/.test(attempt.old_dispatcher_plist_sha256 ?? "") ||
      (entryExists(backup) && digest(backup) !== attempt.old_dispatcher_plist_sha256) ||
      digest(plist) !== attempt.old_dispatcher_plist_sha256) {
    throw new Error("restored Dispatcher plist differs from the saved attempt");
  }
}

export function advanceAttempt(directory, phase, operation = "none", backup = undefined, rehearsal = undefined, options = {}) {
  assertPrivateDirectory(directory);
  if (!phases.includes(phase) || !["none", "bootout_updater", "bootstrap_updater", "bootout_dispatcher", "bootstrap_dispatcher"].includes(operation)) {
    throw new Error("control attempt transition is invalid");
  }
  const file = path.join(directory, "attempt.json");
  if (fs.existsSync(`${file}.tmp`)) throw new Error("control attempt previous publish is ambiguous");
  assertPrivateFile(file);
  const current = JSON.parse(fs.readFileSync(file, "utf8"));
  if (current.schema_version !== 1 || !sha(current.old_build_sha) || !sha(current.new_build_sha) ||
    !phases.includes(current.phase) || !Number.isSafeInteger(current.sequence) || current.sequence < 1 ||
    !Array.isArray(current.launchd_operations)) throw new Error("control attempt is invalid");
  if ((current.phase === "verified" && phase !== "restore_required" && phase !== "needs_review") ||
      current.phase === "restored" || current.phase === "needs_review") {
    throw new Error("control attempt is terminal");
  }
  if (phase !== nextPhase.get(current.phase) && phase !== "restore_required" && phase !== "needs_review") {
    throw new Error("control attempt phase is out of order");
  }
  if ((backup !== undefined || rehearsal !== undefined) && phase !== "backup_verified") {
    throw new Error("backup and rehearsal digests belong to backup_verified");
  }
  if (phase === "backup_verified" && (backup === undefined || rehearsal === undefined)) {
    throw new Error("backup_verified requires both durable artifacts");
  }
  const next = { ...current, phase, sequence: current.sequence + 1,
    db_backup_sha256: backup === undefined ? current.db_backup_sha256 : digest(backup),
    restore_rehearsal_sha256: rehearsal === undefined ? current.restore_rehearsal_sha256 : digest(rehearsal),
    launchd_operations: operation === "none" ? current.launchd_operations : [...current.launchd_operations, { sequence: current.sequence + 1, operation }],
    updated_at: new Date().toISOString() };
  publish(file, next, options.writeFileSync);
}

export function verifyAttemptArtifacts(directory, policy, plist, dispatcherPlist, backup, rehearsal) {
  assertPrivateDirectory(directory);
  const file = path.join(directory, "attempt.json");
  assertPrivateFile(file);
  const attempt = JSON.parse(fs.readFileSync(file, "utf8"));
  if (attempt.phase !== "updater_started" || digest(policy) !== attempt.new_policy_sha256 ||
      digest(plist) !== attempt.new_plist_sha256 ||
      digest(dispatcherPlist) !== attempt.new_dispatcher_plist_sha256 ||
      digest(backup) !== attempt.db_backup_sha256 ||
      digest(rehearsal) !== attempt.restore_rehearsal_sha256) {
    throw new Error("control attempt artifacts do not match the verified identities");
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "create" && args.length === 13) createAttempt(...args);
    else if (command === "advance" && args.length >= 2 && args.length <= 5) advanceAttempt(...args);
    else if (command === "verify" && args.length === 6) verifyAttemptArtifacts(...args);
    else if (command === "verify-restore-control" && args.length === 7) verifyRestoredControl(...args);
    else if (command === "verify-restore-dispatcher" && args.length === 2) verifyRestoredDispatcher(...args);
    else throw new Error("invalid control attempt command");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
