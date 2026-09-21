import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentReadAuthorization,
  agentReadGrantOperations,
  projectAuthorizedJob,
  projectCompletionJob,
  type AgentReadDenyReason,
} from "../src/agent-read-authorization.js";
import type { AgentExecutionContext } from "../src/agent-context.js";
import type { JobAuthorizationBindingRow } from "../src/job-authorization-binding.js";
import type { JobRow } from "../src/types.js";

const context: AgentExecutionContext = {
  event_id: "evt_01J00000000000000000000000", attempt: 1, purpose: "human_command",
  tenant_id: "tenant-a", workspace_id: "workspace-a", principal_kind: "human", principal_id: "user-a",
  expires_at: "2026-09-21T01:00:00.000Z", policy_revision: 1,
};

const privateCanary = "PRIVATE-CANARY-objective-result-error";
const job = {
  job_id: "job_01j00000000000000000000000", source_event_id: "evt_01J00000000000000000000000",
  job_key: "one", source: "slack", workspace_id: "workspace-a", channel_id: "private-channel", thread_ts: "1.1",
  actor_id: "forged-user", objective: privateCanary, workspace_json: `{"secret":"${privateCanary}"}`, status: "blocked",
  attempt_count: 1, available_at: "2026-09-21T00:00:00.000Z", workspace_path: `/tmp/${privateCanary}`,
  result_path: `/tmp/${privateCanary}.json`, herdr_workspace_id: privateCanary, herdr_pane_id: privateCanary,
  agent_name: privateCanary, dispatch_started_at: null, prompt_accepted_at: null, completed_at: null,
  result_json: `{"summary":"${privateCanary}"}`, completion_event_id: null, steer_event_id: null, steer_state: null,
  last_error_code: "agent_waiting", last_error_message: privateCanary,
  created_at: "2026-09-21T00:00:00.000Z", updated_at: "2026-09-21T00:00:00.000Z",
} satisfies JobRow;

const binding = {
  job_id: job.job_id, source_event_id: job.source_event_id, owner_kind: "human_verified",
  principal_binding_event_id: job.source_event_id, ingress_proof_sha256: "a".repeat(64), tenant_id: "tenant-a",
  workspace_id: "workspace-a", principal_kind: "human", principal_id: "user-a",
  disclosure_origin_json: JSON.stringify({ kind: "event_destination", destination: { kind: "channel", channel_id: "private-channel" } }),
  resource_kind: "github_issue", repository_node_id: "repository1", task_node_id: "issue0001", task_number: 166,
  resource_revision: 3, policy_revision: 1, binding_revision: 1, task_binding_revision: 1,
  created_at: "2026-09-21T00:00:00.000Z",
} satisfies JobAuthorizationBindingRow;

const destination = { workspace_id: "workspace-a", channel_id: "private-channel", thread_ts: "2.2" };

test("共通read policyはauthorityとdisclosureを別判定しtyped portを既定拒否する", () => {
  assert.deepEqual(agentReadGrantOperations, ["read_own_human_waits", "read_exact_job_status", "read_bounded_result", "resolve_origin_ref"]);
  const denied = new AgentReadAuthorization().authorize({ context, operation: "read_exact_job_status", surface: "get_job_status", job, binding, owner_binding_current: true, disclosure_destination: destination });
  assert.deepEqual(denied, {
    allowed: false,
    authority: { allowed: false, reason: "grant_unavailable" },
    disclosure: { allowed: false, reason: "grant_unavailable" },
  });

  const grantOnly = new AgentReadAuthorization({ authorize: () => true }).authorize({
    context, operation: "read_exact_job_status", surface: "get_job_status", job, binding, owner_binding_current: true, disclosure_destination: destination,
  });
  assert.equal(grantOnly.authority.allowed, true);
  assert.deepEqual(grantOnly.disclosure, { allowed: false, reason: "visibility_unavailable" });
});

test("principal/workspace/owner/policy不一致をgrantより先に拒否する", () => {
  let grantCalls = 0;
  const decisions: AgentReadDenyReason[] = [];
  const authorize = (changedContext: AgentExecutionContext, changedBinding: JobAuthorizationBindingRow, changedJob: JobRow = job) => {
    const result = new AgentReadAuthorization({ authorize: () => { grantCalls++; return true; } }, { authorize: () => true }).authorize({
      context: changedContext, operation: "read_exact_job_status", surface: "list_owner_jobs", job: changedJob, binding: changedBinding, owner_binding_current: true, disclosure_destination: destination,
    });
    decisions.push(result.authority.reason as AgentReadDenyReason);
  };
  authorize({ ...context, principal_id: "user-b" }, binding);
  authorize({ ...context, workspace_id: "workspace-b" }, binding);
  authorize(context, { ...binding, owner_kind: "unknown", principal_kind: null, principal_id: null });
  authorize(context, { ...binding, policy_revision: 2 });
  authorize(context, binding, { ...job, workspace_id: "workspace-b" });
  assert.deepEqual(decisions, ["principal_mismatch", "workspace_mismatch", "owner_not_human", "policy_revision_mismatch", "workspace_mismatch"]);
  assert.equal(grantCalls, 0);
  const revoked = new AgentReadAuthorization({ authorize: () => true }, { authorize: () => true }).authorize({
    context, operation: "read_exact_job_status", surface: "get_job_status", job, binding, owner_binding_current: false, disclosure_destination: destination,
  });
  assert.equal(revoked.authority.reason, "binding_unavailable");
});

test("current visibilityを投影直前ごとに再評価しprivateから別channelを自動許可しない", () => {
  let current = true;
  let calls = 0;
  const policy = new AgentReadAuthorization({ authorize: () => true }, {
    authorize: input => {
      calls++;
      const origin = input.disclosure_origin as { destination?: { channel_id?: string } };
      const target = input.disclosure_destination as { channel_id?: string };
      return current && origin.destination?.channel_id === target.channel_id;
    },
  });
  assert.equal(policy.authorize({ context, operation: "read_exact_job_status", surface: "get_job_status", job, binding, owner_binding_current: true, disclosure_destination: destination }).allowed, true);
  current = false;
  assert.equal(policy.authorize({ context, operation: "read_exact_job_status", surface: "get_job_status", job, binding, owner_binding_current: true, disclosure_destination: destination }).allowed, false);
  assert.equal(policy.authorize({ context, operation: "read_exact_job_status", surface: "get_job_status", job, binding,
    owner_binding_current: true,
    disclosure_destination: { ...destination, channel_id: "public-channel" } }).allowed, false);
  assert.equal(calls, 3);
});

test("allowlist projectionはraw row、Result、自由文error、runtime identityを含めない", () => {
  const external = projectAuthorizedJob(job);
  const internal = projectCompletionJob(job);
  for (const projection of [external, internal]) {
    const encoded = JSON.stringify(projection);
    assert.doesNotMatch(encoded, /PRIVATE-CANARY/);
    assert.equal("result_json" in projection, false);
    assert.equal("objective" in projection, false);
    assert.equal("last_error_message" in projection, false);
    assert.equal("workspace_path" in projection, false);
  }
  assert.equal(external.last_error_code, "agent_waiting");
  assert.equal(internal.last_error_code, undefined);
});

test("restricted auditはdecision codeだけを受け取りprivate canaryを含まない", () => {
  const audit: unknown[] = [];
  const policy = new AgentReadAuthorization({ authorize: () => true }, { authorize: () => false }, { record: value => audit.push(value) });
  policy.authorize({ context, operation: "read_exact_job_status", surface: "get_job_status", job, binding, owner_binding_current: true, disclosure_destination: destination });
  assert.equal(audit.length, 1);
  assert.doesNotMatch(JSON.stringify(audit), /PRIVATE-CANARY/);
  assert.match(JSON.stringify(audit), /visibility_unavailable/);
});

test("grant/visibility/audit port障害は例外差を出さずfail closedにする", () => {
  const throwing = () => { throw new Error(privateCanary); };
  const grantFailure = new AgentReadAuthorization({ authorize: throwing }, { authorize: () => true }).authorize({
    context, operation: "read_exact_job_status", surface: "get_job_status", job, binding, owner_binding_current: true, disclosure_destination: destination,
  });
  assert.equal(grantFailure.allowed, false);
  assert.equal(grantFailure.authority.reason, "grant_unavailable");
  const visibilityFailure = new AgentReadAuthorization({ authorize: () => true }, { authorize: throwing }).authorize({
    context, operation: "read_exact_job_status", surface: "get_job_status", job, binding, owner_binding_current: true, disclosure_destination: destination,
  });
  assert.equal(visibilityFailure.disclosure.reason, "visibility_unavailable");
  const auditFailure = new AgentReadAuthorization({ authorize: () => true }, { authorize: () => true }, { record: throwing }).authorize({
    context, operation: "read_exact_job_status", surface: "get_job_status", job, binding, owner_binding_current: true, disclosure_destination: destination,
  });
  assert.equal(auditFailure.disclosure.reason, "audit_unavailable");
  assert.equal(auditFailure.allowed, false);
  assert.doesNotMatch(JSON.stringify([grantFailure, visibilityFailure, auditFailure]), /PRIVATE-CANARY/);
});
