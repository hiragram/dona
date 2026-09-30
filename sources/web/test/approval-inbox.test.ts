import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalInboxAdapter, ApprovalInboxUnavailable, approvalInboxView, encodeApprovalDisplay,
  assertApprovalDecisionCandidate, computeApprovalDisplayFingerprint, renderApprovalInboxPreview } from "../src/approval-inbox.js";
import { authorizeWebRoute, matchWebRoute } from "../src/routes.js";

const itemBase = {
  audience_principal_id: "principal_1", instance_id: "instance_1", tenant_id: "tenant_1",
  supervisor_binding_id: "binding_1", binding_revision: 2,
  request_id: "request_1", operation: "slack.post_thread_reply.v1" as const,
  requester: "依頼者", risk: "critical" as const, risk_reason: "明示mentionを含む外部投稿",
  opaque_action_id: "action_1", operation_summary: "限定された操作",
  exact_target: {workspace_id: "workspace_1", channel_id: "channel_1", thread_ts: "1730000000.000001", display_name: "対象_1"},
  exact_draft: "投稿本文", resolved_mentions: [{target_id: "user_1", display: "担当者"}],
  created_at: "2026-09-30T00:00:00.000Z", expires_at: "2026-09-30T00:15:00.000Z",
  request_revision: 1, presentation_ref: "presentation_1", presentation_revision: 2,
  display_codec_version: 1 as const, state: "pending" as const,
};
const withFingerprint = <T extends typeof itemBase>(value: T) =>
  ({...value, display_fingerprint: computeApprovalDisplayFingerprint({opaque_action_id: value.opaque_action_id,
    operation: value.operation, exact_target: value.exact_target, risk: value.risk,
    expires_at: value.expires_at, presentation_revision: value.presentation_revision})});
const item = withFingerprint(itemBase);
const readScope = {principal_id: "principal_1", instance_id: "instance_1", tenant_id: "tenant_1",
  workspace_id: "workspace_1", supervisor_binding_id: "binding_1", binding_revision: 2};
const listItem = {request_id: item.request_id, operation: item.operation, requester: item.requester,
  operation_summary: item.operation_summary, risk: item.risk,
  created_at: item.created_at, expires_at: item.expires_at, state: item.state};
const candidate = { codec_version: 1, display_codec_version: 1, request_id: item.request_id,
  operation: item.operation, decision: "approve", expected_request_revision: item.request_revision,
  expected_presentation_ref: item.presentation_ref, expected_presentation_revision: item.presentation_revision,
  expected_display_fingerprint: item.display_fingerprint, expected_challenge_ref: "challenge_1" };
const evidence = { principal_id: "principal_1", instance_id: "instance_1", tenant_id: "tenant_1", workspace_id: "workspace_1",
  supervisor_binding_id: "binding_1",
  binding_revision: 2, session_ref: "session_1", session_generation: 3, authz_revision: 4,
  role: "supervisor", step_up_verified: true, csrf_verified: true,
  request_id: item.request_id, operation: item.operation, decision: "approve", display_fingerprint: item.display_fingerprint,
  persisted_action_hash: "b".repeat(64), presentation_action_hash: "b".repeat(64), request_revision: 1, presentation_revision: 2,
  presentation_ref: item.presentation_ref, display_codec_version: 1, presentation_status: "synchronized_sent",
  audience_principal_id: "principal_1", policy_revision: 5, requester_authorization_revision: 6,
  challenge_ref: "challenge_1", challenge_state: "unused", challenge_created_at: "2026-09-30T00:09:00.000Z",
  challenge_expires_at: "2026-09-30T00:11:00.000Z",
  challenge_request_id: item.request_id, challenge_decision: "approve",
  challenge_action_hash: "b".repeat(64), challenge_display_fingerprint: item.display_fingerprint,
  challenge_presentation_revision: 2, challenge_principal_id: "principal_1", challenge_session_ref: "session_1",
  challenge_instance_id: "instance_1", challenge_tenant_id: "tenant_1", challenge_workspace_id: "workspace_1",
  challenge_supervisor_binding_id: "binding_1", challenge_binding_revision: 2,
  challenge_credential_id: "credential_1", challenge_credential_revision: 7, challenge_policy_revision: 5,
  credential_id: "credential_1", credential_revision: 7, credential_state: "active",
  credential_non_backup: true, user_verified: true, credential_stored_sign_count: 4, assertion_sign_count: 5,
  counter_unsupported_registration_proven: false, credential_counter_cas_succeeded: true,
  target_visible: true, target_shared: false, visibility_revision: 8, target_workspace_id: "workspace_1",
  persisted_resource_snapshot_hash: "c".repeat(64), current_resource_snapshot_hash: "c".repeat(64),
  created_at: item.created_at, expires_at: item.expires_at, state: "pending", consumed: false };
const scope = { principal_id: "principal_1", instance_id: "instance_1", tenant_id: "tenant_1", workspace_id: "workspace_1",
  supervisor_binding_id: "binding_1",
  binding_revision: 2, session_ref: "session_1", session_generation: 3, authz_revision: 4,
  policy_revision: 5, requester_authorization_revision: 6,
  challenge_ref: "challenge_1", credential_id: "credential_1", credential_revision: 7,
  credential_stored_sign_count: 4, visibility_revision: 8 };
const now = "2026-09-30T00:10:00.000Z";

test("approval list route requires bound supervisor read scope", () => {
  const route = matchWebRoute("GET", "/api/approvals?cursor=opaque");
  assert.equal(route.id, "approval_list");
  assert.deepEqual(authorizeWebRoute({role_ids: ["supervisor"], scopes: ["approval:read:bound"]}, route), {allowed: true});
  assert.deepEqual(authorizeWebRoute({role_ids: ["requester"], scopes: ["job:read:own"]}, route), {allowed: false, reason: "scope_denied"});
});

test("inbox stays unavailable without a verified authority and rejects unsafe projection", async () => {
  await assert.rejects(new ApprovalInboxAdapter().list(), ApprovalInboxUnavailable);
  const adapter = new ApprovalInboxAdapter({list: async () => ({codec_version: 1, items: [listItem], next_cursor: null}), detail: async () => ({codec_version: 1, item})});
  assert.deepEqual(await adapter.list(), {codec_version: 1, items: [listItem], next_cursor: null});
  assert.deepEqual(await adapter.detail(item.request_id, readScope), {codec_version: 1, item});
  await assert.rejects(adapter.detail("other", readScope), ApprovalInboxUnavailable);
  await assert.rejects(adapter.detail(item.request_id, {...readScope, workspace_id: "other"}), ApprovalInboxUnavailable);
  await assert.rejects(adapter.detail(item.request_id, {...readScope, principal_id: "other"}), ApprovalInboxUnavailable);
  const oldDetail = new ApprovalInboxAdapter({list: async () => ({codec_version: 1, items: [], next_cursor: null}),
    detail: async () => ({codec_version: 2, item})});
  await assert.rejects(oldDetail.detail(item.request_id, readScope), ApprovalInboxUnavailable);
  const leaking = new ApprovalInboxAdapter({list: async () => ({codec_version: 1, items: [{...listItem, exact_draft: "private"}], next_cursor: null}), detail: async () => item});
  await assert.rejects(leaking.list(), ApprovalInboxUnavailable);
  const duplicate = new ApprovalInboxAdapter({list: async () => ({codec_version: 1, items: [listItem, {...listItem}], next_cursor: null}), detail: async () => item});
  await assert.rejects(duplicate.list(), ApprovalInboxUnavailable);
});

test("inbox keeps a bounded continuation contract instead of hiding later requests", async () => {
  const next = "a".repeat(43);
  const seen: Array<string | null> = [];
  const first = Array.from({length: 50}, (_, index) => ({...listItem, request_id: `request_${index}`}));
  const adapter = new ApprovalInboxAdapter({list: async cursor => {
    seen.push(cursor);
    return cursor === null ? {codec_version: 1, items: first, next_cursor: next}
      : {codec_version: 1, items: [{...listItem, request_id: "request_50"}], next_cursor: null};
  }, detail: async () => item});
  const page = await adapter.list();
  assert.equal(page.items.length, 50);
  assert.equal(page.next_cursor, next);
  assert.equal((await adapter.list(page.next_cursor)).items[0]?.request_id, "request_50");
  assert.deepEqual(seen, [null, next]);
  await assert.rejects(adapter.list("malformed"), ApprovalInboxUnavailable);
  const oversized = new ApprovalInboxAdapter({list: async () => ({codec_version: 1,
    items: [...first, {...listItem, request_id: "request_50"}], next_cursor: null}), detail: async () => item});
  await assert.rejects(oversized.list(), ApprovalInboxUnavailable);
});

test("detail and confirmation disable stale or terminal requests", () => {
  assert.equal(approvalInboxView(item, now, readScope).canStartChallenge, true);
  assert.equal("candidate" in approvalInboxView(item, now, readScope), false);
  assert.equal(approvalInboxView(withFingerprint({...item, exact_target: {...item.exact_target, display_name: "対象😀"}}), now, readScope).exactTarget.display_name, "対象😀");
  assert.throws(() => approvalInboxView({...item, exact_target: {...item.exact_target, display_name: "別の対象"}}, now, readScope), ApprovalInboxUnavailable);
  assert.throws(() => approvalInboxView(item, now, {...readScope, principal_id: "other"}), ApprovalInboxUnavailable);
  assert.equal(approvalInboxView(item, item.expires_at, readScope).canStartChallenge, false);
  assert.equal(approvalInboxView(withFingerprint({...item, created_at: "2026-09-30T00:11:00.000Z"}), now, readScope).canStartChallenge, false);
  assert.equal(approvalInboxView({...item, state: "approved"}, now, readScope).canStartChallenge, false);
  assert.throws(() => approvalInboxView({...item, expires_at: "2026-09-30T00:15:00.001Z"}, now, readScope), ApprovalInboxUnavailable);
  assert.throws(() => approvalInboxView({...item, operation: "self_update.v1"}, now, readScope), ApprovalInboxUnavailable);
  assert.throws(() => approvalInboxView({...item, operation_summary: "unsafe\ntext"}, now, readScope), ApprovalInboxUnavailable);
  assert.equal(approvalInboxView(withFingerprint({...item, exact_target: {...item.exact_target, display_name: "safe\u202Eunsafe"}}), now, readScope).exactTarget.display_name, "safe\u202Eunsafe");
  assert.throws(() => approvalInboxView({...item, operation_summary: "操作  A"}, now, readScope), ApprovalInboxUnavailable);
  assert.throws(() => approvalInboxView({...item, operation_summary: " 操作"}, now, readScope), ApprovalInboxUnavailable);
  assert.throws(() => approvalInboxView({...item, exact_target: {...item.exact_target, display_name: "対象\ud800名"}}, now, readScope), ApprovalInboxUnavailable);
  assert.throws(() => approvalInboxView({...item, resolved_mentions: Array.from({length: 4}, (_, i) =>
    ({target_id: `user_${i}`, display: "担当者"}))}, now, readScope), ApprovalInboxUnavailable);
  assert.throws(() => approvalInboxView({...item, resolved_mentions: [item.resolved_mentions[0], item.resolved_mentions[0]]}, now, readScope), ApprovalInboxUnavailable);
});

test("preview escapes untrusted summary and never enables a decision", () => {
  const markup = renderApprovalInboxPreview({codec_version: 1, next_cursor: null, items: [{...listItem,
    operation_summary: '<img src=x onerror=alert(1)>'}]}, {codec_version: 1,
    item: {...item, operation_summary: '<img src=x onerror=alert(1)>'}}, now, readScope);
  assert.ok(markup.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!markup.includes('<img'));
  assert.ok(markup.includes('<button type="button" disabled>承認</button>'));
  assert.ok(!markup.includes("b".repeat(64)));
  assert.ok(markup.includes("<pre>対象_1</pre>"));
  assert.ok(markup.includes("channel_1"));
  assert.ok(markup.includes("1730000000.000001"));
  assert.ok(markup.includes("<pre>投稿本文</pre>"));
  assert.ok(markup.includes("<pre>担当者</pre> (user_1)"));
  assert.ok(markup.includes("action_1"));
  assert.ok(markup.includes("<dd>slack.post_thread_reply.v1</dd>"));
  assert.ok(markup.includes("明示mentionを含む外部投稿"));
  assert.ok(markup.includes("文字どおりのbackslash"));
  const futureList = renderApprovalInboxPreview({codec_version: 1, next_cursor: null,
    items: [{...listItem, created_at: "2026-09-30T00:11:00.000Z"}]}, null, now, readScope);
  assert.ok(futureList.includes("再確認が必要"));
  assert.ok(!futureList.includes("確認準備中"));
  const literal = renderApprovalInboxPreview({codec_version: 1, next_cursor: null, items: []},
    {codec_version: 1, item: withFingerprint({...item, exact_draft: "line1\nline2\\\t\u202E",
      exact_target: {...item.exact_target, display_name: "safe\u00A0unsafe"}})}, now, readScope);
  assert.ok(literal.includes("line1\\nline2\\\\\\t\\u{202E}"));
  assert.ok(literal.includes("safe\\u{00A0}unsafe"));
  assert.ok(!literal.includes("line1\nline2"));
  const spacedMention = renderApprovalInboxPreview({codec_version: 1, next_cursor: null, items: []},
    {codec_version: 1, item: {...item, resolved_mentions: [{target_id: "user_1", display: " 担当  者 "}]}}, now, readScope);
  assert.ok(spacedMention.includes("<pre> 担当  者 </pre>"));
  assert.equal(encodeApprovalDisplay("😀\\\n\t\u202E"), "😀\\\\\\n\\t\\u{202E}");
  const later = renderApprovalInboxPreview({codec_version: 1, next_cursor: null, items: []},
    {codec_version: 1, item: withFingerprint({...item, exact_target: {...item.exact_target, display_name: "次ページの対象"}})}, now, readScope);
  assert.ok(later.includes("次ページの対象"));
});

test("server preflight rejects forged, expired, consumed and cross-scope evidence", () => {
  assert.deepEqual(assertApprovalDecisionCandidate(candidate, evidence, scope, now), candidate);
  const noCounter = {...evidence, credential_stored_sign_count: 0, assertion_sign_count: 0,
    counter_unsupported_registration_proven: true};
  assert.deepEqual(assertApprovalDecisionCandidate(candidate, noCounter,
    {...scope, credential_stored_sign_count: 0}, now), candidate);
  assert.throws(() => assertApprovalDecisionCandidate(candidate,
    {...noCounter, counter_unsupported_registration_proven: false},
    {...scope, credential_stored_sign_count: 0}, now), ApprovalInboxUnavailable);
  for (const changed of [
    {...candidate, expected_display_fingerprint: "b".repeat(64)}, {...candidate, expected_request_revision: 2},
    {...candidate, expected_presentation_revision: 3}, {...candidate, expected_presentation_ref: "other"},
    {...candidate, expected_challenge_ref: "other"},
    {...candidate, display_codec_version: 2}, {...candidate, operation: "self_update.v1"},
    {...candidate, request_id: "other"},
  ]) assert.throws(() => assertApprovalDecisionCandidate(changed, evidence, scope, now), ApprovalInboxUnavailable);
  for (const changed of [
    {...evidence, decision: "reject"}, {...evidence, step_up_verified: false}, {...evidence, csrf_verified: false},
    {...evidence, persisted_action_hash: "c".repeat(64)},
    {...evidence, presentation_status: "delivery_pending"}, {...evidence, audience_principal_id: "other"},
    {...evidence, session_ref: "other"}, {...evidence, session_generation: 2}, {...evidence, authz_revision: 2},
    {...evidence, policy_revision: 4}, {...evidence, requester_authorization_revision: 5},
    {...evidence, challenge_state: "consumed"}, {...evidence, challenge_expires_at: now},
    {...evidence, challenge_created_at: "2026-09-30T00:08:59.999Z"},
    {...evidence, created_at: "2026-09-30T00:10:00.001Z", challenge_created_at: "2026-09-30T00:10:00.001Z"},
    {...evidence, challenge_expires_at: "2026-09-30T00:11:00.001Z"},
    {...evidence, challenge_action_hash: "d".repeat(64)},
    {...evidence, challenge_display_fingerprint: "d".repeat(64)},
    {...evidence, challenge_presentation_revision: 3},
    {...evidence, challenge_request_id: "other"}, {...evidence, challenge_decision: "reject"},
    {...evidence, challenge_supervisor_binding_id: "other"},
    {...evidence, challenge_credential_revision: 8},
    {...evidence, credential_revision: 8}, {...evidence, credential_state: "revoked"},
    {...evidence, assertion_sign_count: 4}, {...evidence, assertion_sign_count: 0},
    {...evidence, credential_counter_cas_succeeded: false},
    {...evidence, target_visible: false}, {...evidence, target_shared: true},
    {...evidence, target_workspace_id: "other"},
    {...evidence, visibility_revision: 9}, {...evidence, current_resource_snapshot_hash: "d".repeat(64)},
    {...evidence, expires_at: "2026-09-30T00:15:00.001Z"},
    {...evidence, consumed: true}, {...evidence, state: "approved"},
    {...evidence, tenant_id: "other"}, {...evidence, workspace_id: "other"},
    {...evidence, supervisor_binding_id: "other"}, {...evidence, binding_revision: 3},
  ]) assert.throws(() => assertApprovalDecisionCandidate(candidate, changed, scope, now), ApprovalInboxUnavailable);
  assert.throws(() => assertApprovalDecisionCandidate(candidate, evidence, scope, item.expires_at), ApprovalInboxUnavailable);
});
