import fs from "node:fs";
import { createHash } from "node:crypto";
import { queuePolicySchema, queueIdentity, coalesceKey, QueueAdmissionError, QueueClaimUnavailableError, type QueuePolicy, type QueueAdmissionContext } from "./queue.js";
import path from "node:path";

import Database from "better-sqlite3";
import { ulid } from "ulid";

import type {
  CreateJobRequest,
  CreateJobResult,
  EnqueueResult,
  EventEnvelope,
  EventRow,
  EventStatus,
  JobResultEnvelope,
  JobRow,
  JobStatus,
  ResultEnvelope,
} from "./types.js";
import { eventStatuses, jobStatuses } from "./types.js";
import { jobAgentName } from "./job-agent-name.js";
import { parseJobResultEnvelope, parseResultEnvelope, stableStringify } from "./validation.js";
import { eventOwnerSchema, executionPolicySchema, insertBinding, legacySlackBinding, migrateEventRouting, readBinding } from "./event-routing.js";
import type { EventBinding, ExecutionPolicy, ProviderOwner } from "./event-routing.js";

import { ConnectionRegistry, type CursorBatch } from "./connections/registry.js";
import { migrateConnections, connectionDispatchPredicate, connectionDispatchPredicateFor } from "./connections/schema.js";
import { ConnectionError, type Clock, type DeliveryBinding } from "./connections/domain.js";

const statusSql = eventStatuses.map((status) => `'${status}'`).join(", ");
const jobStatusSql = jobStatuses.map((status) => `'${status}'`).join(", ");
const retryDelaysMs = [5_000, 30_000, 120_000, 600_000] as const;

function nowUtc(): string {
  return new Date().toISOString();
}

function retryAt(attemptCount: number, now: Date): string {
  const delay = retryDelaysMs[Math.min(Math.max(attemptCount - 1, 0), retryDelaysMs.length - 1)]!;
  return new Date(now.getTime() + delay).toISOString();
}

function usesSlackReceivedAtFallback(trace: Record<string, unknown> | undefined): boolean {
  return trace?.occurred_at_source === "received_at";
}

function storedSlackReceivedAtFallback(row: EventRow): boolean {
  if (row.source !== "slack" || row.trace_json === null) return false;
  try {
    const trace = JSON.parse(row.trace_json) as unknown;
    return trace !== null && typeof trace === "object" && !Array.isArray(trace) &&
      (trace as Record<string, unknown>).occurred_at_source === "received_at";
  } catch {
    return false;
  }
}

export class EventNotDispatchableError extends Error {
  constructor(eventId: string) { super(`Event ${eventId} is no longer dispatchable`); this.name = "EventNotDispatchableError"; }
}

export class DispatcherDatabase {
  private readonly db: Database.Database;

  readonly connections: ConnectionRegistry;
  private claimsClosed = false;
  readonly queuePolicy: QueuePolicy;

  constructor(databasePath: string, queuePolicyOrClock: unknown = {}, clock?: Clock) {
    const legacyClock = queuePolicyOrClock !== null && typeof queuePolicyOrClock === "object" &&
      typeof (queuePolicyOrClock as { now?: unknown }).now === "function" ? queuePolicyOrClock as Clock : undefined;
    this.queuePolicy = queuePolicySchema.parse(legacyClock ? {} : queuePolicyOrClock);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(databasePath), 0o700);
    this.db = new Database(databasePath);
    fs.chmodSync(databasePath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 2000");
    this.db.pragma("foreign_keys = ON");
    try {
      this.db.transaction(() => {
        this.migrate();
        if ((this.db.pragma("user_version", { simple: true }) as number) < 4) this.migrateQueue();
        migrateConnections(this.db);
        migrateEventRouting(this.db);
      }).immediate();
    } catch (error) { this.db.close(); throw error; }
    this.connections = new ConnectionRegistry(this.db, clock ?? legacyClock);
  }

  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 4 || version === 3) throw new Error(`Database schema version ${version} is not supported by the event queue schema 4`);
    if (version < 1) this.db.exec(`
      CREATE TABLE events (
        sequence            INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id            TEXT NOT NULL UNIQUE,
        schema_version      INTEGER NOT NULL,
        source              TEXT NOT NULL,
        external_event_id   TEXT NOT NULL,
        event_type          TEXT NOT NULL,
        occurred_at         TEXT NOT NULL,
        subject_json        TEXT NOT NULL,
        payload_json        TEXT NOT NULL,
        reply_target_json   TEXT,
        trace_json          TEXT,
        status              TEXT NOT NULL CHECK (status IN (${statusSql})),
        attempt_count       INTEGER NOT NULL DEFAULT 0,
        available_at        TEXT NOT NULL,
        dispatch_started_at TEXT,
        prompt_accepted_at  TEXT,
        completed_at        TEXT,
        result_json         TEXT,
        result_path         TEXT,
        last_error_code     TEXT,
        last_error_message  TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        UNIQUE (source, external_event_id)
      );
      CREATE INDEX events_dispatch_idx ON events(status, available_at, sequence);
      PRAGMA user_version = 1;
    `);
    if (version < 2) this.db.exec(`
      CREATE TABLE jobs (
        job_id                TEXT PRIMARY KEY,
        source_event_id       TEXT NOT NULL UNIQUE REFERENCES events(event_id),
        source                TEXT NOT NULL,
        workspace_id          TEXT,
        channel_id            TEXT,
        thread_ts             TEXT,
        actor_id              TEXT,
        objective             TEXT NOT NULL,
        workspace_json        TEXT NOT NULL,
        status                TEXT NOT NULL CHECK (status IN (${jobStatusSql})),
        attempt_count         INTEGER NOT NULL DEFAULT 0,
        available_at          TEXT NOT NULL,
        workspace_path        TEXT NOT NULL,
        result_path           TEXT NOT NULL,
        herdr_workspace_id    TEXT,
        herdr_pane_id         TEXT,
        agent_name            TEXT NOT NULL UNIQUE,
        dispatch_started_at   TEXT,
        prompt_accepted_at    TEXT,
        completed_at          TEXT,
        result_json           TEXT,
        completion_event_id   TEXT REFERENCES events(event_id),
        steer_event_id        TEXT,
        steer_state           TEXT CHECK (steer_state IN ('dispatching', 'accepted') OR steer_state IS NULL),
        last_error_code       TEXT,
        last_error_message    TEXT,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );
      CREATE INDEX jobs_run_idx ON jobs(status, available_at, created_at);
      CREATE INDEX jobs_thread_idx ON jobs(workspace_id, channel_id, thread_ts, created_at);
      PRAGMA user_version = 2;
    `);
  }

  private migrateQueue(): void {
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE queue_lanes (
          lane TEXT PRIMARY KEY, source TEXT NOT NULL, connection TEXT NOT NULL,
          class TEXT NOT NULL, tokens REAL NOT NULL, clock_ms INTEGER NOT NULL,
          last_selected INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE queue_events (
          event_id TEXT PRIMARY KEY REFERENCES events(event_id),
          lane TEXT NOT NULL REFERENCES queue_lanes(lane), bytes INTEGER NOT NULL,
          coalesce_key TEXT, fingerprint TEXT NOT NULL, delivery_count INTEGER NOT NULL DEFAULT 1,
          requires_fetch INTEGER NOT NULL DEFAULT 0 CHECK(requires_fetch IN (0,1))
        );
        CREATE INDEX queue_events_lane ON queue_events(lane, event_id);
        CREATE INDEX queue_events_coalesce ON queue_events(lane, coalesce_key);
        CREATE TABLE queue_deliveries (
          source TEXT NOT NULL, external_event_id TEXT NOT NULL,
          event_id TEXT NOT NULL REFERENCES events(event_id), fingerprint TEXT NOT NULL,
          created_at TEXT NOT NULL, PRIMARY KEY(source, external_event_id)
        );
        CREATE TABLE queue_sources (source TEXT PRIMARY KEY, tokens REAL NOT NULL, clock_ms INTEGER NOT NULL);
        CREATE TABLE queue_metrics (code TEXT PRIMARY KEY, count INTEGER NOT NULL);
        CREATE TABLE queue_selector (id INTEGER PRIMARY KEY CHECK(id=1), step INTEGER NOT NULL);
        INSERT INTO queue_selector VALUES (1,0);
      `);
      for (const row of this.db.prepare("SELECT * FROM events ORDER BY sequence").all() as EventRow[]) {
        // 旧provider rowのconnectionは復元不能なのでsource単位のlegacy laneへ隔離する。
        const event: EventEnvelope = { schema_version: 1, source: row.source as EventEnvelope["source"], external_event_id: row.external_event_id, type: row.event_type, occurred_at: row.occurred_at, subject: JSON.parse(row.subject_json), payload: JSON.parse(row.payload_json), reply_target: row.reply_target_json === null ? null : JSON.parse(row.reply_target_json) };
        if (row.trace_json !== null) event.trace = JSON.parse(row.trace_json);
        const identity = queueIdentity(event, { connectionId: "legacy" });
        if (identity.queueClass === "external") {
          identity.lane = `legacy:${createHash("sha256").update(row.source).digest("hex")}`;
          identity.connection = "unverified_legacy";
        }
        this.db.prepare("INSERT OR IGNORE INTO queue_lanes(lane,source,connection,class,tokens,clock_ms) VALUES (?,?,?,?,?,?)")
          .run(identity.lane, row.source, identity.connection, identity.queueClass, this.queuePolicy.defaults.burst, Date.parse(row.created_at));
        this.db.prepare("INSERT INTO queue_events(event_id,lane,bytes,fingerprint) VALUES (?,?,?,?)")
          .run(row.event_id, identity.lane, Buffer.byteLength(stableStringify(event)), this.queueFingerprint(event));
      }
      this.db.pragma("user_version = 4");
    }).immediate();
  }

  private queueFingerprint(event: EventEnvelope): string {
    return createHash("sha256").update(stableStringify({ schema_version: event.schema_version, type: event.type, subject: event.subject, payload: event.payload, reply_target: event.reply_target })).digest("hex");
  }

  private queueMetric(code: string): void {
    this.db.prepare("INSERT INTO queue_metrics VALUES (?,1) ON CONFLICT(code) DO UPDATE SET count=count+1").run(code);
  }

  queueDispatchMetadata(eventId: string) {
    const metadata = this.db.prepare("SELECT requires_fetch, delivery_count FROM queue_events WHERE event_id=?").get(eventId) as {requires_fetch:number;delivery_count:number} | undefined;
    return { schema_version: 1, requires_fetch: metadata?.requires_fetch === 1,
      delivery_count: metadata?.delivery_count ?? 1, deliveries: this.coalescedDeliveries(eventId) };
  }

  coalescedDeliveries(eventId: string) {
    return this.db.prepare("SELECT source,external_event_id,created_at FROM queue_deliveries WHERE event_id=? ORDER BY created_at,external_event_id").all(eventId);
  }

  closeClaims(): void { this.claimsClosed = true; }

  queueHealth(at = new Date()) {
    const counts = this.db.prepare(`SELECT l.class, e.status, count(*) AS depth,
      sum(q.bytes) AS bytes, max(0, ? - min(strftime('%s', e.created_at)*1000)) AS lag_ms
      FROM queue_events q JOIN events e USING(event_id) JOIN queue_lanes l USING(lane)
      WHERE e.status != 'completed' GROUP BY l.class,e.status`).all(at.getTime());
    return { schema_version: 1, claims_closed: this.claimsClosed, counts,
      lanes: this.db.prepare(`SELECT l.lane,l.class,count(*) depth,sum(q.bytes) bytes,
        sum(e.status='blocked' OR e.status='needs_review') blocked,
        sum(e.status='dead_letter') dead_letter,
        sum(e.status='retryable_failed' AND e.available_at>?) deferred
        FROM queue_lanes l JOIN queue_events q USING(lane) JOIN events e USING(event_id)
        WHERE e.status!='completed' GROUP BY l.lane ORDER BY l.lane`).all(at.toISOString()),
      metrics: this.db.prepare("SELECT code,count FROM queue_metrics ORDER BY code").all(),
      in_flight: (this.db.prepare("SELECT count(*) n FROM events WHERE status IN ('dispatching','waiting_agent')").get() as {n:number}).n,
      queued: (this.db.prepare("SELECT count(*) n FROM events WHERE status IN ('queued','retryable_failed')").get() as {n:number}).n,
      blocked: (this.db.prepare("SELECT count(*) n FROM events WHERE status IN ('blocked','needs_review')").get() as {n:number}).n };
  }

  close(): void {
    this.db.close();
  }

  assertReadableWritable(): void {
    this.db.prepare("SELECT 1").get();
    this.db.prepare("UPDATE events SET updated_at = updated_at WHERE 0").run();
  }

  enqueueExternal(envelope: EventEnvelope, binding?: DeliveryBinding, owner?: ProviderOwner, at = new Date(), context?: QueueAdmissionContext): EnqueueResult {
    const queueContext: QueueAdmissionContext | undefined = context ? {
      connectionId: context.connectionId,
      ...(context.coalesce ? { coalesce: context.coalesce } : {}),
    } : binding ? { connectionId: binding.connectionId } : undefined;
    if (!binding) {
      if (this.connections.manages(envelope.source)) throw new ConnectionError("not_authorized");
      return this.enqueueProvider(envelope, owner, at, queueContext);
    }
    try {
      return this.connections.delivery(binding, envelope, () => this.enqueueProvider(envelope, owner, at, queueContext));
    } catch (error) {
      if (error instanceof QueueAdmissionError) this.queueMetric(error.code);
      throw error;
    }
  }

  commitConnectionBatch(batch: CursorBatch): EnqueueResult[] {
    try {
      return this.connections.commitBatch(batch, (envelope) => this.enqueueProvider(envelope, {
        kind: "provider_resource", source: envelope.source, connection_id: batch.binding.connectionId, resource_id: batch.binding.resource,
      }, new Date(), { connectionId: batch.binding.connectionId }));
    } catch (error) {
      if (error instanceof QueueAdmissionError) this.queueMetric(error.code);
      throw error;
    }
  }

  enqueue(envelope: EventEnvelope, at = new Date(), input?: QueueAdmissionContext | EventBinding | (QueueAdmissionContext & { binding: EventBinding })): EnqueueResult {
    const binding = input && "connectionId" in input && "binding" in input ? input.binding :
      input && "owner" in input ? input as EventBinding : undefined;
    const context = input && "connectionId" in input ? input as QueueAdmissionContext :
      binding?.owner.kind === "provider_resource" ? { connectionId: binding.owner.connection_id } : undefined;
    const timestamp = at.toISOString();
    const subjectJson = stableStringify(envelope.subject);
    const payloadJson = stableStringify(envelope.payload);
    const replyTargetJson = envelope.reply_target === null ? null : stableStringify(envelope.reply_target);
    const traceJson = envelope.trace === undefined ? null : stableStringify(envelope.trace);

    const identity = queueIdentity(envelope, context);
    const fingerprint = this.queueFingerprint(envelope);
    const key = identity.queueClass === "external" ? coalesceKey(context) : null;
    const bytes = Buffer.byteLength(stableStringify(envelope));
    const sourcePolicy = Object.hasOwn(this.queuePolicy.sources, envelope.source) ? this.queuePolicy.sources[envelope.source]! : this.queuePolicy.defaults;
    const policy = this.queuePolicy.connections[JSON.stringify([envelope.source, identity.connection])] ?? sourcePolicy;
    try { return this.db.transaction(() => {
      const reject = (code: ConstructorParameters<typeof QueueAdmissionError>[0]): never => { throw new QueueAdmissionError(code); };
      const ownerMatches = (eventId: string): boolean => {
        if (!binding) return identity.queueClass !== "external" || readBinding(this.db, eventId) === undefined;
        const saved = readBinding(this.db, eventId);
        return saved !== undefined && stableStringify(saved.owner) === stableStringify(binding.owner);
      };
      const bindingMatches = (eventId: string): boolean => {
        if (!binding) return identity.queueClass !== "external" || readBinding(this.db, eventId) === undefined;
        const saved = readBinding(this.db, eventId);
        return saved !== undefined && stableStringify(saved) === stableStringify(binding);
      };
      const delivery = this.db.prepare("SELECT * FROM queue_deliveries WHERE source=? AND external_event_id=?").get(envelope.source, envelope.external_event_id) as {event_id:string; fingerprint:string; created_at:string} | undefined;
      if (delivery) {
        const mismatch = delivery.fingerprint !== createHash("sha256").update(fingerprint + envelope.occurred_at).digest("hex") ||
          !ownerMatches(delivery.event_id);
        const outcome = mismatch ? "duplicate_conflict" : "duplicate_same";
        this.queueMetric(outcome);
        return { row: this.get(delivery.event_id)!, committedAt: delivery.created_at, outcome, duplicate: true, payloadMismatch: mismatch } as EnqueueResult;
      }
      const existing = this.db
        .prepare("SELECT * FROM events WHERE source = ? AND external_event_id = ?")
        .get(envelope.source, envelope.external_event_id) as EventRow | undefined;
      if (existing) {
        const ignoreReceivedAtDifference = envelope.source === "slack" &&
          usesSlackReceivedAtFallback(envelope.trace) && storedSlackReceivedAtFallback(existing);
        const mismatch =
          existing.schema_version !== envelope.schema_version ||
          existing.event_type !== envelope.type ||
          (!ignoreReceivedAtDifference && existing.occurred_at !== envelope.occurred_at) ||
          existing.subject_json !== subjectJson ||
          existing.payload_json !== payloadJson ||
          existing.reply_target_json !== replyTargetJson;
        const outcome: EnqueueResult["outcome"] = mismatch ? "duplicate_conflict" : "duplicate_same";
        if (!ownerMatches(existing.event_id)) {
          return { row: existing, outcome: "duplicate_conflict" as const, duplicate: true, payloadMismatch: true };
        }
        this.queueMetric(outcome);
        return {
          row: existing,
          outcome,
          duplicate: true,
          payloadMismatch: mismatch,
        };
      }

      if (this.claimsClosed) reject("queue_quiescing");
      let lane = this.db.prepare("SELECT * FROM queue_lanes WHERE lane=?").get(identity.lane) as {tokens:number; clock_ms:number} | undefined;
      if (!lane) {
        const count = (this.db.prepare("SELECT count(*) n FROM queue_lanes WHERE class=?").get(identity.queueClass) as {n:number}).n;
        // classごとのslotにより外部connection乱立が予約laneの生成を妨げない。
        if (count >= this.queuePolicy.maxLanes) reject("queue_lanes");
        this.db.prepare("INSERT INTO queue_lanes(lane,source,connection,class,tokens,clock_ms) VALUES (?,?,?,?,?,?)")
          .run(identity.lane, envelope.source, identity.connection, identity.queueClass, policy.burst, at.getTime());
        lane = { tokens: policy.burst, clock_ms: at.getTime() };
      }
      const clock = Math.max(lane.clock_ms, at.getTime());
      const tokens = Math.min(policy.burst, lane.tokens + Math.min(60000, clock-lane.clock_ms) * policy.rate / 1000);
      if (tokens < 1) reject("queue_rate");
      const sourceBucket = this.db.prepare("SELECT tokens,clock_ms FROM queue_sources WHERE source=?").get(envelope.source) as {tokens:number;clock_ms:number} | undefined;
      const sourceClock = Math.max(sourceBucket?.clock_ms ?? at.getTime(),at.getTime());
      const sourceTokens = Math.min(sourcePolicy.burst,(sourceBucket?.tokens ?? sourcePolicy.burst)+Math.min(60000,sourceClock-(sourceBucket?.clock_ms ?? sourceClock))*sourcePolicy.rate/1000);
      if (sourceTokens < 1) reject("queue_rate");
      const coalescedCandidate = policy.coalescing && key ? this.db.prepare(`SELECT e.*,q.delivery_count FROM events e JOIN queue_events q USING(event_id)
        WHERE q.lane=? AND q.coalesce_key=? AND q.fingerprint=? AND e.status='queued' AND e.attempt_count=0
        AND e.sequence=(SELECT max(tail.sequence) FROM queue_events tq JOIN events tail USING(event_id) WHERE tq.lane=q.lane)
        ORDER BY e.sequence DESC LIMIT 1`).get(identity.lane,key,fingerprint) as (EventRow & {delivery_count:number}) | undefined : undefined;
      const coalesced = coalescedCandidate && bindingMatches(coalescedCandidate.event_id) ? coalescedCandidate : undefined;
      if (coalesced && coalesced.delivery_count >= this.queuePolicy.maxDeliveries) reject("queue_deliveries");
      const usage = this.db.prepare(`SELECT l.class, count(*) depth, coalesce(sum(q.bytes),0) bytes FROM queue_events q
        JOIN events e USING(event_id) JOIN queue_lanes l USING(lane) WHERE e.status!='completed' GROUP BY l.class`).all() as {class:string;depth:number;bytes:number}[];
      const laneUsage = this.db.prepare(`SELECT count(*) depth,coalesce(sum(q.bytes),0) bytes FROM queue_events q JOIN events e USING(event_id) WHERE q.lane=? AND e.status!='completed'`).get(identity.lane) as {depth:number;bytes:number};
      const sourceUsage = this.db.prepare(`SELECT count(*) depth,coalesce(sum(q.bytes),0) bytes FROM queue_events q JOIN events e USING(event_id) WHERE e.source=? AND e.status!='completed'`).get(envelope.source) as {depth:number;bytes:number};
      const addedDepth = coalesced ? 0 : 1;
      if (sourceUsage.depth+addedDepth > sourcePolicy.depth) reject("queue_depth");
      if (sourceUsage.bytes+bytes > sourcePolicy.bytes) reject("queue_bytes");
      let reservedDepth = 0, reservedBytes = 0;
      for (const c of ["slack","internal","update"] as const) {
        if (c === identity.queueClass) continue;
        const used = usage.find(u => u.class === c);
        reservedDepth += Math.max(0,this.queuePolicy.reservations[c]-(used?.depth??0));
        reservedBytes += Math.max(0,this.queuePolicy.reservedBytes[c]-(used?.bytes??0));
      }
      if (laneUsage.depth+addedDepth > policy.depth || usage.reduce((n,u)=>n+u.depth,0)+addedDepth+reservedDepth > this.queuePolicy.depth) reject("queue_depth");
      if (laneUsage.bytes+bytes > policy.bytes || usage.reduce((n,u)=>n+u.bytes,0)+bytes+reservedBytes > this.queuePolicy.bytes) reject("queue_bytes");
      this.db.prepare("INSERT INTO queue_sources VALUES (?,?,?) ON CONFLICT(source) DO UPDATE SET tokens=excluded.tokens,clock_ms=excluded.clock_ms").run(envelope.source,sourceTokens-1,sourceClock);
      this.db.prepare("UPDATE queue_lanes SET tokens=?,clock_ms=? WHERE lane=?").run(tokens-1,clock,identity.lane);
      if (coalesced) {
        this.db.prepare("INSERT INTO queue_deliveries VALUES (?,?,?,?,?)").run(envelope.source,envelope.external_event_id,coalesced.event_id,createHash("sha256").update(fingerprint+envelope.occurred_at).digest("hex"),timestamp);
        this.db.prepare("UPDATE queue_events SET delivery_count=delivery_count+1,bytes=bytes+? WHERE event_id=?").run(bytes,coalesced.event_id);
        this.queueMetric("coalesced");
        return { row: coalesced, outcome: "created", duplicate: false, payloadMismatch: false, admission: "coalesced", committedAt: timestamp } as EnqueueResult;
      }
      const eventId = `evt_${ulid(at.getTime())}`;
      const result = this.db
        .prepare(`
          INSERT INTO events (
            event_id, schema_version, source, external_event_id, event_type,
            occurred_at, subject_json, payload_json, reply_target_json, trace_json,
            status, available_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
        `)
        .run(
          eventId,
          envelope.schema_version,
          envelope.source,
          envelope.external_event_id,
          envelope.type,
          envelope.occurred_at,
          subjectJson,
          payloadJson,
          replyTargetJson,
          traceJson,
          timestamp,
          timestamp,
          timestamp,
        );
      const row = this.getBySequence(Number(result.lastInsertRowid));
      if (!row) throw new Error("Inserted event could not be read back");
      const resolvedBinding = binding ?? legacySlackBinding(row);
      if (resolvedBinding) insertBinding(this.db, eventId, resolvedBinding);
      this.db.prepare("INSERT INTO queue_events(event_id,lane,bytes,coalesce_key,fingerprint,requires_fetch) VALUES (?,?,?,?,?,?)").run(eventId,identity.lane,bytes,policy.coalescing ? key : null,fingerprint,key === null ? 0 : 1);
      this.queueMetric("created");
      return { row, outcome: "created" as const, duplicate: false, payloadMismatch: false };
    }).immediate();
    } catch (error) {
      if (error instanceof QueueAdmissionError) this.queueMetric(error.code);
      throw error;
    }
  }

  get(eventId: string): EventRow | undefined {
    return this.db.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId) as EventRow | undefined;
  }

  getByExternalId(source: string, externalEventId: string): EventRow | undefined {
    return (this.db.prepare("SELECT * FROM events WHERE source = ? AND external_event_id = ?")
      .get(source, externalEventId) ?? this.db.prepare("SELECT e.* FROM queue_deliveries d JOIN events e USING(event_id) WHERE d.source=? AND d.external_event_id=?").get(source,externalEventId)) as EventRow | undefined;
  }

  isEventCompleted(eventId: string): boolean {
    return this.db.prepare("SELECT 1 FROM events WHERE event_id = ? AND status = 'completed'")
      .get(eventId) !== undefined;
  }

  updateSafetyStatus(): { safe: boolean; unsafe_states: string[] } {
    const unsafe: string[] = [];
    const eventRows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM events
      WHERE status IN ('dispatching', 'waiting_agent') GROUP BY status
    `).all() as Array<{ status: string; count: number }>;
    for (const row of eventRows) unsafe.push(`events.${row.status}:${row.count}`);
    const jobRows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM jobs
      WHERE status IN ('dispatching', 'cancelling') GROUP BY status
    `).all() as Array<{ status: string; count: number }>;
    for (const row of jobRows) unsafe.push(`jobs.${row.status}:${row.count}`);
    const steer = this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE steer_state = 'dispatching'")
      .get() as { count: number };
    if (steer.count > 0) unsafe.push(`jobs.steer_acceptance_unknown:${steer.count}`);
    return { safe: unsafe.length === 0, unsafe_states: unsafe };
  }

  getBySequence(sequence: number): EventRow | undefined {
    return this.db.prepare("SELECT * FROM events WHERE sequence = ?").get(sequence) as EventRow | undefined;
  }

  list(status?: EventStatus, limit = 100): EventRow[] {
    if (status) {
      return this.db
        .prepare("SELECT * FROM events WHERE status = ? ORDER BY sequence LIMIT ?")
        .all(status, limit) as EventRow[];
    }
    return this.db.prepare("SELECT * FROM events ORDER BY sequence LIMIT ?").all(limit) as EventRow[];
  }

  createJob(
    request: CreateJobRequest,
    workspaceRoot: string,
    resultDir: string,
    at = new Date(),
  ): CreateJobResult {
    const sourceEvent = this.getRequired(request.source_event_id);
    const workspaceJson = stableStringify(request.workspace);
    const replyTarget = sourceEvent.reply_target_json
      ? JSON.parse(sourceEvent.reply_target_json) as Record<string, unknown>
      : {};
    const subject = JSON.parse(sourceEvent.subject_json) as Record<string, unknown>;
    const workspaceId = stringValue(replyTarget.workspace_id);
    const channelId = stringValue(replyTarget.channel_id);
    const threadTs = stringValue(replyTarget.thread_ts);
    const binding = this.getEventBinding(sourceEvent.event_id);
    if (!binding) throw new Error(`Event ${sourceEvent.event_id} does not have a Slack thread reply target or authenticated provider owner`);
    if (!binding.execution.background_job) throw new Error("Background job capability denied");
    if (binding.owner.kind === "provider_resource" && request.workspace.kind !== "scratch") {
      throw new Error("Provider job policy permits only scratch workspace");
    }

    return this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM jobs WHERE source_event_id = ?")
        .get(request.source_event_id) as JobRow | undefined;
      if (existing) {
        return {
          row: existing,
          duplicate: true,
          payloadMismatch: existing.objective !== request.objective || existing.workspace_json !== workspaceJson,
        };
      }

      const jobId = jobAgentName(`job_${ulid(at.getTime()).toLowerCase()}`, request.objective);
      const workspacePath = request.workspace.kind === "scratch"
        ? path.join(workspaceRoot, "scratch", jobId)
        : path.join(
          workspaceRoot,
          "github",
          request.workspace.repository.split("/")[0]!,
          request.workspace.repository.split("/")[1]!,
          "worktrees",
          jobId,
        );
      const resultPath = path.join(resultDir, `${jobId}.json`);
      const timestamp = at.toISOString();
      this.db.prepare(`
        INSERT INTO jobs (
          job_id, source_event_id, source, workspace_id, channel_id, thread_ts, actor_id,
          objective, workspace_json, status, available_at, workspace_path, result_path,
          agent_name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)
      `).run(
        jobId,
        request.source_event_id,
        sourceEvent.source,
        workspaceId,
        channelId,
        threadTs,
        stringValue(subject.actor_id),
        request.objective,
        workspaceJson,
        timestamp,
        workspacePath,
        resultPath,
        jobId,
        timestamp,
        timestamp,
      );
      this.db.prepare("INSERT INTO job_bindings SELECT ?, event_id, owner_json, execution_json, destination_json FROM event_bindings WHERE event_id = ?")
        .run(jobId, sourceEvent.event_id);
      return { row: this.getJobRequired(jobId), duplicate: false, payloadMismatch: false };
    }).immediate();
  }

  getJob(jobId: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
  }

  listJobs(status?: JobStatus, limit = 100): JobRow[] {
    if (status) {
      return this.db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY created_at LIMIT ?").all(status, limit) as JobRow[];
    }
    return this.db.prepare("SELECT * FROM jobs ORDER BY created_at LIMIT ?").all(limit) as JobRow[];
  }

  listThreadJobs(workspaceId: string, channelId: string, threadTs: string, limit = 100): JobRow[] {
    return this.db.prepare(`
      SELECT * FROM jobs
      WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(workspaceId, channelId, threadTs, limit) as JobRow[];
  }

  listRunnableJobs(at = new Date(), limit = 100): JobRow[] {
    return this.db.prepare(`
      SELECT * FROM jobs
      WHERE (status IN ('queued', 'retryable_failed') AND available_at <= ?)
         OR status = 'running'
      ORDER BY created_at LIMIT ?
    `).all(at.toISOString(), limit) as JobRow[];
  }

  listJobsNeedingNotification(limit = 100): JobRow[] {
    return this.db.prepare(`
      SELECT * FROM jobs
      WHERE status IN ('blocked', 'completed', 'failed', 'cancelled', 'needs_review')
        AND completion_event_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM job_completions c WHERE c.job_id = jobs.job_id AND c.job_status = jobs.status AND c.notification_state = 'none')
      ORDER BY updated_at LIMIT ?
    `).all(limit) as JobRow[];
  }

  recoverStaleJobs(at = new Date()): { retryable: number; needsReview: number } {
    const timestamp = at.toISOString();
    const retryable = this.db.prepare(`
      UPDATE jobs SET status = 'retryable_failed', available_at = ?,
        last_error_code = 'stale_preparing',
        last_error_message = 'Dispatcher restarted before the job prompt was attempted', updated_at = ?
      WHERE status = 'preparing'
    `).run(timestamp, timestamp).changes;
    const needsReview = this.db.prepare(`
      UPDATE jobs SET status = 'needs_review',
        last_error_code = 'ambiguous_job_control',
        last_error_message = 'Dispatcher restarted while job prompt, steer, or cancellation acceptance was unknown',
        steer_state = NULL, updated_at = ?
      WHERE status IN ('dispatching', 'cancelling') OR steer_state = 'dispatching'
    `).run(timestamp).changes;
    return { retryable, needsReview };
  }

  beginJobPreparation(jobId: string, at = new Date()): JobRow {
    const timestamp = at.toISOString();
    const changed = this.db.prepare(`
      UPDATE jobs SET status = 'preparing', attempt_count = attempt_count + 1,
        last_error_code = NULL, last_error_message = NULL, updated_at = ?
      WHERE job_id = ? AND status IN ('queued', 'retryable_failed') AND available_at <= ?
    `).run(timestamp, jobId, timestamp).changes;
    if (changed !== 1) throw new Error(`Job ${jobId} is no longer ready to prepare`);
    return this.getJobRequired(jobId);
  }

  setJobRuntime(jobId: string, herdrWorkspaceId: string, herdrPaneId: string): void {
    this.updateJob(jobId, ["preparing"], "preparing", {
      herdr_workspace_id: herdrWorkspaceId,
      herdr_pane_id: herdrPaneId,
    });
  }

  beginJobDispatch(jobId: string, at = new Date()): JobRow {
    this.updateJob(jobId, ["preparing"], "dispatching", { dispatch_started_at: at.toISOString() });
    return this.getJobRequired(jobId);
  }

  markJobRunning(jobId: string, at = new Date()): void {
    this.updateJob(jobId, ["dispatching"], "running", {
      prompt_accepted_at: at.toISOString(),
      last_error_code: null,
      last_error_message: null,
    });
  }

  recordJobPreparationFailure(
    jobId: string,
    code: string,
    message: string,
    maxAttempts: number,
    at = new Date(),
  ): JobRow {
    const row = this.getJobRequired(jobId);
    if (row.status !== "preparing") throw new Error(`Job ${jobId} is not preparing`);
    const status: JobStatus = row.attempt_count >= maxAttempts ? "failed" : "retryable_failed";
    const availableAt = status === "failed" ? at.toISOString() : retryAt(row.attempt_count, at);
    this.updateJob(jobId, ["preparing"], status, {
      available_at: availableAt,
      last_error_code: code,
      last_error_message: message,
      ...(status === "failed" ? { completed_at: at.toISOString() } : {}),
    });
    return this.getJobRequired(jobId);
  }

  recordJobSafePromptFailure(
    jobId: string,
    code: string,
    message: string,
    maxAttempts: number,
    at = new Date(),
  ): JobRow {
    const row = this.getJobRequired(jobId);
    if (row.status !== "dispatching") throw new Error(`Job ${jobId} is not dispatching`);
    const status: JobStatus = row.attempt_count >= maxAttempts ? "failed" : "retryable_failed";
    const availableAt = status === "failed" ? at.toISOString() : retryAt(row.attempt_count, at);
    this.updateJob(jobId, ["dispatching"], status, {
      available_at: availableAt,
      last_error_code: code,
      last_error_message: message,
      ...(status === "failed" ? { completed_at: at.toISOString() } : {}),
    });
    return this.getJobRequired(jobId);
  }

  markJobNeedsReview(jobId: string, code: string, message: string): void {
    const row = this.getJobRequired(jobId);
    if (["completed", "failed", "cancelled"].includes(row.status)) return;
    this.updateJob(jobId, [row.status], "needs_review", {
      last_error_code: code,
      last_error_message: message,
      steer_state: null,
    });
  }

  markJobBlocked(jobId: string, message: string, from: JobStatus[] = ["running"]): void {
    this.updateJob(jobId, from, "blocked", {
      last_error_code: "agent_blocked",
      last_error_message: message,
    });
  }

  saveJobResult(jobId: string, result: JobResultEnvelope, resultPath: string): void {
    result = parseJobResultEnvelope(result, jobId);
    const job = this.getJobRequired(jobId);
    if (job.result_path !== resultPath) throw new Error("Job result path mismatch");
    const status: JobStatus = result.status === "completed" ? "completed" : "failed";
    this.updateJob(jobId, ["running"], status, {
      result_json: stableStringify(result),
      result_path: resultPath,
      completed_at: result.completed_at,
      last_error_code: result.status === "failed" ? "agent_reported_failure" : null,
      last_error_message: result.status === "failed" ? result.summary : null,
    });
  }

  appendQueuedJobInstruction(jobId: string, sourceEventId: string, instruction: string): JobRow {
    this.assertJobSourceMatchesThread(jobId, sourceEventId);
    const row = this.getJobRequired(jobId);
    if (row.steer_event_id === sourceEventId && row.steer_state === "accepted") return row;
    if (!["queued", "retryable_failed"].includes(row.status)) throw new Error(`Job ${jobId} is not waiting to start`);
    this.db.prepare(`
      UPDATE jobs SET objective = objective || ?, steer_event_id = ?, steer_state = 'accepted', updated_at = ?
      WHERE job_id = ?
    `).run(`\n\n[DONA_FOLLOW_UP]\n${instruction}\n[/DONA_FOLLOW_UP]`, sourceEventId, nowUtc(), jobId);
    return this.getJobRequired(jobId);
  }

  beginJobSteer(jobId: string, sourceEventId: string): { row: JobRow; duplicate: boolean } {
    this.assertJobSourceMatchesThread(jobId, sourceEventId);
    const row = this.getJobRequired(jobId);
    if (row.steer_event_id === sourceEventId && row.steer_state === "accepted") return { row, duplicate: true };
    if (row.status !== "running") throw new Error(`Job ${jobId} in status ${row.status} cannot be steered`);
    this.db.prepare(`
      UPDATE jobs SET steer_event_id = ?, steer_state = 'dispatching', updated_at = ? WHERE job_id = ?
    `).run(sourceEventId, nowUtc(), jobId);
    return { row: this.getJobRequired(jobId), duplicate: false };
  }

  markJobSteerAccepted(jobId: string, sourceEventId: string): void {
    const changed = this.db.prepare(`
      UPDATE jobs SET steer_state = 'accepted', updated_at = ?
      WHERE job_id = ? AND steer_event_id = ? AND steer_state = 'dispatching'
    `).run(nowUtc(), jobId, sourceEventId).changes;
    if (changed !== 1) throw new Error(`Job ${jobId} steer state changed unexpectedly`);
  }

  clearJobSteer(jobId: string, sourceEventId: string): void {
    this.db.prepare(`
      UPDATE jobs SET steer_event_id = NULL, steer_state = NULL, updated_at = ?
      WHERE job_id = ? AND steer_event_id = ? AND steer_state = 'dispatching'
    `).run(nowUtc(), jobId, sourceEventId);
  }

  beginJobCancellation(jobId: string, sourceEventId: string): JobRow {
    this.assertJobSourceMatchesThread(jobId, sourceEventId);
    const row = this.getJobRequired(jobId);
    if (row.status === "cancelled") return row;
    if (!["queued", "retryable_failed", "running", "blocked"].includes(row.status)) {
      throw new Error(`Job ${jobId} in status ${row.status} cannot be cancelled`);
    }
    this.updateJob(jobId, [row.status], "cancelling", { completion_event_id: null });
    return this.getJobRequired(jobId);
  }

  markJobCancelled(jobId: string, reason: string, at = new Date()): void {
    this.updateJob(jobId, ["cancelling"], "cancelled", {
      completed_at: at.toISOString(),
      last_error_code: "cancelled",
      last_error_message: reason,
    });
  }

  enqueueJobNotification(jobId: string, at = new Date()): EnqueueResult | undefined {
    return this.db.transaction(() => this.materializeJobCompletion(jobId, at)).immediate();
  }

  private materializeJobCompletion(jobId: string, at: Date): EnqueueResult | undefined {
    const job = this.getJobRequired(jobId);
    const binding = this.getEventBinding(job.source_event_id);
    if (!binding) throw new Error("Unknown completion owner");
    this.assertJobSourceMatchesThread(jobId, job.source_event_id);
    if (!["blocked", "completed", "failed", "cancelled", "needs_review"].includes(job.status)) throw new Error("Job is not terminal");
    const savedCompletion = this.getJobCompletion(jobId);
    if (savedCompletion && binding.destination.kind === "none") return undefined;
    this.db.prepare(`INSERT OR IGNORE INTO job_completions
      (job_id, event_id, owner_json, destination_json, result_json, job_status, materialized_at, notification_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(jobId, job.source_event_id, stableStringify(binding.owner), stableStringify(binding.destination), job.result_json,
        job.status, at.toISOString(), binding.destination.kind === "none" ? "none" : "pending");
    if (binding.destination.kind === "none") return undefined;
    if (job.completion_event_id) {
      const existing = this.get(job.completion_event_id);
      if (!existing) throw new Error(`Job ${jobId} references a missing completion event`);
      const subject = JSON.parse(existing.subject_json) as Record<string, unknown>;
      if (existing.source !== "dona_job" || subject.job_id !== jobId || subject.source_event_id !== job.source_event_id ||
        existing.reply_target_json !== stableStringify(binding.destination)) throw new Error("Completion owner mismatch");
      this.linkJobCompletionNotification(jobId, job.status, existing);
      return { row: existing, outcome: "duplicate_same", duplicate: true, payloadMismatch: false };
    }

    const result = job.result_json ? JSON.parse(job.result_json) as Record<string, unknown> : null;
    const envelope: EventEnvelope = {
      schema_version: 1,
      source: "dona_job",
      external_event_id: `${job.job_id}:${job.status}`,
      type: `job_${job.status}`,
      occurred_at: at.toISOString(),
      subject: {
        job_id: job.job_id,
        source_event_id: job.source_event_id,
        ...(job.workspace_id ? { workspace_id: job.workspace_id } : {}),
        ...(job.channel_id ? { channel_id: job.channel_id } : {}),
        ...(job.thread_ts ? { thread_ts: job.thread_ts } : {}),
        ...(job.actor_id ? { actor_id: job.actor_id } : {}),
      },
      payload: {
        job_id: job.job_id,
        job_status: job.status,
        workspace: JSON.parse(job.workspace_json) as Record<string, unknown>,
        ...(result ? { result } : {}),
        ...(job.last_error_code ? { error_code: job.last_error_code } : {}),
        ...(job.last_error_message ? { error_message: job.last_error_message } : {}),
      },
      reply_target: binding.destination,
      trace: { job_id: job.job_id, source_event_id: job.source_event_id },
    };
    const enqueued = this.enqueue(envelope, at);
    this.db.prepare("UPDATE jobs SET completion_event_id = ?, updated_at = ? WHERE job_id = ?")
      .run(enqueued.row.event_id, at.toISOString(), jobId);
    this.linkJobCompletionNotification(jobId, job.status, enqueued.row);
    return enqueued;
  }

  private linkJobCompletionNotification(jobId: string, jobStatus: string, event: EventRow): void {
    const notificationState = event.status === "completed" ? "accepted" :
      ["needs_review", "dead_letter", "blocked"].includes(event.status) ? "needs_review" : "pending";
    this.db.prepare(`UPDATE job_completions
      SET notification_event_id = ?, notification_state = ?, notification_result_json = ?
      WHERE job_id = ? AND job_status = ?`)
      .run(event.event_id, notificationState, event.result_json, jobId, jobStatus);
  }

  getEventBinding(eventId: string): EventBinding | undefined { return readBinding(this.db, eventId); }

  // trusted local configuration API。HTTP/MCP/payload からこの policy を変更しない。
  setProviderExecutionPolicy(ownerInput: ProviderOwner, eventType: string, policy: ExecutionPolicy): void {
    const owner = eventOwnerSchema.parse(ownerInput);
    if (owner.kind !== "provider_resource" || !eventType.trim() || eventType.length > 128) throw new Error("Invalid provider policy");
    this.db.prepare(`INSERT INTO provider_execution_policies VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source, connection_id, resource_id, event_type) DO UPDATE SET policy_json = excluded.policy_json`)
      .run(owner.source, owner.connection_id, owner.resource_id, eventType, stableStringify(executionPolicySchema.parse(policy)));
  }

  enqueueProvider(envelope: EventEnvelope, ownerInput: ProviderOwner | undefined, at = new Date(), context?: QueueAdmissionContext): EnqueueResult {
    if (!ownerInput) return this.enqueue(envelope, at, context);
    const owner = eventOwnerSchema.parse(ownerInput);
    if (owner.kind !== "provider_resource" || owner.source !== envelope.source || envelope.reply_target !== null) throw new Error("Invalid provider binding");
    return this.db.transaction(() => {
      const policy = this.db.prepare(`SELECT policy_json FROM provider_execution_policies
        WHERE source = ? AND connection_id = ? AND resource_id = ? AND event_type = ?`)
        .get(owner.source, owner.connection_id, owner.resource_id, envelope.type) as { policy_json: string } | undefined;
      const binding = { owner, destination: { kind: "none" as const },
        execution: policy ? executionPolicySchema.parse(JSON.parse(policy.policy_json)) : { background_job: false, workspace: "scratch" as const } };
      return this.enqueue(envelope, at, { ...(context ?? { connectionId: owner.connection_id }), binding });
    }).immediate();
  }

  listOwnerJobs(sourceEventId: string): JobRow[] {
    const binding = this.getEventBinding(sourceEventId);
    if (!binding) throw new Error("Unknown event owner");
    return this.db.prepare(`SELECT j.* FROM jobs j JOIN job_bindings b ON b.job_id = j.job_id
      WHERE b.owner_json = ? ORDER BY j.created_at DESC LIMIT 100`).all(stableStringify(binding.owner)) as JobRow[];
  }

  assertJobSourceMatchesThread(jobId: string, sourceEventId: string): void {
    const job = this.getJobRequired(jobId);
    const source = this.getEventBinding(sourceEventId);
    const binding = this.db.prepare("SELECT owner_json FROM job_bindings WHERE job_id = ? AND event_id = ?")
      .get(jobId, job.source_event_id) as { owner_json: string } | undefined;
    if (!source || !binding || stableStringify(source.owner) !== binding.owner_json) {
      throw new Error(`Event ${sourceEventId} does not belong to job ${jobId}'s Slack thread or provider owner`);
    }
  }

  getJobCompletion(jobId: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM job_completions WHERE job_id = ? AND job_status = (SELECT status FROM jobs WHERE job_id = ?)").get(jobId, jobId) as Record<string, unknown> | undefined;
  }

  hasBlockedEvent(): boolean {
    return this.db.prepare("SELECT 1 FROM events WHERE status = 'blocked' LIMIT 1").get() !== undefined;
  }

  nextWaiting(): EventRow | undefined {
    return this.db
      .prepare("SELECT * FROM events WHERE status = 'waiting_agent' AND source!='dona_update' ORDER BY sequence LIMIT 1")
      .get() as EventRow | undefined;
  }

  nextAvailable(at = new Date()): EventRow | undefined {
    if (this.claimsClosed || this.db.prepare("SELECT 1 FROM events WHERE status IN ('dispatching','waiting_agent') AND source!='dona_update' LIMIT 1").get()) return undefined;
    const weights = this.queuePolicy.weights;
    const slots = Object.entries(weights).flatMap(([c,w]) => Array<string>(w).fill(c));
    const step = (this.db.prepare("SELECT step FROM queue_selector WHERE id=1").get() as {step:number}).step;
    const candidates = this.db.prepare(`SELECT events.*,l.class,l.last_selected FROM events
      JOIN queue_events q USING(event_id) JOIN queue_lanes l USING(lane)
      WHERE events.status IN ('queued','retryable_failed') AND events.source!='dona_update' AND events.available_at<=? AND ${connectionDispatchPredicate}
      AND NOT EXISTS (SELECT 1 FROM queue_events older JOIN events prior ON prior.event_id=older.event_id
        WHERE older.lane=q.lane AND prior.sequence<events.sequence AND prior.status!='completed'
          AND ${connectionDispatchPredicateFor("prior")})
      ORDER BY l.last_selected,events.sequence`).all(at.toISOString(), at.getTime(), at.getTime(), at.getTime(), at.getTime()) as (EventRow & {class:string})[];
    for (let offset=0;offset<slots.length;offset++) {
      const candidate = candidates.find(row=>row.class===slots[(step+offset)%slots.length]);
      if (candidate) return candidate;
    }
    return undefined;
  }

  updateEventsNeedingNotification(): EventRow[] {
    return this.db.prepare(`
      SELECT * FROM events
      WHERE source = 'dona_update' AND status IN ('queued', 'retryable_failed')
      ORDER BY sequence
    `).all() as EventRow[];
  }

  saveDeterministicCompleted(eventId: string, result: ResultEnvelope, resultPath: string): void {
    const row = this.getRequired(eventId);
    if (row.status === "completed") return;
    this.transition(eventId, ["queued", "retryable_failed"], "completed", {
      result_json: stableStringify(result),
      result_path: resultPath,
      completed_at: result.completed_at,
      last_error_code: null,
      last_error_message: null,
    });
  }

  saveDeterministicFailure(eventId: string, result: ResultEnvelope, resultPath: string, code: string): void {
    const row = this.getRequired(eventId);
    if (["needs_review", "completed"].includes(row.status)) return;
    this.transition(eventId, ["queued", "retryable_failed"], "needs_review", {
      result_json: stableStringify(result),
      result_path: resultPath,
      completed_at: result.completed_at,
      last_error_code: code,
      last_error_message: result.summary ?? "Update notification requires review",
    });
  }

  recoverStaleDispatching(at = new Date()): number {
    return this.db
      .prepare(`
        UPDATE events SET
          status = 'needs_review',
          last_error_code = 'stale_dispatching',
          last_error_message = 'Dispatcher restarted while prompt acceptance was unknown',
          updated_at = ?
        WHERE status = 'dispatching'
      `)
      .run(at.toISOString()).changes;
  }

  beginDispatch(eventId: string, resultPath: string, at = new Date()): EventRow {
    return this.db.transaction(() => {
    if (this.claimsClosed || this.nextAvailable(at)?.event_id !== eventId) throw new QueueClaimUnavailableError();
    const timestamp = at.toISOString();
    const changed = this.db
      .prepare(`
        UPDATE events SET
          status = 'dispatching', attempt_count = attempt_count + 1,
          dispatch_started_at = ?, prompt_accepted_at = NULL,
          result_path = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ?
        WHERE event_id = ? AND status IN ('queued', 'retryable_failed') AND ${connectionDispatchPredicate}
      `)
      .run(timestamp, resultPath, timestamp, eventId, at.getTime(), at.getTime()).changes;
    if (changed !== 1) throw new EventNotDispatchableError(eventId);
    const slots = Object.entries(this.queuePolicy.weights).flatMap(([c,w])=>Array<string>(w).fill(c));
    const lane = this.db.prepare("SELECT l.lane,l.class FROM queue_events q JOIN queue_lanes l USING(lane) WHERE q.event_id=?").get(eventId) as {lane:string;class:string};
    let step = (this.db.prepare("SELECT step FROM queue_selector WHERE id=1").get() as {step:number}).step;
    while (slots[step%slots.length] !== lane.class) step++;
    step++;
    this.db.prepare("UPDATE queue_selector SET step=? WHERE id=1").run(step);
    this.db.prepare("UPDATE queue_lanes SET last_selected=? WHERE lane=?").run(step,lane.lane);
    return this.get(eventId)!;
    }).immediate();
  }

  markWaiting(eventId: string, at = new Date()): void {
    this.transition(eventId, ["dispatching"], "waiting_agent", {
      prompt_accepted_at: at.toISOString(),
      last_error_code: null,
      last_error_message: null,
    });
  }

  markBlocked(eventId: string, message: string, from: EventStatus[] = ["queued", "retryable_failed", "dispatching", "waiting_agent"]): void {
    this.transition(eventId, from, "blocked", {
      last_error_code: "agent_blocked",
      last_error_message: message,
    });
  }

  markNeedsReview(eventId: string, code: string, message: string): void {
    this.transition(eventId, ["dispatching", "waiting_agent"], "needs_review", {
      last_error_code: code,
      last_error_message: message,
    });
  }

  recordPreDispatchFailure(eventId: string, code: string, message: string, maxAttempts: number, at = new Date()): EventRow | undefined {
    return this.db.transaction(() => {
      const row = this.get(eventId);
      if (!row || !["queued", "retryable_failed"].includes(row.status)) return undefined;
      const attemptCount = row.attempt_count + 1;
      const status: EventStatus = attemptCount >= maxAttempts ? "dead_letter" : "retryable_failed";
      const availableAt = status === "dead_letter" ? at.toISOString() : retryAt(attemptCount, at);
      this.db
        .prepare(`
          UPDATE events SET status = ?, attempt_count = ?, available_at = ?,
            last_error_code = ?, last_error_message = ?, updated_at = ?
          WHERE event_id = ?
        `)
        .run(status, attemptCount, availableAt, code, message, at.toISOString(), eventId);
      return this.get(eventId)!;
    }).immediate();
  }

  recordSafePromptFailure(eventId: string, code: string, message: string, maxAttempts: number, at = new Date()): EventRow {
    return this.db.transaction(() => {
      const row = this.get(eventId);
      if (!row || row.status !== "dispatching") throw new Error(`Event ${eventId} is not dispatching`);
      const status: EventStatus = row.attempt_count >= maxAttempts ? "dead_letter" : "retryable_failed";
      const availableAt = status === "dead_letter" ? at.toISOString() : retryAt(row.attempt_count, at);
      this.db
        .prepare(`
          UPDATE events SET status = ?, available_at = ?, last_error_code = ?,
            last_error_message = ?, updated_at = ? WHERE event_id = ?
        `)
        .run(status, availableAt, code, message, at.toISOString(), eventId);
      return this.get(eventId)!;
    }).immediate();
  }

  recordWaitingError(eventId: string, code: string, message: string, at = new Date()): void {
    this.db
      .prepare(`
        UPDATE events SET last_error_code = ?, last_error_message = ?, updated_at = ?
        WHERE event_id = ? AND status = 'waiting_agent'
      `)
      .run(code, message, at.toISOString(), eventId);
  }

  saveCompleted(eventId: string, result: ResultEnvelope, resultPath: string): void {
    result = parseResultEnvelope(result, eventId);
    this.transition(eventId, ["waiting_agent"], "completed", {
      result_json: stableStringify(result),
      result_path: resultPath,
      completed_at: result.completed_at,
      last_error_code: null,
      last_error_message: null,
    });
  }

  saveFailedResult(eventId: string, result: ResultEnvelope, resultPath: string): void {
    result = parseResultEnvelope(result, eventId);
    this.transition(eventId, ["waiting_agent"], "dead_letter", {
      result_json: stableStringify(result),
      result_path: resultPath,
      completed_at: result.completed_at,
      last_error_code: "agent_reported_failure",
      last_error_message: result.summary ?? "Agent reported failure",
    });
  }

  manualRetry(eventId: string, force: boolean, at = new Date()): EventRow {
    const row = this.getRequired(eventId);
    if (["blocked", "needs_review"].includes(row.status) && !force) {
      throw new Error(`${row.status} may already have side effects; repeat with --force after review`);
    }
    if (!["blocked", "needs_review", "dead_letter", "retryable_failed"].includes(row.status)) {
      throw new Error(`Event in status ${row.status} cannot be retried`);
    }
    this.db
      .prepare(`
        UPDATE events SET status = 'queued', attempt_count = 0, available_at = ?,
          dispatch_started_at = NULL, prompt_accepted_at = NULL, completed_at = NULL,
          result_json = NULL, result_path = NULL, last_error_code = NULL,
          last_error_message = NULL, updated_at = ? WHERE event_id = ?
      `)
      .run(at.toISOString(), at.toISOString(), eventId);
    return this.getRequired(eventId);
  }

  manualComplete(eventId: string, at = new Date()): EventRow {
    const row = this.getRequired(eventId);
    if (row.status === "completed") return row;
    const result: ResultEnvelope = {
      schema_version: 1,
      event_id: eventId,
      status: "completed",
      summary: "Manually marked completed after operator review",
      actions: [],
      memory_candidates: [],
      completed_at: at.toISOString(),
    };
    this.db
      .prepare(`
        UPDATE events SET status = 'completed', result_json = ?, completed_at = ?,
          last_error_code = NULL, last_error_message = NULL, updated_at = ?
        WHERE event_id = ?
      `)
      .run(stableStringify(result), at.toISOString(), at.toISOString(), eventId);
    return this.getRequired(eventId);
  }

  manualDeadLetter(eventId: string, at = new Date()): EventRow {
    this.getRequired(eventId);
    this.db
      .prepare(`
        UPDATE events SET status = 'dead_letter', last_error_code = 'operator_dead_letter',
          last_error_message = 'Moved to dead letter by operator', updated_at = ? WHERE event_id = ?
      `)
      .run(at.toISOString(), eventId);
    return this.getRequired(eventId);
  }

  private getRequired(eventId: string): EventRow {
    const row = this.get(eventId);
    if (!row) throw new Error(`Event ${eventId} was not found`);
    return row;
  }

  private getJobRequired(jobId: string): JobRow {
    const row = this.getJob(jobId);
    if (!row) throw new Error(`Job ${jobId} was not found`);
    return row;
  }

  private updateJob(
    jobId: string,
    from: JobStatus[],
    to: JobStatus,
    values: Record<string, string | null>,
  ): void {
    const timestamp = nowUtc();
    const assignments = [...Object.keys(values).map((key) => `${key} = ?`), "status = ?", "updated_at = ?"];
    const params = [...Object.values(values), to, timestamp, jobId, ...from];
    const placeholders = from.map(() => "?").join(", ");
    const changed = this.db.prepare(
      `UPDATE jobs SET ${assignments.join(", ")} WHERE job_id = ? AND status IN (${placeholders})`,
    ).run(...params).changes;
    if (changed !== 1) throw new Error(`Invalid status transition for job ${jobId} to ${to}`);
  }

  private transition(
    eventId: string,
    from: EventStatus[],
    to: EventStatus,
    values: Record<string, string | null>,
  ): void {
    const timestamp = nowUtc();
    const assignments = [...Object.keys(values).map((key) => `${key} = ?`), "status = ?", "updated_at = ?"];
    const params = [...Object.values(values), to, timestamp, eventId, ...from];
    const placeholders = from.map(() => "?").join(", ");
    const changed = this.db
      .prepare(`UPDATE events SET ${assignments.join(", ")} WHERE event_id = ? AND status IN (${placeholders})`)
      .run(...params).changes;
    if (changed !== 1) throw new Error(`Invalid status transition for event ${eventId} to ${to}`);
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
