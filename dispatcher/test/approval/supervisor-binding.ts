import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { fixture, scope } from "./fixtures/broker.js";
import { grant, intent } from "./fixtures/broker.js";
import { ApprovalCreateBroker, ApprovalCreateError } from "../../src/approval/create-broker.js";
import { ApprovalDecisionBroker } from "../../src/approval/decision-broker.js";
import { ApprovalHistoryTransaction } from "../../src/approval/history-transaction.js";
import { ApprovalRecordMutation } from "../../src/approval/record-mutation.js";
import { content, wrapping, notification as notificationKey } from "./fixtures/broker.js";
import type { AuditEvent } from "../../src/audit/codec.js";
import { installApprovalExecutionMarkerSchema, installApprovalSupervisorBindingSchema } from "../../src/approval/schema.js";
import { SupervisorBindingOperator, SupervisorBindingRepository, SupervisorBindingError,
  SupervisorBindingGuard, supervisorBindingId, supervisorOperationScopeDigest, supervisorTargetScopeDigest,
  KeychainBindingGenerations, bindingGenerationGenesis, supervisorReasonDigest,
  bindSupervisorAccessObservation,
  type BindingGeneration, type BindingGenerationStore, type SupervisorBindingProposal,
  type SupervisorAccessReceipt } from "../../src/approval/supervisor-binding.js";

const blank: SupervisorBindingProposal = { team_id: "T123", supervisor_user_id: "U123",
  reason: null, reason_digest: null, operation_scope_digest: null, target_scope_digest: null, expires_at: null };
function bindingFixture(t: { after(fn: () => void): void }) {
  const f = fixture(t);
  installApprovalExecutionMarkerSchema(f.db);
  installApprovalSupervisorBindingSchema(f.db);
  let generation: BindingGeneration | null = null;
  let mode: "normal" | "deny" | "after_reserve" = "normal";
  const generations: BindingGenerationStore = {
    read: () => generation === null ? null : structuredClone(generation),
    reserve: (_scope, expected, proposed) => {
      assert.deepEqual(expected, generation);
      if (mode === "deny") throw Error("credential store unavailable");
      generation = structuredClone(proposed);
      if (mode === "after_reserve") throw Error("credential response lost");
      return structuredClone(generation);
    },
  };
  const proofs = (action: "bootstrap" | "rotate" | "revoke" | "break_glass", transactionId: string, proposalDigest: string) => [
    { operator_id: "operatorA", credential_id: "hardwareA", credential_domain: "accountA", credential_kind: "hardware_backed" as const,
      action, transaction_id: transactionId, proposal_digest: proposalDigest },
    { operator_id: "operatorB", credential_id: "hardwareB", credential_domain: "accountB", credential_kind: "hardware_backed" as const,
      action, transaction_id: transactionId, proposal_digest: proposalDigest },
  ] as const;
  const operator = new SupervisorBindingOperator(f.db, f.providers, scope, generations, proofs);
  const repository = new SupervisorBindingRepository(f.db, f.providers.auditAnchors, f.providers.auditKeys, scope, generations);
  return { ...f, operator, repository, setMode: (value: typeof mode) => { mode = value; },
    generation: () => generation };
}

test("bootstrapは監査、DB、保護generationを同じrevisionへ固定し、一回だけ受理する", t => {
  const f = bindingFixture(t);
  const binding = f.operator.change("bootstrap", "bootstrap", blank);
  assert.equal(binding.revision, 1);
  assert.equal(binding.status, "active");
  assert.deepEqual(f.repository.read(), binding);
  assert.equal(f.generation()?.revision, 1);
  assert.throws(() => f.operator.change("duplicate", "bootstrap", blank), SupervisorBindingError);
  assert.equal(f.repository.read()?.revision, 1);
  assert.equal(f.db.prepare("SELECT count(*) FROM approval_supervisor_bindings").pluck().get(), 1);
});

test("rotationとrevokeは単調revisionを保持し旧scopeのDB rowを再利用しない", t => {
  const f = bindingFixture(t);
  f.operator.change("bootstrap", "bootstrap", blank);
  const rotated = f.operator.change("rotate", "rotate", { ...blank, supervisor_user_id: "U456" });
  assert.equal(rotated.revision, 2);
  assert.equal(f.repository.read()?.supervisor_user_id, "U456");
  const revoked = f.operator.change("revoke", "revoke", { ...blank, supervisor_user_id: "U456" });
  assert.equal(revoked.revision, 3);
  assert.equal(revoked.status, "revoked");
  assert.throws(() => f.operator.change("rotate_again", "rotate", blank), SupervisorBindingError);
});

test("保護generationの拒否と応答喪失をDB成功へ変換せず、partial reservation後もfail closed", t => {
  for (const mode of ["deny", "after_reserve"] as const) {
    const f = bindingFixture(t);
    f.setMode(mode);
    assert.throws(() => f.operator.change(`bootstrap_${mode}`, "bootstrap", blank), SupervisorBindingError);
    assert.equal(f.db.prepare("SELECT count(*) FROM approval_supervisor_bindings").pluck().get(), 0);
    if (mode === "after_reserve") assert.throws(() => f.repository.read(), SupervisorBindingError);
  }
});

test("generation reserve後のSQLite障害は不整合として残り、自動bootstrapし直さない", t => {
  const f = bindingFixture(t);
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = ((sql: string) => {
    if (sql.startsWith("INSERT INTO main.approval_supervisor_bindings")) throw Error("fixture_sql_failure");
    return prepare(sql);
  }) as typeof f.db.prepare;
  t.after(() => { f.db.prepare = prepare; });
  assert.throws(() => f.operator.change("sql_failure", "bootstrap", blank), SupervisorBindingError);
  assert.equal(f.generation()?.revision, 1);
  assert.equal(prepare("SELECT count(*) FROM approval_supervisor_bindings").pluck().get(), 0);
  assert.throws(() => f.repository.read(), SupervisorBindingError);
  assert.throws(() => f.operator.change("blind_retry", "bootstrap", blank), SupervisorBindingError);
});

test("restoreされた旧DB、別instance、保護generation不整合を読取で拒否する", t => {
  const f = bindingFixture(t);
  f.operator.change("bootstrap", "bootstrap", blank);
  const other = new SupervisorBindingRepository(f.db, f.providers.auditAnchors, f.providers.auditKeys,
    { instance_id: "restored_elsewhere", workspace_id: scope.workspace_id }, { read: () => f.generation(), reserve: () => { throw Error(); } });
  assert.throws(() => other.read(), SupervisorBindingError);
  assert.throws(() => f.db.prepare("UPDATE approval_supervisor_bindings SET binding_json='{}' WHERE instance_id=? AND workspace_id=?")
    .run(scope.instance_id, scope.workspace_id));
});

test("break-glassは理由・scope・30分以内の期限を要求する", t => {
  const f = bindingFixture(t);
  f.operator.change("bootstrap", "bootstrap", blank);
  const proposal = { ...blank, reason: "Incident recovery", reason_digest: supervisorReasonDigest("Incident recovery"), operation_scope_digest: "b".repeat(64),
    target_scope_digest: "c".repeat(64), expires_at: "2026-09-19T00:30:00.000Z" };
  assert.throws(() => f.operator.change("too_long", "break_glass", { ...proposal, expires_at: "2026-09-19T00:30:01.000Z" }), SupervisorBindingError);
  assert.throws(() => f.operator.change("no_reason", "break_glass", { ...proposal, reason_digest: null }), SupervisorBindingError);
  const temporary = f.operator.change("temporary", "break_glass", proposal);
  assert.equal(temporary.status, "break_glass");
  assert.equal(temporary.expires_at, proposal.expires_at);
});

test("break-glassのoperation/target範囲と期限はstatus workerを待たず毎回検証する", t => {
  const f = bindingFixture(t);
  f.operator.change("bootstrap", "bootstrap", blank);
  const target = { channel_id: "C123", thread_ts: "1234567890.123456" };
  const temporary = f.operator.change("break_glass", "break_glass", { ...blank,
    supervisor_user_id: "U456", reason: "Incident recovery", reason_digest: supervisorReasonDigest("Incident recovery"),
    operation_scope_digest: supervisorOperationScopeDigest("slack.post_thread_reply.v1"),
    target_scope_digest: supervisorTargetScopeDigest(target), expires_at: "2026-09-19T00:30:00.000Z" });
  const guard = new SupervisorBindingGuard(f.repository, "primary", (binding, phase, transactionId, operationDigest, targetDigest) => ({
    transaction_id: transactionId, phase, instance_id: scope.instance_id, workspace_id: scope.workspace_id,
    alias: "primary", team_id: binding.team_id, user_id: binding.supervisor_user_id,
    active: true, can_approve: true, target_visible: true, shared: false,
    operation_scope_digest: operationDigest, target_scope_digest: targetDigest,
    observed_at: "2026-09-19T00:00:00.000Z", expires_at: "2026-09-19T00:30:00.000Z",
  }));
  const expected = { binding_id: supervisorBindingId(temporary), revision: temporary.revision, actor_id: "U456" };
  assert.equal(f.audit.readVerifiedState(state => guard.current(state, f.marks.read(), "decision", expected, target)), true);
  assert.equal(f.audit.readVerifiedState(state => guard.current(state, f.marks.read(), "decision", expected,
    { ...target, channel_id: "C999" })), false);
  const expired = { ...f.marks.read(), effective_utc: temporary.expires_at! };
  assert.equal(f.audit.readVerifiedState(state => guard.current(state, expired, "decision", expected, target)), false);
});

test("current accessはalias・team・user・receipt transaction・期限を照合する", t => {
  const f = bindingFixture(t);
  const binding = f.operator.change("bootstrap", "bootstrap", blank);
  const mark = f.marks.read();
  const target = { channel_id: "C123", thread_ts: "1234567890.123456" };
  let override: Partial<SupervisorAccessReceipt> = {};
  const guard = new SupervisorBindingGuard(f.repository, "primary", (_binding, phase, transactionId, operationDigest, targetDigest) => ({
    transaction_id: transactionId, phase, instance_id: scope.instance_id, workspace_id: scope.workspace_id,
    alias: "primary", team_id: binding.team_id, user_id: binding.supervisor_user_id,
    active: true, can_approve: true, target_visible: true, shared: false,
    operation_scope_digest: operationDigest, target_scope_digest: targetDigest,
    observed_at: mark.effective_utc, expires_at: "2026-09-19T00:00:30.000Z", ...override,
  }));
  const expected = { binding_id: supervisorBindingId(binding), revision: binding.revision, actor_id: binding.supervisor_user_id };
  const check = () => f.audit.readVerifiedState(state => guard.current(state, mark, "decision", expected, target));
  assert.equal(check(), true);
  for (const invalid of [
    { alias: "wrong" }, { team_id: "T456" }, { user_id: "U456" }, { active: false },
    { can_approve: false }, { target_visible: false }, { shared: true },
    { transaction_id: "replayed_old_receipt" }, { expires_at: mark.effective_utc },
  ]) { override = invalid; assert.equal(check(), false); }
  override = {};
  assert.equal(supervisorOperationScopeDigest("slack.post_thread_reply.v1").length, 64);
  assert.equal(supervisorTargetScopeDigest(target).length, 64);
  f.operator.change("rotate", "rotate", { ...blank, supervisor_user_id: "U456" });
  assert.equal(check(), false);
  const unavailable = new SupervisorBindingGuard(f.repository, "primary", () => { throw Error("provider_unavailable_private_value"); });
  assert.equal(f.audit.readVerifiedState(state => unavailable.current(state, mark, "decision", expected, target)), false);
});

test("Slack観測はoperation・target・phase・transactionに一致する場合だけreceiptへ変換する", t => {
  const f = bindingFixture(t);
  const binding = f.operator.change("bootstrap", "bootstrap", blank);
  const target = { channel_id: "C123", thread_ts: "1234567890.123456" };
  const observation = { transaction_id: "transaction", phase: "decision", instance_id: scope.instance_id,
    workspace_id: scope.workspace_id, alias: "primary", team_id: binding.team_id, user_id: binding.supervisor_user_id,
    operation_kind: "slack.post_thread_reply.v1", target, active: true, can_approve: true,
    target_visible: true, shared: false, observed_at: "2026-09-19T00:00:00.000Z",
    expires_at: "2026-09-19T00:00:30.000Z" };
  const key = { version: 1, secret: new Uint8Array(32).fill(7) };
  const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object" ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
  const sign = (value: any) => ({ key_version: key.version, observation: value,
    mac: createHmac("sha256", key.secret).update("dona.approval.access.v1\0")
      .update(canonical({ key_version: key.version, observation: value })).digest("hex") });
  const receipt = bindSupervisorAccessObservation(sign(observation), binding, "primary", "decision", "transaction", target, key);
  assert.equal(receipt.target_scope_digest, supervisorTargetScopeDigest(target));
  for (const changed of [ { transaction_id: "old" }, { phase: "consume" }, { team_id: "T999" },
    { target: { ...target, channel_id: "C999" } }, { operation_kind: "unsupported" } ])
    assert.throws(() => bindSupervisorAccessObservation(sign({ ...observation, ...changed }), binding, "primary", "decision", "transaction", target, key), SupervisorBindingError);
  assert.throws(() => bindSupervisorAccessObservation({ ...sign(observation), mac: "0".repeat(64) }, binding, "primary", "decision", "transaction", target, key), SupervisorBindingError);
});

test("operator proofの秘密はbinding行と監査recordへ保存しない", t => {
  const f = bindingFixture(t);
  const guarded = new SupervisorBindingOperator(f.db, f.providers, scope,
    { read: () => null, reserve: () => { throw Error(); } }, (action, transactionId, proposalDigest) => [
      { operator_id: "operatorA", credential_id: "hardwareA", credential_domain: "accountA", credential_kind: "hardware_backed",
        action, transaction_id: transactionId, proposal_digest: proposalDigest, secret: "credential_secret_fixture" },
      { operator_id: "operatorB", credential_id: "hardwareB", credential_domain: "accountB", credential_kind: "hardware_backed",
        action, transaction_id: transactionId, proposal_digest: proposalDigest },
    ] as never);
  assert.throws(() => guarded.change("bad_secret", "bootstrap", blank), SupervisorBindingError);
  assert.equal(f.db.prepare("SELECT count(*) FROM approval_supervisor_bindings").pluck().get(), 0);
  const stored = String(f.db.prepare("SELECT binding_json FROM approval_supervisor_bindings").pluck().get() ?? "");
  const audit = JSON.stringify(f.db.prepare("SELECT record_json FROM security_audit_records").all());
  assert.equal(stored.includes("credential_secret_fixture"), false);
  assert.equal(audit.includes("credential_secret_fixture"), false);
  assert.equal(audit.includes("Incident recovery"), false);
});

test("v6移行前に構築したbrokerもguardなしではrequestを作れない", t => {
  const f = bindingFixture(t);
  assert.throws(() => f.broker.create("legacy_create", intent), ApprovalCreateError);
  assert.equal(f.db.prepare("SELECT count(*) FROM approval_requests").pluck().get(), 0);
});

test("request作成はcurrent bindingとcurrent accessを通しrotation後の旧revisionを拒否する", t => {
  const f = bindingFixture(t);
  const binding = f.operator.change("bootstrap", "bootstrap", blank);
  let accessAvailable = true;
  const guard = new SupervisorBindingGuard(f.repository, "primary", (current, phase, transactionId, operationDigest, targetDigest) => ({
    transaction_id: transactionId, phase, instance_id: scope.instance_id, workspace_id: scope.workspace_id,
    alias: "primary", team_id: current.team_id, user_id: current.supervisor_user_id,
    active: accessAvailable, can_approve: true, target_visible: true, shared: false,
    operation_scope_digest: operationDigest, target_scope_digest: targetDigest,
    observed_at: f.marks.read().effective_utc,
    expires_at: new Date(Date.parse(f.marks.read().effective_utc) + 30_000).toISOString(),
  }));
  const original = grant(); original.binding_id = supervisorBindingId(binding);
  original.snapshot.preconditions.workspace_binding_revision = binding.revision;
  const broker = new ApprovalCreateBroker(f.db, f.providers, scope, () => original, f.lookup, guard);
  accessAvailable = false;
  assert.deepEqual(broker.create("unavailable", intent), { status: "denied", reason: "binding_revoked" });
  accessAvailable = true;
  assert.equal(broker.create("current", intent).status, "created");
  f.operator.change("rotate", "rotate", { ...blank, supervisor_user_id: "U456" });
  assert.deepEqual(broker.create("stale", intent), { status: "denied", reason: "binding_revoked" });
});

test("Keychain CAS adapterは初回genesisと次generationをbyte一致で進める", () => {
  let revision = 1, bytes = Buffer.from(bindingGenerationGenesis(scope));
  const response = (value: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
  const transport = { exchange(request: string): string {
    const input = JSON.parse(request);
    assert.equal(input.scope.purpose, "binding_generation");
    if (input.operation === "compare_exchange") {
      if (input.expected_revision !== revision || input.expected_value !== bytes.toString("base64"))
        return response({ codec_version: 1, status: "conflict" });
      revision++; bytes = Buffer.from(input.proposed_value, "base64");
      return response({ codec_version: 1, status: "changed", revision, value: bytes.toString("base64") });
    }
    return response({ codec_version: 1, status: "observed", revision, value: bytes.toString("base64") });
  } };
  const store = new KeychainBindingGenerations(scope, "ABCDEFGHIJ.dev.dona", transport);
  assert.equal(store.read(scope), null);
  const first = { revision: 1, digest: "a".repeat(64), transaction_id: "first" };
  assert.deepEqual(store.reserve(scope, null, first), first);
  assert.deepEqual(store.read(scope), first);
  assert.throws(() => store.reserve(scope, null, first), SupervisorBindingError);
  assert.throws(() => store.read({ ...scope, workspace_id: "other" }), SupervisorBindingError);
});

test("rotateがapproveより先ならpending requestをneeds_reviewに固定する", t => {
  const f = bindingFixture(t);
  const binding = f.operator.change("bootstrap", "bootstrap", blank);
  const guard = new SupervisorBindingGuard(f.repository, "primary", (current, phase, transactionId, operationDigest, targetDigest) => ({
    transaction_id: transactionId, phase, instance_id: scope.instance_id, workspace_id: scope.workspace_id,
    alias: "primary", team_id: current.team_id, user_id: current.supervisor_user_id,
    active: true, can_approve: true, target_visible: true, shared: false,
    operation_scope_digest: operationDigest, target_scope_digest: targetDigest,
    observed_at: f.marks.read().effective_utc,
    expires_at: new Date(Date.parse(f.marks.read().effective_utc) + 30_000).toISOString(),
  }));
  const g = grant(); g.binding_id = supervisorBindingId(binding);
  g.snapshot.preconditions.workspace_binding_revision = binding.revision;
  const create = new ApprovalCreateBroker(f.db, f.providers, scope, () => g, f.lookup, guard);
  const created = create.create("create_for_race", intent);
  if (created.status === "denied") throw Error();
  assert.equal(created.status, "created");
  const requestId = created.request_handle;
  const card = f.records.readAlias({ name: "notification_request_kind", request_id: requestId, notification_kind: "approval_card" });
  assert.equal(card?.kind, "notification"); if (card?.kind !== "notification") throw Error();
  const history = new ApprovalHistoryTransaction(f.db, f.providers, scope);
  const mutations = new ApprovalRecordMutation(f.db, scope);
  for (const phase of ["dispatching", "sent"] as const) history.runPrepared(`card_${phase}`, (mark, state) => {
    const old = f.records.readInState(state, "notification", card.row.notification_attempt_id)!;
    const request = f.records.readInState(state, "request", requestId)!;
    const changes = [{ previous: old, next: { ...old, row: { ...old.row, state: phase, fence: 1,
      message_ref: phase === "sent" ? "message_approval_card" : null } } },
      ...(phase === "sent" ? [{ previous: request, next: { ...request, row: { ...request.row, state: "sent" as const,
        revision: request.row.revision + 1 } } }] : [])];
    const event: Omit<AuditEvent, "occurred_at"> = { scope: { instance_id: scope.instance_id, tenant_id: scope.workspace_id },
      actor: { kind: "system", id: "fixture" }, action: "approval_delivery", operation: "slack.post_thread_reply.v1",
      resource_id: requestId, outcome: "succeeded", reason: "none", session_ref: null, receipt_id: null, attempt_id: null,
      policy_revision: request.row.policy_revision, binding_revision: request.row.binding_revision, authz_revision: 7 };
    return { event, ...mutations.prepare(mark, state, changes) };
  });
  const decision = new ApprovalDecisionBroker(f.db, f.providers, scope, (_command, request) => ({
    status: "verified", scope, request_id: requestId, actor_kind: "supervisor", actor_id: "U123",
    binding_id: request.row.binding_id, binding_revision: request.row.binding_revision,
    policy_revision: request.row.policy_revision, semantic_hash: request.row.semantic_hash,
    requester_authorization_revision: 7, presentation_ref: "message_approval_card", presentation_revision: 1,
    stale_reason: null,
  }), () => content, () => wrapping, () => notificationKey, guard);
  f.operator.change("rotate_before_approve", "rotate", { ...blank, supervisor_user_id: "U456" });
  assert.deepEqual(decision.decide("late_approve", { action: "approve", request_handle: requestId,
    authority_ref: "verified_inbox", expected_revision: 1, presentation_revision: 1 }),
    { status: "changed", request_state: "needs_review" });
  assert.equal(f.records.read("request", requestId)?.row.state, "needs_review");
  assert.equal(f.records.read("decision", requestId), null);
});
