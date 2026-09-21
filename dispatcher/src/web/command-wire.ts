import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ServiceScope, WebServiceCredentialLookup } from "./service-auth.js";

export const webCommandServicePath = "/v1/web/command";
export const webCommandServiceHost = "dona-web-command";
export const maximumWebCommandBodyBytes = 131072;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const browserBody = z.string().min(1).max(180000).refine(value => {
  try { return Buffer.from(value, "base64url").toString("base64url") === value && Buffer.from(value, "base64url").byteLength <= 65536; }
  catch { return false; }
});
export const webCommandInputSchema = z.strictObject({ codec_version: z.literal(1), operation: z.enum(["submit", "cancel"]),
  method: z.literal("POST"), target: z.string().min(1).max(256), context: z.string().min(1).max(8192),
  browser_body: browserBody, idempotency_key: digest });
export type WebCommandInput = z.infer<typeof webCommandInputSchema>;
const projection = z.strictObject({ job_id: id, status: z.string().min(1).max(32) });
export const webCommandResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("succeeded"), outcome: z.enum(["created", "reused", "cancelled", "already_cancelled"]),
    receipt_id: z.string().min(1).max(96), job: projection }),
  z.strictObject({ status: z.literal("denied"), reason: z.enum(["invalid_request", "identity_unavailable", "scope_denied",
    "idempotency_conflict", "quota_exceeded", "not_found", "owner_mismatch", "terminal", "scheduled_policy", "acceptance_unknown"]) }),
]);
export type WebCommandResult = z.infer<typeof webCommandResultSchema>;
export class WebCommandWireError extends Error { constructor() { super("web_command_unverified"); this.name = "WebCommandWireError"; } }
const claimsSchema = z.strictObject({ codec_version: z.literal(1), key_version: z.number().int().min(1), instance_id: id, tenant_id: id,
  body_digest: digest, issued_at: z.string().datetime(), expires_at: z.string().datetime(), nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function parseWebCommandInput(raw: string): WebCommandInput {
  try { if (Buffer.byteLength(raw) > maximumWebCommandBodyBytes) throw Error(); const value = webCommandInputSchema.parse(JSON.parse(raw));
    if (JSON.stringify(value) !== raw) throw Error(); return value; } catch { throw new WebCommandWireError(); }
}
export function verifyWebCommandProof(proof: string, raw: string, scope: ServiceScope, lookup: WebServiceCredentialLookup, now: string): void {
  try {
    const parts = proof.split("."); if (parts.length !== 2) throw Error();
    const text = Buffer.from(parts[0]!, "base64url").toString("utf8"), claims = claimsSchema.parse(JSON.parse(text));
    if (Buffer.from(parts[0]!, "base64url").toString("base64url") !== parts[0] || JSON.stringify(claims) !== text) throw Error();
    const credential = lookup(claims.key_version), at = Date.parse(now), issued = Date.parse(claims.issued_at), expires = Date.parse(claims.expires_at);
    if (!credential || credential.purpose !== "web_bff_service" || credential.state === "revoked" || credential.instance_id !== scope.instance_id
      || credential.tenant_id !== scope.tenant_id || claims.instance_id !== scope.instance_id || claims.tenant_id !== scope.tenant_id
      || claims.body_digest !== hash(raw) || at < issued || at >= expires || expires - issued > 10000
      || issued < Date.parse(credential.activated_at) || issued >= Date.parse(credential.signing_expires_at)) throw Error();
    const actual = Buffer.from(parts[1]!, "base64url"), expected = createHmac("sha256", credential.secret)
      .update("dona.web-command.request.v1\0").update(parts[0]!).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
  } catch { throw new WebCommandWireError(); }
}
