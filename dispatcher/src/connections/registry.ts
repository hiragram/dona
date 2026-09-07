import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { stableStringify } from "../validation.js";
import { scopedExternalEventId } from "../ingress.js";
import type { ExternalEventSource, EventEnvelope, EnqueueResult } from "../types.js";
import { ConnectionError, deliverySchema, identifier, parseConfig, systemClock,
  type Clock, type Connection, type DeliveryBinding, type Operation, type ProviderObservation,
  type Subscription } from "./domain.js";

type SubscriptionRow = { connection_id: string; resource: string; generation: number; revision: number;
  provider_id: string | null; state: Subscription["state"]; created_at: number; verified_at: number | null;
  expires_at: number | null; renewal_window_ms: number; verification_epoch: number; last_delivery_at: number | null; last_reconcile_at: number | null; error: string | null };
function subscription(row: SubscriptionRow): Subscription {
  return { connectionId: row.connection_id, resource: row.resource, generation: row.generation, revision: row.revision,
    providerId: row.provider_id, state: row.state, createdAt: row.created_at, verifiedAt: row.verified_at,
    expiresAt: row.expires_at, renewalWindowMs: row.renewal_window_ms, verificationEpoch: row.verification_epoch, lastDeliveryAt: row.last_delivery_at, lastReconcileAt: row.last_reconcile_at, error: row.error };
}
export interface Cursor { revision: number; version: number; checkpoint: string | null; }
export interface CursorBatch {
  binding: DeliveryBinding; expected: Cursor; checkpoint: string; complete: boolean;
  events: readonly { providerEventId: string; envelope: EventEnvelope }[];
  membership?: readonly string[];
}
export class ConnectionRegistry {
  constructor(private readonly db: Database.Database, readonly clock: Clock = systemClock) {}

  private tick(id: string, disabling = false): number {
    let now = this.clock.now();
    const row = this.db.prepare("SELECT last_clock FROM connections WHERE id=?").get(id) as { last_clock: number } | undefined;
    if (!row) throw new ConnectionError("not_found");
    if (disabling && Number.isSafeInteger(now)) now = Math.max(now, row.last_clock);
    if (!Number.isSafeInteger(now) || now < row.last_clock) throw new ConnectionError("clock_skew");
    this.db.prepare("UPDATE connections SET last_clock=? WHERE id=?").run(now, id);
    return now;
  }
  private audit(c: Connection, action: string, at: number): void {
    this.db.prepare("INSERT INTO connection_audit(connection_id,revision,action,at) VALUES(?,?,?,?)")
      .run(c.id, c.revision, action, at);
  }
  get(id: string): Connection {
    const row = this.db.prepare("SELECT config_json,revision,state FROM connections WHERE id=?").get(id) as
      { config_json: string; revision: number; state: Connection["state"] } | undefined;
    if (!row) throw new ConnectionError("not_found");
    return { ...parseConfig(JSON.parse(row.config_json)), revision: row.revision, state: row.state };
  }
  manages(source: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM connections WHERE provider=? LIMIT 1").get(source);
  }
  private completeUndispatched(id: string, revision: number, now: number, summary: string, disposition: string): number {
    const completedAt = new Date(now).toISOString();
    const rows = this.db.prepare(`SELECT events.event_id FROM events JOIN connection_event_bindings binding USING(event_id)
      WHERE binding.connection_id=? AND binding.revision=? AND events.status IN ('queued','retryable_failed')`)
      .all(id, revision) as {event_id:string}[];
    for (const {event_id} of rows) {
      const result = { schema_version: 1, event_id, status: "completed", summary, actions: [], memory_candidates: [], completed_at: completedAt };
      this.db.prepare(`UPDATE events SET status='completed',result_json=?,completed_at=?,last_error_code=?,
        last_error_message=NULL,updated_at=? WHERE event_id=?`).run(stableStringify(result), completedAt, disposition, completedAt, event_id);
    }
    return rows.length;
  }
  register(input: unknown): Connection {
    const config = parseConfig(input);
    return this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM connections WHERE id=?").get(config.id)) throw new ConnectionError("revision_conflict");
      if (this.db.prepare(`SELECT 1 FROM events WHERE source=? AND status IN ('queued','retryable_failed','dispatching','waiting_agent','blocked','needs_review','dead_letter')
        AND NOT EXISTS (SELECT 1 FROM connection_event_bindings binding WHERE binding.event_id=events.event_id) LIMIT 1`).get(config.provider)) throw new ConnectionError("operation_pending");
      const now = this.clock.now();
      if (!Number.isSafeInteger(now) || now < 0) throw new ConnectionError("clock_skew");
      this.db.prepare("INSERT INTO connections VALUES(?,?,?,1,'verification_pending',?)")
        .run(config.id, config.provider, stableStringify(config), now);
      if (config.capability.cursor) for (const entry of config.allowlist) {
        this.db.prepare("INSERT INTO connection_cursors VALUES(?,?,1,0,NULL)").run(config.id, entry.resource);
      }
      const result = this.get(config.id); this.audit(result, "registered", now); return result;
    }).immediate();
  }
  revise(id: string, revision: number, input: unknown): Connection {
    const config = parseConfig(input);
    return this.db.transaction(() => {
      const current = this.get(id);
      if (current.revision !== revision) throw new ConnectionError("revision_conflict");
      if (this.operations(id).some((operation) => operation.state !== "done") || this.subscriptions(id).some((s) => s.state === "stop_candidate")) throw new ConnectionError("operation_pending");
      if (this.db.prepare(`SELECT 1 FROM events JOIN connection_event_bindings USING(event_id)
        WHERE connection_id=? AND revision=? AND status IN ('dispatching','waiting_agent','blocked','needs_review','dead_letter') LIMIT 1`).get(id, revision)) throw new ConnectionError("operation_pending");
      if (config.id !== id || config.provider !== current.provider || config.account !== current.account) throw new ConnectionError("invalid_input");
      if (config.credentialRevision < current.credentialRevision) throw new ConnectionError("revision_conflict");
      const now = this.tick(id);
      const superseded = this.completeUndispatched(id, revision, now, "Connection revision superseded before dispatch", "connection_revision_superseded");
      this.db.prepare("UPDATE connections SET config_json=?,revision=revision+1,state=CASE WHEN state='disabled' THEN 'disabled' ELSE 'degraded' END WHERE id=?")
        .run(stableStringify(config), id);
      if (config.capability.cursor) for (const entry of config.allowlist) {
        this.db.prepare("INSERT OR IGNORE INTO connection_cursors VALUES(?,?,?,0,NULL)").run(id, entry.resource, revision + 1);
      }
      const result = this.get(id);
      if (superseded) this.audit(result, "queued_events_superseded", now);
      this.audit(result, "revised", now); return result;
    }).immediate();
  }
  disable(id: string, revision: number): void {
    this.db.transaction(() => {
      const c = this.get(id);
      if (c.revision !== revision) throw new ConnectionError("revision_conflict");
      if (c.state === "disabled") return;
      const now = this.tick(id, true);
      const superseded = this.completeUndispatched(id, revision, now, "Connection disabled before dispatch", "connection_disabled");
      this.db.prepare("UPDATE connections SET state='disabled' WHERE id=?").run(id);
      if (superseded) this.audit(c, "queued_events_superseded", now);
      this.audit(c, "disabled", now);
    }).immediate();
  }
  degrade(id: string, revision: number): void {
    this.db.transaction(() => {
      const c = this.get(id);
      if (c.revision !== revision || c.state === "disabled") return;
      const now = this.tick(id);
      this.db.prepare("UPDATE connections SET state='degraded' WHERE id=?").run(id);
      this.audit(c, "credential_unavailable", now);
    }).immediate();
  }
  quarantine(id: string, revision: number, resource: string, generation: number, epoch?: number): void {
    this.db.transaction(() => {
      const c = this.get(id);
      if (c.revision !== revision || c.state === "disabled") return;
      if (epoch !== undefined && this.sub(id, resource, generation).verificationEpoch !== epoch) return;
      const now = this.tick(id);
      this.db.prepare(`UPDATE connection_subscriptions SET verified_at=NULL,error='verification_failed',last_reconcile_at=?
        WHERE connection_id=? AND resource=? AND generation=?`).run(now, id, resource, generation);
      this.audit(c, "verification_failed", now);
    }).immediate();
  }
  private current(id: string, revision: number, resource: string, allowDisabled = false): Connection {
    const c = this.get(id);
    if (c.state === "disabled" && !allowDisabled) throw new ConnectionError("disabled");
    if (c.revision !== revision) throw new ConnectionError("revision_conflict");
    if (!c.allowlist.some((entry) => entry.resource === resource)) throw new ConnectionError("not_authorized");
    return c;
  }
  subscriptions(id: string): Subscription[] {
    return (this.db.prepare("SELECT * FROM connection_subscriptions WHERE connection_id=? ORDER BY resource,generation").all(id) as SubscriptionRow[]).map(subscription);
  }
  beginVerification(id: string, revision: number, resource: string, generation: number): Subscription {
    return this.db.transaction(() => {
      this.assertVerifiable(id, revision, resource, generation);
      const now = this.tick(id);
      this.db.prepare(`UPDATE connection_subscriptions SET state='verification_pending',verified_at=NULL,
        verification_epoch=verification_epoch+1,last_reconcile_at=?,error=NULL
        WHERE connection_id=? AND resource=? AND generation=?`).run(now, id, resource, generation);
      return this.sub(id, resource, generation);
    }).immediate();
  }
  assertVerifiable(id: string, revision: number, resource: string, generation: number): Subscription {
    const c = this.current(id, revision, resource);
    const s = this.sub(id, resource, generation);
    if (s.providerId === null || ["stopped","stop_candidate"].includes(s.state)) throw new ConnectionError("invalid_transition");
    if (c.capability.kind === "manual" && s.revision !== revision && this.subscriptions(id).some((candidate) =>
      candidate.resource === resource && candidate.generation !== generation && candidate.revision === revision)) throw new ConnectionError("invalid_transition");
    if (this.operations(id).some((o) => o.resource === resource && o.generation === generation && o.state !== "done")) throw new ConnectionError("operation_pending");
    return s;
  }
  private sub(id: string, resource: string, generation: number): Subscription {
    const result = this.subscriptions(id).find((entry) => entry.resource === resource && entry.generation === generation);
    if (!result) throw new ConnectionError("not_found");
    return result;
  }
  claim(id: string, revision: number, resource: string, leaseMs: number, kind: "create" | "stop" = "create", generation?: number): Operation {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 60_000) throw new ConnectionError("invalid_input");
    return this.db.transaction(() => {
      const c = this.current(id, revision, resource);
      if (c.capability.kind !== "managed") throw new ConnectionError("capability_mismatch");
      const now = this.tick(id);
      // lease expiry grants lookup only; never a second create/stop.
      if (this.db.prepare("SELECT 1 FROM connection_operations WHERE connection_id=? AND resource=? AND state!='done'").get(id, resource)) {
        throw new ConnectionError("operation_pending");
      }
      const previous = this.subscriptions(id).filter((entry) => entry.resource === resource).at(-1);
      let next: number;
      if (kind === "create") {
        if (previous) {
          const quarantined = previous.state === "verification_pending" && previous.verifiedAt === null && previous.error === "verification_failed";
          const renewable = ["active","expiring"].includes(previous.state) && previous.expiresAt !== null &&
            now >= previous.expiresAt - previous.renewalWindowMs;
          if ((!quarantined && previous.revision !== revision) || c.capability.renewal !== "replace" || (!quarantined && !renewable)) {
            throw new ConnectionError("invalid_transition");
          }
        }
        next = (previous?.generation ?? 0) + 1;
        this.db.prepare(`INSERT INTO connection_subscriptions(connection_id,resource,generation,revision,state,created_at,renewal_window_ms)
          VALUES(?,?,?,?,'verification_pending',?,?)`).run(id, resource, next, revision, now, c.capability.renewal === "replace" ? c.capability.windowMs : 0);
      } else {
        if (!generation) throw new ConnectionError("invalid_input");
        const target = this.sub(id, resource, generation);
        if (target.revision !== revision || target.state !== "stop_candidate") throw new ConnectionError("invalid_transition");
        const replacement = this.subscriptions(id).filter((s) => s.resource === resource && s.generation > generation &&
          s.revision === revision && s.verifiedAt !== null && ["active","expiring"].includes(s.state) &&
          (s.expiresAt === null || s.expiresAt > now)).at(-1);
        if (!replacement) throw new ConnectionError("invalid_transition");
        this.db.prepare(`UPDATE connection_event_bindings SET generation=?
          WHERE connection_id=? AND resource=? AND generation=? AND revision=?
          AND event_id IN (SELECT event_id FROM events WHERE status!='completed')`)
          .run(replacement.generation, id, resource, generation, revision);
        next = generation;
      }
      const operation: Operation = { id: randomUUID(), connectionId: id, revision, resource, generation: next, kind, leaseUntil: now + leaseMs, providerId: kind === "stop" ? this.sub(id, resource, next).providerId : null };
      this.db.prepare("INSERT INTO connection_operations VALUES(?,?,?,?,?,?,'inflight',?)")
        .run(operation.id, id, resource, next, revision, kind, operation.leaseUntil);
      this.audit(c, `${kind}_claimed`, now); return operation;
    }).immediate();
  }
  operations(id: string): (Operation & { state: "inflight" | "unknown" | "done" })[] {
    return this.db.prepare(`SELECT id,connection_id AS connectionId,resource,generation,revision,kind,
      lease_until AS leaseUntil,state,(SELECT provider_id FROM connection_subscriptions s WHERE
      s.connection_id=connection_operations.connection_id AND s.resource=connection_operations.resource AND s.generation=connection_operations.generation) AS providerId
      FROM connection_operations WHERE connection_id=? ORDER BY rowid`).all(id) as
      (Operation & { state: "inflight" | "unknown" | "done" })[];
  }
  unknown(operation: Operation): void {
    this.db.transaction(() => {
      const c = this.get(operation.connectionId); const now = this.tick(c.id);
      const changed = this.db.prepare("UPDATE connection_operations SET state='unknown' WHERE id=? AND state='inflight'").run(operation.id).changes;
      if (!changed) return;
      this.db.prepare(`UPDATE connection_subscriptions SET state='renewal_unknown',error='response_unknown'
        WHERE connection_id=? AND resource=? AND generation=?`).run(c.id, operation.resource, operation.generation);
      this.audit(c, "response_unknown", now);
    }).immediate();
  }
  private validateObservation(observed: ProviderObservation, now: number, allowExpired = false): void {
    if (!identifier.safeParse(observed.providerId).success || typeof observed.verified !== "boolean" || typeof observed.cutoverConfirmed !== "boolean" ||
      (observed.expiresAt !== null && (!Number.isSafeInteger(observed.expiresAt) || observed.expiresAt < 0 || (!allowExpired && observed.expiresAt <= now)))) throw new ConnectionError("invalid_input");
  }
  observe(id: string, revision: number, resource: string, generation: number, observed: ProviderObservation, operation?: Operation, verificationEpoch?: number): void {
    this.recordObservation(id, revision, resource, generation, observed, false, operation, verificationEpoch);
  }
  reconcileObservation(operation: Operation, observed: ProviderObservation): void {
    this.recordObservation(operation.connectionId, operation.revision, operation.resource, operation.generation, observed, true, operation);
  }
  private recordObservation(id: string, revision: number, resource: string, generation: number, observed: ProviderObservation,
    allowDisabled: boolean, operation?: Operation, verificationEpoch?: number): void {
    this.db.transaction(() => {
      const c = this.current(id, revision, resource, allowDisabled); const now = this.tick(id);
      this.validateObservation(observed, now, allowDisabled);
      const expired = observed.expiresAt !== null && observed.expiresAt <= now;
      const s = this.sub(id, resource, generation);
      if (verificationEpoch !== undefined && s.verificationEpoch !== verificationEpoch) throw new ConnectionError("revision_conflict");
      if ((s.revision !== revision && operation !== undefined) || s.state === "stopped" || s.state === "stop_candidate" ||
          (s.providerId !== null && s.providerId !== observed.providerId)) throw new ConnectionError("invalid_transition");
      if (c.capability.kind === "managed" && c.capability.renewal === "replace" && observed.expiresAt === null) throw new ConnectionError("invalid_input");
      if (!operation && this.operations(id).some((o) => o.resource === resource && o.generation === generation && o.state !== "done")) throw new ConnectionError("operation_pending");
      if (operation) {
        const saved = this.operations(id).find((entry) => entry.id === operation.id);
        if (!saved || saved.kind !== "create" || saved.generation !== generation || saved.resource !== resource || saved.revision !== revision) throw new ConnectionError("invalid_transition");
        if (saved.state === "done") return;
        this.db.prepare("UPDATE connection_operations SET state='done' WHERE id=?").run(operation.id);
      }
      this.db.prepare(`UPDATE connection_subscriptions SET revision=?,provider_id=?,state=?,verified_at=?,expires_at=?,renewal_window_ms=?,last_reconcile_at=?,error=?
        WHERE connection_id=? AND resource=? AND generation=?`).run(revision, observed.providerId, expired ? "expiring" : observed.verified ? "active" : "verification_pending",
        observed.verified && !expired ? now : null, observed.expiresAt, c.capability.kind === "managed" && c.capability.renewal === "replace" ? c.capability.windowMs : 0,
        now, expired ? "expired" : observed.verified ? null : "verification_failed", id, resource, generation);
      if (observed.verified && !expired) {
        this.db.prepare("UPDATE connections SET state='active' WHERE id=? AND state!='disabled'").run(id);
        if (observed.cutoverConfirmed) this.db.prepare(`UPDATE connection_subscriptions SET revision=?,state='stop_candidate',verification_epoch=verification_epoch+1,
          error=CASE WHEN error='verification_failed' THEN NULL ELSE error END
          WHERE connection_id=? AND resource=? AND generation<? AND
            state IN ('active','expiring','verification_pending')`).run(revision,id,resource,generation);
      }
      this.audit(c, "observed", now);
    }).immediate();
  }
  attachManual(id: string, revision: number, resource: string, providerId: string, expiresAt: number | null): void {
    this.db.transaction(() => {
      const c = this.current(id, revision, resource);
      if (c.capability.kind !== "manual") throw new ConnectionError("capability_mismatch");
      const now = this.tick(id); this.validateObservation({ providerId, expiresAt, verified: false, cutoverConfirmed: false }, now);
      if (this.subscriptions(id).some((s) => s.resource === resource && s.revision === revision)) throw new ConnectionError("invalid_transition");
      const generation = (this.subscriptions(id).filter((s) => s.resource === resource).at(-1)?.generation ?? 0) + 1;
      this.db.prepare(`INSERT INTO connection_subscriptions(connection_id,resource,generation,revision,provider_id,state,created_at,expires_at)
        VALUES(?,?,?,?,?,'verification_pending',?,?)`).run(id, resource, generation, revision, providerId, now, expiresAt);
      this.audit(c, "manual_attached", now);
    }).immediate();
  }
  reconcileStopped(operation: Operation): void {
    this.finishStop(operation, "unknown");
  }
  stopped(operation: Operation): void {
    this.finishStop(operation, "inflight");
  }
  private finishStop(operation: Operation, expected: "unknown" | "inflight"): void {
    this.db.transaction(() => {
      const c = this.current(operation.connectionId, operation.revision, operation.resource, expected === "unknown");
      const now = this.tick(c.id);
      const saved = this.operations(c.id).find((o) => o.id === operation.id);
      if (!saved || saved.kind !== "stop" || saved.state !== expected) throw new ConnectionError("invalid_transition");
      this.db.prepare("UPDATE connection_operations SET state='done' WHERE id=?").run(operation.id);
      this.db.prepare("UPDATE connection_subscriptions SET state='stopped' WHERE connection_id=? AND resource=? AND generation=?")
        .run(c.id, operation.resource, operation.generation);
      this.audit(c, "stopped", now);
    }).immediate();
  }
  delivery(binding: DeliveryBinding, envelope: EventEnvelope, persist: () => EnqueueResult): EnqueueResult {
    return this.db.transaction(() => {
      if (!deliverySchema.safeParse(binding).success) throw new ConnectionError("not_authorized");
      const c = this.current(binding.connectionId, binding.revision, binding.resource);
      if (c.state !== "active" || c.provider !== envelope.source || c.account !== binding.account ||
        c.credentialRevision !== binding.credentialRevision || !c.allowlist.some((a) => a.resource === binding.resource && a.events.includes(envelope.type))) throw new ConnectionError("not_authorized");
      const now = this.tick(c.id);
      const s = this.sub(c.id, binding.resource, binding.generation);
      // stop の外部call待ちに旧channelへ届いた通知も、cutover済みの新generationへbindingする。
      const stopping = this.operations(c.id).some((o) => o.resource === binding.resource && o.generation === binding.generation && o.kind === "stop" && o.state !== "done");
      const replacement = stopping ? this.subscriptions(c.id).filter((candidate) => candidate.resource === binding.resource &&
        candidate.generation > binding.generation && candidate.revision === c.revision && candidate.verifiedAt !== null &&
        ["active","expiring"].includes(candidate.state) && (candidate.expiresAt === null || candidate.expiresAt > now)).at(-1) : undefined;
      const deliverableState=["active","expiring","stop_candidate"].includes(s.state) || (s.state==="renewal_unknown"&&!!replacement);
      if (s.revision !== c.revision || s.verifiedAt === null || !deliverableState ||
        (s.expiresAt !== null && s.expiresAt <= now)) throw new ConnectionError("not_authorized");
      if (stopping && !replacement) throw new ConnectionError("not_authorized");
      const dispatchGeneration = replacement?.generation ?? binding.generation;
      const result = persist();
      if (result.outcome === "duplicate_conflict") return result;
      const prior = this.db.prepare("SELECT connection_id,revision,resource,generation FROM connection_event_bindings WHERE event_id=?").get(result.row.event_id) as {connection_id: string; revision: number; resource: string; generation: number} | undefined;
      if (prior && (prior.connection_id !== c.id || prior.resource !== binding.resource)) throw new ConnectionError("not_authorized");
      if (!prior) this.db.prepare("INSERT INTO connection_event_bindings VALUES(?,?,?,?,?)").run(result.row.event_id, c.id, c.revision, binding.resource, dispatchGeneration);
      else if (prior.revision !== c.revision && result.outcome === "duplicate_same" && result.row.status === "queued")
        this.db.prepare("UPDATE connection_event_bindings SET revision=?,generation=? WHERE event_id=?").run(c.revision,dispatchGeneration,result.row.event_id);
      else if (prior.revision === c.revision && prior.generation < dispatchGeneration) this.db.prepare("UPDATE connection_event_bindings SET generation=? WHERE event_id=?")
        .run(dispatchGeneration, result.row.event_id);
      this.db.prepare("UPDATE connection_subscriptions SET last_delivery_at=? WHERE connection_id=? AND resource=? AND generation=?")
        .run(now, c.id, binding.resource, binding.generation);
      return result;
    }).immediate();
  }
  cursor(id: string, resource: string): Cursor {
    const c = this.get(id);
    return this.db.prepare("SELECT revision,version,checkpoint FROM connection_cursors WHERE connection_id=? AND resource=?").get(id, resource) as Cursor | undefined ??
      { revision: c.revision, version: 0, checkpoint: null };
  }
  membership(id: string, resource: string): string[] {
    return (this.db.prepare("SELECT member FROM connection_resource_memberships WHERE connection_id=? AND resource=? ORDER BY member")
      .all(id,resource) as {member:string}[]).map(({member})=>member);
  }
  pollingSnapshot(binding: DeliveryBinding): { cursor: Cursor; membership: string[] } {
    return this.db.transaction(() => {
      this.assertPolling(binding);
      return { cursor: this.cursor(binding.connectionId,binding.resource),
        membership: this.membership(binding.connectionId,binding.resource) };
    }).immediate();
  }
  assertPolling(binding: DeliveryBinding): void {
    this.db.transaction(() => {
      if (!deliverySchema.safeParse(binding).success) throw new ConnectionError("not_authorized");
      const c = this.current(binding.connectionId, binding.revision, binding.resource);
      const now = this.tick(c.id);
      const current = this.current(binding.connectionId, binding.revision, binding.resource);
      const s = this.sub(current.id, binding.resource, binding.generation);
      if (!current.capability.cursor || current.state !== "active" || current.account !== binding.account || current.credentialRevision !== binding.credentialRevision ||
        s.revision !== current.revision || s.verifiedAt === null || !["active","expiring","stop_candidate"].includes(s.state) ||
        (s.expiresAt !== null && s.expiresAt <= now)) throw new ConnectionError("not_authorized");
    }).immediate();
  }
  rebindCursor(id: string, resource: string, expected: Cursor, revision: number): void {
    this.db.transaction(() => {
      const c = this.current(id, revision, resource);
      if (c.state !== "active" || !c.capability.cursor) throw new ConnectionError("not_authorized");
      const cursor = this.cursor(id, resource);
      if (stableStringify(cursor) !== stableStringify(expected)) throw new ConnectionError("cursor_conflict");
      const now = this.tick(id);
      this.db.prepare(`INSERT INTO connection_cursors VALUES(?,?,?,?,?) ON CONFLICT(connection_id,resource)
        DO UPDATE SET revision=excluded.revision,version=excluded.version,checkpoint=excluded.checkpoint`).run(id, resource, revision, cursor.version + 1, cursor.checkpoint);
      this.audit(c, "cursor_rebound", now);
    }).immediate();
  }
  commitBatch(batch: CursorBatch, enqueue: (envelope: EventEnvelope) => EnqueueResult): EnqueueResult[] {
    if (!batch.complete || typeof batch.checkpoint !== "string" || batch.checkpoint.length > 16_384) throw new ConnectionError("incomplete_batch");
    if (batch.membership !== undefined && (new Set(batch.membership).size !== batch.membership.length ||
      batch.membership.some((member)=>!identifier.safeParse(member).success))) throw new ConnectionError("invalid_input");
    return this.db.transaction(() => {
      const b = batch.binding; const c = this.current(b.connectionId, b.revision, b.resource);
      if (!c.capability.cursor) throw new ConnectionError("capability_mismatch");
      const cursor = this.cursor(c.id, b.resource);
      if (cursor.revision !== c.revision || stableStringify(cursor) !== stableStringify(batch.expected)) throw new ConnectionError("cursor_conflict");
      // 空の最終 page も同じ認証・revision gate を通す。
      const s = this.sub(c.id, b.resource, b.generation);
      const now = this.tick(c.id);
      if (!deliverySchema.safeParse(b).success || c.state !== "active" || b.account !== c.account || b.credentialRevision !== c.credentialRevision ||
        s.revision !== c.revision || s.verifiedAt === null || !["active","expiring","stop_candidate"].includes(s.state) || (s.expiresAt !== null && s.expiresAt <= now)) throw new ConnectionError("not_authorized");
      const results = batch.events.map(({ providerEventId, envelope }) => {
        if (envelope.external_event_id !== scopedExternalEventId(c.provider as ExternalEventSource, c.id, providerEventId)) throw new ConnectionError("not_authorized");
        const result = this.delivery(b, envelope, () => enqueue(envelope));
        if (result.outcome === "duplicate_conflict") throw new ConnectionError("duplicate_conflict");
        return result;
      });
      this.db.prepare(`INSERT INTO connection_cursors VALUES(?,?,?,?,?) ON CONFLICT(connection_id,resource)
        DO UPDATE SET revision=excluded.revision,version=excluded.version,checkpoint=excluded.checkpoint`)
        .run(c.id, b.resource, c.revision, cursor.version + 1, batch.checkpoint);
      if (batch.membership !== undefined) {
        this.db.prepare("DELETE FROM connection_resource_memberships WHERE connection_id=? AND resource=?").run(c.id,b.resource);
        const insert=this.db.prepare("INSERT INTO connection_resource_memberships VALUES(?,?,?)");
        for(const member of batch.membership) insert.run(c.id,b.resource,member);
      }
      this.audit(c, "checkpoint_committed", now); return results;
    }).immediate();
  }
  inspect(id?: string): unknown[] {
    const ids = id ? [{ id }] : this.db.prepare("SELECT id FROM connections ORDER BY id").all() as {id: string}[];
    const now = this.clock.now();
    return ids.map(({id}) => {
      const c = this.get(id); const { credentialRef: _ref, ...visible } = c;
      return { ...visible, credentialRef: "[redacted]", subscriptions: this.subscriptions(id).map((s) => ({ ...s,
        state: s.state === "active" && s.expiresAt !== null && c.capability.kind === "managed" && c.capability.renewal === "replace" &&
          now >= s.expiresAt - s.renewalWindowMs ? "expiring" : s.state })), operations: this.operations(id),
        cursors: this.db.prepare("SELECT resource,revision,version FROM connection_cursors WHERE connection_id=?").all(id) };
    });
  }
  health(): { ready: boolean; degraded: number; pending: number; expiring: number; unknown: number; disabled: number; staleLeases: number } {
    const now = this.clock.now();
    const connections = this.db.prepare("SELECT id,state,last_clock FROM connections").all() as {id: string; state: string; last_clock: number}[];
    const relevant = (id: string) => {
      const c = this.get(id);
      return this.subscriptions(id).filter((s) => s.state !== "stopped" && s.revision === c.revision && c.allowlist.some((entry) => entry.resource === s.resource));
    };
    let expiring = 0;
    for (const {id} of connections) {
      const c = this.get(id);
      if (c.state === "disabled") continue;
      for (const s of relevant(id)) if (["active","expiring"].includes(s.state) && s.expiresAt !== null &&
        now >= s.expiresAt - s.renewalWindowMs) expiring++;
    }
    const count = (state: string) => connections.filter((c) => c.state === state).length;
    const unknown = (this.db.prepare("SELECT count(*) AS n FROM connection_operations WHERE state='unknown'").get() as {n:number}).n;
    const staleLeases = (this.db.prepare("SELECT count(*) AS n FROM connection_operations WHERE state='inflight' AND lease_until<=?").get(now) as {n:number}).n;
    const degraded = connections.filter((c) => c.state === "degraded" || (c.state !== "disabled" &&
      (c.last_clock > now || relevant(c.id).some((s) => s.error === "verification_failed")))).length;
    const pending = connections.filter((row) => {
      if (row.state === "disabled") return false;
      const c = this.get(row.id), subscriptions = relevant(row.id);
      return c.state === "verification_pending" || subscriptions.some((s) => s.state === "verification_pending") ||
        c.allowlist.some((entry) => !subscriptions.some((s) => s.resource === entry.resource && s.revision === c.revision &&
          s.verifiedAt !== null && ["active","expiring"].includes(s.state) && (s.expiresAt === null || s.expiresAt > now)));
    }).length;
    return { ready: degraded + pending + expiring + unknown + staleLeases === 0, degraded, pending, expiring, unknown, disabled: count("disabled"), staleLeases };
  }
}
