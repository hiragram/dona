import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, test } from "node:test";
import Database from "better-sqlite3";

import { signAuditCheckpoint, type AuditAnchor, type AuditEvent, type AuditKey } from "../src/audit/codec.js";
import { AuditRepository, installAuditSchema, type AuditAnchorStore } from "../src/audit/repository.js";
import { DispatcherDatabase } from "../src/database.js";
import { JobAuthorizationBindingRepository, TaskBindingConflictError, type TaskBindingEvidenceVerifier, type VerifiedTaskBindingEvidence } from "../src/job-authorization-binding.js";
import type { VerifiedSlackPrincipalProof } from "../src/principal-proof.js";
import { eventEnvelope, tempConfig } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))));

function proof(externalEventId: string): VerifiedSlackPrincipalProof {
  return {
    version: 1, key_id: "sha256:0123456789abcdef", event_id: externalEventId, attempt: 1,
    tenant_id: "T_TEST", workspace_id: "T_TEST", principal_kind: "human", principal_id: "U_TEST",
    issued_at: "2026-09-21T00:00:00.000Z", expires_at: "2026-09-21T00:15:00.000Z",
    nonce: `nonce-${createHash("sha256").update(externalEventId).digest("hex").slice(0, 24)}`,
    adapter_id: "slack_socket:T_TEST", proof_sha256: createHash("sha256").update(externalEventId).digest("hex"),
  };
}

const verifier: TaskBindingEvidenceVerifier = {
  verify(input) {
    const wrapper = input as { provider_verified?: unknown; evidence?: VerifiedTaskBindingEvidence };
    if (wrapper.provider_verified !== true || !wrapper.evidence) throw new Error("provider_verification_failed");
    return wrapper.evidence;
  },
};
const auditEvents: AuditEvent[] = [];
const audit = {
  append<T>(_transactionId: string, _keyVersion: number, event: AuditEvent, mutation: () => T) {
    auditEvents.push(event);
    return { record: {} as never, result: mutation() };
  },
} as Pick<AuditRepository, "append">;
const auditContext = { instance_id: "dispatcher_test", transaction_id: "bind_transaction_1", key_version: 1 };

const auditKey: AuditKey = { version: 1, purpose: "audit", state: "active",
  activated_at: "2026-09-01T00:00:00.000Z", signing_expires_at: "2026-11-01T00:00:00.000Z",
  secret: Buffer.alloc(32, 0x51) };
const auditKeys = (version: number) => version === 1 ? auditKey : undefined;

function evidence(sourceEventId: string, suffix = "1", resourceRevision = 3): VerifiedTaskBindingEvidence {
  return {
    evidence_sha256: suffix.padStart(64, "0"), source_event_id: sourceEventId,
    authorization_principal_event_id: sourceEventId, tenant_id: "T_TEST", workspace_id: "T_TEST",
    principal_kind: "human", principal_id: "U_TEST", permission: "bind_exact_task",
    verified_at: "2026-09-21T00:01:00.000Z", expires_at: "2026-09-21T00:03:00.000Z",
    task: { provider: "github", repository_node_id: "R_kgDOULBeiA", task_node_id: "I_kwDOULBeiM7task1",
      task_number: 164, resource_revision: resourceRevision },
  };
}

test("new jobはverified principal、ingress、origin、exact GitHub taskを同一transactionで固定する", async () => {
  const { root, config } = await tempConfig(); roots.push(root);
  const database = new DispatcherDatabase(config.databasePath);
  const envelope = eventEnvelope("Ev-job-binding");
  const source = database.enqueue(envelope, new Date("2026-09-21T00:01:00.000Z"), proof(envelope.external_event_id)).row;
  const first = database.jobAuthorization.bindEventTask(source.event_id, 0,
    { provider_verified: true, evidence: evidence(source.event_id) }, verifier, audit, auditContext,
    new Date("2026-09-21T00:01:30.000Z"));
  assert.equal(first.binding_revision, 1);
  assert.equal(auditEvents.at(-1)?.action, "binding_change");
  const job = database.createJob({ source_event_id: source.event_id, job_key: "exact-task", objective: "確認する",
    workspace: { kind: "github", repository: "hiragram/dona", base_ref: "main" } },
  config.jobsWorkspaceRoot, config.jobResultsDir, new Date("2026-09-21T00:02:00.000Z")).row;
  const binding = database.jobAuthorization.readJob(job.job_id)!;
  assert.deepEqual({ owner: binding.owner_kind, principal: binding.principal_id, proof: binding.ingress_proof_sha256,
    resource: binding.resource_kind, repo: binding.repository_node_id, task: binding.task_node_id,
    resourceRevision: binding.resource_revision, policyRevision: binding.policy_revision,
    bindingRevision: binding.binding_revision, taskBindingRevision: binding.task_binding_revision }, {
    owner: "human_verified", principal: "U_TEST", proof: proof(envelope.external_event_id).proof_sha256,
    resource: "github_issue", repo: "R_kgDOULBeiA", task: "I_kwDOULBeiM7task1",
    resourceRevision: 3, policyRevision: 1, bindingRevision: 1, taskBindingRevision: 1,
  });
  assert.equal(JSON.parse(binding.disclosure_origin_json).destination.kind, "slack_thread");
  database.jobAuthorization.bindEventTask(source.event_id, 1,
    { provider_verified: true, evidence: evidence(source.event_id, "5", 4) }, verifier, audit,
    { ...auditContext, transaction_id: "bind_transaction_snapshot_2" }, new Date("2026-09-21T00:02:01.000Z"));
  assert.equal(database.jobAuthorization.readJob(job.job_id)?.resource_revision, 3);
  database.close();
});

test("共有auditのDB外CASとtask bindingを同じtransactionで確定する", async () => {
  const { root, config } = await tempConfig(); roots.push(root);
  let dispatcher = new DispatcherDatabase(config.databasePath);
  const envelope = eventEnvelope("Ev-task-audit");
  const source = dispatcher.enqueue(envelope, new Date("2026-09-21T00:01:00.000Z"), proof(envelope.external_event_id)).row;
  dispatcher.close();
  const db = new Database(config.databasePath); db.pragma("foreign_keys = ON"); installAuditSchema(db);
  const checkpoint = signAuditCheckpoint({ codec_version: 1, chain_id: "task_binding_chain",
    transaction_id: "task_binding_genesis", signed_at: "2026-09-21T00:00:00.000Z", key_version: 1 }, auditKeys);
  class Store implements AuditAnchorStore {
    value: AuditAnchor = { chain_id: "task_binding_chain", sequence: 0, mac: "0".repeat(64),
      checkpoint_mac: checkpoint.mac, pending_transaction_id: null };
    read() { return structuredClone(this.value); }
    reserve(expected: AuditAnchor, proposed: AuditAnchor) { assert.deepEqual(this.value, expected); this.value = structuredClone(proposed); return this.read(); }
    finalize(reservation: AuditAnchor) { assert.deepEqual(this.value, reservation); this.value = { ...this.value, pending_transaction_id: null }; return this.read(); }
  }
  const auditStore = new Store(); const realAudit = new AuditRepository(db, auditStore, auditKeys);
  realAudit.initialize(checkpoint);
  const bindings = new JobAuthorizationBindingRepository(db);
  const bound = bindings.bindEventTask(source.event_id, 0, { provider_verified: true, evidence: evidence(source.event_id) },
    verifier, realAudit, { ...auditContext, transaction_id: "bind_with_shared_audit" }, new Date("2026-09-21T00:01:30.000Z"));
  assert.equal(bound.binding_revision, 1); assert.equal(realAudit.verify().sequence, 1);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  db.close();
  dispatcher = new DispatcherDatabase(config.databasePath);
  assert.equal(dispatcher.jobAuthorization.readEventTask(source.event_id)?.task_number, 164);
  dispatcher.close();
});

test("exact task bindingはretry-stableでCAS競合、別task、旧revisionを拒否する", async () => {
  const { root, config } = await tempConfig(); roots.push(root);
  const database = new DispatcherDatabase(config.databasePath);
  const envelope = eventEnvelope("Ev-task-cas");
  const source = database.enqueue(envelope, new Date("2026-09-21T00:01:00.000Z"), proof(envelope.external_event_id)).row;
  const wrapped = { provider_verified: true, evidence: evidence(source.event_id) };
  const first = database.jobAuthorization.bindEventTask(source.event_id, 0, wrapped, verifier, audit, auditContext,
    new Date("2026-09-21T00:01:30.000Z"));
  assert.deepEqual(database.jobAuthorization.bindEventTask(source.event_id, 0, wrapped, verifier,
    audit, auditContext, new Date("2026-09-21T00:01:31.000Z")), first);
  const competing = new DispatcherDatabase(config.databasePath);
  const updated = database.jobAuthorization.bindEventTask(source.event_id, 1,
    { provider_verified: true, evidence: evidence(source.event_id, "2", 4) }, verifier, audit,
    { ...auditContext, transaction_id: "bind_transaction_2" }, new Date("2026-09-21T00:01:40.000Z"));
  assert.equal(updated.binding_revision, 2);
  assert.throws(() => competing.jobAuthorization.bindEventTask(source.event_id, 1,
    { provider_verified: true, evidence: evidence(source.event_id, "3", 5) }, verifier,
    audit, { ...auditContext, transaction_id: "bind_transaction_3" },
    new Date("2026-09-21T00:01:41.000Z")), TaskBindingConflictError);
  const otherTask = evidence(source.event_id, "4", 5); otherTask.task.task_node_id = "I_kwDOULBeiM7task2";
  assert.throws(() => database.jobAuthorization.bindEventTask(source.event_id, 2,
    { provider_verified: true, evidence: otherTask }, verifier, audit,
    { ...auditContext, transaction_id: "bind_transaction_4" },
    new Date("2026-09-21T00:01:42.000Z")), TaskBindingConflictError);
  competing.close(); database.close();
});

test("legacy jobはactorをownerへ推測せずunknownのままreopenする", async () => {
  const { root, config } = await tempConfig(); roots.push(root);
  let database = new DispatcherDatabase(config.databasePath);
  const source = database.enqueue(eventEnvelope("Ev-job-binding-legacy")).row;
  const job = database.createJob({ source_event_id: source.event_id, objective: "legacy", workspace: { kind: "scratch" } },
    config.jobsWorkspaceRoot, config.jobResultsDir).row;
  assert.equal(database.jobAuthorization.readJob(job.job_id)?.owner_kind, "unknown");
  assert.equal(database.jobAuthorization.readJob(job.job_id)?.principal_id, null);
  database.close();
  database = new DispatcherDatabase(config.databasePath);
  assert.equal(database.jobAuthorization.readJob(job.job_id)?.resource_kind, "unknown");
  database.close();
});

test("provider未検証、permission不一致、URL形式identityをfail-closedにする", async () => {
  const { root, config } = await tempConfig(); roots.push(root);
  const database = new DispatcherDatabase(config.databasePath);
  const envelope = eventEnvelope("Ev-task-deny");
  const source = database.enqueue(envelope, new Date("2026-09-21T00:01:00.000Z"), proof(envelope.external_event_id)).row;
  assert.throws(() => database.jobAuthorization.bindEventTask(source.event_id, 0,
    { provider_verified: false, evidence: evidence(source.event_id) }, verifier, audit, auditContext,
    new Date("2026-09-21T00:01:30.000Z")));
  const forged = evidence(source.event_id); forged.task.task_node_id = "https://github.com/hiragram/dona/issues/164";
  assert.throws(() => database.jobAuthorization.bindEventTask(source.event_id, 0,
    { provider_verified: true, evidence: forged }, verifier, audit, auditContext,
    new Date("2026-09-21T00:01:30.000Z")));
  const wrongPermission = { ...evidence(source.event_id), permission: "read_task" };
  assert.throws(() => database.jobAuthorization.bindEventTask(source.event_id, 0,
    { provider_verified: true, evidence: wrongPermission }, verifier, audit, auditContext,
    new Date("2026-09-21T00:01:30.000Z")));
  database.close();
});
