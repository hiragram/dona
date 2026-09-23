import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import { assertSynchronousResult } from "../audit/synchronous.js";
import { assertCurrentAuditReadState } from "../audit/repository.js";
import { assertActiveClockMutation, verifyOpenDatabaseFile } from "../audit/file-identity.js";
import type { AuditResourceCommitment, VerifiedAuditState } from "../audit/codec.js";
import { parseClockMark, type ClockMark } from "./clock.js";
import { ApprovalMetadataNodes } from "./metadata-store.js";
import { prepareMetadataUpdate, readMetadataValue } from "./metadata-tree.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const scopeSchema = z.strictObject({ instance_id: id, workspace_id: id });
type Scope = z.infer<typeof scopeSchema>;
export const approvalClockHistoryResource = "approval_clock_marks";
export class ApprovalClockHistoryError extends Error {
  constructor() { super("approval_clock_history_unverified"); this.name = "ApprovalClockHistoryError"; }
}
function guard<T>(operation: () => T): T { try { return operation(); } catch { throw new ApprovalClockHistoryError(); } }
function encode(scope: Scope, input: unknown) {
  assertSynchronousResult(input);
  const mark = Object.freeze(parseClockMark(input)), canonical = JSON.stringify(mark);
  if (Buffer.byteLength(canonical) > 1024) throw Error();
  const binding = JSON.stringify([scope.instance_id, scope.workspace_id]);
  return { mark, canonical, digest: createHash("sha256").update("dona.approval.clock-history.v1\0").update(binding).update("\0").update(canonical).digest("hex") };
}
function key(scope: Scope, transactionId: string): string {
  id.parse(transactionId);
  return "clock_" + createHash("sha256").update("dona.approval.clock-history-key.v1\0")
    .update(JSON.stringify([scope.instance_id, scope.workspace_id, transactionId])).digest("hex");
}
/** 過去markを共有監査rootと照合する内部component。providerのcurrent mark、
 * actor認可、rootのoperator admissionを代行せず、欠落rootを生成しない。 */
export class ApprovalClockHistory {
  private readonly scope: Scope;
  private readonly nodes: ApprovalMetadataNodes;
  constructor(private readonly db: Database.Database, scope: Scope) {
    this.scope = guard(() => { assertSynchronousResult(scope); return Object.freeze(scopeSchema.parse(scope)); });
    this.nodes = guard(() => new ApprovalMetadataNodes(db));
  }
  readInState(state: VerifiedAuditState, transactionId: string): Readonly<ClockMark> | null {
    return guard(() => {
      assertCurrentAuditReadState(this.db, state);
      const selectedKey = key(this.scope, transactionId), root = this.root(state);
      const result = this.nodes.read(reader => {
        const digest = readMetadataValue({ ...this.scope, collection: "approval_clock_marks_v1" }, root, selectedKey, reader);
        const stored = this.sql(transactionId);
        if ((stored === null ? null : encode(this.scope, stored).digest) !== digest) throw Error();
        return stored;
      });
      assertCurrentAuditReadState(this.db, state); return result;
    });
  }
  /** runPreparedが生成した現在markを一件だけ予約計画へ追加する。 */
  prepare(markInput: Readonly<ClockMark>, state: VerifiedAuditState) {
    return guard(() => {
      assertCurrentAuditReadState(this.db, state);
      const value = encode(this.scope, markInput), root = this.root(state), selectedKey = key(this.scope, value.mark.transaction_id);
      if (this.sql(value.mark.transaction_id) !== null) throw Error();
      const plan = this.nodes.read(reader => prepareMetadataUpdate({ ...this.scope, collection: "approval_clock_marks_v1" },
        root, selectedKey, null, value.digest, reader));
      const commitments: AuditResourceCommitment[] = [{ scope: { instance_id: this.scope.instance_id, tenant_id: this.scope.workspace_id },
        resource_id: approvalClockHistoryResource, resource_digest: plan.proposed_root }];
      Object.freeze(commitments[0]!.scope); Object.freeze(commitments[0]); Object.freeze(commitments);
      let used = false;
      return Object.freeze({ resource_commitments: commitments, mutation: () => guard(() => {
        if (used) throw Error(); used = true;
        assertActiveClockMutation(this.db, value.mark.transaction_id);
        const stored = this.sql(value.mark.transaction_id);
        if (stored === null || encode(this.scope, stored).canonical !== value.canonical) throw Error();
        this.nodes.stage(plan.nodes);
        this.nodes.read(reader => {
          if (readMetadataValue({ ...this.scope, collection: "approval_clock_marks_v1" }, plan.proposed_root, selectedKey, reader) !== value.digest) throw Error();
          return null;
        });
        return null;
      }) });
    });
  }
  private root(state: VerifiedAuditState): string {
    const roots = state.resource_bindings.filter(binding => binding.resource_id === approvalClockHistoryResource
      && binding.scope.instance_id === this.scope.instance_id && binding.scope.tenant_id === this.scope.workspace_id);
    if (roots.length !== 1) throw Error(); return roots[0]!.resource_digest;
  }
  private sql(transactionId: string): Readonly<ClockMark> | null {
    if (!this.db.inTransaction) throw Error();
    verifyOpenDatabaseFile(this.db);
    const row = this.db.prepare("SELECT CASE WHEN typeof(mark_json)='text' AND length(CAST(mark_json AS BLOB)) BETWEEN 1 AND 1024 THEN mark_json ELSE NULL END AS wire FROM main.approval_clock_reservations WHERE transaction_id=?")
      .get(transactionId) as { wire: string | null } | undefined;
    if (row === undefined) return null;
    if (typeof row.wire !== "string") throw Error();
    const value = encode(this.scope, JSON.parse(row.wire));
    if (value.canonical !== row.wire || value.mark.transaction_id !== transactionId) throw Error();
    verifyOpenDatabaseFile(this.db); return value.mark;
  }
}
