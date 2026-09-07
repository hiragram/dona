import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DeliveryBinding } from "./connections/domain.js";
import {
  ExternalIngressAuthenticationError,
  ExternalIngressValidationError,
  type ExternalEventSourceRegistration,
  type NormalizedExternalEvent,
  type RawIngressRequest,
} from "./ingress.js";

const id = z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/);
const eventSchema = z.object({
  id,
  timestamp: z.string().datetime({ offset: true }),
  workspace_id: id,
  subscription_id: id,
  integration_id: id,
  type: z.string().min(1).max(128).regex(/^[a-z0-9_.]+$/),
  entity: z.object({ id, type: z.enum(["page", "database", "data_source"]) }),
  attempt_number: z.number().int().min(1).max(8),
});
const verificationSchema = z.object({ verification_token: z.string().min(16).max(1024) });

export interface NotionSecretStore {
  get(reference: string): Promise<Buffer | undefined>;
}
export interface NotionVerificationClaim {
  binding: DeliveryBinding;
  providerEventId: string;
  occurredAt: string;
}
export interface NotionVerificationStore {
  // pending registration attemptだけを原子的にconsumeし、secretを未設定の場合だけ保存する。
  claim(input: Readonly<{ connectionId: string; secretRef: string; token: Buffer }>): Promise<NotionVerificationClaim | undefined>;
}
export interface NotionBindingResolver {
  resolve(input: Readonly<{ connectionId: string; subscriptionId: string; integrationId: string;
    workspaceId: string; resourceId: string; eventType: string }>): Promise<DeliveryBinding | undefined>;
}
export interface NotionRegistrationOptions {
  connectionId: string;
  verificationSecretRef: string;
  secrets: NotionSecretStore;
  verification: NotionVerificationStore;
  bindings: NotionBindingResolver;
}

function header(request: RawIngressRequest, name: string): string | undefined {
  const values = request.headers.filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);
  return values.length === 1 ? values[0] : undefined;
}
function json(body: Buffer): unknown {
  try { return JSON.parse(body.toString("utf8")); } catch { throw new ExternalIngressValidationError(); }
}
function signatureBytes(value: string): Buffer | undefined {
  const hex = value.startsWith("sha256=") ? value.slice(7) : value;
  return /^[a-f0-9]{64}$/i.test(hex) ? Buffer.from(hex, "hex") : undefined;
}

export function createNotionRegistration(options: NotionRegistrationOptions): ExternalEventSourceRegistration {
  return {
    source: "notion",
    maxBodyBytes: 512 * 1024,
    bodyTimeoutMs: 10_000,
    processingTimeoutMs: 10_000,
    async authenticate(request) {
      const candidate = json(request.body);
      const verification = verificationSchema.safeParse(candidate);
      if (verification.success) {
        if (header(request, "x-notion-signature") !== undefined) throw new ExternalIngressAuthenticationError();
        const claim = await options.verification.claim({ connectionId: options.connectionId,
          secretRef: options.verificationSecretRef, token: Buffer.from(verification.data.verification_token) });
        if (!claim || claim.binding.connectionId !== options.connectionId) throw new ExternalIngressAuthenticationError();
        return { connectionId: options.connectionId, connection: claim.binding, resourceId: claim.binding.resource,
          purpose: "verification",
          principal: { kind: "verification", provider_event_id: claim.providerEventId, occurred_at: claim.occurredAt } };
      }
      const parsed = eventSchema.safeParse(candidate);
      if (!parsed.success) throw new ExternalIngressAuthenticationError();
      const secret = await options.secrets.get(options.verificationSecretRef);
      const supplied = signatureBytes(header(request, "x-notion-signature") ?? "");
      if (!secret || !supplied) throw new ExternalIngressAuthenticationError();
      const expected = createHmac("sha256", secret).update(request.body).digest();
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        throw new ExternalIngressAuthenticationError();
      }
      const binding = await options.bindings.resolve({ connectionId: options.connectionId,
        subscriptionId: parsed.data.subscription_id, integrationId: parsed.data.integration_id,
        workspaceId: parsed.data.workspace_id, resourceId: parsed.data.entity.id, eventType: parsed.data.type });
      if (!binding || binding.connectionId !== options.connectionId || binding.resource !== parsed.data.entity.id) {
        throw new ExternalIngressAuthenticationError();
      }
      return { connectionId: options.connectionId, connection: binding, resourceId: binding.resource,
        principal: { kind: "event", subscription_id: parsed.data.subscription_id } };
    },
    normalize(request, verified) {
      if (verified.principal.kind === "verification") {
        return { providerEventId: String(verified.principal.provider_event_id), type: "notion.verification",
          occurredAt: String(verified.principal.occurred_at), subject: { connection_id: options.connectionId },
          payload: { verified: true }, replyTarget: null } satisfies NormalizedExternalEvent;
      }
      const parsed = eventSchema.parse(json(request.body));
      return { providerEventId: parsed.id, type: `notion.${parsed.type}`, occurredAt: parsed.timestamp,
        subject: { connection_id: options.connectionId, workspace_id: parsed.workspace_id,
          subscription_id: parsed.subscription_id, integration_id: parsed.integration_id,
          entity_id: parsed.entity.id, entity_type: parsed.entity.type },
        // attempt_numberは同じevent IDの配送ごとに変わるため、durable event fingerprintへ含めない。
        payload: {}, replyTarget: null } satisfies NormalizedExternalEvent;
    },
    parseNormalized(input) { return input as NormalizedExternalEvent; },
    queueSignal(event) {
      const entity = event.subject.entity_id;
      return typeof entity === "string" ? { resourceKey: entity, signalKey: entity, requiresFetch: true } : undefined;
    },
    buildAcknowledgement(receipt) {
      return { statusCode: 200, body: { accepted: true, event_id: receipt.eventId, outcome: receipt.outcome } };
    },
  };
}

export type NotionFetchOutcome = "fetched" | "not_found_or_inaccessible" | "permission_lost" | "rate_limited" | "degraded";
export interface NotionReadClient {
  fetch(resourceId: string): Promise<{ status: number; retryAfter?: number; value?: Readonly<Record<string, unknown>> }>;
}
export async function fetchLatestNotionState(client: NotionReadClient, resourceId: string): Promise<{
  outcome: NotionFetchOutcome; retryAfter?: number; value?: Readonly<Record<string, unknown>> }> {
  let response: Awaited<ReturnType<NotionReadClient["fetch"]>>;
  try { response = await client.fetch(resourceId); } catch { return { outcome: "degraded" }; }
  if (response.status === 200 && response.value) return { outcome: "fetched", value: response.value };
  if (response.status === 404) return { outcome: "not_found_or_inaccessible" };
  if (response.status === 401 || response.status === 403) return { outcome: "permission_lost" };
  if (response.status === 429) return { outcome: "rate_limited", ...(response.retryAfter === undefined ? {} : { retryAfter: response.retryAfter }) };
  return { outcome: "degraded" };
}
