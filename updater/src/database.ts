import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { ulid } from "ulid";

import { assertTransition, isTerminal } from "./state-machine.js";
import type {
  ApplyRequest,
  Compatibility,
  OutboxRow,
  PlanRequest,
  UpdatePlan,
  UpdateRow,
  UpdateState,
  RuntimeOperationKind,
  RuntimeOperationPhase,
  RuntimeOperationRow,
} from "./types.js";
import { terminalUpdateStates, updateStates } from "./types.js";
import { canonicalJson, sha256 } from "./validation.js";

const stateSql = updateStates.map((state) => `'${state}'`).join(", ");
const terminalStateSql = terminalUpdateStates.map((state) => `'${state}'`).join(", ");
const reconcilableNeedsReviewCodes = [
  // Policy 2026-09-03.1 compatibility bridge.
  "main_agent_start_failed",
  "dispatcher_start_acceptance_unknown",
  "dispatcher_target_health_unavailable",
  "slack_start_acceptance_unknown",
  "slack_workspace_readiness_unavailable",
  // Policy 2026-09-03.2 bounded observation outcomes.
  "main_agent_stop_acceptance_unknown",
  "main_agent_start_acceptance_unknown",
  "main_agent_start_observation_timeout",
  "activation_evidence_mismatch",
  "ambiguous_runtime_observation",
  "stop_slack_acceptance_unknown",
  "stop_slack_observation_timeout",
  "stop_dispatcher_acceptance_unknown",
  "stop_dispatcher_observation_timeout",
  "start_target_dispatcher_acceptance_unknown",
  "start_target_dispatcher_health_unavailable",
  "start_target_slack_acceptance_unknown",
  "start_target_slack_health_unavailable",
  "rollback_pointer_observation_mismatch",
  "rollback_activation_evidence_mismatch",
  "rollback_stop_evidence_incomplete",
  "rollback_activation_unconfirmed",
  "rollback_previous_health_failed",
  "rollback_main_agent_stop_acceptance_unknown",
  "rollback_main_agent_start_acceptance_unknown",
  "stop_target_slack_acceptance_unknown",
  "stop_target_slack_observation_timeout",
  "stop_target_dispatcher_acceptance_unknown",
  "stop_target_dispatcher_observation_timeout",
  "start_previous_dispatcher_acceptance_unknown",
  "start_previous_dispatcher_health_unavailable",
  "start_previous_slack_acceptance_unknown",
  "start_previous_slack_health_unavailable",
] as const;
const reconcilableNeedsReviewSql = reconcilableNeedsReviewCodes.map(() => "?").join(", ");

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export interface PlanMaterial {
  current_sha: string;
  target_sha: string;
  previous_sha: string | null;
  policy_version: string;
  compatibility: Compatibility;
  rollback_compatible: boolean;
}

export interface MutationFields {
  [key: string]: unknown;
  last_error_code?: string | null;
  last_error_message?: string | null;
  activation_generation?: number;
  restart_attempts?: number;
}

export class UpdateDatabase {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(databasePath), 0o700);
    this.db = new Database(databasePath);
    fs.chmodSync(databasePath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 2000");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 3) throw new Error(`Updater database schema ${version} is newer than supported schema 3`);
    const migrate = (sql: string): void => {
      this.db.transaction(() => { this.db.exec(sql); })();
    };
    if (version === 0) migrate(`
      CREATE TABLE update_requests (
        request_id             TEXT PRIMARY KEY,
        source_event_id        TEXT NOT NULL UNIQUE,
        reply_target_json      TEXT NOT NULL,
        state                  TEXT NOT NULL CHECK (state IN (${stateSql})),
        current_sha            TEXT NOT NULL,
        target_sha             TEXT NOT NULL,
        previous_sha           TEXT,
        plan_id                TEXT NOT NULL UNIQUE,
        plan_hash              TEXT NOT NULL,
        policy_version         TEXT NOT NULL,
        compatibility_json     TEXT NOT NULL,
        rollback_compatible    INTEGER NOT NULL CHECK (rollback_compatible IN (0, 1)),
        approval_id            TEXT,
        approval_event_id      TEXT,
        attempt                INTEGER NOT NULL DEFAULT 0,
        activation_generation  INTEGER NOT NULL DEFAULT 0,
        restart_attempts       INTEGER NOT NULL DEFAULT 0,
        lease_owner            TEXT,
        lease_expires_at       TEXT,
        fence                  INTEGER NOT NULL DEFAULT 0,
        cancellation_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancellation_requested IN (0, 1)),
        cancellation_event_id  TEXT,
        last_error_code        TEXT,
        last_error_message     TEXT,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL,
        completed_at           TEXT,
        reconcile_after        TEXT,
        reconcile_deadline     TEXT,
        last_reconciled_at     TEXT,
        observed_active_sha    TEXT
      );
      CREATE INDEX update_requests_state_idx ON update_requests(state, created_at);

      CREATE TABLE controller_state (
        singleton         INTEGER PRIMARY KEY CHECK (singleton = 1),
        active_request_id TEXT REFERENCES update_requests(request_id),
        updated_at        TEXT NOT NULL
      );
      INSERT INTO controller_state(singleton, active_request_id, updated_at)
        VALUES (1, NULL, '1970-01-01T00:00:00.000Z');

      CREATE TABLE update_audit (
        sequence       INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id     TEXT NOT NULL REFERENCES update_requests(request_id),
        from_state     TEXT,
        to_state       TEXT NOT NULL,
        fence          INTEGER NOT NULL,
        code           TEXT NOT NULL,
        details_json   TEXT NOT NULL,
        occurred_at    TEXT NOT NULL
      );
      CREATE TRIGGER update_audit_no_update BEFORE UPDATE ON update_audit BEGIN
        SELECT RAISE(ABORT, 'update_audit is append-only');
      END;
      CREATE TRIGGER update_audit_no_delete BEFORE DELETE ON update_audit BEGIN
        SELECT RAISE(ABORT, 'update_audit is append-only');
      END;

      CREATE TABLE update_outbox (
        outbox_id        TEXT PRIMARY KEY,
        request_id       TEXT NOT NULL REFERENCES update_requests(request_id),
        external_event_id TEXT NOT NULL UNIQUE,
        payload_json     TEXT NOT NULL,
        status           TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'needs_review')),
        attempt_count    INTEGER NOT NULL DEFAULT 0,
        last_error       TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        dispatcher_event_id TEXT,
        dispatcher_accepted_at TEXT,
        slack_reported_at TEXT,
        next_attempt_at TEXT,
        superseded_by_outbox_id TEXT REFERENCES update_outbox(outbox_id)
      );
      CREATE INDEX update_outbox_status_idx ON update_outbox(status, created_at);
      CREATE TABLE runtime_operations (
        operation_id        TEXT PRIMARY KEY,
        request_id          TEXT NOT NULL REFERENCES update_requests(request_id),
        fence               INTEGER NOT NULL,
        kind                TEXT NOT NULL,
        phase               TEXT NOT NULL CHECK (phase IN ('prepared', 'accepted', 'observed', 'rejected', 'acceptance_unknown')),
        target_ref          TEXT NOT NULL,
        expected_sha        TEXT,
        previous_session_id TEXT,
        observed_session_id TEXT,
        evidence_json       TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        UNIQUE(request_id, kind)
      );
      PRAGMA user_version = 3;
    `);
    if (version === 1) migrate(`
      ALTER TABLE update_requests ADD COLUMN reconcile_after TEXT;
      ALTER TABLE update_requests ADD COLUMN reconcile_deadline TEXT;
      ALTER TABLE update_requests ADD COLUMN last_reconciled_at TEXT;
      ALTER TABLE update_requests ADD COLUMN observed_active_sha TEXT;
      ALTER TABLE update_outbox ADD COLUMN dispatcher_event_id TEXT;
      ALTER TABLE update_outbox ADD COLUMN dispatcher_accepted_at TEXT;
      ALTER TABLE update_outbox ADD COLUMN slack_reported_at TEXT;
      ALTER TABLE update_outbox ADD COLUMN next_attempt_at TEXT;
      ALTER TABLE update_outbox ADD COLUMN superseded_by_outbox_id TEXT REFERENCES update_outbox(outbox_id);
      CREATE TABLE runtime_operations (
        operation_id        TEXT PRIMARY KEY,
        request_id          TEXT NOT NULL REFERENCES update_requests(request_id),
        fence               INTEGER NOT NULL,
        kind                TEXT NOT NULL,
        phase               TEXT NOT NULL CHECK (phase IN ('prepared', 'accepted', 'observed', 'rejected', 'acceptance_unknown')),
        target_ref          TEXT NOT NULL,
        expected_sha        TEXT,
        previous_session_id TEXT,
        observed_session_id TEXT,
        evidence_json       TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        UNIQUE(request_id, kind)
      );
      PRAGMA user_version = 3;
    `);
    if (version === 2) migrate(`
      ALTER TABLE update_outbox ADD COLUMN superseded_by_outbox_id TEXT REFERENCES update_outbox(outbox_id);
      PRAGMA user_version = 3;
    `);
  }

  close(): void {
    this.db.close();
  }

  checkpoint(): void {
    this.db.pragma("wal_checkpoint(FULL)");
  }

  assertReadableWritable(): void {
    this.db.prepare("SELECT 1").get();
    this.db.prepare("UPDATE update_requests SET state = state WHERE 0").run();
  }

  createPlan(request: PlanRequest, material: PlanMaterial, at = new Date()): { row: UpdateRow; plan: UpdatePlan; duplicate: boolean } {
    const replyTargetJson = canonicalJson(request.reply_target);
    const compatibilityJson = canonicalJson(material.compatibility);
    const createdAt = at.toISOString();
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM update_requests WHERE source_event_id = ?")
        .get(request.source_event_id) as UpdateRow | undefined;
      if (existing) {
        const mismatch = existing.reply_target_json !== replyTargetJson ||
          existing.current_sha !== material.current_sha || existing.target_sha !== material.target_sha ||
          existing.policy_version !== material.policy_version || existing.compatibility_json !== compatibilityJson;
        if (mismatch) throw new Error("A plan for this source event already exists with different material");
        return { row: existing, plan: this.planFromRow(existing), duplicate: true };
      }
      const openRequest = this.db.prepare(`
        SELECT request_id FROM update_requests
        WHERE state NOT IN (${terminalStateSql})
        ORDER BY created_at LIMIT 1
      `).get() as { request_id: string } | undefined;
      if (openRequest) throw new Error(`Another self-update plan is still open: ${openRequest.request_id}`);
      if (this.hasUnreportedTerminalNotification()) {
        throw new Error("The previous self-update terminal notification is not settled");
      }

      const requestId = `upd_${ulid(at.getTime()).toLowerCase()}`;
      const planId = `plan_${ulid(at.getTime() + 1).toLowerCase()}`;
      const canonicalPlan = {
        schema_version: 1,
        plan_id: planId,
        policy_version: material.policy_version,
        current_sha: material.current_sha,
        target_sha: material.target_sha,
        previous_sha: material.previous_sha,
        compatibility: material.compatibility,
        rollback_compatible: material.rollback_compatible,
        created_at: createdAt,
      };
      const planHash = sha256(canonicalJson(canonicalPlan));
      this.db.prepare(`
        INSERT INTO update_requests (
          request_id, source_event_id, reply_target_json, state, current_sha, target_sha, previous_sha,
          plan_id, plan_hash, policy_version, compatibility_json, rollback_compatible, created_at, updated_at
        ) VALUES (?, ?, ?, 'awaiting_approval', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        requestId, request.source_event_id, replyTargetJson, material.current_sha, material.target_sha,
        material.previous_sha, planId, planHash, material.policy_version, compatibilityJson,
        material.rollback_compatible ? 1 : 0, createdAt, createdAt,
      );
      const row = this.getRequired(requestId);
      this.audit(row, null, "awaiting_approval", "plan_created", {
        current_sha: material.current_sha,
        target_sha: material.target_sha,
        plan_hash: planHash,
      }, at);
      return { row, plan: this.planFromRow(row), duplicate: false };
    })();
  }

  approve(input: ApplyRequest, at = new Date()): { row: UpdateRow; duplicate: boolean } {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM update_requests WHERE plan_id = ?").get(input.plan_id) as UpdateRow | undefined;
      if (!row) throw new Error(`Plan ${input.plan_id} was not found`);
      if (row.reply_target_json !== canonicalJson(input.reply_target) || row.plan_hash !== input.plan_hash) {
        throw new Error("Apply request does not match the persisted exact plan");
      }
      if (row.approval_id !== null) {
        if (row.approval_id !== input.approval_id || row.approval_event_id !== input.source_event_id) {
          throw new Error("Plan was already approved with a different approval receipt or event");
        }
        return { row, duplicate: true };
      }
      this.transitionInternal(row, "approved", at, {
        approval_id: input.approval_id,
        approval_event_id: input.source_event_id,
      }, "plan_approved", {
        approval_event_id: input.source_event_id,
      });
      return { row: this.getRequired(row.request_id), duplicate: false };
    })();
  }

  requestCancellation(requestId: string, sourceEventId: string, replyTarget: PlanRequest["reply_target"], reason: string, at = new Date()): UpdateRow {
    return this.db.transaction(() => {
      const row = this.getRequired(requestId);
      if (row.reply_target_json !== canonicalJson(replyTarget)) throw new Error("Cancellation event is not in the planned reply target");
      if (isTerminal(row.state)) return row;
      if (["requested", "planning", "awaiting_approval", "approved", "preparing", "staged"].includes(row.state)) {
        return this.completeInternal(row, "cancelled", "cancelled", {
          cancellation_requested: 1,
          cancellation_event_id: sourceEventId,
          last_error_code: "cancelled_by_operator",
          last_error_message: reason,
        }, at);
      }
      return this.completeInternal(row, "needs_review", "cancellation_needs_review", {
        cancellation_requested: 1,
        cancellation_event_id: sourceEventId,
        last_error_code: "cancellation_after_external_mutation",
        last_error_message: "Cancellation was requested after runtime mutation began; reconcile is required",
      }, at);
    })();
  }

  nextRunnable(at = new Date()): UpdateRow | undefined {
    return this.db.prepare(`
      SELECT * FROM update_requests
      WHERE state IN ('approved', 'preparing', 'staged', 'quiescing', 'activating', 'restarting', 'verifying', 'rolling_back')
        AND (reconcile_after IS NULL OR reconcile_after <= ?)
      ORDER BY created_at LIMIT 1
    `).get(at.toISOString()) as UpdateRow | undefined;
  }

  reconcilableNeedsReview(): UpdateRow[] {
    return this.db.prepare(`
      SELECT * FROM update_requests
      WHERE state = 'needs_review' AND last_error_code IN (${reconcilableNeedsReviewSql})
      ORDER BY completed_at
    `).all(...reconcilableNeedsReviewCodes) as UpdateRow[];
  }

  claim(requestId: string, owner: string, leaseMs: number, at = new Date()): UpdateRow | undefined {
    return this.db.transaction(() => {
      const row = this.getRequired(requestId);
      const controller = this.db.prepare("SELECT active_request_id FROM controller_state WHERE singleton = 1")
        .get() as { active_request_id: string | null };
      if (controller.active_request_id && controller.active_request_id !== requestId) {
        const active = this.get(controller.active_request_id);
        const activeLeaseValid = active?.lease_expires_at && active.lease_expires_at > at.toISOString() && !isTerminal(active.state);
        if (activeLeaseValid) return undefined;
      }
      if (row.lease_owner && row.lease_owner !== owner && row.lease_expires_at && row.lease_expires_at > at.toISOString()) {
        return undefined;
      }
      const fence = row.fence + 1;
      const expiresAt = new Date(at.getTime() + leaseMs).toISOString();
      const state: UpdateState = row.state === "approved" ? "preparing" : row.state;
      if (state !== row.state) assertTransition(row.state, state);
      this.db.prepare(`
        UPDATE update_requests SET state = ?, attempt = attempt + ?, lease_owner = ?, lease_expires_at = ?,
          fence = ?, updated_at = ? WHERE request_id = ? AND fence = ?
      `).run(state, row.state === "approved" ? 1 : 0, owner, expiresAt, fence, at.toISOString(), requestId, row.fence);
      this.db.prepare("UPDATE controller_state SET active_request_id = ?, updated_at = ? WHERE singleton = 1")
        .run(requestId, at.toISOString());
      const claimed = this.getRequired(requestId);
      this.audit(claimed, row.state, state, row.state === "approved" ? "attempt_claimed" : "attempt_reclaimed", {
        lease_owner: owner,
      }, at);
      return claimed;
    })();
  }

  beginOperatorRollback(requestId: string, planHash: string, owner: string, leaseMs: number, at = new Date()): UpdateRow {
    return this.db.transaction(() => {
      const row = this.getRequired(requestId);
      if (row.state !== "needs_review" || row.plan_hash !== planHash || row.rollback_compatible !== 1) {
        throw new Error("Operator rollback requires a matching needs_review plan with compatible previous release");
      }
      const controller = this.db.prepare("SELECT active_request_id FROM controller_state WHERE singleton = 1")
        .get() as { active_request_id: string | null };
      if (controller.active_request_id && controller.active_request_id !== requestId) throw new Error("Another update is active");
      const fence = row.fence + 1;
      const expiresAt = new Date(at.getTime() + leaseMs).toISOString();
      const changed = this.db.prepare(`
        UPDATE update_requests SET state = 'rolling_back', completed_at = NULL, lease_owner = ?, lease_expires_at = ?,
          fence = ?, updated_at = ? WHERE request_id = ? AND fence = ? AND state = 'needs_review'
      `).run(owner, expiresAt, fence, at.toISOString(), requestId, row.fence).changes;
      if (changed !== 1) throw new Error("Operator rollback was rejected by CAS");
      this.db.prepare("UPDATE controller_state SET active_request_id = ?, updated_at = ? WHERE singleton = 1")
        .run(requestId, at.toISOString());
      const reopened = this.getRequired(requestId);
      this.audit(reopened, "needs_review", "rolling_back", "operator_rollback_approved", { plan_hash: planHash }, at);
      return reopened;
    })();
  }

  completeEvidenceReconcile(
    requestId: string,
    terminalStatus: "succeeded" | "rolled_back",
    activeSha: string,
    at = new Date(),
  ): UpdateRow {
    return this.db.transaction(() => {
      const row = this.getRequired(requestId);
      if (row.state !== "needs_review") throw new Error("Evidence reconcile requires needs_review state");
      const allowed = this.reconcilableNeedsReview().some((candidate) => candidate.request_id === requestId) ||
        this.runtimeOperation(requestId, "legacy_confirmation")?.phase === "observed";
      if (!allowed) throw new Error("This needs_review reason is not eligible for evidence reconciliation");
      if (!this.terminalOutboxSettledForCorrection(requestId)) {
        throw new Error("Prior terminal notification acceptance is not settled");
      }
      const controller = this.db.prepare("SELECT active_request_id FROM controller_state WHERE singleton = 1")
        .get() as { active_request_id: string | null };
      if (controller.active_request_id && controller.active_request_id !== requestId) throw new Error("Another update is active");
      const fence = row.fence + 1;
      const intermediate: UpdateState = terminalStatus === "succeeded" ? "verifying" : "rolling_back";
      assertTransition(row.state, intermediate);
      const changed = this.db.prepare(`
        UPDATE update_requests SET state = ?, completed_at = NULL, lease_owner = NULL,
          lease_expires_at = NULL, fence = ?, reconcile_after = NULL, reconcile_deadline = NULL,
          last_reconciled_at = ?, updated_at = ?
        WHERE request_id = ? AND fence = ? AND state = 'needs_review'
      `).run(intermediate, fence, at.toISOString(), at.toISOString(), requestId, row.fence).changes;
      if (changed !== 1) throw new Error("Evidence reconcile was rejected by CAS");
      this.db.prepare("UPDATE controller_state SET active_request_id = ?, updated_at = ? WHERE singleton = 1")
        .run(requestId, at.toISOString());
      const reopened = this.getRequired(requestId);
      this.audit(reopened, "needs_review", intermediate, "evidence_reconcile_started", {}, at);
      return this.completeInternal(reopened, terminalStatus, `reconciled_${terminalStatus}_evidence`, {
        observed_active_sha: activeSha,
        last_error_code: null,
        last_error_message: null,
      }, at);
    })();
  }

  renewLease(requestId: string, fence: number, owner: string, leaseMs: number, at = new Date()): void {
    const changed = this.db.prepare(`
      UPDATE update_requests SET lease_expires_at = ?, updated_at = ?
      WHERE request_id = ? AND fence = ? AND lease_owner = ? AND completed_at IS NULL
    `).run(new Date(at.getTime() + leaseMs).toISOString(), at.toISOString(), requestId, fence, owner).changes;
    if (changed !== 1) throw new Error("Lease renewal rejected by fencing token");
  }

  assertLease(requestId: string, fence: number, owner: string, at = new Date()): void {
    const row = this.db.prepare(`
      SELECT fence, lease_owner, lease_expires_at, completed_at FROM update_requests WHERE request_id = ?
    `).get(requestId) as Pick<UpdateRow, "fence" | "lease_owner" | "lease_expires_at" | "completed_at"> | undefined;
    if (!row || row.fence !== fence || row.lease_owner !== owner || row.completed_at !== null ||
      !row.lease_expires_at || row.lease_expires_at <= at.toISOString()) {
      throw new Error("Lease assertion rejected by fencing token");
    }
  }

  transition(requestId: string, fence: number, to: UpdateState, code: string, fields: MutationFields = {}, at = new Date()): UpdateRow {
    return this.db.transaction(() => {
      const row = this.getRequired(requestId);
      if (row.fence !== fence) throw new Error("Mutation rejected by stale fencing token");
      return this.transitionInternal(row, to, at, fields, code, {});
    })();
  }

  terminal(requestId: string, fence: number, to: Extract<UpdateState, "succeeded" | "failed" | "rolled_back" | "needs_review" | "cancelled">, code: string, fields: MutationFields = {}, at = new Date()): UpdateRow {
    return this.db.transaction(() => {
      const row = this.getRequired(requestId);
      if (row.fence !== fence) throw new Error("Terminal mutation rejected by stale fencing token");
      return this.completeInternal(row, to, code, fields, at);
    })();
  }

  recordActivationGeneration(requestId: string, fence: number, generation: number, at = new Date()): void {
    const changed = this.db.prepare(`
      UPDATE update_requests SET activation_generation = ?, updated_at = ? WHERE request_id = ? AND fence = ?
    `).run(generation, at.toISOString(), requestId, fence).changes;
    if (changed !== 1) throw new Error("Activation generation rejected by fencing token");
  }

  incrementRestartAttempts(requestId: string, fence: number, at = new Date()): void {
    const changed = this.db.prepare(`
      UPDATE update_requests SET restart_attempts = restart_attempts + 1, updated_at = ? WHERE request_id = ? AND fence = ?
    `).run(at.toISOString(), requestId, fence).changes;
    if (changed !== 1) throw new Error("Restart attempt rejected by fencing token");
  }

  deferReconcile(
    requestId: string,
    fence: number,
    errorCode: string,
    errorMessage: string,
    after: Date,
    deadline: Date,
    at = new Date(),
  ): void {
    const changed = this.db.prepare(`
      UPDATE update_requests SET reconcile_after = ?, reconcile_deadline = COALESCE(reconcile_deadline, ?),
        last_reconciled_at = ?, last_error_code = ?, last_error_message = ?,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE request_id = ? AND fence = ? AND completed_at IS NULL
    `).run(
      after.toISOString(), deadline.toISOString(), at.toISOString(), errorCode,
      errorMessage.slice(0, 2_000), at.toISOString(), requestId, fence,
    ).changes;
    if (changed !== 1) throw new Error("Reconcile deferral rejected by fencing token");
  }

  clearReconcile(requestId: string, fence: number, at = new Date()): void {
    const changed = this.db.prepare(`
      UPDATE update_requests SET reconcile_after = NULL, reconcile_deadline = NULL,
        last_reconciled_at = ?, updated_at = ? WHERE request_id = ? AND fence = ?
    `).run(at.toISOString(), at.toISOString(), requestId, fence).changes;
    if (changed !== 1) throw new Error("Reconcile clear rejected by fencing token");
  }

  prepareRuntimeOperation(
    requestId: string,
    fence: number,
    kind: RuntimeOperationKind,
    targetRef: string,
    expectedSha: string | null,
    previousSessionId: string | null,
    evidence: Record<string, unknown> = {},
    at = new Date(),
  ): RuntimeOperationRow {
    return this.db.transaction(() => {
      const fenced = this.db.prepare(`
        UPDATE update_requests SET updated_at = updated_at
        WHERE request_id = ? AND fence = ? AND (
          completed_at IS NULL OR (state = 'needs_review' AND ? = 'legacy_confirmation')
        )
      `).run(requestId, fence, kind).changes;
      if (fenced !== 1) throw new Error(`Runtime operation ${kind} was rejected by fencing token`);
      const operationId = `runtime:${requestId}:${kind}`;
      const evidenceJson = canonicalJson(evidence);
      this.db.prepare(`
        INSERT OR IGNORE INTO runtime_operations (
          operation_id, request_id, fence, kind, phase, target_ref, expected_sha,
          previous_session_id, observed_session_id, evidence_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?, NULL, ?, ?, ?)
      `).run(
        operationId, requestId, fence, kind, targetRef, expectedSha, previousSessionId,
        evidenceJson, at.toISOString(), at.toISOString(),
      );
      const row = this.runtimeOperation(requestId, kind);
      if (!row || row.target_ref !== targetRef || row.expected_sha !== expectedSha ||
        row.previous_session_id !== previousSessionId) {
        throw new Error(`Runtime operation ${kind} does not match its persisted intent`);
      }
      return row;
    })();
  }

  recordRuntimeOperation(
    requestId: string,
    fence: number,
    kind: RuntimeOperationKind,
    phase: RuntimeOperationPhase,
    observedSessionId: string | null,
    evidence: Record<string, unknown>,
    at = new Date(),
  ): RuntimeOperationRow {
    const changed = this.db.prepare(`
      UPDATE runtime_operations SET fence = ?, phase = ?, observed_session_id = ?, evidence_json = ?, updated_at = ?
      WHERE request_id = ? AND kind = ? AND EXISTS (
        SELECT 1 FROM update_requests
        WHERE request_id = ? AND fence = ? AND (
          completed_at IS NULL OR (state = 'needs_review' AND ? = 'legacy_confirmation')
        )
      )
    `).run(
      fence, phase, observedSessionId, canonicalJson(evidence), at.toISOString(),
      requestId, kind, requestId, fence, kind,
    ).changes;
    if (changed !== 1) throw new Error(`Runtime operation ${kind} was not prepared or was rejected by fencing token`);
    return this.runtimeOperation(requestId, kind)!;
  }

  runtimeOperation(requestId: string, kind: RuntimeOperationKind): RuntimeOperationRow | undefined {
    return this.db.prepare("SELECT * FROM runtime_operations WHERE request_id = ? AND kind = ?")
      .get(requestId, kind) as RuntimeOperationRow | undefined;
  }

  runtimeOperations(requestId: string): RuntimeOperationRow[] {
    return this.db.prepare("SELECT * FROM runtime_operations WHERE request_id = ? ORDER BY created_at, operation_id")
      .all(requestId) as RuntimeOperationRow[];
  }

  get(requestId: string): UpdateRow | undefined {
    return this.db.prepare("SELECT * FROM update_requests WHERE request_id = ?").get(requestId) as UpdateRow | undefined;
  }

  getByPlan(planId: string): UpdateRow | undefined {
    return this.db.prepare("SELECT * FROM update_requests WHERE plan_id = ?").get(planId) as UpdateRow | undefined;
  }

  list(limit = 100): UpdateRow[] {
    return this.db.prepare("SELECT * FROM update_requests ORDER BY created_at DESC LIMIT ?").all(limit) as UpdateRow[];
  }

  nonTerminalCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM update_requests WHERE state NOT IN (${terminalStateSql})`)
      .get() as { count: number };
    return row.count;
  }

  auditRows(requestId: string): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM update_audit WHERE request_id = ? ORDER BY sequence").all(requestId) as Array<Record<string, unknown>>;
  }

  pendingOutbox(limit = 100, at = new Date()): OutboxRow[] {
    return this.db.prepare(`
      SELECT * FROM update_outbox
      WHERE (status IN ('pending', 'delivering') OR (status = 'delivered' AND slack_reported_at IS NULL))
        AND superseded_by_outbox_id IS NULL
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at LIMIT ?
    `).all(at.toISOString(), limit) as OutboxRow[];
  }

  hasUnreportedTerminalNotification(): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM update_outbox
      WHERE superseded_by_outbox_id IS NULL AND (
        status IN ('pending', 'delivering') OR (status = 'delivered' AND slack_reported_at IS NULL)
      ) LIMIT 1
    `).get();
    return row !== undefined;
  }

  outboxFor(requestId: string): OutboxRow | undefined {
    return this.db.prepare("SELECT * FROM update_outbox WHERE request_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(requestId) as OutboxRow | undefined;
  }

  terminalOutboxSettledForCorrection(requestId: string): boolean {
    const outbox = this.outboxFor(requestId);
    if (!outbox || outbox.superseded_by_outbox_id !== null) return false;
    return (outbox.status === "pending" && outbox.attempt_count === 0) || outbox.status === "needs_review" ||
      (outbox.status === "delivered" && outbox.slack_reported_at !== null);
  }

  markOutboxDelivering(outboxId: string, at = new Date()): OutboxRow {
    this.db.prepare(`UPDATE update_outbox SET status = 'delivering', attempt_count = attempt_count + 1,
      last_error = NULL, next_attempt_at = NULL, updated_at = ? WHERE outbox_id = ? AND status IN ('pending', 'delivering')`)
      .run(at.toISOString(), outboxId);
    return this.outboxRequired(outboxId);
  }

  markOutboxDelivered(outboxId: string, dispatcherEventId: string, at = new Date()): void {
    this.db.prepare(`UPDATE update_outbox SET status = 'delivered', dispatcher_event_id = ?,
      dispatcher_accepted_at = COALESCE(dispatcher_accepted_at, ?), next_attempt_at = ?,
      last_error = NULL, updated_at = ? WHERE outbox_id = ?`)
      .run(dispatcherEventId, at.toISOString(), new Date(at.getTime() + 1_000).toISOString(), at.toISOString(), outboxId);
  }

  markOutboxReported(outboxId: string, at = new Date()): void {
    this.db.prepare(`UPDATE update_outbox SET slack_reported_at = ?, next_attempt_at = NULL,
      last_error = NULL, updated_at = ? WHERE outbox_id = ? AND status = 'delivered'`)
      .run(at.toISOString(), at.toISOString(), outboxId);
  }

  markOutboxNeedsReview(outboxId: string, error: string, at = new Date()): void {
    this.db.prepare("UPDATE update_outbox SET status = 'needs_review', next_attempt_at = NULL, last_error = ?, updated_at = ? WHERE outbox_id = ?")
      .run(error.slice(0, 2_000), at.toISOString(), outboxId);
  }

  markOutboxPending(outboxId: string, error: string, at = new Date(), delayMs = 1_000): void {
    this.db.prepare("UPDATE update_outbox SET status = 'pending', next_attempt_at = ?, last_error = ?, updated_at = ? WHERE outbox_id = ?")
      .run(new Date(at.getTime() + delayMs).toISOString(), error.slice(0, 2_000), at.toISOString(), outboxId);
  }

  deferOutboxLookup(outboxId: string, error: string, at = new Date(), delayMs = 1_000): void {
    this.db.prepare("UPDATE update_outbox SET status = 'delivering', next_attempt_at = ?, last_error = ?, updated_at = ? WHERE outbox_id = ?")
      .run(new Date(at.getTime() + delayMs).toISOString(), error.slice(0, 2_000), at.toISOString(), outboxId);
  }

  deferOutboxReport(outboxId: string, error: string, at = new Date(), delayMs = 1_000): void {
    this.db.prepare("UPDATE update_outbox SET status = 'delivered', next_attempt_at = ?, last_error = ?, updated_at = ? WHERE outbox_id = ?")
      .run(new Date(at.getTime() + delayMs).toISOString(), error.slice(0, 2_000), at.toISOString(), outboxId);
  }

  metrics(): { states: Record<string, number>; outbox_pending: number } {
    const rows = this.db.prepare("SELECT state, COUNT(*) AS count FROM update_requests GROUP BY state")
      .all() as Array<{ state: string; count: number }>;
    const outbox = this.db.prepare(`
      SELECT COUNT(*) AS count FROM update_outbox
      WHERE superseded_by_outbox_id IS NULL AND (
        status IN ('pending', 'delivering') OR (status = 'delivered' AND slack_reported_at IS NULL)
      )
    `)
      .get() as { count: number };
    return { states: Object.fromEntries(rows.map((row) => [row.state, row.count])), outbox_pending: outbox.count };
  }

  private transitionInternal(row: UpdateRow, to: UpdateState, at: Date, fields: Record<string, unknown>, code: string, details: Record<string, unknown>): UpdateRow {
    if (row.state !== to) assertTransition(row.state, to);
    const allowed = new Set([
      "approval_id", "cancellation_requested", "last_error_code", "last_error_message", "completed_at",
      "approval_event_id", "cancellation_event_id", "lease_owner", "lease_expires_at", "activation_generation", "restart_attempts",
      "reconcile_after", "reconcile_deadline", "last_reconciled_at", "observed_active_sha",
    ]);
    for (const key of Object.keys(fields)) if (!allowed.has(key)) throw new Error(`Unsupported update mutation field ${key}`);
    const assignments = ["state = ?", "updated_at = ?", ...Object.keys(fields).map((key) => `${key} = ?`)];
    const values = [to, at.toISOString(), ...Object.values(fields), row.request_id, row.fence];
    const changed = this.db.prepare(`UPDATE update_requests SET ${assignments.join(", ")} WHERE request_id = ? AND fence = ?`)
      .run(...values).changes;
    if (changed !== 1) throw new Error("Update transition rejected by fencing token");
    const updated = this.getRequired(row.request_id);
    this.audit(updated, row.state, to, code, details, at);
    return updated;
  }

  private completeInternal(
    row: UpdateRow,
    to: Extract<UpdateState, "succeeded" | "failed" | "rolled_back" | "needs_review" | "cancelled">,
    code: string,
    fields: MutationFields,
    at: Date,
  ): UpdateRow {
    const completed = this.transitionInternal(row, to, at, {
      ...fields,
      observed_active_sha: fields.observed_active_sha ?? (
        to === "succeeded" ? row.target_sha :
          to === "rolled_back" ? row.current_sha : null
      ),
      completed_at: at.toISOString(),
      lease_owner: null,
      lease_expires_at: null,
      reconcile_after: null,
      reconcile_deadline: null,
    }, code, {});
    this.db.prepare("UPDATE controller_state SET active_request_id = NULL, updated_at = ? WHERE singleton = 1 AND active_request_id = ?")
      .run(at.toISOString(), row.request_id);
    this.insertOutbox(completed, at);
    return completed;
  }

  private insertOutbox(row: UpdateRow, at: Date): void {
    const state = row.state;
    if (!terminalUpdateStates.includes(state as (typeof terminalUpdateStates)[number])) throw new Error("Outbox requires terminal state");
    const payload = {
      schema_version: 1,
      source: "dona_update",
      external_event_id: `update:${row.request_id}:terminal:${row.fence}`,
      type: `update_${state}`,
      occurred_at: at.toISOString(),
      subject: { request_id: row.request_id },
      payload: {
        request_id: row.request_id,
        update_status: state,
        current_sha: row.current_sha,
        target_sha: row.target_sha,
        previous_sha: row.previous_sha,
        plan_hash: row.plan_hash,
        policy_version: row.policy_version,
        rollback_compatible: row.rollback_compatible === 1,
        active_sha: row.observed_active_sha,
        error: row.last_error_code ? { code: row.last_error_code, message: row.last_error_message } : null,
      },
      reply_target: JSON.parse(row.reply_target_json) as Record<string, unknown>,
    };
    const outboxId = `out_${row.request_id.slice(4)}_${row.fence}`;
    this.db.prepare(`
      INSERT OR IGNORE INTO update_outbox (
        outbox_id, request_id, external_event_id, payload_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(outboxId, row.request_id, payload.external_event_id, canonicalJson(payload), at.toISOString(), at.toISOString());
    this.db.prepare(`
      UPDATE update_outbox SET superseded_by_outbox_id = ?, updated_at = ?
      WHERE request_id = ? AND outbox_id <> ? AND status = 'pending' AND superseded_by_outbox_id IS NULL
    `).run(outboxId, at.toISOString(), row.request_id, outboxId);
  }

  private audit(row: UpdateRow, from: UpdateState | null, to: UpdateState, code: string, details: Record<string, unknown>, at: Date): void {
    this.db.prepare(`INSERT INTO update_audit (
      request_id, from_state, to_state, fence, code, details_json, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(row.request_id, from, to, row.fence, code, canonicalJson(details), at.toISOString());
  }

  private planFromRow(row: UpdateRow): UpdatePlan {
    return {
      schema_version: 1,
      plan_id: row.plan_id,
      plan_hash: row.plan_hash,
      policy_version: row.policy_version,
      current_sha: row.current_sha,
      target_sha: row.target_sha,
      previous_sha: row.previous_sha,
      compatibility: JSON.parse(row.compatibility_json) as Compatibility,
      rollback_compatible: row.rollback_compatible === 1,
      created_at: row.created_at,
    };
  }

  private getRequired(requestId: string): UpdateRow {
    const row = this.get(requestId);
    if (!row) throw new Error(`Update request ${requestId} was not found`);
    return row;
  }

  private outboxRequired(outboxId: string): OutboxRow {
    const row = this.db.prepare("SELECT * FROM update_outbox WHERE outbox_id = ?").get(outboxId) as OutboxRow | undefined;
    if (!row) throw new Error(`Outbox ${outboxId} was not found`);
    return row;
  }
}
