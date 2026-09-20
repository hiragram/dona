import type Database from "better-sqlite3";
import { AuditRepository, type AuditAnchorStore } from "../audit/repository.js";
import type { AuditKeyLookup } from "../audit/codec.js";
import { ApprovalMetadataNodes } from "./metadata-store.js";
import { ApprovalIndexBlobs } from "./index-store.js";
import { ApprovalMetadataPlan } from "./metadata-plan.js";
import { ApprovalRecordSql } from "./record-sql.js";
import { approvalRecordKey, encodeApprovalRecord, type ApprovalRecord, type ApprovalRecordKind, type ApprovalRecordScope } from "./record-codec.js";
import { assertSynchronousResult } from "../audit/synchronous.js";
import { z } from "zod";
import { readApprovalRecordGraph } from "./record-relations.js";
import { approvalIndexKey, type ApprovalIndexIdentity, type ApprovalIndexList } from "./index-codec.js";
import { approvalRecordAliases, approvalRecordPrimary, approvalRecordActive } from "./record-indexes.js";
import { readApprovalListHead, verifyApprovalListMembership } from "./index-list.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const scopeSchema = z.strictObject({ instance_id: id, workspace_id: id });
export class ApprovalRecordRepositoryError extends Error {
  constructor() { super("approval_record_repository_unverified"); this.name = "ApprovalRecordRepositoryError"; }
}
type Of<K extends ApprovalRecordKind> = Extract<ApprovalRecord, { kind: K }>;
type Selector = Extract<ApprovalIndexIdentity, { kind: "alias" }>["selector"];
export interface ApprovalRecordListHead { readonly count: number; readonly records: readonly ApprovalRecord[]; readonly truncated: boolean }
const aliasKinds: Record<Selector["name"], ApprovalRecordKind> = {
  request_creation: "request", decision_id: "decision", consume_id: "consume", consume_decision: "consume", consume_attempt: "consume",
  execution_request: "execution", execution_consume: "execution", notification_request_kind: "notification", notification_message: "notification",
  event_decision: "event", presentation_revision: "presentation", presentation_active_message: "presentation",
};
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
      return this.withPlan(plan => this.record(plan, kind, primary));
    } catch { throw new ApprovalRecordRepositoryError(); }
  }
  /** 固定aliasを現在rootから解決する。aliasが指すrowだけでなく、その
   * selector、all/active membership、全固定aliasを同じ読取で照合する。 */
  readAlias(selector: Selector): ApprovalRecord | null {
    try {
      const selectedKey = approvalIndexKey(this.scope, { kind: "alias", selector });
      return this.withPlan(plan => {
        const index = plan.readIndex({ kind: "alias", selector });
        if (index === null) return null;
        if (index.kind !== "alias") throw Error();
        if (index.target === null) return null;
        const record = this.record(plan, aliasKinds[index.selector.name], index.target);
        if (record === null) throw Error();
        if (index.selector.name === "presentation_active_message") {
          if (record.kind !== "presentation" || record.row.message_ref !== index.selector.message_ref
            || !["dispatching", "acceptance_unknown"].includes(record.row.state)) throw Error();
        } else if (!approvalRecordAliases(record).some(value => approvalIndexKey(this.scope, { kind: "alias", selector: value }) === selectedKey)) throw Error();
        this.verifyIndexes(plan, record); return record;
      });
    } catch { throw new ApprovalRecordRepositoryError(); }
  }
  /** 内部一覧の先頭のみ、最大4件/3MiB。truncatedを全件取得やexpiry sweep
   * 完了に変換しない。cursor、並べ替え、caller root、認可は受け付けない。 */
  readListHead(list: ApprovalIndexList, limit: number) {
    try {
      approvalIndexKey(this.scope, { kind: "manifest", list }); z.number().int().min(1).max(4).parse(limit);
      return this.withPlan(plan => {
        const head = readApprovalListHead(plan, list, limit), records: ApprovalRecord[] = []; let bytes = 0;
        for (const primary of head.ids) {
          const record = this.record(plan, list.record_kind, primary);
          if (record === null || (list.membership === "active" && !approvalRecordActive(record))) throw Error();
          this.verifyIndexes(plan, record); bytes += Buffer.byteLength(encodeApprovalRecord(record, this.scope).canonical);
          if (bytes > 3 * 1024 * 1024) throw Error(); records.push(record);
        }
        return Object.freeze({ count: head.count, records: Object.freeze(records), truncated: head.truncated });
      });
    } catch { throw new ApprovalRecordRepositoryError(); }
  }
  private record(plan: ApprovalMetadataPlan, kind: ApprovalRecordKind, primary: string): ApprovalRecord | null {
    return readApprovalRecordGraph(this.scope, plan, (type, key) => this.sql.read(type, key), kind, primary);
  }
  private verifyIndexes(plan: ApprovalMetadataPlan, record: ApprovalRecord): void {
    const primary = approvalRecordPrimary(record);
    verifyApprovalListMembership(plan, { record_kind: record.kind, membership: "all" }, primary, true);
    if (!["decision", "consume"].includes(record.kind))
      verifyApprovalListMembership(plan, { record_kind: record.kind, membership: "active" }, primary, approvalRecordActive(record));
    for (const selector of approvalRecordAliases(record)) {
      const index = plan.readIndex({ kind: "alias", selector });
      if (index?.kind !== "alias" || index.target !== primary) throw Error();
    }
    if (record.kind === "presentation") {
      const index = plan.readIndex({ kind: "alias", selector: { name: "presentation_active_message", message_ref: record.row.message_ref } });
      if (index !== null && index.kind !== "alias") throw Error();
      const holds = ["dispatching", "acceptance_unknown"].includes(record.row.state);
      if ((index?.target === primary) !== holds) throw Error();
    }
  }
  private withPlan(read: (plan: ApprovalMetadataPlan) => ApprovalRecord | null): ApprovalRecord | null;
  private withPlan(read: (plan: ApprovalMetadataPlan) => ApprovalRecordListHead): ApprovalRecordListHead;
  private withPlan(read: (plan: ApprovalMetadataPlan) => ApprovalRecord | null | ApprovalRecordListHead): ApprovalRecord | null | ApprovalRecordListHead {
    return this.audit.readVerifiedState(state => {
      const bindings = state.resource_bindings.filter(value => value.resource_id === "approval_records"
        && value.scope.instance_id === this.scope.instance_id && value.scope.tenant_id === this.scope.workspace_id);
      if (bindings.length !== 1) throw Error();
      return this.nodes.read(nodes => this.indexes.read(indexes => read(new ApprovalMetadataPlan(this.scope, bindings[0]!.resource_digest, nodes, indexes))));
    });
  }
}
