import assert from "node:assert/strict";
import { ApprovalHistoryTransaction } from "../../src/approval/history-transaction.js";
import { ApprovalRecordMutation } from "../../src/approval/record-mutation.js";
import { test } from "node:test";
import { decisionFixture } from "./fixtures/decision.js";
import { scope } from "./fixtures/broker.js";
import { executionFixture } from "./fixtures/execution.js";
import { ApprovalOperations, ApprovalOperationsError } from "../../src/approval/operations.js";

test("expiry候補はexact境界でだけ現れ、単件brokerの確定後は再表示されない", t => {
  const f = decisionFixture(t, false), operations = new ApprovalOperations(f.db, f.providers, scope);
  assert.deepEqual(operations.expiryPage({ limit: 1, after: null }).request_handles, []);
  f.setNow("2026-09-19T00:15:00.000Z");
  assert.deepEqual(operations.expiryPage({ limit: 1, after: null }).request_handles, [f.requestId]);
  assert.equal(operations.health().counts?.expiry_lag, 1);
  // 単件brokerが期限を再検証し、payload削除とauditを同時に確定する。
  f.decision.expire("exact", f.requestId);
  assert.deepEqual(operations.expiryPage({ limit: 1, after: null }).request_handles, []);
  assert.equal(f.read().row.state, "expired");
  assert.throws(() => operations.expiryPage({ limit: 101, after: null }), ApprovalOperationsError);
});

test("healthは未処理の状態を秘匿した件数だけで返し、clock異常でreadinessを落とす", t => {
  const f = decisionFixture(t, false), operations = new ApprovalOperations(f.db, f.providers, scope);
  const normal = operations.health();
  assert.equal(normal.live, true);
  assert.equal(JSON.stringify(normal).includes(f.requestId), false);
  const observe = f.providers.clock.observe;
  f.providers.clock.observe = () => ({ ...observe(), boot_id: "unexpected_boot" });
  assert.deepEqual(operations.health().degraded, ["integrity_or_clock_unverified"]);
});


test("expiryのread-only観測はclock markと監査anchorを変更しない", t => {
  const f = decisionFixture(t, false), operations = new ApprovalOperations(f.db, f.providers, scope);
  const mark = f.marks.read(), anchor = f.anchors.read();
  f.setNow("2026-09-19T00:15:00.000Z");
  assert.deepEqual(operations.expiryPage({ limit: 1, after: null }).request_handles, [f.requestId]);
  assert.deepEqual(f.marks.read(), mark);
  assert.deepEqual(f.anchors.read(), anchor);
  assert.equal(operations.health().ready, false);
  assert.ok(operations.health().degraded.includes("runtime_readiness_unverified"));
});

test("clockの巻戻しと大きなwall jumpでは候補を返さない", t => {
  const f = decisionFixture(t, false), operations = new ApprovalOperations(f.db, f.providers, scope);
  const observe = f.providers.clock.observe;
  for (const wall_utc of ["2026-09-18T23:00:00.000Z", "2026-09-20T00:00:00.000Z"]) {
    f.providers.clock.observe = () => ({ ...observe(), wall_utc });
    assert.throws(() => operations.expiryPage({ limit: 1, after: null }), ApprovalOperationsError);
    assert.equal(operations.health().counts, null);
    assert.equal(operations.health().ready, false);
  }
});

test("監査anchorの不一致を空の正常一覧と解釈しない", t => {
  const f = decisionFixture(t, false), operations = new ApprovalOperations(f.db, f.providers, scope);
  f.anchors.value = { ...f.anchors.value, sequence: f.anchors.value.sequence + 1 };
  assert.throws(() => operations.expiryPage({ limit: 1, after: null }), ApprovalOperationsError);
  assert.equal(operations.health().counts, null);
  assert.equal(operations.health().ready, false);
});

test("同期callback以外をpage入力として評価しない", t => {
  const f = decisionFixture(t, false), operations = new ApprovalOperations(f.db, f.providers, scope);
  let called = false;
  assert.throws(() => operations.expiryPage({ get limit() { called = true; return 1; }, after: null }), ApprovalOperationsError);
  assert.equal(called, false);
});

test("metricsは検証済み件数だけを固定名で公開し、失敗をゼロ件へ戻さない", t => {
  const f = decisionFixture(t, false), operations = new ApprovalOperations(f.db, f.providers, scope);
  const normal = operations.metrics();
  assert.ok(normal.includes("dona_approval_observation_verified 1\n"));
  assert.ok(normal.includes("dona_approval_expiry_lag 0\n"));
  assert.equal(normal.includes(f.requestId), false);
  assert.equal(normal.includes("retention_overdue"), false);
  f.anchors.value = { ...f.anchors.value, sequence: f.anchors.value.sequence + 1 };
  const degraded = operations.metrics();
  assert.ok(degraded.includes("dona_approval_observation_verified 0\n"));
  assert.equal(degraded.includes("expiry_lag"), false);
});

test("paginationはfilterより前の候補を進める", t => {
  const f = decisionFixture(t, false), operations = new ApprovalOperations(f.db, f.providers, scope);
  const first = operations.expiryPage({ limit: 1, after: null });
  assert.deepEqual(first.request_handles, []);
  assert.equal(first.next_after, f.requestId);
  assert.equal(first.has_more, false);
  assert.deepEqual(operations.expiryPage({ limit: 1, after: first.next_after }),
    { request_handles: [], next_after: null, has_more: false });
});

test("SQL期限改変を候補filterで隠さず監査不一致として拒否する", t => {
  const f = decisionFixture(t, false), operations = new ApprovalOperations(f.db, f.providers, scope);
  const triggers = f.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='approval_requests'").all() as { name: string; sql: string }[];
  for (const trigger of triggers) f.db.exec(`DROP TRIGGER "${trigger.name}"`);
  f.db.prepare("UPDATE approval_requests SET expires_at=? WHERE request_id=?")
    .run("2026-09-20T00:00:00.000Z", f.requestId);
  for (const trigger of triggers) f.db.exec(trigger.sql);
  assert.throws(() => operations.expiryPage({ limit: 1, after: null }), ApprovalOperationsError);
  assert.equal(operations.health().counts, null);
});

test("scope getterは評価せず拒否する", t => {
  const f = decisionFixture(t, false);
  let called = false;
  assert.throws(() => new ApprovalOperations(f.db, f.providers, {
    get instance_id() { called = true; return scope.instance_id; }, workspace_id: scope.workspace_id,
  }), ApprovalOperationsError);
  assert.equal(called, false);
});

test("同じtransaction IDでもcurrent markのfield不一致を拒否する", t => {
  const f = decisionFixture(t, false), operations = new ApprovalOperations(f.db, f.providers, scope);
  const original = f.marks.read();
  for (const patch of [{ continuous_ms: original.continuous_ms - 1 },
    { effective_utc: new Date(Date.parse(original.effective_utc) - 1).toISOString() },
    { previous_transaction_id: "different_parent" }]) {
    f.marks.value = { ...original, ...patch };
    assert.throws(() => operations.expiryPage({ limit: 1, after: null }), ApprovalOperationsError);
    assert.equal(operations.health().counts, null);
  }
});

test("current履歴が正常でもrequestの古いclock履歴改変を拒否する", t => {
  const f = decisionFixture(t, false), operations = new ApprovalOperations(f.db, f.providers, scope);
  f.decision.expire("advance_history", f.requestId);
  const triggers = f.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='approval_clock_reservations'").all() as { name: string; sql: string }[];
  for (const trigger of triggers) f.db.exec(`DROP TRIGGER "${trigger.name}"`);
  const created = f.db.prepare("SELECT mark_json FROM approval_clock_reservations WHERE transaction_id='create'").pluck().get() as string;
  const mark = JSON.parse(created); mark.continuous_ms++;
  f.db.prepare("UPDATE approval_clock_reservations SET mark_json=? WHERE transaction_id='create'").run(JSON.stringify(mark));
  for (const trigger of triggers) f.db.exec(trigger.sql);
  assert.throws(() => operations.expiryPage({ limit: 1, after: null }), ApprovalOperationsError);
  assert.equal(operations.health().counts, null);
});

test("観測用の名前と一致する業務transactionの後も観測できる", t => {
  const f = decisionFixture(t, false), operations = new ApprovalOperations(f.db, f.providers, scope);
  for (const name of ["approval_expiry_observation", "approval_health_observation", "approval_observation_0"]) {
    f.decision.expire(name, f.requestId);
    assert.deepEqual(operations.expiryPage({ limit: 1, after: null }).request_handles, []);
    assert.notEqual(operations.health().counts, null);
  }
});


test("execution attemptのneeds_reviewをhealthとmetricsへ反映する", t => {
  const f = executionFixture(t), operations = new ApprovalOperations(f.db, f.providers, scope);
  f.setNow(f.attempt().row.execution_expires_at);
  f.execution.recover("recover_expired", f.executionCommand());
  assert.equal(f.attempt().row.state, "needs_review");
  assert.equal(f.read().row.state, "consumed");
  assert.equal(operations.health().counts?.needs_review, 1);
  assert.ok(operations.metrics().includes("dona_approval_needs_review 1\n"));
});

test("attempt固有の古いclock履歴改変はhealthをsafe-offへ落とす", t => {
  const f = executionFixture(t), operations = new ApprovalOperations(f.db, f.providers, scope);
  const transactionId = f.attempt().row.clock_transaction_id;
  const triggers = f.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='approval_clock_reservations'").all() as { name: string; sql: string }[];
  for (const trigger of triggers) f.db.exec(`DROP TRIGGER "${trigger.name}"`);
  const wire = f.db.prepare("SELECT mark_json FROM approval_clock_reservations WHERE transaction_id=?").pluck().get(transactionId) as string;
  const mark = JSON.parse(wire); mark.continuous_ms++;
  f.db.prepare("UPDATE approval_clock_reservations SET mark_json=? WHERE transaction_id=?").run(JSON.stringify(mark), transactionId);
  for (const trigger of triggers) f.db.exec(trigger.sql);
  assert.equal(operations.health().counts, null);
});

test("terminal requestのpresentation updateもunknownとneeds_reviewへ集計する", t => {
  const f = decisionFixture(t), operations = new ApprovalOperations(f.db, f.providers, scope);
  f.decision.decide("reject", f.command("reject"));
  const row = f.db.prepare("SELECT update_id FROM approval_presentation_updates LIMIT 1").get() as { update_id: string };
  const tx = new ApprovalHistoryTransaction(f.db, f.providers, scope), mutations = new ApprovalRecordMutation(f.db, scope);
  for (const nextState of ["dispatching", "acceptance_unknown", "needs_review"] as const) {
    tx.runPrepared("fixture_presentation_" + nextState, (mark, state) => {
      const previous = f.records.readInState(state, "presentation", row.update_id)!;
      const next = { ...previous, row: { ...previous.row, state: nextState, fence: previous.row.fence + 1 } };
      return { event: { scope: { instance_id: scope.instance_id, tenant_id: scope.workspace_id }, actor: { kind: "system" as const, id: "fixture" },
        action: "approval_delivery" as const, operation: "slack.post_thread_reply.v1" as const, resource_id: f.requestId,
        outcome: "pending" as const, reason: "none" as const, session_ref: null, receipt_id: null, attempt_id: null,
        policy_revision: 1, binding_revision: 3, authz_revision: 7 }, ...mutations.prepare(mark, state, [{ previous, next }]) };
    });
    const health = operations.health();
    assert.notEqual(health.counts, null);
    assert.equal(health.counts?.unknown_delivery, Number(nextState === "acceptance_unknown"));
    assert.equal(health.counts?.needs_review, Number(nextState === "needs_review"));
  }
  assert.equal(f.read().row.state, "rejected");
});
