import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionFixture } from "./fixtures/decision.js";
import { fixtureConsumeAuthority } from "./fixtures/consume-authority.js";
import { scope, content, wrapping, notification } from "./fixtures/broker.js";
import { ApprovalConsumeBroker } from "../../src/approval/consume-broker.js";
import { installApprovalSchema, installApprovalExecutionMarkerSchema } from "../../src/approval/schema.js";
import { ApprovalExecutionMarkerStore, ApprovalExecutionMarkerStoreError } from "../../src/approval/execution-marker-store.js";
import { signApprovalExecutionMarker, verifyApprovalExecutionMarker, type ApprovalExecutionMarkerKey } from "../../src/approval/execution-marker.js";
import { ApprovalHistoryTransaction } from "../../src/approval/history-transaction.js";
import { ApprovalRecordMutation } from "../../src/approval/record-mutation.js";
import { ApprovalRecordRepository } from "../../src/approval/record-repository.js";
import { emptyMetadataRoot } from "../../src/approval/metadata-tree.js";
import { openSecurityDatabase } from "../../src/audit/coordination.js";
import type { AuditEvent, VerifiedAuditState } from "../../src/audit/codec.js";
const key: ApprovalExecutionMarkerKey = { purpose: "approval_execution_marker", version: 1, state: "active", activated_at: "2026-09-01T00:00:00.000Z",
  signing_expires_at: "2026-11-01T00:00:00.000Z", secret: Buffer.alloc(32, 94) };
const event: Omit<AuditEvent, "occurred_at"> = { scope: { instance_id: scope.instance_id, tenant_id: scope.workspace_id },
  actor: { kind: "system", id: "fixture" }, action: "approval_consume", operation: "slack.post_thread_reply.v1", resource_id: "fixture_execution",
  outcome: "succeeded", reason: "none", session_ref: null, receipt_id: null, attempt_id: null, policy_revision: 1, binding_revision: 1, authz_revision: 1 };
function setup(t: { after(fn: () => void): void }, admitted = true) {
  const f = decisionFixture(t); f.decision.decide("approve", f.command("approve"));
  const consume = new ApprovalConsumeBroker(f.db, f.providers, scope, fixtureConsumeAuthority(f.records), () => content, () => wrapping, () => notification);
  const claim = consume.consume("consume", { request_handle: f.requestId, authority_ref: "fixture_consumer_connection", expected_revision: 3 });
  if (claim.status !== "claimed") throw Error();
  installApprovalExecutionMarkerSchema(f.db);
  const store = new ApprovalExecutionMarkerStore(f.db, f.providers, scope), transaction = new ApprovalHistoryTransaction(f.db, f.providers, scope);
  const mutation = new ApprovalRecordMutation(f.db, scope);
  if (admitted) f.transaction.runPrepared("fixture_marker_admission", () => ({ event,
    resource_commitments: [{ scope: event.scope, resource_id: "approval_execution_markers", resource_digest: emptyMetadataRoot({ ...scope, collection: "approval_execution_markers_v1" }) }], mutation: () => null }));
  const attempt = () => f.records.read("execution", claim.attempt_handle)!;
  const start = (tx = "start", behavior: "normal" | "marker_first" | "missing_record" | "rollback" = "normal") => transaction.runPrepared(tx, (mark, state) => {
    const prior = f.records.readInState(state, "execution", claim.attempt_handle)!;
    const next = { ...prior, row: { ...prior.row, state: "executing" as const, fence: prior.row.fence + 1 } };
    const request = f.records.readInState(state, "request", f.requestId)!;
    const sealed = signApprovalExecutionMarker({ codec_version: 1, scope, request_id: f.requestId, attempt_id: claim.attempt_handle, consume_id: claim.consume_handle,
      semantic_hash: request.row.semantic_hash, operation: "slack.post_thread_reply.v1", execution_fence: next.row.fence,
      created_at: mark.effective_utc, clock_transaction_id: mark.transaction_id, key_version: 1 }, key, mark);
    const records = mutation.prepare(mark, state, [{ previous: prior, next }]), marker = store.prepare(mark, state, sealed);
    return { event, resource_commitments: [...records.resource_commitments, ...marker.resource_commitments], mutation: () => {
      if (behavior === "marker_first") marker.mutation();
      if (behavior !== "missing_record") records.mutation();
      marker.mutation();
      if (behavior === "rollback") throw Error("fixture rollback");
      return sealed;
    } };
  });
  return { ...f, store, transaction, attempt, start, claim };
}
test("execution fenceとmarkerを同時commitし再open・key rotation後も同じmarkerを検証する", t => {
  const f = setup(t); assert.equal(f.store.read(f.claim.attempt_handle), null);
  const signed = f.start(); assert.equal(f.attempt().row.state, "executing"); assert.equal(f.attempt().row.fence, 2);
  assert.deepEqual(f.store.read(f.claim.attempt_handle), signed); verifyApprovalExecutionMarker(signed, { ...key, state: "verification_only" });
  f.db.close(); const db = openSecurityDatabase(f.filename);
  try {
    db.pragma("journal_mode=WAL"); db.pragma("synchronous=FULL"); db.pragma("foreign_keys=ON"); installApprovalSchema(db);
    const reopened = new ApprovalExecutionMarkerStore(db, f.providers, scope); assert.deepEqual(reopened.read(f.claim.attempt_handle), signed);
    const records = new ApprovalRecordRepository(db, f.providers.auditAnchors, f.providers.auditKeys, scope);
    assert.equal(records.read("execution", f.claim.attempt_handle)!.row.state, "executing");
  } finally { db.close(); }
});
test("marker root欠落では自動admissionせずaudit予約前に拒否する", t => {
  const f = setup(t, false), calls = f.anchors.calls.length;
  assert.throws(() => f.store.read(f.claim.attempt_handle), ApprovalExecutionMarkerStoreError);
  assert.throws(() => f.start()); assert.equal(f.anchors.calls.length, calls); assert.equal(f.attempt().row.state, "claimed");
  assert.equal(f.db.prepare("SELECT count(*) FROM approval_execution_markers").pluck().get(), 0);
});
test("markerだけのcommit・実行fence前の保存・mutation失敗でpartial executingを残さない", t => {
  for (const behavior of ["marker_first", "missing_record", "rollback"] as const) {
    const f = setup(t); assert.throws(() => f.start("failed", behavior));
    assert.equal(f.db.prepare("SELECT state FROM approval_execution_attempts").pluck().get(), "claimed");
    // reserve済みのmutation失敗はrootを検証済みとせず、reconcileまで読取も拒否。
    assert.throws(() => f.store.read(f.claim.attempt_handle), ApprovalExecutionMarkerStoreError);
    assert.equal(f.db.prepare("SELECT count(*) FROM approval_execution_markers").pluck().get(), 0);
  }
});
test("markerとfenceのcommit応答喪失では再作成せずdurable状態を保持する", t => {
  for (const fault of ["reserve_before", "reserve_after", "finalize_before", "finalize_after"] as const) {
    const f = setup(t); f.anchors.fault = fault; assert.throws(() => f.start());
    const committed = fault.startsWith("finalize");
    assert.equal(f.db.prepare("SELECT state FROM approval_execution_attempts").pluck().get(), committed ? "executing" : "claimed");
    assert.equal(f.db.prepare("SELECT count(*) FROM approval_execution_markers").pluck().get(), committed ? 1 : 0);
    if (fault === "finalize_after") assert.ok(f.store.read(f.claim.attempt_handle));
  }
});
test("markerの差替え・削除・REPLACEと二度目のexecuting開始を拒否する", t => {
  const f = setup(t), signed = f.start();
  for (const sql of ["UPDATE approval_execution_markers SET marker_json='{}'", "DELETE FROM approval_execution_markers", "INSERT OR REPLACE INTO approval_execution_markers SELECT * FROM approval_execution_markers"])
    assert.throws(() => f.db.exec(sql));
  assert.throws(() => f.start("again")); assert.deepEqual(f.store.read(f.claim.attempt_handle), signed); assert.equal(f.attempt().row.fence, 2);
});
test("marker SQLの外部改変・欠落・異なるscopeを共有rootと照合して拒否する", t => {
  for (const mode of ["tamper", "missing", "scope"] as const) {
    const f = setup(t); f.start();
    if (mode === "scope") {
      assert.throws(() => new ApprovalExecutionMarkerStore(f.db, f.providers, { ...scope, workspace_id: "other" }).read(f.claim.attempt_handle), ApprovalExecutionMarkerStoreError);
    } else {
      const name = mode === "tamper" ? "approval_execution_marker_immutable" : "approval_execution_marker_no_delete";
      const ddl = f.db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").pluck().get(name) as string;
      f.db.exec(`DROP TRIGGER ${name}`);
      try {
        if (mode === "missing") f.db.exec("DELETE FROM approval_execution_markers");
        else f.db.prepare("UPDATE approval_execution_markers SET marker_json=json_set(marker_json,'$.mac',?)").run("b".repeat(64));
      } finally { f.db.exec(ddl); }
      assert.throws(() => f.store.read(f.claim.attempt_handle), ApprovalExecutionMarkerStoreError);
    }
  }
});
test("markerは保存したexact stateだけを読みcallback外へstateを持ち出せない", t => {
  const f = setup(t); f.start(); let retained: VerifiedAuditState | undefined;
  f.transaction.runPrepared("read_mark", (_mark, state) => {
    retained = state; assert.ok(f.store.readInState(state, f.claim.attempt_handle));
    assert.throws(() => f.store.readInState(structuredClone(state), f.claim.attempt_handle), ApprovalExecutionMarkerStoreError);
    return { event, resource_digest: null, mutation: () => null };
  });
  assert.throws(() => f.store.readInState(retained!, f.claim.attempt_handle), ApprovalExecutionMarkerStoreError);
});
