import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import Database from "better-sqlite3";

import { dispatcherSchemaCompatibility, migrateDispatcherDatabase } from "./database.js";

export interface SchemaCompatibility {
  app_schema_read_min: number;
  app_schema_read_max: number;
  app_schema_write: number;
  rollback_safe: boolean;
}

export interface MigrationReceipt {
  schema_version: 1;
  from_schema: 2;
  to_schema: 3;
  backup: { opened: true; integrity_check: "ok"; foreign_key_violations: 0 };
  migrated: { integrity_check: "ok"; foreign_key_violations: 0; user_version: 3 };
  preservation: Record<string, { before: number; after: number; before_digest: string; after_digest: string }>;
  rollback: { target_schema: 3; previous_release_can_read: true; backup_restore_opened: boolean };
  completed_at: string;
}

export async function publishMigrationReceipt(receiptPath: string, receipt: MigrationReceipt): Promise<void> {
  const temporary = path.join(path.dirname(receiptPath), `.${path.basename(receiptPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, receiptPath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

const preservedCounts = {
  events: "SELECT COUNT(*) AS count FROM events",
  event_results: "SELECT COUNT(*) AS count FROM events WHERE result_json IS NOT NULL",
  event_completions: "SELECT COUNT(*) AS count FROM events WHERE completed_at IS NOT NULL",
  jobs: "SELECT COUNT(*) AS count FROM jobs",
  job_results: "SELECT COUNT(*) AS count FROM jobs WHERE result_json IS NOT NULL",
  job_completions: "SELECT COUNT(*) AS count FROM jobs WHERE completed_at IS NOT NULL",
} as const;

export function countSnapshot(db: Database.Database): Record<string, number> {
  return Object.fromEntries(Object.entries(preservedCounts).map(([name, sql]) => [
    name,
    (db.prepare(sql).get() as { count: number }).count,
  ]));
}

export function contentSnapshot(db: Database.Database): Record<string, string> {
  const digestRows = (table: "events" | "jobs", orderBy: string): string => {
    const columns = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(({ name }) => name);
    const canonicalColumns = [...columns];
    if (table === "jobs" && !columns.includes("job_key")) {
      canonicalColumns.push("job_key");
    }
    canonicalColumns.sort();
    const projections = canonicalColumns.map((name) => name === "job_key" && !columns.includes("job_key")
      ? `'legacy-default' AS "job_key"`
      : `"${name.replaceAll('"', '""')}"`);
    const projection = projections.join(", ");
    const rows = db.prepare(`SELECT ${projection} FROM ${table} ORDER BY ${orderBy}`).all();
    return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  };
  return { events: digestRows("events", "sequence"), jobs: digestRows("jobs", "job_id") };
}

export function verifyDatabase(db: Database.Database, expectedVersion: number): void {
  const integrity = db.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") throw new Error("database_integrity_check_failed");
  const foreignKeys = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeys.length !== 0) throw new Error("database_foreign_key_check_failed");
  const version = db.pragma("user_version", { simple: true });
  if (version !== expectedVersion) throw new Error(`database_schema_${String(version)}_does_not_match_${expectedVersion}`);
}

export function assertReceiptMatchesDatabases(
  receipt: MigrationReceipt,
  migrated: Database.Database,
  backup: Database.Database,
): void {
  verifyDatabase(migrated, 3);
  verifyDatabase(backup, 2);
  const migratedCounts = countSnapshot(migrated);
  const backupCounts = countSnapshot(backup);
  const migratedDigests = contentSnapshot(migrated);
  const backupDigests = contentSnapshot(backup);
  const names = Object.keys(receipt.preservation);
  if (names.length !== Object.keys(migratedCounts).length || names.some((name) =>
    !(name in migratedCounts) ||
    receipt.preservation[name]?.after !== migratedCounts[name] ||
    receipt.preservation[name]?.after_digest !== migratedDigests[name === "events" || name.startsWith("event_") ? "events" : "jobs"] ||
    (receipt.rollback.backup_restore_opened && (
      receipt.preservation[name]?.before !== backupCounts[name] ||
      receipt.preservation[name]?.before_digest !== backupDigests[name === "events" || name.startsWith("event_") ? "events" : "jobs"] ||
      backupCounts[name] !== migratedCounts[name]
    ))
  )) throw new Error("schema_rollout_receipt_state_mismatch");
}

export function assertSchemaActivationSafe(
  previous: SchemaCompatibility,
  target: SchemaCompatibility,
  actualSchema: number,
): void {
  if (actualSchema !== 2) throw new Error("schema_activation_requires_v2_database");
  if (previous.app_schema_read_min > 2 || previous.app_schema_read_max < 3 || previous.app_schema_write !== 2) {
    throw new Error("previous_release_is_not_v2_v3_compatibility_bridge");
  }
  if (target.app_schema_read_min > 2 || target.app_schema_read_max < 3 || target.app_schema_write !== 3) {
    throw new Error("target_release_is_not_v3_activation_release");
  }
  if (!previous.rollback_safe || !target.rollback_safe) throw new Error("schema_activation_has_no_safe_rollback_target");
}

export async function migrateV2ToV3WithBackup(input: {
  databasePath: string;
  backupPath: string;
  previous: SchemaCompatibility;
  target: SchemaCompatibility;
  quiesced: boolean;
  drained: boolean;
  completedAt?: string;
  postMigrationHook?: () => void;
  reuseVerifiedBackup?: boolean;
}): Promise<MigrationReceipt> {
  if (!input.quiesced || !input.drained) throw new Error("schema_activation_requires_quiesced_drained_runtime");
  try {
    await fs.access(input.backupPath);
    if (!input.reuseVerifiedBackup) throw new Error("schema_backup_target_already_exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const source = new Database(input.databasePath, { fileMustExist: true });
  source.pragma("foreign_keys = ON");
  try {
    const actual = source.pragma("user_version", { simple: true }) as number;
    assertSchemaActivationSafe(input.previous, input.target, actual);
    verifyDatabase(source, 2);
    const before = countSnapshot(source);
    const beforeDigests = contentSnapshot(source);

    // better-sqlite3 uses SQLite's Online Backup API and includes committed WAL pages.
    if (!input.reuseVerifiedBackup) {
      await source.backup(input.backupPath);
      await fs.chmod(input.backupPath, 0o600);
    }
    const backup = new Database(input.backupPath, { readonly: true, fileMustExist: true });
    try {
      backup.pragma("foreign_keys = ON");
      verifyDatabase(backup, 2);
      if (JSON.stringify(countSnapshot(backup)) !== JSON.stringify(before) ||
        JSON.stringify(contentSnapshot(backup)) !== JSON.stringify(beforeDigests)) {
        throw new Error("schema_backup_content_mismatch");
      }
    } finally {
      backup.close();
    }

    let preservation!: MigrationReceipt["preservation"];
    source.transaction(() => {
      migrateDispatcherDatabase(source, () => {}, true);
      input.postMigrationHook?.();
      verifyDatabase(source, dispatcherSchemaCompatibility.write);
      const after = countSnapshot(source);
      const afterDigests = contentSnapshot(source);
      preservation = Object.fromEntries(Object.keys(before).map((name) => [name, {
        before: before[name]!, after: after[name]!,
        before_digest: beforeDigests[name === "events" || name.startsWith("event_") ? "events" : "jobs"]!,
        after_digest: afterDigests[name === "events" || name.startsWith("event_") ? "events" : "jobs"]!,
      }]));
      if (Object.values(preservation).some(({ before: left, after: right, before_digest: leftDigest, after_digest: rightDigest }) =>
        left !== right || leftDigest !== rightDigest)) {
        throw new Error("schema_migration_preservation_failed");
      }
    })();
    return {
      schema_version: 1,
      from_schema: 2,
      to_schema: 3,
      backup: { opened: true, integrity_check: "ok", foreign_key_violations: 0 },
      migrated: { integrity_check: "ok", foreign_key_violations: 0, user_version: 3 },
      preservation,
      rollback: { target_schema: 3, previous_release_can_read: true, backup_restore_opened: true },
      completed_at: input.completedAt ?? new Date().toISOString(),
    };
  } finally {
    source.close();
  }
}
