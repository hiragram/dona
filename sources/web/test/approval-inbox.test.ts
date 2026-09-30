import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalInboxAdapter, ApprovalInboxUnavailable, approvalInboxView,
  assertApprovalDecisionCandidate, renderApprovalInboxPreview } from "../src/approval-inbox.js";
import { authorizeWebRoute, matchWebRoute } from "../src/routes.js";

const item = {
  request_id: "request_1", requester: "依頼者", risk: "critical" as const,
  operation_summary: "限定された操作", exact_target: "対象_1", display_fingerprint: "a".repeat(64),
  created_at: "2026-09-30T00:00:00.000Z", expires_at: "2026-09-30T00:15:00.000Z",
  revision: 1, state: "pending" as const,
};
const candidate = { codec_version: 1, request_id: item.request_id, decision: "approve",
  expected_revision: item.revision, expected_display_fingerprint: item.display_fingerprint };
const evidence = { principal_id: "principal_1", instance_id: "instance_1", tenant_id: "tenant_1",
  binding_revision: 2, role: "supervisor", step_up_verified: true, csrf_verified: true,
  request_id: item.request_id, display_fingerprint: item.display_fingerprint,
  persisted_action_hash: "b".repeat(64), presentation_action_hash: "b".repeat(64), revision: 1,
  expires_at: item.expires_at, state: "pending", consumed: false };
const scope = { principal_id: "principal_1", instance_id: "instance_1", tenant_id: "tenant_1", binding_revision: 2 };
const now = "2026-09-30T00:10:00.000Z";

test("approval list route requires bound supervisor read scope", () => {
  const route = matchWebRoute("GET", "/api/approvals");
  assert.equal(route.id, "approval_list");
  assert.deepEqual(authorizeWebRoute({role_ids: ["supervisor"], scopes: ["approval:read:bound"]}, route), {allowed: true});
  assert.deepEqual(authorizeWebRoute({role_ids: ["requester"], scopes: ["job:read:own"]}, route), {allowed: false, reason: "scope_denied"});
});

test("inbox stays unavailable without a verified authority and rejects unsafe projection", async () => {
  await assert.rejects(new ApprovalInboxAdapter().list(), ApprovalInboxUnavailable);
  const adapter = new ApprovalInboxAdapter({list: async () => ({codec_version: 1, items: [item]}), detail: async () => item});
  assert.deepEqual(await adapter.list(), [item]);
  assert.deepEqual(await adapter.detail(item.request_id), item);
  await assert.rejects(adapter.detail("other"), ApprovalInboxUnavailable);
  const leaking = new ApprovalInboxAdapter({list: async () => ({codec_version: 1, items: [{...item, secret: "private"}]}), detail: async () => item});
  await assert.rejects(leaking.list(), ApprovalInboxUnavailable);
});

test("detail and confirmation disable stale or terminal requests", () => {
  assert.equal(approvalInboxView(item, now).canConfirm, true);
  assert.equal(approvalInboxView(item, item.expires_at).canConfirm, false);
  assert.equal(approvalInboxView({...item, state: "approved"}, now).candidate, null);
  assert.throws(() => approvalInboxView({...item, operation_summary: "unsafe\ntext"}, now), ApprovalInboxUnavailable);
  assert.throws(() => approvalInboxView({...item, exact_target: "safe\u202Eunsafe"}, now), ApprovalInboxUnavailable);
});

test("preview escapes untrusted summary and never enables a decision", () => {
  const markup = renderApprovalInboxPreview({codec_version: 1, items: [{...item,
    operation_summary: '<img src=x onerror=alert(1)>'}]}, item.request_id, now);
  assert.ok(markup.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!markup.includes('<img'));
  assert.ok(markup.includes('<button type="button" disabled>承認</button>'));
  assert.ok(!markup.includes("b".repeat(64)));
});

test("server preflight rejects forged, expired, consumed and cross-scope evidence", () => {
  assert.deepEqual(assertApprovalDecisionCandidate(candidate, evidence, scope, now), candidate);
  for (const changed of [
    {...candidate, expected_display_fingerprint: "b".repeat(64)}, {...candidate, expected_revision: 2},
    {...candidate, request_id: "other"},
  ]) assert.throws(() => assertApprovalDecisionCandidate(changed, evidence, scope, now), ApprovalInboxUnavailable);
  for (const changed of [
    {...evidence, step_up_verified: false}, {...evidence, csrf_verified: false},
    {...evidence, persisted_action_hash: "c".repeat(64)},
    {...evidence, consumed: true}, {...evidence, state: "approved"},
    {...evidence, tenant_id: "other"}, {...evidence, binding_revision: 3},
  ]) assert.throws(() => assertApprovalDecisionCandidate(candidate, changed, scope, now), ApprovalInboxUnavailable);
  assert.throws(() => assertApprovalDecisionCandidate(candidate, evidence, scope, item.expires_at), ApprovalInboxUnavailable);
});
