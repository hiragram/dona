import type Database from "better-sqlite3";
import { z } from "zod";
import type { AuditResourceCommitment, VerifiedAuditState } from "../audit/codec.js";
import { AuditRepository, assertCurrentAuditReadState } from "../audit/repository.js";
import { assertActiveClockMutation, verifyOpenDatabaseFile } from "../audit/file-identity.js";
import { assertSynchronousResult } from "../audit/synchronous.js";
import type { ApprovalTransactionProviders } from "./transaction.js";
import { parseClockMark, type ClockMark } from "./clock.js";
import { ApprovalMetadataNodes } from "./metadata-store.js";
import { prepareMetadataUpdate, readMetadataValue } from "./metadata-tree.js";
import { verifyApprovalExecutionMarkerSchema } from "./schema.js";
import { ApprovalRecordRepository } from "./record-repository.js";
import { encodeApprovalExecutionMarker, type SealedApprovalExecutionMarker } from "./execution-marker.js";
import { createHash } from "node:crypto";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const scopeSchema = z.strictObject({ instance_id: id, workspace_id: id });
type Scope = z.infer<typeof scopeSchema>;
export const approvalExecutionMarkerResource = "approval_execution_markers";
export class ApprovalExecutionMarkerStoreError extends Error {
  constructor() { super("approval_execution_marker_store_unverified"); this.name = "ApprovalExecutionMarkerStoreError"; }
}
function guard<T>(operation: () => T): T { try { return operation(); } catch { throw new ApprovalExecutionMarkerStoreError(); } }
function key(scope: Scope, attemptId: string): string {
  id.parse(attemptId);
  return "execution_" + createHash("sha256").update("dona.approval.execution-marker-key.v1\0")
    .update(JSON.stringify([scope.instance_id, scope.workspace_id, attemptId])).digest("hex");
}
/** 共有audit rootに結合したimmutable marker保存。実行認可・鍵検証・
 * retention承認・root admissionは行わない。実行fenceと同時commitする。 */
export class ApprovalExecutionMarkerStore {
  private readonly scope: Scope;
  private readonly audit: AuditRepository;
  private readonly records: ApprovalRecordRepository;
  private readonly nodes: ApprovalMetadataNodes;
  constructor(private readonly db: Database.Database, providers: ApprovalTransactionProviders, scope: Scope) {
    this.scope = guard(() => { assertSynchronousResult(scope); return Object.freeze(scopeSchema.parse(scope)); });
    this.audit = guard(() => new AuditRepository(db, providers.auditAnchors, providers.auditKeys));
    this.records = guard(() => new ApprovalRecordRepository(db, providers.auditAnchors, providers.auditKeys, this.scope));
    this.nodes = guard(() => { verifyApprovalExecutionMarkerSchema(db); return new ApprovalMetadataNodes(db); });
  }
  read(attemptId: string): SealedApprovalExecutionMarker | null {
    return guard(() => this.audit.readVerifiedState(state => this.readInState(state, attemptId)));
  }
  readInState(state: VerifiedAuditState, attemptId: string): SealedApprovalExecutionMarker | null {
    return guard(() => {
      assertCurrentAuditReadState(this.db, state);
      const selectedKey = key(this.scope, attemptId), root = this.root(state);
      const result = this.nodes.read(reader => {
        const expected = readMetadataValue({ ...this.scope, collection: "approval_execution_markers_v1" }, root, selectedKey, reader);
        const stored = this.sql(attemptId);
        if ((stored === null ? null : encodeApprovalExecutionMarker(stored).digest) !== expected) throw Error();
        return stored;
      });
      if (result !== null) {
        const marker = result.marker, attempt = this.records.readInState(state, "execution", attemptId);
        const request = this.records.readInState(state, "request", marker.request_id);
        if (attempt === null || request === null || attempt.row.state === "claimed" || attempt.row.fence < marker.execution_fence
          || attempt.row.request_id !== marker.request_id || attempt.row.consume_id !== marker.consume_id
          || request.row.semantic_hash !== marker.semantic_hash) throw Error();
      }
      assertCurrentAuditReadState(this.db, state); return result;
    });
  }
  /** 呼出元がMAC/実行認可を検証した後、claimed->executingのrecord mutation
   * と同じplanへ合成する。record mutationを先に実行しないとSQLが拒否する。 */
  prepare(markInput: Readonly<ClockMark>, state: VerifiedAuditState, input: SealedApprovalExecutionMarker) {
    return guard(() => {
      assertCurrentAuditReadState(this.db, state); assertSynchronousResult(markInput);
      const mark = parseClockMark(markInput), value = encodeApprovalExecutionMarker(input), marker = value.sealed.marker;
      if (marker.scope.instance_id !== this.scope.instance_id || marker.scope.workspace_id !== this.scope.workspace_id
        || marker.created_at !== mark.effective_utc || marker.clock_transaction_id !== mark.transaction_id) throw Error();
      const root = this.root(state), attempt = this.records.readInState(state, "execution", marker.attempt_id);
      const request = this.records.readInState(state, "request", marker.request_id);
      if (attempt === null || request === null || attempt.row.state !== "claimed" || marker.execution_fence !== attempt.row.fence + 1
        || attempt.row.request_id !== marker.request_id || attempt.row.consume_id !== marker.consume_id
        || request.row.semantic_hash !== marker.semantic_hash || request.row.state !== "consumed") throw Error();
      if (this.readInState(state, marker.attempt_id) !== null) throw Error();
      const treeScope = { ...this.scope, collection: "approval_execution_markers_v1" as const };
      const plan = this.nodes.read(reader => prepareMetadataUpdate(treeScope, root, value.key, null, value.digest, reader));
      const commitments: AuditResourceCommitment[] = [{ scope: { instance_id: this.scope.instance_id, tenant_id: this.scope.workspace_id },
        resource_id: approvalExecutionMarkerResource, resource_digest: plan.proposed_root }];
      Object.freeze(commitments[0]!.scope); Object.freeze(commitments[0]); Object.freeze(commitments);
      let used = false;
      return Object.freeze({ resource_commitments: commitments, mutation: () => guard(() => {
        if (used) throw Error(); used = true;
        assertActiveClockMutation(this.db, mark.transaction_id); verifyApprovalExecutionMarkerSchema(this.db); verifyOpenDatabaseFile(this.db);
        this.db.prepare("INSERT INTO main.approval_execution_markers(attempt_id,request_id,consume_id,marker_json,clock_transaction_id) VALUES(?,?,?,?,?)")
          .run(marker.attempt_id, marker.request_id, marker.consume_id, value.wire, mark.transaction_id);
        this.nodes.stage(plan.nodes);
        const stored = this.sql(marker.attempt_id);
        if (stored === null || encodeApprovalExecutionMarker(stored).wire !== value.wire) throw Error();
        this.nodes.read(reader => {
          if (readMetadataValue(treeScope, plan.proposed_root, value.key, reader) !== value.digest) throw Error(); return null;
        });
        verifyOpenDatabaseFile(this.db); return null;
      }) });
    });
  }
  private root(state: VerifiedAuditState): string {
    const roots = state.resource_bindings.filter(value => value.resource_id === approvalExecutionMarkerResource
      && value.scope.instance_id === this.scope.instance_id && value.scope.tenant_id === this.scope.workspace_id);
    if (roots.length !== 1) throw Error(); return roots[0]!.resource_digest;
  }
  private sql(attemptId: string): SealedApprovalExecutionMarker | null {
    if (!this.db.inTransaction) throw Error(); verifyOpenDatabaseFile(this.db); verifyApprovalExecutionMarkerSchema(this.db);
    const raw = this.db.prepare(`SELECT CASE WHEN typeof(marker_json)='text' AND length(CAST(marker_json AS BLOB)) BETWEEN 1 AND 2048
      AND typeof(request_id)='text' AND length(CAST(request_id AS BLOB)) BETWEEN 1 AND 128
      AND typeof(consume_id)='text' AND length(CAST(consume_id AS BLOB)) BETWEEN 1 AND 128
      AND typeof(clock_transaction_id)='text' AND length(CAST(clock_transaction_id AS BLOB)) BETWEEN 1 AND 128
      THEN json_object('wire',marker_json,'request_id',request_id,'consume_id',consume_id,'clock_transaction_id',clock_transaction_id)
      ELSE NULL END AS row_json FROM main.approval_execution_markers WHERE attempt_id=?`)
      .get(attemptId) as { row_json: string | null } | undefined;
    if (raw === undefined) return null; if (typeof raw.row_json !== "string" || Buffer.byteLength(raw.row_json) > 4096) throw Error();
    const row = JSON.parse(raw.row_json) as { wire: string; request_id: string; consume_id: string; clock_transaction_id: string };
    const value = encodeApprovalExecutionMarker(JSON.parse(row.wire)), marker = value.sealed.marker;
    if (value.wire !== row.wire || marker.attempt_id !== attemptId || marker.request_id !== row.request_id || marker.consume_id !== row.consume_id
      || marker.clock_transaction_id !== row.clock_transaction_id || marker.scope.instance_id !== this.scope.instance_id
      || marker.scope.workspace_id !== this.scope.workspace_id) throw Error();
    verifyOpenDatabaseFile(this.db); return value.sealed;
  }
}
