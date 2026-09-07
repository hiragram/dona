import type { QueueAdmissionContext, AdmissionCode } from "./queue.js";
import { createHash } from "node:crypto";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { performance } from "node:perf_hooks";
import { eventOwnerSchema } from "./event-routing.js";
import type { ProviderOwner } from "./event-routing.js";

import type { EnqueueResult, EventEnvelope, ExternalEventSource } from "./types.js";

import { deliverySchema, type DeliveryBinding } from "./connections/domain.js";

const externalSourcePattern = /^[a-z][a-z0-9._-]{0,63}$/;
const connectionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const utcRfc3339Pattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;
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
  readonly requestTarget: string;
  readonly receivedAt: string;
}

export interface VerifiedIngressPrincipal {
  readonly connectionId: string;
  readonly principal: Readonly<Record<string, unknown>>;
  readonly connection?: Omit<DeliveryBinding, "connectionId">;
  readonly resourceId?: string;
}
type IngressPersistenceContext = QueueAdmissionContext & { readonly binding?: DeliveryBinding; readonly owner?: ProviderOwner };

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
  readonly admission?: AdmissionCode;
  readonly ackAllowed?: boolean;
}

export interface ExternalIngressAcknowledgement {
  readonly statusCode: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
}

export interface PreparedExternalIngressAcknowledgement {
  readonly statusCode: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly encodedBody: Buffer;
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
  queueSignal?(event: NormalizedExternalEvent, verified: VerifiedIngressPrincipal): QueueAdmissionContext["coalesce"];
  buildAcknowledgement(receipt: PersistReceipt): ExternalIngressAcknowledgement;
}

export interface ExternalIngressResult {
  readonly receipt: PersistReceipt;
  readonly acknowledgement: PreparedExternalIngressAcknowledgement | null;
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

function isJsonCompatible(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string") || keys.length !== value.length + 1) return false;
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor) || !isJsonCompatible(descriptor.value, ancestors)) {
          return false;
        }
      }
      return true;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor) || !isJsonCompatible(descriptor.value, ancestors)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

function validatePrincipal(input: VerifiedIngressPrincipal): VerifiedIngressPrincipal {
  if (typeof input.connectionId !== "string" ||
    !connectionIdPattern.test(input.connectionId) || !isJsonObject(input.principal)) {
    throw new ExternalIngressAuthenticationError();
  }
  return input;
}

function isUtcRfc3339Timestamp(value: string): boolean {
  const match = utcRfc3339Pattern.exec(value);
  if (!match) return false;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return false;
  const parsed = new Date(timestamp);
  return parsed.getUTCFullYear() === Number(match[1]) &&
    parsed.getUTCMonth() + 1 === Number(match[2]) &&
    parsed.getUTCDate() === Number(match[3]) &&
    parsed.getUTCHours() === Number(match[4]) &&
    parsed.getUTCMinutes() === Number(match[5]) &&
    parsed.getUTCSeconds() === Number(match[6]);
}

export function validateNormalizedExternalEvent(input: NormalizedExternalEvent): NormalizedExternalEvent {
  if (
    !input.providerEventId.trim() || input.providerEventId.length > 512 ||
    !input.type.trim() || input.type.length > 128 ||
    !isUtcRfc3339Timestamp(input.occurredAt) ||
    !isJsonObject(input.subject) || !isJsonObject(input.payload) ||
    (input.replyTarget !== null && !isJsonObject(input.replyTarget)) ||
    (input.trace !== undefined && !isJsonObject(input.trace)) ||
    !isJsonCompatible(input.subject) || !isJsonCompatible(input.payload) ||
    (input.replyTarget !== null && !isJsonCompatible(input.replyTarget)) ||
    (input.trace !== undefined && !isJsonCompatible(input.trace))
  ) {
    throw new ExternalIngressValidationError();
  }
  return input;
}

function validateAcknowledgement(input: ExternalIngressAcknowledgement): PreparedExternalIngressAcknowledgement {
  if (
    !Number.isInteger(input.statusCode) || input.statusCode < 200 || input.statusCode > 299 ||
    input.statusCode === 204 || input.statusCode === 205 || !isJsonObject(input.body)
  ) {
    throw new ExternalIngressAcknowledgementError();
  }
  const headers: Record<string, string> = {};
  if (input.headers !== undefined) {
    if (!isJsonObject(input.headers)) throw new ExternalIngressAcknowledgementError();
    for (const [name, value] of Object.entries(input.headers)) {
      if (
        typeof value !== "string" || reservedAcknowledgementHeaders.has(name.toLowerCase())
      ) {
        throw new ExternalIngressAcknowledgementError();
      }
      try {
        validateHeaderName(name);
        validateHeaderValue(name, value);
      } catch {
        throw new ExternalIngressAcknowledgementError();
      }
      headers[name] = value;
    }
  }
  let encodedBody: Buffer;
  try {
    const serialized = JSON.stringify(input.body);
    if (serialized === undefined) throw new Error("Acknowledgement body is not JSON serializable");
    encodedBody = Buffer.from(serialized);
  } catch {
    throw new ExternalIngressAcknowledgementError();
  }
  return {
    statusCode: input.statusCode,
    ...(Object.keys(headers).length === 0 ? {} : { headers: Object.freeze(headers) }),
    encodedBody,
  };
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

function remainingProcessingTime(deadline: number): number {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new ExternalIngressTimeoutError();
  return remaining;
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
    persist: (envelope: EventEnvelope, context: IngressPersistenceContext) => EnqueueResult,
  ): Promise<ExternalIngressResult> {
    const processingDeadline = performance.now() + registration.processingTimeoutMs;
    let verified: VerifiedIngressPrincipal;
    let verifiedBinding: DeliveryBinding | undefined;
    try {
      const authenticated = await within(
        Promise.resolve().then(() => registration.authenticate(request)),
        remainingProcessingTime(processingDeadline),
      );
      verified = validatePrincipal(authenticated);
      verifiedBinding = verified.connection === undefined ? undefined : deliverySchema.parse({
        ...verified.connection,
        connectionId: verified.connectionId,
      });
      remainingProcessingTime(processingDeadline);
    } catch (error) {
      if (error instanceof ExternalIngressTimeoutError) throw error;
      throw new ExternalIngressAuthenticationError();
    }

    const verifiedConnectionId = verified.connectionId;
    let owner: ProviderOwner | undefined;
    if (verifiedBinding && verified.resourceId !== undefined && verified.resourceId !== verifiedBinding.resource) throw new ExternalIngressAuthenticationError();
    const verifiedResourceId = verifiedBinding?.resource ?? verified.resourceId;
    if (verifiedResourceId !== undefined) {
      const parsed = eventOwnerSchema.safeParse({ kind: "provider_resource", source,
        connection_id: verifiedConnectionId, resource_id: verifiedResourceId });
      if (!parsed.success || parsed.data.kind !== "provider_resource") throw new ExternalIngressAuthenticationError();
      owner = parsed.data;
    }
    let normalized: NormalizedExternalEvent;
    try {
      const candidate = await within(
        Promise.resolve().then(() => registration.normalize(request, verified)),
        remainingProcessingTime(processingDeadline),
      );
      normalized = validateNormalizedExternalEvent(registration.parseNormalized(candidate));
      remainingProcessingTime(processingDeadline);
    } catch (error) {
      if (error instanceof ExternalIngressTimeoutError) throw error;
      throw new ExternalIngressValidationError();
    }

    const envelope: EventEnvelope = {
      schema_version: 1,
      source,
      external_event_id: scopedExternalEventId(source, verifiedConnectionId, normalized.providerEventId),
      type: normalized.type,
      occurred_at: normalized.occurredAt,
      subject: normalized.subject,
      payload: normalized.payload,
      reply_target: normalized.replyTarget,
      ...(normalized.trace === undefined ? {} : { trace: normalized.trace }),
    };
    if (owner && envelope.reply_target !== null) throw new ExternalIngressValidationError();
    const signal = registration.queueSignal?.(normalized, verified);
    const result = persist(envelope, {
      connectionId: verifiedConnectionId,
      ...(signal ? { coalesce: signal } : {}),
      ...(verifiedBinding ? { binding: verifiedBinding } : {}),
      ...(owner ? { owner } : {}),
    });
    const receipt: PersistReceipt = {
      schemaVersion: 1,
      eventId: result.row.event_id,
      sequence: result.row.sequence,
      source,
      externalEventId: envelope.external_event_id,
      outcome: result.outcome,
      committedAt: result.committedAt ?? result.row.created_at,
      admission: result.admission ?? result.outcome,
      ackAllowed: result.outcome !== "duplicate_conflict",
    };
    if (result.outcome === "duplicate_conflict") return { receipt, acknowledgement: null };

    let acknowledgement: PreparedExternalIngressAcknowledgement;
    try {
      acknowledgement = validateAcknowledgement(registration.buildAcknowledgement(receipt));
    } catch {
      throw new ExternalIngressAcknowledgementError();
    }
    return { receipt, acknowledgement };
  }
}
