import { createHash, randomBytes } from "node:crypto";

import Database from "better-sqlite3";
import { ulid } from "ulid";
import { z } from "zod";

import { insertEventJobBinding, readEventJobBinding } from "./job-routing.js";
import type { JobRow } from "./types.js";
import { jobObjectiveCharacterMax, stableStringify } from "./validation.js";
import { evaluateWorkerDecision, renderWorkerDecisionPost, type WorkerDecisionAction, type WorkerDecisionSibling } from "./worker-decision.js";

export const workerMessageProtocolVersion = 1 as const;
export const workerMessagePayloadUtf8ByteMax = 16_384;
export const workerMessageRetentionDays = 30;
export const workerMessageLeaseMaxMs = 300_000;
export const workerReportMaxPerJob = 256;
const workerMessageOverdueGraceMs = 60_000;

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
  z.object({ kind: z.literal("checkpoint"), summary: safeText, eta_at: utcRfc3339.optional() }).strict(),
  z.object({ kind: z.literal("question"), question: safeText }).strict(),
  z.object({ kind: z.literal("risk"), summary: safeText, severity: z.enum(["low", "medium", "high"]), eta_at: utcRfc3339.optional() }).strict(),
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

export const workerReportSchema = z.object({ ...commonMessage, payload: reportPayload }).strict().superRefine((value, context) => {
  if ((value.payload.kind === "question" || value.payload.kind === "decision_request")
    && value.conversation_revision === Number.MAX_SAFE_INTEGER) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["conversation_revision"],
      message: "must leave room for the correlated answer revision" });
  }
});
export const donaInstructionSchema = z.object({ ...commonMessage, payload: instructionPayload }).strict().superRefine((value, context) => {
  if (value.payload.operation !== "answer") return;
  if (!value.correlation_message_id) context.addIssue({ code:z.ZodIssueCode.custom,path:["correlation_message_id"],
    message:"is required for an answer" });
  if (value.conversation_revision === undefined) context.addIssue({ code:z.ZodIssueCode.custom,path:["conversation_revision"],
    message:"is required for an answer" });
});

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

export interface WorkerInstructionController {
  steer(jobId:string,sourceEventId:string,instruction:string,operationId?:string):Promise<unknown>;
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

    CREATE TABLE IF NOT EXISTS worker_message_runtime_identities (
      message_id               TEXT PRIMARY KEY REFERENCES worker_messages(message_id) ON DELETE CASCADE,
      runtime_identity_sha256  TEXT NOT NULL CHECK (length(runtime_identity_sha256) = 64),
      first_seen_at            TEXT NOT NULL
    );

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

    DROP TRIGGER IF EXISTS worker_message_terminal_worker_deliveries;
    DROP TRIGGER IF EXISTS worker_message_terminal_deliveries;
    CREATE TRIGGER worker_message_terminal_deliveries
    AFTER UPDATE OF status ON jobs
    WHEN NEW.status IN ('completed','failed','cancelled') AND OLD.status <> NEW.status
    BEGIN
      UPDATE worker_message_deliveries
      SET state='superseded',lease_owner=NULL,lease_token_sha256=NULL,lease_expires_at=NULL,updated_at=NEW.updated_at
      WHERE state IN ('pending','leased')
        AND message_id IN (SELECT message_id FROM worker_messages WHERE job_id=NEW.job_id);
      UPDATE worker_message_cadence
      SET pending_message_id=NULL,updated_at=NEW.updated_at
      WHERE job_id=NEW.job_id;
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

    CREATE TABLE IF NOT EXISTS worker_message_decisions (
      message_id             TEXT NOT NULL REFERENCES worker_messages(message_id) ON DELETE CASCADE,
      notification_event_id  TEXT NOT NULL REFERENCES events(event_id),
      job_id                 TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
      action                 TEXT NOT NULL CHECK (action IN ('ack_internal','aggregate_wait','report_to_user','ask_user')),
      reason                 TEXT NOT NULL,
      content_sha256         TEXT NOT NULL CHECK (length(content_sha256) = 64),
      group_sha256           TEXT NOT NULL CHECK (length(group_sha256) = 64),
      group_total            INTEGER NOT NULL,
      safe_projection_json   TEXT,
      decided_at             TEXT NOT NULL,
      PRIMARY KEY(message_id,notification_event_id)
    );
    CREATE INDEX IF NOT EXISTS worker_message_decisions_job_idx ON worker_message_decisions(job_id,decided_at,message_id);
  `);
  const runtimeIdentityColumns=new Set((db.pragma("table_info(worker_message_runtime_identities)") as Array<{name:string}>).map(row=>row.name));
  if(runtimeIdentityColumns.has("job_id"))db.exec(`
    CREATE TABLE worker_message_runtime_identities_v2 (
      message_id TEXT PRIMARY KEY REFERENCES worker_messages(message_id) ON DELETE CASCADE,
      runtime_identity_sha256 TEXT NOT NULL CHECK (length(runtime_identity_sha256) = 64),
      first_seen_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO worker_message_runtime_identities_v2(message_id,runtime_identity_sha256,first_seen_at)
      SELECT m.message_id,r.runtime_identity_sha256,r.first_seen_at
      FROM worker_message_runtime_identities r JOIN worker_messages m ON m.job_id=r.job_id AND m.producer='worker'
      WHERE (SELECT COUNT(*) FROM worker_message_runtime_identities legacy WHERE legacy.job_id=r.job_id)=1;
    DROP TABLE worker_message_runtime_identities;
    ALTER TABLE worker_message_runtime_identities_v2 RENAME TO worker_message_runtime_identities;
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
function typedInstructionText(messageId:string,kind:WorkerMessageKind,payload:unknown,correlationMessageId:string|null,conversationRevision:number|null):string {
  const instruction=stableStringify({schema_version:workerMessageProtocolVersion,message_id:messageId,
    correlation_message_id:correlationMessageId,conversation_revision:conversationRevision,operation:kind,payload});
  return `[DONA_TYPED_INSTRUCTION]\n${instruction}\n[/DONA_TYPED_INSTRUCTION]`;
}

export class WorkerMessageRepository {
  constructor(private readonly db: Database.Database,private readonly jobObjectiveTotalMaxBytes=400_000) {}

  private queuedInstructionReservations(sourceEventId:string):Array<{job_id:string;addition:string}> {
    const rows=this.db.prepare(`SELECT m.message_id,m.job_id,m.kind,m.payload_json,m.correlation_message_id,m.conversation_revision
      FROM worker_messages m JOIN worker_message_deliveries d USING(message_id) JOIN jobs j USING(job_id)
      WHERE j.source_event_id=? AND j.status IN ('queued','retryable_failed') AND m.direction='dona_to_worker'
        AND d.consumer='worker' AND d.state IN ('pending','leased')
        AND NOT EXISTS (SELECT 1 FROM job_steer_receipts r WHERE r.job_id=m.job_id AND r.operation_id=m.message_id)`)
      .all(sourceEventId) as Array<{message_id:string;job_id:string;kind:WorkerMessageKind;payload_json:string;
        correlation_message_id:string|null;conversation_revision:number|null}>;
    return rows.map(row=>({job_id:row.job_id,addition:`\n\n[DONA_FOLLOW_UP]\n${typedInstructionText(row.message_id,row.kind,
      JSON.parse(row.payload_json),row.correlation_message_id,row.conversation_revision)}\n[/DONA_FOLLOW_UP]`}));
  }

  reservedQueuedInstructionBytes(sourceEventId:string):number {
    return this.queuedInstructionReservations(sourceEventId)
      .reduce((sum,row)=>sum+Buffer.byteLength(row.addition,"utf8"),0);
  }

  rearmUndispatchedReport(eventId:string,availableAt:string,at=new Date()):boolean {
    const row=this.db.prepare(`SELECT d.delivery_id,j.status,m.job_id,m.kind,m.payload_json,m.producer_sequence FROM worker_message_deliveries d
      JOIN worker_messages m USING(message_id) JOIN jobs j USING(job_id)
      WHERE d.event_id=? AND d.consumer='dona-main' AND d.state='delivered'`)
      .get(eventId) as {delivery_id:string;status:JobRow["status"];job_id:string;kind:WorkerMessageKind;payload_json:string;producer_sequence:number}|undefined;
    if(!row||terminal(row.status))return false;
    this.db.prepare("DELETE FROM worker_message_receipts WHERE delivery_id=? AND consumer='dona-main' AND receipt_kind='delivered'")
      .run(row.delivery_id);
    const urgent=row.kind==="question"||row.kind==="decision_request"
      ||(row.kind==="risk"&&(JSON.parse(row.payload_json) as {severity?:string}).severity==="high");
    const newer=!urgent&&this.db.prepare(`SELECT 1 FROM worker_messages WHERE job_id=? AND direction='worker_to_dona'
      AND producer_sequence>? LIMIT 1`).get(row.job_id,row.producer_sequence);
    if(newer){
      this.db.prepare(`UPDATE worker_message_deliveries SET state='superseded',event_id=NULL,delivered_at=NULL,updated_at=?
        WHERE delivery_id=? AND event_id=? AND state='delivered'`).run(at.toISOString(),row.delivery_id,eventId);
      return true;
    }
    this.db.prepare(`UPDATE worker_message_deliveries SET state='pending',event_id=NULL,delivered_at=NULL,
      available_at=?,updated_at=? WHERE delivery_id=? AND event_id=? AND state='delivered'`)
      .run(availableAt,at.toISOString(),row.delivery_id,eventId);
    if(!urgent)this.db.prepare("UPDATE worker_message_cadence SET pending_message_id=(SELECT message_id FROM worker_message_deliveries WHERE delivery_id=?),updated_at=? WHERE job_id=?")
      .run(row.delivery_id,at.toISOString(),row.job_id);
    return true;
  }

  appendWorkerReport(jobId: string, runtimeIdentity: string, raw: unknown, at = new Date()) {
    this.assertWorkerRuntime(jobId, runtimeIdentity);
    return this.db.transaction(() => {
      const result=this.appendReport(jobId, raw, at);
      this.db.prepare(`INSERT OR IGNORE INTO worker_message_runtime_identities(message_id,runtime_identity_sha256,first_seen_at)
        VALUES(?,?,?)`).run(result.message.message_id,sha256(runtimeIdentity),at.toISOString());
      return result;
    }).immediate();
  }

  appendReport(jobId: string, raw: unknown, at = new Date()) {
    return this.append(jobId, "worker_to_dona", parseWorkerReport(raw), at);
  }

  appendInstruction(jobId: string, raw: unknown, at = new Date()) {
    const input=parseDonaInstruction(raw);
    const event=this.db.prepare("SELECT source FROM events WHERE event_id=?").get(input.source_event_id) as {source:string}|undefined;
    if(event?.source!=="slack")throw new WorkerMessageError("worker_message_instruction_source_invalid","worker instructions require a Slack source event");
    return this.append(jobId, "dona_to_worker", input, at);
  }

  private append(jobId: string, direction: WorkerMessageDirection, input: WorkerMessageInput, at: Date): { message: WorkerMessageRow; receipt_id: string; outcome: "created" | "reused" } {
    const job = this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow | undefined;
    if (!job) throw new WorkerMessageError("job_not_found", "job does not exist");
    this.assertAuthorized(job, input.source_event_id);
    const producer = direction === "worker_to_dona" ? "worker" : "dona-main";
    const kind = direction === "worker_to_dona" ? reportKind(input as WorkerReportInput) : instructionKind(input as DonaInstructionInput);
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
    if(direction==="dona_to_worker"&&!["queued","retryable_failed","running","blocked"].includes(job.status))
      throw new WorkerMessageError("worker_message_instruction_unavailable",`job in status ${job.status} cannot accept instructions`);
    if(direction==="worker_to_dona"&&["question","decision_request"].includes(kind)
      &&!["queued","retryable_failed","running","blocked"].includes(job.status))
      throw new WorkerMessageError("worker_message_report_unavailable",`job in status ${job.status} cannot accept a question report`);
    if(direction==="worker_to_dona") {
      const reportCount=this.db.prepare("SELECT COUNT(*) AS count FROM worker_messages WHERE job_id=? AND direction='worker_to_dona'")
        .get(jobId) as {count:number};
      if(reportCount.count>=workerReportMaxPerJob)
        throw new WorkerMessageError("worker_message_report_limit_exceeded",`worker report limit of ${workerReportMaxPerJob} has been reached`);
      if(["question","decision_request"].includes(kind)) {
        const pending=this.db.prepare(`SELECT 1 FROM worker_messages question
          JOIN worker_message_deliveries question_delivery ON question_delivery.message_id=question.message_id
          WHERE question.job_id=? AND question.direction='worker_to_dona' AND question.kind IN ('question','decision_request')
            AND question_delivery.consumer='dona-main' AND question_delivery.state!='superseded'
            AND NOT EXISTS (SELECT 1 FROM worker_messages answer
              JOIN worker_message_deliveries answer_delivery ON answer_delivery.message_id=answer.message_id
              WHERE answer.job_id=question.job_id AND answer.direction='dona_to_worker' AND answer.kind='answer'
                AND answer.correlation_message_id=question.message_id AND answer_delivery.consumer='worker'
                AND answer_delivery.state='delivered') LIMIT 1`).get(jobId);
        if(pending)throw new WorkerMessageError("worker_message_question_pending","job already has an unanswered question");
      }
    }
    let correlated:WorkerMessageRow|undefined;
    if (input.correlation_message_id) {
      correlated = this.db.prepare("SELECT * FROM worker_messages WHERE message_id=?").get(input.correlation_message_id) as WorkerMessageRow | undefined;
      if (!correlated || correlated.job_id !== jobId) throw new WorkerMessageError("worker_message_correlation_mismatch", "correlated message is not bound to this job");
    }
    if (direction === "dona_to_worker" && instructionKind(input as DonaInstructionInput) === "answer") {
      if (!correlated || correlated.direction !== "worker_to_dona" || !["question","decision_request"].includes(correlated.kind))
        throw new WorkerMessageError("worker_message_answer_target_invalid", "answer must correlate to a worker question or decision request");
      const expectedRevision=(correlated.conversation_revision ?? 0)+1;
      if (input.conversation_revision !== expectedRevision)
        throw new WorkerMessageError("worker_message_answer_revision_mismatch", `answer revision must be ${expectedRevision}`);
      const answered=this.db.prepare(`SELECT 1 FROM worker_messages answer JOIN worker_message_deliveries delivery ON delivery.message_id=answer.message_id
        WHERE answer.job_id=? AND answer.direction='dona_to_worker' AND answer.kind='answer'
          AND answer.correlation_message_id=? AND delivery.consumer='worker' AND delivery.state!='superseded'`).get(jobId,correlated.message_id);
      if(answered)throw new WorkerMessageError("worker_message_answer_already_exists","correlated question already has an answer");
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
      if(direction==="dona_to_worker"&&["queued","retryable_failed"].includes(job.status)){
        const typed=typedInstructionText(messageId,kind,input.payload,input.correlation_message_id??null,input.conversation_revision??null);
        const addition=`\n\n[DONA_FOLLOW_UP]\n${typed}\n[/DONA_FOLLOW_UP]`;
        const reservations=this.queuedInstructionReservations(job.source_event_id);
        const own=reservations.filter(row=>row.job_id===jobId).map(row=>row.addition).join("");
        if([...job.objective,...own,...addition].length>jobObjectiveCharacterMax)
          throw new WorkerMessageError("worker_message_instruction_unavailable","effective job objective character limit exceeded");
        const siblings=this.db.prepare("SELECT objective FROM jobs WHERE source_event_id=?").all(job.source_event_id) as Array<{objective:string}>;
        const current=siblings.reduce((sum,sibling)=>sum+Buffer.byteLength(sibling.objective,"utf8"),0)
          +reservations.reduce((sum,row)=>sum+Buffer.byteLength(row.addition,"utf8"),0);
        if(current+Buffer.byteLength(addition,"utf8")>this.jobObjectiveTotalMaxBytes)
          throw new WorkerMessageError("worker_message_instruction_unavailable","effective job group objective byte limit exceeded");
      }
      if(direction==="worker_to_dona"&&["question","decision_request"].includes(kind)&&job.status==="blocked"){
        if(job.completion_event_id){
          const attention=this.db.prepare("SELECT status FROM events WHERE event_id=?").get(job.completion_event_id) as {status:string}|undefined;
          if(!attention)throw new WorkerMessageError("worker_message_attention_conflict","blocked attention event is missing");
          if(["dispatching","waiting_agent","blocked","needs_review"].includes(attention.status))
            throw new WorkerMessageError("worker_message_attention_conflict","blocked attention delivery is uncertain");
          if(["queued","retryable_failed"].includes(attention.status)){
            const siblingAttention=this.db.prepare(`SELECT 1 FROM jobs WHERE source_event_id=? AND job_id!=?
              AND status IN ('blocked','failed','needs_review') LIMIT 1`).get(job.source_event_id,jobId);
            if(siblingAttention)throw new WorkerMessageError("worker_message_attention_conflict","group attention includes another job");
            this.db.prepare(`UPDATE events SET status='completed',completed_at=?,updated_at=?,
              last_error_code='worker_message_question_superseded',last_error_message=NULL WHERE event_id=? AND status IN ('queued','retryable_failed')`)
              .run(acceptedAt,acceptedAt,job.completion_event_id);
            this.db.prepare("UPDATE job_groups SET attention_event_id=NULL,updated_at=? WHERE source_event_id=? AND attention_event_id=?")
              .run(acceptedAt,job.source_event_id,job.completion_event_id);
            this.db.prepare("UPDATE jobs SET completion_event_id=NULL,updated_at=? WHERE job_id=? AND completion_event_id=?")
              .run(acceptedAt,jobId,job.completion_event_id);
            this.db.prepare("UPDATE job_completion_results SET notification_state='none' WHERE notification_event_id=? AND notification_state='pending'")
              .run(job.completion_event_id);
          }
          if(["completed","dead_letter"].includes(attention.status)){
            this.db.prepare("UPDATE job_groups SET attention_event_id=NULL,updated_at=? WHERE source_event_id=? AND attention_event_id=?")
              .run(acceptedAt,job.source_event_id,job.completion_event_id);
            this.db.prepare("UPDATE jobs SET completion_event_id=NULL,updated_at=? WHERE job_id=? AND completion_event_id=?")
              .run(acceptedAt,jobId,job.completion_event_id);
          }
        }
        this.db.prepare(`UPDATE jobs SET last_error_code='worker_message_question_pending',
          last_error_message='Background worker is waiting for an answer',updated_at=? WHERE job_id=? AND status='blocked'`)
          .run(acceptedAt,jobId);
      }
      this.db.prepare(`INSERT INTO worker_messages(message_id,schema_version,job_id,source_event_id,workspace_id,channel_id,thread_ts,direction,kind,producer,producer_sequence,idempotency_key,payload_json,payload_sha256,correlation_message_id,conversation_revision,occurred_at,accepted_at)
        VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(messageId, jobId, input.source_event_id, job.workspace_id, job.channel_id, job.thread_ts,
        direction, kind, producer, input.producer_sequence, input.idempotency_key, payloadJson, payloadSha,
        input.correlation_message_id ?? null, input.conversation_revision ?? null, input.occurred_at, acceptedAt);
      this.db.prepare("INSERT INTO worker_message_receipts(receipt_id,message_id,delivery_id,receipt_kind,consumer,created_at) VALUES(?,?,NULL,'accepted','dispatcher',?)")
        .run(receiptId, messageId, acceptedAt);

      let availableAt = acceptedAt;
      if (direction === "worker_to_dona") {
        const silencePrefix=`worker-message-silence:${jobId}:`;
        this.db.prepare(`UPDATE events SET status='completed',completed_at=?,updated_at=?,
          last_error_code='worker_message_silence_superseded',last_error_message=NULL
          WHERE source='dona_message' AND event_type='worker_message_silence'
            AND substr(external_event_id,1,length(?))=?
            AND status IN ('queued','retryable_failed','dispatching','waiting_agent','blocked','needs_review')`)
          .run(acceptedAt,acceptedAt,silencePrefix,silencePrefix);
        const cadence = this.db.prepare("SELECT * FROM worker_message_cadence WHERE job_id=?").get(jobId) as { minimum_interval_ms:number;silence_interval_ms:number;last_delivery_at:string|null;pending_message_id:string|null } | undefined;
        const workspaceCadence=job.workspace_id?this.db.prepare("SELECT * FROM worker_message_workspace_cadence WHERE workspace_id=?").get(job.workspace_id) as
          {minimum_interval_ms:number;last_delivery_at:string|null}|undefined:undefined;
        const minimum = cadence?.minimum_interval_ms ?? 60_000;
        const report = input as WorkerReportInput;
        const urgent = kind === "question" || kind === "decision_request" || (report.payload.kind === "risk" && report.payload.severity === "high");
        if (!urgent && cadence?.last_delivery_at) availableAt = new Date(Math.max(at.getTime(), Date.parse(cadence.last_delivery_at) + minimum)).toISOString();
        if (!urgent && workspaceCadence?.last_delivery_at) availableAt = new Date(Math.max(Date.parse(availableAt),
          Date.parse(workspaceCadence.last_delivery_at)+workspaceCadence.minimum_interval_ms)).toISOString();
        this.db.prepare(`UPDATE worker_message_deliveries SET state='superseded',updated_at=?
          WHERE consumer='dona-main' AND state='pending' AND message_id IN
          (SELECT message_id FROM worker_messages WHERE job_id=? AND direction='worker_to_dona'
            AND (kind='checkpoint' OR (kind='risk' AND json_extract(payload_json,'$.severity')!='high')))`)
          .run(acceptedAt,jobId);
        const silenceInterval = cadence?.silence_interval_ms ?? 900_000;
        this.db.prepare(`INSERT INTO worker_message_cadence(job_id,last_report_at,silence_due_at,pending_message_id,generation,updated_at)
          VALUES(?,?,?,?,1,?) ON CONFLICT(job_id) DO UPDATE SET last_report_at=excluded.last_report_at,silence_due_at=excluded.silence_due_at,
          pending_message_id=excluded.pending_message_id,
          generation=worker_message_cadence.generation+1,updated_at=excluded.updated_at`)
          .run(jobId, acceptedAt, new Date(at.getTime() + silenceInterval).toISOString(), urgent ? null : messageId, acceptedAt);
      }
      const consumer = direction === "worker_to_dona" ? "dona-main" : "worker";
      this.db.prepare(`INSERT INTO worker_message_deliveries(delivery_id,message_id,consumer,state,available_at,lease_owner,lease_token_sha256,lease_expires_at,fence,attempt_count,delivered_at,created_at,updated_at)
        VALUES(?,?,?,'pending',?,NULL,NULL,NULL,0,0,NULL,?,?)`).run(deliveryId, messageId, consumer, availableAt, acceptedAt, acceptedAt);
      if(direction==="worker_to_dona"&&["question","decision_request"].includes(kind)&&job.status==="running"){
        const changed=this.db.prepare(`UPDATE jobs SET status='blocked',last_error_code='worker_message_question_pending',
          last_error_message='Background worker is waiting for an answer',updated_at=? WHERE job_id=? AND status='running'`)
          .run(acceptedAt,jobId).changes;
        if(changed!==1)throw new WorkerMessageError("worker_message_job_state_changed","job state changed while accepting the question report");
      }
      return { message: this.getMessageRequired(messageId), receipt_id: receiptId, outcome: "created" as const };
    }).immediate();
  }

  getMessage(jobId: string, messageId: string, sourceEventId: string): WorkerMessageRow | undefined {
    const job=this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow|undefined;
    if(!job)return undefined;
    this.assertAuthorized(job,sourceEventId);
    const message=this.db.prepare("SELECT * FROM worker_messages WHERE job_id=? AND message_id=?")
      .get(jobId, messageId) as WorkerMessageRow | undefined;
    if(message?.direction==="worker_to_dona"){
      const delivery=this.db.prepare("SELECT event_id FROM worker_message_deliveries WHERE message_id=? AND consumer='dona-main'")
        .get(messageId) as {event_id:string|null}|undefined;
      if(!delivery?.event_id||delivery.event_id!==sourceEventId)
        throw new WorkerMessageError("job_binding_mismatch","source event is not the notification event for this message");
      if(terminal(job.status))
        throw new WorkerMessageError("worker_message_terminal_fence","worker report is stale after terminal job state");
      if(["question","decision_request"].includes(message.kind)
        &&!["queued","retryable_failed","running","blocked"].includes(job.status))
        throw new WorkerMessageError("worker_message_report_unavailable","question can no longer receive an answer");
    }
    return message;
  }

  decideReport(jobId:string,messageId:string,notificationEventId:string,at=new Date()) {
    return this.db.transaction(()=>{
      const job=this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow|undefined;
      if(!job)throw new WorkerMessageError("job_not_found","job does not exist");
      this.assertAuthorized(job,notificationEventId);
      const message=this.db.prepare("SELECT * FROM worker_messages WHERE job_id=? AND message_id=?")
        .get(jobId,messageId) as WorkerMessageRow|undefined;
      if(!message||message.direction!=="worker_to_dona")
        throw new WorkerMessageError("job_binding_mismatch","notification does not own this worker report");
      const delivery=this.db.prepare("SELECT event_id FROM worker_message_deliveries WHERE message_id=? AND consumer='dona-main'")
        .get(messageId) as {event_id:string|null}|undefined;
      if(delivery?.event_id!==notificationEventId)
        throw new WorkerMessageError("job_binding_mismatch","notification does not own this delivery");
      const existing=this.db.prepare("SELECT * FROM worker_message_decisions WHERE message_id=? AND notification_event_id=?")
        .get(messageId,notificationEventId) as {message_id:string;notification_event_id:string;action:WorkerDecisionAction;reason:string;
          content_sha256:string;group_sha256:string;group_total:number;safe_projection_json:string|null;decided_at:string}|undefined;
      const project=(row:NonNullable<typeof existing>)=>({message_id:row.message_id,job_id:jobId,
        notification_event_id:row.notification_event_id,action:row.action,reason:row.reason,
        content_sha256:row.content_sha256,group_sha256:row.group_sha256,group_total:row.group_total,
        ...(row.safe_projection_json?(()=>{const safe_projection=JSON.parse(row.safe_projection_json) as NonNullable<ReturnType<typeof evaluateWorkerDecision>["safe_projection"]>;
          const post_text=renderWorkerDecisionPost(safe_projection);
          return {safe_projection,post_text,post_body_sha256:sha256(post_text)};})():{}),decided_at:row.decided_at});
      if(existing)return project(existing);
      if(terminal(job.status)===false&&job.status!=="needs_review"&&job.status!=="cancelling")
        this.getMessage(jobId,messageId,notificationEventId);
      const event=this.db.prepare("SELECT status FROM events WHERE event_id=? AND source='dona_message' AND event_type='worker_message_report'")
        .get(notificationEventId) as {status:string}|undefined;
      if(!event||!["dispatching","waiting_agent"].includes(event.status))
        throw new WorkerMessageError("worker_message_report_unavailable","notification is no longer active");
      const group=this.db.prepare("SELECT job_id,status FROM jobs WHERE source_event_id=? ORDER BY job_id LIMIT 33")
        .all(job.source_event_id) as WorkerDecisionSibling[];
      const total=(this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE source_event_id=?")
        .get(job.source_event_id) as {count:number}).count;
      if(!group.some(row=>row.job_id===jobId))
        throw new WorkerMessageError("job_binding_mismatch","report job is absent from its group");
      const previous=this.db.prepare(`SELECT d.action,d.content_sha256,d.decided_at,
          json_extract(m.payload_json,'$.severity') AS severity
        FROM worker_message_decisions d JOIN worker_messages m USING(message_id)
        WHERE d.job_id=? AND m.producer_sequence<? AND m.producer='worker'
        ORDER BY m.producer_sequence DESC,d.decided_at DESC,d.notification_event_id DESC LIMIT 1`).get(jobId,message.producer_sequence) as
        {action:WorkerDecisionAction;content_sha256:string;decided_at:string;severity:string|null}|undefined;
      const lastEta=this.db.prepare(`SELECT json_extract(payload_json,'$.eta_at') AS eta_at FROM worker_messages
        WHERE job_id=? AND direction='worker_to_dona' AND producer_sequence<?
          AND json_type(payload_json,'$.eta_at')='text'
        ORDER BY producer_sequence DESC LIMIT 1`).get(jobId,message.producer_sequence) as {eta_at:string}|undefined;
      const lastRisk=this.db.prepare(`SELECT json_extract(m.payload_json,'$.severity') AS severity FROM worker_messages m
        JOIN worker_message_decisions d ON d.message_id=m.message_id AND d.action='report_to_user'
        JOIN events e ON e.event_id=d.notification_event_id AND e.status='completed'
        WHERE m.job_id=? AND m.direction='worker_to_dona' AND m.kind='risk' AND m.producer_sequence<?
        ORDER BY m.producer_sequence DESC,d.decided_at DESC LIMIT 1`).get(jobId,message.producer_sequence) as {severity:string}|undefined;
      const answered=this.db.prepare(`SELECT 1 FROM worker_messages answer JOIN worker_message_deliveries delivery
        ON delivery.message_id=answer.message_id WHERE answer.job_id=? AND answer.direction='dona_to_worker'
        AND answer.kind='answer' AND answer.correlation_message_id=? AND delivery.consumer='worker'
        AND delivery.state!='superseded' LIMIT 1`).get(jobId,messageId)!==undefined;
      const firstReport=this.db.prepare("SELECT MIN(accepted_at) AS at FROM worker_messages WHERE job_id=? AND direction='worker_to_dona'")
        .get(jobId) as {at:string|null};
      const lastUserDecision=this.db.prepare(`SELECT MAX(d.decided_at) AS at FROM worker_message_decisions d
        JOIN worker_messages m USING(message_id)
        JOIN events e ON e.event_id=d.notification_event_id AND e.status='completed'
        WHERE d.job_id=? AND m.producer_sequence<?
        AND d.action IN ('report_to_user','ask_user')`).get(jobId,message.producer_sequence) as {at:string|null};
      const payload=JSON.parse(message.payload_json) as {kind:"checkpoint"|"question"|"risk"|"decision_request";
        summary?:string;question?:string;severity?:"low"|"medium"|"high";options?:string[];eta_at?:string};
      const cadence=this.db.prepare("SELECT silence_interval_ms FROM worker_message_cadence WHERE job_id=?")
        .get(jobId) as {silence_interval_ms:number}|undefined;
      const decision=evaluateWorkerDecision({report:{message_id:messageId,job_id:jobId,kind:payload.kind,
        sequence:message.producer_sequence,accepted_at:message.accepted_at,text:payload.question??payload.summary??"",
        ...(payload.severity?{severity:payload.severity}:{}),...(payload.options?{options:payload.options}:{}),
        ...(payload.eta_at?{eta_at:payload.eta_at}:{})},siblings:group,total_jobs:total,
        ...(previous?{previous:{action:previous.action,content_sha256:previous.content_sha256,decided_at:previous.decided_at,
          ...(previous.severity?{severity:previous.severity}:{})}}:{}),
        ...(lastEta?.eta_at?{last_eta_at:lastEta.eta_at}:{}),
        ...(lastRisk?.severity?{last_risk_severity:lastRisk.severity}:{}),answered,
        ...(firstReport.at?{first_report_at:firstReport.at}:{}),
        ...(lastUserDecision.at?{last_user_decision_at:lastUserDecision.at}:{}),
        now:at.toISOString(),silence_interval_ms:cadence?.silence_interval_ms??900_000});
      const groupHash=sha256(stableStringify({total,jobs:group}));
      this.db.prepare(`INSERT INTO worker_message_decisions(message_id,notification_event_id,job_id,action,reason,
        content_sha256,group_sha256,group_total,safe_projection_json,decided_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(messageId,notificationEventId,jobId,decision.action,decision.reason,decision.content_sha256,
          groupHash,total,decision.safe_projection?stableStringify(decision.safe_projection):null,at.toISOString());
      return project(this.db.prepare("SELECT * FROM worker_message_decisions WHERE message_id=? AND notification_event_id=?")
        .get(messageId,notificationEventId) as NonNullable<typeof existing>);
    }).immediate();
  }

  decisionCurrent(jobId:string,messageId:string,notificationEventId:string) {
    return this.db.transaction(()=>{
    const job=this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow|undefined;
    if(!job)throw new WorkerMessageError("job_not_found","job does not exist");
    this.assertAuthorized(job,notificationEventId);
    const decision=this.db.prepare(`SELECT d.action,d.group_sha256 FROM worker_message_decisions d
      JOIN worker_message_deliveries delivery ON delivery.message_id=d.message_id
      WHERE d.job_id=? AND d.message_id=? AND d.notification_event_id=?
        AND delivery.event_id=? AND delivery.consumer='dona-main'`)
      .get(jobId,messageId,notificationEventId,notificationEventId) as
      {action:WorkerDecisionAction;group_sha256:string}|undefined;
    if(!decision)throw new WorkerMessageError("job_binding_mismatch","notification has no bound decision");
    const event=this.db.prepare("SELECT status FROM events WHERE event_id=? AND source='dona_message' AND event_type='worker_message_report'")
      .get(notificationEventId) as {status:string}|undefined;
    if(!event||!["dispatching","waiting_agent"].includes(event.status))return {current:false,reason:"notification_inactive"};
    if(terminal(job.status)||job.status==="needs_review"||job.status==="cancelling")return {current:false,reason:"job_inactive"};
    if(decision.action==="ask_user"&&this.db.prepare(`SELECT 1 FROM worker_messages answer
      JOIN worker_message_deliveries delivery ON delivery.message_id=answer.message_id
      WHERE answer.job_id=? AND answer.direction='dona_to_worker' AND answer.kind='answer'
        AND answer.correlation_message_id=? AND delivery.consumer='worker' AND delivery.state!='superseded' LIMIT 1`)
      .get(jobId,messageId)!==undefined)return {current:false,reason:"answered"};
    const group=this.db.prepare("SELECT job_id,status FROM jobs WHERE source_event_id=? ORDER BY job_id LIMIT 33")
      .all(job.source_event_id) as WorkerDecisionSibling[];
    const total=(this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE source_event_id=?")
      .get(job.source_event_id) as {count:number}).count;
    if(decision.action!=="ask_user"&&sha256(stableStringify({total,jobs:group}))!==decision.group_sha256)
      return {current:false,reason:"group_changed"};
    if(group.some(row=>(row.status==="blocked"&&!(decision.action==="ask_user"&&row.job_id===jobId))
      ||row.status==="failed"||row.status==="needs_review"))
      return {current:false,reason:"group_attention"};
    return {current:decision.action==="ask_user"||decision.action==="report_to_user",
      reason:decision.action==="ask_user"||decision.action==="report_to_user"?"current":"internal_decision"};
    }).deferred();
  }

  pendingQuestion(jobId: string) {
    const rows=this.db.prepare(`SELECT m.message_id,m.kind,m.payload_json,
        COALESCE((SELECT MAX(next.producer_sequence) FROM worker_messages next WHERE next.job_id=m.job_id AND next.producer='dona-main'),0)+1 AS next_producer_sequence,
        COALESCE(m.conversation_revision,0)+1 AS next_conversation_revision
      FROM worker_messages m JOIN worker_message_deliveries d ON d.message_id=m.message_id JOIN jobs j ON j.job_id=m.job_id
      WHERE m.job_id=? AND m.direction='worker_to_dona' AND m.kind IN ('question','decision_request') AND d.consumer='dona-main'
        AND d.state='delivered' AND j.status IN ('queued','retryable_failed','running','blocked')
        AND NOT EXISTS (SELECT 1 FROM worker_messages answer JOIN worker_message_deliveries answer_delivery ON answer_delivery.message_id=answer.message_id
          WHERE answer.job_id=m.job_id AND answer.direction='dona_to_worker' AND answer.kind='answer'
            AND answer.correlation_message_id=m.message_id AND answer_delivery.consumer='worker' AND answer_delivery.state!='superseded')
      ORDER BY m.producer_sequence DESC,m.message_id DESC LIMIT 4`).all(jobId) as Array<
        {message_id:string;kind:"question"|"decision_request";payload_json:string;next_producer_sequence:number;next_conversation_revision:number}>;
    if(rows.length>1)return {ambiguous:true,pending_count_at_least:rows.length,candidates:rows.map(({payload_json,...row})=>({
      ...row,question:(JSON.parse(payload_json) as {question:string}).question,
    }))};
    const row=rows[0];
    return row ? {ambiguous:false,message_id:row.message_id,kind:row.kind,next_producer_sequence:row.next_producer_sequence,
      next_conversation_revision:row.next_conversation_revision} : undefined;
  }

  supersedeUndeliveredInstructions(jobId:string,at=new Date().toISOString()):number {
    return this.db.prepare(`UPDATE worker_message_deliveries SET state='superseded',lease_owner=NULL,lease_token_sha256=NULL,
      lease_expires_at=NULL,updated_at=? WHERE consumer='worker' AND state IN ('pending','leased')
      AND message_id IN (SELECT message_id FROM worker_messages WHERE job_id=? AND direction='dona_to_worker')`).run(at,jobId).changes;
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
          AND NOT EXISTS (
            SELECT 1 FROM worker_messages prior JOIN worker_message_deliveries prior_delivery USING(message_id)
            WHERE prior.job_id=m.job_id AND prior.producer=m.producer AND prior.producer_sequence<m.producer_sequence
              AND prior_delivery.consumer=d.consumer AND prior_delivery.state IN ('pending','leased')
          )
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

  claimWorker(jobId:string,sourceEventId:string,runtimeIdentity:string,leaseOwner:string,limit:number,leaseMs:number,at=new Date()) {
    this.assertWorkerRuntime(jobId,runtimeIdentity);
    return this.claim(jobId,sourceEventId,"worker",leaseOwner,limit,leaseMs,at);
  }

  claimNextWorkerInstruction(leaseOwner:string,leaseMs:number,at=new Date()) {
    const now=at.toISOString();
    this.db.prepare(`UPDATE worker_message_deliveries SET state='pending',lease_owner=NULL,lease_token_sha256=NULL,
      lease_expires_at=NULL,updated_at=? WHERE consumer='worker' AND state='leased' AND lease_expires_at<=?`).run(now,now);
    const candidate=this.db.prepare(`SELECT m.job_id,m.source_event_id FROM worker_message_deliveries d
      JOIN worker_messages m USING(message_id) JOIN jobs j USING(job_id)
      WHERE d.consumer='worker' AND d.state='pending' AND d.available_at<=?
        AND j.status IN ('queued','retryable_failed','running','blocked')
        AND NOT EXISTS (
          SELECT 1 FROM worker_messages prior JOIN worker_message_deliveries prior_delivery USING(message_id)
          WHERE prior.job_id=m.job_id AND prior.producer=m.producer AND prior.producer_sequence<m.producer_sequence
            AND prior_delivery.consumer=d.consumer AND prior_delivery.state IN ('pending','leased')
        )
      ORDER BY d.available_at,d.created_at,m.job_id,m.producer_sequence,d.delivery_id LIMIT 1`)
      .get(now) as {job_id:string;source_event_id:string}|undefined;
    return candidate ? this.claim(candidate.job_id,candidate.source_event_id,"worker",leaseOwner,1,leaseMs,at)[0] : undefined;
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

  acknowledgeWorker(jobId: string, sourceEventId: string, runtimeIdentity:string, deliveryId: string, leaseOwner: string, leaseToken: string, fence: number, at = new Date()) {
    this.assertWorkerRuntime(jobId,runtimeIdentity);
    const row = this.db.prepare("SELECT consumer FROM worker_message_deliveries WHERE delivery_id=?")
      .get(deliveryId) as {consumer:WorkerMessageDeliveryRow["consumer"]}|undefined;
    if (row && row.consumer !== "worker") throw new WorkerMessageError("delivery_consumer_mismatch", "worker bridge cannot acknowledge this delivery");
    return this.acknowledge(jobId,sourceEventId,deliveryId,leaseOwner,leaseToken,fence,at);
  }

  reconcileWorker(jobId:string,sourceEventId:string,runtimeIdentity:string,idempotencyKey:string) {
    this.assertWorkerReconciliationRuntime(jobId,runtimeIdentity,idempotencyKey);
    return this.reconcile(jobId,sourceEventId,"worker",idempotencyKey);
  }

  operationalSnapshot(at = new Date()) {
    const pending = this.db.prepare("SELECT COUNT(*) AS count FROM worker_message_deliveries WHERE state IN ('pending','leased')").get() as {count:number};
    const overdue = this.db.prepare("SELECT COUNT(*) AS count FROM worker_message_deliveries WHERE state='pending' AND available_at<=?")
      .get(new Date(at.getTime()-workerMessageOverdueGraceMs).toISOString()) as {count:number};
    const expired = this.db.prepare("SELECT COUNT(*) AS count FROM worker_message_deliveries WHERE state='leased' AND lease_expires_at<=?").get(at.toISOString()) as {count:number};
    const dueSilence = this.db.prepare(`SELECT COUNT(*) AS count FROM worker_message_cadence c JOIN jobs j USING(job_id)
      WHERE c.silence_due_at<=? AND j.status NOT IN ('completed','failed','cancelled','needs_review')
        AND NOT (j.status='blocked' AND j.last_error_code='worker_message_question_pending')`).get(at.toISOString()) as {count:number};
    return { protocol_version: workerMessageProtocolVersion, pending_deliveries: pending.count, overdue_deliveries: overdue.count,
      expired_leases: expired.count, due_silence_deadlines: dueSilence.count, degraded: expired.count > 0 || overdue.count > 0 };
  }

  publishPendingReports(limit = 100, at = new Date()): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new WorkerMessageError("invalid_publish_limit", "publish limit must be between 1 and 100");
    return this.db.transaction(() => {
      const now = at.toISOString();
      this.db.prepare(`UPDATE worker_message_deliveries SET state='pending',lease_owner=NULL,lease_token_sha256=NULL,lease_expires_at=NULL,updated_at=?
        WHERE consumer='dona-main' AND state='leased' AND lease_expires_at<=?`).run(now, now);
      this.db.prepare(`UPDATE worker_message_deliveries SET state='superseded',lease_owner=NULL,lease_token_sha256=NULL,
        lease_expires_at=NULL,updated_at=? WHERE consumer='dona-main' AND state IN ('pending','leased') AND message_id IN
        (SELECT m.message_id FROM worker_messages m JOIN jobs j USING(job_id) WHERE j.status IN ('completed','failed','cancelled','needs_review'))`)
        .run(now);
      this.db.prepare(`UPDATE worker_message_cadence SET pending_message_id=NULL,updated_at=? WHERE pending_message_id IN
        (SELECT m.message_id FROM worker_messages m JOIN jobs j USING(job_id) WHERE j.status IN ('completed','failed','cancelled','needs_review'))`)
        .run(now);
      const rows = this.db.prepare(`SELECT d.delivery_id,d.message_id,m.job_id,m.source_event_id,m.workspace_id,m.channel_id,m.thread_ts,m.kind,m.payload_json,m.occurred_at,j.status
        FROM worker_message_deliveries d JOIN worker_messages m USING(message_id) JOIN jobs j USING(job_id)
        WHERE d.consumer='dona-main' AND d.state='pending' AND d.available_at<=?
          AND j.status NOT IN ('completed','failed','cancelled','needs_review')
          AND m.workspace_id IS NOT NULL AND m.channel_id IS NOT NULL AND m.thread_ts IS NOT NULL
        ORDER BY d.available_at,d.created_at,m.job_id,m.producer_sequence,d.delivery_id LIMIT ?`).all(now, limit) as Array<{
          delivery_id:string;message_id:string;job_id:string;source_event_id:string;workspace_id:string|null;channel_id:string|null;thread_ts:string|null;
          kind:WorkerMessageKind;payload_json:string;occurred_at:string;status:JobRow["status"];
        }>;
      let published = 0;
      for (const row of rows) {
        if (terminal(row.status)||row.status==='needs_review') {
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
        const claimedDelivery=this.db.prepare("SELECT fence FROM worker_message_deliveries WHERE delivery_id=?").get(row.delivery_id) as {fence:number};
        const externalId=`worker-message:${row.message_id}${claimedDelivery.fence===1?"":`:${claimedDelivery.fence}`}`;
        const subject=stableStringify({job_id:row.job_id,message_id:row.message_id});
        const payload=stableStringify({schema_version:1,message_id:row.message_id,job_id:row.job_id,source_event_id:row.source_event_id,kind:row.kind});
        const replyTarget=row.workspace_id&&row.channel_id&&row.thread_ts?stableStringify({kind:"slack_thread",workspace_id:row.workspace_id,channel_id:row.channel_id,thread_ts:row.thread_ts}):null;
        this.db.prepare(`INSERT OR IGNORE INTO events(event_id,schema_version,source,external_event_id,event_type,occurred_at,subject_json,payload_json,reply_target_json,trace_json,status,available_at,created_at,updated_at)
          VALUES(?,1,'dona_message',?,'worker_message_report',?,?,?,?,?,'queued',?,?,?)`).run(eventId,externalId,row.occurred_at,subject,payload,replyTarget,
          stableStringify({message_id:row.message_id,job_id:row.job_id}),now,now,now);
        const event=this.db.prepare("SELECT event_id,event_type,payload_json FROM events WHERE source='dona_message' AND external_event_id=?")
          .get(externalId) as {event_id:string;event_type:string;payload_json:string};
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
        FROM worker_message_cadence c JOIN jobs j USING(job_id) WHERE c.silence_due_at<=? AND j.status NOT IN ('completed','failed','cancelled','needs_review')
          AND NOT (j.status='blocked' AND j.last_error_code='worker_message_question_pending')
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

  silenceEventState(jobId:string,eventId:string):{worker_message_silence:{event_id:string,event_generation:number,current_generation:number,current:boolean}}|undefined {
    const event=this.db.prepare("SELECT status,payload_json FROM events WHERE event_id=? AND source='dona_message' AND event_type='worker_message_silence'")
      .get(eventId) as {status:string;payload_json:string}|undefined;
    if(!event)return undefined;
    let payload:unknown;
    try {payload=JSON.parse(event.payload_json);} catch {return undefined;}
    if(!payload||typeof payload!=="object"||Array.isArray(payload))return undefined;
    const projected=payload as {job_id?:unknown;generation?:unknown};
    if(projected.job_id!==jobId||!Number.isSafeInteger(projected.generation))return undefined;
    const cadence=this.db.prepare("SELECT generation FROM worker_message_cadence WHERE job_id=?").get(jobId) as {generation:number}|undefined;
    const job=this.db.prepare("SELECT status,last_error_code FROM jobs WHERE job_id=?").get(jobId) as Pick<JobRow,"status"|"last_error_code">|undefined;
    const currentGeneration=cadence?.generation ?? 0,eventGeneration=projected.generation as number;
    return {worker_message_silence:{event_id:eventId,event_generation:eventGeneration,current_generation:currentGeneration,
      current:event.status==="waiting_agent"&&eventGeneration===currentGeneration&&!!job&&!terminal(job.status)&&job.status!=="needs_review"
        &&!(job.status==="blocked"&&job.last_error_code==="worker_message_question_pending")}};
  }

  purge(at = new Date()): number {
    const cutoff = new Date(at.getTime() - workerMessageRetentionDays * 86_400_000).toISOString();
    return this.db.transaction(() => {
      this.db.prepare(`UPDATE worker_message_deliveries SET state='superseded',lease_owner=NULL,lease_token_sha256=NULL,
        lease_expires_at=NULL,updated_at=? WHERE state IN ('pending','leased') AND message_id IN
        (SELECT m.message_id FROM worker_messages m JOIN jobs j USING(job_id) WHERE j.status IN ('completed','failed','cancelled'))`)
        .run(at.toISOString());
      this.db.prepare(`UPDATE worker_message_cadence SET pending_message_id=NULL,updated_at=? WHERE pending_message_id IN
        (SELECT m.message_id FROM worker_messages m JOIN jobs j USING(job_id) WHERE j.status IN ('completed','failed','cancelled'))`)
        .run(at.toISOString());
      this.db.prepare(`UPDATE worker_message_cadence SET pending_message_id=NULL,updated_at=? WHERE pending_message_id IN
        (SELECT m.message_id FROM worker_messages m WHERE m.accepted_at<? AND m.job_id IN
          (SELECT job_id FROM jobs WHERE status IN ('completed','failed','cancelled'))
          AND NOT EXISTS (SELECT 1 FROM worker_message_deliveries d WHERE d.message_id=m.message_id AND d.state IN ('pending','leased'))
          AND NOT EXISTS (SELECT 1 FROM worker_messages child WHERE child.correlation_message_id=m.message_id))`)
        .run(at.toISOString(),cutoff);
      const deleted=this.db.prepare(`DELETE FROM worker_messages WHERE accepted_at<? AND job_id IN
        (SELECT job_id FROM jobs WHERE status IN ('completed','failed','cancelled'))
        AND NOT EXISTS (SELECT 1 FROM worker_message_deliveries d WHERE d.message_id=worker_messages.message_id AND d.state IN ('pending','leased'))
        AND NOT EXISTS (SELECT 1 FROM worker_messages child WHERE child.correlation_message_id=worker_messages.message_id)`).run(cutoff).changes;
      return deleted;
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

  private assertWorkerRuntime(jobId:string,runtimeIdentity:string):void {
    if(typeof runtimeIdentity!=="string"||runtimeIdentity.length<1||runtimeIdentity.length>512)
      throw new WorkerMessageError("worker_runtime_mismatch","worker runtime identity is invalid");
    const identity=this.db.prepare("SELECT herdr_agent_session_id FROM job_live_session_identities WHERE job_id=?")
      .get(jobId) as {herdr_agent_session_id:string}|undefined;
    if(!identity||identity.herdr_agent_session_id!==runtimeIdentity)
      throw new WorkerMessageError("worker_runtime_mismatch","worker runtime identity does not own this job");
  }

  private assertWorkerReconciliationRuntime(jobId:string,runtimeIdentity:string,idempotencyKey:string):void {
    if(typeof runtimeIdentity!=="string"||runtimeIdentity.length<1||runtimeIdentity.length>512)
      throw new WorkerMessageError("worker_runtime_mismatch","worker runtime identity is invalid");
    const historical=this.db.prepare(`SELECT 1 FROM worker_messages m JOIN worker_message_runtime_identities r USING(message_id)
      WHERE m.job_id=? AND m.producer='worker' AND m.idempotency_key=? AND r.runtime_identity_sha256=?`)
      .get(jobId,idempotencyKey,sha256(runtimeIdentity));
    if(historical)return;
    const existing=this.db.prepare("SELECT 1 FROM worker_messages WHERE job_id=? AND producer='worker' AND idempotency_key=?")
      .get(jobId,idempotencyKey);
    if(existing)throw new WorkerMessageError("worker_runtime_mismatch","worker runtime identity does not own this job");
    this.assertWorkerRuntime(jobId,runtimeIdentity);
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

export class WorkerInstructionBridge {
  private timer:NodeJS.Timeout|undefined;
  private operation:Promise<void>|undefined;
  private stopping=false;
  private readonly leaseOwner="dispatcher-worker-instruction-bridge";
  constructor(private readonly repository:WorkerMessageRepository,private readonly controller:WorkerInstructionController,
    private readonly pollMs=1_000,private readonly onError:(error:unknown)=>void=()=>{},
    private readonly onDelivered:()=>void=()=>{}) {}
  start():void {
    if(this.timer)return;
    this.stopping=false;
    this.run();
    this.timer=setInterval(()=>this.run(),this.pollMs);
    this.timer.unref();
  }
  beginShutdown():void {
    this.stopping=true;
    if(this.timer)clearInterval(this.timer);
    this.timer=undefined;
  }
  async stop():Promise<void> {
    this.beginShutdown();
    await this.operation;
  }
  async runOnce(at=new Date()):Promise<boolean> {
    const claimed=this.repository.claimNextWorkerInstruction(this.leaseOwner,workerMessageLeaseMaxMs,at);
    if(!claimed)return false;
    const {delivery,lease_token}=claimed;
    await this.controller.steer(delivery.job_id,delivery.source_event_id,
      typedInstructionText(delivery.message_id,delivery.kind,delivery.payload,delivery.correlation_message_id,delivery.conversation_revision),delivery.message_id);
    this.repository.acknowledge(delivery.job_id,delivery.source_event_id,delivery.delivery_id,this.leaseOwner,
      lease_token,delivery.fence,new Date());
    this.onDelivered();
    return true;
  }
  private run():void {
    if(this.operation)return;
    const operation=(async()=>{while(!this.stopping&&await this.runOnce());})().catch(error=>this.onError(error));
    this.operation=operation;
    void operation.finally(()=>{if(this.operation===operation)this.operation=undefined;});
  }
}
