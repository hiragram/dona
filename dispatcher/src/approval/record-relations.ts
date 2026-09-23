import { approvalRecordKey, encodeApprovalRecord, type ApprovalRecord, type ApprovalRecordKind, type ApprovalRecordScope } from "./record-codec.js";
import { ApprovalMetadataPlan, ApprovalMetadataPlanError } from "./metadata-plan.js";
import { assertSynchronousCallback } from "../audit/synchronous.js";
type Of<K extends ApprovalRecordKind> = Extract<ApprovalRecord, { kind: K }>;
/** 内部のpoint/親参照検証。現在のaudit rootと同一transactionのSQL/overlay
 * readerだけを接続する。認可や状態遷移の判定を提供しない。 */
export function readApprovalRecordGraph<K extends ApprovalRecordKind>(scope: ApprovalRecordScope, plan: ApprovalMetadataPlan,
  reader: (kind: ApprovalRecordKind, primary: string) => ApprovalRecord | null, kind: K, primary: string): Of<K> | null {
  try {
    assertSynchronousCallback(reader);
    const cache = new Map<string, ApprovalRecord | null>(), queue: ApprovalRecord[] = [];
    const get = <T extends ApprovalRecordKind>(type: T, key: string, required = true): Of<T> | null => {
      const point = approvalRecordKey(scope, type, key);
      if (!cache.has(point)) {
        if (cache.size >= 32) throw Error();
        const digest = plan.readRecordDigest(type, key), record = reader(type, key);
        if ((record === null ? null : encodeApprovalRecord(record, scope).digest) !== digest) throw Error();
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
  } catch { plan.invalidate(); throw new ApprovalMetadataPlanError(); }
}
