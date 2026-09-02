import { ulid } from "ulid";
import path from "node:path";

import type { UpdateDatabase } from "./database.js";
import type { UpdatePolicy } from "./policy.js";
import type { BuildPort, Clock, DispatcherPort, GitPort, Logger, ReleaseStorePort, RuntimePort } from "./ports.js";
import { redactText } from "./redaction.js";
import type { ApplyRequest, HealthSnapshot, MainAgentObservation, PlanRequest, ReleaseManifest, UpdateRow } from "./types.js";
import { canonicalJson } from "./validation.js";

const systemClock: Clock = { now: () => new Date() };
type ActiveServices = "none" | "dispatcher" | "all" | "unknown";

function compatible(previous: ReleaseManifest["compatibility"], target: ReleaseManifest["compatibility"]): boolean {
  return previous.rollback_safe && target.rollback_safe &&
    previous.protocol === target.protocol && previous.config === target.config &&
    previous.app_schema_write >= target.app_schema_read_min && previous.app_schema_write <= target.app_schema_read_max &&
    target.app_schema_write >= previous.app_schema_read_min && target.app_schema_write <= previous.app_schema_read_max;
}

function resultSucceeded(result: { exit_code: number | null; timed_out: boolean }): boolean {
  return result.exit_code === 0 && !result.timed_out;
}

function mainAgentMatches(agent: MainAgentObservation): boolean {
  return agent.exists && agent.name === "dona-main" && agent.kind === "codex" && agent.session_id !== null &&
    agent.interactive_ready && agent.matches_release && agent.status !== null && agent.status !== "unknown";
}

export class UpdateController {
  constructor(
    private readonly database: UpdateDatabase,
    private readonly policy: UpdatePolicy,
    private readonly git: GitPort,
    private readonly build: BuildPort,
    private readonly releases: ReleaseStorePort,
    private readonly runtime: RuntimePort,
    private readonly dispatcher: DispatcherPort,
    private readonly logger: Logger,
    private readonly clock: Clock = systemClock,
    private readonly owner = `controller-${process.pid}-${ulid().toLowerCase()}`,
  ) {}

  async plan(request: PlanRequest): Promise<Record<string, unknown>> {
    const current = await this.releases.readCurrentManifest();
    const previous = await this.releases.readPreviousManifest();
    if (current.repository !== this.policy.repository) throw new Error("current_release_repository_mismatch");
    const [git, storage, toolchain] = await Promise.all([
      this.git.refresh(current.sha),
      this.releases.preflight(),
      this.build.toolchain(),
    ]);
    if (git.current_sha !== current.sha || !git.target_reachable) throw new Error("target_is_not_fast_forward_from_current");
    if (!git.ci_trusted) throw new Error("target_does_not_pass_fixed_ci_trust_gate");
    if (canonicalJson(git.target_compatibility) !== canonicalJson(this.policy.compatibility)) {
      throw new Error("target_compatibility_does_not_match_the_approved_policy_version");
    }
    if (git.target_sha === current.sha) throw new Error("current_release_is_already_at_fixed_branch_tip");
    const targetManifest: ReleaseManifest = {
      schema_version: 1,
      sha: git.target_sha,
      repository: this.policy.repository,
      policy_version: this.policy.policy_version,
      lock_hashes: {},
      node_version: process.versions.node,
      npm_version: "pending",
      built_at: this.clock.now().toISOString(),
      compatibility: git.target_compatibility,
    };
    const rollbackCompatible = compatible(current.compatibility, targetManifest.compatibility);
    if (!rollbackCompatible) throw new Error("target_is_not_rollback_compatible_with_current_release");
    const result = this.database.createPlan(request, {
      current_sha: current.sha,
      target_sha: git.target_sha,
      previous_sha: previous?.sha ?? null,
      policy_version: this.policy.policy_version,
      compatibility: targetManifest.compatibility,
      rollback_compatible: rollbackCompatible,
    }, this.clock.now());
    return {
      schema_version: 1,
      request_id: result.row.request_id,
      duplicate: result.duplicate,
      plan: result.plan,
      preflight: { storage, toolchain, ci_trusted: git.ci_trusted, fast_forward: git.target_reachable },
    };
  }

  apply(request: ApplyRequest): Record<string, unknown> {
    const result = this.database.approve(request, this.clock.now());
    return {
      schema_version: 1,
      accepted: true,
      duplicate: result.duplicate,
      request_id: result.row.request_id,
      state: result.row.state,
      target_sha: result.row.target_sha,
    };
  }

  cancel(requestId: string, sourceEventId: string, replyTarget: PlanRequest["reply_target"], reason = "Cancelled by operator"): Record<string, unknown> {
    const row = this.database.requestCancellation(requestId, sourceEventId, replyTarget, redactText(reason), this.clock.now());
    return { schema_version: 1, request_id: row.request_id, state: row.state };
  }

  async status(requestId?: string): Promise<Record<string, unknown>> {
    if (!requestId) return { schema_version: 1, updates: this.database.list() };
    const row = this.database.get(requestId);
    if (!row) throw new Error(`Update request ${requestId} was not found`);
    const observed = await this.releases.observe();
    const activeRelease = observed.current_sha ? path.join(this.policy.release_root, observed.current_sha) : this.policy.current_pointer;
    const [dispatcherHealth, slackHealth, mainAgent] = await Promise.all([
      this.runtime.dispatcherHealth(),
      this.runtime.slackHealth(),
      this.runtime.mainAgentStatus(activeRelease),
    ]);
    return {
      schema_version: 1,
      update: row,
      compatibility: JSON.parse(row.compatibility_json),
      audit: this.database.auditRows(requestId),
      outbox: this.database.outboxFor(requestId) ?? null,
      observed: { ...observed, dispatcher: dispatcherHealth, slack_adapter: slackHealth, main_agent: mainAgent },
    };
  }

  async doctor(): Promise<Record<string, unknown>> {
    const current = await this.releases.readCurrentManifest();
    const previous = await this.releases.readPreviousManifest();
    const [remote, mainAgent] = await Promise.all([
      this.git.refresh(current.sha),
      this.runtime.mainAgentStatus(path.join(this.policy.release_root, current.sha)),
    ]);
    const protectedShas = new Set([current.sha, ...(previous ? [previous.sha] : [])]);
    return {
      schema_version: 1,
      policy_version: this.policy.policy_version,
      repository: this.policy.repository,
      current_sha: current.sha,
      previous_sha: previous?.sha ?? null,
      remote_target_sha: remote.target_sha,
      fast_forward: remote.target_reachable,
      ci_trusted: remote.ci_trusted,
      cleanup_dry_run: await this.releases.cleanupPlan(protectedShas),
      database: "read_write",
      updater_self_update: "disabled",
      main_agent: mainAgent,
    };
  }

  async processNext(): Promise<boolean> {
    const candidate = this.database.nextRunnable();
    if (!candidate) return false;
    if (["quiescing", "activating", "restarting", "verifying", "rolling_back"].includes(candidate.state)) {
      await this.reconcile(candidate.request_id);
      return true;
    }
    if (candidate.state === "approved") {
      if (!candidate.approval_event_id) throw new Error("approved_request_has_no_persisted_approval_event");
      const terminal = await this.dispatcher.eventTerminal(candidate.approval_event_id);
      if (!terminal) return false;
    }
    const row = this.database.claim(candidate.request_id, this.owner, this.policy.timeouts.lease_ms, this.clock.now());
    if (!row) return false;
    this.logger.info("Update attempt claimed", {
      request_id: row.request_id,
      state: row.state,
      fence: row.fence,
      attempt: row.attempt,
      target_sha: row.target_sha,
    });
    try {
      await this.withLeaseHeartbeat(row, () => this.runClaimed(row));
    } catch (error) {
      await this.handleUnexpected(row.request_id, row.fence, error);
    }
    return true;
  }

  async reconcile(requestId: string): Promise<Record<string, unknown>> {
    const existing = this.database.get(requestId);
    if (!existing) throw new Error(`Update request ${requestId} was not found`);
    if (["succeeded", "failed", "rolled_back", "needs_review", "cancelled"].includes(existing.state)) {
      return this.status(requestId);
    }
    const claimed = this.database.claim(requestId, this.owner, this.policy.timeouts.lease_ms, this.clock.now());
    if (!claimed) throw new Error("Update request is leased by another controller");
    const observation = await this.releases.observe();
    const expectedRelease = observation.current_sha ? path.join(this.policy.release_root, observation.current_sha) : this.policy.current_pointer;
    const [dispatcherHealth, slackHealth, mainAgent] = await Promise.all([
      this.runtime.dispatcherHealth(), this.runtime.slackHealth(), this.runtime.mainAgentStatus(expectedRelease),
    ]);
    if (
      observation.current_sha === claimed.target_sha &&
      this.healthMatches(dispatcherHealth, claimed.target_sha, false) &&
      this.healthMatches(slackHealth, claimed.target_sha, true) && mainAgentMatches(mainAgent)
    ) {
      this.database.terminal(claimed.request_id, claimed.fence, "succeeded", "reconciled_target_health", {}, this.clock.now());
    } else if (
      observation.current_sha === claimed.current_sha &&
      this.healthMatches(dispatcherHealth, claimed.current_sha, false) &&
      this.healthMatches(slackHealth, claimed.current_sha, true) && mainAgentMatches(mainAgent)
    ) {
      this.database.terminal(claimed.request_id, claimed.fence, "rolled_back", "reconciled_previous_health", {}, this.clock.now());
    } else if (observation.current_sha !== claimed.current_sha && observation.current_sha !== claimed.target_sha) {
      this.database.terminal(claimed.request_id, claimed.fence, "needs_review", "pointer_observation_mismatch", {
        last_error_code: "pointer_observation_mismatch",
        last_error_message: "Observed current pointer is neither the planned current nor target SHA",
      }, this.clock.now());
    } else if (["activating", "restarting", "verifying", "rolling_back", "quiescing"].includes(claimed.state)) {
      this.database.terminal(claimed.request_id, claimed.fence, "needs_review", "ambiguous_runtime_observation", {
        last_error_code: "ambiguous_runtime_observation",
        last_error_message: "Pointer and versioned health do not establish a safe terminal state",
      }, this.clock.now());
    }
    return this.status(requestId);
  }

  async operatorRollback(requestId: string, planHash: string): Promise<Record<string, unknown>> {
    const row = this.database.beginOperatorRollback(
      requestId,
      planHash,
      this.owner,
      this.policy.timeouts.lease_ms,
      this.clock.now(),
    );
    const observation = await this.releases.observe();
    if (observation.current_sha !== row.target_sha || observation.previous_sha !== row.current_sha) {
      this.database.terminal(row.request_id, row.fence, "needs_review", "operator_rollback_pointer_mismatch", {
        last_error_code: "operator_rollback_pointer_mismatch",
        last_error_message: "Exact target/current pointer pair was not observed; rollback was not attempted",
      }, this.clock.now());
      throw new Error("Operator rollback refused because pointer observation does not match the exact plan");
    }
    await this.withLeaseHeartbeat(row, () => this.rollback(row, "operator_approved_emergency_rollback", {
      operatorApproved: true,
      activeServices: "unknown",
    }));
    return this.status(requestId);
  }

  async deliverOutbox(): Promise<void> {
    for (const candidate of this.database.pendingOutbox()) {
      if (candidate.status === "delivering") {
        if (await this.dispatcher.completionExists(candidate.external_event_id)) {
          this.database.markOutboxDelivered(candidate.outbox_id, this.clock.now());
        } else {
          this.database.markOutboxNeedsReview(candidate.outbox_id, "Prior completion delivery acceptance is unknown", this.clock.now());
        }
        continue;
      }
      const delivering = this.database.markOutboxDelivering(candidate.outbox_id, this.clock.now());
      const outcome = await this.dispatcher.deliverCompletion(delivering);
      if (outcome === "delivered") {
        this.database.markOutboxDelivered(delivering.outbox_id, this.clock.now());
      } else if (outcome === "accepted_unknown") {
        if (await this.dispatcher.completionExists(delivering.external_event_id)) {
          this.database.markOutboxDelivered(delivering.outbox_id, this.clock.now());
        } else {
          this.database.markOutboxNeedsReview(delivering.outbox_id, "Completion POST acceptance is unknown after lookup", this.clock.now());
        }
      } else {
        if (delivering.attempt_count < 3) {
          this.database.markOutboxPending(delivering.outbox_id, "Dispatcher definitively rejected completion; bounded retry pending", this.clock.now());
        } else {
          this.database.markOutboxNeedsReview(delivering.outbox_id, "Dispatcher rejected completion event after bounded retries", this.clock.now());
        }
      }
    }
  }

  private async runClaimed(initial: UpdateRow): Promise<void> {
    let row = initial;
    let mainAgentPaneId: string | undefined;
    this.assertLease(row);
    if (row.state === "preparing") {
      const refreshed = await this.git.refresh(row.current_sha);
      this.assertLease(row);
      if (!refreshed.target_reachable || refreshed.target_sha !== row.target_sha) {
        // A later fast-forward is allowed only when the approved SHA remains reachable. Never follow the new tip.
        const reachable = refreshed.target_sha !== row.target_sha && refreshed.target_reachable;
        if (!reachable) throw new Error("approved_target_is_no_longer_reachable");
      }
      const existingRelease = await this.releases.releaseManifest(row.target_sha);
      this.assertLease(row);
      if (existingRelease) {
        if (existingRelease.repository !== this.policy.repository || existingRelease.policy_version !== row.policy_version ||
          canonicalJson(existingRelease.compatibility) !== canonicalJson(JSON.parse(row.compatibility_json))) {
          throw new Error("existing_immutable_release_does_not_match_approved_plan");
        }
      } else {
        const stagingPath = await this.releases.prepareStaging(row.request_id, row.fence);
        await this.git.stage(row.target_sha, stagingPath);
        this.assertLease(row);
        const build = await this.build.buildRelease(stagingPath);
        this.assertLease(row);
        if (canonicalJson(build.compatibility) !== canonicalJson(JSON.parse(row.compatibility_json))) {
          throw new Error("staged_compatibility_metadata_differs_from_approved_plan");
        }
        const manifest: ReleaseManifest = {
          schema_version: 1,
          sha: row.target_sha,
          repository: this.policy.repository,
          policy_version: row.policy_version,
          lock_hashes: build.lock_hashes,
          node_version: build.node_version,
          npm_version: build.npm_version,
          built_at: this.clock.now().toISOString(),
          compatibility: JSON.parse(row.compatibility_json) as ReleaseManifest["compatibility"],
        };
        await this.releases.publish(stagingPath, manifest);
        this.assertLease(row);
      }
      row = this.database.transition(row.request_id, row.fence, "staged", "release_staged", {}, this.clock.now());
    }
    if (row.state === "staged") {
      if (!row.approval_event_id || !(await this.dispatcher.eventTerminal(row.approval_event_id))) {
        throw new Error("approval_event_terminal_barrier_not_met");
      }
      row = this.database.transition(row.request_id, row.fence, "quiescing", "runtime_quiesce_started", {}, this.clock.now());
    }
    if (row.state === "quiescing") {
      const slackDrain = await this.runtime.quiesceSlack(row.request_id, row.target_sha);
      this.assertLease(row);
      if (!slackDrain.quiescing || !slackDrain.drained || slackDrain.in_flight !== 0) {
        throw new Error("slack_adapter_drain_incomplete");
      }
      const dispatcherDrain = await this.runtime.quiesceDispatcher(row.request_id, row.target_sha);
      this.assertLease(row);
      if (!dispatcherDrain.quiescing || !dispatcherDrain.drained || dispatcherDrain.unsafe_states.length) {
        throw new Error("dispatcher_drain_incomplete");
      }
      const mainAgent = await this.runtime.waitForMainAgentIdle();
      this.assertLease(row);
      if (!mainAgent.exists || !["idle", "done"].includes(mainAgent.status ?? "") ||
        mainAgent.name !== this.policy.main_agent.name || mainAgent.kind !== "codex") {
        await this.restoreQuiescedServices(
          row,
          mainAgent.status === "blocked" ? "main_agent_blocked" : "main_agent_not_idle",
        );
        return;
      }
      const mainAgentStop = await this.runtime.stopMainAgent(mainAgent);
      this.assertLease(row);
      if (mainAgentStop.outcome === "rejected") {
        await this.restoreQuiescedServices(row, mainAgentStop.error_code ?? "main_agent_stop_rejected");
        return;
      }
      if (mainAgentStop.outcome !== "stopped" || !mainAgentStop.pane_id) {
        return void this.needsReview(row, mainAgentStop.error_code ?? "main_agent_stop_acceptance_unknown");
      }
      mainAgentPaneId = mainAgentStop.pane_id;
      const stopSlack = await this.runtime.stopSlack();
      this.assertLease(row);
      if (!resultSucceeded(stopSlack)) return void this.needsReview(row, "slack_stop_acceptance_unknown");
      const stopDispatcher = await this.runtime.stopDispatcher();
      this.assertLease(row);
      if (!resultSucceeded(stopDispatcher)) return void this.needsReview(row, "dispatcher_stop_acceptance_unknown");
      row = this.database.transition(row.request_id, row.fence, "activating", "runtime_quiesced", {}, this.clock.now());
    }
    if (row.state === "activating") {
      const releasePath = `${this.policy.release_root}/${row.target_sha}`;
      const receipt = await this.releases.activate(row, releasePath);
      this.assertLease(row);
      this.database.recordActivationGeneration(row.request_id, row.fence, receipt.generation, this.clock.now());
      row = this.database.transition(row.request_id, row.fence, "restarting", "pointer_activated", {
        activation_generation: receipt.generation,
      }, this.clock.now());
    }
    if (row.state === "restarting") {
      this.database.incrementRestartAttempts(row.request_id, row.fence, this.clock.now());
      if (!mainAgentPaneId) return void this.needsReview(row, "main_agent_pane_not_recorded");
      const targetRelease = path.join(this.policy.release_root, row.target_sha);
      const mainAgentStart = await this.runtime.startMainAgent(mainAgentPaneId, targetRelease);
      this.assertLease(row);
      if (mainAgentStart.outcome === "accepted_unknown") {
        return void this.needsReview(row, mainAgentStart.error_code ?? "main_agent_start_acceptance_unknown");
      }
      if (mainAgentStart.outcome === "rejected") {
        await this.rollback(row, mainAgentStart.error_code ?? "main_agent_target_start_failed", {
          knownPaneId: mainAgentPaneId,
          activeServices: "none",
        });
        return;
      }
      const dispatcherStart = await this.runtime.startDispatcher();
      this.assertLease(row);
      if (!resultSucceeded(dispatcherStart)) return void this.needsReview(row, "dispatcher_start_acceptance_unknown");
      const dispatcherHealth = await this.waitForHealth("dispatcher", row.target_sha);
      this.assertLease(row);
      if (!this.healthMatches(dispatcherHealth, row.target_sha, false)) {
        if (dispatcherHealth.live && dispatcherHealth.build_sha && dispatcherHealth.build_sha !== row.target_sha) {
          await this.rollback(row, "dispatcher_wrong_target_sha", { activeServices: "dispatcher" });
        } else {
          this.needsReview(row, "dispatcher_target_health_unavailable");
        }
        return;
      }
      const slackStart = await this.runtime.startSlack();
      this.assertLease(row);
      if (!resultSucceeded(slackStart)) return void this.needsReview(row, "slack_start_acceptance_unknown");
      row = this.database.transition(row.request_id, row.fence, "verifying", "services_started", {}, this.clock.now());
    }
    if (row.state === "verifying") {
      const slackHealth = await this.waitForHealth("slack_adapter", row.target_sha);
      this.assertLease(row);
      if (!this.healthMatches(slackHealth, row.target_sha, true)) {
        if (slackHealth.live && slackHealth.build_sha && slackHealth.build_sha !== row.target_sha) {
          await this.rollback(row, "slack_wrong_target_sha", { activeServices: "all" });
        } else {
          this.needsReview(row, "slack_workspace_readiness_unavailable");
        }
        return;
      }
      const mainAgent = await this.runtime.mainAgentStatus(path.join(this.policy.release_root, row.target_sha));
      this.assertLease(row);
      if (!mainAgentMatches(mainAgent)) {
        await this.rollback(row, "main_agent_target_unavailable", { activeServices: "all" });
        return;
      }
      this.database.checkpoint();
      this.database.terminal(row.request_id, row.fence, "succeeded", "target_verified", {}, this.clock.now());
      this.logger.info("Update succeeded", { request_id: row.request_id, target_sha: row.target_sha, fence: row.fence });
      try {
        await this.releases.cleanup(new Set([row.target_sha, row.current_sha]));
      } catch (error) {
        this.logger.warn("Release retention cleanup failed after successful activation", {
          request_id: row.request_id,
          error_code: "retention_cleanup_failed",
          error_message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async rollback(
    row: UpdateRow,
    reason: string,
    options: { operatorApproved?: boolean; knownPaneId?: string; activeServices: ActiveServices },
  ): Promise<void> {
    this.assertLease(row);
    if (row.rollback_compatible !== 1 || (!options.operatorApproved && row.restart_attempts > 1)) {
      this.needsReview(row, "rollback_not_safe_or_circuit_open");
      return;
    }
    let rolling = this.database.transition(row.request_id, row.fence, "rolling_back", "rollback_started", {
      last_error_code: reason,
      last_error_message: "Target regression was observed by versioned local health",
    }, this.clock.now());
    if (options.activeServices === "all") {
      const slackDrain = await this.runtime.quiesceSlack(rolling.request_id, rolling.current_sha);
      this.assertLease(rolling);
      if (!slackDrain.quiescing || !slackDrain.drained || slackDrain.in_flight !== 0) {
        return void this.needsReview(rolling, "rollback_slack_drain_incomplete");
      }
    }
    if (["dispatcher", "all"].includes(options.activeServices)) {
      const dispatcherDrain = await this.runtime.quiesceDispatcher(rolling.request_id, rolling.current_sha);
      this.assertLease(rolling);
      if (!dispatcherDrain.quiescing || !dispatcherDrain.drained || dispatcherDrain.unsafe_states.length) {
        return void this.needsReview(rolling, "rollback_dispatcher_drain_incomplete");
      }
    }
    let mainAgentPaneId = options.knownPaneId;
    if (!mainAgentPaneId) {
      const mainAgent = await this.runtime.waitForMainAgentIdle();
      this.assertLease(rolling);
      if (!mainAgent.exists || !["idle", "done"].includes(mainAgent.status ?? "")) {
        return void this.needsReview(rolling, mainAgent.status === "blocked" ? "rollback_main_agent_blocked" : "rollback_main_agent_not_idle");
      }
      const mainAgentStop = await this.runtime.stopMainAgent(mainAgent);
      this.assertLease(rolling);
      if (mainAgentStop.outcome !== "stopped" || !mainAgentStop.pane_id) {
        return void this.needsReview(rolling, mainAgentStop.error_code ?? "rollback_main_agent_stop_unknown");
      }
      mainAgentPaneId = mainAgentStop.pane_id;
    }
    if (["all", "unknown"].includes(options.activeServices)) {
      const stopSlack = await this.runtime.stopSlack();
      this.assertLease(rolling);
      if (!resultSucceeded(stopSlack)) return void this.needsReview(rolling, "rollback_slack_stop_acceptance_unknown");
    }
    if (["dispatcher", "all", "unknown"].includes(options.activeServices)) {
      const stopDispatcher = await this.runtime.stopDispatcher();
      this.assertLease(rolling);
      if (!resultSucceeded(stopDispatcher)) {
        return void this.needsReview(rolling, "rollback_dispatcher_stop_acceptance_unknown");
      }
    }
    const receipt = await this.releases.rollback(rolling);
    this.assertLease(rolling);
    this.database.recordActivationGeneration(rolling.request_id, rolling.fence, receipt.generation, this.clock.now());
    rolling = { ...rolling, activation_generation: receipt.generation };
    const mainAgentStart = await this.runtime.startMainAgent(
      mainAgentPaneId,
      path.join(this.policy.release_root, rolling.current_sha),
    );
    this.assertLease(rolling);
    if (mainAgentStart.outcome !== "started") {
      return void this.needsReview(rolling, mainAgentStart.error_code ?? "rollback_main_agent_start_unknown");
    }
    const dispatcherStart = await this.runtime.startDispatcher();
    this.assertLease(rolling);
    if (!resultSucceeded(dispatcherStart)) return void this.needsReview(rolling, "rollback_dispatcher_start_unknown");
    const dispatcherHealth = await this.waitForHealth("dispatcher", rolling.current_sha);
    this.assertLease(rolling);
    if (!this.healthMatches(dispatcherHealth, rolling.current_sha, false)) return void this.needsReview(rolling, "rollback_dispatcher_health_failed");
    const slackStart = await this.runtime.startSlack();
    this.assertLease(rolling);
    if (!resultSucceeded(slackStart)) return void this.needsReview(rolling, "rollback_slack_start_unknown");
    const slackHealth = await this.waitForHealth("slack_adapter", rolling.current_sha);
    this.assertLease(rolling);
    if (!this.healthMatches(slackHealth, rolling.current_sha, true)) return void this.needsReview(rolling, "rollback_previous_health_failed");
    this.database.terminal(rolling.request_id, rolling.fence, "rolled_back", "previous_release_verified", {
      last_error_code: reason,
      last_error_message: "Target regression triggered one compatible rollback",
      activation_generation: receipt.generation,
    }, this.clock.now());
  }

  private async waitForHealth(service: HealthSnapshot["service"], sha: string): Promise<HealthSnapshot> {
    const deadline = Date.now() + this.policy.timeouts.health_ms;
    let latest: HealthSnapshot;
    do {
      latest = service === "dispatcher" ? await this.runtime.dispatcherHealth() : await this.runtime.slackHealth();
      if (this.healthMatches(latest, sha, service === "slack_adapter")) return latest;
      if (latest.live && latest.build_sha && latest.build_sha !== sha) return latest;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    return latest!;
  }

  private healthMatches(health: HealthSnapshot, sha: string, requireWorkspaces: boolean): boolean {
    return health.ready && health.build_sha === sha && health.protocol === this.policy.compatibility.protocol &&
      health.app_schema === this.policy.compatibility.app_schema_write && health.config === this.policy.compatibility.config &&
      (!requireWorkspaces || health.workspaces_ready === true);
  }

  private async restoreQuiescedServices(row: UpdateRow, causeCode: string): Promise<void> {
    const dispatcherStart = await this.runtime.startDispatcher();
    this.assertLease(row);
    if (!resultSucceeded(dispatcherStart)) {
      this.needsReview(
        row,
        "quiesce_recovery_dispatcher_restart_unknown",
        `Update stopped before main-agent mutation (${causeCode}), but Dispatcher restart acceptance is unknown; no blind retry was attempted`,
      );
      return;
    }
    const dispatcherHealth = await this.waitForHealth("dispatcher", row.current_sha);
    this.assertLease(row);
    if (!this.healthMatches(dispatcherHealth, row.current_sha, false)) {
      this.needsReview(
        row,
        "quiesce_recovery_dispatcher_health_failed",
        `Update stopped before main-agent mutation (${causeCode}), but current Dispatcher health was not verified`,
      );
      return;
    }
    const slackStart = await this.runtime.startSlack();
    this.assertLease(row);
    if (!resultSucceeded(slackStart)) {
      this.needsReview(
        row,
        "quiesce_recovery_slack_restart_unknown",
        `Update stopped before main-agent mutation (${causeCode}), but Slack restart acceptance is unknown; no blind retry was attempted`,
      );
      return;
    }
    const slackHealth = await this.waitForHealth("slack_adapter", row.current_sha);
    this.assertLease(row);
    if (!this.healthMatches(slackHealth, row.current_sha, true)) {
      this.needsReview(
        row,
        "quiesce_recovery_slack_health_failed",
        `Update stopped before main-agent mutation (${causeCode}), but current Slack health was not verified`,
      );
      return;
    }
    this.logger.info("Quiesced current services were restarted after a pre-mutation update stop", {
      request_id: row.request_id,
      current_sha: row.current_sha,
      cause_code: causeCode,
    });
    this.needsReview(
      row,
      causeCode,
      "Update stopped before main-agent mutation; current Dispatcher and Slack services were restarted and verified",
    );
  }

  private needsReview(
    row: UpdateRow,
    code: string,
    message = "External command or runtime acceptance could not be proven; no blind retry was attempted",
  ): void {
    this.database.terminal(row.request_id, row.fence, "needs_review", code, {
      last_error_code: code,
      last_error_message: message,
    }, this.clock.now());
  }

  private assertLease(row: UpdateRow): void {
    this.database.assertLease(row.request_id, row.fence, this.owner, this.clock.now());
  }

  private async withLeaseHeartbeat<T>(row: UpdateRow, operation: () => Promise<T>): Promise<T> {
    const interval = setInterval(() => {
      try {
        this.database.renewLease(row.request_id, row.fence, this.owner, this.policy.timeouts.lease_ms, this.clock.now());
      } catch (error) {
        this.logger.warn("Update lease renewal failed; the next phase boundary will fail closed", {
          request_id: row.request_id,
          fence: row.fence,
          error_code: "lease_renewal_failed",
          error_message: redactText(error instanceof Error ? error.message : String(error), 500),
        });
      }
    }, Math.max(250, Math.floor(this.policy.timeouts.lease_ms / 3)));
    interval.unref();
    try {
      return await operation();
    } finally {
      clearInterval(interval);
    }
  }

  private async handleUnexpected(requestId: string, fence: number, error: unknown): Promise<void> {
    const row = this.database.get(requestId);
    if (!row || row.fence !== fence || ["succeeded", "failed", "rolled_back", "needs_review", "cancelled"].includes(row.state)) return;
    const message = error instanceof Error ? error.message : String(error);
    const mutated = ["quiescing", "activating", "restarting", "verifying", "rolling_back"].includes(row.state);
    this.database.terminal(requestId, fence, mutated ? "needs_review" : "failed", mutated ? "runtime_operation_failed" : "pre_activation_failed", {
      last_error_code: mutated ? "runtime_operation_failed" : "pre_activation_failed",
      last_error_message: redactText(message),
    }, this.clock.now());
    this.logger.error("Update attempt failed", {
      request_id: requestId,
      state: row.state,
      fence,
      error_code: mutated ? "runtime_operation_failed" : "pre_activation_failed",
      error_message: redactText(message, 500),
    });
  }
}
