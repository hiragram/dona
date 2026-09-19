#!/usr/bin/env node
import Database from "better-sqlite3";

async function main(): Promise<void> {
  const [databasePath] = process.argv.slice(2);
  if (!databasePath) throw new Error("app_schema_inspect_arguments_invalid");
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    database.pragma("foreign_keys = ON");
    const userVersion = database.pragma("user_version", { simple: true });
    const integrity = database.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const foreignKeys = database.pragma("foreign_key_check") as unknown[];
    if (typeof userVersion !== "number" || !Number.isSafeInteger(userVersion)) {
      throw new Error("dispatcher_database_schema_invalid");
    }
    process.stdout.write(`${JSON.stringify({
      schema_version: 1,
      user_version: userVersion,
      integrity_ok: integrity.length === 1 && integrity[0]?.integrity_check === "ok",
      foreign_key_violations: foreignKeys.length,
    })}\n`);
  } finally {
    database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
