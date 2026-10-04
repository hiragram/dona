import type Database from "better-sqlite3";
import type { VerifiedAuditState } from "../audit/codec.js";
import { ApprovalRequestLifecycle } from "./request-lifecycle.js";
import { z } from "zod";
import { assertSynchronousResult } from "../audit/synchronous.js";
import { AuditRepository } from "../audit/repository.js";
import { ApprovalRecordRepository } from "./record-repository.js";
import { ApprovalClockHistory } from "./clock-history.js";
import type { SupervisorBindingGuard } from "./supervisor-binding.js";
import { advanceClockMark, parseClockMark } from "./clock.js";
import type { ApprovalRecordScope } from "./record-codec.js";
import type { ApprovalTransactionProviders } from "./transaction.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const scopeSchema = z.strictObject({ instance_id: id, workspace_id: id });
const pageSchema = z.strictObject({ limit: z.number().int().min(1).max(100), after: id.nullable() });
const requestStates = ["requested", "delivery_pending", "delivery_unknown", "sent", "approved", "needs_review"] as const;

export class ApprovalOperationsError extends Error {
  constructor() { super("approval_operations_unverified"); this.name = "ApprovalOperationsError"; }
}
export interface ApprovalOperationsPage {
  readonly request_handles: readonly string[];
  readonly next_after: string | null;
  readonly has_more: boolean;
}
export interface ApprovalHealth {
  readonly live: true;
  readonly ready: false;
  readonly degraded: readonly string[];
  readonly counts: Readonly<Record<"expiry_lag" | "stale_claim" | "unknown_attempt" | "unknown_delivery" | "needs_review", number> & { retention_overdue: null }> | null;
}

/** Internal, read-only operations view. SQL supplies bounded candidate IDs only;
 * every selected record is checked against the current authenticated audit root.
 * No token, target, snapshot, payload, receipt or actor is returned. */
export class ApprovalOperations {
  private readonly scope: ApprovalRecordScope;
  private readonly audit: AuditRepository;
  private readonly records: ApprovalRecordRepository;
  private readonly history: ApprovalClockHistory;
  private readonly lifecycle: ApprovalRequestLifecycle;
  constructor(private readonly db: Database.Database, private readonly providers: ApprovalTransactionProviders, scope: ApprovalRecordScope,
    private readonly bindingGuard?: SupervisorBindingGuard) {
    try {
      assertSynchronousResult(scope);
      this.scope = Object.freeze(scopeSchema.parse(scope));
      this.audit = new AuditRepository(db, providers.auditAnchors, providers.auditKeys);
      this.records = new ApprovalRecordRepository(db, providers.auditAnchors, providers.auditKeys, this.scope);
      this.history = new ApprovalClockHistory(db, this.scope);
      this.lifecycle = new ApprovalRequestLifecycle(db, providers, this.scope);
    } catch { throw new ApprovalOperationsError(); }
  }
  /** A request list is a hint for an authenticated internal expiry worker. The
   * worker must call the existing single-request broker, which rechecks TTL and
   * commits its decision, payload deletion and audit together. */
  expiryPage(input: { limit: number; after: string | null }): ApprovalOperationsPage {
    try {
      assertSynchronousResult(input); const page = pageSchema.parse(input);
      return this.audit.readVerifiedState(state => {
        const mark = this.observation(state), effective = mark.effective_utc;
        // Scan every request in the bounded page before filtering. Filtering on
        // unauthenticated SQL state/expiry could silently hide a due request.
        const total = this.db.prepare("SELECT count(*) FROM main.approval_requests WHERE instance_id=? AND workspace_id=?")
          .pluck().get(this.scope.instance_id, this.scope.workspace_id);
        if (total !== this.records.readListHeadInState(state, { record_kind: "request", membership: "all" }, 1).count) throw Error();
        const rows = this.db.prepare(`SELECT request_id FROM main.approval_requests
          WHERE instance_id=? AND workspace_id=? AND request_id>?
          ORDER BY request_id LIMIT ?`).all(this.scope.instance_id, this.scope.workspace_id, page.after ?? "", page.limit + 1) as { request_id: string }[];
        const selected = rows.slice(0, page.limit);
        const due: string[] = [];
        for (const row of selected) {
          const request = this.records.readInState(state, "request", id.parse(row.request_id));
          if (request === null || request.row.instance_id !== this.scope.instance_id || request.row.workspace_id !== this.scope.workspace_id) throw Error();
          this.lifecycle.verifyClock(request, mark, state);
          if (request.row.state === "approved" ? request.row.consume_expires_at !== null && request.row.consume_expires_at <= effective
            : requestStates.slice(0, 4).includes(request.row.state as never) && request.row.expires_at <= effective) due.push(row.request_id);
        }
        return Object.freeze({ request_handles: Object.freeze(due),
          next_after: selected.length ? selected.at(-1)!.request_id : null, has_more: rows.length > page.limit });
      }) as ApprovalOperationsPage;
    } catch { throw new ApprovalOperationsError(); }
  }
  /** Health is derived from a protected clock observation and root-verified rows.
   * A clock/anchor/DB mismatch returns a degraded result, never safe readiness. */
  metrics(): string {
    const health = this.health();
    const lines = ["dona_approval_live 1", "dona_approval_safe_ready 0",
      "dona_approval_observation_verified " + Number(health.counts !== null)];
    if (health.counts !== null) {
      for (const [name, count] of Object.entries(health.counts)) {
        if (count !== null) lines.push("dona_approval_" + name + " " + count);
      }
    }
    return lines.join("\n") + "\n";
  }
  private observation(state: VerifiedAuditState) {
    const current = parseClockMark(this.providers.clockMarks.read());
    const saved = this.history.readInState(state, current.transaction_id);
    if (saved === null || !(Object.keys(current) as (keyof typeof current)[]).every(key => current[key] === saved[key])) throw Error();
    const observationId = current.transaction_id === "approval_observation_0" ? "approval_observation_1" : "approval_observation_0";
    return advanceClockMark(current, this.providers.clock.observe(), observationId, this.providers.maximumClockDriftMs);
  }
  health(): ApprovalHealth {
    const counts = { expiry_lag: 0, stale_claim: 0, unknown_attempt: 0, unknown_delivery: 0, retention_overdue: null, needs_review: 0 };
    try {
      return this.audit.readVerifiedState(state => {
        const mark = this.observation(state), effective = mark.effective_utc;
        if (this.bindingGuard && !this.bindingGuard.matchesScope(this.scope)) throw Error();
        const requestRows = this.db.prepare("SELECT request_id FROM main.approval_requests WHERE instance_id=? AND workspace_id=? ORDER BY request_id LIMIT 101")
          .all(this.scope.instance_id, this.scope.workspace_id) as { request_id: string }[];
        if (requestRows.length > 100 || this.records.readListHeadInState(state, { record_kind: "request", membership: "all" }, 1).count !== requestRows.length) throw Error();
        for (const row of requestRows) {
          const request = this.records.readInState(state, "request", id.parse(row.request_id));
          if (request === null) throw Error();
          this.lifecycle.verifyClock(request, mark, state);
          if (request.row.state === "needs_review") counts.needs_review++;
          if (requestStates.slice(0, 4).includes(request.row.state as never) && request.row.expires_at <= effective
            || request.row.state === "approved" && request.row.consume_expires_at !== null && request.row.consume_expires_at <= effective)
            counts.expiry_lag++;
        }
        const attempts = this.db.prepare("SELECT e.attempt_id FROM main.approval_execution_attempts e JOIN main.approval_requests r ON r.request_id=e.request_id WHERE r.instance_id=? AND r.workspace_id=? ORDER BY e.attempt_id LIMIT 101")
          .all(this.scope.instance_id, this.scope.workspace_id) as { attempt_id: string }[];
        if (attempts.length > 100 || this.records.readListHeadInState(state, { record_kind: "execution", membership: "all" }, 1).count !== attempts.length) throw Error();
        for (const row of attempts) {
          const attempt = this.records.readInState(state, "execution", id.parse(row.attempt_id));
          if (attempt === null) throw Error();
          if (attempt.row.state === "needs_review") counts.needs_review++;
          if (attempt.row.state === "acceptance_unknown") counts.unknown_attempt++;
          if (attempt.row.state === "claimed" && attempt.row.execution_expires_at <= effective
            || attempt.row.state === "executing" && attempt.row.payload_expires_at <= effective) counts.stale_claim++;
        }
        const notifications = this.db.prepare("SELECT n.notification_attempt_id FROM main.approval_notifications n JOIN main.approval_requests r ON r.request_id=n.request_id WHERE r.instance_id=? AND r.workspace_id=? ORDER BY n.notification_attempt_id LIMIT 101")
          .all(this.scope.instance_id, this.scope.workspace_id) as { notification_attempt_id: string }[];
        if (notifications.length > 100 || this.records.readListHeadInState(state, { record_kind: "notification", membership: "all" }, 1).count !== notifications.length) throw Error();
        for (const row of notifications) {
          const notification = this.records.readInState(state, "notification", id.parse(row.notification_attempt_id));
          if (notification === null) throw Error();
          if (notification.row.state === "acceptance_unknown") counts.unknown_delivery++;
          if (notification.row.state === "needs_review") counts.needs_review++;
        }
        // 内部recordの健全性だけではoperator認可やruntimeの安全性を証明できない。
        const degraded = ["runtime_readiness_unverified", "retention_unverified", ...Object.entries(counts).filter(([, count]) => count !== null && count > 0).map(([name]) => name)];
        return Object.freeze({ live: true as const, ready: false as const, degraded: Object.freeze(degraded), counts: Object.freeze(counts) });
      }) as ApprovalHealth;
    } catch {
      return { live: true, ready: false, degraded: ["integrity_or_clock_unverified"], counts: null };
    }
  }
}
