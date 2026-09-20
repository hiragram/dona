import { openSecurityDatabase } from "../../src/audit/coordination.js";
import { installApprovalSchema } from "../../src/approval/schema.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalDecisionBroker, ApprovalDecisionError, type ApprovalDecisionCommand, type ApprovalDecisionGrant, type ApprovalDecisionAuthority } from "../../src/approval/decision-broker.js";
import { ApprovalHistoryTransaction } from "../../src/approval/history-transaction.js";
import { ApprovalRecordMutation } from "../../src/approval/record-mutation.js";
import type { ApprovalRecord } from "../../src/approval/record-codec.js";
import type { AuditEvent, VerifiedAuditState } from "../../src/audit/codec.js";
import { assertCurrentAuditReadState } from "../../src/audit/repository.js";
import { fixture, scope, intent, content, wrapping, notification as notificationKey } from "./fixtures/broker.js";

function setup(t: { after(fn: () => void): void }, sent = true) {
  const f = fixture(t), created = f.broker.create("create", intent);
  if (created.status === "denied") throw Error();
  const requestId = created.request_handle;
  const tx = new ApprovalHistoryTransaction(f.db, f.providers, scope), mutation = new ApprovalRecordMutation(f.db, scope);
  const notification = (kind: "approval_card" | "pending_notice") => {
    const row = f.records.readAlias({ name: "notification_request_kind", request_id: requestId, notification_kind: kind });
    if (row?.kind !== "notification") throw Error(); return row;
  };
  // Fixture-only delivery; no production adapter/claim is simulated as live proof.
  const deliver = (kind: "approval_card" | "pending_notice") => {
    const attemptId = notification(kind).row.notification_attempt_id;
    for (const next of ["dispatching", "sent"] as const) tx.runPrepared("fixture_" + kind + "_" + next, (mark, state) => {
      const old = f.records.readInState(state, "notification", attemptId)!;
      const request = f.records.readInState(state, "request", requestId)!;
      const changes: Array<{previous: ApprovalRecord; next: ApprovalRecord}> = [{ previous: old, next: { ...old, row: {
        ...old.row, state: next, fence: 1, message_ref: next === "sent" ? "message_" + kind : null } } }];
      if (kind === "approval_card" && next === "sent") changes.push({ previous: request, next: { ...request, row: { ...request.row, state: "sent", revision: request.row.revision + 1 } } });
      const event: Omit<AuditEvent, "occurred_at"> = { scope: { instance_id: scope.instance_id, tenant_id: scope.workspace_id }, actor: { kind: "system", id: "fixture" },
        action: "approval_delivery", operation: "slack.post_thread_reply.v1", resource_id: requestId, outcome: "succeeded", reason: "none", session_ref: null, receipt_id: null, attempt_id: null,
        policy_revision: 1, binding_revision: 3, authz_revision: 7 };
      return { event, ...mutation.prepare(mark, state, changes) };
    });
  };
  if (sent) deliver("approval_card");
  let override: ((grant: Extract<ApprovalDecisionGrant, { status: "verified" }>) => ApprovalDecisionGrant) | null = null;
  let captured: VerifiedAuditState | null = null, calls = 0;
  const authorize: ApprovalDecisionAuthority = (command, request, _mark, state) => {
    calls++; captured = state; assertCurrentAuditReadState(f.db, state); assert.equal(command.authority_ref, "fixture_authenticated_inbox");
    assert.equal(f.records.readInState(state, "request", request.row.request_id)!.row.revision, request.row.revision);
    const snapshot = JSON.parse(request.row.snapshot_json);
    const g: Extract<ApprovalDecisionGrant, { status: "verified" }> = { status: "verified", scope, request_id: requestId,
      actor_kind: command.action === "cancel" ? "requester" : "supervisor", actor_id: command.action === "cancel" ? snapshot.request_source.owner_id : "supervisor",
      binding_id: request.row.binding_id, binding_revision: request.row.binding_revision, policy_revision: request.row.policy_revision,
      semantic_hash: request.row.semantic_hash, requester_authorization_revision: snapshot.preconditions.requester_authorization_revision,
      presentation_ref: command.action === "cancel" ? null : "message_approval_card", presentation_revision: command.action === "cancel" ? null : 1, stale_reason: null };
    return override ? override(g) : g;
  };
  const broker = new ApprovalDecisionBroker(f.db, f.providers, scope, authorize, () => content, () => wrapping, () => notificationKey);
  const command = (action: "approve" | "reject" | "cancel", revision = 1): ApprovalDecisionCommand => ({ action, request_handle: requestId,
    authority_ref: "fixture_authenticated_inbox", expected_revision: revision, ...(action === "cancel" ? {} : { presentation_revision: 1 }) }) as ApprovalDecisionCommand;
  return { ...f, authorize, decision: broker, requestId, notification, deliver, command, setGrant: (fn: typeof override) => { override = fn; },
    authorityState: () => captured, calls: () => calls, read: () => f.records.read("request", requestId)!,
    rows: (table: "approval_decisions" | "approval_event_outbox" | "approval_payload_secrets" | "approval_presentation_updates") => Number(f.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()) };
}

test("approveはdecisionとeventを一度だけ作りpayloadを保持しconsume期限を固定する", t => {
  const f = setup(t); f.setNow("2026-09-19T00:14:59.999Z");
  const first = f.decision.decide("approve", f.command("approve"));
  assert.equal(first.status, "decided"); assert.equal(f.read().row.state, "approved");
  assert.equal(f.read().row.consume_expires_at, "2026-09-19T00:19:59.999Z"); assert.equal(f.read().row.revision, 3);
  assert.deepEqual([f.rows("approval_decisions"), f.rows("approval_event_outbox"), f.rows("approval_payload_secrets"), f.rows("approval_presentation_updates")], [1,1,1,1]);
  assert.equal(f.notification("pending_notice").row.state, "aborted");
  f.setNow("2026-09-19T00:15:00.000Z");
  assert.deepEqual(f.decision.decide("duplicate", f.command("approve")), { ...first, status: "reused" });
  assert.equal(f.read().row.consume_expires_at, "2026-09-19T00:19:59.999Z"); assert.equal(f.rows("approval_event_outbox"), 1);
  assert.throws(() => assertCurrentAuditReadState(f.db, f.authorityState()!)); assert.equal(f.calls(), 2);
});

test("rejectは本文を同時削除し送信済みcardとnoticeの無効表示をoutboxへ残す", t => {
  const f = setup(t); f.deliver("pending_notice");
  assert.equal(f.decision.decide("reject", f.command("reject")).status, "decided");
  assert.equal(f.read().row.state, "rejected"); assert.equal(f.rows("approval_payload_secrets"), 0); assert.equal(f.rows("approval_presentation_updates"), 2);
  assert.equal(f.payloads.inspect("request", f.requestId)!.metadata.state, "deleted");
  assert.equal(f.decision.decide("duplicate", f.command("reject")).status, "reused"); assert.equal(f.rows("approval_presentation_updates"), 2);
  assert.deepEqual(f.decision.decide("conflict", f.command("approve")), { status: "denied", reason: "decision_conflict" });
});

test("approveとcancelの先着だけがsingle decisionを確定しapproval後cancelは実行許可を失効する", t => {
  const c = setup(t, false); assert.equal(c.decision.decide("cancel", c.command("cancel")).status, "decided");
  assert.equal(c.read().row.state, "cancelled"); assert.equal(c.rows("approval_payload_secrets"), 0);
  assert.equal(c.notification("approval_card").row.state, "aborted"); assert.equal(c.notification("pending_notice").row.state, "aborted");
  assert.equal(c.decision.decide("repeat", c.command("cancel")).status, "reused"); assert.equal(c.decision.decide("late", c.command("approve")).status, "denied");
  const a = setup(t); a.decision.decide("approve", a.command("approve"));
  assert.deepEqual(a.decision.decide("stale_cancel", a.command("cancel")), { status: "denied", reason: "revision_mismatch" });
  assert.deepEqual(a.decision.decide("cancel", a.command("cancel", 3)), { status: "changed", request_state: "execution_cancelled" });
  assert.equal(a.rows("approval_decisions"), 1); assert.equal(a.records.read("decision", a.requestId)!.row.kind, "approve");
  assert.equal(a.rows("approval_payload_secrets"), 0); assert.equal(a.rows("approval_presentation_updates"), 2);
});

test("requestとconsume TTLのexact境界でexpireしduplicate sweepは再生成しない", t => {
  const f = setup(t, false); f.setNow("2026-09-19T00:14:59.999Z");
  assert.deepEqual(f.decision.expire("early", f.requestId), { status: "unchanged", request_state: "delivery_pending" });
  f.setNow("2026-09-19T00:15:00.000Z"); assert.equal(f.decision.expire("exact", f.requestId).status, "decided");
  assert.equal(f.read().row.state, "expired"); assert.equal(f.records.read("decision", f.requestId)!.row.kind, "expire"); assert.equal(f.rows("approval_payload_secrets"), 0);
  assert.deepEqual(f.decision.expire("repeat", f.requestId), { status: "unchanged", request_state: "expired" }); assert.equal(f.rows("approval_event_outbox"), 1);
  const a = setup(t); a.decision.decide("approve", a.command("approve")); a.setNow("2026-09-19T00:04:59.999Z");
  assert.equal(a.decision.expire("early", a.requestId).status, "unchanged"); a.setNow("2026-09-19T00:05:00.000Z");
  assert.deepEqual(a.decision.expire("exact", a.requestId), { status: "changed", request_state: "consume_expired" });
  assert.equal(a.rows("approval_decisions"), 1); assert.equal(a.rows("approval_payload_secrets"), 0);
});

test("期限境界に到着したapproveを承認へ変換しない", t => {
  const f = setup(t); f.setNow("2026-09-19T00:15:00.000Z");
  const result = f.decision.decide("late", f.command("approve"));
  assert.equal(result.status, "decided"); if (result.status !== "decided") throw Error(); assert.equal(result.decision, "expire"); assert.equal(f.rows("approval_payload_secrets"), 0);
});

test("scope・actor・proof・presentation不一致は既存状態とpayloadを変更しない", t => {
  for (const fault of ["scope", "request", "role", "requester", "proof", "message", "presentation", "revision"] as const) {
    const f = setup(t), before = f.read();
    f.setGrant(g => fault === "proof" ? { status: "denied", reason: "proof_invalid" } : { ...g,
      ...(fault === "scope" ? { scope: { ...scope, workspace_id: "other" } } : {}), ...(fault === "request" ? { request_id: "another" } : {}),
      ...(fault === "role" ? { actor_kind: "requester" as const } : {}), ...(fault === "requester" ? { actor_id: "another" } : {}),
      ...(fault === "message" ? { presentation_ref: "another" } : {}), ...(fault === "presentation" ? { presentation_revision: 2 } : {}) });
    assert.equal(f.decision.decide("bad", f.command(fault === "requester" ? "cancel" : "approve", fault === "revision" ? 2 : 1)).status, "denied");
    assert.deepEqual(f.read(), before); assert.equal(f.rows("approval_payload_secrets"), 1); assert.equal(f.rows("approval_decisions"), 0);
  }
});

test("認証済みauthorityのbinding・policy・snapshot・visibility driftはneeds_reviewへ固定する", t => {
  for (const fault of ["binding", "policy", "snapshot", "authorization", "visibility"] as const) {
    const f = setup(t); f.setGrant(g => ({ ...g, ...(fault === "binding" ? { binding_revision: 4 } : {}), ...(fault === "policy" ? { policy_revision: 2 } : {}),
      ...(fault === "snapshot" ? { semantic_hash: "b".repeat(64) } : {}), ...(fault === "authorization" ? { requester_authorization_revision: 8 } : {}),
      ...(fault === "visibility" ? { stale_reason: "resource_not_visible" as const } : {}) }));
    assert.deepEqual(f.decision.decide("stale", f.command("approve")), { status: "changed", request_state: "needs_review" });
    assert.equal(f.rows("approval_decisions"), 0); assert.equal(f.rows("approval_payload_secrets"), 0); assert.equal(f.rows("approval_presentation_updates"), 1);
  }
});

test("未配送cardをapproveできずclient actorと非同期authorityも受けない", t => {
  const f = setup(t, false); assert.deepEqual(f.decision.decide("pending", f.command("approve")), { status: "denied", reason: "presentation_stale" });
  const before = f.anchors.calls.length;
  assert.throws(() => f.decision.decide("client", { ...f.command("approve"), actor_id: "supervisor" } as unknown as ApprovalDecisionCommand), ApprovalDecisionError); assert.equal(f.anchors.calls.length, before);
  assert.throws(() => new ApprovalDecisionBroker(f.db, f.providers, scope, (async () => ({ status: "denied", reason: "unauthorized" })) as never, () => content, () => wrapping, () => notificationKey), ApprovalDecisionError);
});

test("欠落payloadをapproveせずneeds_reviewにして再生成しない", t => {
  const f = setup(t);
  const trigger = f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='approval_payload_secret_delete_guard'").pluck().get() as string;
  f.db.exec("DROP TRIGGER approval_payload_secret_delete_guard");
  try { f.db.prepare("DELETE FROM approval_payload_secrets").run(); } finally { f.db.exec(trigger); }
  assert.deepEqual(f.decision.decide("missing", f.command("approve")), { status: "changed", request_state: "needs_review" });
  assert.equal(f.payloads.inspect("request", f.requestId)!.metadata.state, "deleted"); assert.equal(f.rows("approval_decisions"), 0);
});

test("decisionのSQL・audit障害ではpartial writeせず応答喪失を再実行しない", t => {
  for (const fault of ["sql", "reserve_before", "reserve_after", "finalize_before", "finalize_after"] as const) {
    const f = setup(t);
    if (fault === "sql") {
      const prepare = f.db.prepare.bind(f.db); f.db.prepare = ((...args: Parameters<typeof f.db.prepare>) => {
        if (args[0].startsWith("INSERT INTO main.approval_event_outbox")) throw Error("fixture SQL failure"); return prepare(...args);
      }) as typeof f.db.prepare; t.after(() => { f.db.prepare = prepare; });
    } else f.anchors.fault = fault;
    assert.throws(() => f.decision.decide("reject", f.command("reject")), ApprovalDecisionError);
    const committed = fault.startsWith("finalize");
    assert.deepEqual([f.rows("approval_decisions"), f.rows("approval_event_outbox"), f.rows("approval_payload_secrets"), f.rows("approval_presentation_updates")], committed ? [1,1,0,1] : [0,0,1,0]);
    if (fault === "finalize_after") assert.equal(f.read().row.state, "rejected");
  }
});


test("失効content keyとSQL clock改変をapprovalの成功へ変換しない", t => {
  const f = setup(t);
  const revoked = new ApprovalDecisionBroker(f.db, f.providers, scope, f.authorize, () => ({ ...content, state: "revoked" }), () => wrapping, () => notificationKey);
  assert.deepEqual(revoked.decide("revoked", f.command("approve")), { status: "changed", request_state: "needs_review" });
  assert.equal(f.rows("approval_payload_secrets"), 0); assert.equal(f.rows("approval_decisions"), 0);
  const altered = setup(t), before = altered.anchors.calls.length;
  const trigger = altered.db.prepare("SELECT sql FROM sqlite_schema WHERE name='approval_clock_immutable'").pluck().get() as string;
  altered.db.exec("DROP TRIGGER approval_clock_immutable");
  try { altered.db.prepare("UPDATE approval_clock_reservations SET mark_json=json_set(mark_json,'$.continuous_ms',1001) WHERE transaction_id='create'").run(); }
  finally { altered.db.exec(trigger); }
  assert.throws(() => altered.decision.decide("tampered", altered.command("approve")), ApprovalDecisionError);
  assert.equal(altered.anchors.calls.length, before); assert.equal(altered.rows("approval_decisions"), 0);
});

test("boot変更とclock巻戻しはrequest期限を延ばさずdecision経路を停止する", t => {
  for (const fault of ["boot", "rewind"] as const) {
    const f = setup(t), original = f.providers.clock.observe.bind(f.providers.clock), before = f.anchors.calls.length;
    f.providers.clock.observe = () => ({ ...original(), ...(fault === "boot" ? { boot_id: "other_boot" } : { continuous_ms: 0 }) });
    assert.throws(() => f.decision.decide("clock_failure", f.command("approve")), ApprovalDecisionError);
    assert.equal(f.anchors.calls.length, before); assert.equal(f.rows("approval_decisions"), 0); assert.equal(f.read().row.expires_at, "2026-09-19T00:15:00.000Z");
  }
});

test("decision authority中のSQL writeは共有監査reserve前に拒否する", t => {
  const f = setup(t), before = f.anchors.calls.length;
  const broker = new ApprovalDecisionBroker(f.db, f.providers, scope, () => {
    f.db.prepare("UPDATE approval_requests SET revision=revision+1").run(); return { status: "denied", reason: "unauthorized" };
  }, () => content, () => wrapping, () => notificationKey);
  assert.throws(() => broker.decide("bad_authority", f.command("approve")), ApprovalDecisionError);
  assert.equal(f.anchors.calls.length, before); assert.equal(f.read().row.revision, 2);
});


test("policy driftが同時にあっても別messageと古いcancel revisionでは状態を変えない", t => {
  for (const action of ["approve", "cancel"] as const) {
    const f = setup(t), before = f.read();
    f.setGrant(g => ({ ...g, policy_revision: 2, ...(action === "approve" ? { presentation_ref: "wrong_message" } : {}) }));
    assert.equal(f.decision.decide("bad", f.command(action, action === "cancel" ? 3 : 1)).status, "denied");
    assert.deepEqual(f.read(), before); assert.equal(f.rows("approval_payload_secrets"), 1);
  }
});


test("再open後も確定decisionと未配送eventを保持してduplicateで再生成しない", t => {
  const f = setup(t), first = f.decision.decide("reject", f.command("reject")); f.db.close();
  const db = openSecurityDatabase(f.filename);
  try {
    db.pragma("journal_mode=WAL"); db.pragma("synchronous=FULL"); db.pragma("foreign_keys=ON"); installApprovalSchema(db);
    const broker = new ApprovalDecisionBroker(db, f.providers, scope, (_command, request, _mark, state) => {
      assertCurrentAuditReadState(db, state); const snapshot = JSON.parse(request.row.snapshot_json);
      return { status: "verified", scope, request_id: request.row.request_id, actor_kind: "supervisor", actor_id: "supervisor",
        binding_id: request.row.binding_id, binding_revision: request.row.binding_revision, policy_revision: request.row.policy_revision,
        semantic_hash: request.row.semantic_hash, requester_authorization_revision: snapshot.preconditions.requester_authorization_revision,
        presentation_ref: "message_approval_card", presentation_revision: 1, stale_reason: null };
    }, () => content, () => wrapping, () => notificationKey);
    assert.deepEqual(broker.decide("reopened", f.command("reject")), { ...first, status: "reused" });
    assert.deepEqual(broker.decide("conflict", f.command("approve")), { status: "denied", reason: "decision_conflict" });
    assert.deepEqual(db.prepare("SELECT state,count(*) AS n FROM approval_event_outbox GROUP BY state").all(), [{ state: "pending", n: 1 }]);
    assert.equal(db.prepare("SELECT count(*) FROM approval_payload_secrets").pluck().get(), 0);
  } finally { db.close(); }
});


test("notification旧検証鍵は許可し失効marker keyではstateを変更しない", t => {
  const f = setup(t), before = f.read(), calls = f.anchors.calls.length;
  const revoked = new ApprovalDecisionBroker(f.db, f.providers, scope, f.authorize, () => content, () => wrapping,
    () => ({ ...notificationKey, state: "revoked" }));
  assert.throws(() => revoked.decide("revoked_marker", f.command("approve")), ApprovalDecisionError);
  assert.equal(f.anchors.calls.length, calls); assert.deepEqual(f.read(), before); assert.equal(f.rows("approval_decisions"), 0);
  const retained = new ApprovalDecisionBroker(f.db, f.providers, scope, f.authorize, () => content, () => wrapping,
    () => ({ ...notificationKey, state: "verification_only" }));
  assert.equal(retained.decide("retained_marker", f.command("approve")).status, "decided");
});
