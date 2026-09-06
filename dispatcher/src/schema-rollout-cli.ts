#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

import { migrateV2ToV3WithBackup, type SchemaCompatibility } from "./schema-rollout.js";

async function main(): Promise<void> {
  const [databasePath, backupPath, receiptPath, previousJson, targetJson] = process.argv.slice(2);
  if (!databasePath || !backupPath || !receiptPath || !previousJson || !targetJson) throw new Error("schema_rollout_arguments_invalid");
  await fs.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(backupPath), 0o700);
  try {
    const existing = JSON.parse(await fs.readFile(receiptPath, "utf8")) as { schema_version?: unknown; to_schema?: unknown };
    if (existing.schema_version !== 1 || existing.to_schema !== 3) throw new Error("schema_rollout_receipt_invalid");
    const migrated = new Database(databasePath, { readonly: true, fileMustExist: true });
    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      if (migrated.pragma("user_version", { simple: true }) !== 3 ||
        backup.pragma("user_version", { simple: true }) !== 2 ||
        migrated.pragma("integrity_check", { simple: true }) !== "ok" ||
        backup.pragma("integrity_check", { simple: true }) !== "ok") {
        throw new Error("schema_rollout_receipt_state_mismatch");
      }
    } finally {
      migrated.close();
      backup.close();
    }
    process.stdout.write(`${JSON.stringify(existing)}\n`);
    return;
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
