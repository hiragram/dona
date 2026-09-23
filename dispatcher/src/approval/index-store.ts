import type Database from "better-sqlite3";
import { z } from "zod";
import { assertSecurityDurability } from "../audit/durability.js";
import { verifyOpenDatabaseFile } from "../audit/file-identity.js";
import { assertSynchronousCallback, assertSynchronousResult, type SynchronousCallback } from "../audit/synchronous.js";
import { verifyApprovalIndexSchema } from "./schema.js";
import { decodeApprovalIndex } from "./index-codec.js";
import { MetadataConflictError } from "./metadata-tree.js";
import type { ApprovalRecordScope } from "./record-codec.js";

export class ApprovalIndexStoreError extends Error {
  constructor() { super("approval_index_store_unverified"); this.name = "ApprovalIndexStoreError"; }
}
export type ApprovalIndexBlob = { digest: string; wire: string };
export type ApprovalIndexBlobReader = (digest: string) => string | undefined;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const scopeSchema = z.strictObject({ instance_id: id, workspace_id: id });
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const blobSchema = z.strictObject({ digest: digestSchema, wire: z.string().max(2048) });
function guard<T>(operation: () => T): T { try { return operation(); } catch { throw new ApprovalIndexStoreError(); } }
function readBlob(db: Database.Database, digest: string, scope: ApprovalRecordScope): string | undefined {
  const row = db.prepare("SELECT CASE WHEN typeof(wire)='text' AND length(CAST(wire AS BLOB)) BETWEEN 1 AND 2048 THEN wire ELSE NULL END AS wire FROM main.approval_index_blobs WHERE digest=?")
    .get(digest) as { wire: string | null } | undefined;
  if (row === undefined) return undefined;
  if (row.wire === null) throw new ApprovalIndexStoreError();
  return decodeApprovalIndex(row.wire, digest, scope).wire;
}
/** 同じ監査transaction内で用いるimmutable blob保存層。現在の権限・rootを
 * 所有せず、独自transaction、migration、空rootによる修復を行わない。 */
export class ApprovalIndexBlobs {
  private readonly scope: ApprovalRecordScope;
  constructor(private readonly db: Database.Database, scope: ApprovalRecordScope) {
    this.scope = guard(() => {
      assertSynchronousResult(scope);
      if (db.inTransaction) throw new ApprovalIndexStoreError();
      assertSecurityDurability(db); verifyOpenDatabaseFile(db); verifyApprovalIndexSchema(db);
      return Object.freeze(scopeSchema.parse(scope));
    });
  }
  read<F extends (reader: ApprovalIndexBlobReader) => unknown>(operation: SynchronousCallback<F>): ReturnType<F>;
  read(operation: (reader: ApprovalIndexBlobReader) => unknown): unknown {
    guard(() => {
      assertSynchronousCallback(operation);
      if (!this.db.inTransaction) throw new ApprovalIndexStoreError();
      verifyOpenDatabaseFile(this.db); verifyApprovalIndexSchema(this.db);
    });
    let active = true;
    const reader: ApprovalIndexBlobReader = digest => guard(() => {
      if (!active || !this.db.inTransaction) throw new ApprovalIndexStoreError();
      return readBlob(this.db, digestSchema.parse(digest), this.scope);
    });
    try { const result = operation(reader); assertSynchronousResult(result); return result; }
    catch (error) {
      if (error instanceof MetadataConflictError) throw new MetadataConflictError();
      throw new ApprovalIndexStoreError();
    } finally {
      active = false;
      guard(() => verifyOpenDatabaseFile(this.db));
    }
  }
  stage(input: readonly ApprovalIndexBlob[]): undefined {
    return guard(() => {
      if (!this.db.inTransaction) throw new ApprovalIndexStoreError();
      verifyOpenDatabaseFile(this.db); verifyApprovalIndexSchema(this.db); assertSynchronousResult(input);
      if (!Array.isArray(input) || input.length < 1 || input.length > 32) throw new ApprovalIndexStoreError();
      const blobs = input.map(value => {
        const blob = blobSchema.parse(value); decodeApprovalIndex(blob.wire, blob.digest, this.scope); return blob;
      });
      if (new Set(blobs.map(blob => blob.digest)).size !== blobs.length) throw new ApprovalIndexStoreError();
      const insert = this.db.prepare("INSERT INTO main.approval_index_blobs(digest,wire) VALUES (?,?)");
      for (const blob of blobs) {
        const existing = readBlob(this.db, blob.digest, this.scope);
        if (existing === undefined) insert.run(blob.digest, blob.wire);
        else if (existing !== blob.wire) throw new ApprovalIndexStoreError();
      }
      for (const blob of blobs) if (readBlob(this.db, blob.digest, this.scope) !== blob.wire) throw new ApprovalIndexStoreError();
      verifyOpenDatabaseFile(this.db); return undefined;
    });
  }
}
