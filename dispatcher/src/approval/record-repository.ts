import type Database from "better-sqlite3";
import { AuditRepository, type AuditAnchorStore } from "../audit/repository.js";
import type { AuditKeyLookup } from "../audit/codec.js";
import { ApprovalMetadataNodes } from "./metadata-store.js";
import { ApprovalIndexBlobs } from "./index-store.js";
import { ApprovalMetadataPlan } from "./metadata-plan.js";
import { ApprovalRecordSql } from "./record-sql.js";
import { approvalRecordKey, type ApprovalRecord, type ApprovalRecordKind, type ApprovalRecordScope } from "./record-codec.js";
import { assertSynchronousResult } from "../audit/synchronous.js";
import { z } from "zod";
import { readApprovalRecordGraph } from "./record-relations.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const scopeSchema = z.strictObject({ instance_id: id, workspace_id: id });
export class ApprovalRecordRepositoryError extends Error {
  constructor() { super("approval_record_repository_unverified"); this.name = "ApprovalRecordRepositoryError"; }
}
type Of<K extends ApprovalRecordKind> = Extract<ApprovalRecord, { kind: K }>;
/** 永続recordの現在rootと親参照を検証する内部読取component。
 * actor/binding/visibilityの現在の認可や操作可能性判定は提供しない。 */
export class ApprovalRecordRepository {
  private readonly audit: AuditRepository;
  private readonly sql: ApprovalRecordSql;
  private readonly nodes: ApprovalMetadataNodes;
  private readonly indexes: ApprovalIndexBlobs;
  private readonly scope: ApprovalRecordScope;
  constructor(db: Database.Database, anchors: AuditAnchorStore, keys: AuditKeyLookup, scope: ApprovalRecordScope) {
    try {
      assertSynchronousResult(scope); this.scope = Object.freeze(scopeSchema.parse(scope));
      this.audit = new AuditRepository(db, anchors, keys); this.sql = new ApprovalRecordSql(db, this.scope);
      this.nodes = new ApprovalMetadataNodes(db); this.indexes = new ApprovalIndexBlobs(db, this.scope);
    } catch { throw new ApprovalRecordRepositoryError(); }
  }
  read<K extends ApprovalRecordKind>(kind: K, primary: string): Of<K> | null;
  read(kind: ApprovalRecordKind, primary: string): ApprovalRecord | null {
    try {
      // kind/primaryはcodecで検証し、任意rootを引数として受け取らない。
      approvalRecordKey(this.scope, kind, primary);
      return this.audit.readVerifiedState(state => {
        const bindings = state.resource_bindings.filter(value => value.resource_id === "approval_records"
          && value.scope.instance_id === this.scope.instance_id && value.scope.tenant_id === this.scope.workspace_id);
        if (bindings.length !== 1) throw Error();
        return this.nodes.read(nodes => this.indexes.read(indexes => {
          const plan = new ApprovalMetadataPlan(this.scope, bindings[0]!.resource_digest, nodes, indexes);
          return readApprovalRecordGraph(this.scope, plan, (type, key) => this.sql.read(type, key), kind, primary);
        }));
      });
    } catch { throw new ApprovalRecordRepositoryError(); }
  }
}
