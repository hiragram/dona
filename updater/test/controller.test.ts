import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { releaseCompatibilityMatches, UpdateController } from "../src/controller.js";
import { UpdateDatabase } from "../src/database.js";
import type { BuildPort, DispatcherPort, GitPort, RuntimePort } from "../src/ports.js";
import { ReleaseStore } from "../src/release-store.js";
import type {
  CommandResult,
  Compatibility,
  CompletionDeliveryResult,
  CompletionLookupResult,
  DrainSnapshot,
  HealthSnapshot,
  MainAgentObservation,
  OutboxRow,
  SchemaRollout,
} from "../src/types.js";
import { currentSha, installPointers, logger, manifest, removeTree, targetSha, tempPolicy } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeTree)));

const sourceEventId = "evt_01M1ES03XY5CF8D9PM5CWX4SRV";
const approvalEventId = "evt_01M1ES03XY5CF8D9PM5CWX4SRW";
const replyTarget = { kind: "slack_thread" as const, workspace_id: "T_TEST", channel_id: "C_TEST", thread_ts: "1756722030.123456" };
const ok: CommandResult = { exit_code: 0, stdout: "", stderr: "", timed_out: false, output_truncated: false };

test("requires a v2/v3 compatibility bridge before a schema-v3 writing release", () => {
  const schemaV2 = {
    protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 2,
    app_schema_write: 2, rollback_safe: true,
  };
  const bridge = { ...schemaV2, app_schema_read_max: 3 };
  const schemaV3 = { ...bridge, app_schema_write: 3 };
  assert.equal(releaseCompatibilityMatches(schemaV2, schemaV3), false);
  assert.equal(releaseCompatibilityMatches(schemaV2, bridge), true);
  assert.equal(releaseCompatibilityMatches(bridge, schemaV3), true);
  assert.equal(releaseCompatibilityMatches(schemaV3, bridge), true);
});

test("refuses schema-v3 planning without an exact stable updater migration capability receipt", async () => {
  const f = await fixture();
  const bridgeCompatibility: Compatibility = {
    protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 3,
    app_schema_write: 2, rollback_safe: true,
  };
  const activationCompatibility: Compatibility = { ...bridgeCompatibility, app_schema_write: 3 };
  await fs.writeFile(path.join(f.policy.release_root, currentSha, "release-manifest.json"),
    `${JSON.stringify({ ...manifest(currentSha), compatibility: bridgeCompatibility })}\n`);
  f.policy.compatibility = activationCompatibility;
  f.git.targetCompatibility = activationCompatibility;
  f.git.targetRollout = {
    schema_version: 1,
    phase: "bootstrap",
    database_schema: 2,
    multi_job_enabled: false,
    capabilities: ["schema_v3_read", "schema_v3_backup_restore"],
  };
  await assert.rejects(
    f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget }),
    /target_schema_rollout_does_not_match_activation_contract/,
  );
  f.git.targetRollout = new FakeGit().targetRollout;
  f.runtime.schemaMigrationReady = false;
  await assert.rejects(
    f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget }),
    /stable_updater_exact_target_schema_migration_capability_required/,
  );
  f.runtime.schemaMigrationReady = true;
  f.runtime.schemaMigrationBuildSha = "3".repeat(40);
  await assert.rejects(
    f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget }),
    /stable_updater_exact_target_schema_migration_capability_required/,
  );
  assert.equal(f.database.list().length, 0);
  f.database.close();
});

class FakeGit implements GitPort {
  targetCompatibility: Compatibility = {
    protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 2,
    app_schema_write: 2, rollback_safe: true,
  };
  targetRollout: SchemaRollout = {
    schema_version: 1,
    phase: "activation",
    database_schema: 3,
    multi_job_enabled: true,
    previous_release_sha: "61bc86f71726ce1f44fc3500e524203626cf869a",
    previous_release_contract: "release-compatibility.v2-v3-bridge.json",
    required_control_plane_capability: "dispatcher_v2_to_v3_online_backup_v1",
    migration: {
      from_schema: 2,
      to_schema: 3,
      requires_quiesce: true,
      requires_drain: true,
      backup: "sqlite_online_backup",
      restore_open_test: true,
    },
  };
  constructor(readonly target = targetSha, readonly reachable = true) {}
  async refresh(current: string) {
    return {
      current_sha: current,
      target_sha: this.target,
      target_reachable: this.reachable,
      ci_trusted: true,
      target_compatibility: this.targetCompatibility,
      target_rollout: this.targetRollout,
    };
  }
  async stage(target: string, destination: string) {
    assert.equal(target, this.target);
    await fs.writeFile(path.join(destination, "app.js"), "export {};\n", { mode: 0o600 });
  }
  async verifyStaged() {}
}

class FakeBuild implements BuildPort {
  fail = false;
  compatibility: Compatibility = {
    protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 2,
    app_schema_write: 2, rollback_safe: true,
  };
  async toolchain() { return { node_version: process.versions.node, npm_version: "11.0.0" }; }
  async buildRelease() {
    if (this.fail) throw new Error("canonical tests failed");
    return {
      lock_hashes: { dispatcher: "a".repeat(64), "sources/slack": "b".repeat(64), updater: "c".repeat(64) },
      node_version: process.versions.node,
      npm_version: "11.0.0",
      compatibility: this.compatibility,
    };
  }
}

class FakeDispatcher implements DispatcherPort {
  terminal = false;
  safe = true;
  delivery: CompletionDeliveryResult = { outcome: "accepted", event_id: "evt_update_terminal" };
  exists = false;
  completionStatus = "queued";
  lastTerminalEventId: string | undefined;
  async eventTerminal(eventId: string) { this.lastTerminalEventId = eventId; return this.terminal; }
  async safetyStatus() { return { safe: this.safe, unsafe_states: this.safe ? [] : ["jobs.cancelling:1"] }; }
  async deliverCompletion(_outbox: OutboxRow) { return this.delivery; }
  async completionLookup(): Promise<CompletionLookupResult> {
    return this.exists
      ? { outcome: "exists", event_id: "evt_update_terminal", status: this.completionStatus }
      : { outcome: "absent" };
  }
}

class FakeRuntime implements RuntimePort {
  readonly calls: string[] = [];
  schemaMigrationReady = true;
  schemaMigrationBuildSha = targetSha;
  async schemaMigrationCapability() {
    this.calls.push("schemaMigrationCapability");
    return { ready: this.schemaMigrationReady, build_sha: this.schemaMigrationReady ? this.schemaMigrationBuildSha : null };
  }
  async migrateAppSchema() { this.calls.push("migrateAppSchema"); return ok; }
  wrongTargetOnce = false;
  wrongSlackOnce = false;
  dispatcherStartUnknownOnce = false;
  mainWaitStatus: MainAgentObservation["status"] = "idle";
  mainObserveStatus: MainAgentObservation["status"] = "idle";
  mainStopOutcome: "stopped" | "rejected" | "accepted_unknown" = "stopped";
  mainStartUnknownOnce = false;
  previousMainStartUnknownOnce = false;
  notificationProtocolReady = true;
  actualAppSchema = 2;
  afterSlackStart: (() => Promise<void>) | undefined;
  private readonly healthCompatibility = new Map<string, Compatibility>();
  private mainAgentExists = true;
  private dispatcherLive = true;
  private slackLive = true;
  mainAgentSha = currentSha;
  constructor(
    private readonly store: ReleaseStore,
    private readonly policySha: () => string,
    private readonly releaseRoot: string,
  ) {}
  simulateStoppedRuntime(): void {
    this.mainAgentExists = false;
    this.dispatcherLive = false;
    this.slackLive = false;
  }
  setHealthCompatibility(sha: string, compatibility: Compatibility): void {
    this.healthCompatibility.set(sha, compatibility);
  }
  async quiesceSlack(): Promise<DrainSnapshot> { this.calls.push("quiesceSlack"); return { service: "slack_adapter", quiescing: true, drained: true, in_flight: 0, unsafe_states: [] }; }
  async quiesceDispatcher(): Promise<DrainSnapshot> { this.calls.push("quiesceDispatcher"); return { service: "dispatcher", quiescing: true, drained: true, in_flight: 0, unsafe_states: [] }; }
  async stopSlack() { this.calls.push("stopSlack"); this.slackLive = false; return ok; }
  async stopDispatcher() { this.calls.push("stopDispatcher"); this.dispatcherLive = false; return ok; }
  async startDispatcher() {
    this.calls.push("startDispatcher");
    if (this.dispatcherStartUnknownOnce) {
      this.dispatcherStartUnknownOnce = false;
      return { ...ok, exit_code: null, timed_out: true };
    }
    this.dispatcherLive = true;
    return ok;
  }
  async startSlack() {
    this.calls.push("startSlack");
    this.slackLive = true;
    await this.afterSlackStart?.();
    return ok;
  }
  async waitForMainAgentIdle(): Promise<MainAgentObservation> {
    this.calls.push("waitForMainAgentIdle");
    return this.mainAgent(this.mainAgentSha, this.mainWaitStatus);
  }
  async stopMainAgent(expected: MainAgentObservation) {
    this.calls.push("stopMainAgent");
    assert.equal(expected.pane_id, "w1:p1");
    if (this.mainStopOutcome !== "stopped") {
      return {
        outcome: this.mainStopOutcome,
        pane_id: "w1:p1",
        error_code: this.mainStopOutcome === "rejected" ? "main_agent_identity_changed" : "main_agent_stop_timeout",
      };
    }
    this.mainAgentExists = false;
    return { outcome: "stopped" as const, pane_id: "w1:p1", error_code: null };
  }
  async startMainAgent(paneId: string, releasePath: string) {
    this.calls.push(`startMainAgent:${path.basename(releasePath)}`);
    assert.equal(paneId, "w1:p1");
    if (this.previousMainStartUnknownOnce && path.basename(releasePath) === currentSha) {
      this.previousMainStartUnknownOnce = false;
      this.mainAgentExists = true;
      this.mainAgentSha = currentSha;
      return {
        outcome: "accepted_unknown" as const,
        observation: this.mainAgent(currentSha, "idle", releasePath),
        error_code: "main_agent_start_timeout",
      };
    }
    if (this.mainStartUnknownOnce) {
      this.mainStartUnknownOnce = false;
      return {
        outcome: "accepted_unknown" as const,
        observation: this.mainAgent(this.mainAgentSha, "unknown", releasePath),
        error_code: "main_agent_start_timeout",
      };
    }
    this.mainAgentExists = true;
    this.mainAgentSha = path.basename(releasePath);
    return { outcome: "started" as const, observation: this.mainAgent(this.mainAgentSha, "idle", releasePath), error_code: null };
  }
  async mainAgentStatus(releasePath: string): Promise<MainAgentObservation> {
    return this.mainAgent(this.mainAgentSha, this.mainObserveStatus, releasePath);
  }
  async dispatcherHealth(): Promise<HealthSnapshot> {
    if (!this.dispatcherLive) return this.health("dispatcher", null, false, false);
    const current = (await this.store.observe()).current_sha;
    if (this.wrongTargetOnce && current === targetSha) {
      this.wrongTargetOnce = false;
      return this.health("dispatcher", "f".repeat(40), true);
    }
    return this.health("dispatcher", current, true);
  }
  async slackHealth(): Promise<HealthSnapshot> {
    if (!this.slackLive) return { ...this.health("slack_adapter", null, false, false), workspaces_ready: false };
    const current = (await this.store.observe()).current_sha;
    if (this.wrongSlackOnce && current === targetSha) {
      this.wrongSlackOnce = false;
      return { ...this.health("slack_adapter", "f".repeat(40), true), workspaces_ready: true };
    }
    return { ...this.health("slack_adapter", current, true), workspaces_ready: true };
  }
  private health(service: HealthSnapshot["service"], sha: string | null, ready: boolean, live = true): HealthSnapshot {
    const compatibility = sha ? this.healthCompatibility.get(sha) : undefined;
    return {
      service,
      live,
      ready,
      build_sha: live ? sha ?? this.policySha() : null,
      protocol: live ? 1 : null,
      app_schema: live ? this.actualAppSchema : null,
      config: live ? 1 : null,
      ...(live && compatibility ? {
        app_schema_read_min: compatibility.app_schema_read_min,
        app_schema_read_max: compatibility.app_schema_read_max,
        app_schema_write: compatibility.app_schema_write,
      } : {}),
      ...(live && this.notificationProtocolReady ? { update_notification_protocol: 1 } : {}),
    };
  }
  private mainAgent(sha: string, status: MainAgentObservation["status"], expectedRelease?: string): MainAgentObservation {
    const workingDirectory = path.join(this.releaseRoot, sha);
    return {
      exists: this.mainAgentExists,
      name: this.mainAgentExists ? "dona-main" : null,
      kind: this.mainAgentExists ? "codex" : null,
      pane_id: this.mainAgentExists ? "w1:p1" : null,
      status: this.mainAgentExists ? status : null,
      interactive_ready: this.mainAgentExists,
      working_directory: this.mainAgentExists ? workingDirectory : null,
      session_id: this.mainAgentExists ? `session-${sha}` : null,
      matches_release: this.mainAgentExists && expectedRelease !== undefined && workingDirectory === expectedRelease,
      error_code: null,
    };
  }
}

async function fixture(policyVersion = "2026-09-03.2") {
  const { root, policy } = await tempPolicy();
  policy.policy_version = policyVersion;
  roots.push(root);
  await installPointers(policy);
  const database = new UpdateDatabase(path.join(policy.control_root, "updater.sqlite3"));
  const store = new ReleaseStore(policy);
  const dispatcher = new FakeDispatcher();
  const git = new FakeGit();
  const build = new FakeBuild();
  const runtime = new FakeRuntime(store, () => currentSha, policy.release_root);
  let now = new Date("2026-09-02T00:00:00.000Z");
  const controller = new UpdateController(database, policy, git, build, store, runtime, dispatcher, logger, {
    now: () => new Date(now),
  }, "controller-test");
  return {
    policy, database, store, dispatcher, git, build, runtime, controller,
    advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); },
  };
}

describe("UpdateController isolated end-to-end", () => {
  test("waits for the source Result terminal barrier, then stages, activates, verifies, and routes completion", async () => {
    const f = await fixture();
    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    const requestId = planned.request_id as string;
    f.controller.apply({ source_event_id: approvalEventId, reply_target: replyTarget, plan_id: plan.plan_id, plan_hash: plan.plan_hash, approval_id: "human-approval-1" });
    assert.equal(await f.controller.processNext(), false);
    assert.equal(f.dispatcher.lastTerminalEventId, approvalEventId);
    assert.equal(f.database.get(requestId)?.state, "approved");
    f.dispatcher.terminal = true;
    assert.equal(await f.controller.processNext(), true);
    assert.equal(f.database.get(requestId)?.state, "succeeded");
    assert.equal((await f.store.observe()).current_sha, targetSha);
    assert.deepEqual(f.runtime.calls, [
      "quiesceSlack", "quiesceDispatcher", "waitForMainAgentIdle", "stopMainAgent", "stopSlack", "stopDispatcher",
      `startMainAgent:${targetSha}`, "startDispatcher", "startSlack",
    ]);
    assert.equal(f.database.outboxFor(requestId)?.status, "pending");
    const futureEventId = "evt_01M1ES03XY5CF8D9PM5CWX4SRX";
    assert.throws(() => f.database.createPlan({ source_event_id: futureEventId, reply_target: replyTarget }, {
      current_sha: targetSha,
      target_sha: "3".repeat(40),
      previous_sha: currentSha,
      policy_version: f.policy.policy_version,
      compatibility: f.policy.compatibility,
      rollback_compatible: true,
    }), /terminal notification is not settled/);
    f.dispatcher.delivery = { outcome: "acceptance_unknown", error_code: "completion_post_timeout" };
    f.dispatcher.exists = true;
    await f.controller.deliverOutbox();
    f.advance(1_001);
    await f.controller.deliverOutbox();
    assert.equal(f.database.outboxFor(requestId)?.status, "delivered");
    assert.equal(f.database.outboxFor(requestId)?.slack_reported_at, null);
    f.dispatcher.completionStatus = "completed";
    f.advance(1_001);
    await f.controller.deliverOutbox();
    assert.notEqual(f.database.outboxFor(requestId)?.slack_reported_at, null);
    assert.equal((await f.controller.status(requestId)).notification_state, "reported");
    f.database.close();
  });

  test("validates target health against the compatibility persisted in the approved plan", async () => {
    const f = await fixture();
    const schemaV2Compatibility = { ...f.policy.compatibility };
    const bridgeCompatibility: Compatibility = {
      ...schemaV2Compatibility,
      app_schema_read_max: 3,
    };
    f.policy.compatibility = bridgeCompatibility;
    f.git.targetCompatibility = bridgeCompatibility;
    f.build.compatibility = bridgeCompatibility;
    f.runtime.setHealthCompatibility(targetSha, bridgeCompatibility);

    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    f.controller.apply({
      source_event_id: approvalEventId,
      reply_target: replyTarget,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      approval_id: "human-approval-bridge",
    });
    f.dispatcher.terminal = true;

    // A restarted controller may load a different current policy, but target
    // runtime evidence stays bound to the compatibility persisted in the plan.
    f.policy.compatibility = schemaV2Compatibility;
    await f.controller.processNext();

    const row = f.database.get(planned.request_id as string)!;
    assert.equal(row.state, "succeeded", JSON.stringify({
      error: row.last_error_code,
      calls: f.runtime.calls,
      operations: f.database.runtimeOperations(row.request_id),
    }));
    assert.deepEqual(JSON.parse(row.compatibility_json), bridgeCompatibility);
    f.database.close();
  });

  test("performs one compatible rollback only for a proven wrong target SHA", async () => {
    const f = await fixture();
    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    f.controller.apply({ source_event_id: approvalEventId, reply_target: replyTarget, plan_id: plan.plan_id, plan_hash: plan.plan_hash, approval_id: "human-approval-2" });
    f.dispatcher.terminal = true;
    f.runtime.wrongTargetOnce = true;
    await f.controller.processNext();
    assert.equal(f.database.get(planned.request_id as string)?.state, "rolled_back");
    assert.equal((await f.store.observe()).current_sha, currentSha);
    assert.deepEqual(f.runtime.calls, [
      "quiesceSlack", "quiesceDispatcher", "waitForMainAgentIdle", "stopMainAgent", "stopSlack", "stopDispatcher",
      `startMainAgent:${targetSha}`, "startDispatcher", "quiesceDispatcher", "waitForMainAgentIdle", "stopMainAgent",
      "stopDispatcher", `startMainAgent:${currentSha}`, "startDispatcher", "startSlack",
    ]);
    f.database.close();
  });

  test("drains both target services before rolling dona-main back after a Slack wrong SHA", async () => {
    const f = await fixture();
    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    f.controller.apply({
      source_event_id: approvalEventId,
      reply_target: replyTarget,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      approval_id: "human-approval-slack-rollback",
    });
    f.dispatcher.terminal = true;
    f.runtime.wrongSlackOnce = true;
    await f.controller.processNext();
    const rollbackRow = f.database.get(planned.request_id as string)!;
    assert.equal(rollbackRow.state, "rolled_back", JSON.stringify({
      error: rollbackRow.last_error_code,
      calls: f.runtime.calls,
      operations: f.database.runtimeOperations(rollbackRow.request_id),
    }));
    assert.deepEqual(f.runtime.calls, [
      "quiesceSlack", "quiesceDispatcher", "waitForMainAgentIdle", "stopMainAgent", "stopSlack", "stopDispatcher",
      `startMainAgent:${targetSha}`, "startDispatcher", "startSlack",
      "quiesceSlack", "quiesceDispatcher", "waitForMainAgentIdle", "stopMainAgent", "stopSlack", "stopDispatcher",
      `startMainAgent:${currentSha}`, "startDispatcher", "startSlack",
    ]);
    f.database.close();
  });

  test("validates rollback health against the previous release manifest compatibility", async () => {
    const f = await fixture();
    const bridgeCompatibility: Compatibility = {
      protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 3,
      app_schema_write: 2, rollback_safe: true,
    };
    const schemaV3Compatibility: Compatibility = { ...bridgeCompatibility, app_schema_write: 3 };
    await fs.writeFile(
      path.join(f.policy.release_root, currentSha, "release-manifest.json"),
      `${JSON.stringify({ ...manifest(currentSha), compatibility: bridgeCompatibility })}\n`,
    );
    f.policy.compatibility = schemaV3Compatibility;
    f.git.targetCompatibility = schemaV3Compatibility;
    f.build.compatibility = schemaV3Compatibility;
    f.runtime.setHealthCompatibility(currentSha, bridgeCompatibility);
    f.runtime.setHealthCompatibility(targetSha, schemaV3Compatibility);
    f.runtime.actualAppSchema = 3;

    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    f.controller.apply({
      source_event_id: approvalEventId,
      reply_target: replyTarget,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      approval_id: "human-approval-schema-v3-rollback",
    });
    f.dispatcher.terminal = true;
    f.runtime.wrongSlackOnce = true;

    await f.controller.processNext();

    assert.equal(f.database.get(planned.request_id as string)?.state, "rolled_back");
    assert.equal(f.runtime.calls.filter((call) => call === "migrateAppSchema").length, 1);
    assert.ok(f.runtime.calls.indexOf("stopDispatcher") < f.runtime.calls.indexOf("migrateAppSchema"));
    assert.ok(f.runtime.calls.indexOf("migrateAppSchema") < f.runtime.calls.indexOf(`startMainAgent:${targetSha}`));
    assert.equal((await f.store.observe()).current_sha, currentSha);
    f.database.close();
  });

  test("resumes rollback from persisted launch evidence without starting the previous main agent twice", async () => {
    const f = await fixture();
    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    const requestId = planned.request_id as string;
    f.controller.apply({
      source_event_id: approvalEventId,
      reply_target: replyTarget,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      approval_id: "human-approval-rollback-reconcile",
    });
    f.dispatcher.terminal = true;
    f.runtime.wrongSlackOnce = true;
    f.runtime.previousMainStartUnknownOnce = true;
    await f.controller.processNext();
    assert.equal(f.database.get(requestId)?.state, "rolling_back");
    assert.equal(f.database.runtimeOperation(requestId, "start_previous_main_agent")?.phase, "acceptance_unknown");
    assert.equal(f.runtime.calls.filter((call) => call === `startMainAgent:${currentSha}`).length, 1);
    f.advance(1_001);
    await f.controller.processNext();
    const resumed = f.database.get(requestId)!;
    assert.equal(resumed.state, "rolled_back", JSON.stringify({
      error: resumed.last_error_code,
      after: resumed.reconcile_after,
      calls: f.runtime.calls,
      operations: f.database.runtimeOperations(requestId),
    }));
    assert.equal(f.database.runtimeOperation(requestId, "start_previous_main_agent")?.phase, "observed");
    assert.equal(f.runtime.calls.filter((call) => call === `startMainAgent:${currentSha}`).length, 1);
    f.database.close();
  });

  test("accepts a proven target dona-main that started handling a new event during final verification", async () => {
    const f = await fixture();
    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    f.controller.apply({
      source_event_id: approvalEventId,
      reply_target: replyTarget,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      approval_id: "human-approval-working-main",
    });
    f.dispatcher.terminal = true;
    f.runtime.afterSlackStart = async () => { f.runtime.mainObserveStatus = "working"; };
    await f.controller.processNext();
    assert.equal(f.database.get(planned.request_id as string)?.state, "succeeded");
    f.database.close();
  });

  test("fails before activation when canonical staging verification fails and leaves current untouched", async () => {
    const f = await fixture();
    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    f.controller.apply({ source_event_id: approvalEventId, reply_target: replyTarget, plan_id: plan.plan_id, plan_hash: plan.plan_hash, approval_id: "human-approval-3" });
    f.dispatcher.terminal = true;
    f.build.fail = true;
    await f.controller.processNext();
    const row = f.database.get(planned.request_id as string)!;
    assert.equal(row.state, "failed");
    assert.equal(row.last_error_code, "pre_activation_failed");
    assert.equal((await f.store.observe()).current_sha, currentSha);
    assert.deepEqual(f.runtime.calls, []);
    f.database.close();
  });

  test("requires review instead of claiming an active SHA when pre-activation runtime evidence is inconsistent", async () => {
    const f = await fixture();
    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    const requestId = planned.request_id as string;
    f.controller.apply({
      source_event_id: approvalEventId,
      reply_target: replyTarget,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      approval_id: "human-approval-unverified-pre-activation-runtime",
    });
    f.dispatcher.terminal = true;
    f.build.fail = true;
    f.runtime.mainAgentSha = targetSha;
    await f.controller.processNext();
    const row = f.database.get(requestId)!;
    assert.equal(row.state, "needs_review");
    assert.equal(row.last_error_code, "pre_activation_runtime_unverified");
    assert.equal(row.observed_active_sha, null);
    assert.equal(JSON.parse(f.database.outboxFor(requestId)!.payload_json).payload.active_sha, null);
    f.database.close();
  });

  test("does not quiesce for a stale plan whose current release changed before execution", async () => {
    const f = await fixture();
    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    const requestId = planned.request_id as string;
    f.controller.apply({
      source_event_id: approvalEventId,
      reply_target: replyTarget,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      approval_id: "human-approval-stale-current",
    });
    f.dispatcher.terminal = true;
    await fs.unlink(f.policy.current_pointer);
    await fs.symlink(path.join(f.policy.release_root, targetSha), f.policy.current_pointer);
    await f.controller.processNext();
    const row = f.database.get(requestId)!;
    assert.equal(row.state, "needs_review");
    assert.equal(row.last_error_code, "pre_activation_runtime_unverified");
    assert.equal(row.observed_active_sha, null);
    assert.deepEqual(f.runtime.calls, []);
    f.database.close();
  });

  test("does not stop a blocked dona-main or switch the release pointer", async () => {
    const f = await fixture();
    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    f.controller.apply({
      source_event_id: approvalEventId,
      reply_target: replyTarget,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      approval_id: "human-approval-blocked",
    });
    f.dispatcher.terminal = true;
    f.runtime.mainWaitStatus = "blocked";
    await f.controller.processNext();
    assert.equal(f.database.get(planned.request_id as string)?.state, "failed");
    assert.equal(f.database.get(planned.request_id as string)?.last_error_code, "main_agent_blocked");
    assert.equal(f.database.get(planned.request_id as string)?.observed_active_sha, currentSha);
    assert.equal((await f.store.observe()).current_sha, currentSha);
    assert.deepEqual(f.runtime.calls, [
      "quiesceSlack", "quiesceDispatcher", "waitForMainAgentIdle", "startDispatcher", "startSlack",
    ]);
    f.database.close();
  });

  test("does not stop a dona-main whose release identity changed after draining", async () => {
    const f = await fixture();
    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    f.controller.apply({
      source_event_id: approvalEventId,
      reply_target: replyTarget,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      approval_id: "human-approval-main-identity-changed",
    });
    f.dispatcher.terminal = true;
    f.runtime.mainAgentSha = targetSha;
    await f.controller.processNext();
    const row = f.database.get(planned.request_id as string)!;
    assert.equal(row.state, "needs_review");
    assert.equal(row.last_error_code, "quiesce_recovery_runtime_mismatch");
    assert.equal((await f.store.observe()).current_sha, currentSha);
    assert.deepEqual(f.runtime.calls, [
      "quiesceSlack", "quiesceDispatcher", "waitForMainAgentIdle", "startDispatcher", "startSlack",
    ]);
    f.database.close();
  });

  test("restores current services when dona-main stop is definitively rejected before mutation", async () => {
    const f = await fixture();
    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    f.controller.apply({
      source_event_id: approvalEventId,
      reply_target: replyTarget,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      approval_id: "human-approval-main-stop-rejected",
    });
    f.dispatcher.terminal = true;
    f.runtime.mainStopOutcome = "rejected";
    await f.controller.processNext();
    const row = f.database.get(planned.request_id as string)!;
    assert.equal(row.state, "failed");
    assert.equal(row.last_error_code, "main_agent_identity_changed");
    assert.equal(row.observed_active_sha, currentSha);
    assert.match(row.last_error_message ?? "", /restored and verified/);
    assert.equal((await f.store.observe()).current_sha, currentSha);
    assert.deepEqual(f.runtime.calls, [
      "quiesceSlack", "quiesceDispatcher", "waitForMainAgentIdle", "stopMainAgent", "startDispatcher", "startSlack",
    ]);
    assert.equal(f.database.runtimeOperation(row.request_id, "restart_current_dispatcher")?.phase, "observed");
    assert.equal(f.database.runtimeOperation(row.request_id, "restart_current_slack")?.phase, "observed");
    f.database.close();
  });

  test("does not restart services when dona-main stop acceptance is unknown", async () => {
    const f = await fixture();
    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    f.controller.apply({
      source_event_id: approvalEventId,
      reply_target: replyTarget,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      approval_id: "human-approval-main-stop-timeout",
    });
    f.dispatcher.terminal = true;
    f.runtime.mainStopOutcome = "accepted_unknown";
    await f.controller.processNext();
    assert.equal(f.database.get(planned.request_id as string)?.state, "quiescing");
    f.advance(f.policy.timeouts.reconcile_ms + 1);
    await f.controller.processNext();
    const row = f.database.get(planned.request_id as string)!;
    assert.equal(row.state, "needs_review");
    assert.equal(row.last_error_code, "main_agent_stop_acceptance_unknown");
    assert.equal((await f.store.observe()).current_sha, currentSha);
    assert.deepEqual(f.runtime.calls, [
      "quiesceSlack", "quiesceDispatcher", "waitForMainAgentIdle", "stopMainAgent",
      "quiesceSlack", "quiesceDispatcher",
    ]);
    f.database.close();
  });

  test("does not retry or continue when quiesce recovery restart acceptance is unknown", async () => {
    const f = await fixture();
    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    f.controller.apply({
      source_event_id: approvalEventId,
      reply_target: replyTarget,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      approval_id: "human-approval-quiesce-recovery-timeout",
    });
    f.dispatcher.terminal = true;
    f.runtime.mainStopOutcome = "rejected";
    f.runtime.dispatcherStartUnknownOnce = true;
    await f.controller.processNext();
    const row = f.database.get(planned.request_id as string)!;
    assert.equal(row.state, "needs_review");
    assert.equal(row.last_error_code, "quiesce_recovery_dispatcher_restart_unknown");
    assert.match(row.last_error_message ?? "", /no blind retry/);
    assert.equal((await f.store.observe()).current_sha, currentSha);
    assert.deepEqual(f.runtime.calls, [
      "quiesceSlack", "quiesceDispatcher", "waitForMainAgentIdle", "stopMainAgent", "startDispatcher",
    ]);
    assert.equal(f.database.runtimeOperation(row.request_id, "restart_current_dispatcher")?.phase, "acceptance_unknown");
    assert.equal(await f.controller.processNext(), false);
    assert.deepEqual(f.runtime.calls, [
      "quiesceSlack", "quiesceDispatcher", "waitForMainAgentIdle", "stopMainAgent", "startDispatcher",
    ]);
    f.database.close();
  });

  test("finishes a recovered pre-mutation stop without quiescing already-restored services again", async () => {
    const f = await fixture();
    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    const requestId = planned.request_id as string;
    f.controller.apply({
      source_event_id: approvalEventId,
      reply_target: replyTarget,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      approval_id: "human-approval-restored-before-crash",
    });
    let row = f.database.claim(requestId, "controller-test", f.policy.timeouts.lease_ms)!;
    row = f.database.transition(requestId, row.fence, "staged", "release_staged");
    row = f.database.transition(requestId, row.fence, "quiescing", "runtime_quiesce_started");
    for (const [kind, service] of [
      ["restart_current_dispatcher", "dispatcher"],
      ["restart_current_slack", "slack_adapter"],
    ] as const) {
      f.database.prepareRuntimeOperation(
        requestId,
        row.fence,
        kind,
        service,
        currentSha,
        null,
        { cause_code: "main_agent_blocked" },
      );
      f.database.recordRuntimeOperation(
        requestId,
        row.fence,
        kind,
        "observed",
        null,
        { cause_code: "main_agent_blocked" },
      );
    }
    await f.controller.processNext();
    assert.equal(f.database.get(requestId)?.state, "failed");
    assert.equal(f.database.get(requestId)?.last_error_code, "main_agent_blocked");
    assert.deepEqual(f.runtime.calls, []);
    f.database.close();
  });

  test("does not start services or retry when dona-main start acceptance is unknown", async () => {
    const f = await fixture();
    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    f.controller.apply({
      source_event_id: approvalEventId,
      reply_target: replyTarget,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      approval_id: "human-approval-main-start-timeout",
    });
    f.dispatcher.terminal = true;
    f.runtime.mainStartUnknownOnce = true;
    await f.controller.processNext();
    assert.equal(f.database.get(planned.request_id as string)?.state, "restarting");
    f.advance(f.policy.timeouts.reconcile_ms + 1);
    await f.controller.processNext();
    assert.equal(f.database.get(planned.request_id as string)?.state, "needs_review");
    assert.equal(f.database.get(planned.request_id as string)?.last_error_code, "main_agent_start_observation_timeout");
    assert.equal((await f.store.observe()).current_sha, targetSha);
    assert.deepEqual(f.runtime.calls, [
      "quiesceSlack", "quiesceDispatcher", "waitForMainAgentIdle", "stopMainAgent", "stopSlack", "stopDispatcher",
      `startMainAgent:${targetSha}`,
    ]);
    f.database.close();
  });

  test("requires exact plan confirmation for an operator rollback after ambiguous start acceptance", async () => {
    const f = await fixture();
    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    const requestId = planned.request_id as string;
    f.controller.apply({ source_event_id: approvalEventId, reply_target: replyTarget, plan_id: plan.plan_id, plan_hash: plan.plan_hash, approval_id: "human-approval-4" });
    f.dispatcher.terminal = true;
    f.runtime.dispatcherStartUnknownOnce = true;
    await f.controller.processNext();
    assert.equal(f.database.get(requestId)?.state, "restarting");
    f.advance(f.policy.timeouts.reconcile_ms + 1);
    await f.controller.processNext();
    assert.equal(f.database.get(requestId)?.state, "needs_review");
    assert.equal((await f.store.observe()).current_sha, targetSha);
    assert.equal(JSON.parse(f.database.outboxFor(requestId)!.payload_json).payload.active_sha, null);
    await assert.rejects(f.controller.operatorRollback(requestId, "f".repeat(64)), /matching needs_review plan/);
    await f.controller.operatorRollback(requestId, plan.plan_hash);
    assert.equal(f.database.get(requestId)?.state, "rolled_back");
    assert.equal((await f.store.observe()).current_sha, currentSha);
    assert.match(f.database.outboxFor(requestId)?.external_event_id ?? "", /:terminal:3$/);
    assert.equal(JSON.parse(f.database.outboxFor(requestId)!.payload_json).payload.active_sha, currentSha);
    f.database.close();
  });

  test("fails planning closed when CI trust or candidate compatibility is not exact", async () => {
    const { root, policy } = await tempPolicy();
    roots.push(root);
    await installPointers(policy);
    const database = new UpdateDatabase(path.join(policy.control_root, "updater.sqlite3"));
    const store = new ReleaseStore(policy);
    const dispatcher = new FakeDispatcher();
    const runtime = new FakeRuntime(store, () => currentSha, policy.release_root);
    const untrustedGit = new FakeGit();
    untrustedGit.refresh = async (current: string) => ({
      current_sha: current,
      target_sha: targetSha,
      target_reachable: true,
      ci_trusted: false,
      target_compatibility: policy.compatibility,
      target_rollout: untrustedGit.targetRollout,
    });
    const untrusted = new UpdateController(database, policy, untrustedGit, new FakeBuild(), store, runtime, dispatcher, logger);
    await assert.rejects(untrusted.plan({ source_event_id: sourceEventId, reply_target: replyTarget }), /ci_trust_gate/);
    const incompatibleGit = new FakeGit();
    incompatibleGit.refresh = async (current: string) => ({
      current_sha: current,
      target_sha: targetSha,
      target_reachable: true,
      ci_trusted: true,
      target_compatibility: { ...policy.compatibility, protocol: 2 },
      target_rollout: incompatibleGit.targetRollout,
    });
    const incompatible = new UpdateController(database, policy, incompatibleGit, new FakeBuild(), store, runtime, dispatcher, logger);
    await assert.rejects(incompatible.plan({ source_event_id: sourceEventId, reply_target: replyTarget }), /approved_policy/);
    database.close();
  });

  test("reconciles target health after a controller crash without repeating restart commands", async () => {
    const f = await fixture();
    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    const requestId = planned.request_id as string;
    f.controller.apply({ source_event_id: approvalEventId, reply_target: replyTarget, plan_id: plan.plan_id, plan_hash: plan.plan_hash, approval_id: "human-approval-5" });
    f.dispatcher.terminal = true;
    let row = f.database.claim(requestId, "crashed-controller", 1, new Date("2026-09-01T23:59:00.000Z"))!;
    const staging = await f.store.prepareStaging(requestId, row.fence);
    await fs.writeFile(path.join(staging, "app.js"), "export {};\n", { mode: 0o600 });
    const release = await f.store.publish(staging, manifest(targetSha));
    row = f.database.transition(requestId, row.fence, "staged", "release_staged");
    row = f.database.transition(requestId, row.fence, "quiescing", "quiesce");
    row = f.database.transition(requestId, row.fence, "activating", "activate");
    const receipt = await f.store.activate(row, release);
    f.database.recordActivationGeneration(requestId, row.fence, receipt.generation);
    row = f.database.transition(requestId, row.fence, "restarting", "pointer_activated", { activation_generation: receipt.generation });
    f.database.prepareRuntimeOperation(
      requestId, row.fence, "start_target_main_agent", "w1:p1", targetSha, `session-${currentSha}`,
    );
    f.database.recordRuntimeOperation(
      requestId, row.fence, "start_target_main_agent", "observed", `session-${targetSha}`, {},
    );
    for (const [kind, service] of [
      ["start_target_dispatcher", "dispatcher"],
      ["start_target_slack", "slack_adapter"],
    ] as const) {
      f.database.prepareRuntimeOperation(requestId, row.fence, kind, service, targetSha, null);
      f.database.recordRuntimeOperation(requestId, row.fence, kind, "observed", null, {});
    }
    f.database.transition(requestId, row.fence, "verifying", "restart_response_lost");
    f.runtime.mainAgentSha = targetSha;
    await f.controller.processNext();
    assert.equal(f.database.get(requestId)?.state, "succeeded");
    assert.deepEqual(f.runtime.calls, []);
    f.database.close();
  });

  test("does not report success when the previous pointer no longer matches the activation receipt", async () => {
    const f = await fixture();
    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    const requestId = planned.request_id as string;
    f.controller.apply({
      source_event_id: approvalEventId,
      reply_target: replyTarget,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      approval_id: "human-approval-pointer-pair",
    });
    f.dispatcher.terminal = true;
    f.runtime.afterSlackStart = async () => {
      f.runtime.afterSlackStart = undefined;
      await fs.unlink(f.policy.previous_pointer);
      await fs.symlink(path.join(f.policy.release_root, targetSha), f.policy.previous_pointer);
    };

    await f.controller.processNext();
    let row = f.database.get(requestId)!;
    assert.equal(row.state, "verifying");
    assert.equal(row.last_error_code, "activation_evidence_mismatch");
    assert.equal(f.database.outboxFor(requestId), undefined);

    f.advance(f.policy.timeouts.reconcile_ms + 1);
    await f.controller.processNext();
    row = f.database.get(requestId)!;
    assert.equal(row.state, "needs_review");
    assert.equal(row.last_error_code, "activation_evidence_mismatch");
    assert.equal(row.observed_active_sha, null);
    f.database.close();
  });

  test("resumes the exact remaining rollback writes after a crash between pointer switches", async () => {
    const f = await fixture();
    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    const requestId = planned.request_id as string;
    f.controller.apply({
      source_event_id: approvalEventId,
      reply_target: replyTarget,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      approval_id: "human-approval-partial-rollback",
    });
    let row = f.database.claim(requestId, "controller-test", 10_000, new Date("2026-09-02T00:00:00.000Z"))!;
    const staging = await f.store.prepareStaging(requestId, row.fence);
    await fs.writeFile(path.join(staging, "app.js"), "export {};\n", { mode: 0o600 });
    const release = await f.store.publish(staging, manifest(targetSha));
    row = f.database.transition(requestId, row.fence, "staged", "release_staged");
    row = f.database.transition(requestId, row.fence, "quiescing", "runtime_quiesce_started");
    row = f.database.transition(requestId, row.fence, "activating", "runtime_quiesced");
    const activation = await f.store.activate(row, release);
    f.database.recordActivationGeneration(requestId, row.fence, activation.generation);
    row = f.database.transition(requestId, row.fence, "restarting", "pointer_activated", {
      activation_generation: activation.generation,
    });
    row = f.database.transition(requestId, row.fence, "rolling_back", "rollback_started");
    for (const [kind, targetRef, expectedSha, previousSessionId] of [
      ["stop_target_main_agent", "w1:p1", targetSha, `session-${targetSha}`],
      ["stop_target_slack", "slack_adapter", null, null],
      ["stop_target_dispatcher", "dispatcher", null, null],
    ] as const) {
      f.database.prepareRuntimeOperation(requestId, row.fence, kind, targetRef, expectedSha, previousSessionId);
      f.database.recordRuntimeOperation(requestId, row.fence, kind, "observed", null, {});
    }
    await fs.unlink(f.policy.current_pointer);
    await fs.symlink(path.join(f.policy.release_root, currentSha), f.policy.current_pointer);
    f.runtime.simulateStoppedRuntime();

    await f.controller.processNext();
    const resumed = f.database.get(requestId)!;
    assert.equal(resumed.state, "rolled_back");
    assert.equal(resumed.activation_generation, activation.generation + 1);
    assert.deepEqual(f.runtime.calls, [
      `startMainAgent:${currentSha}`, "startDispatcher", "startSlack",
    ]);
    const observed = await f.store.observe();
    assert.equal(observed.current_sha, currentSha);
    assert.equal(observed.previous_sha, targetSha);
    assert.equal(observed.receipt?.to_sha, currentSha);
    f.database.close();
  });

  test("corrects the policy 2026-09-03.1 main-agent ambiguity from exact current evidence", async () => {
    const f = await fixture("2026-09-03.1");
    const planned = await f.controller.plan({ source_event_id: sourceEventId, reply_target: replyTarget });
    const plan = planned.plan as { plan_id: string; plan_hash: string };
    const requestId = planned.request_id as string;
    f.controller.apply({
      source_event_id: approvalEventId,
      reply_target: replyTarget,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      approval_id: "human-approval-legacy-evidence",
    });
    let row = f.database.claim(requestId, "legacy-controller", 10_000, new Date("2026-09-02T00:00:00.000Z"))!;
    const staging = await f.store.prepareStaging(requestId, row.fence);
    await fs.writeFile(path.join(staging, "app.js"), "export {};\n", { mode: 0o600 });
    const release = await f.store.publish(staging, { ...manifest(targetSha), policy_version: "2026-09-03.1" });
    row = f.database.transition(requestId, row.fence, "staged", "release_staged");
    row = f.database.transition(requestId, row.fence, "quiescing", "runtime_quiesce_started");
    row = f.database.transition(requestId, row.fence, "activating", "runtime_quiesced");
    const receipt = await f.store.activate(row, release);
    f.database.recordActivationGeneration(requestId, row.fence, receipt.generation);
    row = f.database.transition(requestId, row.fence, "restarting", "pointer_activated", {
      activation_generation: receipt.generation,
    });
    f.database.terminal(requestId, row.fence, "needs_review", "main_agent_start_failed", {
      last_error_code: "main_agent_start_failed",
      last_error_message: "Runtime acceptance was not proven",
    }, new Date("2026-09-01T23:59:59.000Z"));
    f.runtime.mainAgentSha = targetSha;
    f.runtime.notificationProtocolReady = false;
    await f.controller.processNext();
    assert.equal(f.database.get(requestId)?.state, "needs_review");
    assert.equal(f.database.runtimeOperation(requestId, "legacy_confirmation")?.phase, "observed");
    f.runtime.notificationProtocolReady = true;
    await f.controller.processNext();
    const corrected = f.database.get(requestId)!;
    assert.equal(corrected.state, "succeeded");
    assert.equal(corrected.fence, 2);
    assert.equal(corrected.observed_active_sha, targetSha);
    assert.equal(JSON.parse(f.database.outboxFor(requestId)!.payload_json).payload.active_sha, targetSha);
    assert.deepEqual(
      f.database.pendingOutbox().map((outbox) => outbox.external_event_id),
      [`update:${requestId}:terminal:2`],
    );
    assert.deepEqual(f.runtime.calls, []);
    f.database.close();
  });
});
