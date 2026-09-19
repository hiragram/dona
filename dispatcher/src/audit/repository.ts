import Database from "better-sqlite3";
import { assertSecurityDurability } from "./durability.js";
import { loadSecurityExtension, withMutationSqlGuard } from "./file-identity.js";
import { verifyApprovalSchema } from "../approval/schema.js";
import { assertSynchronousCallback, assertSynchronousResult, type SynchronousCallback } from "./synchronous.js";
import {
  AuditIntegrityError, auditAnchorSchema, signAuditRecord, signAuditCheckpoint, verifyAuditChain,
  type AuditAnchor, type AuditCheckpoint, type AuditEvent, type AuditKeyLookup, type AuditRecord,
} from "./codec.js";

/** Protected, rollback-resistant store outside the Dispatcher DB and its backups.
 * Implementations must return fresh integrity-verified values, compare every field
 * atomically, durably reserve before returning, and never silently retry writes.
 * Transaction IDs are one-shot: retain a reservation ledger and reject reused IDs.
 * A missing/unknown/pending anchor is not an initialized empty chain.
 */
export interface AuditAnchorStore {
  read(): AuditAnchor;
  reserve(expected: AuditAnchor, proposed: AuditAnchor): AuditAnchor;
  finalize(reservation: AuditAnchor): AuditAnchor;
}

const schemaVersion = 1;
function guard<T>(operation: () => T): T {
  try { return operation(); } catch { throw new AuditIntegrityError(); }
}
function equal(left: AuditAnchor, right: AuditAnchor): boolean {
  return (Object.keys(left) as Array<keyof AuditAnchor>).every((key) => left[key] === right[key]);
}
function requireEqual(left: AuditAnchor, right: AuditAnchor): void {
  if (!equal(auditAnchorSchema.parse(left), auditAnchorSchema.parse(right))) throw new AuditIntegrityError();
}

const schemaSql = `
        CREATE TABLE security_audit_schema (version INTEGER PRIMARY KEY CHECK (version = 1));
        INSERT INTO security_audit_schema VALUES (1);
        CREATE TABLE security_audit_checkpoint (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          transaction_id TEXT,
          checkpoint_json TEXT NOT NULL CHECK (length(checkpoint_json) <= 4096)
        );
        CREATE TABLE security_audit_records (
          sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
          transaction_id TEXT NOT NULL UNIQUE,
          record_json TEXT NOT NULL CHECK (length(record_json) <= 8192)
        );
        CREATE TRIGGER security_audit_no_update BEFORE UPDATE ON security_audit_records
          BEGIN SELECT RAISE(ABORT, 'security_audit_append_only'); END;
`;
const shapeQuery = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE substr(lower(name),1,15)='security_audit_' OR substr(lower(tbl_name),1,15)='security_audit_' ORDER BY type,name";
function shape(db: Database.Database): string { return JSON.stringify(db.prepare(shapeQuery).all()); }
let expectedShape: string | undefined;
export function verifyAuditSchema(db: Database.Database): void {
  guard(() => {
    if (expectedShape === undefined) {
      const expected = new Database(":memory:");
      try { expected.exec(schemaSql); expectedShape = shape(expected); } finally { expected.close(); }
    }
    if (shape(db) !== expectedShape || db.prepare("SELECT 1 FROM sqlite_temp_master WHERE substr(lower(name),1,15)='security_audit_' OR substr(lower(tbl_name),1,15)='security_audit_'").get()) throw new AuditIntegrityError();
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND substr(lower(name),1,15)!='security_audit_' AND substr(lower(name),1,9)!='approval_'").get()
      || db.prepare("SELECT 1 FROM sqlite_temp_master WHERE type='trigger'").get()) throw new AuditIntegrityError();
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE substr(lower(name),1,9)='approval_' OR substr(lower(tbl_name),1,9)='approval_'").get()) verifyApprovalSchema(db);
    const rows = db.prepare("SELECT version FROM security_audit_schema").all() as Array<{ version: number }>;
    if (rows.length !== 1 || rows[0]?.version !== schemaVersion) throw new AuditIntegrityError();
  });
}

/** Opt-in schema only; callers must introduce Dispatcher compatibility/migration
 * and protected-store provisioning before connecting this to the runtime. */
export function installAuditSchema(db: Database.Database): void {
  guard(() => {
    if (db.inTransaction) throw new AuditIntegrityError();
    db.transaction(() => {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='security_audit_schema'").get();
      if (exists) { verifyAuditSchema(db); return; }
      if (db.prepare(shapeQuery).get() || db.prepare("SELECT 1 FROM sqlite_temp_master WHERE substr(lower(name),1,15)='security_audit_' OR substr(lower(tbl_name),1,15)='security_audit_'").get()) throw new AuditIntegrityError();
      db.exec(schemaSql);
      verifyAuditSchema(db);
    }).immediate();
  });
}

export class AuditRepository {
  constructor(private readonly db: Database.Database, private readonly store: AuditAnchorStore, private readonly keys: AuditKeyLookup) {}

  private checkpoint(): unknown {
    const row = this.db.prepare("SELECT checkpoint_json FROM security_audit_checkpoint WHERE singleton=1").get() as { checkpoint_json: string } | undefined;
    if (!row) throw new AuditIntegrityError();
    return JSON.parse(row.checkpoint_json);
  }
  private *records(): Iterable<unknown> {
    const checkpoint = this.checkpoint() as AuditCheckpoint;
    for (const row of this.db.prepare("SELECT sequence, transaction_id, record_json FROM security_audit_records WHERE sequence > ? ORDER BY sequence").iterate(checkpoint.sequence) as Iterable<{ sequence: number; transaction_id: string; record_json: string }>) {
      const record = JSON.parse(row.record_json) as AuditRecord;
      if (record.sequence !== row.sequence || record.transaction_id !== row.transaction_id) throw new AuditIntegrityError();
      yield record;
    }
  }
  private assertSchema(): void { verifyAuditSchema(this.db); }
  private verifyInside(): AuditAnchor {
    this.assertSchema();
    const before = auditAnchorSchema.parse(this.store.read());
    const verified = verifyAuditChain(this.checkpoint(), this.records(), before, this.keys);
    requireEqual(verified, this.store.read());
    return verified;
  }

  /** Only installs an already provisioned, externally anchored genesis. No key or
   * trust-root creation, reset, repair, or automatic restore occurs here. */
  initialize(checkpoint: AuditCheckpoint): void {
    guard(() => {
      assertSecurityDurability(this.db);
      if (this.db.inTransaction) throw new AuditIntegrityError();
      this.db.transaction(() => {
        this.assertSchema();
        if (this.db.prepare("SELECT 1 FROM security_audit_checkpoint").get()
          || this.db.prepare("SELECT 1 FROM security_audit_records").get()
          || checkpoint.sequence !== 0) throw new AuditIntegrityError();
        const anchor = auditAnchorSchema.parse(this.store.read());
        verifyAuditChain(checkpoint, [], anchor, this.keys);
        this.db.prepare("INSERT INTO security_audit_checkpoint VALUES (1, NULL, ?)").run(JSON.stringify(checkpoint));
        requireEqual(anchor, this.store.read());
      }).immediate();
    });
  }

  verify(): AuditAnchor {
    return guard(() => {
      if (this.db.inTransaction) throw new AuditIntegrityError();
      return this.db.transaction(() => this.verifyInside())();
    });
  }

  /** mutation must perform synchronous SQL on this same DB connection only.
   * It must not commit, issue external writes, or return deferred work. The returned
   * value is released only after durable finalize and a complete verified reread. */
  append<F extends () => unknown>(transactionId: string, keyVersion: number, event: AuditEvent, mutation: SynchronousCallback<F>): { record: AuditRecord; result: ReturnType<F> };
  append(transactionId: string, keyVersion: number, event: AuditEvent, mutation: () => unknown): { record: AuditRecord; result: unknown } {
    return guard(() => {
      assertSecurityDurability(this.db);
      assertSynchronousCallback(mutation);
      if (this.db.inTransaction) throw new AuditIntegrityError();
      loadSecurityExtension(this.db);
      let reservation: AuditAnchor | undefined;
      const committed = this.db.transaction(() => {
        const current = this.verifyInside();
        if (this.db.prepare("SELECT 1 FROM security_audit_records WHERE transaction_id=?").get(transactionId)) throw new AuditIntegrityError();
        const record = signAuditRecord({ codec_version: 1, chain_id: current.chain_id,
          sequence: current.sequence + 1, transaction_id: transactionId, previous_mac: current.mac,
          key_version: keyVersion, event }, this.keys);
        // Verify ordering, key state and record input before the first external write.
        const existing = this.records();
        const extended = function* () { yield* existing; yield record; };
        verifyAuditChain(this.checkpoint(), extended(), {
          ...current, sequence: record.sequence, mac: record.mac,
        }, this.keys);
        const proposed: AuditAnchor = { ...current, sequence: record.sequence, mac: record.mac,
          pending_transaction_id: transactionId };
        reservation = auditAnchorSchema.parse(this.store.reserve(current, proposed));
        requireEqual(reservation, proposed);
        requireEqual(reservation, this.store.read());
        this.db.prepare("INSERT INTO security_audit_records VALUES (?, ?, ?)")
          .run(record.sequence, transactionId, JSON.stringify(record));
        const result = withMutationSqlGuard(this.db, mutation);
        assertSecurityDurability(this.db);
        assertSynchronousResult(result);
        // A callback may not modify the audit rows/checkpoint or transaction state.
        if (!this.db.inTransaction) throw new AuditIntegrityError();
        this.assertSchema();
        const expected = { ...proposed, pending_transaction_id: null };
        verifyAuditChain(this.checkpoint(), this.records(), expected, this.keys);
        requireEqual(reservation, this.store.read());
        return { record, result };
      }).immediate();
      if (!reservation) throw new AuditIntegrityError();
      const expected = { ...reservation, pending_transaction_id: null };
      // The first transaction is already durable. Reacquire the writer lock
      // while the anchor is still pending, then serialize finalize + read-back.
      // Otherwise a peer can append between finalize and verification and make
      // this successfully committed operation look like an integrity failure.
      const reserved = reservation;
      return this.db.transaction(() => {
        requireEqual(this.store.finalize(reserved), expected);
        requireEqual(this.verifyInside(), expected);
        return committed;
      }).immediate();
    });
  }

  /** effectiveNow must come from the protected rollback-resistant clock. Retention
   * keeps at least 400 days and does not retire verification keys or backups. */
  retain(transactionId: string, keyVersion: number, throughSequence: number, effectiveNow: string): void {
    guard(() => {
      assertSecurityDurability(this.db);
      if (this.db.inTransaction || !Number.isSafeInteger(throughSequence) || throughSequence < 1) throw new AuditIntegrityError();
      const now = Date.parse(effectiveNow);
      if (!Number.isFinite(now) || new Date(now).toISOString() !== effectiveNow) throw new AuditIntegrityError();
      let reservation: AuditAnchor | undefined;
      this.db.transaction(() => {
        const current = this.verifyInside();
        const prior = this.checkpoint() as AuditCheckpoint;
        if (throughSequence <= prior.sequence || throughSequence > current.sequence) throw new AuditIntegrityError();
        const row = this.db.prepare("SELECT record_json FROM security_audit_records WHERE sequence=?").get(throughSequence) as { record_json: string } | undefined;
        if (!row) throw new AuditIntegrityError();
        const record = JSON.parse(row.record_json) as AuditRecord;
        if (Date.parse(record.event.occurred_at) > now - 400 * 24 * 60 * 60 * 1000) throw new AuditIntegrityError();
        const checkpoint = signAuditCheckpoint({ codec_version: 1, chain_id: current.chain_id,
          transaction_id: transactionId, signed_at: effectiveNow, key_version: keyVersion }, this.keys, record);
        const proposed = auditAnchorSchema.parse({ ...current, checkpoint_mac: checkpoint.mac, pending_transaction_id: transactionId });
        // An empty/invalid transaction ID must never act as a finalized proposal.
        if (proposed.pending_transaction_id === null) throw new AuditIntegrityError();
        reservation = auditAnchorSchema.parse(this.store.reserve(current, proposed));
        requireEqual(reservation, proposed);
        requireEqual(reservation, this.store.read());
        this.db.prepare("UPDATE security_audit_checkpoint SET transaction_id=?, checkpoint_json=? WHERE singleton=1").run(transactionId, JSON.stringify(checkpoint));
      }).immediate();
      if (!reservation) throw new AuditIntegrityError();
      const expected = { ...reservation, pending_transaction_id: null };
      const reserved = reservation;
      // Serialize finalize + read-back + deletion against other writers. A crash
      // before deletion leaves an authenticated prefix for explicit cleanup.
      this.db.transaction(() => {
        requireEqual(this.store.finalize(reserved), expected);
        requireEqual(this.verifyInside(), expected);
        this.db.prepare("DELETE FROM security_audit_records WHERE sequence<=?").run(throughSequence);
        requireEqual(this.verifyInside(), expected);
      }).immediate();
    });
  }

  /** Explicit cleanup after a finalized retention whose deletion was interrupted.
   * This never finalizes or retries an ambiguous external write. */
  pruneRetainedPrefix(): void {
    guard(() => {
      assertSecurityDurability(this.db);
      if (this.db.inTransaction) throw new AuditIntegrityError();
      this.db.transaction(() => {
        const anchor = this.verifyInside();
        const checkpoint = this.checkpoint() as AuditCheckpoint;
        this.db.prepare("DELETE FROM security_audit_records WHERE sequence<=?").run(checkpoint.sequence);
        requireEqual(this.verifyInside(), anchor);
      }).immediate();
    });
  }

}
