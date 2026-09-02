import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { UpdateController } from "../src/controller.js";
import { UpdateDatabase } from "../src/database.js";
import type { BuildPort, DispatcherPort, GitPort, RuntimePort } from "../src/ports.js";
import { ReleaseStore } from "../src/release-store.js";
import type { CommandResult, DrainSnapshot, HealthSnapshot, MainAgentObservation, OutboxRow } from "../src/types.js";
import { currentSha, installPointers, logger, manifest, removeTree, targetSha, tempPolicy } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeTree)));

const sourceEventId = "evt_01M1ES03XY5CF8D9PM5CWX4SRV";
const approvalEventId = "evt_01M1ES03XY5CF8D9PM5CWX4SRW";
const replyTarget = { kind: "slack_thread" as const, workspace_id: "T_TEST", channel_id: "C_TEST", thread_ts: "1756722030.123456" };
const ok: CommandResult = { exit_code: 0, stdout: "", stderr: "", timed_out: false, output_truncated: false };

class FakeGit implements GitPort {
  constructor(readonly target = targetSha, readonly reachable = true) {}
  async refresh(current: string) {
    return {
      current_sha: current,
      target_sha: this.target,
      target_reachable: this.reachable,
      ci_trusted: true,
      target_compatibility: { protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 2, app_schema_write: 2, rollback_safe: true },
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
  async toolchain() { return { node_version: process.versions.node, npm_version: "11.0.0" }; }
  async buildRelease() {
    if (this.fail) throw new Error("canonical tests failed");
    return {
      lock_hashes: { dispatcher: "a".repeat(64), "sources/slack": "b".repeat(64), updater: "c".repeat(64) },
      node_version: process.versions.node,
      npm_version: "11.0.0",
      compatibility: { protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 2, app_schema_write: 2, rollback_safe: true },
    };
  }
}

class FakeDispatcher implements DispatcherPort {
  terminal = false;
  safe = true;
  delivery: "delivered" | "accepted_unknown" | "rejected" = "delivered";
  exists = false;
  lastTerminalEventId: string | undefined;
  async eventTerminal(eventId: string) { this.lastTerminalEventId = eventId; return this.terminal; }
  async safetyStatus() { return { safe: this.safe, unsafe_states: this.safe ? [] : ["jobs.cancelling:1"] }; }
  async deliverCompletion(_outbox: OutboxRow) { return this.delivery; }
  async completionExists() { return this.exists; }
}

class FakeRuntime implements RuntimePort {
  readonly calls: string[] = [];
  wrongTargetOnce = false;
  wrongSlackOnce = false;
  dispatcherStartUnknownOnce = false;
  mainWaitStatus: MainAgentObservation["status"] = "idle";
  mainObserveStatus: MainAgentObservation["status"] = "idle";
  mainStopOutcome: "stopped" | "rejected" | "accepted_unknown" = "stopped";
  mainStartUnknownOnce = false;
  private mainAgentExists = true;
  mainAgentSha = currentSha;
  constructor(
    private readonly store: ReleaseStore,
    private readonly policySha: () => string,
    private readonly releaseRoot: string,
  ) {}
  async quiesceSlack(): Promise<DrainSnapshot> { this.calls.push("quiesceSlack"); return { service: "slack_adapter", quiescing: true, drained: true, in_flight: 0, unsafe_states: [] }; }
  async quiesceDispatcher(): Promise<DrainSnapshot> { this.calls.push("quiesceDispatcher"); return { service: "dispatcher", quiescing: true, drained: true, in_flight: 0, unsafe_states: [] }; }
  async stopSlack() { this.calls.push("stopSlack"); return ok; }
  async stopDispatcher() { this.calls.push("stopDispatcher"); return ok; }
  async startDispatcher() {
    this.calls.push("startDispatcher");
    if (this.dispatcherStartUnknownOnce) {
      this.dispatcherStartUnknownOnce = false;
      return { ...ok, exit_code: null, timed_out: true };
    }
    return ok;
  }
  async startSlack() { this.calls.push("startSlack"); return ok; }
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
    const current = (await this.store.observe()).current_sha;
    if (this.wrongTargetOnce && current === targetSha) {
      this.wrongTargetOnce = false;
      return this.health("dispatcher", "f".repeat(40), true);
    }
    return this.health("dispatcher", current, true);
  }
  async slackHealth(): Promise<HealthSnapshot> {
    if (this.wrongSlackOnce) {
      this.wrongSlackOnce = false;
      return { ...this.health("slack_adapter", "f".repeat(40), true), workspaces_ready: true };
    }
    return { ...this.health("slack_adapter", (await this.store.observe()).current_sha, true), workspaces_ready: true };
  }
  private health(service: HealthSnapshot["service"], sha: string | null, ready: boolean): HealthSnapshot {
    return { service, live: true, ready, build_sha: sha ?? this.policySha(), protocol: 1, app_schema: 2, config: 1 };
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

async function fixture() {
  const { root, policy } = await tempPolicy();
  roots.push(root);
  await installPointers(policy);
  const database = new UpdateDatabase(path.join(policy.control_root, "updater.sqlite3"));
  const store = new ReleaseStore(policy);
  const dispatcher = new FakeDispatcher();
  const build = new FakeBuild();
  const runtime = new FakeRuntime(store, () => currentSha, policy.release_root);
  const controller = new UpdateController(database, policy, new FakeGit(), build, store, runtime, dispatcher, logger, {
    now: () => new Date("2026-09-02T00:00:00.000Z"),
  }, "controller-test");
  return { policy, database, store, dispatcher, build, runtime, controller };
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
    f.dispatcher.delivery = "accepted_unknown";
    f.dispatcher.exists = true;
    await f.controller.deliverOutbox();
    assert.equal(f.database.outboxFor(requestId)?.status, "delivered");
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
    assert.equal(f.database.get(planned.request_id as string)?.state, "rolled_back");
    assert.deepEqual(f.runtime.calls, [
      "quiesceSlack", "quiesceDispatcher", "waitForMainAgentIdle", "stopMainAgent", "stopSlack", "stopDispatcher",
      `startMainAgent:${targetSha}`, "startDispatcher", "startSlack",
      "quiesceSlack", "quiesceDispatcher", "waitForMainAgentIdle", "stopMainAgent", "stopSlack", "stopDispatcher",
      `startMainAgent:${currentSha}`, "startDispatcher", "startSlack",
    ]);
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
    f.runtime.mainObserveStatus = "working";
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
    assert.equal(f.database.get(planned.request_id as string)?.state, "needs_review");
    assert.equal(f.database.get(planned.request_id as string)?.last_error_code, "main_agent_blocked");
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
    assert.equal(row.state, "needs_review");
    assert.equal(row.last_error_code, "main_agent_identity_changed");
    assert.match(row.last_error_message ?? "", /restarted and verified/);
    assert.equal((await f.store.observe()).current_sha, currentSha);
    assert.deepEqual(f.runtime.calls, [
      "quiesceSlack", "quiesceDispatcher", "waitForMainAgentIdle", "stopMainAgent", "startDispatcher", "startSlack",
    ]);
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
    const row = f.database.get(planned.request_id as string)!;
    assert.equal(row.state, "needs_review");
    assert.equal(row.last_error_code, "main_agent_stop_timeout");
    assert.equal((await f.store.observe()).current_sha, currentSha);
    assert.deepEqual(f.runtime.calls, [
      "quiesceSlack", "quiesceDispatcher", "waitForMainAgentIdle", "stopMainAgent",
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
    assert.equal(f.database.get(planned.request_id as string)?.state, "needs_review");
    assert.equal(f.database.get(planned.request_id as string)?.last_error_code, "main_agent_start_timeout");
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
    assert.equal(f.database.get(requestId)?.state, "needs_review");
    assert.equal((await f.store.observe()).current_sha, targetSha);
    assert.equal(JSON.parse(f.database.outboxFor(requestId)!.payload_json).payload.active_sha, null);
    await assert.rejects(f.controller.operatorRollback(requestId, "f".repeat(64)), /matching needs_review plan/);
    await f.controller.operatorRollback(requestId, plan.plan_hash);
    assert.equal(f.database.get(requestId)?.state, "rolled_back");
    assert.equal((await f.store.observe()).current_sha, currentSha);
    assert.match(f.database.outboxFor(requestId)?.external_event_id ?? "", /:terminal:2$/);
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
    f.database.transition(requestId, row.fence, "verifying", "restart_response_lost");
    f.runtime.mainAgentSha = targetSha;
    await f.controller.processNext();
    assert.equal(f.database.get(requestId)?.state, "succeeded");
    assert.deepEqual(f.runtime.calls, []);
    f.database.close();
  });
});
