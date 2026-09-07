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
const eventSchema = z.strictObject({
  id,
  timestamp: z.string().datetime({ offset: true }),
  workspace_id: id,
  subscription_id: id,
  integration_id: id,
  type: z.string().min(1).max(128).regex(/^[a-z0-9_.]+$/),
  entity: z.strictObject({ id, type: z.enum(["page", "database", "data_source"]) }),
  attempt_number: z.number().int().min(1).max(8),
});
const verificationSchema = z.strictObject({ verification_token: z.string().min(16).max(1024) });

export interface NotionSecretStore {
  get(reference: string): Promise<Buffer | undefined>;
  put(reference: string, value: Buffer): Promise<void>;
}
export interface NotionBindingResolver {
  resolve(input: Readonly<{ connectionId: string; subscriptionId: string; integrationId: string;
    workspaceId: string; resourceId: string; eventType: string }>): Promise<DeliveryBinding | undefined>;
}
export interface NotionRegistrationOptions {
  connectionId: string;
  verificationSecretRef: string;
  secrets: NotionSecretStore;
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
        await options.secrets.put(options.verificationSecretRef, Buffer.from(verification.data.verification_token));
        return { connectionId: options.connectionId, principal: { kind: "verification" } };
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
        return { providerEventId: `verification:${options.connectionId}`, type: "notion.verification",
          occurredAt: request.receivedAt, subject: { connection_id: options.connectionId },
          payload: { verified: true }, replyTarget: null } satisfies NormalizedExternalEvent;
      }
      const parsed = eventSchema.parse(json(request.body));
      return { providerEventId: parsed.id, type: `notion.${parsed.type}`, occurredAt: parsed.timestamp,
        subject: { connection_id: options.connectionId, workspace_id: parsed.workspace_id,
          subscription_id: parsed.subscription_id, integration_id: parsed.integration_id,
          entity_id: parsed.entity.id, entity_type: parsed.entity.type },
        payload: { attempt_number: parsed.attempt_number }, replyTarget: null } satisfies NormalizedExternalEvent;
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

export type NotionFetchOutcome = "fetched" | "deleted" | "permission_lost" | "rate_limited" | "degraded";
export interface NotionReadClient {
  fetch(resourceId: string): Promise<{ status: number; retryAfter?: number; value?: Readonly<Record<string, unknown>> }>;
}
export async function fetchLatestNotionState(client: NotionReadClient, resourceId: string): Promise<{
  outcome: NotionFetchOutcome; retryAfter?: number; value?: Readonly<Record<string, unknown>> }> {
  const response = await client.fetch(resourceId);
  if (response.status === 200 && response.value) return { outcome: "fetched", value: response.value };
  if (response.status === 404) return { outcome: "deleted" };
  if (response.status === 401 || response.status === 403) return { outcome: "permission_lost" };
  if (response.status === 429) return { outcome: "rate_limited", ...(response.retryAfter === undefined ? {} : { retryAfter: response.retryAfter }) };
  return { outcome: "degraded" };
}
