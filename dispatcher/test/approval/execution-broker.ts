import assert from "node:assert/strict";
import { test } from "node:test";
import { executionFixture } from "./fixtures/execution.js";
import { ApprovalExecutionBroker, ApprovalExecutionError } from "../../src/approval/execution-broker.js";
import { scope, content, wrapping, body } from "./fixtures/broker.js";
import { executionKey } from "./fixtures/execution.js";
import type { ExecutionCommand } from "../../src/approval/execution-authority.js";
const start = (f: ReturnType<typeof executionFixture>) => f.execution.start("start", f.executionCommand());
const payload = (f: ReturnType<typeof executionFixture>) => f.payloads.inspect("attempt", f.claim.attempt_handle)!;
test("fresh startだけがexecuting fenceと保存markerを作り本文を結果に返さない", t => {
  const f = executionFixture(t), result = start(f);
  assert.deepEqual(result, { status: "started", attempt_handle: f.claim.attempt_handle, attempt_state: "executing", fence: 2 });
  assert.equal(f.read().row.state, "consumed"); assert.equal(payload(f).metadata.state, "active");
  assert.equal(f.markerStore.read(f.claim.attempt_handle)!.marker.execution_fence, 2);
  assert.deepEqual(f.execution.start("duplicate", f.executionCommand()), { status: "denied", reason: "already_consumed" });
  assert.equal(f.attempt().row.fence, 2);
  assert.equal(JSON.stringify(f.db.prepare("SELECT record_json FROM security_audit_records").all()).includes(body), false);
});
test("確定acceptedは成功metadataと本文削除を同時保存しterminal duplicateを再実行しない", t => {
  const f = executionFixture(t); start(f);
  assert.deepEqual(f.execution.resolve("accepted", f.executionCommand()), { status: "updated", attempt_handle: f.claim.attempt_handle, attempt_state: "succeeded", fence: 3 });
  assert.equal(f.attempt().row.receipt_ref, "fixture_receipt"); assert.equal(payload(f).secret.status, "deleted");
  assert.equal(f.execution.recover("terminal_recovery", f.executionCommand()).status, "unchanged");
  assert.equal(f.execution.resolve("terminal_duplicate", f.executionCommand()).status, "unchanged");
  assert.equal(f.execution.start("terminal_start", f.executionCommand()).status, "denied"); assert.equal(f.attempt().row.fence, 3);
});
test("決定的rejectionだけをfailedへしreceiptと失敗理由を保存する", t => {
  const f = executionFixture(t); start(f); f.setReceipt({ outcome: "rejected", receipt_ref: "rejected_receipt", reason: "scope_denied" });
  f.execution.resolve("rejected", f.executionCommand()); assert.equal(f.attempt().row.state, "failed");
  assert.equal(f.attempt().row.failure_code, "scope_denied"); assert.equal(f.attempt().row.receipt_ref, "rejected_receipt"); assert.equal(payload(f).secret.status, "deleted");
});
test("executing復旧は必ずunknownへ進み旧callbackをfenceしてread-only receiptでだけ確定する", t => {
  const f = executionFixture(t); start(f); const old = f.executionCommand();
  f.execution.recover("recovery", old); assert.equal(f.attempt().row.state, "acceptance_unknown"); assert.equal(f.attempt().row.fence, 3);
  assert.deepEqual(f.execution.resolve("late_callback", old), { status: "denied", reason: "revision_mismatch" });
  f.setReceipt({ outcome: "accepted", receipt_ref: "not_reconcile" });
  assert.deepEqual(f.execution.resolve("wrong_proof_kind", f.executionCommand()), { status: "denied", reason: "proof_invalid" });
  f.setReceipt({ outcome: "unknown" }, "reconcile"); assert.equal(f.execution.resolve("zero", f.executionCommand()).status, "unchanged");
  assert.equal(f.attempt().row.fence, 3); assert.equal(payload(f).secret.status, "present");
  f.setReceipt({ outcome: "accepted", receipt_ref: "exact_reconciled" }, "reconcile"); f.execution.resolve("one", f.executionCommand());
  assert.equal(f.attempt().row.state, "succeeded"); assert.equal(f.attempt().row.receipt_ref, "exact_reconciled"); assert.equal(payload(f).secret.status, "deleted");
});
test("応答不明はunknownへ進み0件では再送せず複数または不完全proofはneeds_reviewへする", t => {
  const f = executionFixture(t); start(f); f.setReceipt({ outcome: "unknown" }); f.execution.resolve("lost", f.executionCommand());
  f.setReceipt({ outcome: "unknown" }, "reconcile"); f.execution.resolve("zero", f.executionCommand());
  assert.equal(f.attempt().row.state, "acceptance_unknown"); assert.equal(f.execution.start("resend", f.executionCommand()).status, "denied");
  f.setReceipt({ outcome: "ambiguous" }, "reconcile"); f.execution.resolve("multiple_or_incomplete", f.executionCommand());
  assert.equal(f.attempt().row.state, "needs_review"); assert.equal(payload(f).secret.status, "deleted");
});
test("claimedの開始期限境界は外部実行前にneeds_reviewと本文削除へ収束する", t => {
  const f = executionFixture(t); f.setNow("2026-09-19T00:00:30.000Z");
  const result = start(f); assert.equal(result.status, "updated"); assert.equal(f.attempt().row.state, "needs_review");
  assert.equal(payload(f).secret.status, "deleted"); assert.equal(f.markerStore.read(f.claim.attempt_handle), null);
});
test("24時間境界でunknown本文を削除し期限後receiptや失効markerでも再実行しない", t => {
  const f = executionFixture(t); start(f); f.execution.recover("recovery", f.executionCommand());
  f.revokeMarker(); f.setNow("2026-09-20T00:00:00.000Z"); f.execution.recover("expired", f.executionCommand());
  assert.equal(f.attempt().row.state, "needs_review"); assert.equal(payload(f).secret.status, "deleted");
  assert.equal(f.execution.start("no_restart", f.executionCommand()).status, "denied");
});
test("認証・scope・attempt・fence不一致とclient指定outcomeは状態を変えない", t => {
  const f = executionFixture(t), command = f.executionCommand();
  for (const [n, change] of ["denied", "scope", "attempt"].entries()) {
    f.setStart(g => g.status === "denied" ? g : change === "denied" ? { status: "denied", reason: "unauthorized" }
      : { ...g, ...(change === "scope" ? { scope: { ...scope, workspace_id: "other" } } : { attempt_id: "other" }) });
    assert.equal(f.execution.start("bad_" + n, command).status, "denied");
  }
  f.setStart(null); assert.equal(f.execution.start("bad_fence", { ...command, expected_fence: 2 }).status, "denied");
  const calls = f.anchors.calls.length;
  assert.throws(() => f.execution.start("bad_field", { ...command, outcome: "accepted" } as unknown as ExecutionCommand), ApprovalExecutionError);
  assert.equal(f.anchors.calls.length, calls); assert.equal(f.attempt().row.state, "claimed"); assert.equal(payload(f).secret.status, "present");
  assert.throws(() => new ApprovalExecutionBroker(f.db, f.providers, scope, (async () => ({ status: "denied", reason: "unauthorized" })) as never,
    f.authorities.recovery, f.authorities.receipts, () => content, () => wrapping, () => executionKey), ApprovalExecutionError);
});
test("current binding・policy・thread snapshot・visibility driftでは実行せず本文を削除する", t => {
  for (const fault of ["binding", "policy", "snapshot", "visibility"] as const) {
    const f = executionFixture(t); f.setStart(g => { if (g.status !== "verified") throw Error(); return { ...g,
      ...(fault === "binding" ? { binding_revision: 5 } : {}), ...(fault === "policy" ? { policy_revision: 5 } : {}),
      ...(fault === "snapshot" ? { semantic_hash: "b".repeat(64) } : {}), ...(fault === "visibility" ? { stale_reason: "resource_not_visible" as const } : {}) }; });
    start(f); assert.equal(f.attempt().row.state, "needs_review"); assert.equal(payload(f).secret.status, "deleted");
    assert.equal(f.markerStore.read(f.claim.attempt_handle), null);
  }
});
test("本文欠落またはcontent鍵失効はstartを許可せずneeds_reviewへする", t => {
  for (const fault of ["missing", "revoked"] as const) {
    const f = executionFixture(t);
    if (fault === "revoked") f.revokeContent(); else {
      const ddl = f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='approval_payload_secret_delete_guard'").pluck().get() as string;
      f.db.exec("DROP TRIGGER approval_payload_secret_delete_guard"); try { f.db.exec("DELETE FROM approval_payload_secrets"); } finally { f.db.exec(ddl); }
    }
    start(f); assert.equal(f.attempt().row.state, "needs_review"); assert.equal(payload(f).secret.status, "deleted");
  }
});
test("失効markerでもunknown復旧を記録し結果照合は拒否、保持鍵だけ照合に使う", t => {
  const f = executionFixture(t); start(f); f.revokeMarker();
  f.execution.recover("revoked_recovery", f.executionCommand());
  assert.equal(f.attempt().row.state, "acceptance_unknown");
  f.setReceipt({ outcome: "accepted", receipt_ref: "revoked_receipt" }, "reconcile"); const calls = f.anchors.calls.length;
  assert.throws(() => f.execution.resolve("revoked", f.executionCommand()), ApprovalExecutionError);
  assert.equal(f.anchors.calls.length, calls); assert.equal(f.attempt().row.state, "acceptance_unknown");
  const retained = executionFixture(t); start(retained); retained.retainMarker(); retained.execution.resolve("accepted", retained.executionCommand());
  assert.equal(retained.attempt().row.state, "succeeded");
});
test("startのSQL/audit障害でpartial markerを作らずfinalize応答喪失でもstartedを返さない", t => {
  for (const fault of ["sql", "reserve_before", "reserve_after", "finalize_before", "finalize_after"] as const) {
    const f = executionFixture(t), command = f.executionCommand();
    if (fault === "sql") {
      const prepare = f.db.prepare.bind(f.db); f.db.prepare = ((...args: Parameters<typeof f.db.prepare>) => {
        if (args[0].startsWith("INSERT INTO main.approval_execution_markers")) throw Error("fixture SQL fault"); return prepare(...args);
      }) as typeof f.db.prepare; t.after(() => { f.db.prepare = prepare; });
    } else f.anchors.fault = fault;
    assert.throws(() => f.execution.start("failed", command), ApprovalExecutionError);
    const committed = fault.startsWith("finalize");
    assert.equal(f.db.prepare("SELECT state FROM approval_execution_attempts").pluck().get(), committed ? "executing" : "claimed");
    assert.equal(f.db.prepare("SELECT count(*) FROM approval_execution_markers").pluck().get(), committed ? 1 : 0);
  }
});
test("結果commitのSQL障害は状態と本文削除をrollbackし応答喪失後も二度目の送信を許さない", t => {
  for (const fault of ["sql", "finalize_after"] as const) {
    const f = executionFixture(t); start(f); const command = f.executionCommand();
    if (fault === "sql") {
      const prepare = f.db.prepare.bind(f.db); f.db.prepare = ((...args: Parameters<typeof f.db.prepare>) => {
        if (args[0].startsWith("UPDATE main.approval_payload_metadata SET state='deleted'")) throw Error("fixture result SQL fault"); return prepare(...args);
      }) as typeof f.db.prepare; t.after(() => { f.db.prepare = prepare; });
    } else f.anchors.fault = fault;
    assert.throws(() => f.execution.resolve("result_fault", command), ApprovalExecutionError);
    assert.equal(f.db.prepare("SELECT state FROM approval_execution_attempts").pluck().get(), fault === "sql" ? "executing" : "succeeded");
    assert.equal(f.db.prepare("SELECT count(*) FROM approval_payload_secrets").pluck().get(), fault === "sql" ? 1 : 0);
  }
});
test("再openしたexecutingを再送せずunknownへ進め同じmarkerの照合だけを行う", async t => {
  const { openSecurityDatabase } = await import("../../src/audit/coordination.js");
  const { installApprovalSchema } = await import("../../src/approval/schema.js");
  const { ApprovalRecordRepository } = await import("../../src/approval/record-repository.js");
  const f = executionFixture(t); start(f); const command = f.executionCommand(), saved = f.markerStore.read(f.claim.attempt_handle)!;
  f.db.close(); const db = openSecurityDatabase(f.filename);
  try {
    db.pragma("journal_mode=WAL"); db.pragma("synchronous=FULL"); db.pragma("foreign_keys=ON"); installApprovalSchema(db);
    const broker = new ApprovalExecutionBroker(db, f.providers, scope, f.authorities.start, f.authorities.recovery, f.authorities.receipts,
      () => content, () => wrapping, () => ({ ...executionKey, state: "verification_only" }));
    broker.recover("reopen_recovery", command);
    const records = new ApprovalRecordRepository(db, f.providers.auditAnchors, f.providers.auditKeys, scope);
    assert.equal(records.read("execution", f.claim.attempt_handle)!.row.state, "acceptance_unknown");
    f.setReceipt({ outcome: "accepted", receipt_ref: "reopened_exact" }, "reconcile");
    broker.resolve("reopen_reconcile", { ...command, expected_fence: 3 });
    assert.equal(records.read("execution", f.claim.attempt_handle)!.row.receipt_ref, "reopened_exact");
    const row = db.prepare("SELECT marker_json FROM approval_execution_markers").pluck().get() as string;
    assert.deepEqual(JSON.parse(row), saved);
  } finally { db.close(); }
});

test("期限切れexecuting復旧はunknownの監査と本文削除を先に保存してneeds_reviewへ収束する", t => {
  const f = executionFixture(t); start(f); f.revokeMarker(); f.setNow("2026-09-20T00:00:00.000Z");
  f.execution.recover("expired_executing", f.executionCommand());
  assert.equal(f.attempt().row.state, "acceptance_unknown"); assert.equal(payload(f).secret.status, "deleted");
  const rows = f.db.prepare("SELECT record_json FROM security_audit_records ORDER BY sequence").pluck().all() as string[];
  assert.equal(rows.some(row => row.includes('"outcome":"acceptance_unknown"') && row.includes('"reason":"expired"')), true);
  f.execution.recover("finish_expired", f.executionCommand());
  assert.equal(f.attempt().row.state, "needs_review"); assert.equal(payload(f).secret.status, "deleted");
});

test("復旧とreceiptの認証・scope・fence拒否は保存済み実行状態を変えない", t => {
  const f = executionFixture(t); start(f);
  f.setRecovery(() => ({ status: "denied", reason: "unauthorized" }));
  assert.equal(f.execution.recover("recovery_denied", f.executionCommand()).status, "denied");
  f.setRecovery(g => g.status === "verified" ? { ...g, scope: { ...scope, workspace_id: "other" } } : g);
  assert.equal(f.execution.recover("recovery_scope", f.executionCommand()).status, "denied");
  f.setReceiptGrant(() => ({ status: "denied", reason: "unauthenticated" }));
  assert.equal(f.execution.resolve("receipt_denied", f.executionCommand()).status, "denied");
  f.setReceiptGrant(g => g.status === "verified" ? { ...g, execution_fence: g.execution_fence + 1 } : g);
  assert.equal(f.execution.resolve("receipt_fence", f.executionCommand()).status, "denied");
  assert.equal(f.attempt().row.state, "executing"); assert.equal(f.attempt().row.fence, 2);
  assert.equal(payload(f).secret.status, "present");
});
test("本文を失ったexecutingのreceiptは成功にせずunknown監査と削除を経て収束する", t => {
  const f = executionFixture(t); start(f);
  const ddl = f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='approval_payload_secret_delete_guard'").pluck().get() as string;
  f.db.exec("DROP TRIGGER approval_payload_secret_delete_guard"); try { f.db.exec("DELETE FROM approval_payload_secrets"); } finally { f.db.exec(ddl); }
  f.execution.resolve("missing_receipt", f.executionCommand());
  assert.equal(f.attempt().row.state, "acceptance_unknown"); assert.equal(f.attempt().row.receipt_ref, null);
  assert.equal(payload(f).metadata.state, "deleted");
  f.execution.recover("missing_finish", f.executionCommand()); assert.equal(f.attempt().row.state, "needs_review");
});
