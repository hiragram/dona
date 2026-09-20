import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import { assertSecurityDurability } from "../audit/durability.js";
import { verifyOpenDatabaseFile } from "../audit/file-identity.js";
import { assertSynchronousCallback, assertSynchronousResult, type SynchronousCallback } from "../audit/synchronous.js";
import { verifyApprovalMetadataSchema } from "./schema.js";
import type { MetadataTreeNode, MetadataTreeNodeReader } from "./metadata-tree.js";
import { MetadataConflictError } from "./metadata-tree.js";

export class MetadataStoreError extends Error {
  constructor() { super("approval_metadata_store_unverified"); this.name = "MetadataStoreError"; }
}
const digestSchema = z.string().length(64).regex(/^[a-f0-9]+$/);
const nodeSchema = z.strictObject({ digest: digestSchema, wire: z.string().max(176) });
function guard<T>(operation: () => T): T { try { return operation(); } catch { throw new MetadataStoreError(); } }
function node(input: unknown): MetadataTreeNode {
  assertSynchronousResult(input); const parsed = nodeSchema.parse(input), raw = Buffer.from(parsed.wire, "base64");
  if (![99, 131].includes(raw.length) || raw.toString("base64") !== parsed.wire) throw new MetadataStoreError();
  const depth = raw.readUInt16BE(33), prefix = raw.subarray(35, 67);
  if (raw.length === 99 ? raw[0] !== 0x4c || depth !== 256 : raw[0] !== 0x49 || depth >= 256) throw new MetadataStoreError();
  for (let bit = depth; bit < 256; bit++) if ((prefix[Math.floor(bit / 8)]! & (1 << (7 - bit % 8))) !== 0) throw new MetadataStoreError();
  if (raw.length === 131) {
    const emptyChild = (right: boolean) => {
      const header = Buffer.from(raw.subarray(0, 67)); header[0] = 0x45; header.writeUInt16BE(depth + 1, 33);
      if (right) header[35 + Math.floor(depth / 8)]! |= 1 << (7 - depth % 8);
      return createHash("sha256").update("dona.metadata-tree-node.v1\0").update(header).digest();
    };
    if (raw.subarray(67, 99).equals(emptyChild(false)) && raw.subarray(99, 131).equals(emptyChild(true))) throw new MetadataStoreError();
  }
  if (createHash("sha256").update("dona.metadata-tree-node.v1\0").update(raw).digest("hex") !== parsed.digest) throw new MetadataStoreError();
  return parsed;
}
function readNode(db: Database.Database, digest: string): string | undefined {
  const row = db.prepare("SELECT CASE WHEN typeof(wire)='text' AND length(CAST(wire AS BLOB)) IN (132,176) THEN wire ELSE NULL END AS wire FROM main.approval_metadata_nodes WHERE digest=?")
    .get(digest) as { wire: string | null } | undefined;
  if (row === undefined) return undefined;
  return node({ digest, wire: row.wire }).wire;
}

/** 既存ApprovalTransaction/AuditRepositoryが所有する同一connection用。
 * 自身でtransactionや監査rootを作らず、migrationも自動実行しない。
 * SQLite transactionだけを認証・認可の証明とみなしてはいけない。 */
export class ApprovalMetadataNodes {
  constructor(private readonly db: Database.Database) {
    guard(() => {
      if (db.inTransaction) throw new MetadataStoreError();
      assertSecurityDurability(db); verifyOpenDatabaseFile(db); verifyApprovalMetadataSchema(db);
    });
  }
  read<F extends (reader: MetadataTreeNodeReader) => unknown>(operation: SynchronousCallback<F>): ReturnType<F>;
  read(operation: (reader: MetadataTreeNodeReader) => unknown): unknown {
    guard(() => {
      assertSynchronousCallback(operation);
      if (!this.db.inTransaction) throw new MetadataStoreError();
      verifyOpenDatabaseFile(this.db); verifyApprovalMetadataSchema(this.db);
    });
    let active = true;
    const reader: MetadataTreeNodeReader = digest => guard(() => {
      if (!active || !this.db.inTransaction) throw new MetadataStoreError();
      return readNode(this.db, digestSchema.parse(digest));
    });
    try { const result = operation(reader); assertSynchronousResult(result); return result; }
    catch (error) {
      // 生node読取の障害はreader内で包む。codecの期待値競合だけを
      // repositoryへ伝え、callback由来の例外messageは引き継がない。
      if (error instanceof MetadataConflictError) throw new MetadataConflictError();
      throw new MetadataStoreError();
    } finally {
      active = false;
      // callbackの通常競合よりもfile identity喪失を優先して拒否する。
      guard(() => verifyOpenDatabaseFile(this.db));
    }
  }
  stage(input: readonly MetadataTreeNode[]): undefined {
    return guard(() => {
      if (!this.db.inTransaction) throw new MetadataStoreError();
      verifyOpenDatabaseFile(this.db);
      verifyApprovalMetadataSchema(this.db); assertSynchronousResult(input);
      if (!Array.isArray(input) || input.length < 1 || input.length > 257) throw new MetadataStoreError();
      const nodes = input.map(node);
      if (new Set(nodes.map(item => item.digest)).size !== nodes.length) throw new MetadataStoreError();
      const insert = this.db.prepare("INSERT INTO main.approval_metadata_nodes(digest,wire) VALUES (?,?)");
      for (const item of nodes) {
        const existing = readNode(this.db, item.digest);
        if (existing === undefined) insert.run(item.digest, item.wire);
        else if (existing !== item.wire) throw new MetadataStoreError();
      }
      for (const item of nodes) if (readNode(this.db, item.digest) !== item.wire) throw new MetadataStoreError();
      verifyOpenDatabaseFile(this.db);
      return undefined;
    });
  }
}
