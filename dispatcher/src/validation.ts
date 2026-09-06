import { z } from "zod";

import type {
  CancelJobRequest,
  CreateJobRequest,
  EventEnvelope,
  JobResultEnvelope,
  ResultEnvelope,
  SteerJobRequest,
} from "./types.js";

const jsonObject = z.record(z.string(), z.unknown());
const utcRfc3339 = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, "must be UTC RFC 3339")
  .refine((value) => !Number.isNaN(Date.parse(value)), "must be a valid timestamp");

const eventEnvelopeSchema = z
  .object({
    schema_version: z.literal(1),
    source: z.enum(["slack", "dona_job"]),
    external_event_id: z.string().trim().min(1),
    type: z.string().trim().min(1),
    occurred_at: utcRfc3339,
    subject: jsonObject,
    payload: jsonObject,
    reply_target: jsonObject.nullable(),
    trace: jsonObject.optional(),
  })
  .strip();

const updateEventEnvelopeSchema = z
  .object({
    schema_version: z.literal(1),
    source: z.literal("dona_update"),
    external_event_id: z.string().regex(/^update:upd_[0-9a-hjkmnp-tv-z]{26}:terminal:\d+$/),
    type: z.enum(["update_succeeded", "update_failed", "update_rolled_back", "update_needs_review", "update_cancelled"]),
    occurred_at: utcRfc3339,
    subject: z.object({ request_id: z.string().regex(/^upd_[0-9a-hjkmnp-tv-z]{26}$/) }).strict(),
    payload: z.object({
      request_id: z.string().regex(/^upd_[0-9a-hjkmnp-tv-z]{26}$/),
      update_status: z.enum(["succeeded", "failed", "rolled_back", "needs_review", "cancelled"]),
      current_sha: z.string().regex(/^[0-9a-f]{40}$/),
      target_sha: z.string().regex(/^[0-9a-f]{40}$/),
      previous_sha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
      plan_hash: z.string().regex(/^[0-9a-f]{64}$/),
      policy_version: z.string().min(1).max(64),
      rollback_compatible: z.boolean(),
      active_sha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
      error: z.object({ code: z.string().max(128), message: z.string().max(2_000).nullable() }).nullable(),
    }).strict(),
    reply_target: z.object({
      kind: z.literal("slack_thread"),
      workspace_id: z.string().min(1).max(64),
      channel_id: z.string().min(1).max(64),
      thread_ts: z.string().regex(/^\d+\.\d+$/),
    }).strict(),
  })
  .strict()
  .refine((value) => value.subject.request_id === value.payload.request_id, "request_id mismatch")
  .refine((value) => value.external_event_id.startsWith(`update:${value.payload.request_id}:terminal:`), "external_event_id mismatch")
  .refine((value) => value.type === `update_${value.payload.update_status}`, "type/status mismatch");

const scheduleEventEnvelopeSchema = z.object({
  schema_version: z.literal(1),
  source: z.literal("dona_schedule"),
  external_event_id: z.string().regex(/^schedule:v1:[A-Za-z0-9_-]+:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
  type: z.literal("schedule_due"),
  occurred_at: utcRfc3339,
  subject: z.object({
    tenant_id: z.string().min(1).max(160), owner_id: z.string().min(1).max(160), schedule_id: z.string().min(1).max(160),
  }).strict(),
  payload: z.object({
    run_id: z.string().min(1).max(160), revision: z.number().int().positive(), occurrence_key: z.string().min(1).max(512),
    work: z.object({ objective: z.string().min(1).max(4_000), scope: z.literal("read_only"),
      allowed_external_writes: z.tuple([]), result_destination: z.unknown() }).strict().optional(),
  }).strict(),
  reply_target: z.null(),
  trace: z.object({ schedule_id: z.string().min(1).max(160), run_id: z.string().min(1).max(160) }).strict(),
}).strict()
  .refine((value) => value.external_event_id === `schedule:v1:${value.subject.schedule_id}:${value.occurred_at}`, "external_event_id mismatch")
  .refine((value) => value.subject.schedule_id === value.trace.schedule_id && value.payload.run_id === value.trace.run_id, "trace mismatch");

const resultEnvelopeSchema = z
  .object({
    schema_version: z.literal(1),
    event_id: z.string().min(1),
    status: z.enum(["completed", "failed"]),
    summary: z.string().optional(),
    actions: z.array(z.unknown()).optional(),
    memory_candidates: z.array(z.unknown()).optional(),
    completed_at: utcRfc3339,
  })
  .loose();

const repository = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/, "must be owner/repo");
const gitRef = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !value.startsWith("-") && !value.includes("..") && !/[\u0000-\u001f\u007f ~^:?*\[\\]/.test(value), "must be a safe Git ref");

const createJobSchema = z.object({
  source_event_id: z.string().trim().min(1),
  objective: z.string().trim().min(1).max(100_000),
  workspace: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("scratch") }).strip(),
    z.object({ kind: z.literal("github"), repository, base_ref: gitRef.optional() }).strip(),
  ]),
}).strip();

const steerJobSchema = z.object({
  source_event_id: z.string().trim().min(1),
  instruction: z.string().trim().min(1).max(100_000),
}).strip();

const cancelJobSchema = z.object({
  source_event_id: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(2_000).optional(),
}).strip();

const jobResultEnvelopeSchema = z.object({
  schema_version: z.literal(1),
  job_id: z.string().min(1),
  status: z.enum(["completed", "failed"]),
  summary: z.string().min(1),
  output: z.object({ format: z.enum(["markdown", "text"]), text: z.string() }).optional(),
  artifacts: z.array(jsonObject).optional(),
  actions: z.array(z.unknown()).optional(),
  completed_at: utcRfc3339,
}).loose();

export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

export function parseEventEnvelope(input: unknown): EventEnvelope {
  const parsed = eventEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.length ? `${issue.path.join(".")} ` : "";
    throw new RequestValidationError(`${location}${issue?.message ?? "is invalid"}`);
  }
  return parsed.data as EventEnvelope;
}

export function parseInternalUpdateEventEnvelope(input: unknown): EventEnvelope {
  const parsed = updateEventEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.length ? `${issue.path.join(".")} ` : "";
    throw new RequestValidationError(`${location}${issue?.message ?? "is invalid"}`);
  }
  return parsed.data as EventEnvelope;
}

export function parseInternalScheduleEventEnvelope(input: unknown): EventEnvelope {
  const parsed = scheduleEventEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.length ? `${issue.path.join(".")} ` : "";
    throw new RequestValidationError(`${location}${issue?.message ?? "is invalid"}`);
  }
  return parsed.data as EventEnvelope;
}

export function parseResultEnvelope(input: unknown, eventId: string): ResultEnvelope {
  const parsed = resultEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.length ? `${issue.path.join(".")} ` : "";
    throw new RequestValidationError(`${location}${issue?.message ?? "is invalid"}`);
  }
  if (parsed.data.event_id !== eventId) {
    throw new RequestValidationError("event_id does not match the dispatched event");
  }
  return parsed.data as ResultEnvelope;
}

function parseWithSchema<T>(schema: z.ZodType, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.length ? `${issue.path.join(".")} ` : "";
    throw new RequestValidationError(`${location}${issue?.message ?? "is invalid"}`);
  }
  return parsed.data as T;
}

export function parseCreateJobRequest(input: unknown): CreateJobRequest {
  return parseWithSchema<CreateJobRequest>(createJobSchema, input);
}

export function parseSteerJobRequest(input: unknown): SteerJobRequest {
  return parseWithSchema<SteerJobRequest>(steerJobSchema, input);
}

export function parseCancelJobRequest(input: unknown): CancelJobRequest {
  return parseWithSchema<CancelJobRequest>(cancelJobSchema, input);
}

export function parseJobResultEnvelope(input: unknown, jobId: string): JobResultEnvelope {
  const result = parseWithSchema<JobResultEnvelope>(jobResultEnvelopeSchema, input);
  if (result.job_id !== jobId) throw new RequestValidationError("job_id does not match the dispatched job");
  return result;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
