import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

import { jobResultEnvelopeMaxBytes } from "./job-result-publish.js";
import { parseJobResultEnvelope } from "./validation.js";

type LegacyJob = {
  job_id: string; source_event_id: string; status: string; updated_at: string;
  last_error_code: string | null; result_json: string | null; result_path: string;
  completion_event_id: string | null;
};

export type LegacyResultObservation =
  | { state: "absent" }
  | { state: "invalid" | "valid"; sha256: string; bytes: number; device: number; inode: number }
  | { state: "invalid"; reason: "oversize"; sha256: null; bytes: number; device: number; inode: number };

export interface LegacyRecoveryCandidate {
  job_id: string;
  source_event_id: string;
  updated_at: string;
  cause: string | null;
  result: LegacyResultObservation;
  job_row_sha256: string;
  notification_rows_sha256: string;
  provisional_decision: "accept_valid_result" | "fail_invalid_result" | "fail_missing_result" | "blocked";
  blockers: string[];
}

export interface LegacyRecoveryPreflight {
  schema_version: 1;
  source_schema: number;
  backup_sha256: string;
  backup_counts: Record<string, number>;
  candidates: LegacyRecoveryCandidate[];
  maintenance_fence: "unavailable";
  recovery_allowed: false;
  blocker: "independent_complete_worker_stop_receipt_unavailable";
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function verify(db: Database.Database): number {
  if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("legacy_backup_integrity_failed");
  if ((db.pragma("foreign_key_check") as unknown[]).length !== 0) throw new Error("legacy_backup_foreign_keys_failed");
  const version = db.pragma("user_version", { simple: true });
  if (version !== 3) throw new Error("legacy_backup_schema_unsupported");
  return version;
}

function counts(db: Database.Database): Record<string, number> {
  const result: Record<string, number> = {};
  for (const table of ["events", "jobs", "job_groups", "event_job_bindings", "job_owner_bindings"] as const) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!exists) throw new Error("legacy_backup_schema_incomplete");
    result[table] = (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  }
  return result;
}

async function pathIdentities(filePath: string): Promise<Set<string>> {
  const absolute = path.resolve(filePath);
  const identities = new Set([absolute]);
  try { identities.add(path.join(await fs.realpath(path.dirname(absolute)), path.basename(absolute))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return identities;
}

async function assertBackupPathsUnreserved(
  db: Database.Database, sourcePath: string, backupPath: string, requireSidecarsAbsent = true,
): Promise<void> {
  const reserved = [sourcePath, `${sourcePath}-wal`, `${sourcePath}-shm`, `${sourcePath}-journal`];
  for (const row of db.prepare("SELECT result_path FROM jobs UNION ALL SELECT result_path FROM events WHERE result_path IS NOT NULL")
    .all() as Array<{ result_path: string }>) reserved.push(row.result_path);
  const temporary = `${backupPath}.tmp`;
  const destinations = [backupPath, temporary, `${temporary}-journal`, `${temporary}-wal`, `${temporary}-shm`];
  const destination = new Set<string>();
  for (const candidate of destinations) {
    for (const identity of await pathIdentities(candidate)) destination.add(identity);
  }
  for (const candidate of reserved) {
    for (const identity of await pathIdentities(candidate)) {
      if (destination.has(identity)) throw new Error("legacy_backup_path_reserved");
    }
  }
  for (const candidate of requireSidecarsAbsent ? destinations.slice(2) : []) {
    try { await fs.lstat(candidate); throw new Error("legacy_backup_sidecar_exists"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function resultObservation(job: LegacyJob): Promise<LegacyResultObservation> {
  let file: fs.FileHandle;
  try {
    file = await fs.open(job.result_path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    throw new Error("legacy_result_open_failed", { cause: error });
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("legacy_result_file_invalid");
    if (stat.size > jobResultEnvelopeMaxBytes) {
      const after = await file.stat();
      const named = await fs.lstat(job.result_path);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs ||
          !named.isFile() || named.dev !== stat.dev || named.ino !== stat.ino)
        throw new Error("legacy_result_changed_during_read");
      return { state: "invalid", reason: "oversize", sha256: null, bytes: stat.size,
        device: stat.dev, inode: stat.ino };
    }
    const chunks: Buffer[] = [];
    let length = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65_536, jobResultEnvelopeMaxBytes + 1 - length));
      const read = (await file.read(chunk, 0, chunk.length, null)).bytesRead;
      if (read === 0) break;
      length += read;
      if (length > jobResultEnvelopeMaxBytes) throw new Error("legacy_result_file_invalid");
      chunks.push(chunk.subarray(0, read));
    }
    const after = await file.stat();
    const named = await fs.lstat(job.result_path);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new Error("legacy_result_changed_during_read");
    if (!named.isFile() || named.dev !== stat.dev || named.ino !== stat.ino)
      throw new Error("legacy_result_changed_during_read");
    const bytes = Buffer.concat(chunks, length);
    const observed = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: length,
      device: stat.dev, inode: stat.ino };
    try {
      parseJobResultEnvelope(JSON.parse(bytes.toString("utf8")), job.job_id);
      return { state: "valid", ...observed };
    } catch {
      return { state: "invalid", ...observed };
    }
  } finally {
    await file.close();
  }
}

/** Creates an owner-only, verified snapshot. It never changes the source database or any Result. */
export async function createLegacyRecoveryPreflight(sourcePath: string, backupPath: string): Promise<LegacyRecoveryPreflight> {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const temporary = `${backupPath}.tmp`;
  let backup: Database.Database | undefined;
  let temporaryCreated = false;
  try {
    verify(source);
    await assertBackupPathsUnreserved(source, sourcePath, backupPath);
    const parent = await fs.realpath(path.dirname(backupPath));
    const parentStat = await fs.stat(parent);
    if ((parentStat.mode & 0o077) !== 0) throw new Error("legacy_backup_directory_not_private");
    if (await fs.stat(backupPath).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    })) throw new Error("legacy_backup_already_exists");
    const tempHandle = await fs.open(temporary, "wx", 0o600);
    temporaryCreated = true;
    await tempHandle.close();
    // better-sqlite3's online backup supplies one consistent SQLite snapshot.
    await source.backup(temporary);
    await fs.chmod(temporary, 0o600);
    backup = new Database(temporary, { fileMustExist: true });
    // The online backup inherits WAL mode. Checkpoint this private copy and
    // switch it to DELETE so no SQLite sidecars remain beside the published file.
    if (backup.pragma("journal_mode = DELETE", { simple: true }) !== "delete")
      throw new Error("legacy_backup_journal_mode_failed");
    const sourceSchema = verify(backup);
    const backupCounts = counts(backup);
    await assertBackupPathsUnreserved(backup, sourcePath, backupPath, false);
    const rows = backup.prepare("SELECT * FROM jobs WHERE status='needs_review' ORDER BY job_id").all() as LegacyJob[];
    const candidates: LegacyRecoveryCandidate[] = [];
    for (const job of rows) {
      const result = await resultObservation(job);
      const notificationRows = backup.prepare("SELECT * FROM events WHERE event_id IN (SELECT completion_event_id FROM jobs WHERE job_id=?) OR event_id IN (SELECT attention_event_id FROM job_groups WHERE source_event_id=?) OR event_id IN (SELECT all_terminal_event_id FROM job_groups WHERE source_event_id=?) ORDER BY sequence")
        .all(job.job_id, job.source_event_id, job.source_event_id);
      const group = backup.prepare("SELECT * FROM job_groups WHERE source_event_id=?").get(job.source_event_id);
      const binding = backup.prepare("SELECT owner_json FROM job_owner_bindings WHERE job_id=? AND source_event_id=?")
        .get(job.job_id, job.source_event_id) as { owner_json: string } | undefined;
      const blockers: string[] = [];
      let ownerKind: unknown;
      try { ownerKind = binding ? (JSON.parse(binding.owner_json) as { kind?: unknown }).kind : undefined; }
      catch { ownerKind = undefined; }
      if (ownerKind !== "slack_thread") blockers.push("owner_not_slack_thread_or_unverified");
      if (job.result_json !== null) blockers.push("result_already_accepted");
      if (notificationRows.some((row) => (row as { status: string }).status !== "queued" && (row as { status: string }).status !== "completed"))
        blockers.push("notification_requires_individual_reconciliation");
      if (!group) blockers.push("group_missing");
      const provisionalDecision = blockers.length ? "blocked" : result.state === "valid" ? "accept_valid_result" :
        result.state === "absent" ? "fail_missing_result" : "fail_invalid_result";
      candidates.push({ job_id: job.job_id, source_event_id: job.source_event_id, updated_at: job.updated_at,
        cause: job.last_error_code, result, job_row_sha256: digest(job),
        notification_rows_sha256: digest({ group, notificationRows }), provisional_decision: provisionalDecision, blockers });
    }
    backup.close(); backup = undefined;
    const backupHash = createHash("sha256");
    for await (const chunk of createReadStream(temporary)) backupHash.update(chunk);
    const backupSha256 = backupHash.digest("hex");
    await assertBackupPathsUnreserved(source, sourcePath, backupPath);
    // link is exclusive: unlike rename, it cannot replace a backup created during inspection.
    await fs.link(temporary, backupPath);
    await fs.unlink(temporary);
    temporaryCreated = false;
    return { schema_version: 1, source_schema: sourceSchema, backup_sha256: backupSha256,
      backup_counts: backupCounts, candidates, maintenance_fence: "unavailable", recovery_allowed: false,
      blocker: "independent_complete_worker_stop_receipt_unavailable" };
  } catch (error) {
    if (temporaryCreated) await fs.rm(temporary, { force: true });
    throw error;
  } finally {
    backup?.close();
    source.close();
  }
}
