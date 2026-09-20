import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { auditEventSchema } from "../audit/codec.js";
import { assertSynchronousResult } from "../audit/synchronous.js";
import { decodeApprovalSnapshot, type ApprovalSourceContext } from "./snapshot.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const utc = z.string().max(24).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const scopeSchema = z.strictObject({ instance_id: id, workspace_id: id });
export type ApprovalRecordScope = z.infer<typeof scopeSchema>;
export const maximumApprovalRecordBytes = 512 * 1024 + 8192;
const request = z.strictObject({
  request_id: id, instance_id: id, workspace_id: id, creation_key: digest,
  snapshot_json: z.string().max(262144), semantic_hash: digest, binding_id: id, binding_revision: positive,
  policy_revision: positive, model_version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/),
  state: z.enum(["requested", "delivery_pending", "delivery_unknown", "sent", "approved", "rejected", "cancelled", "expired",
    "delivery_failed", "consumed", "execution_cancelled", "consume_expired", "needs_review"]),
  revision: positive, created_at: utc, expires_at: utc, consume_expires_at: utc.nullable(), clock_transaction_id: id,
}).superRefine((row, ctx) => {
  const elapsed = Date.parse(row.expires_at) - Date.parse(row.created_at);
  const needsConsumeExpiry = ["approved", "consumed", "execution_cancelled", "consume_expired"].includes(row.state);
  if (elapsed <= 0 || elapsed > 15 * 60000 || (needsConsumeExpiry && row.consume_expires_at === null)
    || (!needsConsumeExpiry && row.state !== "needs_review" && row.consume_expires_at !== null)) ctx.addIssue({ code: "custom", message: "record_invalid" });
  if (row.consume_expires_at !== null && (Date.parse(row.consume_expires_at) <= Date.parse(row.created_at)
    || Date.parse(row.consume_expires_at) > Date.parse(row.expires_at) + 5 * 60000)) ctx.addIssue({ code: "custom", message: "record_invalid" });
});
const decision = z.strictObject({ decision_id: id, request_id: id, instance_id: id, workspace_id: id, semantic_hash: digest,
  binding_id: id, binding_revision: positive, kind: z.enum(["approve", "reject", "cancel", "expire"]),
  actor_kind: z.enum(["supervisor", "requester", "system"]), actor_id: id, presentation_revision: positive.nullable(),
  decided_at: utc, clock_transaction_id: id,
}).superRefine((row, ctx) => {
  if (row.kind === "approve" || row.kind === "reject" ? row.actor_kind !== "supervisor" || row.presentation_revision === null
    : row.actor_kind !== (row.kind === "cancel" ? "requester" : "system")) ctx.addIssue({ code: "custom", message: "record_invalid" });
});
const consume = z.strictObject({ consume_id: id, request_id: id, decision_id: id, decision_kind: z.literal("approve"),
  attempt_id: id, claimed_at: utc, clock_transaction_id: id });
const execution = z.strictObject({ attempt_id: id, request_id: id, consume_id: id,
  state: z.enum(["claimed", "executing", "succeeded", "failed", "acceptance_unknown", "needs_review"]),
  fence: positive, claimed_at: utc, execution_expires_at: utc, payload_expires_at: utc,
  receipt_ref: id.nullable(), failure_code: auditEventSchema.shape.reason.exclude(["none"]).nullable(), clock_transaction_id: id,
}).superRefine((row, ctx) => {
  const claimed = Date.parse(row.claimed_at), executionExpiry = Date.parse(row.execution_expires_at), payloadExpiry = Date.parse(row.payload_expires_at);
  if (executionExpiry <= claimed || payloadExpiry < executionExpiry || payloadExpiry > claimed + 24 * 3600000)
    ctx.addIssue({ code: "custom", message: "record_invalid" });
});
const notification = z.strictObject({ notification_attempt_id: id, request_id: id, kind: z.enum(["approval_card", "pending_notice"]),
  state: z.enum(["pending", "dispatching", "sent", "failed", "acceptance_unknown", "needs_review", "aborted"]),
  request_revision: positive, presentation_revision: positive, marker_mac: digest, marker_key_version: positive,
  fence: counter, message_ref: id.nullable(), clock_transaction_id: id,
}).superRefine((row, ctx) => {
  if ((!['pending', 'aborted'].includes(row.state) && row.fence === 0) || ((row.state === "sent") !== (row.message_ref !== null)))
    ctx.addIssue({ code: "custom", message: "record_invalid" });
});
const event = z.strictObject({ event_id: id, decision_id: id, kind: z.literal("dona_approval.decision.v1"),
  state: z.enum(["pending", "delivered"]), delivered_at: utc.nullable(),
}).superRefine((row, ctx) => {
  if ((row.state === "delivered") !== (row.delivered_at !== null)) ctx.addIssue({ code: "custom", message: "record_invalid" });
});
const presentation = z.strictObject({ update_id: id, notification_attempt_id: id, message_ref: id, desired_revision: positive,
  state: z.enum(["pending", "dispatching", "succeeded", "failed", "acceptance_unknown", "needs_review", "aborted"]),
  fence: counter, clock_transaction_id: id,
}).superRefine((row, ctx) => {
  if (!['pending', 'aborted'].includes(row.state) && row.fence === 0) ctx.addIssue({ code: "custom", message: "record_invalid" });
});
const envelope = { codec_version: z.literal(1), scope: scopeSchema };
const schema = z.discriminatedUnion("kind", [
  z.strictObject({ ...envelope, kind: z.literal("request"), row: request }),
  z.strictObject({ ...envelope, kind: z.literal("decision"), row: decision }),
  z.strictObject({ ...envelope, kind: z.literal("consume"), row: consume }),
  z.strictObject({ ...envelope, kind: z.literal("execution"), row: execution }),
  z.strictObject({ ...envelope, kind: z.literal("notification"), row: notification }),
  z.strictObject({ ...envelope, kind: z.literal("event"), row: event }),
  z.strictObject({ ...envelope, kind: z.literal("presentation"), row: presentation }),
]);
export type ApprovalRecord = z.infer<typeof schema>;
export type ApprovalRecordKind = ApprovalRecord["kind"];
export class ApprovalRecordError extends Error {
  constructor() { super("approval_record_unverified"); this.name = "ApprovalRecordError"; }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return "{" + Object.keys(object).sort().map(key => JSON.stringify(key) + ":" + canonical(object[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}
function guard<T>(operation: () => T): T { try { return operation(); } catch { throw new ApprovalRecordError(); } }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function primary(record: ApprovalRecord): string {
  switch (record.kind) {
    case "request": case "decision": case "consume": return record.row.request_id;
    case "execution": return record.row.attempt_id;
    case "notification": return record.row.notification_attempt_id;
    case "event": return record.row.event_id;
    case "presentation": return record.row.update_id;
  }
}
/** Canonical point-record key only. Possession grants no permission. Secondary
 * indexes, completeness, current roots and cross-row bindings belong to the
 * audited repository, not to this pure codec. */
export function approvalRecordKey(scopeInput: ApprovalRecordScope, kind: ApprovalRecordKind, primaryKey: string): string {
  return guard(() => {
    assertSynchronousResult(scopeInput); const scope = scopeSchema.parse(scopeInput); id.parse(primaryKey);
    if (!["request", "decision", "consume", "execution", "notification", "event", "presentation"].includes(kind)) throw Error();
    return "record_" + createHash("sha256").update("dona.approval-record-key.v1\0")
      .update(canonical({ scope, kind, primary_key: primaryKey })).digest("hex");
  });
}
/** Stored identity fields are data, never authenticated actor/binding proof.
 * This validates the canonical representation and its selected storage scope. */
export function encodeApprovalRecord(input: unknown, scopeInput: ApprovalRecordScope) {
  return guard(() => {
    assertSynchronousResult(input); assertSynchronousResult(scopeInput);
    const record = schema.parse(input), scope = scopeSchema.parse(scopeInput);
    if (canonical(record.scope) !== canonical(scope)) throw Error();
    if (record.kind === "request" || record.kind === "decision") {
      if (record.row.instance_id !== scope.instance_id || record.row.workspace_id !== scope.workspace_id) throw Error();
    }
    if (record.kind === "request") {
      const row = record.row;
      if (Buffer.byteLength(row.snapshot_json) > 262144) throw Error();
      const stored = JSON.parse(row.snapshot_json) as { request_source?: unknown };
      const context = { ...scope, request_source: stored.request_source } as ApprovalSourceContext;
      const snapshot = decodeApprovalSnapshot(row.snapshot_json, row.semantic_hash, context);
      if (snapshot.creation_key !== row.creation_key || snapshot.snapshot.policy_revision !== row.policy_revision
        || snapshot.snapshot.preconditions.workspace_binding_revision !== row.binding_revision) throw Error();
    }
    const encoded = canonical(record); if (Buffer.byteLength(encoded) > maximumApprovalRecordBytes) throw Error();
    return { canonical: encoded, digest: createHash("sha256").update("dona.approval-record.v1\0").update(encoded).digest("hex"),
      key: approvalRecordKey(scope, record.kind, primary(record)), record: freeze(record) };
  });
}
export function decodeApprovalRecord(encoded: string, expectedDigest: string, scope: ApprovalRecordScope) {
  return guard(() => {
    if (typeof encoded !== "string" || Buffer.byteLength(encoded) > maximumApprovalRecordBytes) throw Error();
    digest.parse(expectedDigest); const decoded = encodeApprovalRecord(JSON.parse(encoded), scope);
    if (decoded.canonical !== encoded || !timingSafeEqual(Buffer.from(decoded.digest, "hex"), Buffer.from(expectedDigest, "hex"))) throw Error();
    return decoded;
  });
}
