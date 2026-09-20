import type Database from "better-sqlite3";
import { assertActiveClockMutation } from "../audit/file-identity.js";
import { z } from "zod";
import type { VerifiedAuditState, AuditResourceCommitment } from "../audit/codec.js";
import type { ClockMark } from "./clock.js";
import { assertSynchronousResult } from "../audit/synchronous.js";
import { ApprovalMetadataNodes } from "./metadata-store.js";
import { ApprovalIndexBlobs } from "./index-store.js";
import { ApprovalMetadataPlan } from "./metadata-plan.js";
import { ApprovalMetadataPlanWriter } from "./metadata-plan-store.js";
import { ApprovalRecordSql, type ApprovalRecordSqlChange } from "./record-sql.js";
import { readApprovalRecordGraph } from "./record-relations.js";
import { approvalRecordAliases, approvalRecordPrimary, approvalRecordActive } from "./record-indexes.js";
import { approvalRecordKey, encodeApprovalRecord, type ApprovalRecord, type ApprovalRecordScope } from "./record-codec.js";
import { approvalIndexKey, type ApprovalIndexIdentity } from "./index-codec.js";
import { appendApprovalList, removeActiveApprovalList, verifyApprovalListMembership } from "./index-list.js";
import { MetadataConflictError } from "./metadata-tree.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const scopeSchema = z.strictObject({ instance_id: id, workspace_id: id });
type Selector = Extract<ApprovalIndexIdentity, { kind: "alias" }>["selector"];
export class ApprovalRecordMutationError extends Error {
  constructor() { super("approval_record_mutation_unverified"); this.name = "ApprovalRecordMutationError"; }
}
function holdsMessage(record: ApprovalRecord | null): record is Extract<ApprovalRecord, { kind: "presentation" }> {
  return record?.kind === "presentation" && ["dispatching", "acceptance_unknown"].includes(record.row.state);
}
/** ApprovalTransaction.runPreparedの内部prepareへ接続する保存component。
 * event/actor/現在binding/TTL/payload lifecycleの判断はbrokerが先に行う。
 * verified stateの所持や本componentの呼出し自体は認可を与えない。 */
export class ApprovalRecordMutation {
  private readonly scope: ApprovalRecordScope;
  private readonly sql: ApprovalRecordSql;
  private readonly nodes: ApprovalMetadataNodes;
  private readonly indexes: ApprovalIndexBlobs;
  private readonly writer: ApprovalMetadataPlanWriter;
  constructor(private readonly db: Database.Database, scope: ApprovalRecordScope) {
    try {
      assertSynchronousResult(scope); this.scope = Object.freeze(scopeSchema.parse(scope));
      this.sql = new ApprovalRecordSql(db, this.scope); this.nodes = new ApprovalMetadataNodes(db);
      this.indexes = new ApprovalIndexBlobs(db, this.scope); this.writer = new ApprovalMetadataPlanWriter(db, this.scope);
    } catch { throw new ApprovalRecordMutationError(); }
  }
  prepare(mark: Readonly<ClockMark>, state: VerifiedAuditState, input: readonly ApprovalRecordSqlChange[]) {
    try {
      assertSynchronousResult(mark); assertSynchronousResult(state); assertSynchronousResult(input);
      const transactionId = id.parse(mark.transaction_id);
      if (!Array.isArray(input) || input.length < 1 || input.length > 16) throw Error();
      const bindings = state.resource_bindings.filter(value => value.resource_id === "approval_records"
        && value.scope.instance_id === this.scope.instance_id && value.scope.tenant_id === this.scope.workspace_id);
      if (bindings.length !== 1) throw Error();
      const changes = input.map(change => {
        if (Object.keys(change).sort().join(",") !== "next,previous") throw Error();
        return Object.freeze({ previous: change.previous === null ? null : encodeApprovalRecord(change.previous, this.scope).record,
          next: encodeApprovalRecord(change.next, this.scope).record });
      });
      for (const change of changes) if (change.previous === null) {
        const row = change.next.row;
        if ("clock_transaction_id" in row && row.clock_transaction_id !== transactionId) throw Error();
        for (const time of ["created_at", "decided_at", "claimed_at"] as const)
          if (time in row && (row as unknown as Record<string, unknown>)[time] !== mark.effective_utc) throw Error();
      }
      this.sql.validate(changes);
      const metadata = this.nodes.read(nodes => this.indexes.read(indexes => {
        const plan = new ApprovalMetadataPlan(this.scope, bindings[0]!.resource_digest, nodes, indexes);
        const overlay = new Map<string, ApprovalRecord>();
        for (const change of changes) {
          const primary = approvalRecordPrimary(change.next), next = encodeApprovalRecord(change.next, this.scope);
          const actual = readApprovalRecordGraph(this.scope, plan, (kind, key) => this.sql.read(kind, key), change.next.kind, primary);
          if ((actual === null ? null : encodeApprovalRecord(actual, this.scope).digest)
            !== (change.previous === null ? null : encodeApprovalRecord(change.previous, this.scope).digest)) throw new MetadataConflictError();
          this.verifyIndexes(plan, change.previous, change.next);
          overlay.set(next.key, change.next);
        }
        // message fenceを解放してから新規holderを登録し、入力順で競合させない。
        for (const change of changes) if (holdsMessage(change.previous) && !holdsMessage(change.next)) {
          this.putAlias(plan, { name: "presentation_active_message", message_ref: change.previous.row.message_ref }, approvalRecordPrimary(change.previous), null);
        }
        for (const change of changes) {
          this.applyIndexes(plan, change.previous, change.next);
          plan.putRecord(change.previous === null ? null : encodeApprovalRecord(change.previous, this.scope).digest, change.next);
        }
        for (const change of changes) {
          readApprovalRecordGraph(this.scope, plan, (kind, key) => overlay.get(approvalRecordKey(this.scope, kind, key))
            ?? this.sql.read(kind, key), change.next.kind, approvalRecordPrimary(change.next));
        }
        return plan.finish();
      }));
      const priorities = { request: 0, decision: 1, consume: 2, execution: 3, notification: 4, event: 5, presentation: 6 };
      const ordered = [...changes].sort((a, b) => priorities[a.next.kind] - priorities[b.next.kind]
        || Number(holdsMessage(b.previous) && !holdsMessage(b.next)) - Number(holdsMessage(a.previous) && !holdsMessage(a.next)));
      let used = false;
      const commitments: AuditResourceCommitment[] = [{ scope: { instance_id: this.scope.instance_id, tenant_id: this.scope.workspace_id }, resource_id: "approval_records", resource_digest: metadata.proposed_root }];
      Object.freeze(commitments[0]!.scope); Object.freeze(commitments[0]); Object.freeze(commitments);
      return Object.freeze({ resource_commitments: commitments, mutation: () => {
        if (used) throw new ApprovalRecordMutationError(); used = true;
        try {
          assertActiveClockMutation(this.db, transactionId);
          this.sql.stage(ordered); this.writer.stage(metadata); return null;
        }
        catch { throw new ApprovalRecordMutationError(); }
      } });
    } catch (error) {
      if (error instanceof MetadataConflictError) throw new MetadataConflictError();
      throw new ApprovalRecordMutationError();
    }
  }
  private alias(plan: ApprovalMetadataPlan, selector: Selector) {
    const value = plan.readIndex({ kind: "alias", selector });
    if (value !== null && value.kind !== "alias") throw Error(); return value;
  }
  private putAlias(plan: ApprovalMetadataPlan, selector: Selector, expected: string | null, target: string | null) {
    const prior = this.alias(plan, selector);
    if ((prior?.target ?? null) !== expected) {
      if (expected !== null) throw Error();
      throw new MetadataConflictError();
    }
    if (prior !== null && prior.target === target) return;
    plan.putIndex(prior, { codec_version: 1, scope: this.scope, kind: "alias", selector, target });
  }
  private verifyIndexes(plan: ApprovalMetadataPlan, previous: ApprovalRecord | null, next: ApprovalRecord) {
    const primary = approvalRecordPrimary(next);
    verifyApprovalListMembership(plan, { record_kind: next.kind, membership: "all" }, primary, previous !== null);
    if (!["decision", "consume"].includes(next.kind)) verifyApprovalListMembership(plan, { record_kind: next.kind, membership: "active" }, primary, previous !== null && approvalRecordActive(previous));
    const before = new Set(previous === null ? [] : approvalRecordAliases(previous).map(selector => approvalIndexKey(this.scope, { kind: "alias", selector })));
    for (const selector of approvalRecordAliases(next)) {
      const expected = before.has(approvalIndexKey(this.scope, { kind: "alias", selector })) ? primary : null;
      if ((this.alias(plan, selector)?.target ?? null) !== expected) {
        if (expected !== null) throw Error();
        throw new MetadataConflictError();
      }
    }
    if (holdsMessage(previous)) {
      if (this.alias(plan, { name: "presentation_active_message", message_ref: previous.row.message_ref })?.target !== primary) throw Error();
    }
  }
  private applyIndexes(plan: ApprovalMetadataPlan, previous: ApprovalRecord | null, next: ApprovalRecord) {
    const primary = approvalRecordPrimary(next);
    if (previous === null) appendApprovalList(plan, { record_kind: next.kind, membership: "all" }, primary);
    const beforeActive = previous !== null && approvalRecordActive(previous), afterActive = approvalRecordActive(next);
    if (beforeActive !== afterActive) {
      const list = { record_kind: next.kind, membership: "active" } as const;
      if (afterActive) appendApprovalList(plan, list, primary); else removeActiveApprovalList(plan, list, primary);
    }
    const before = new Set(previous === null ? [] : approvalRecordAliases(previous).map(selector => approvalIndexKey(this.scope, { kind: "alias", selector })));
    for (const selector of approvalRecordAliases(next)) this.putAlias(plan, selector, before.has(approvalIndexKey(this.scope, { kind: "alias", selector })) ? primary : null, primary);
    if (holdsMessage(next) && !holdsMessage(previous)) this.putAlias(plan, { name: "presentation_active_message", message_ref: next.row.message_ref }, null, primary);
  }
}
