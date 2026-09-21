import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { EventEnvelope } from "./types.js";
import { stableStringify } from "./validation.js";

const utcSeconds = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
const identity = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const proofSchema = z.strictObject({
  version: z.literal(1),
  key_id: z.string().regex(/^sha256:[0-9a-f]{16}$/),
  event_id: identity,
  attempt: z.number().int().positive().max(1_000_000),
  tenant_id: identity,
  workspace_id: identity,
  principal_kind: z.literal("human"),
  principal_id: identity,
  issued_at: utcSeconds,
  expires_at: utcSeconds,
  nonce: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
});

export type SlackPrincipalProof = z.infer<typeof proofSchema>;
export interface VerifiedSlackPrincipalProof extends SlackPrincipalProof {
  adapter_id: string;
  proof_sha256: string;
}

export class PrincipalProofError extends Error {
  constructor(readonly code: "principal_proof_missing" | "principal_proof_invalid" | "principal_proof_expired" | "principal_proof_identity_mismatch") {
    super(code);
    this.name = "PrincipalProofError";
  }
}

export function principalProofKeyId(key: string): string {
  return `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function singleHeader(value: string | string[] | undefined): string {
  if (typeof value !== "string" || value.length === 0) throw new PrincipalProofError("principal_proof_missing");
  return value;
}

export function verifySlackPrincipalProof(
  envelope: EventEnvelope,
  proofHeader: string | string[] | undefined,
  signatureHeader: string | string[] | undefined,
  key: string,
  now = new Date(),
): VerifiedSlackPrincipalProof {
  if (envelope.source !== "slack") throw new PrincipalProofError("principal_proof_identity_mismatch");
  const encoded = singleHeader(proofHeader);
  const signature = singleHeader(signatureHeader);
  let raw: string;
  try {
    raw = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(raw, "utf8").toString("base64url") !== encoded) throw new Error("non-canonical base64url");
  } catch {
    throw new PrincipalProofError("principal_proof_invalid");
  }
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new PrincipalProofError("principal_proof_invalid");
  }
  if (stableStringify(input) !== raw) throw new PrincipalProofError("principal_proof_invalid");
  const parsed = proofSchema.safeParse(input);
  if (!parsed.success || parsed.data.key_id !== principalProofKeyId(key)) {
    throw new PrincipalProofError("principal_proof_invalid");
  }
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); } catch { throw new PrincipalProofError("principal_proof_invalid"); }
  const expected = createHmac("sha256", key).update(raw, "utf8").digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new PrincipalProofError("principal_proof_invalid");
  }
  const issued = Date.parse(parsed.data.issued_at), expires = Date.parse(parsed.data.expires_at), current = now.getTime();
  if (issued > current || current >= expires || expires - issued <= 0 || expires - issued > 120_000) {
    throw new PrincipalProofError("principal_proof_expired");
  }
  const subject = envelope.subject;
  const attempt = envelope.trace?.ingress_attempt;
  if (parsed.data.event_id !== envelope.external_event_id || parsed.data.attempt !== attempt
    || parsed.data.tenant_id !== subject.workspace_id || parsed.data.workspace_id !== subject.workspace_id
    || parsed.data.principal_id !== subject.actor_id) {
    throw new PrincipalProofError("principal_proof_identity_mismatch");
  }
  return {
    ...parsed.data,
    adapter_id: `slack_socket:${parsed.data.workspace_id}`,
    proof_sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
  };
}
