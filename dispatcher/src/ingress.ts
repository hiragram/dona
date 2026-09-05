import { createHash } from "node:crypto";

import type { EnqueueResult, EventEnvelope, ExternalEventSource } from "./types.js";

const externalSourcePattern = /^[a-z][a-z0-9._-]{0,63}$/;
const connectionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const utcRfc3339Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const reservedSources = new Set(["slack", "dona_job", "dona_update"]);
const reservedAcknowledgementHeaders = new Set([
  "connection",
  "content-length",
  "content-type",
  "set-cookie",
  "transfer-encoding",
]);
const registrationHardLimits = {
  maxBodyBytes: 16 * 1_024 * 1_024,
  bodyTimeoutMs: 60_000,
  processingTimeoutMs: 60_000,
} as const;

export class ExternalIngressAuthenticationError extends Error {
  constructor() {
    super("Provider authentication failed");
    this.name = "ExternalIngressAuthenticationError";
  }
}

export class ExternalIngressValidationError extends Error {
  constructor() {
    super("Provider event is invalid");
    this.name = "ExternalIngressValidationError";
  }
}

export class ExternalIngressTimeoutError extends Error {
  constructor() {
    super("Provider ingress processing timed out");
    this.name = "ExternalIngressTimeoutError";
  }
}

export class ExternalIngressAcknowledgementError extends Error {
  constructor() {
    super("Provider acknowledgement could not be built");
    this.name = "ExternalIngressAcknowledgementError";
  }
}

export interface RawIngressRequest {
  readonly body: Buffer;
  readonly headers: ReadonlyArray<readonly [name: string, value: string]>;
  readonly method: "POST";
  readonly path: string;
  readonly receivedAt: string;
}

export interface VerifiedIngressPrincipal {
  readonly connectionId: string;
  readonly principal: Readonly<Record<string, unknown>>;
}

export interface NormalizedExternalEvent {
  readonly providerEventId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly subject: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly replyTarget: Record<string, unknown> | null;
  readonly trace?: Record<string, unknown>;
}

export interface PersistReceipt {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly sequence: number;
  readonly source: ExternalEventSource;
  readonly externalEventId: string;
  readonly outcome: EnqueueResult["outcome"];
  readonly committedAt: string;
}

export interface ExternalIngressAcknowledgement {
  readonly statusCode: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
}

export interface ExternalEventSourceRegistration {
  readonly source: string;
  readonly maxBodyBytes: number;
  readonly bodyTimeoutMs: number;
  readonly processingTimeoutMs: number;
  authenticate(request: RawIngressRequest): Promise<VerifiedIngressPrincipal>;
  normalize(
    request: RawIngressRequest,
    verified: VerifiedIngressPrincipal,
  ): Promise<unknown> | unknown;
  parseNormalized(input: unknown): NormalizedExternalEvent;
  buildAcknowledgement(receipt: PersistReceipt): ExternalIngressAcknowledgement;
}

export interface ExternalIngressResult {
  readonly receipt: PersistReceipt;
  readonly acknowledgement: ExternalIngressAcknowledgement | null;
}

export function externalEventSource(value: string): ExternalEventSource {
  if (!externalSourcePattern.test(value) || reservedSources.has(value)) {
    throw new Error("External event source must be a safe non-reserved identifier");
  }
  return value as ExternalEventSource;
}

export function persistedEventSource(value: string): EventEnvelope["source"] {
  if (reservedSources.has(value)) return value as EventEnvelope["source"];
  return externalEventSource(value);
}

export function scopedExternalEventId(
  source: ExternalEventSource,
  connectionId: string,
  providerEventId: string,
): string {
  if (!connectionIdPattern.test(connectionId)) throw new ExternalIngressValidationError();
  if (!providerEventId.trim() || providerEventId.length > 512) throw new ExternalIngressValidationError();
  return `external:${createHash("sha256")
    .update(source)
    .update("\0")
    .update(connectionId)
    .update("\0")
    .update(providerEventId)
    .digest("hex")}`;
}

export class ExternalIngressRegistry {
  private readonly registrations = new Map<ExternalEventSource, ExternalEventSourceRegistration>();

  constructor(registrations: readonly ExternalEventSourceRegistration[] = []) {
    for (const registration of registrations) this.register(registration);
  }

  register(registration: ExternalEventSourceRegistration): void {
    const source = externalEventSource(registration.source);
    if (this.registrations.has(source)) throw new Error(`External event source is already registered: ${source}`);
    for (const [value, name] of [
      [registration.maxBodyBytes, "maxBodyBytes"],
      [registration.bodyTimeoutMs, "bodyTimeoutMs"],
      [registration.processingTimeoutMs, "processingTimeoutMs"],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
      if (value > registrationHardLimits[name]) throw new Error(`${name} exceeds its hard limit`);
    }
    this.registrations.set(source, registration);
  }

  get(sourceInput: string): { source: ExternalEventSource; registration: ExternalEventSourceRegistration } | undefined {
    let source: ExternalEventSource;
    try {
      source = externalEventSource(sourceInput);
    } catch {
      return undefined;
    }
    const registration = this.registrations.get(source);
    return registration ? { source, registration } : undefined;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validatePrincipal(input: VerifiedIngressPrincipal): VerifiedIngressPrincipal {
  if (!connectionIdPattern.test(input.connectionId) || !isJsonObject(input.principal)) {
    throw new ExternalIngressAuthenticationError();
  }
  return input;
}

function validateNormalized(input: NormalizedExternalEvent): NormalizedExternalEvent {
  if (
    !input.providerEventId.trim() || input.providerEventId.length > 512 ||
    !input.type.trim() || input.type.length > 128 ||
    !utcRfc3339Pattern.test(input.occurredAt) || Number.isNaN(Date.parse(input.occurredAt)) ||
    !isJsonObject(input.subject) || !isJsonObject(input.payload) ||
    (input.replyTarget !== null && !isJsonObject(input.replyTarget)) ||
    (input.trace !== undefined && !isJsonObject(input.trace))
  ) {
    throw new ExternalIngressValidationError();
  }
  return input;
}

function validateAcknowledgement(input: ExternalIngressAcknowledgement): ExternalIngressAcknowledgement {
  if (!Number.isInteger(input.statusCode) || input.statusCode < 200 || input.statusCode > 299 || !isJsonObject(input.body)) {
    throw new ExternalIngressAcknowledgementError();
  }
  if (input.headers && Object.entries(input.headers).some(([name, value]) =>
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
    reservedAcknowledgementHeaders.has(name.toLowerCase()) ||
    /[\r\n]/.test(value))) {
    throw new ExternalIngressAcknowledgementError();
  }
  return input;
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ExternalIngressTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ExternalIngressProcessor {
  constructor(private readonly registry: ExternalIngressRegistry) {}

  registration(source: string) {
    return this.registry.get(source);
  }

  async process(
    source: ExternalEventSource,
    registration: ExternalEventSourceRegistration,
    request: RawIngressRequest,
    persist: (envelope: EventEnvelope) => EnqueueResult,
  ): Promise<ExternalIngressResult> {
    let verified: VerifiedIngressPrincipal;
    try {
      verified = validatePrincipal(await within(Promise.resolve(registration.authenticate(request)), registration.processingTimeoutMs));
    } catch (error) {
      if (error instanceof ExternalIngressTimeoutError) throw error;
      throw new ExternalIngressAuthenticationError();
    }

    let normalized: NormalizedExternalEvent;
    try {
      const candidate = await within(
        Promise.resolve(registration.normalize(request, verified)),
        registration.processingTimeoutMs,
      );
      normalized = validateNormalized(registration.parseNormalized(candidate));
    } catch (error) {
      if (error instanceof ExternalIngressTimeoutError) throw error;
      throw new ExternalIngressValidationError();
    }

    const envelope: EventEnvelope = {
      schema_version: 1,
      source,
      external_event_id: scopedExternalEventId(source, verified.connectionId, normalized.providerEventId),
      type: normalized.type,
      occurred_at: normalized.occurredAt,
      subject: normalized.subject,
      payload: normalized.payload,
      reply_target: normalized.replyTarget,
      ...(normalized.trace === undefined ? {} : { trace: normalized.trace }),
    };
    const result = persist(envelope);
    const receipt: PersistReceipt = {
      schemaVersion: 1,
      eventId: result.row.event_id,
      sequence: result.row.sequence,
      source,
      externalEventId: result.row.external_event_id,
      outcome: result.outcome,
      committedAt: result.row.created_at,
    };
    if (result.outcome === "duplicate_conflict") return { receipt, acknowledgement: null };

    let acknowledgement: ExternalIngressAcknowledgement;
    try {
      acknowledgement = validateAcknowledgement(registration.buildAcknowledgement(receipt));
    } catch {
      throw new ExternalIngressAcknowledgementError();
    }
    return { receipt, acknowledgement };
  }
}
