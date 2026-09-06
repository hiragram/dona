import { ulid } from "ulid";
import path from "node:path";

import type { UpdateDatabase } from "./database.js";
import type { UpdatePolicy } from "./policy.js";
import type { BuildPort, Clock, DispatcherPort, GitPort, Logger, ReleaseStorePort, RuntimePort } from "./ports.js";
import { redactText } from "./redaction.js";
import type {
  ApplyRequest,
  CommandResult,
  HealthSnapshot,
  MainAgentObservation,
  OutboxRow,
  PlanRequest,
  ReleaseManifest,
  RuntimeOperationKind,
  UpdateRow,
} from "./types.js";
import { canonicalJson } from "./validation.js";

const systemClock: Clock = { now: () => new Date() };
interface TerminalObservation {
  status: "succeeded" | "rolled_back";
  activeSha: string;
}

export function releaseCompatibilityMatches(
  previous: ReleaseManifest["compatibility"],
  target: ReleaseManifest["compatibility"],
): boolean {
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
    const rollbackCompatible = releaseCompatibilityMatches(current.compatibility, targetManifest.compatibility);
    if (!rollbackCompatible) throw new Error("target_is_not_rollback_compatible_with_current_release");
    let controlPlane: { ready: boolean; build_sha: string | null } | undefined;
    if (current.compatibility.app_schema_write === 2 && targetManifest.compatibility.app_schema_write === 3) {
      controlPlane = await this.runtime.schemaMigrationCapability();
      if (!controlPlane.ready) throw new Error("stable_updater_schema_migration_capability_required");
    }
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
      preflight: {
        storage, toolchain, ci_trusted: git.ci_trusted, fast_forward: git.target_reachable,
        ...(controlPlane ? { schema_migration_control_plane_sha: controlPlane.build_sha } : {}),
      },
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
    if (!requestId) {
      return {
        schema_version: 1,
        updates: this.database.list(),
        nonterminal_count: this.database.nonTerminalCount(),
      };
    }
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
      runtime_operations: this.database.runtimeOperations(requestId),
      runtime_state: row.state,
      notification_state: this.notificationState(this.database.outboxFor(requestId)),
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
    if (candidate && this.database.hasUnreportedTerminalNotification()) return false;
    if (!candidate) {
      const review = this.database.reconcilableNeedsReview()[0];
      if (!review) return false;
      await this.reconcile(review.request_id);
      return true;
    }
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
    if (["succeeded", "failed", "rolled_back", "cancelled"].includes(existing.state)) {
      return this.status(requestId);
    }
    if (existing.state === "needs_review") {
      const terminal = await this.observeTerminal(existing);
      if (!terminal || !this.database.terminalOutboxSettledForCorrection(requestId)) return this.status(requestId);
      this.database.completeEvidenceReconcile(requestId, terminal.status, terminal.activeSha, this.clock.now());
      return this.status(requestId);
    }
    const claimed = this.database.claim(requestId, this.owner, this.policy.timeouts.lease_ms, this.clock.now());
    if (!claimed) throw new Error("Update request is leased by another controller");
    if (["quiescing", "restarting", "verifying", "rolling_back"].includes(claimed.state)) {
      await this.withLeaseHeartbeat(claimed, () => this.runClaimed(claimed));
      return this.status(requestId);
    }
    const observation = await this.releases.observe();
    const expectedRelease = observation.current_sha ? path.join(this.policy.release_root, observation.current_sha) : this.policy.current_pointer;
    const [dispatcherHealth, slackHealth, mainAgent, activeManifest] = await Promise.all([
      this.runtime.dispatcherHealth(), this.runtime.slackHealth(), this.runtime.mainAgentStatus(expectedRelease),
      observation.current_sha ? this.releases.releaseManifest(observation.current_sha) : Promise.resolve(null),
    ]);
    const targetCompatibility = JSON.parse(claimed.compatibility_json) as ReleaseManifest["compatibility"];
    if (
      observation.current_sha === claimed.target_sha &&
      observation.previous_sha === claimed.current_sha &&
      observation.receipt?.request_id === claimed.request_id &&
      observation.receipt.from_sha === claimed.current_sha &&
      observation.receipt.to_sha === claimed.target_sha &&
      observation.receipt.fence <= claimed.fence &&
      observation.receipt.generation === claimed.activation_generation &&
      this.healthMatches(dispatcherHealth, claimed.target_sha, false, targetCompatibility) &&
      this.healthMatches(slackHealth, claimed.target_sha, true, targetCompatibility) &&
      this.notificationReporterReady(dispatcherHealth, slackHealth) &&
      this.mainAgentMatchesReceipt(claimed, mainAgent)
    ) {
      this.database.terminal(claimed.request_id, claimed.fence, "succeeded", "reconciled_target_health", {}, this.clock.now());
    } else if (
      observation.current_sha === claimed.current_sha &&
      observation.previous_sha === claimed.target_sha &&
      observation.receipt?.request_id === claimed.request_id &&
      observation.receipt.from_sha === claimed.target_sha &&
      observation.receipt.to_sha === claimed.current_sha &&
      observation.receipt.fence <= claimed.fence &&
      observation.receipt.generation === claimed.activation_generation &&
      activeManifest !== null &&
      this.healthMatches(dispatcherHealth, claimed.current_sha, false, activeManifest.compatibility) &&
      this.healthMatches(slackHealth, claimed.current_sha, true, activeManifest.compatibility) &&
      this.notificationReporterReady(dispatcherHealth, slackHealth) && mainAgentMatches(mainAgent)
    ) {
      this.database.terminal(claimed.request_id, claimed.fence, "rolled_back", "reconciled_previous_health", {}, this.clock.now());
    } else if (observation.current_sha !== claimed.current_sha && observation.current_sha !== claimed.target_sha) {
      this.database.terminal(claimed.request_id, claimed.fence, "needs_review", "pointer_observation_mismatch", {
        last_error_code: "pointer_observation_mismatch",
        last_error_message: "Observed current pointer is neither the planned current nor target SHA",
      }, this.clock.now());
    } else if (claimed.state === "activating" && observation.current_sha === claimed.target_sha &&
      observation.previous_sha === claimed.current_sha &&
      observation.receipt?.request_id === claimed.request_id &&
      observation.receipt.from_sha === claimed.current_sha &&
      observation.receipt.to_sha === claimed.target_sha && observation.receipt.fence <= claimed.fence &&
      (observation.receipt.generation === claimed.activation_generation ||
        observation.receipt.generation === claimed.activation_generation + 1)) {
      const restarting = this.database.transition(claimed.request_id, claimed.fence, "restarting", "activation_reconciled", {
        activation_generation: observation.receipt.generation,
      }, this.clock.now());
      await this.withLeaseHeartbeat(restarting, () => this.runClaimed(restarting));
    } else if (["activating", "quiescing"].includes(claimed.state)) {
      this.deferOrReview(claimed, "ambiguous_runtime_observation", "Pointer and versioned health do not establish a safe terminal state");
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
    }));
    return this.status(requestId);
  }

  async deliverOutbox(): Promise<void> {
    for (const candidate of this.database.pendingOutbox(100, this.clock.now())) {
      if (candidate.status === "delivering" || candidate.status === "delivered") {
        const lookup = await this.dispatcher.completionLookup(candidate);
        if (lookup.outcome === "exists") {
          if (candidate.status !== "delivered") {
            this.database.markOutboxDelivered(candidate.outbox_id, lookup.event_id, this.clock.now());
          }
          if (lookup.status === "completed") {
            this.database.markOutboxReported(candidate.outbox_id, this.clock.now());
          } else if (["needs_review", "dead_letter"].includes(lookup.status)) {
            this.database.markOutboxNeedsReview(candidate.outbox_id, `Dispatcher notification event entered ${lookup.status}`, this.clock.now());
          } else {
            this.database.deferOutboxReport(candidate.outbox_id, "Slack terminal report is still pending", this.clock.now());
          }
        } else if (lookup.outcome === "absent") {
          this.database.markOutboxPending(candidate.outbox_id, "Dispatcher authoritatively reported the event absent", this.clock.now());
        } else if (lookup.outcome === "conflict") {
          this.database.markOutboxNeedsReview(candidate.outbox_id, lookup.error_code, this.clock.now());
        } else {
          this.database.deferOutboxLookup(candidate.outbox_id, lookup.error_code, this.clock.now());
        }
        continue;
      }
      const delivering = this.database.markOutboxDelivering(candidate.outbox_id, this.clock.now());
      const outcome = await this.dispatcher.deliverCompletion(delivering);
      if (outcome.outcome === "accepted") {
        this.database.markOutboxDelivered(delivering.outbox_id, outcome.event_id, this.clock.now());
      } else if (outcome.outcome === "definitive_rejection") {
        this.database.markOutboxNeedsReview(delivering.outbox_id, outcome.error_code, this.clock.now());
      } else if (outcome.outcome === "acceptance_unknown") {
        this.database.deferOutboxLookup(delivering.outbox_id, outcome.error_code, this.clock.now());
      } else {
        this.database.markOutboxPending(delivering.outbox_id, outcome.error_code, this.clock.now());
      }
    }
  }

  private async runClaimed(initial: UpdateRow): Promise<void> {
    let row = initial;
    const targetCompatibility = JSON.parse(initial.compatibility_json) as ReleaseManifest["compatibility"];
    let mainAgentPaneId = this.database.runtimeOperation(row.request_id, "stop_main_agent")?.target_ref;
    this.assertLease(row);
    if (row.state === "rolling_back") {
      await this.resumeRollback(row);
      return;
    }
    if (row.state === "preparing") {
      const activeManifest = await this.releases.readCurrentManifest();
      this.assertLease(row);
      if (activeManifest.sha !== row.current_sha) {
        throw new Error("planned_current_release_is_no_longer_active");
      }
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
      const persistedStop = this.database.runtimeOperation(row.request_id, "stop_main_agent");
      const persistedRecovery = this.database.runtimeOperation(row.request_id, "restart_current_dispatcher") ??
        this.database.runtimeOperation(row.request_id, "restart_current_slack");
      if (persistedRecovery || persistedStop?.phase === "rejected") {
        let evidence: Record<string, unknown> = {};
        try {
          evidence = JSON.parse((persistedRecovery ?? persistedStop)!.evidence_json) as Record<string, unknown>;
        } catch {
          // Invalid persisted evidence is not used to broaden the recovery action.
        }
        await this.restoreQuiescedServices(
          row,
          typeof evidence.cause_code === "string"
            ? evidence.cause_code
            : typeof evidence.error_code === "string"
              ? evidence.error_code
              : "main_agent_stop_rejected",
        );
        return;
      }
      // Quiesce is keyed by the stable request ID and is idempotent. Re-observe it
      // after every controller restart in case either ingress service also restarted.
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
      if (!persistedStop) {
        const drainedMainAgent = await this.runtime.waitForMainAgentIdle();
        this.assertLease(row);
        const currentMainAgent = await this.runtime.mainAgentStatus(
          path.join(this.policy.release_root, row.current_sha),
        );
        this.assertLease(row);
        const sameCurrentIdentity = currentMainAgent.pane_id === drainedMainAgent.pane_id &&
          currentMainAgent.session_id === drainedMainAgent.session_id;
        if (!drainedMainAgent.exists || !["idle", "done"].includes(drainedMainAgent.status ?? "") ||
          !sameCurrentIdentity || !currentMainAgent.exists ||
          !["idle", "done"].includes(currentMainAgent.status ?? "") || !currentMainAgent.matches_release ||
          currentMainAgent.name !== this.policy.main_agent.name || currentMainAgent.kind !== "codex" ||
          !currentMainAgent.pane_id || !currentMainAgent.session_id) {
          await this.restoreQuiescedServices(
            row,
            drainedMainAgent.status === "blocked"
              ? "main_agent_blocked"
              : !sameCurrentIdentity || !currentMainAgent.matches_release
                ? "main_agent_identity_changed"
                : "main_agent_not_idle",
          );
          return;
        }
        this.database.prepareRuntimeOperation(
          row.request_id, row.fence, "stop_main_agent", currentMainAgent.pane_id, row.current_sha,
          currentMainAgent.session_id, { observation: currentMainAgent }, this.clock.now(),
        );
        const stopped = await this.runtime.stopMainAgent(currentMainAgent);
        this.assertLease(row);
        if (stopped.outcome === "rejected") {
          this.database.recordRuntimeOperation(row.request_id, row.fence, "stop_main_agent", "rejected", null, {
            error_code: stopped.error_code,
          }, this.clock.now());
          await this.restoreQuiescedServices(row, stopped.error_code ?? "main_agent_stop_rejected");
          return;
        }
        if (stopped.outcome !== "stopped" || !stopped.pane_id) {
          this.database.recordRuntimeOperation(row.request_id, row.fence, "stop_main_agent", "acceptance_unknown", null, {
            error_code: stopped.error_code,
          }, this.clock.now());
          this.deferOrReview(row, "main_agent_stop_acceptance_unknown", "Main-agent stop acceptance is unknown");
          return;
        }
        this.database.recordRuntimeOperation(row.request_id, row.fence, "stop_main_agent", "observed", null, {}, this.clock.now());
        mainAgentPaneId = stopped.pane_id;
      } else if (persistedStop.phase !== "observed") {
        const currentAgent = await this.runtime.mainAgentStatus(path.join(this.policy.release_root, row.current_sha));
        this.assertLease(row);
        if (!currentAgent.exists) {
          this.database.recordRuntimeOperation(row.request_id, row.fence, "stop_main_agent", "observed", null, {}, this.clock.now());
        } else {
          this.deferOrReview(row, "main_agent_stop_acceptance_unknown", "Persisted main-agent stop has not been observed");
          return;
        }
      }
      if (!(await this.ensureServiceStopped(
        row, "stop_slack", "slack_adapter", row.current_sha, () => this.runtime.stopSlack(),
      ))) return;
      if (!(await this.ensureServiceStopped(
        row, "stop_dispatcher", "dispatcher", row.current_sha, () => this.runtime.stopDispatcher(),
      ))) return;
      const previousCompatibility = (await this.releases.readCurrentManifest()).compatibility;
      if (previousCompatibility.app_schema_write === 2 && targetCompatibility.app_schema_write === 3) {
        const controlPlane = await this.runtime.schemaMigrationCapability();
        this.assertLease(row);
        if (!controlPlane.ready) {
          this.needsReview(row, "stable_updater_schema_migration_capability_unverified");
          return;
        }
        const migration = await this.runtime.migrateAppSchema(
          row.request_id, row.target_sha, previousCompatibility, targetCompatibility,
        );
        this.assertLease(row);
        if (migration.timed_out || migration.output_truncated || migration.exit_code !== 0) {
          this.needsReview(row, "app_schema_migration_unverified");
          return;
        }
      }
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
      if (!this.database.runtimeOperation(row.request_id, "start_target_main_agent")) {
        this.database.incrementRestartAttempts(row.request_id, row.fence, this.clock.now());
      }
      if (!mainAgentPaneId) return void this.needsReview(row, "main_agent_pane_not_recorded");
      const targetRelease = path.join(this.policy.release_root, row.target_sha);
      const mainStart = await this.ensureTargetMainAgent(row, mainAgentPaneId, targetRelease);
      if (mainStart === "deferred") return;
      if (mainStart === "rejected") {
        await this.rollback(row, "main_agent_target_start_failed", {
          knownPaneId: mainAgentPaneId,
        });
        return;
      }
      const dispatcherStart = await this.ensureServiceStarted(
        row, "start_target_dispatcher", "dispatcher", row.target_sha, () => this.runtime.startDispatcher(),
        targetCompatibility,
      );
      if (dispatcherStart === "deferred") return;
      if (dispatcherStart === "wrong_sha") {
        await this.rollback(row, "dispatcher_wrong_target_sha", {});
        return;
      }
      const slackStart = await this.ensureServiceStarted(
        row, "start_target_slack", "slack_adapter", row.target_sha, () => this.runtime.startSlack(),
        targetCompatibility,
      );
      if (slackStart === "deferred") return;
      if (slackStart === "wrong_sha") {
        await this.rollback(row, "slack_wrong_target_sha", {});
        return;
      }
      row = this.database.transition(row.request_id, row.fence, "verifying", "services_started", {}, this.clock.now());
    }
    if (row.state === "verifying") {
      const [pointer, dispatcherHealth, slackHealth, mainAgent] = await Promise.all([
        this.releases.observe(),
        this.runtime.dispatcherHealth(),
        this.runtime.slackHealth(),
        this.runtime.mainAgentStatus(path.join(this.policy.release_root, row.target_sha)),
      ]);
      this.assertLease(row);
      if (pointer.current_sha !== row.target_sha || pointer.previous_sha !== row.current_sha ||
        pointer.receipt?.request_id !== row.request_id || pointer.receipt.from_sha !== row.current_sha ||
        pointer.receipt.to_sha !== row.target_sha || pointer.receipt.generation !== row.activation_generation ||
        pointer.receipt.fence > row.fence) {
        this.deferOrReview(row, "activation_evidence_mismatch", "Target pointer and activation receipt do not match the exact update");
        return;
      }
      if (dispatcherHealth.live && dispatcherHealth.build_sha && dispatcherHealth.build_sha !== row.target_sha) {
        await this.rollback(row, "dispatcher_wrong_target_sha", {});
        return;
      }
      if (slackHealth.live && slackHealth.build_sha && slackHealth.build_sha !== row.target_sha) {
        await this.rollback(row, "slack_wrong_target_sha", {});
        return;
      }
      if (!this.healthMatches(dispatcherHealth, row.target_sha, false, targetCompatibility) ||
        !this.healthMatches(slackHealth, row.target_sha, true, targetCompatibility) ||
        !this.notificationReporterReady(dispatcherHealth, slackHealth) ||
        !this.mainAgentMatchesReceipt(row, mainAgent)) {
        this.deferOrReview(row, "ambiguous_runtime_observation", "Target runtime has not reached the exact verified state");
        return;
      }
      this.database.checkpoint();
      this.database.terminal(row.request_id, row.fence, "succeeded", "target_verified", {
        observed_active_sha: row.target_sha,
      }, this.clock.now());
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
    options: { operatorApproved?: boolean; knownPaneId?: string },
  ): Promise<void> {
    this.assertLease(row);
    if (row.rollback_compatible !== 1 || (!options.operatorApproved && row.restart_attempts > 1)) {
      this.needsReview(row, "rollback_not_safe_or_circuit_open");
      return;
    }
    const rolling = this.database.transition(row.request_id, row.fence, "rolling_back", "rollback_started", {
      last_error_code: reason,
      last_error_message: "Target regression was observed by versioned local health",
    }, this.clock.now());
    await this.resumeRollback(rolling, options.knownPaneId);
  }

  private async resumeRollback(row: UpdateRow, knownPaneId?: string): Promise<void> {
    this.assertLease(row);
    const previousManifest = await this.releases.releaseManifest(row.current_sha);
    this.assertLease(row);
    if (!previousManifest) {
      this.needsReview(row, "rollback_previous_release_manifest_missing");
      return;
    }
    const previousCompatibility = previousManifest.compatibility;
    let observation = await this.releases.observe();
    let receipt = observation.receipt;
    const pointerAlreadyRolledBack = observation.current_sha === row.current_sha &&
      observation.previous_sha === row.target_sha && receipt?.request_id === row.request_id &&
      receipt.from_sha === row.target_sha && receipt.to_sha === row.current_sha && receipt.fence <= row.fence &&
      (receipt.generation === row.activation_generation || receipt.generation === row.activation_generation + 1);
    const exactActivationReceipt = receipt?.request_id === row.request_id &&
      receipt.from_sha === row.current_sha && receipt.to_sha === row.target_sha &&
      receipt.generation === row.activation_generation && receipt.fence <= row.fence;
    const rollbackPointerMutationStarted = observation.current_sha === row.current_sha &&
      (observation.previous_sha === row.current_sha || observation.previous_sha === row.target_sha) &&
      exactActivationReceipt;

    if (!pointerAlreadyRolledBack) {
      if (observation.current_sha !== row.target_sha && !rollbackPointerMutationStarted) {
        this.deferOrReview(row, "rollback_pointer_observation_mismatch", "Rollback pointer is neither the target nor the exact observed previous release");
        return;
      }
      if (observation.current_sha === row.target_sha) {
        if (observation.previous_sha !== row.current_sha || !exactActivationReceipt) {
          this.deferOrReview(row, "rollback_activation_evidence_mismatch", "Rollback requires the exact target/current pointer pair and activation receipt");
          return;
        }
        const [slackHealth, dispatcherHealth] = await Promise.all([
          this.runtime.slackHealth(), this.runtime.dispatcherHealth(),
        ]);
        this.assertLease(row);
        if (slackHealth.live) {
          const slackDrain = await this.runtime.quiesceSlack(row.request_id, row.target_sha);
          this.assertLease(row);
          if (!slackDrain.quiescing || !slackDrain.drained || slackDrain.in_flight !== 0) {
            this.needsReview(row, "rollback_slack_drain_incomplete");
            return;
          }
        }
        if (dispatcherHealth.live) {
          const dispatcherDrain = await this.runtime.quiesceDispatcher(row.request_id, row.target_sha);
          this.assertLease(row);
          if (!dispatcherDrain.quiescing || !dispatcherDrain.drained || dispatcherDrain.unsafe_states.length) {
            this.needsReview(row, "rollback_dispatcher_drain_incomplete");
            return;
          }
        }
        const stoppedMain = await this.ensureRollbackMainAgentStopped(row, knownPaneId);
        if (!stoppedMain) return;
        knownPaneId = stoppedMain;
        if (!(await this.ensureServiceStopped(
          row, "stop_target_slack", "slack_adapter", null, () => this.runtime.stopSlack(),
        ))) return;
        if (!(await this.ensureServiceStopped(
          row, "stop_target_dispatcher", "dispatcher", null, () => this.runtime.stopDispatcher(),
        ))) return;
      } else {
        const stoppedKinds = ["stop_target_main_agent", "stop_target_slack", "stop_target_dispatcher"] as const;
        if (stoppedKinds.some((kind) => this.database.runtimeOperation(row.request_id, kind)?.phase !== "observed")) {
          this.deferOrReview(row, "rollback_stop_evidence_incomplete", "Partial rollback pointer mutation lacks exact persisted stop evidence");
          return;
        }
      }
      receipt = await this.releases.rollback(row);
      this.assertLease(row);
      this.database.recordActivationGeneration(row.request_id, row.fence, receipt.generation, this.clock.now());
      observation = await this.releases.observe();
      this.assertLease(row);
      if (observation.current_sha !== row.current_sha || observation.receipt?.request_id !== row.request_id ||
        observation.previous_sha !== row.target_sha || observation.receipt.from_sha !== row.target_sha ||
        observation.receipt.to_sha !== row.current_sha || observation.receipt.generation !== receipt.generation ||
        observation.receipt.fence > row.fence) {
        this.deferOrReview(row, "rollback_activation_unconfirmed", "Rollback pointer receipt was not observed exactly");
        return;
      }
    } else {
      this.database.recordActivationGeneration(row.request_id, row.fence, receipt!.generation, this.clock.now());
    }
    row = { ...row, activation_generation: receipt!.generation };

    const stopTarget = this.database.runtimeOperation(row.request_id, "stop_target_main_agent");
    const originalStop = this.database.runtimeOperation(row.request_id, "stop_main_agent");
    const targetStart = this.database.runtimeOperation(row.request_id, "start_target_main_agent");
    const paneId = knownPaneId ?? stopTarget?.target_ref ?? originalStop?.target_ref;
    if (!paneId) {
      this.needsReview(row, "rollback_main_agent_pane_not_recorded");
      return;
    }
    const previousSessionId = stopTarget?.previous_session_id ?? targetStart?.observed_session_id ??
      originalStop?.previous_session_id ?? undefined;
    if (!(await this.ensurePreviousMainAgentStarted(row, paneId, previousSessionId))) return;
    const dispatcherStart = await this.ensureServiceStarted(
      row, "start_previous_dispatcher", "dispatcher", row.current_sha, () => this.runtime.startDispatcher(),
      previousCompatibility,
    );
    if (dispatcherStart !== "started") {
      if (dispatcherStart === "wrong_sha") this.needsReview(row, "rollback_dispatcher_wrong_sha");
      return;
    }
    const slackStart = await this.ensureServiceStarted(
      row, "start_previous_slack", "slack_adapter", row.current_sha, () => this.runtime.startSlack(),
      previousCompatibility,
    );
    if (slackStart !== "started") {
      if (slackStart === "wrong_sha") this.needsReview(row, "rollback_slack_wrong_sha");
      return;
    }
    const [pointerFinal, dispatcherFinal, slackFinal, mainFinal] = await Promise.all([
      this.releases.observe(),
      this.runtime.dispatcherHealth(),
      this.runtime.slackHealth(),
      this.runtime.mainAgentStatus(path.join(this.policy.release_root, row.current_sha)),
    ]);
    this.assertLease(row);
    if (pointerFinal.current_sha !== row.current_sha || pointerFinal.previous_sha !== row.target_sha ||
      pointerFinal.receipt?.request_id !== row.request_id || pointerFinal.receipt.from_sha !== row.target_sha ||
      pointerFinal.receipt.to_sha !== row.current_sha || pointerFinal.receipt.generation !== row.activation_generation ||
      pointerFinal.receipt.fence > row.fence ||
      !this.healthMatches(dispatcherFinal, row.current_sha, false, previousCompatibility) ||
      !this.healthMatches(slackFinal, row.current_sha, true, previousCompatibility) ||
      !this.mainAgentMatchesOperation(row, "start_previous_main_agent", row.current_sha, mainFinal)) {
      this.deferOrReview(row, "rollback_previous_health_failed", "Previous runtime has not reached the exact verified state");
      return;
    }
    this.database.checkpoint();
    this.database.terminal(row.request_id, row.fence, "rolled_back", "previous_release_verified", {
      last_error_code: row.last_error_code,
      last_error_message: "Target regression triggered one compatible rollback",
      activation_generation: observation.receipt!.generation,
      observed_active_sha: row.current_sha,
    }, this.clock.now());
  }

  private async waitForHealth(
    service: HealthSnapshot["service"],
    sha: string,
    compatibility: ReleaseManifest["compatibility"],
  ): Promise<HealthSnapshot> {
    const deadline = Date.now() + this.policy.timeouts.health_ms;
    let latest: HealthSnapshot;
    do {
      latest = service === "dispatcher" ? await this.runtime.dispatcherHealth() : await this.runtime.slackHealth();
      if (this.healthMatches(latest, sha, service === "slack_adapter", compatibility)) return latest;
      if (latest.live && latest.build_sha && latest.build_sha !== sha) return latest;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    return latest!;
  }

  private async waitForStopped(service: HealthSnapshot["service"]): Promise<HealthSnapshot> {
    const deadline = Date.now() + this.policy.timeouts.health_ms;
    let latest: HealthSnapshot;
    do {
      latest = service === "dispatcher" ? await this.runtime.dispatcherHealth() : await this.runtime.slackHealth();
      if (!latest.live) return latest;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    return latest!;
  }

  private notificationState(outbox: OutboxRow | undefined): string {
    if (!outbox) return "not_created";
    if (outbox.superseded_by_outbox_id) return "superseded";
    if (outbox.status === "needs_review") return "needs_review";
    if (outbox.slack_reported_at) return "reported";
    if (outbox.status === "delivered") return "dispatcher_accepted";
    if (outbox.status === "delivering") return "acceptance_reconciling";
    return "pending";
  }

  private async observeTerminal(row: UpdateRow): Promise<TerminalObservation | undefined> {
    const observation = await this.releases.observe();
    const activeSha = observation.current_sha;
    if (!activeSha) return undefined;
    const activeRelease = path.join(this.policy.release_root, activeSha);
    const [dispatcherHealth, slackHealth, mainAgent, activeManifest] = await Promise.all([
      this.runtime.dispatcherHealth(),
      this.runtime.slackHealth(),
      this.runtime.mainAgentStatus(activeRelease),
      this.releases.releaseManifest(activeSha),
    ]);
    if (!activeManifest || !this.healthMatches(dispatcherHealth, activeSha, false, activeManifest.compatibility) ||
      !this.healthMatches(slackHealth, activeSha, true, activeManifest.compatibility)) return undefined;

    const captured = this.database.runtimeOperation(row.request_id, "legacy_confirmation");
    if (captured?.phase === "observed") {
      if (!this.notificationReporterReady(dispatcherHealth, slackHealth) || !mainAgentMatches(mainAgent)) return undefined;
      try {
        const evidence = JSON.parse(captured.evidence_json) as Record<string, unknown>;
        if (evidence.confirmed_status === "succeeded" && evidence.confirmed_sha === row.target_sha &&
          evidence.activation_generation === row.activation_generation && evidence.activation_fence === captured.fence &&
          captured.expected_sha === row.target_sha) {
          return { status: "succeeded", activeSha };
        }
        if (evidence.confirmed_status === "rolled_back" && evidence.confirmed_sha === row.current_sha &&
          evidence.activation_generation === row.activation_generation && evidence.activation_fence === captured.fence &&
          captured.expected_sha === row.current_sha) {
          return { status: "rolled_back", activeSha };
        }
      } catch {
        return undefined;
      }
    }

    if (activeSha !== row.target_sha && activeSha !== row.current_sha) return undefined;
    if (activeSha === row.target_sha) {
      if (observation.previous_sha !== row.current_sha || observation.receipt?.request_id !== row.request_id ||
        observation.receipt.from_sha !== row.current_sha ||
        observation.receipt.to_sha !== row.target_sha ||
        observation.receipt.fence > row.fence ||
        observation.receipt.generation !== row.activation_generation) return undefined;
      const exactRuntimeReceipt = this.mainAgentMatchesReceipt(row, mainAgent);
      const migrationBridge = row.policy_version === "2026-09-03.1" &&
        row.last_error_code === "main_agent_start_failed" &&
        this.database.runtimeOperations(row.request_id).length === 0 && mainAgentMatches(mainAgent);
      if (!exactRuntimeReceipt && !migrationBridge) return undefined;
      if (migrationBridge && !this.notificationReporterReady(dispatcherHealth, slackHealth)) {
        const evidence = {
          confirmed_status: "succeeded",
          confirmed_sha: row.target_sha,
          activation_generation: observation.receipt.generation,
          activation_fence: observation.receipt.fence,
          captured_at: this.clock.now().toISOString(),
        };
        this.database.prepareRuntimeOperation(
          row.request_id, row.fence, "legacy_confirmation", "policy-2026-09-03.1-terminal-evidence",
          row.target_sha, null, evidence, this.clock.now(),
        );
        this.database.recordRuntimeOperation(
          row.request_id, row.fence, "legacy_confirmation", "observed", mainAgent.session_id, evidence, this.clock.now(),
        );
        return undefined;
      }
      if (!this.notificationReporterReady(dispatcherHealth, slackHealth)) return undefined;
      return { status: "succeeded", activeSha };
    }
    const rolledBack = observation.previous_sha === row.target_sha &&
      observation.receipt?.request_id === row.request_id &&
      observation.receipt.from_sha === row.target_sha && observation.receipt.to_sha === row.current_sha &&
      observation.receipt.fence <= row.fence &&
      observation.receipt.generation === row.activation_generation &&
      mainAgentMatches(mainAgent);
    if (!rolledBack) return undefined;
    if (!this.notificationReporterReady(dispatcherHealth, slackHealth)) {
      if (row.policy_version === "2026-09-03.1" && this.database.runtimeOperations(row.request_id).length === 0) {
        const evidence = {
          confirmed_status: "rolled_back",
          confirmed_sha: row.current_sha,
          activation_generation: observation.receipt!.generation,
          activation_fence: observation.receipt!.fence,
          captured_at: this.clock.now().toISOString(),
        };
        this.database.prepareRuntimeOperation(
          row.request_id, row.fence, "legacy_confirmation", "policy-2026-09-03.1-terminal-evidence",
          row.current_sha, null, evidence, this.clock.now(),
        );
        this.database.recordRuntimeOperation(
          row.request_id, row.fence, "legacy_confirmation", "observed", mainAgent.session_id, evidence, this.clock.now(),
        );
      }
      return undefined;
    }
    return { status: "rolled_back", activeSha };
  }

  private notificationReporterReady(dispatcher: HealthSnapshot, slack: HealthSnapshot): boolean {
    return dispatcher.update_notification_protocol === 1 && slack.update_notification_protocol === 1;
  }

  private mainAgentMatchesReceipt(row: UpdateRow, agent: MainAgentObservation): boolean {
    return this.mainAgentMatchesOperation(row, "start_target_main_agent", row.target_sha, agent);
  }

  private mainAgentMatchesOperation(
    row: UpdateRow,
    kind: Extract<RuntimeOperationKind, "start_target_main_agent" | "start_previous_main_agent">,
    sha: string,
    agent: MainAgentObservation,
  ): boolean {
    const operation = this.database.runtimeOperation(row.request_id, kind);
    return operation?.phase === "observed" && operation.expected_sha === sha &&
      agent.pane_id === operation.target_ref && agent.session_id !== null &&
      agent.session_id === operation.observed_session_id && agent.session_id !== operation.previous_session_id &&
      mainAgentMatches(agent);
  }

  private deferOrReview(row: UpdateRow, code: string, message: string): void {
    const current = this.database.get(row.request_id);
    if (!current || current.fence !== row.fence || current.completed_at !== null) return;
    const now = this.clock.now();
    const deadline = current.reconcile_deadline
      ? new Date(current.reconcile_deadline)
      : new Date(now.getTime() + this.policy.timeouts.reconcile_ms);
    if (now.getTime() >= deadline.getTime()) {
      this.needsReview(current, code, `${message}; the bounded observation window expired and no write was retried`);
      return;
    }
    this.database.deferReconcile(
      current.request_id,
      current.fence,
      code,
      message,
      new Date(Math.min(deadline.getTime(), now.getTime() + 1_000)),
      deadline,
      now,
    );
  }

  private async ensureRollbackMainAgentStopped(row: UpdateRow, fallbackPaneId?: string): Promise<string | undefined> {
    const kind = "stop_target_main_agent" as const;
    const targetRelease = path.join(this.policy.release_root, row.target_sha);
    const existing = this.database.runtimeOperation(row.request_id, kind);
    if (existing && (existing.expected_sha !== row.target_sha ||
      (fallbackPaneId !== undefined && existing.target_ref !== fallbackPaneId))) {
      this.needsReview(row, "rollback_main_agent_stop_intent_mismatch");
      return undefined;
    }
    if (existing?.phase === "rejected") {
      this.needsReview(row, "rollback_main_agent_stop_rejected");
      return undefined;
    }
    if (existing) {
      const observed = await this.runtime.mainAgentStatus(targetRelease);
      this.assertLease(row);
      if (!observed.exists) {
        this.database.recordRuntimeOperation(row.request_id, row.fence, kind, "observed", null, { observation: observed }, this.clock.now());
        return existing.target_ref;
      }
      if (observed.pane_id !== existing.target_ref || observed.session_id !== existing.previous_session_id ||
        !observed.matches_release || observed.name !== this.policy.main_agent.name || observed.kind !== "codex") {
        this.needsReview(row, "rollback_main_agent_identity_changed");
        return undefined;
      }
      this.deferOrReview(row, "rollback_main_agent_stop_acceptance_unknown", "Persisted target main-agent stop has not been observed");
      return undefined;
    }

    const drainedMainAgent = await this.runtime.waitForMainAgentIdle();
    this.assertLease(row);
    if (!drainedMainAgent.exists) {
      if (!fallbackPaneId) {
        this.needsReview(row, "rollback_main_agent_pane_not_recorded");
        return undefined;
      }
      this.database.prepareRuntimeOperation(
        row.request_id, row.fence, kind, fallbackPaneId, row.target_sha, null,
        { observation: drainedMainAgent }, this.clock.now(),
      );
      this.database.recordRuntimeOperation(row.request_id, row.fence, kind, "observed", null, { observation: drainedMainAgent }, this.clock.now());
      return fallbackPaneId;
    }
    const mainAgent = await this.runtime.mainAgentStatus(targetRelease);
    this.assertLease(row);
    const sameDrainedIdentity = mainAgent.pane_id === drainedMainAgent.pane_id &&
      mainAgent.session_id === drainedMainAgent.session_id;
    if (!sameDrainedIdentity || !["idle", "done"].includes(mainAgent.status ?? "") || !mainAgent.matches_release ||
      mainAgent.name !== this.policy.main_agent.name || mainAgent.kind !== "codex" ||
      !mainAgent.pane_id || !mainAgent.session_id || (fallbackPaneId && mainAgent.pane_id !== fallbackPaneId)) {
      this.needsReview(
        row,
        mainAgent.status === "blocked" ? "rollback_main_agent_blocked" : "rollback_main_agent_identity_changed",
      );
      return undefined;
    }
    this.database.prepareRuntimeOperation(
      row.request_id, row.fence, kind, mainAgent.pane_id, row.target_sha, mainAgent.session_id,
      { observation: mainAgent }, this.clock.now(),
    );
    const stopped = await this.runtime.stopMainAgent(mainAgent);
    this.assertLease(row);
    if (stopped.outcome === "rejected") {
      this.database.recordRuntimeOperation(row.request_id, row.fence, kind, "rejected", null, {
        error_code: stopped.error_code,
      }, this.clock.now());
      this.needsReview(row, stopped.error_code ?? "rollback_main_agent_stop_rejected");
      return undefined;
    }
    if (stopped.outcome !== "stopped" || !stopped.pane_id) {
      this.database.recordRuntimeOperation(row.request_id, row.fence, kind, "acceptance_unknown", null, {
        error_code: stopped.error_code,
      }, this.clock.now());
      this.deferOrReview(row, "rollback_main_agent_stop_acceptance_unknown", "Target main-agent stop acceptance is unknown");
      return undefined;
    }
    this.database.recordRuntimeOperation(row.request_id, row.fence, kind, "observed", null, {}, this.clock.now());
    return stopped.pane_id;
  }

  private async ensurePreviousMainAgentStarted(
    row: UpdateRow,
    paneId: string,
    previousSessionId?: string,
  ): Promise<boolean> {
    const kind = "start_previous_main_agent" as const;
    const release = path.join(this.policy.release_root, row.current_sha);
    const existing = this.database.runtimeOperation(row.request_id, kind);
    if (existing && (existing.target_ref !== paneId || existing.expected_sha !== row.current_sha ||
      existing.previous_session_id !== (previousSessionId ?? null))) {
      this.needsReview(row, "rollback_main_agent_start_intent_mismatch");
      return false;
    }
    if (existing?.phase === "rejected") {
      this.needsReview(row, "rollback_main_agent_start_rejected");
      return false;
    }
    const observed = await this.runtime.mainAgentStatus(release);
    this.assertLease(row);
    if (this.mainAgentMatchesOperation(row, kind, row.current_sha, observed)) return true;
    if (existing && mainAgentMatches(observed) && observed.pane_id === paneId &&
      observed.session_id !== previousSessionId) {
      this.database.recordRuntimeOperation(
        row.request_id, row.fence, kind, "observed", observed.session_id, { observation: observed }, this.clock.now(),
      );
      return true;
    }
    if (!existing && mainAgentMatches(observed) && observed.pane_id === paneId &&
      observed.session_id !== previousSessionId) {
      this.database.prepareRuntimeOperation(
        row.request_id, row.fence, kind, paneId, row.current_sha, previousSessionId ?? null,
        { observation: observed }, this.clock.now(),
      );
      this.database.recordRuntimeOperation(
        row.request_id, row.fence, kind, "observed", observed.session_id, { observation: observed }, this.clock.now(),
      );
      return true;
    }
    if (existing) {
      if (observed.exists && (!observed.matches_release || observed.pane_id !== paneId)) {
        this.needsReview(row, "rollback_main_agent_start_identity_changed");
      } else {
        this.deferOrReview(row, "rollback_main_agent_start_acceptance_unknown", "Persisted previous main-agent launch has not been observed");
      }
      return false;
    }
    if (observed.exists) {
      this.needsReview(row, "rollback_main_agent_start_identity_changed");
      return false;
    }
    this.database.prepareRuntimeOperation(
      row.request_id, row.fence, kind, paneId, row.current_sha, previousSessionId ?? null, {}, this.clock.now(),
    );
    const result = await this.runtime.startMainAgent(paneId, release, previousSessionId);
    this.assertLease(row);
    if (result.outcome === "rejected") {
      this.database.recordRuntimeOperation(row.request_id, row.fence, kind, "rejected", null, {
        error_code: result.error_code,
        observation: result.observation,
      }, this.clock.now());
      this.needsReview(row, result.error_code ?? "rollback_main_agent_start_rejected");
      return false;
    }
    if (result.outcome === "started" && result.observation.session_id &&
      result.observation.session_id !== previousSessionId && result.observation.matches_release) {
      this.database.recordRuntimeOperation(
        row.request_id, row.fence, kind, "observed", result.observation.session_id,
        { observation: result.observation }, this.clock.now(),
      );
      return true;
    }
    this.database.recordRuntimeOperation(row.request_id, row.fence, kind, "acceptance_unknown", null, {
      error_code: result.error_code,
      observation: result.observation,
    }, this.clock.now());
    this.deferOrReview(row, "rollback_main_agent_start_acceptance_unknown", "Previous main-agent launch acceptance is unknown");
    return false;
  }

  private async ensureServiceStopped(
    row: UpdateRow,
    kind: Extract<RuntimeOperationKind, "stop_slack" | "stop_dispatcher" | "stop_target_slack" | "stop_target_dispatcher">,
    service: HealthSnapshot["service"],
    expectedSha: string | null,
    execute: () => Promise<CommandResult>,
  ): Promise<boolean> {
    const existing = this.database.runtimeOperation(row.request_id, kind);
    if (existing && (existing.target_ref !== service || existing.expected_sha !== expectedSha)) {
      this.needsReview(row, `${kind}_intent_mismatch`, `The persisted ${kind} operation does not match the requested service and SHA`);
      return false;
    }
    if (existing?.phase === "rejected") {
      this.needsReview(row, `${kind}_rejected`, `The persisted ${kind} operation was definitively rejected`);
      return false;
    }
    if (existing) {
      const health = await this.waitForStopped(service);
      this.assertLease(row);
      if (!health.live) {
        this.database.recordRuntimeOperation(row.request_id, row.fence, kind, "observed", null, { health }, this.clock.now());
        return true;
      }
      this.deferOrReview(row, `${kind}_acceptance_unknown`, `The persisted ${kind} intent has not yet been observed`);
      return false;
    }

    const before = service === "dispatcher" ? await this.runtime.dispatcherHealth() : await this.runtime.slackHealth();
    this.assertLease(row);
    if (!before.live) {
      this.database.prepareRuntimeOperation(row.request_id, row.fence, kind, service, expectedSha, null, {}, this.clock.now());
      this.database.recordRuntimeOperation(row.request_id, row.fence, kind, "observed", null, { health: before }, this.clock.now());
      return true;
    }
    if (expectedSha && before.build_sha && before.build_sha !== expectedSha) {
      this.needsReview(row, `${kind}_wrong_sha`, `The service selected for ${kind} does not match the expected SHA`);
      return false;
    }
    this.database.prepareRuntimeOperation(row.request_id, row.fence, kind, service, expectedSha, null, {}, this.clock.now());
    const result = await execute();
    this.assertLease(row);
    if (!resultSucceeded(result)) {
      const phase = result.timed_out || result.output_truncated || result.exit_code === null
        ? "acceptance_unknown"
        : "rejected";
      this.database.recordRuntimeOperation(row.request_id, row.fence, kind, phase, null, {
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        output_truncated: result.output_truncated,
      }, this.clock.now());
      if (phase === "rejected") {
        this.needsReview(row, `${kind}_rejected`, `The ${kind} command was definitively rejected`);
      } else {
        this.deferOrReview(row, `${kind}_acceptance_unknown`, `The ${kind} command acceptance is unknown`);
      }
      return false;
    }
    this.database.recordRuntimeOperation(row.request_id, row.fence, kind, "accepted", null, {
      exit_code: result.exit_code,
    }, this.clock.now());
    const health = await this.waitForStopped(service);
    this.assertLease(row);
    if (!health.live) {
      this.database.recordRuntimeOperation(row.request_id, row.fence, kind, "observed", null, { health }, this.clock.now());
      return true;
    }
    this.deferOrReview(row, `${kind}_observation_timeout`, `The ${kind} command was accepted but service exit was not observed`);
    return false;
  }

  private async ensureTargetMainAgent(
    row: UpdateRow,
    paneId: string,
    targetRelease: string,
  ): Promise<"started" | "deferred" | "rejected"> {
    const stop = this.database.runtimeOperation(row.request_id, "stop_main_agent");
    const previousSessionId = stop?.previous_session_id ?? undefined;
    const existing = this.database.runtimeOperation(row.request_id, "start_target_main_agent");
    if (existing && (existing.target_ref !== paneId || existing.expected_sha !== row.target_sha ||
      existing.previous_session_id !== (previousSessionId ?? null))) {
      this.needsReview(row, "main_agent_start_intent_mismatch");
      return "deferred";
    }
    if (existing?.phase === "rejected") return "rejected";
    if (existing) {
      const observed = await this.runtime.mainAgentStatus(targetRelease);
      this.assertLease(row);
      if (observed.exists && observed.name === this.policy.main_agent.name && observed.kind === "codex" &&
        observed.pane_id === existing.target_ref && observed.session_id !== null &&
        observed.session_id !== existing.previous_session_id && observed.interactive_ready &&
        observed.matches_release && observed.status !== null && observed.status !== "unknown") {
        this.database.recordRuntimeOperation(
          row.request_id, row.fence, "start_target_main_agent", "observed", observed.session_id, { observation: observed }, this.clock.now(),
        );
        return "started";
      }
      this.deferOrReview(row, "main_agent_start_observation_timeout", "The persisted target main-agent launch has not been observed");
      return "deferred";
    }

    this.database.prepareRuntimeOperation(
      row.request_id, row.fence, "start_target_main_agent", paneId, row.target_sha,
      previousSessionId ?? null, {}, this.clock.now(),
    );
    const result = await this.runtime.startMainAgent(paneId, targetRelease, previousSessionId);
    this.assertLease(row);
    if (result.outcome === "rejected") {
      this.database.recordRuntimeOperation(row.request_id, row.fence, "start_target_main_agent", "rejected", null, {
        error_code: result.error_code,
        observation: result.observation,
      }, this.clock.now());
      return "rejected";
    }
    if (result.outcome === "started" && result.observation.session_id) {
      this.database.recordRuntimeOperation(
        row.request_id, row.fence, "start_target_main_agent", "observed", result.observation.session_id,
        { observation: result.observation }, this.clock.now(),
      );
      return "started";
    }
    this.database.recordRuntimeOperation(row.request_id, row.fence, "start_target_main_agent", "acceptance_unknown", null, {
      error_code: result.error_code,
      observation: result.observation,
    }, this.clock.now());
    this.deferOrReview(row, "main_agent_start_acceptance_unknown", "The target main-agent launch acceptance is unknown");
    return "deferred";
  }

  private async ensureServiceStarted(
    row: UpdateRow,
    kind: Extract<RuntimeOperationKind,
      "start_target_dispatcher" | "start_target_slack" | "start_previous_dispatcher" | "start_previous_slack">,
    service: HealthSnapshot["service"],
    sha: string,
    execute: () => Promise<CommandResult>,
    compatibility: ReleaseManifest["compatibility"],
  ): Promise<"started" | "deferred" | "wrong_sha"> {
    const existing = this.database.runtimeOperation(row.request_id, kind);
    if (existing && (existing.target_ref !== service || existing.expected_sha !== sha)) {
      this.needsReview(row, `${kind}_intent_mismatch`, `The persisted ${kind} operation does not match the requested service and SHA`);
      return "deferred";
    }
    if (existing?.phase === "rejected") {
      this.needsReview(row, `${kind}_rejected`, `The persisted ${kind} operation was definitively rejected`);
      return "deferred";
    }
    if (existing) {
      const health = await this.waitForHealth(service, sha, compatibility);
      this.assertLease(row);
      if (health.live && health.build_sha && health.build_sha !== sha) return "wrong_sha";
      if (this.healthMatches(health, sha, service === "slack_adapter", compatibility)) {
        this.database.recordRuntimeOperation(row.request_id, row.fence, kind, "observed", null, { health }, this.clock.now());
        return "started";
      }
      this.deferOrReview(row, `${kind}_health_unavailable`, `The persisted ${kind} intent has not reached versioned health`);
      return "deferred";
    }

    const before = service === "dispatcher" ? await this.runtime.dispatcherHealth() : await this.runtime.slackHealth();
    this.assertLease(row);
    if (before.live && before.build_sha && before.build_sha !== sha) return "wrong_sha";
    if (this.healthMatches(before, sha, service === "slack_adapter", compatibility)) {
      this.database.prepareRuntimeOperation(row.request_id, row.fence, kind, service, sha, null, {}, this.clock.now());
      this.database.recordRuntimeOperation(row.request_id, row.fence, kind, "observed", null, { health: before }, this.clock.now());
      return "started";
    }
    this.database.prepareRuntimeOperation(row.request_id, row.fence, kind, service, sha, null, {}, this.clock.now());
    const result = await execute();
    this.assertLease(row);
    if (!resultSucceeded(result)) {
      const phase = result.timed_out || result.output_truncated || result.exit_code === null
        ? "acceptance_unknown"
        : "rejected";
      this.database.recordRuntimeOperation(row.request_id, row.fence, kind, phase, null, {
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        output_truncated: result.output_truncated,
      }, this.clock.now());
      if (phase === "rejected") {
        this.needsReview(row, `${kind}_rejected`, `The ${kind} command was definitively rejected`);
      } else {
        this.deferOrReview(row, `${kind}_acceptance_unknown`, `The ${kind} command acceptance is unknown`);
      }
      return "deferred";
    }
    this.database.recordRuntimeOperation(row.request_id, row.fence, kind, "accepted", null, { exit_code: result.exit_code }, this.clock.now());
    const health = await this.waitForHealth(service, sha, compatibility);
    this.assertLease(row);
    if (health.live && health.build_sha && health.build_sha !== sha) return "wrong_sha";
    if (this.healthMatches(health, sha, service === "slack_adapter", compatibility)) {
      this.database.recordRuntimeOperation(row.request_id, row.fence, kind, "observed", null, { health }, this.clock.now());
      return "started";
    }
    this.deferOrReview(row, `${kind}_health_unavailable`, `The ${kind} command was accepted but versioned health was not observed`);
    return "deferred";
  }

  private healthMatches(
    health: HealthSnapshot,
    sha: string,
    requireWorkspaces: boolean,
    compatibility: ReleaseManifest["compatibility"],
  ): boolean {
    const rangeAbsent = health.app_schema_read_min === undefined && health.app_schema_read_max === undefined &&
      health.app_schema_write === undefined;
    const rangeMatches = health.app_schema_read_min === compatibility.app_schema_read_min &&
      health.app_schema_read_max === compatibility.app_schema_read_max &&
      health.app_schema_write === compatibility.app_schema_write;
    const legacySingleSchemaProjection = compatibility.app_schema_read_min === compatibility.app_schema_read_max &&
      compatibility.app_schema_write === compatibility.app_schema_read_min && rangeAbsent;
    const actualSchemaReadable = health.app_schema !== null &&
      health.app_schema >= compatibility.app_schema_read_min &&
      health.app_schema <= compatibility.app_schema_read_max;
    return health.ready && health.build_sha === sha && health.protocol === compatibility.protocol &&
      actualSchemaReadable && health.config === compatibility.config &&
      (legacySingleSchemaProjection || rangeMatches) &&
      (!requireWorkspaces || health.workspaces_ready === true);
  }

  private async restoreQuiescedServices(row: UpdateRow, causeCode: string): Promise<void> {
    if (!(await this.restartQuiescedService(
      row,
      "restart_current_dispatcher",
      "dispatcher",
      causeCode,
      () => this.runtime.startDispatcher(),
    ))) return;
    if (!(await this.restartQuiescedService(
      row,
      "restart_current_slack",
      "slack_adapter",
      causeCode,
      () => this.runtime.startSlack(),
    ))) return;
    const [pointer, mainAgent] = await Promise.all([
      this.releases.observe(),
      this.runtime.mainAgentStatus(path.join(this.policy.release_root, row.current_sha)),
    ]);
    this.assertLease(row);
    if (pointer.current_sha !== row.current_sha || !mainAgentMatches(mainAgent)) {
      this.needsReview(
        row,
        "quiesce_recovery_runtime_mismatch",
        `Update stopped before pointer mutation (${causeCode}), but the exact current pointer and main-agent runtime were not verified`,
      );
      return;
    }
    this.logger.info("Quiesced current services were restarted after a pre-mutation update stop", {
      request_id: row.request_id,
      current_sha: row.current_sha,
      cause_code: causeCode,
    });
    this.database.terminal(row.request_id, row.fence, "failed", causeCode, {
      last_error_code: causeCode,
      last_error_message: "Update stopped before pointer mutation; the current pointer and runtime were restored and verified",
      observed_active_sha: row.current_sha,
    }, this.clock.now());
  }

  private async restartQuiescedService(
    row: UpdateRow,
    kind: Extract<RuntimeOperationKind, "restart_current_dispatcher" | "restart_current_slack">,
    service: HealthSnapshot["service"],
    causeCode: string,
    execute: () => Promise<CommandResult>,
  ): Promise<boolean> {
    const label = service === "dispatcher" ? "Dispatcher" : "Slack Adapter";
    const codePrefix = service === "dispatcher"
      ? "quiesce_recovery_dispatcher"
      : "quiesce_recovery_slack";
    const existing = this.database.runtimeOperation(row.request_id, kind);
    if (existing && (existing.target_ref !== service || existing.expected_sha !== row.current_sha)) {
      this.needsReview(
        row,
        `${codePrefix}_restart_intent_mismatch`,
        `Update stopped before main-agent mutation (${causeCode}), but the persisted ${label} restart intent does not match`,
      );
      return false;
    }
    if (existing?.phase === "prepared" || existing?.phase === "acceptance_unknown") {
      this.needsReview(
        row,
        `${codePrefix}_restart_unknown`,
        `Update stopped before main-agent mutation (${causeCode}), but ${label} restart acceptance is unknown; no blind retry was attempted`,
      );
      return false;
    }
    if (existing?.phase === "rejected") {
      this.needsReview(
        row,
        `${codePrefix}_restart_rejected`,
        `Update stopped before main-agent mutation (${causeCode}), but ${label} restart was definitively rejected`,
      );
      return false;
    }
    if (!existing) {
      this.database.prepareRuntimeOperation(
        row.request_id,
        row.fence,
        kind,
        service,
        row.current_sha,
        null,
        { cause_code: causeCode },
        this.clock.now(),
      );
      const result = await execute();
      this.assertLease(row);
      if (!resultSucceeded(result)) {
        const phase = result.timed_out || result.output_truncated || result.exit_code === null
          ? "acceptance_unknown"
          : "rejected";
        this.database.recordRuntimeOperation(row.request_id, row.fence, kind, phase, null, {
          cause_code: causeCode,
          exit_code: result.exit_code,
          timed_out: result.timed_out,
          output_truncated: result.output_truncated,
        }, this.clock.now());
        this.needsReview(
          row,
          phase === "rejected" ? `${codePrefix}_restart_rejected` : `${codePrefix}_restart_unknown`,
          phase === "rejected"
            ? `Update stopped before main-agent mutation (${causeCode}), but ${label} restart was definitively rejected`
            : `Update stopped before main-agent mutation (${causeCode}), but ${label} restart acceptance is unknown; no blind retry was attempted`,
        );
        return false;
      }
      this.database.recordRuntimeOperation(row.request_id, row.fence, kind, "accepted", null, {
        cause_code: causeCode,
        exit_code: result.exit_code,
      }, this.clock.now());
    }
    const currentManifest = await this.releases.releaseManifest(row.current_sha);
    this.assertLease(row);
    if (!currentManifest) {
      this.needsReview(
        row,
        `${codePrefix}_release_manifest_missing`,
        `Update stopped before main-agent mutation (${causeCode}), but the current release manifest was not found`,
      );
      return false;
    }
    const health = await this.waitForHealth(service, row.current_sha, currentManifest.compatibility);
    this.assertLease(row);
    if (!this.healthMatches(health, row.current_sha, service === "slack_adapter", currentManifest.compatibility)) {
      this.needsReview(
        row,
        `${codePrefix}_health_failed`,
        `Update stopped before main-agent mutation (${causeCode}), but current ${label} health was not verified`,
      );
      return false;
    }
    this.database.recordRuntimeOperation(
      row.request_id,
      row.fence,
      kind,
      "observed",
      null,
      { cause_code: causeCode, health },
      this.clock.now(),
    );
    return true;
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
    const currentVerified = !mutated && await this.currentRuntimeVerified(row);
    const terminalState = mutated || !currentVerified ? "needs_review" : "failed";
    const errorCode = mutated
      ? "runtime_operation_failed"
      : currentVerified
        ? "pre_activation_failed"
        : "pre_activation_runtime_unverified";
    this.database.terminal(requestId, fence, terminalState, errorCode, {
      last_error_code: errorCode,
      last_error_message: currentVerified
        ? redactText(message)
        : `${redactText(message)}; the current runtime could not be verified exactly`,
      observed_active_sha: currentVerified ? row.current_sha : null,
    }, this.clock.now());
    this.logger.error("Update attempt failed", {
      request_id: requestId,
      state: row.state,
      fence,
      error_code: errorCode,
      error_message: redactText(message, 500),
    });
  }

  private async currentRuntimeVerified(row: UpdateRow): Promise<boolean> {
    try {
      const release = path.join(this.policy.release_root, row.current_sha);
      const [pointer, dispatcherHealth, slackHealth, mainAgent, currentManifest] = await Promise.all([
        this.releases.observe(),
        this.runtime.dispatcherHealth(),
        this.runtime.slackHealth(),
        this.runtime.mainAgentStatus(release),
        this.releases.releaseManifest(row.current_sha),
      ]);
      return currentManifest !== null && pointer.current_sha === row.current_sha &&
        this.healthMatches(dispatcherHealth, row.current_sha, false, currentManifest.compatibility) &&
        this.healthMatches(slackHealth, row.current_sha, true, currentManifest.compatibility) &&
        mainAgentMatches(mainAgent);
    } catch {
      return false;
    }
  }
}
