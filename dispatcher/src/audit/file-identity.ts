import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

const loaded = new WeakSet<Database.Database>();
const mutationTokens = new WeakMap<Database.Database, Buffer>();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Fixed, locally built extension only. Neither SQL nor an external request can
 * choose a library path. Missing/unsupported/stale builds fail closed. */
export function loadSecurityExtension(db: Database.Database): void {
  if (!loaded.has(db)) {
    if (!["darwin", "linux"].includes(process.platform)) throw new Error("security_file_identity_unavailable");
    const manifest = JSON.parse(fs.readFileSync(new URL("../../dist/native/file-identity.json", import.meta.url), "utf8"));
    const library = new URL("../../dist/native/file-identity" + (process.platform === "darwin" ? ".dylib" : ".so"), import.meta.url);
    if (manifest.inputs?.version !== 1 || manifest.inputs.platform !== process.platform || manifest.inputs.arch !== process.arch
      || manifest.inputs.source !== hash(fs.readFileSync(new URL("../../src/native/file-identity.c", import.meta.url)))
      || manifest.inputs.headers !== hash(Buffer.concat([
        fs.readFileSync(new URL("../../node_modules/better-sqlite3/deps/sqlite3/sqlite3.h", import.meta.url)),
        fs.readFileSync(new URL("../../node_modules/better-sqlite3/deps/sqlite3/sqlite3ext.h", import.meta.url)),
      ]))
      || manifest.binary !== hash(fs.readFileSync(library))) throw new Error("security_file_identity_unavailable");
    db.loadExtension(fileURLToPath(library));
    loaded.add(db);
  }
}
export function verifyOpenDatabaseFile(db: Database.Database): void {
  loadSecurityExtension(db);
  const row = db.prepare("SELECT dona_file_identity_ok() AS ok").get() as { ok: number };
  if (row.ok !== 1) throw new Error("security_file_identity_unverified");
}

export function publishMutexFile(db: Database.Database, source: string, target: string): void {
  loadSecurityExtension(db);
  const row = db.prepare("SELECT dona_publish_mutex(?,?) AS published").get(source, target) as { published: number };
  if (row.published !== 0 && row.published !== 1) throw new Error("security_mutex_publish_failed");
}

/** Internal SQL guard, not a sandbox for arbitrary JavaScript. Installing the
 * SQLite authorizer expires previously prepared statements as well. The opaque
 * per-call token is held only by this closure and never stored in the database. */
export function withMutationSqlGuard<T>(db: Database.Database, callback: () => T): T {
  loadSecurityExtension(db);
  const token = randomBytes(32);
  const control = db.prepare("SELECT dona_mutation_guard(?,CAST(? AS INTEGER)) AS ok");
  control.get(token, 1);
  mutationTokens.set(db, token);
  try { return callback(); }
  finally { try { control.get(token, 0); } finally { mutationTokens.delete(db); token.fill(0); } }
}

/** The framework inserts its verified reservation before entering this phase.
 * User mutation SQL cannot add or change clock rows, including prepared SQL. */
export function withClockRowsReadOnly<T>(db: Database.Database, transactionId: string, callback: () => T): T {
  const token = mutationTokens.get(db);
  if (!token) throw new Error("security_sql_guard_unverified");
  const control = db.prepare("SELECT dona_mutation_guard(?,CAST(? AS INTEGER),?) AS ok");
  control.get(token, 2, transactionId);
  try { return callback(); }
  finally { control.get(token, 3, null); }
}
