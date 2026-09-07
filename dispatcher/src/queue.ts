import { createHash } from "node:crypto";
import { z } from "zod";
import type { EventEnvelope } from "./types.js";

export const queueClasses = ["slack", "internal", "external", "update"] as const;
export type QueueClass = typeof queueClasses[number];
const positive = z.number().int().min(1).max(1_000_000_000);
const lanePolicy = z.object({
  depth: positive.default(256), bytes: positive.default(4_194_304),
  rate: positive.default(100), burst: positive.default(256),
  coalescing: z.boolean().default(false),
}).strict();
export const queuePolicySchema = z.object({
  depth: positive.default(4096), bytes: positive.default(67_108_864),
  maxLanes: z.number().int().min(4).max(10000).default(512),
  maxDeliveries: positive.default(256),
  reservations: z.object({ slack: positive.default(64), internal: positive.default(64), update: positive.default(32) }).strict().default({ slack: 64, internal: 64, update: 32 }),
  reservedBytes: z.object({ slack: positive.default(1_048_576), internal: positive.default(1_048_576), update: positive.default(1_048_576) }).strict().default({ slack: 1_048_576, internal: 1_048_576, update: 1_048_576 }),
  weights: z.object({ slack: z.number().int().min(1).max(16).default(2), internal: z.number().int().min(1).max(16).default(2), external: z.number().int().min(1).max(16).default(1) }).strict().default({ slack: 2, internal: 2, external: 1 }),
  defaults: lanePolicy.default({ depth: 256, bytes: 4_194_304, rate: 100, burst: 256, coalescing: false }),
  sources: z.record(z.string().max(64), lanePolicy).default({}),
  connections: z.record(z.string().max(200), lanePolicy).default({}),
}).strict().superRefine((p, ctx) => {
  if (Object.values(p.reservations).reduce((a,b) => a+b,0) >= p.depth ||
      Object.values(p.reservedBytes).reduce((a,b) => a+b,0) >= p.bytes) {
    ctx.addIssue({ code: "custom", message: "Queue reservations must leave external capacity" });
  }
});
export type QueuePolicy = z.infer<typeof queuePolicySchema>;
export interface QueueAdmissionContext {
  /** 認証後のregistrationだけが渡す。Envelopeの自己申告を使わない。 */
  connectionId: string;
  coalesce?: { resourceKey: string; signalKey: string; requiresFetch: true; latestState?: true };
  /** 認証済みverification receiptを即時terminal化する内部経路だけが設定する。 */
  terminalVerification?: true;
}
export const admissionCodes = ["created", "duplicate_same", "duplicate_conflict", "coalesced", "queue_depth", "queue_bytes", "queue_rate", "queue_lanes", "queue_deliveries", "queue_quiescing", "queue_identity"] as const;
export type AdmissionCode = typeof admissionCodes[number];
export class QueueClaimUnavailableError extends Error {
  constructor() { super("Event is no longer dispatchable because it is not selected or claims are closed"); }
}
export class QueueAdmissionError extends Error {
  readonly ackAllowed = false;
  constructor(readonly code: AdmissionCode) { super(code); }
}
export function queueIdentity(event: EventEnvelope, context?: QueueAdmissionContext) {
  const builtIn = ["slack", "dona_job", "dona_update"].includes(event.source);
  if (!builtIn && (!context || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(context.connectionId))) {
    throw new QueueAdmissionError("queue_identity");
  }
  const connection = builtIn ? String(event.subject.workspace_id ?? "internal") : context!.connectionId;
  const queueClass: QueueClass = event.source === "slack" ? "slack" : event.source === "dona_update" ? "update" : event.source === "dona_job" ? "internal" : "external";
  return { connection, queueClass, lane: createHash("sha256").update(JSON.stringify([event.source, connection])).digest("hex") };
}
export function coalesceKey(context?: QueueAdmissionContext): string | null {
  const c = context?.coalesce;
  if (!c) return null;
  if (c.requiresFetch !== true || !c.resourceKey || !c.signalKey || c.resourceKey.length > 512 || c.signalKey.length > 128) throw new QueueAdmissionError("queue_identity");
  return createHash("sha256").update(JSON.stringify([c.resourceKey, c.signalKey])).digest("hex");
}
