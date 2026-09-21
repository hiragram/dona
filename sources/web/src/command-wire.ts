import { createHash, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import type { ServiceScope, WebServiceCredential } from "./service-auth.js";

export const webCommandServicePath = "/v1/web/command";
export const webCommandServiceHost = "dona-web-command";
export const maximumWebCommandBodyBytes = 131072;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), digest = z.string().regex(/^[0-9a-f]{64}$/);
export const webCommandInputSchema = z.strictObject({ codec_version: z.literal(1), operation: z.enum(["submit", "cancel"]),
  method: z.literal("POST"), target: z.string().min(1).max(256), context: z.string().min(1).max(8192),
  browser_body: z.string().min(1).max(180000), idempotency_key: digest });
export type WebCommandInput = z.infer<typeof webCommandInputSchema>;
export const webCommandResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("succeeded"), outcome: z.enum(["created", "reused", "cancelled", "already_cancelled"]),
    receipt_id: z.string().min(1).max(96), job: z.strictObject({ job_id: id, status: z.string().min(1).max(32) }) }),
  z.strictObject({ status: z.literal("denied"), reason: z.enum(["invalid_request", "identity_unavailable", "scope_denied",
    "idempotency_conflict", "quota_exceeded", "not_found", "owner_mismatch", "terminal", "scheduled_policy", "acceptance_unknown"]) }),
]);
export type WebCommandResult = z.infer<typeof webCommandResultSchema>;
export class WebCommandWireError extends Error { constructor() { super("web_command_unverified"); this.name = "WebCommandWireError"; } }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function encodeWebCommandInput(input: unknown): string {
  try { const raw = JSON.stringify(webCommandInputSchema.parse(input)); if (Buffer.byteLength(raw) > maximumWebCommandBodyBytes) throw Error(); return raw; }
  catch { throw new WebCommandWireError(); }
}
export function signWebCommandProof(raw: string, scope: ServiceScope, credential: WebServiceCredential, now: string): string {
  try {
    const at = Date.parse(now); if (credential.purpose !== "web_bff_service" || credential.state !== "active"
      || credential.instance_id !== scope.instance_id || credential.tenant_id !== scope.tenant_id
      || at < Date.parse(credential.activated_at) || at >= Date.parse(credential.signing_expires_at)) throw Error();
    const claims = { codec_version: 1, key_version: credential.version, instance_id: scope.instance_id, tenant_id: scope.tenant_id,
      body_digest: hash(raw), issued_at: now, expires_at: new Date(at + 10000).toISOString(), nonce: randomBytes(32).toString("base64url") };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url"), mac = createHmac("sha256", credential.secret)
      .update("dona.web-command.request.v1\0").update(payload).digest("base64url");
    return `${payload}.${mac}`;
  } catch { throw new WebCommandWireError(); }
}
