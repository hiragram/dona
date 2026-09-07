import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import {
  ExternalIngressAuthenticationError,
  ExternalIngressValidationError,
  type ExternalEventSourceRegistration,
  type RawIngressRequest,
} from "../ingress.js";
import { stableStringify } from "../validation.js";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/);
const connectionIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const eventType = z.enum(["PING", "FILE_UPDATE"]);
const payloadSchema = z.object({
  passcode: z.string().min(1).max(512),
  webhook_id: identifier,
  event_type: eventType,
  timestamp: z.string().datetime({ offset: true }),
  file_key: identifier.optional(),
  file_name: z.string().max(512).optional(),
  description: z.string().max(4_096).optional(),
  triggered_by: z.object({ id: identifier, handle: z.string().max(512), img_url: z.string().url().optional() }).strict().optional(),
}).strict();

export interface FigmaIngressConfig {
  connectionId: string;
  webhookId: string;
  fileKey: string;
  allowedEvents: ReadonlySet<string>;
  passcode: string;
}

function decode(body: Buffer): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
  catch { throw new ExternalIngressValidationError(); }
}

function candidatePasscode(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const passcode = (value as Record<string, unknown>).passcode;
  return typeof passcode === "string" ? passcode : undefined;
}

function equalSecret(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function payloadFingerprint(value: z.infer<typeof payloadSchema>): string {
  const { passcode: _passcode, ...authenticatedPayload } = value;
  return createHash("sha256").update("figma-payload-v1\0").update(stableStringify(authenticatedPayload)).digest("hex");
}

const figmaEnvironmentKeys = ["FIGMA_CONNECTION_ID", "FIGMA_WEBHOOK_ID", "FIGMA_FILE_KEY", "FIGMA_ALLOWED_EVENTS", "FIGMA_WEBHOOK_PASSCODE"] as const;

export function figmaIngressFromEnv(env: NodeJS.ProcessEnv): ExternalEventSourceRegistration | undefined {
  const configured = figmaEnvironmentKeys.filter((key) => (env[key]?.trim().length ?? 0) > 0);
  if (configured.length === 0) return undefined;
  if (configured.length !== figmaEnvironmentKeys.length) throw new Error("Figma ingress configuration is incomplete");
  return figmaIngress({
    connectionId: env.FIGMA_CONNECTION_ID!, webhookId: env.FIGMA_WEBHOOK_ID!, fileKey: env.FIGMA_FILE_KEY!,
    allowedEvents: new Set(env.FIGMA_ALLOWED_EVENTS!.split(",").map((value) => value.trim()).filter(Boolean)),
    passcode: env.FIGMA_WEBHOOK_PASSCODE!,
  });
}

export function figmaIngress(config: FigmaIngressConfig): ExternalEventSourceRegistration {
  if (!config.passcode || !connectionIdentifier.safeParse(config.connectionId).success ||
    !identifier.safeParse(config.webhookId).success || !identifier.safeParse(config.fileKey).success ||
    config.allowedEvents.size !== 1 || !config.allowedEvents.has("FILE_UPDATE")) {
    throw new Error("Figma ingress configuration is invalid");
  }
  return {
    source: "figma",
    maxBodyBytes: 256 * 1_024,
    bodyTimeoutMs: 5_000,
    processingTimeoutMs: 5_000,
    async authenticate(request: RawIngressRequest) {
      const parsed = decode(request.body);
      const passcode = candidatePasscode(parsed);
      if (passcode === undefined || !equalSecret(passcode, config.passcode)) {
        throw new ExternalIngressAuthenticationError();
      }
      return { connectionId: config.connectionId, resourceId: config.fileKey, principal: { kind: "figma_webhook" } };
    },
    normalize(request) {
      const parsed = payloadSchema.safeParse(decode(request.body));
      if (!parsed.success) throw new ExternalIngressValidationError();
      const value = parsed.data;
      if (value.webhook_id !== config.webhookId) throw new ExternalIngressValidationError();
      if (value.event_type !== "PING") {
        if (value.file_key !== config.fileKey || !config.allowedEvents.has(value.event_type)) {
          throw new ExternalIngressValidationError();
        }
      }
      const fingerprint = payloadFingerprint(value);
      return {
        providerEventId: `payload-v1:${fingerprint}`,
        type: value.event_type === "PING" ? "figma.ping" : `figma.${value.event_type.toLowerCase()}`,
        occurredAt: new Date(value.timestamp).toISOString(),
        subject: { webhook_id: value.webhook_id, ...(value.file_key ? { file_key: value.file_key } : {}) },
        payload: {
          fingerprint_version: 1,
          payload_fingerprint: fingerprint,
          ...(value.file_name ? { file_name: value.file_name } : {}),
          ...(value.description ? { description: value.description } : {}),
          ...(value.triggered_by ? { actor: { id: value.triggered_by.id, handle: value.triggered_by.handle } } : {}),
        },
        replyTarget: null,
      };
    },
    parseNormalized(input) { return input as ReturnType<ExternalEventSourceRegistration["parseNormalized"]>; },
    controlAcknowledgement(event) {
      return event.type === "figma.ping"
        ? { statusCode: 200, body: { schema_version: 1, outcome: "ping_verified" } }
        : undefined;
    },
    buildAcknowledgement(receipt) {
      return { statusCode: 200, body: { schema_version: 1, outcome: receipt.outcome, event_id: receipt.eventId } };
    },
  };
}
