#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const [oldDatabaseModule, newDatabaseModule, backup, receiptPath] = process.argv.slice(2);
if (![oldDatabaseModule, newDatabaseModule, backup, receiptPath].every(value => path.isAbsolute(value ?? "")) ||
    path.basename(oldDatabaseModule) !== "database.js" || path.basename(newDatabaseModule) !== "database.js" ||
    path.basename(backup) !== "updater.previous.sqlite3" ||
    path.basename(receiptPath) !== "restore-rehearsal.json") {
  throw new Error("restore rehearsal arguments are invalid");
}
for (const file of [oldDatabaseModule, newDatabaseModule, backup]) {
  const stats = fs.lstatSync(file);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== process.getuid() || stats.nlink !== 1 ||
      (stats.mode & 0o077) !== 0) throw new Error("restore rehearsal input identity is invalid");
}
if (fs.existsSync(receiptPath)) throw new Error("restore rehearsal already exists");
const backupHash = createHash("sha256").update(fs.readFileSync(backup)).digest("hex");
const temporaryDirectory = fs.mkdtempSync(path.join(path.dirname(backup), "restore-rehearsal."));
fs.chmodSync(temporaryDirectory, 0o700);
const readVersion = (file) => Number(execFileSync("/usr/bin/python3", ["-c",
  "import sqlite3,sys,pathlib; c=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True); print(c.execute('PRAGMA user_version').fetchone()[0]); c.close()", file],
  { encoding: "utf8", timeout: 30_000 }).trim());
const inventory = (file) => JSON.parse(execFileSync("/usr/bin/python3", ["-c", `
import json,sqlite3,sys,pathlib
c=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True)
try:
 if c.execute('PRAGMA integrity_check').fetchone()!=('ok',): raise RuntimeError('integrity check failed')
 if c.execute('PRAGMA foreign_key_check').fetchone() is not None: raise RuntimeError('foreign key check failed')
 tables=[row[0] for row in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
 print(json.dumps({'tables':tables,'rows':{name:c.execute('SELECT COUNT(*) FROM "'+name.replace('"','""')+'"').fetchone()[0] for name in tables}}))
finally: c.close()
`, file], { encoding: "utf8", timeout: 30_000 }));
const openModule = (modulePath, file, readonly) => {
  const moduleUrl = pathToFileURL(modulePath).href;
  const code = `import { UpdateDatabase } from ${JSON.stringify(moduleUrl)}; const db = new UpdateDatabase(process.argv[1], ${readonly ? "{ readonly: true }" : "{}"}); db.close();`;
  execFileSync(process.execPath, ["--input-type=module", "-e", code, file], {
    timeout: 30_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.homedir() },
    stdio: ["ignore", "ignore", "pipe"],
  });
};
try {
  const oldSchema = readVersion(backup);
  const originalInventory = inventory(backup);
  const forward = path.join(temporaryDirectory, "forward.sqlite3");
  fs.copyFileSync(backup, forward);
  fs.chmodSync(forward, 0o600);
  openModule(newDatabaseModule, forward, false);
  const newSchema = readVersion(forward);
  const forwardInventory = inventory(forward);
  if (!Number.isSafeInteger(oldSchema) || !Number.isSafeInteger(newSchema) || newSchema < oldSchema) {
    throw new Error("control DB forward migration is invalid");
  }
  for (const name of originalInventory.tables) {
    if (!(name in forwardInventory.rows) || forwardInventory.rows[name] < originalInventory.rows[name]) {
      throw new Error("control DB forward inventory lost existing rows");
    }
  }
  const restored = path.join(temporaryDirectory, "updater.sqlite3");
  fs.copyFileSync(backup, restored);
  fs.chmodSync(restored, 0o600);
  openModule(oldDatabaseModule, restored, true);
  if (readVersion(restored) !== oldSchema) throw new Error("restored control schema changed during rehearsal");
  if (JSON.stringify(inventory(restored)) !== JSON.stringify(originalInventory)) {
    throw new Error("restored control inventory differs from backup");
  }
  if (createHash("sha256").update(fs.readFileSync(backup)).digest("hex") !== backupHash) {
    throw new Error("restore rehearsal changed the immutable backup");
  }
  const receipt = { schema_version: 1, backup_sha256: backupHash,
    old_database_module_sha256: createHash("sha256").update(fs.readFileSync(oldDatabaseModule)).digest("hex"),
    new_database_module_sha256: createHash("sha256").update(fs.readFileSync(newDatabaseModule)).digest("hex"),
    old_schema: oldSchema, new_schema: newSchema,
    rollback: newSchema > oldSchema ? "restore_backup_required" : "same_schema",
    old_binary_restored_backup_readable: true, verified_at: new Date().toISOString() };
  const temporary = `${receiptPath}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(receipt)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, receiptPath);
  const directory = fs.openSync(path.dirname(receiptPath), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
