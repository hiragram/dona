#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

import {
  assertReceiptMatchesDatabases,
  contentSnapshot,
  countSnapshot,
  migrateV2ToV3WithBackup,
  publishMigrationReceipt,
  verifyDatabase,
  type MigrationReceipt,
  type SchemaCompatibility,
} from "./schema-rollout.js";

async function main(): Promise<void> {
  const [databasePath, backupPath, receiptPath, previousJson, targetJson] = process.argv.slice(2);
  if (!databasePath || !backupPath || !receiptPath || !previousJson || !targetJson) throw new Error("schema_rollout_arguments_invalid");
  await fs.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(backupPath), 0o700);
  let reuseVerifiedBackup = false;
  try {
    const existing = JSON.parse(await fs.readFile(receiptPath, "utf8")) as MigrationReceipt;
    if (existing.schema_version !== 1 || existing.from_schema !== 2 || existing.to_schema !== 3 ||
      typeof existing.rollback?.backup_restore_opened !== "boolean") throw new Error("schema_rollout_receipt_invalid");
    const migrated = new Database(databasePath, { readonly: true, fileMustExist: true });
    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      migrated.pragma("foreign_keys = ON");
      backup.pragma("foreign_keys = ON");
      assertReceiptMatchesDatabases(existing, migrated, backup);
    } finally {
      migrated.close();
      backup.close();
    }
    process.stdout.write(`${JSON.stringify(existing)}\n`);
    return;
  } catch (error) {
    if ((error as Error).message !== "schema_rollout_receipt_state_mismatch" &&
      (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const migrated = new Database(databasePath, { readonly: true, fileMustExist: true });
    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      migrated.pragma("foreign_keys = ON");
      backup.pragma("foreign_keys = ON");
      const migratedVersion = migrated.pragma("user_version", { simple: true });
      const backupVersion = backup.pragma("user_version", { simple: true });
      if (migratedVersion === 2 && backupVersion === 2) {
        verifyDatabase(migrated, 2);
        verifyDatabase(backup, 2);
        if (JSON.stringify(countSnapshot(backup)) !== JSON.stringify(countSnapshot(migrated)) ||
          JSON.stringify(contentSnapshot(backup)) !== JSON.stringify(contentSnapshot(migrated))) {
          throw new Error("schema_backup_content_mismatch");
        }
        throw new Error("schema_rollout_backup_ready_for_migration");
      }
      verifyDatabase(migrated, 3);
      verifyDatabase(backup, 2);
      const before = countSnapshot(backup);
      const after = countSnapshot(migrated);
      const beforeDigests = contentSnapshot(backup);
      const afterDigests = contentSnapshot(migrated);
      const backupStillMatches = JSON.stringify(before) === JSON.stringify(after) &&
        JSON.stringify(beforeDigests) === JSON.stringify(afterDigests);
      if (!backupStillMatches) throw new Error("schema_backup_content_mismatch");
      const recovered: MigrationReceipt = {
        schema_version: 1,
        from_schema: 2,
        to_schema: 3,
        backup: { opened: true, integrity_check: "ok", foreign_key_violations: 0 },
        migrated: { integrity_check: "ok", foreign_key_violations: 0, user_version: 3 },
        preservation: Object.fromEntries(Object.keys(before).map((name) => [name, {
          before: before[name]!, after: after[name]!,
          before_digest: beforeDigests[name === "events" || name.startsWith("event_") ? "events" : "jobs"]!,
          after_digest: afterDigests[name === "events" || name.startsWith("event_") ? "events" : "jobs"]!,
        }])),
        rollback: { target_schema: 3, previous_release_can_read: true, backup_restore_opened: true },
        completed_at: new Date().toISOString(),
      };
      await publishMigrationReceipt(receiptPath, recovered);
      process.stdout.write(`${JSON.stringify(recovered)}\n`);
      return;
    } finally {
      migrated.close();
      backup.close();
    }
  } catch (error) {
    if ((error as Error).message === "schema_rollout_backup_ready_for_migration") reuseVerifiedBackup = true;
    else if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const receipt = await migrateV2ToV3WithBackup({
    databasePath,
    backupPath,
    previous: JSON.parse(previousJson) as SchemaCompatibility,
    target: JSON.parse(targetJson) as SchemaCompatibility,
    quiesced: true,
    drained: true,
    reuseVerifiedBackup,
  });
  await publishMigrationReceipt(receiptPath, receipt);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
