import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionFixture } from "./fixtures/decision.js";
import { scope } from "./fixtures/broker.js";
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
