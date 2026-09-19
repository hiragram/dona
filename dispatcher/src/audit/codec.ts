import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// These values come from persisted server-side identities, never from display text.
const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const utc = z.string().refine((value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
});
const scope = z.strictObject({ instance_id: opaqueId, tenant_id: opaqueId });
const actor = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unauthenticated"), id: z.null() }),
  z.strictObject({ kind: z.enum(["principal", "supervisor", "operator", "system"]), id: opaqueId }),
]);

export const auditEventSchema = z.strictObject({
  occurred_at: utc,
  scope,
  actor,
  action: z.enum([
    "approval_request", "approval_decision", "approval_consume", "approval_execution",
    "approval_delivery", "binding_change", "policy_change", "identity_change",
    "web_login", "web_logout", "web_authorize", "web_command", "retention",
  ]),
  operation: z.enum([
    "web.login.v1", "web.logout.v1", "web.job_list.v1", "web.job_read.v1", "web.job_submit.v1",
    "web.job_cancel.v1", "web.receipt_read.v1", "web.sse_subscribe.v1", "web.approval_list.v1",
    "web.approval_read.v1", "approval.approve.v1", "approval.reject.v1", "approval.cancel.v1",
    "approval.consume.v1", "slack.post_thread_reply.v1", "binding.change.v1", "policy.change.v1",
    "identity.change.v1", "credential.change.v1", "audit.retain.v1", "unsupported",
  ]),
  resource_id: opaqueId.nullable(),
  outcome: z.enum(["allowed", "denied", "pending", "succeeded", "failed", "acceptance_unknown", "needs_review"]),
  reason: z.enum([
    "none", "unauthenticated", "unauthorized", "expired", "revoked", "identity_mismatch",
    "scope_mismatch", "revision_mismatch", "snapshot_mismatch", "already_consumed",
    "invalid_input", "unavailable", "clock_anomaly", "response_lost", "integrity_failure",
    "session_invalid", "resource_not_visible", "scope_denied", "operation_unsupported",
    "execution_safe_off", "job_kind_unsupported", "quota_exceeded", "deployment_invalid",
    "origin_invalid", "csrf_invalid", "step_up_required", "session_revoked", "session_expired",
    "identity_invalid", "identity_unavailable", "durability_unavailable", "cookie_ambiguous", "cookie_invalid",
    "challenge_consumed", "action_binding_mismatch", "presentation_stale", "proof_invalid",
    "binding_revoked", "approval_expired", "decision_conflict", "consume_expired", "idempotency_conflict",
    "audit_integrity_failed", "approval_safe_off", "credential_registration_denied",
    "credential_counter_invalid", "authorization_proof_invalid",
  ]),
  session_ref: opaqueId.nullable(),
  receipt_id: opaqueId.nullable(),
  attempt_id: opaqueId.nullable(),
  policy_revision: integer,
  binding_revision: integer,
  authz_revision: integer,
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

const recordBodyV1Schema = z.strictObject({
  codec_version: z.literal(1),
  chain_id: opaqueId,
  sequence: integer.min(1),
  transaction_id: opaqueId,
  previous_mac: digest,
  key_version: integer.min(1),
  event: auditEventSchema,
});
const recordBodyV2Schema = recordBodyV1Schema.extend({ codec_version: z.literal(2), resource_digest: digest,
  event: auditEventSchema.refine(event => event.resource_id !== null) });
const recordBodySchema = z.discriminatedUnion("codec_version", [recordBodyV1Schema, recordBodyV2Schema]);
const recordSchema = z.discriminatedUnion("codec_version", [
  recordBodyV1Schema.extend({ record_digest: digest, mac: digest }),
  recordBodyV2Schema.extend({ record_digest: digest, mac: digest }),
]);
export type AuditRecordSigningInput = z.infer<typeof recordBodySchema>;
export type AuditRecord = z.infer<typeof recordSchema>;

const checkpointBodySchema = z.strictObject({
  codec_version: z.literal(1),
  chain_id: opaqueId,
  transaction_id: opaqueId,
  // The checkpoint authenticates the last removed record (zero at genesis).
  sequence: integer,
  through_mac: digest,
  through_occurred_at: utc.nullable(),
  signed_at: utc,
  key_version: integer.min(1),
});
// Resource digests bind bounded aggregate metadata roots, not individual jobs or
// lifetime principal entries. Exceeding this bound fails before anchor reserve.
export const maximumAuditResourceRoots = 64;
const resourceBindingSchema = z.strictObject({
  scope, resource_id: opaqueId, sequence: integer.min(1), resource_digest: digest,
});
export type AuditResourceBinding = z.infer<typeof resourceBindingSchema>;
const checkpointBodyV2Schema = checkpointBodySchema.extend({
  codec_version: z.literal(2), resource_bindings: z.array(resourceBindingSchema).max(maximumAuditResourceRoots),
});
const checkpointSchema = z.discriminatedUnion("codec_version", [
  checkpointBodySchema.extend({ mac: digest }), checkpointBodyV2Schema.extend({ mac: digest }),
]);
export type AuditCheckpoint = z.infer<typeof checkpointSchema>;

export const auditAnchorSchema = z.strictObject({
  chain_id: opaqueId,
  sequence: integer,
  mac: digest,
  checkpoint_mac: digest,
  pending_transaction_id: opaqueId.nullable(),
});
export type AuditAnchor = z.infer<typeof auditAnchorSchema>;

export interface AuditKey {
  version: number;
  purpose: "audit";
  state: "active" | "verification_only" | "revoked";
  activated_at: string;
  signing_expires_at: string;
  // Supplied by the protected credential store; never persisted in the audit DB.
  secret: Uint8Array;
}
export type AuditKeyLookup = (version: number) => AuditKey | undefined;

export class AuditIntegrityError extends Error {
  constructor() {
    // Do not copy schema errors, input, key material, or provider errors into logs.
    super("audit_integrity_unverified");
    this.name = "AuditIntegrityError";
  }
}

const zeroMac = "0".repeat(64);
const signingLifetimeMs = 90 * 24 * 60 * 60 * 1000;

// Input is schema-validated before canonicalization. Arrays retain semantic order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function protect<T>(operation: () => T): T {
  try { return operation(); } catch { throw new AuditIntegrityError(); }
}
function sameMac(actual: string, expected: string): boolean {
  return timingSafeEqual(Buffer.from(digest.parse(actual), "hex"), Buffer.from(digest.parse(expected), "hex"));
}
function checkedKey(lookup: AuditKeyLookup, version: number, signingAt?: string): AuditKey {
  const key = lookup(version);
  if (!key || key.version !== version || key.purpose !== "audit" || key.state === "revoked"
    || !["active", "verification_only"].includes(key.state)
    || !(key.secret instanceof Uint8Array) || key.secret.byteLength < 32) throw new AuditIntegrityError();
  const activated = Date.parse(utc.parse(key.activated_at));
  const expires = Date.parse(utc.parse(key.signing_expires_at));
  if (expires <= activated || expires - activated > signingLifetimeMs) throw new AuditIntegrityError();
  if (signingAt !== undefined) {
    const at = Date.parse(utc.parse(signingAt));
    if (key.state !== "active" || at < activated || at >= expires) throw new AuditIntegrityError();
  }
  return key;
}
function mac(key: AuditKey, purpose: string, body: unknown): string {
  return createHmac("sha256", key.secret).update(`dona.audit.${purpose}.v1\0`, "utf8")
    .update(canonical(body), "utf8").digest("hex");
}

export function signAuditRecord(input: AuditRecordSigningInput, lookup: AuditKeyLookup): AuditRecord {
  return protect(() => {
    const body = recordBodySchema.parse(input);
    const key = checkedKey(lookup, body.key_version, body.event.occurred_at);
    const record_digest = createHash("sha256").update(canonical(body), "utf8").digest("hex");
    return { ...body, record_digest, mac: mac(key, "record", { ...body, record_digest }) };
  });
}

export function verifyAuditRecord(input: unknown, lookup: AuditKeyLookup): AuditRecord {
  return protect(() => {
    const record = recordSchema.parse(input);
    const { mac: storedMac, record_digest: storedDigest, ...body } = record;
    const key = checkedKey(lookup, body.key_version);
    const at = Date.parse(body.event.occurred_at);
    if (at < Date.parse(key.activated_at) || at >= Date.parse(key.signing_expires_at)) throw new AuditIntegrityError();
    const computedDigest = createHash("sha256").update(canonical(body), "utf8").digest("hex");
    if (!sameMac(storedDigest, computedDigest) || !sameMac(storedMac, mac(key, "record", { ...body, record_digest: storedDigest }))) {
      throw new AuditIntegrityError();
    }
    return record;
  });
}

function resourceKey(binding: Pick<AuditResourceBinding, "scope" | "resource_id">): string {
  return JSON.stringify([binding.scope.instance_id, binding.scope.tenant_id, binding.resource_id]);
}
function checkCheckpointBoundary(body: z.infer<typeof checkpointBodySchema> | z.infer<typeof checkpointBodyV2Schema>): void {
  if (body.codec_version === 2) {
    let previous: string | undefined;
    for (const binding of body.resource_bindings) {
      const key = resourceKey(binding);
      if (binding.sequence > body.sequence || (previous !== undefined && key <= previous)) throw new AuditIntegrityError();
      previous = key;
    }
  }
  if (body.sequence === 0) {
    if (body.through_mac !== zeroMac || body.through_occurred_at !== null) throw new AuditIntegrityError();
  } else if (body.through_occurred_at === null || Date.parse(body.through_occurred_at) > Date.parse(body.signed_at)) {
    throw new AuditIntegrityError();
  }
}

// Provisioning/retention must independently authorize and CAS-anchor this checkpoint.
// This function only signs bytes; it does not initialize or change the trusted anchor.
const checkpointSigningSchema = checkpointBodySchema.pick({
  codec_version: true, chain_id: true, transaction_id: true, key_version: true, signed_at: true,
});
export type AuditCheckpointSigningInput = z.infer<typeof checkpointSigningSchema>;

export function signAuditCheckpoint(input: AuditCheckpointSigningInput, lookup: AuditKeyLookup, boundaryInput?: unknown): AuditCheckpoint {
  return protect(() => {
    const signing = checkpointSigningSchema.parse(input);
    const boundary = boundaryInput === undefined ? undefined : verifyAuditRecord(boundaryInput, lookup);
    if (boundary && boundary.chain_id !== signing.chain_id) throw new AuditIntegrityError();
    // Never accept independently supplied sequence/MAC/time for a retained prefix.
    const body = checkpointBodySchema.parse({ ...signing, sequence: boundary?.sequence ?? 0,
      through_mac: boundary?.mac ?? zeroMac, through_occurred_at: boundary?.event.occurred_at ?? null });
    checkCheckpointBoundary(body);
    return { ...body, mac: mac(checkedKey(lookup, body.key_version, body.signed_at), "checkpoint", body) };
  });
}

export interface VerifiedAuditState {
  anchor: AuditAnchor;
  resource_bindings: AuditResourceBinding[];
}
function sortedBindings(bindings: Map<string, AuditResourceBinding>): AuditResourceBinding[] {
  return [...bindings.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
}

// Internal traversal validates the entire chain before releasing either current
// metadata roots or a captured retention boundary. A boundary is never trusted
// merely because its record has a valid standalone MAC.
function verifyState(checkpointInput: unknown, records: Iterable<unknown>, anchorInput: unknown,
  lookup: AuditKeyLookup, options: { throughSequence?: number; requireResourceCompleteness: boolean }): VerifiedAuditState & {
    boundary: AuditRecord | undefined; retained_bindings: AuditResourceBinding[] | undefined;
  } {
  const checkpoint = checkpointSchema.parse(checkpointInput);
  // A legacy retained prefix may have removed v2 roots without recording them.
  // Even an otherwise valid chain cannot establish that these roots are absent.
  if (options.requireResourceCompleteness && checkpoint.codec_version === 1 && checkpoint.sequence !== 0) throw new AuditIntegrityError();
  const throughSequence = options.throughSequence;
  const anchor = auditAnchorSchema.parse(anchorInput);
  const { mac: checkpointMac, ...checkpointBody } = checkpoint;
  checkCheckpointBoundary(checkpointBody);
  const checkpointKey = checkedKey(lookup, checkpoint.key_version);
  const signedAt = Date.parse(checkpoint.signed_at);
  if (signedAt < Date.parse(checkpointKey.activated_at) || signedAt >= Date.parse(checkpointKey.signing_expires_at)) throw new AuditIntegrityError();
  if (anchor.pending_transaction_id !== null || checkpoint.chain_id !== anchor.chain_id
    || !sameMac(checkpointMac, anchor.checkpoint_mac)
    || !sameMac(checkpointMac, mac(checkpointKey, "checkpoint", checkpointBody))) throw new AuditIntegrityError();
  if (throughSequence !== undefined && (!Number.isSafeInteger(throughSequence)
    || throughSequence <= checkpoint.sequence || throughSequence > anchor.sequence)) throw new AuditIntegrityError();
  const bindings = new Map<string, AuditResourceBinding>();
  if (checkpoint.codec_version === 2) for (const binding of checkpoint.resource_bindings) bindings.set(resourceKey(binding), binding);
  let sequence = checkpoint.sequence;
  let previousMac = checkpoint.through_mac;
  let lastTime = Date.parse(checkpoint.through_occurred_at ?? checkpoint.signed_at);
  let boundary: AuditRecord | undefined;
  let retained_bindings: AuditResourceBinding[] | undefined;
  for (const input of records) {
    const record = verifyAuditRecord(input, lookup);
    const at = Date.parse(record.event.occurred_at);
    if (record.chain_id !== anchor.chain_id || sequence === Number.MAX_SAFE_INTEGER
      || record.sequence !== sequence + 1 || !sameMac(record.previous_mac, previousMac)
      || at < lastTime) throw new AuditIntegrityError();
    sequence = record.sequence; previousMac = record.mac; lastTime = at;
    if (record.codec_version === 2) {
      const binding = resourceBindingSchema.parse({ scope: record.event.scope, resource_id: record.event.resource_id,
        sequence: record.sequence, resource_digest: record.resource_digest });
      bindings.set(resourceKey(binding), binding);
      if (bindings.size > maximumAuditResourceRoots) throw new AuditIntegrityError();
    }
    if (record.sequence === throughSequence) { boundary = record; retained_bindings = sortedBindings(bindings); }
  }
  if (sequence !== anchor.sequence || !sameMac(previousMac, anchor.mac)) throw new AuditIntegrityError();
  if (throughSequence !== undefined && (!boundary || !retained_bindings)) throw new AuditIntegrityError();
  return { anchor, resource_bindings: sortedBindings(bindings), boundary, retained_bindings };
}

/** The anchor must be a fresh integrity-verified DB/backup-external CAS read.
 * Returns metadata commitments only; callers must compare actual canonical state
 * from the same verified database snapshot before authorizing any decision. */
export function verifyAuditState(checkpointInput: unknown, records: Iterable<unknown>, anchorInput: unknown,
  lookup: AuditKeyLookup): VerifiedAuditState {
  return protect(() => { const { anchor, resource_bindings } = verifyState(checkpointInput, records, anchorInput, lookup, { requireResourceCompleteness: true });
    return { anchor, resource_bindings }; });
}
export function verifyAuditChain(checkpointInput: unknown, records: Iterable<unknown>, anchorInput: unknown,
  lookup: AuditKeyLookup): AuditAnchor {
  return protect(() => verifyState(checkpointInput, records, anchorInput, lookup, { requireResourceCompleteness: false }).anchor);
}

/** Retention carries the latest aggregate roots at the removed boundary, derived
 * only after complete verification to the current external anchor. Existing
 * records retain their original bytes/MACs. This does not perform retention CAS
 * or authorize retention; the repository enforces age and durable publication. */
export function signAuditRetentionCheckpoint(input: Omit<AuditCheckpointSigningInput, "codec_version">,
  lookup: AuditKeyLookup, checkpointInput: unknown, records: Iterable<unknown>, anchorInput: unknown,
  throughSequence: number): AuditCheckpoint {
  return protect(() => {
    const signing = checkpointSigningSchema.omit({ codec_version: true }).parse(input);
    const state = verifyState(checkpointInput, records, anchorInput, lookup, { throughSequence, requireResourceCompleteness: true });
    const boundary = state.boundary!;
    if (signing.chain_id !== state.anchor.chain_id) throw new AuditIntegrityError();
    const body = checkpointBodyV2Schema.parse({ ...signing, codec_version: 2,
      sequence: boundary.sequence, through_mac: boundary.mac, through_occurred_at: boundary.event.occurred_at,
      resource_bindings: state.retained_bindings });
    checkCheckpointBoundary(body);
    return { ...body, mac: mac(checkedKey(lookup, body.key_version, body.signed_at), "checkpoint", body) };
  });
}
