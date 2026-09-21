import { createHmac, randomUUID } from "node:crypto";

import type { SlackCurrentAccessEvidence } from "./current-access.js";

function utcSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function signSlackAccessReceipt(
  evidence: SlackCurrentAccessEvidence,
  key: string,
  now = new Date(),
  nonce: string = randomUUID(),
): string {
  if (key.length < 32) throw new Error("Slack access receipt signing key is invalid");
  const payload = Buffer.from(JSON.stringify({
    ...evidence,
    issued_at: utcSeconds(now),
    expires_at: utcSeconds(new Date(now.getTime() + 120_000)),
    nonce,
    consumed: false,
  })).toString("base64url");
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}
