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
} from "./types.js";
import { terminalUpdateStates, updateStates } from "./types.js";
import { canonicalJson, sha256 } from "./validation.js";

const stateSql = updateStates.map((state) => `'${state}'`).join(", ");

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
    if (version > 1) throw new Error(`Updater database schema ${version} is newer than supported schema 1`);
    if (version === 1) return;
    this.db.exec(`
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
        completed_at           TEXT
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
        updated_at       TEXT NOT NULL
      );
      CREATE INDEX update_outbox_status_idx ON update_outbox(status, created_at);
      PRAGMA user_version = 1;
    `);
  }

  close(): void {
    this.db.close();
  }

  checkpoint(): void {
    this.db.pragma("wal_checkpoint(FULL)");
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

  nextRunnable(): UpdateRow | undefined {
    return this.db.prepare(`
      SELECT * FROM update_requests
      WHERE state IN ('approved', 'preparing', 'staged', 'quiescing', 'activating', 'restarting', 'verifying', 'rolling_back')
      ORDER BY created_at LIMIT 1
    `).get() as UpdateRow | undefined;
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

  get(requestId: string): UpdateRow | undefined {
    return this.db.prepare("SELECT * FROM update_requests WHERE request_id = ?").get(requestId) as UpdateRow | undefined;
  }

  getByPlan(planId: string): UpdateRow | undefined {
    return this.db.prepare("SELECT * FROM update_requests WHERE plan_id = ?").get(planId) as UpdateRow | undefined;
  }

  list(limit = 100): UpdateRow[] {
    return this.db.prepare("SELECT * FROM update_requests ORDER BY created_at DESC LIMIT ?").all(limit) as UpdateRow[];
  }

  auditRows(requestId: string): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM update_audit WHERE request_id = ? ORDER BY sequence").all(requestId) as Array<Record<string, unknown>>;
  }

  pendingOutbox(limit = 100): OutboxRow[] {
    return this.db.prepare("SELECT * FROM update_outbox WHERE status IN ('pending', 'delivering') ORDER BY created_at LIMIT ?")
      .all(limit) as OutboxRow[];
  }

  outboxFor(requestId: string): OutboxRow | undefined {
    return this.db.prepare("SELECT * FROM update_outbox WHERE request_id = ? ORDER BY created_at DESC, outbox_id DESC LIMIT 1")
      .get(requestId) as OutboxRow | undefined;
  }

  markOutboxDelivering(outboxId: string, at = new Date()): OutboxRow {
    this.db.prepare(`UPDATE update_outbox SET status = 'delivering', attempt_count = attempt_count + 1,
      last_error = NULL, updated_at = ? WHERE outbox_id = ? AND status IN ('pending', 'delivering')`)
      .run(at.toISOString(), outboxId);
    return this.outboxRequired(outboxId);
  }

  markOutboxDelivered(outboxId: string, at = new Date()): void {
    this.db.prepare("UPDATE update_outbox SET status = 'delivered', last_error = NULL, updated_at = ? WHERE outbox_id = ?")
      .run(at.toISOString(), outboxId);
  }

  markOutboxNeedsReview(outboxId: string, error: string, at = new Date()): void {
    this.db.prepare("UPDATE update_outbox SET status = 'needs_review', last_error = ?, updated_at = ? WHERE outbox_id = ?")
      .run(error.slice(0, 2_000), at.toISOString(), outboxId);
  }

  markOutboxPending(outboxId: string, error: string, at = new Date()): void {
    this.db.prepare("UPDATE update_outbox SET status = 'pending', last_error = ?, updated_at = ? WHERE outbox_id = ?")
      .run(error.slice(0, 2_000), at.toISOString(), outboxId);
  }

  metrics(): { states: Record<string, number>; outbox_pending: number } {
    const rows = this.db.prepare("SELECT state, COUNT(*) AS count FROM update_requests GROUP BY state")
      .all() as Array<{ state: string; count: number }>;
    const outbox = this.db.prepare("SELECT COUNT(*) AS count FROM update_outbox WHERE status IN ('pending', 'delivering')")
      .get() as { count: number };
    return { states: Object.fromEntries(rows.map((row) => [row.state, row.count])), outbox_pending: outbox.count };
  }

  private transitionInternal(row: UpdateRow, to: UpdateState, at: Date, fields: Record<string, unknown>, code: string, details: Record<string, unknown>): UpdateRow {
    if (row.state !== to) assertTransition(row.state, to);
    const allowed = new Set([
      "approval_id", "cancellation_requested", "last_error_code", "last_error_message", "completed_at",
      "approval_event_id", "cancellation_event_id", "lease_owner", "lease_expires_at", "activation_generation", "restart_attempts",
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
      completed_at: at.toISOString(),
      lease_owner: null,
      lease_expires_at: null,
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
        active_sha: row.state === "succeeded" ? row.target_sha :
          row.state === "rolled_back" || row.state === "failed" || row.state === "cancelled" ? row.current_sha : null,
        error: row.last_error_code ? { code: row.last_error_code, message: row.last_error_message } : null,
      },
      reply_target: JSON.parse(row.reply_target_json) as Record<string, unknown>,
    };
    this.db.prepare(`
      INSERT OR IGNORE INTO update_outbox (
        outbox_id, request_id, external_event_id, payload_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(`out_${row.request_id.slice(4)}_${row.fence}`, row.request_id, payload.external_event_id, canonicalJson(payload), at.toISOString(), at.toISOString());
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
