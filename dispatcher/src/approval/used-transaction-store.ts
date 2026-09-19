import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { assertSynchronousResult } from "../audit/synchronous.js";
import { assertSecurityDurability } from "../audit/durability.js";
import { verifyOpenDatabaseFile } from "../audit/file-identity.js";
import { withSecurityTransactionLock } from "../audit/coordination.js";
import type { UsedTransactionNode } from "./used-transactions.js";

export interface ImmutableUsedTransactionNodes {
  read(digest: string): string | undefined;
  /** Must durably stage and read back all nodes before returning. */
  stage(nodes: readonly UsedTransactionNode[]): undefined;
}
export class UsedTransactionStoreError extends Error {
  constructor() { super("used_transaction_store_unverified"); this.name = "UsedTransactionStoreError"; }
}
const digestSchema = z.string().length(64).regex(/^[a-f0-9]+$/);
const nodeSchema = z.strictObject({ digest: digestSchema, wire: z.string().min(1).max(176) });
const statements = [
  "CREATE TABLE used_transaction_node_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version=1)) STRICT",
  "CREATE TABLE used_transaction_nodes (digest TEXT PRIMARY KEY NOT NULL CHECK(length(digest)=64 AND digest NOT GLOB '*[^a-f0-9]*'), wire TEXT NOT NULL CHECK(length(CAST(wire AS BLOB)) IN (92,176))) STRICT",
  "CREATE TRIGGER used_transaction_nodes_no_update BEFORE UPDATE ON used_transaction_nodes BEGIN SELECT RAISE(ABORT,'used_transaction_node_immutable'); END",
  "CREATE TRIGGER used_transaction_nodes_no_delete BEFORE DELETE ON used_transaction_nodes BEGIN SELECT RAISE(ABORT,'used_transaction_node_immutable'); END",
];
function guard<T>(operation: () => T): T { try { return operation(); } catch { throw new UsedTransactionStoreError(); } }
function objects(db: Database.Database): string[] {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE substr(name,1,7)<>'sqlite_' LIMIT 5").all() as Array<{ sql: string }>).map(row => row.sql).sort();
}
function verify(db: Database.Database): void {
  assertSecurityDurability(db); verifyOpenDatabaseFile(db);
  if (JSON.stringify(objects(db)) !== JSON.stringify([...statements].sort())) throw new UsedTransactionStoreError();
  const rows = db.prepare("SELECT singleton,version FROM used_transaction_node_schema LIMIT 2").all() as Array<{ singleton: number; version: number }>;
  if (rows.length !== 1 || rows[0]!.singleton !== 1 || rows[0]!.version !== 1) throw new UsedTransactionStoreError();
}
function node(input: unknown): UsedTransactionNode {
  assertSynchronousResult(input); const value = nodeSchema.parse(input), bytes = Buffer.from(value.wire, "base64");
  if (![67, 131].includes(bytes.length) || bytes.toString("base64") !== value.wire) throw new UsedTransactionStoreError();
  const depth = bytes.readUInt16BE(33), prefix = bytes.subarray(35, 67);
  if ((bytes.length === 67 ? bytes[0] !== 0x4c || depth !== 256 : bytes[0] !== 0x49 || depth >= 256)) throw new UsedTransactionStoreError();
  for (let bit = depth; bit < 256; bit++) if ((prefix[Math.floor(bit / 8)]! & (1 << (7 - bit % 8))) !== 0) throw new UsedTransactionStoreError();
  if (createHash("sha256").update("dona.used-transaction-node.v1\0").update(bytes).digest("hex") !== value.digest) throw new UsedTransactionStoreError();
  return value;
}
function readNode(db: Database.Database, digest: string): string | undefined {
  // Keep malformed oversized persisted values out of the JS process. Missing
  // and present-but-invalid remain distinct, including after hostile DB edits.
  const row = db.prepare("SELECT CASE WHEN typeof(wire)='text' AND length(CAST(wire AS BLOB)) IN (92,176) THEN wire ELSE NULL END AS wire FROM used_transaction_nodes WHERE digest=?")
    .get(digest) as { wire: string | null } | undefined;
  if (!row) return undefined;
  return node({ digest, wire: row.wire }).wire;
}

/** Explicit fixture/operator migration only. Runtime constructors never create
 * the file, schema, a protected head or an empty-root authority. */
export function installUsedTransactionNodeSchema(db: Database.Database): void {
  guard(() => withSecurityTransactionLock(db, () => db.transaction(() => {
    assertSecurityDurability(db); verifyOpenDatabaseFile(db);
    if (objects(db).length === 0) {
      for (const sql of statements) db.exec(sql);
      db.prepare("INSERT INTO used_transaction_node_schema VALUES (1,1)").run();
    }
    verify(db); return undefined;
  }).immediate()));
}

/** Dedicated auxiliary DB, not the business DB and never a root authority.
 * Immutable nodes may survive an unsuccessful reservation as harmless orphans.
 * No deletion, GC, automatic repair or reservation retry is implemented. */
export class SqliteUsedTransactionNodes implements ImmutableUsedTransactionNodes {
  constructor(private readonly db: Database.Database) { guard(() => { if (db.inTransaction) throw new UsedTransactionStoreError(); verify(db); }); }
  read(digestInput: string): string | undefined {
    return guard(() => {
      const digest = digestSchema.parse(digestInput);
      if (this.db.inTransaction) throw new UsedTransactionStoreError();
      return this.db.transaction(() => { verify(this.db); const result = readNode(this.db, digest); verifyOpenDatabaseFile(this.db); return result; }).deferred();
    });
  }
  stage(input: readonly UsedTransactionNode[]): undefined {
    return guard(() => {
      assertSynchronousResult(input);
      if (!Array.isArray(input) || input.length < 1 || input.length > 257) throw new UsedTransactionStoreError();
      const nodes = input.map(node);
      if (new Set(nodes.map(value => value.digest)).size !== nodes.length) throw new UsedTransactionStoreError();
      return withSecurityTransactionLock(this.db, () => this.db.transaction(() => {
        verify(this.db);
        const insert = this.db.prepare("INSERT INTO used_transaction_nodes(digest,wire) VALUES (?,?)");
        for (const value of nodes) {
          const existing = readNode(this.db, value.digest);
          if (existing === undefined) insert.run(value.digest, value.wire);
          else if (existing !== value.wire) throw new UsedTransactionStoreError();
        }
        for (const value of nodes) if (readNode(this.db, value.digest) !== value.wire) throw new UsedTransactionStoreError();
        verify(this.db); return undefined;
      }).immediate());
    });
  }
}
