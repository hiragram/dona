#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

import {
  assertReceiptMatchesDatabases,
  countSnapshot,
  migrateV2ToV3WithBackup,
  verifyDatabase,
  type MigrationReceipt,
  type SchemaCompatibility,
} from "./schema-rollout.js";

async function main(): Promise<void> {
  const [databasePath, backupPath, receiptPath, previousJson, targetJson] = process.argv.slice(2);
  if (!databasePath || !backupPath || !receiptPath || !previousJson || !targetJson) throw new Error("schema_rollout_arguments_invalid");
  await fs.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(backupPath), 0o700);
  try {
    const existing = JSON.parse(await fs.readFile(receiptPath, "utf8")) as MigrationReceipt;
    if (existing.schema_version !== 1 || existing.to_schema !== 3) throw new Error("schema_rollout_receipt_invalid");
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
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const migrated = new Database(databasePath, { readonly: true, fileMustExist: true });
    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      migrated.pragma("foreign_keys = ON");
      backup.pragma("foreign_keys = ON");
      verifyDatabase(migrated, 3);
      verifyDatabase(backup, 2);
      const before = countSnapshot(backup);
      const after = countSnapshot(migrated);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("schema_rollout_receipt_state_mismatch");
      const recovered: MigrationReceipt = {
        schema_version: 1,
        from_schema: 2,
        to_schema: 3,
        backup: { opened: true, integrity_check: "ok", foreign_key_violations: 0 },
        migrated: { integrity_check: "ok", foreign_key_violations: 0, user_version: 3 },
        preservation: Object.fromEntries(Object.keys(before).map((name) => [name, { before: before[name]!, after: after[name]! }])),
        rollback: { target_schema: 3, previous_release_can_read: true, backup_restore_opened: true },
        completed_at: new Date().toISOString(),
      };
      const temporary = `${receiptPath}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(recovered)}\n`, { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, receiptPath);
      process.stdout.write(`${JSON.stringify(recovered)}\n`);
      return;
    } finally {
      migrated.close();
      backup.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const receipt = await migrateV2ToV3WithBackup({
    databasePath,
    backupPath,
    previous: JSON.parse(previousJson) as SchemaCompatibility,
    target: JSON.parse(targetJson) as SchemaCompatibility,
    quiesced: true,
    drained: true,
  });
  const temporary = `${receiptPath}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, receiptPath);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
