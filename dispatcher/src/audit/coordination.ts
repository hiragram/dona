import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";

const active = new Set<string>();
const opened = new WeakMap<Database.Database, { filename: string; identity: string }>();
const ddl = "CREATE TABLE security_transaction_mutex (singleton INTEGER PRIMARY KEY CHECK(singleton=1), target_hash TEXT NOT NULL)";
export class SecurityCoordinationError extends Error {
  constructor() { super("security_transaction_coordination_failed"); this.name = "SecurityCoordinationError"; }
}

function privateRegular(filename: string, singleLink = false): void {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0
    || (singleLink && info.nlink !== 1)) throw new SecurityCoordinationError();
}

function databasePathIdentity(filename: string): string {
  if (!path.isAbsolute(filename) || path.normalize(filename) !== filename) throw new SecurityCoordinationError();
  privateRegular(filename, true);
  const file = fs.lstatSync(filename);
  const parts: Array<[string, number, number]> = [[filename, file.dev, file.ino]];
  let directory = path.dirname(filename);
  while (true) {
    const info = fs.lstatSync(directory);
    // Every ancestor must be a real directory controlled by this user or root.
    // In particular, a writable or symlink ancestor cannot redirect the open.
    if (!info.isDirectory() || ![0, process.getuid?.()].includes(info.uid) || (info.mode & 0o022) !== 0
      || (directory === path.dirname(filename) && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))) {
      throw new SecurityCoordinationError();
    }
    parts.push([directory, info.dev, info.ino]);
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return JSON.stringify(parts);
}

/** Open an existing owner-only database after checking the configured path itself.
 * Runtime provisioning must create the private file separately; this never
 * resolves aliases, creates a database, or registers an already-open connection. */
export function openSecurityDatabase(filename: string): Database.Database {
  let db: Database.Database | undefined;
  try {
    const identity = databasePathIdentity(filename);
    db = new Database(filename, { fileMustExist: true });
    if (databasePathIdentity(filename) !== identity) throw new SecurityCoordinationError();
    opened.set(db, { filename, identity });
    return db;
  } catch {
    try { db?.close(); } catch { /* Preserve the redacted open error. */ }
    throw new SecurityCoordinationError();
  }
}

/** Publish an owner-only empty file without ever opening/closing an extra fd on
 * the published SQLite inode while another connection may hold POSIX locks. */
function ensureFile(filename: string): void {
  try { fs.lstatSync(filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const temporary = filename + ".init-" + randomUUID();
    const fd = fs.openSync(temporary, "wx", 0o600);
    fs.closeSync(fd);
    try {
      try { fs.linkSync(temporary, filename); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { fs.unlinkSync(temporary); }
  }
  privateRegular(filename);
}

/** Cross-process coordination only, never an audit anchor or clock authority.
 * The separate DB contains no decisions, credentials or trusted high-water mark.
 * Its OS writer lock spans clock reservation through audit finalize, and is
 * released automatically on crash. All users of the shared clock must use it.
 * No transaction is opened on the business DB before the clock reservation. */
export function withSecurityTransactionLock<T>(business: Database.Database, work: () => T): T {
  let mutex: Database.Database | undefined;
  let owned: string | undefined;
  try {
    if (!business.open || business.memory || business.readonly || business.inTransaction || !path.isAbsolute(business.name)) throw new SecurityCoordinationError();
    const registration = opened.get(business);
    if (!registration || business.name !== registration.filename
      || databasePathIdentity(registration.filename) !== registration.identity) throw new SecurityCoordinationError();
    const target = registration.filename;
    const filename = target + ".security-lock.sqlite";
    if (active.has(filename)) throw new SecurityCoordinationError();
    active.add(filename); owned = filename;
    ensureFile(filename);
    mutex = new Database(filename, { timeout: 2000 });
    const connection = mutex;
    const targetHash = createHash("sha256").update(target).digest("hex");
    return connection.transaction(() => {
      const objects = connection.prepare("SELECT type,name,sql FROM sqlite_master WHERE substr(name,1,7)<>'sqlite_'").all() as Array<{ type: string; name: string; sql: string }>;
      if (objects.length === 0) {
        connection.exec(ddl);
        connection.prepare("INSERT INTO security_transaction_mutex VALUES (1,?)").run(targetHash);
      } else if (objects.length !== 1 || objects[0]?.type !== "table" || objects[0]?.name !== "security_transaction_mutex" || objects[0]?.sql !== ddl) {
        throw new SecurityCoordinationError();
      }
      const rows = connection.prepare("SELECT singleton,target_hash FROM security_transaction_mutex").all() as Array<{ singleton: number; target_hash: string }>;
      if (rows.length !== 1 || rows[0]?.singleton !== 1 || rows[0]?.target_hash !== targetHash) throw new SecurityCoordinationError();
      if (databasePathIdentity(target) !== registration.identity) throw new SecurityCoordinationError();
      const result = work();
      if (result !== null && (typeof result === "object" || typeof result === "function")
        && typeof (result as { then?: unknown }).then === "function") throw new SecurityCoordinationError();
      return result;
    }).immediate();
  } catch { throw new SecurityCoordinationError(); }
  finally {
    try { mutex?.close(); }
    catch { throw new SecurityCoordinationError(); }
    finally { if (owned) active.delete(owned); }
  }
}
