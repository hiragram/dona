import { createHash, randomBytes } from "node:crypto";

import Database from "better-sqlite3";
import { ulid } from "ulid";
import { z } from "zod";

import { insertEventJobBinding, readEventJobBinding } from "./job-routing.js";
import type { JobRow } from "./types.js";
import { stableStringify } from "./validation.js";

export const workerMessageProtocolVersion = 1 as const;
export const workerMessagePayloadUtf8ByteMax = 16_384;
export const workerMessageRetentionDays = 30;
export const workerMessageLeaseMaxMs = 300_000;

const utcRfc3339Pattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;
const utcRfc3339 = z.string().regex(utcRfc3339Pattern)
  .refine((value) => {
    const match=utcRfc3339Pattern.exec(value);
    const parsed=new Date(value);
    if(!match||Number.isNaN(parsed.getTime()))return false;
    const [,year,month,day,hour,minute,second]=match.map(Number);
    return parsed.getUTCFullYear()===year&&parsed.getUTCMonth()+1===month&&parsed.getUTCDate()===day
      &&parsed.getUTCHours()===hour&&parsed.getUTCMinutes()===minute&&parsed.getUTCSeconds()===second;
  }, "must be a real UTC RFC 3339 date-time");
const identifier = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const safeText = z.string().trim().min(1).max(4_000);
const reportPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("checkpoint"), summary: safeText }).strict(),
  z.object({ kind: z.literal("question"), question: safeText }).strict(),
  z.object({ kind: z.literal("risk"), summary: safeText, severity: z.enum(["low", "medium", "high"]) }).strict(),
  z.object({ kind: z.literal("decision_request"), question: safeText, options: z.array(safeText.max(1_000)).min(1).max(8) }).strict(),
]);
const instructionPayload = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("answer"), text: safeText }).strict(),
  z.object({ operation: z.literal("add_condition"), text: safeText }).strict(),
  z.object({ operation: z.literal("change_priority"), priority: z.enum(["low", "normal", "high", "urgent"]), reason: safeText.optional() }).strict(),
]);

const commonMessage = {
  schema_version: z.literal(workerMessageProtocolVersion),
  source_event_id: identifier,
  producer_sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  idempotency_key: identifier,
  occurred_at: utcRfc3339,
  correlation_message_id: z.string().regex(/^msg_[0-9a-hjkmnp-tv-z]{26}$/).optional(),
  conversation_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
};

export const workerReportSchema = z.object({ ...commonMessage, payload: reportPayload }).strict();
export const donaInstructionSchema = z.object({ ...commonMessage, payload: instructionPayload }).strict();

export type WorkerReportInput = z.infer<typeof workerReportSchema>;
export type DonaInstructionInput = z.infer<typeof donaInstructionSchema>;
export type WorkerMessageInput = WorkerReportInput | DonaInstructionInput;
export type WorkerMessageDirection = "worker_to_dona" | "dona_to_worker";
export type WorkerMessageKind = "checkpoint" | "question" | "risk" | "decision_request" | "answer" | "add_condition" | "change_priority";

export interface WorkerMessageRow {
  message_id: string;
  schema_version: number;
  job_id: string;
  source_event_id: string;
  workspace_id: string | null;
  channel_id: string | null;
  thread_ts: string | null;
  direction: WorkerMessageDirection;
  kind: WorkerMessageKind;
  producer: "worker" | "dona-main";
  producer_sequence: number;
  idempotency_key: string;
  payload_json: string;
  payload_sha256: string;
  correlation_message_id: string | null;
  conversation_revision: number | null;
  occurred_at: string;
  accepted_at: string;
}

export interface WorkerMessageDeliveryRow {
  delivery_id: string;
  message_id: string;
  consumer: "dona-main" | "worker";
  state: "pending" | "leased" | "delivered" | "superseded";
  available_at: string;
  lease_owner: string | null;
  lease_token_sha256: string | null;
  lease_expires_at: string | null;
  fence: number;
  attempt_count: number;
  delivered_at: string | null;
  delivered_lease_owner: string | null;
  delivered_lease_token_sha256: string | null;
  delivered_fence: number | null;
  created_at: string;
  updated_at: string;
}

export class WorkerMessageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkerMessageError";
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.length ? `${issue.path.join(".")} ` : "";
    throw new WorkerMessageError("invalid_worker_message", `${location}${issue?.message ?? "is invalid"}`);
  }
  const bytes = Buffer.byteLength(stableStringify(parsed.data), "utf8");
  if (bytes > workerMessagePayloadUtf8ByteMax) {
    throw new WorkerMessageError("worker_message_too_large", `message exceeds ${workerMessagePayloadUtf8ByteMax} UTF-8 bytes`);
  }
  return parsed.data;
}

export function parseWorkerReport(value: unknown): WorkerReportInput { return parse(workerReportSchema, value); }
export function parseDonaInstruction(value: unknown): DonaInstructionInput { return parse(donaInstructionSchema, value); }

export function migrateWorkerMessaging(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_messages (
      message_id              TEXT PRIMARY KEY,
      schema_version          INTEGER NOT NULL CHECK (schema_version = 1),
      job_id                  TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
      source_event_id         TEXT NOT NULL REFERENCES events(event_id),
      workspace_id            TEXT,
      channel_id              TEXT,
      thread_ts               TEXT,
      direction               TEXT NOT NULL CHECK (direction IN ('worker_to_dona','dona_to_worker')),
      kind                    TEXT NOT NULL CHECK (kind IN ('checkpoint','question','risk','decision_request','answer','add_condition','change_priority')),
      producer                TEXT NOT NULL CHECK (producer IN ('worker','dona-main')),
      producer_sequence       INTEGER NOT NULL CHECK (producer_sequence > 0),
      idempotency_key         TEXT NOT NULL,
      payload_json            TEXT NOT NULL,
      payload_sha256          TEXT NOT NULL CHECK (length(payload_sha256) = 64),
      correlation_message_id  TEXT REFERENCES worker_messages(message_id),
      conversation_revision   INTEGER,
      occurred_at             TEXT NOT NULL,
      accepted_at             TEXT NOT NULL,
      UNIQUE(job_id, producer, producer_sequence),
      UNIQUE(job_id, producer, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS worker_messages_job_idx ON worker_messages(job_id, accepted_at, message_id);
    CREATE INDEX IF NOT EXISTS worker_messages_retention_idx ON worker_messages(accepted_at, message_id);

    CREATE TABLE IF NOT EXISTS worker_message_deliveries (
      delivery_id          TEXT PRIMARY KEY,
      message_id           TEXT NOT NULL REFERENCES worker_messages(message_id) ON DELETE CASCADE,
      consumer             TEXT NOT NULL CHECK (consumer IN ('dona-main','worker')),
      state                TEXT NOT NULL CHECK (state IN ('pending','leased','delivered','superseded')),
      available_at         TEXT NOT NULL,
      lease_owner          TEXT,
      lease_token_sha256   TEXT,
      lease_expires_at     TEXT,
      fence                INTEGER NOT NULL DEFAULT 0,
      attempt_count        INTEGER NOT NULL DEFAULT 0,
      delivered_at        TEXT,
      delivered_lease_owner TEXT,
      delivered_lease_token_sha256 TEXT,
      delivered_fence      INTEGER,
      event_id             TEXT REFERENCES events(event_id),
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL,
      UNIQUE(message_id, consumer)
    );
    CREATE INDEX IF NOT EXISTS worker_message_delivery_claim_idx
      ON worker_message_deliveries(consumer, state, available_at, created_at);

    CREATE TRIGGER IF NOT EXISTS worker_message_terminal_worker_deliveries
    AFTER UPDATE OF status ON jobs
    WHEN NEW.status IN ('completed','failed','cancelled') AND OLD.status <> NEW.status
    BEGIN
      UPDATE worker_message_deliveries
      SET state='superseded',lease_owner=NULL,lease_token_sha256=NULL,lease_expires_at=NULL,updated_at=NEW.updated_at
      WHERE consumer='worker' AND state IN ('pending','leased')
        AND message_id IN (SELECT message_id FROM worker_messages WHERE job_id=NEW.job_id);
    END;

    CREATE TABLE IF NOT EXISTS worker_message_receipts (
      receipt_id       TEXT PRIMARY KEY,
      message_id       TEXT NOT NULL REFERENCES worker_messages(message_id) ON DELETE CASCADE,
      delivery_id      TEXT REFERENCES worker_message_deliveries(delivery_id) ON DELETE SET NULL,
      receipt_kind     TEXT NOT NULL CHECK (receipt_kind IN ('accepted','delivered')),
      consumer         TEXT NOT NULL CHECK (consumer IN ('dispatcher','dona-main','worker')),
      created_at       TEXT NOT NULL,
      UNIQUE(message_id, receipt_kind, consumer)
    );

    CREATE TABLE IF NOT EXISTS worker_message_cadence (
      job_id                 TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
      minimum_interval_ms    INTEGER NOT NULL DEFAULT 60000 CHECK (minimum_interval_ms BETWEEN 0 AND 3600000),
      silence_interval_ms    INTEGER NOT NULL DEFAULT 900000 CHECK (silence_interval_ms BETWEEN 60000 AND 86400000),
      last_report_at         TEXT,
      last_delivery_at       TEXT,
      silence_due_at         TEXT,
      pending_message_id     TEXT REFERENCES worker_messages(message_id),
      generation             INTEGER NOT NULL DEFAULT 0,
      updated_at             TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worker_message_workspace_cadence (
      workspace_id           TEXT PRIMARY KEY,
      minimum_interval_ms    INTEGER NOT NULL DEFAULT 60000 CHECK (minimum_interval_ms BETWEEN 0 AND 3600000),
      last_delivery_at       TEXT,
      updated_at             TEXT NOT NULL
    );
  `);
  const deliveryColumns=new Set((db.pragma("table_info(worker_message_deliveries)") as Array<{name:string}>).map(row=>row.name));
  if(!deliveryColumns.has("event_id"))db.exec("ALTER TABLE worker_message_deliveries ADD COLUMN event_id TEXT REFERENCES events(event_id)");
  if(!deliveryColumns.has("delivered_lease_owner"))db.exec("ALTER TABLE worker_message_deliveries ADD COLUMN delivered_lease_owner TEXT");
  if(!deliveryColumns.has("delivered_lease_token_sha256"))db.exec("ALTER TABLE worker_message_deliveries ADD COLUMN delivered_lease_token_sha256 TEXT");
  if(!deliveryColumns.has("delivered_fence"))db.exec("ALTER TABLE worker_message_deliveries ADD COLUMN delivered_fence INTEGER");
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function terminal(status: JobRow["status"]): boolean { return status === "completed" || status === "failed" || status === "cancelled"; }
function reportKind(input: WorkerReportInput): WorkerMessageKind { return input.payload.kind; }
function instructionKind(input: DonaInstructionInput): WorkerMessageKind { return input.payload.operation; }

export class WorkerMessageRepository {
  constructor(private readonly db: Database.Database) {}

  appendReport(jobId: string, raw: unknown, at = new Date()) {
    return this.append(jobId, "worker_to_dona", parseWorkerReport(raw), at);
  }

  appendInstruction(jobId: string, raw: unknown, at = new Date()) {
    return this.append(jobId, "dona_to_worker", parseDonaInstruction(raw), at);
  }

  private append(jobId: string, direction: WorkerMessageDirection, input: WorkerMessageInput, at: Date): { message: WorkerMessageRow; receipt_id: string; outcome: "created" | "reused" } {
    const job = this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow | undefined;
    if (!job) throw new WorkerMessageError("job_not_found", "job does not exist");
    this.assertAuthorized(job, input.source_event_id);
    const producer = direction === "worker_to_dona" ? "worker" : "dona-main";
    const payloadJson = stableStringify(input.payload);
    const payloadSha = sha256(payloadJson);
    const acceptedAt = at.toISOString();
    const keyExisting = this.db.prepare("SELECT * FROM worker_messages WHERE job_id=? AND producer=? AND idempotency_key=?")
      .get(jobId, producer, input.idempotency_key) as WorkerMessageRow | undefined;
    if (keyExisting) {
      if (keyExisting.payload_sha256 !== payloadSha || keyExisting.producer_sequence !== input.producer_sequence
        || keyExisting.occurred_at !== input.occurred_at || keyExisting.source_event_id !== input.source_event_id
        || keyExisting.correlation_message_id !== (input.correlation_message_id ?? null)
        || keyExisting.conversation_revision !== (input.conversation_revision ?? null)) {
        throw new WorkerMessageError("worker_message_idempotency_conflict", "idempotency key already has a different canonical message");
      }
      const receipt = this.db.prepare("SELECT receipt_id FROM worker_message_receipts WHERE message_id=? AND receipt_kind='accepted' AND consumer='dispatcher'")
        .get(keyExisting.message_id) as { receipt_id: string };
      return { message: keyExisting, receipt_id: receipt.receipt_id, outcome: "reused" };
    }
    if (terminal(job.status)) throw new WorkerMessageError("worker_message_terminal_fence", "new messages are rejected after terminal job state");
    if (input.correlation_message_id) {
      const correlated = this.db.prepare("SELECT job_id FROM worker_messages WHERE message_id=?").get(input.correlation_message_id) as { job_id: string } | undefined;
      if (!correlated || correlated.job_id !== jobId) throw new WorkerMessageError("worker_message_correlation_mismatch", "correlated message is not bound to this job");
    }
    const max = this.db.prepare("SELECT MAX(producer_sequence) AS value FROM worker_messages WHERE job_id=? AND producer=?")
      .get(jobId, producer) as { value: number | null };
    const expected = (max.value ?? 0) + 1;
    if (input.producer_sequence < expected) throw new WorkerMessageError("worker_message_sequence_rollback", `expected producer sequence ${expected}`);
    if (input.producer_sequence > expected) throw new WorkerMessageError("worker_message_sequence_gap", `expected producer sequence ${expected}`);

    return this.db.transaction(() => {
      const messageId = `msg_${ulid(at.getTime()).toLowerCase()}`;
      const receiptId = `rcpt_${ulid(at.getTime()).toLowerCase()}`;
      const deliveryId = `dlv_${ulid(at.getTime()).toLowerCase()}`;
      const kind = direction === "worker_to_dona" ? reportKind(input as WorkerReportInput) : instructionKind(input as DonaInstructionInput);
      this.db.prepare(`INSERT INTO worker_messages(message_id,schema_version,job_id,source_event_id,workspace_id,channel_id,thread_ts,direction,kind,producer,producer_sequence,idempotency_key,payload_json,payload_sha256,correlation_message_id,conversation_revision,occurred_at,accepted_at)
        VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(messageId, jobId, input.source_event_id, job.workspace_id, job.channel_id, job.thread_ts,
        direction, kind, producer, input.producer_sequence, input.idempotency_key, payloadJson, payloadSha,
        input.correlation_message_id ?? null, input.conversation_revision ?? null, input.occurred_at, acceptedAt);
      this.db.prepare("INSERT INTO worker_message_receipts(receipt_id,message_id,delivery_id,receipt_kind,consumer,created_at) VALUES(?,?,NULL,'accepted','dispatcher',?)")
        .run(receiptId, messageId, acceptedAt);

      let availableAt = acceptedAt;
      if (direction === "worker_to_dona") {
        const cadence = this.db.prepare("SELECT * FROM worker_message_cadence WHERE job_id=?").get(jobId) as { minimum_interval_ms:number;silence_interval_ms:number;last_delivery_at:string|null;pending_message_id:string|null } | undefined;
        const workspaceCadence=job.workspace_id?this.db.prepare("SELECT * FROM worker_message_workspace_cadence WHERE workspace_id=?").get(job.workspace_id) as
          {minimum_interval_ms:number;last_delivery_at:string|null}|undefined:undefined;
        const minimum = cadence?.minimum_interval_ms ?? 60_000;
        const report = input as WorkerReportInput;
        const urgent = kind === "question" || kind === "decision_request" || (report.payload.kind === "risk" && report.payload.severity === "high");
        if (!urgent && cadence?.last_delivery_at) availableAt = new Date(Math.max(at.getTime(), Date.parse(cadence.last_delivery_at) + minimum)).toISOString();
        if (!urgent && workspaceCadence?.last_delivery_at) availableAt = new Date(Math.max(Date.parse(availableAt),
          Date.parse(workspaceCadence.last_delivery_at)+workspaceCadence.minimum_interval_ms)).toISOString();
        if (!urgent && cadence?.pending_message_id) {
          const pending = this.db.prepare("SELECT kind,payload_json FROM worker_messages WHERE message_id=?")
            .get(cadence.pending_message_id) as {kind:WorkerMessageKind;payload_json:string}|undefined;
          const pendingPayload = pending ? JSON.parse(pending.payload_json) as {severity?:unknown} : undefined;
          const pendingUrgent = pending?.kind === "question" || pending?.kind === "decision_request"
            || (pending?.kind === "risk" && pendingPayload?.severity === "high");
          if (!pendingUrgent) {
            this.db.prepare("UPDATE worker_message_deliveries SET state='superseded',updated_at=? WHERE message_id=? AND consumer='dona-main' AND state='pending'")
              .run(acceptedAt, cadence.pending_message_id);
          }
        }
        const silenceInterval = cadence?.silence_interval_ms ?? 900_000;
        this.db.prepare(`INSERT INTO worker_message_cadence(job_id,last_report_at,silence_due_at,pending_message_id,generation,updated_at)
          VALUES(?,?,?,?,1,?) ON CONFLICT(job_id) DO UPDATE SET last_report_at=excluded.last_report_at,silence_due_at=excluded.silence_due_at,
          pending_message_id=COALESCE(excluded.pending_message_id,worker_message_cadence.pending_message_id),
          generation=worker_message_cadence.generation+1,updated_at=excluded.updated_at`)
          .run(jobId, acceptedAt, new Date(at.getTime() + silenceInterval).toISOString(), urgent ? null : messageId, acceptedAt);
      }
      const consumer = direction === "worker_to_dona" ? "dona-main" : "worker";
      this.db.prepare(`INSERT INTO worker_message_deliveries(delivery_id,message_id,consumer,state,available_at,lease_owner,lease_token_sha256,lease_expires_at,fence,attempt_count,delivered_at,created_at,updated_at)
        VALUES(?,?,?,'pending',?,NULL,NULL,NULL,0,0,NULL,?,?)`).run(deliveryId, messageId, consumer, availableAt, acceptedAt, acceptedAt);
      return { message: this.getMessageRequired(messageId), receipt_id: receiptId, outcome: "created" as const };
    }).immediate();
  }

  getMessage(jobId: string, messageId: string, sourceEventId: string): WorkerMessageRow | undefined {
    const job=this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow|undefined;
    if(!job)return undefined;
    this.assertAuthorized(job,sourceEventId);
    return this.db.prepare("SELECT * FROM worker_messages WHERE job_id=? AND message_id=?")
      .get(jobId, messageId) as WorkerMessageRow | undefined;
  }

  reconcile(jobId: string, sourceEventId: string, producer: "worker" | "dona-main", idempotencyKey: string) {
    const job = this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow | undefined;
    if (!job) throw new WorkerMessageError("job_not_found", "job does not exist");
    this.assertAuthorized(job,sourceEventId);
    const message = this.db.prepare("SELECT * FROM worker_messages WHERE job_id=? AND producer=? AND idempotency_key=?")
      .get(jobId, producer, idempotencyKey) as WorkerMessageRow | undefined;
    if (!message) return { reconciliation: "not_found" as const };
    const receipt = this.db.prepare("SELECT receipt_id,receipt_kind,consumer,created_at FROM worker_message_receipts WHERE message_id=? ORDER BY created_at")
      .all(message.message_id);
    const delivery = this.db.prepare("SELECT delivery_id,consumer,state,available_at,fence,attempt_count,delivered_at FROM worker_message_deliveries WHERE message_id=?")
      .get(message.message_id);
    return { reconciliation: "matched" as const, message: this.project(message), receipts: receipt, delivery };
  }

  claim(jobId: string, sourceEventId: string, consumer: "dona-main" | "worker", leaseOwner: string, limit: number, leaseMs: number, at = new Date()) {
    if (!identifier.safeParse(leaseOwner).success) throw new WorkerMessageError("invalid_lease_owner", "lease owner is invalid");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new WorkerMessageError("invalid_claim_limit", "claim limit must be between 1 and 100");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > workerMessageLeaseMaxMs) throw new WorkerMessageError("invalid_lease_duration", "lease duration is invalid");
    const job = this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow|undefined;
    if (!job) throw new WorkerMessageError("job_not_found", "job does not exist");
    this.assertAuthorized(job,sourceEventId);
    return this.db.transaction(() => {
      const now = at.toISOString();
      this.db.prepare(`UPDATE worker_message_deliveries SET state='pending',lease_owner=NULL,lease_token_sha256=NULL,lease_expires_at=NULL,updated_at=?
        WHERE consumer=? AND state='leased' AND lease_expires_at<=?`).run(now, consumer, now);
      const candidates = this.db.prepare(`SELECT d.delivery_id FROM worker_message_deliveries d JOIN worker_messages m USING(message_id)
        WHERE m.job_id=? AND d.consumer=? AND d.state='pending' AND d.available_at<=?
        ORDER BY m.producer_sequence,d.available_at,d.created_at,d.delivery_id LIMIT ?`).all(jobId, consumer, now, limit) as Array<{delivery_id:string}>;
      return candidates.map(({ delivery_id }) => {
        const token = `lease_${ulid(at.getTime()).toLowerCase()}_${randomBytes(16).toString("hex")}`;
        const expires = new Date(at.getTime() + leaseMs).toISOString();
        const changed = this.db.prepare(`UPDATE worker_message_deliveries SET state='leased',lease_owner=?,lease_token_sha256=?,lease_expires_at=?,fence=fence+1,attempt_count=attempt_count+1,updated_at=?
          WHERE delivery_id=? AND state='pending'`).run(leaseOwner, sha256(token), expires, now, delivery_id).changes;
        if (changed !== 1) throw new WorkerMessageError("delivery_claim_conflict", "delivery was concurrently claimed");
        const row = this.db.prepare(`SELECT d.*,m.job_id,m.source_event_id,m.kind,m.direction,m.producer_sequence,m.correlation_message_id,m.conversation_revision,m.occurred_at,m.payload_json
          FROM worker_message_deliveries d JOIN worker_messages m USING(message_id) WHERE d.delivery_id=?`).get(delivery_id) as WorkerMessageDeliveryRow & WorkerMessageRow;
        const {payload_json,...projected}=row;
        return { delivery: {...projected,payload:JSON.parse(payload_json)}, lease_token: token };
      });
    }).immediate();
  }

  acknowledge(jobId: string, sourceEventId: string, deliveryId: string, leaseOwner: string, leaseToken: string, fence: number, at = new Date()) {
    return this.db.transaction(() => {
      const now = at.toISOString();
      const row = this.db.prepare("SELECT * FROM worker_message_deliveries WHERE delivery_id=?")
        .get(deliveryId) as WorkerMessageDeliveryRow | undefined;
      if (!row) throw new WorkerMessageError("delivery_not_found", "delivery does not exist");
      const bound = this.db.prepare("SELECT job_id,source_event_id FROM worker_messages WHERE message_id=?").get(row.message_id) as {job_id:string;source_event_id:string}|undefined;
      const job=this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow|undefined;
      if(!job)throw new WorkerMessageError("job_not_found","job does not exist");
      this.assertAuthorized(job,sourceEventId);
      if (!bound || bound.job_id !== jobId) throw new WorkerMessageError("job_binding_mismatch", "source event does not own this delivery");
      const tokenSha = sha256(leaseToken);
      if (row.state === "delivered") {
        if (row.delivered_lease_owner !== leaseOwner || row.delivered_lease_token_sha256 !== tokenSha || row.delivered_fence !== fence) {
          throw new WorkerMessageError("delivery_fence_mismatch", "delivered receipt does not match the original lease proof");
        }
        return { delivery: row, outcome: "reused" as const };
      }
      if (row.state !== "leased" || row.lease_owner !== leaseOwner || row.lease_token_sha256 !== tokenSha || row.fence !== fence || !row.lease_expires_at || row.lease_expires_at <= now) {
        throw new WorkerMessageError("delivery_fence_mismatch", "delivery lease is not current");
      }
      this.db.prepare(`UPDATE worker_message_deliveries SET state='delivered',delivered_at=?,delivered_lease_owner=?,
        delivered_lease_token_sha256=?,delivered_fence=?,lease_owner=NULL,lease_token_sha256=NULL,lease_expires_at=NULL,updated_at=? WHERE delivery_id=?`)
        .run(now, leaseOwner, tokenSha, fence, now, deliveryId);
      const receiptId = `rcpt_${ulid(at.getTime()).toLowerCase()}`;
      this.db.prepare("INSERT OR IGNORE INTO worker_message_receipts(receipt_id,message_id,delivery_id,receipt_kind,consumer,created_at) VALUES(?,?,?,'delivered',?,?)")
        .run(receiptId, row.message_id, deliveryId, row.consumer, now);
      const message = this.getMessageRequired(row.message_id);
      if (row.consumer === "dona-main") this.db.prepare(`UPDATE worker_message_cadence SET last_delivery_at=?,pending_message_id=CASE WHEN pending_message_id=? THEN NULL ELSE pending_message_id END,updated_at=? WHERE job_id=?`)
        .run(now, row.message_id, now, message.job_id);
      if(row.consumer==="dona-main"&&message.workspace_id)this.recordWorkspaceDelivery(message.workspace_id,now);
      return { delivery: this.db.prepare("SELECT * FROM worker_message_deliveries WHERE delivery_id=?").get(deliveryId), receipt_id: receiptId, outcome: "delivered" as const };
    }).immediate();
  }

  acknowledgeWorker(jobId: string, sourceEventId: string, deliveryId: string, leaseOwner: string, leaseToken: string, fence: number, at = new Date()) {
    const row = this.db.prepare("SELECT consumer FROM worker_message_deliveries WHERE delivery_id=?")
      .get(deliveryId) as {consumer:WorkerMessageDeliveryRow["consumer"]}|undefined;
    if (row && row.consumer !== "worker") throw new WorkerMessageError("delivery_consumer_mismatch", "worker bridge cannot acknowledge this delivery");
    return this.acknowledge(jobId,sourceEventId,deliveryId,leaseOwner,leaseToken,fence,at);
  }

  operationalSnapshot(at = new Date()) {
    const pending = this.db.prepare("SELECT COUNT(*) AS count FROM worker_message_deliveries WHERE state IN ('pending','leased')").get() as {count:number};
    const overdue = this.db.prepare("SELECT COUNT(*) AS count FROM worker_message_deliveries WHERE state='pending' AND available_at<=?")
      .get(at.toISOString()) as {count:number};
    const expired = this.db.prepare("SELECT COUNT(*) AS count FROM worker_message_deliveries WHERE state='leased' AND lease_expires_at<=?").get(at.toISOString()) as {count:number};
    const dueSilence = this.db.prepare(`SELECT COUNT(*) AS count FROM worker_message_cadence c JOIN jobs j USING(job_id)
      WHERE c.silence_due_at<=? AND j.status NOT IN ('completed','failed','cancelled')`).get(at.toISOString()) as {count:number};
    return { protocol_version: workerMessageProtocolVersion, pending_deliveries: pending.count, overdue_deliveries: overdue.count,
      expired_leases: expired.count, due_silence_deadlines: dueSilence.count, degraded: expired.count > 0 || overdue.count > 0 };
  }

  publishPendingReports(limit = 100, at = new Date()): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new WorkerMessageError("invalid_publish_limit", "publish limit must be between 1 and 100");
    return this.db.transaction(() => {
      const now = at.toISOString();
      this.db.prepare(`UPDATE worker_message_deliveries SET state='pending',lease_owner=NULL,lease_token_sha256=NULL,lease_expires_at=NULL,updated_at=?
        WHERE consumer='dona-main' AND state='leased' AND lease_expires_at<=?`).run(now, now);
      const rows = this.db.prepare(`SELECT d.delivery_id,d.message_id,m.job_id,m.source_event_id,m.workspace_id,m.channel_id,m.thread_ts,m.kind,m.payload_json,m.occurred_at,j.status
        FROM worker_message_deliveries d JOIN worker_messages m USING(message_id) JOIN jobs j USING(job_id)
        WHERE d.consumer='dona-main' AND d.state='pending' AND d.available_at<=?
        ORDER BY d.available_at,d.created_at,d.delivery_id LIMIT ?`).all(now, limit) as Array<{
          delivery_id:string;message_id:string;job_id:string;source_event_id:string;workspace_id:string|null;channel_id:string|null;thread_ts:string|null;
          kind:WorkerMessageKind;payload_json:string;occurred_at:string;status:JobRow["status"];
        }>;
      let published = 0;
      for (const row of rows) {
        if (terminal(row.status)) {
          this.db.prepare("UPDATE worker_message_deliveries SET state='superseded',updated_at=? WHERE delivery_id=? AND state='pending'").run(now,row.delivery_id);
          this.db.prepare("UPDATE worker_message_cadence SET pending_message_id=NULL,updated_at=? WHERE job_id=? AND pending_message_id=?")
            .run(now,row.job_id,row.message_id);
          continue;
        }
        if (!row.workspace_id || !row.channel_id || !row.thread_ts) continue;
        const report=JSON.parse(row.payload_json) as {severity?:unknown};
        const urgent=row.kind==="question"||row.kind==="decision_request"||(row.kind==="risk"&&report.severity==="high");
        if(!urgent&&row.workspace_id){
          const cadence=this.db.prepare("SELECT minimum_interval_ms,last_delivery_at FROM worker_message_workspace_cadence WHERE workspace_id=?")
            .get(row.workspace_id) as {minimum_interval_ms:number;last_delivery_at:string|null}|undefined;
          if(cadence?.last_delivery_at){
            const availableAt=new Date(Date.parse(cadence.last_delivery_at)+cadence.minimum_interval_ms).toISOString();
            if(availableAt>now){
              this.db.prepare("UPDATE worker_message_deliveries SET available_at=?,updated_at=? WHERE delivery_id=? AND state='pending'")
                .run(availableAt,now,row.delivery_id);
              continue;
            }
          }
        }
        const leaseExpires = new Date(at.getTime()+30_000).toISOString();
        const claimed=this.db.prepare(`UPDATE worker_message_deliveries SET state='leased',lease_owner='dispatcher-worker-message-publisher',lease_token_sha256=?,lease_expires_at=?,fence=fence+1,attempt_count=attempt_count+1,updated_at=?
          WHERE delivery_id=? AND state='pending'`).run(sha256(`${row.delivery_id}:${now}`),leaseExpires,now,row.delivery_id).changes;
        if(claimed!==1)continue;
        const eventId=`evt_${ulid(at.getTime())}`;
        const subject=stableStringify({job_id:row.job_id,message_id:row.message_id});
        const payload=stableStringify({schema_version:1,message_id:row.message_id,job_id:row.job_id,source_event_id:row.source_event_id,kind:row.kind});
        const replyTarget=row.workspace_id&&row.channel_id&&row.thread_ts?stableStringify({kind:"slack_thread",workspace_id:row.workspace_id,channel_id:row.channel_id,thread_ts:row.thread_ts}):null;
        this.db.prepare(`INSERT OR IGNORE INTO events(event_id,schema_version,source,external_event_id,event_type,occurred_at,subject_json,payload_json,reply_target_json,trace_json,status,available_at,created_at,updated_at)
          VALUES(?,1,'dona_message',?,'worker_message_report',?,?,?,?,?,'queued',?,?,?)`).run(eventId,`worker-message:${row.message_id}`,row.occurred_at,subject,payload,replyTarget,
          stableStringify({message_id:row.message_id,job_id:row.job_id}),now,now,now);
        const event=this.db.prepare("SELECT event_id,event_type,payload_json FROM events WHERE source='dona_message' AND external_event_id=?")
          .get(`worker-message:${row.message_id}`) as {event_id:string;event_type:string;payload_json:string};
        if(event.event_type!=="worker_message_report"||event.payload_json!==payload)
          throw new WorkerMessageError("worker_message_event_conflict","internal event identity has a different projection");
        const binding=readEventJobBinding(this.db,row.source_event_id);
        if(binding)insertEventJobBinding(this.db,event.event_id,binding);
        this.db.prepare(`UPDATE worker_message_deliveries SET state='delivered',event_id=?,delivered_at=?,lease_owner=NULL,lease_token_sha256=NULL,lease_expires_at=NULL,updated_at=? WHERE delivery_id=? AND state='leased'`)
          .run(event.event_id,now,now,row.delivery_id);
        this.db.prepare("INSERT OR IGNORE INTO worker_message_receipts(receipt_id,message_id,delivery_id,receipt_kind,consumer,created_at) VALUES(?,?,?,'delivered','dona-main',?)")
          .run(`rcpt_${ulid(at.getTime()).toLowerCase()}`,row.message_id,row.delivery_id,now);
        this.db.prepare("UPDATE worker_message_cadence SET last_delivery_at=?,pending_message_id=CASE WHEN pending_message_id=? THEN NULL ELSE pending_message_id END,updated_at=? WHERE job_id=?")
          .run(now,row.message_id,now,row.job_id);
        if(row.workspace_id)this.recordWorkspaceDelivery(row.workspace_id,now);
        published += 1;
      }
      return published;
    }).immediate();
  }

  publishDueSilenceEvents(limit = 100, at = new Date()): number {
    return this.db.transaction(() => {
      const now=at.toISOString();
      const rows=this.db.prepare(`SELECT c.job_id,c.generation,c.silence_interval_ms,j.source_event_id,j.workspace_id,j.channel_id,j.thread_ts
        FROM worker_message_cadence c JOIN jobs j USING(job_id) WHERE c.silence_due_at<=? AND j.status NOT IN ('completed','failed','cancelled')
        ORDER BY c.silence_due_at,c.job_id LIMIT ?`).all(now,limit) as Array<{job_id:string;generation:number;silence_interval_ms:number;source_event_id:string;workspace_id:string|null;channel_id:string|null;thread_ts:string|null}>;
      for(const row of rows){
        const externalId=`worker-message-silence:${row.job_id}:${row.generation}`;
        const eventId=`evt_${ulid(at.getTime())}`;
        const replyTarget=row.workspace_id&&row.channel_id&&row.thread_ts?stableStringify({kind:"slack_thread",workspace_id:row.workspace_id,channel_id:row.channel_id,thread_ts:row.thread_ts}):null;
        this.db.prepare(`INSERT OR IGNORE INTO events(event_id,schema_version,source,external_event_id,event_type,occurred_at,subject_json,payload_json,reply_target_json,trace_json,status,available_at,created_at,updated_at)
          VALUES(?,1,'dona_message',?,'worker_message_silence',?,?,?,?,?,'queued',?,?,?)`).run(eventId,externalId,now,
          stableStringify({job_id:row.job_id}),stableStringify({schema_version:1,job_id:row.job_id,source_event_id:row.source_event_id,generation:row.generation}),replyTarget,
          stableStringify({job_id:row.job_id,generation:row.generation}),now,now,now);
        const expectedPayload=stableStringify({schema_version:1,job_id:row.job_id,source_event_id:row.source_event_id,generation:row.generation});
        const event=this.db.prepare("SELECT event_id,event_type,payload_json FROM events WHERE source='dona_message' AND external_event_id=?")
          .get(externalId) as {event_id:string;event_type:string;payload_json:string};
        if(event.event_type!=="worker_message_silence"||event.payload_json!==expectedPayload)
          throw new WorkerMessageError("worker_message_event_conflict","silence event identity has a different projection");
        const binding=readEventJobBinding(this.db,row.source_event_id);
        if(binding)insertEventJobBinding(this.db,event.event_id,binding);
        this.db.prepare("UPDATE worker_message_cadence SET silence_due_at=NULL,updated_at=? WHERE job_id=? AND generation=?")
          .run(now,row.job_id,row.generation);
      }
      return rows.length;
    }).immediate();
  }

  purge(at = new Date()): number {
    const cutoff = new Date(at.getTime() - workerMessageRetentionDays * 86_400_000).toISOString();
    return this.db.transaction(() => {
      this.db.prepare(`UPDATE worker_message_deliveries SET state='superseded',lease_owner=NULL,lease_token_sha256=NULL,
        lease_expires_at=NULL,updated_at=? WHERE consumer='worker' AND state IN ('pending','leased') AND message_id IN
        (SELECT m.message_id FROM worker_messages m JOIN jobs j USING(job_id) WHERE j.status IN ('completed','failed','cancelled'))`)
        .run(at.toISOString());
      this.db.prepare(`UPDATE worker_message_cadence SET pending_message_id=NULL,updated_at=? WHERE pending_message_id IN
        (SELECT m.message_id FROM worker_messages m WHERE m.accepted_at<? AND m.job_id IN
          (SELECT job_id FROM jobs WHERE status IN ('completed','failed','cancelled'))
          AND NOT EXISTS (SELECT 1 FROM worker_message_deliveries d WHERE d.message_id=m.message_id AND d.state IN ('pending','leased'))
          AND NOT EXISTS (SELECT 1 FROM worker_messages child WHERE child.correlation_message_id=m.message_id))`)
        .run(at.toISOString(),cutoff);
      return this.db.prepare(`DELETE FROM worker_messages WHERE accepted_at<? AND job_id IN
        (SELECT job_id FROM jobs WHERE status IN ('completed','failed','cancelled'))
        AND NOT EXISTS (SELECT 1 FROM worker_message_deliveries d WHERE d.message_id=worker_messages.message_id AND d.state IN ('pending','leased'))
        AND NOT EXISTS (SELECT 1 FROM worker_messages child WHERE child.correlation_message_id=worker_messages.message_id)`).run(cutoff).changes;
    }).immediate();
  }

  project(row: WorkerMessageRow) {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const safeSummary = typeof payload.summary === "string" ? payload.summary : typeof payload.question === "string" ? payload.question : undefined;
    return { message_id: row.message_id, schema_version: row.schema_version, job_id: row.job_id, source_event_id: row.source_event_id,
      direction: row.direction, kind: row.kind, producer_sequence: row.producer_sequence, correlation_message_id: row.correlation_message_id,
      conversation_revision: row.conversation_revision, occurred_at: row.occurred_at, accepted_at: row.accepted_at,
      ...(safeSummary ? { safe_summary: Array.from(safeSummary).slice(0, 240).join("") } : {}) };
  }

  private getMessageRequired(messageId: string): WorkerMessageRow {
    const row = this.db.prepare("SELECT * FROM worker_messages WHERE message_id=?").get(messageId) as WorkerMessageRow | undefined;
    if (!row) throw new Error(`Worker message ${messageId} disappeared`);
    return row;
  }

  private assertAuthorized(job:JobRow,sourceEventId:string):void {
    const owner=readEventJobBinding(this.db,job.source_event_id)?.owner;
    const caller=sourceEventId===job.source_event_id?owner:readEventJobBinding(this.db,sourceEventId)?.owner;
    if(!owner||!caller||stableStringify(owner)!==stableStringify(caller))
      throw new WorkerMessageError("job_binding_mismatch","source event does not own this job");
  }

  private recordWorkspaceDelivery(workspaceId:string,at:string):void {
    this.db.prepare(`INSERT INTO worker_message_workspace_cadence(workspace_id,last_delivery_at,updated_at) VALUES(?,?,?)
      ON CONFLICT(workspace_id) DO UPDATE SET last_delivery_at=excluded.last_delivery_at,updated_at=excluded.updated_at`).run(workspaceId,at,at);
  }
}

export class WorkerMessagePublisher {
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly repository:WorkerMessageRepository,private readonly wake:()=>void,private readonly pollMs=30_000,
    private readonly onError:(error:unknown)=>void=()=>{}) {}
  start():void { if(this.timer)return; this.runOnce(); this.timer=setInterval(()=>this.runOnce(),this.pollMs); this.timer.unref(); }
  stop():void { if(this.timer)clearInterval(this.timer); this.timer=undefined; }
  runOnce(at=new Date()):void {
    try {
      const published=this.repository.publishPendingReports(100,at);
      const silence=this.repository.publishDueSilenceEvents(100,at);
      this.repository.purge(at);
      if(published+silence>0)this.wake();
    }
    catch(error){this.onError(error);}
  }
}
