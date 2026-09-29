#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

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

export function createAttempt(directory, oldSha, newSha, oldPolicy, newPolicy, oldPlist, newPlist, releaseDigest) {
  assertPrivateDirectory(directory);
  if (!sha(oldSha) || !sha(newSha) || !/^[0-9a-f]{64}$/.test(releaseDigest ?? "")) {
    throw new Error("control attempt SHA or release digest is invalid");
  }
  const file = path.join(directory, "attempt.json");
  if (fs.existsSync(file) || fs.existsSync(`${file}.tmp`)) throw new Error("control attempt already exists or publish is ambiguous");
  publish(file, {
    schema_version: 1, old_build_sha: oldSha, new_build_sha: newSha,
    release_tree_sha256: releaseDigest,
    old_policy_sha256: digest(oldPolicy), new_policy_sha256: digest(newPolicy),
    old_plist_sha256: digest(oldPlist), new_plist_sha256: digest(newPlist),
    phase: "prepared", sequence: 1, db_backup_sha256: null, restore_rehearsal_sha256: null, launchd_operations: [],
    updated_at: new Date().toISOString(),
  });
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

export function verifyAttemptArtifacts(directory, policy, plist, backup, rehearsal) {
  assertPrivateDirectory(directory);
  const file = path.join(directory, "attempt.json");
  assertPrivateFile(file);
  const attempt = JSON.parse(fs.readFileSync(file, "utf8"));
  if (attempt.phase !== "updater_started" || digest(policy) !== attempt.new_policy_sha256 ||
      digest(plist) !== attempt.new_plist_sha256 || digest(backup) !== attempt.db_backup_sha256 ||
      digest(rehearsal) !== attempt.restore_rehearsal_sha256) {
    throw new Error("control attempt artifacts do not match the verified identities");
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "create" && args.length === 8) createAttempt(...args);
    else if (command === "advance" && args.length >= 2 && args.length <= 5) advanceAttempt(...args);
    else if (command === "verify" && args.length === 5) verifyAttemptArtifacts(...args);
    else throw new Error("invalid control attempt command");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
