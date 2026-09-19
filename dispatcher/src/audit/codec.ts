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
  resource_id: opaqueId.nullable(),
  outcome: z.enum(["allowed", "denied", "pending", "succeeded", "failed", "acceptance_unknown", "needs_review"]),
  reason: z.enum([
    "none", "unauthenticated", "unauthorized", "expired", "revoked", "identity_mismatch",
    "scope_mismatch", "revision_mismatch", "snapshot_mismatch", "already_consumed",
    "invalid_input", "unavailable", "clock_anomaly", "response_lost", "integrity_failure",
  ]),
  session_ref: opaqueId.nullable(),
  receipt_id: opaqueId.nullable(),
  attempt_id: opaqueId.nullable(),
  policy_revision: integer,
  binding_revision: integer,
  role_revision: integer,
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

const recordBodySchema = z.strictObject({
  codec_version: z.literal(1),
  chain_id: opaqueId,
  sequence: integer.min(1),
  transaction_id: opaqueId,
  previous_mac: digest,
  key_version: integer.min(1),
  event: auditEventSchema,
});
const recordSchema = recordBodySchema.extend({ record_digest: digest, mac: digest });
export type AuditRecord = z.infer<typeof recordSchema>;

const checkpointBodySchema = z.strictObject({
  codec_version: z.literal(1),
  chain_id: opaqueId,
  // The checkpoint authenticates the last removed record (zero at genesis).
  sequence: integer,
  through_mac: digest,
  through_occurred_at: utc.nullable(),
  signed_at: utc,
  key_version: integer.min(1),
});
const checkpointSchema = checkpointBodySchema.extend({ mac: digest });
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

export function signAuditRecord(input: Omit<AuditRecord, "record_digest" | "mac">, lookup: AuditKeyLookup): AuditRecord {
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

function checkCheckpointBoundary(body: Omit<AuditCheckpoint, "mac">): void {
  if (body.sequence === 0) {
    if (body.through_mac !== zeroMac || body.through_occurred_at !== null) throw new AuditIntegrityError();
  } else if (body.through_occurred_at === null || Date.parse(body.through_occurred_at) > Date.parse(body.signed_at)) {
    throw new AuditIntegrityError();
  }
}

// Provisioning/retention must independently authorize and CAS-anchor this checkpoint.
// This function only signs bytes; it does not initialize or change the trusted anchor.
export function signAuditCheckpoint(input: Omit<AuditCheckpoint, "mac">, lookup: AuditKeyLookup): AuditCheckpoint {
  return protect(() => {
    const body = checkpointBodySchema.parse(input);
    checkCheckpointBoundary(body);
    return { ...body, mac: mac(checkedKey(lookup, body.key_version, body.signed_at), "checkpoint", body) };
  });
}

// `anchor` must be a fresh integrity-verified read from the DB/backup-external CAS store.
// A DB row or cached anchor cannot be used as this trust root.
export function verifyAuditChain(
  checkpointInput: unknown,
  records: Iterable<unknown>,
  anchorInput: unknown,
  lookup: AuditKeyLookup,
): AuditAnchor {
  return protect(() => {
    const checkpoint = checkpointSchema.parse(checkpointInput);
    const anchor = auditAnchorSchema.parse(anchorInput);
    const { mac: checkpointMac, ...checkpointBody } = checkpoint;
    checkCheckpointBoundary(checkpointBody);
    const checkpointKey = checkedKey(lookup, checkpoint.key_version);
    const signedAt = Date.parse(checkpoint.signed_at);
    if (signedAt < Date.parse(checkpointKey.activated_at) || signedAt >= Date.parse(checkpointKey.signing_expires_at)) throw new AuditIntegrityError();
    if (anchor.pending_transaction_id !== null || checkpoint.chain_id !== anchor.chain_id
      || !sameMac(checkpointMac, anchor.checkpoint_mac)
      || !sameMac(checkpointMac, mac(checkpointKey, "checkpoint", checkpointBody))
      || (checkpoint.sequence === 0 && checkpoint.through_mac !== zeroMac)) throw new AuditIntegrityError();
    let sequence = checkpoint.sequence;
    let previousMac = checkpoint.through_mac;
    let lastTime = checkpoint.through_occurred_at === null ? -Infinity : Date.parse(checkpoint.through_occurred_at);
    for (const input of records) {
      const record = verifyAuditRecord(input, lookup);
      const at = Date.parse(record.event.occurred_at);
      if (record.chain_id !== anchor.chain_id || sequence === Number.MAX_SAFE_INTEGER
        || record.sequence !== sequence + 1 || !sameMac(record.previous_mac, previousMac)
        || at < lastTime) throw new AuditIntegrityError();
      sequence = record.sequence;
      previousMac = record.mac;
      lastTime = at;
    }
    if (sequence !== anchor.sequence || !sameMac(previousMac, anchor.mac)) throw new AuditIntegrityError();
    return anchor;
  });
}
