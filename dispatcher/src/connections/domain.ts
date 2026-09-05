import { z } from "zod";
import { externalEventSource } from "../ingress.js";

// 保存・表示する値は識別子だけ。credential の解決は driver の境界内で行う。
export const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/).refine((value) => !value.includes("://"));
export const connectionIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const capabilitySchema = z.union([
  z.strictObject({ kind: z.literal("manual"), cursor: z.boolean() }),
  z.strictObject({ kind: z.literal("managed"), cursor: z.boolean(), renewal: z.literal("none") }),
  z.strictObject({ kind: z.literal("managed"), cursor: z.boolean(), renewal: z.literal("replace"),
    windowMs: z.number().int().positive().max(30 * 86_400_000) }),
]);
export type Capability = z.infer<typeof capabilitySchema>;
export const connectionSchema = z.strictObject({
  id: connectionIdentifier,
  provider: z.string().refine((value) => { try { externalEventSource(value); return true; } catch { return false; } }),
  account: identifier,
  allowlist: z.array(z.strictObject({ resource: identifier, events: z.array(identifier).min(1).max(100) })).min(1).max(100),
  credentialRef: z.string().regex(/^cred_[A-Za-z0-9_-]{1,100}$/),
  credentialRevision: z.number().int().positive(),
  capability: capabilitySchema,
});
export type ConnectionConfig = z.infer<typeof connectionSchema>;
export type ConnectionState = "verification_pending" | "active" | "degraded" | "disabled";
export interface Connection extends ConnectionConfig { revision: number; state: ConnectionState; }
export type SubscriptionState = "verification_pending" | "active" | "expiring" | "renewal_unknown" | "stop_candidate" | "stopped";
export interface Subscription {
  connectionId: string; resource: string; generation: number; revision: number;
  providerId: string | null; state: SubscriptionState;
  createdAt: number; verifiedAt: number | null; expiresAt: number | null; renewalWindowMs: number; verificationEpoch: number;
  lastDeliveryAt: number | null; lastReconcileAt: number | null; error: string | null;
}
export interface Clock { now(): number; }
export const systemClock: Clock = { now: () => Date.now() };
export class ConnectionError extends Error {
  constructor(readonly code: "invalid_input" | "not_found" | "revision_conflict" | "not_authorized" |
    "disabled" | "credential_unavailable" | "clock_skew" | "cursor_conflict" | "incomplete_batch" |
    "duplicate_conflict" | "operation_pending" | "invalid_transition" | "capability_mismatch") {
    super(code); this.name = "ConnectionError";
  }
}
export function parseConfig(input: unknown): ConnectionConfig {
  const result = connectionSchema.safeParse(input);
  if (!result.success) throw new ConnectionError("invalid_input");
  const resources = result.data.allowlist.map((entry) => entry.resource);
  if (new Set(resources).size !== resources.length) throw new ConnectionError("invalid_input");
  return result.data;
}
export interface DeliveryBinding {
  connectionId: string; account: string; revision: number; credentialRevision: number;
  resource: string; generation: number;
}
export const deliverySchema = z.strictObject({
  connectionId: connectionIdentifier, account: identifier, revision: z.number().int().positive(),
  credentialRevision: z.number().int().positive(), resource: identifier, generation: z.number().int().positive(),
});
export interface Operation {
  id: string; connectionId: string; resource: string; generation: number; revision: number;
  kind: "create" | "stop"; leaseUntil: number; providerId: string | null;
}
export interface ProviderObservation {
  providerId: string; expiresAt: number | null; verified: boolean; cutoverConfirmed: boolean;
}
export interface Driver {
  readonly provider: string;
  readonly capability: Capability;
  // この参照の現在の capability revision を secret store から検証。secret は返さない。
  credentialAvailable(connection: Readonly<Connection>): Promise<boolean>;
  create(connection: Readonly<Connection>, operation: Readonly<Operation>): Promise<ProviderObservation>;
  lookup(connection: Readonly<Connection>, operation: Readonly<Operation>): Promise<ProviderObservation | null>;
  inspect(connection: Readonly<Connection>, subscription: Readonly<Subscription>): Promise<ProviderObservation>;
  stop(connection: Readonly<Connection>, operation: Readonly<Operation>, providerId: string): Promise<void>;
}
export interface OperationAuthority {
  // 運用者による exact revision/resource/kind の認可。MCP の自己申告 boolean では提供しない。
  authorize(request: Readonly<{ connectionId: string; revision: number; resource: string; kind: "create" | "stop" }>): Promise<boolean>;
}
