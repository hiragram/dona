import type Database from "better-sqlite3";

// SQLite's application_id is a persistent database header field. Unlike a
// table name, it survives table rename/drop and records payload-store history.
// No application operation clears it. This is not a tamper-proof OS anchor.
const payloadDatabaseId = 0x444f4e50; // DONP
export function markDatabasePayloadHistory(db: Database.Database): void {
  if (!db.inTransaction) throw new Error("payload_backup_boundary_unverified");
  const existing = db.pragma("main.application_id", { simple: true });
  if (existing !== 0 && existing !== payloadDatabaseId) throw new Error("payload_backup_boundary_unverified");
  if (existing === 0) db.pragma(`main.application_id = ${payloadDatabaseId}`);
  verifyDatabasePayloadHistory(db);
}
export function verifyDatabasePayloadHistory(db: Database.Database): void {
  if (db.pragma("main.application_id", { simple: true }) !== payloadDatabaseId) {
    throw new Error("payload_backup_boundary_unverified");
  }
}
