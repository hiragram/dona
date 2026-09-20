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
          return this.readRelated(plan, kind, primary);
        }));
      });
    } catch { throw new ApprovalRecordRepositoryError(); }
  }
  private readRelated<K extends ApprovalRecordKind>(plan: ApprovalMetadataPlan, kind: K, primary: string): Of<K> | null {
    const cache = new Map<string, ApprovalRecord | null>(), queue: ApprovalRecord[] = [];
    const get = <T extends ApprovalRecordKind>(type: T, key: string, required = true): Of<T> | null => {
      const point = approvalRecordKey(this.scope, type, key);
      if (!cache.has(point)) {
        if (cache.size >= 32) throw Error();
        const digest = plan.readRecordDigest(type, key), record = this.sql.read(type, key);
        if ((record === null ? null : encodeApprovalRecord(record, this.scope).digest) !== digest) throw Error();
        cache.set(point, record); if (record !== null) queue.push(record);
      }
      const record = cache.get(point)!;
      if (required && record === null) throw Error();
      return record as Of<T> | null;
    };
    const result = get(kind, primary, false);
    // cacheに入れてから親を辿り、consume/attemptの循環参照を有限に検証する。
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const record = queue[cursor]!;
      switch (record.kind) {
        case "request": break;
        case "decision": {
          const row = record.row, request = get("request", row.request_id)!.row;
          if (row.semantic_hash !== request.semantic_hash || row.binding_id !== request.binding_id
            || row.binding_revision !== request.binding_revision || row.instance_id !== request.instance_id
            || row.workspace_id !== request.workspace_id || row.decided_at < request.created_at) throw Error();
          break;
        }
        case "consume": {
          const row = record.row, request = get("request", row.request_id)!.row;
          const decision = get("decision", row.request_id)!.row, execution = get("execution", row.attempt_id)!.row;
          if (decision.decision_id !== row.decision_id || decision.kind !== "approve" || request.consume_expires_at === null
            || row.claimed_at < decision.decided_at || row.claimed_at >= request.consume_expires_at
            || execution.request_id !== row.request_id || execution.consume_id !== row.consume_id || execution.claimed_at !== row.claimed_at) throw Error();
          break;
        }
        case "execution": {
          const row = record.row, consume = get("consume", row.request_id)!.row;
          if (consume.attempt_id !== row.attempt_id || consume.consume_id !== row.consume_id || consume.claimed_at !== row.claimed_at) throw Error();
          break;
        }
        case "notification": {
          const row = record.row, request = get("request", row.request_id)!.row;
          if (row.request_revision > request.revision) throw Error();
          break;
        }
        case "event": {
          const row = record.row, alias = plan.readIndex({ kind: "alias", selector: { name: "decision_id", decision_id: row.decision_id } });
          if (alias === null || alias.kind !== "alias" || alias.target === null) throw Error();
          if (get("decision", alias.target)!.row.decision_id !== row.decision_id) throw Error();
          break;
        }
        case "presentation": {
          const row = record.row, notification = get("notification", row.notification_attempt_id)!.row;
          if (notification.state !== "sent" || notification.message_ref !== row.message_ref || row.desired_revision < notification.presentation_revision) throw Error();
          break;
        }
      }
    }
    return result;
  }
}
