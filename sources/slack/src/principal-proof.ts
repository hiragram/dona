import { createHash, createHmac, randomBytes } from "node:crypto";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function utcSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function principalProofKeyId(key: string): string {
  return `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

export function signSlackPrincipalProof(
  envelope: Record<string, unknown>,
  attempt: number,
  key: string,
  now = new Date(),
  nonce = randomBytes(18).toString("base64url"),
): { proof: string; signature: string } {
  const subject = envelope.subject as Record<string, unknown> | undefined;
  if (envelope.source !== "slack" || typeof envelope.external_event_id !== "string"
    || typeof subject?.workspace_id !== "string" || typeof subject.actor_id !== "string"
    || !Number.isSafeInteger(attempt) || attempt < 1 || !key) throw new Error("invalid_slack_principal_input");
  const proof = {
    version: 1,
    key_id: principalProofKeyId(key),
    event_id: envelope.external_event_id,
    attempt,
    tenant_id: subject.workspace_id,
    workspace_id: subject.workspace_id,
    principal_kind: "human",
    principal_id: subject.actor_id,
    issued_at: utcSeconds(now),
    expires_at: utcSeconds(new Date(now.getTime() + 120_000)),
    nonce,
  };
  const raw = JSON.stringify(canonical(proof));
  return {
    proof: Buffer.from(raw, "utf8").toString("base64url"),
    signature: createHmac("sha256", key).update(raw, "utf8").digest("base64url"),
  };
}
