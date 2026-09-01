import { z } from "zod";

import type { EventEnvelope, ResultEnvelope } from "./types.js";

const jsonObject = z.record(z.string(), z.unknown());
const utcRfc3339 = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, "must be UTC RFC 3339")
  .refine((value) => !Number.isNaN(Date.parse(value)), "must be a valid timestamp");

const eventEnvelopeSchema = z
  .object({
    schema_version: z.literal(1),
    source: z.literal("slack"),
    external_event_id: z.string().trim().min(1),
    type: z.string().trim().min(1),
    occurred_at: utcRfc3339,
    subject: jsonObject,
    payload: jsonObject,
    reply_target: jsonObject.nullable(),
    trace: jsonObject.optional(),
  })
  .strip();

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
