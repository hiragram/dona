import { createHmac } from "node:crypto";
import { z } from "zod";
import type { ContextIdentity } from "./context.js";
import { assertProtectionKey, type SessionProtectionKey } from "./session-protection.js";

const requestId = z.string().length(43).refine(value => /^[A-Za-z0-9_-]+$/.test(value)
  && Buffer.from(value, "base64url").byteLength === 32 && Buffer.from(value, "base64url").toString("base64url") === value);
const workspace = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("scratch") }),
  z.strictObject({ kind: z.literal("github"), repository: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/),
    base_ref: z.string().min(1).max(255).refine(value => !value.startsWith("-") && !value.includes("..") && !/[\u0000-\u001f\u007f ~^:?*\[\\]/.test(value)).optional() })]);
const submit = z.strictObject({ request_id: requestId, objective: z.string().trim().min(1).max(100000)
  .refine(value => Buffer.byteLength(value) <= 400000), workspace });
const cancel = z.strictObject({ request_id: requestId });
export type BrowserCommand = z.infer<typeof submit> | z.infer<typeof cancel>;
export function parseBrowserCommand(routeId: string, bytes: Uint8Array): BrowserCommand {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > 65536) throw new Error("web_command_invalid");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return routeId === "job_submit" ? submit.parse(value) : routeId === "job_cancel" ? cancel.parse(value) : (() => { throw Error(); })();
}
export function deriveWebIdempotencyKey(identity: ContextIdentity, requestIdValue: string, key: SessionProtectionKey, now: string): string {
  requestId.parse(requestIdValue); const at = Date.parse(now);
  assertProtectionKey(key, "web_cookie_index", at, false);
  return createHmac("sha256", key.secret).update("dona.web-command.idempotency.v1\0")
    .update(JSON.stringify([identity.instance_id, identity.tenant_id, identity.principal_id, identity.session_ref, requestIdValue])).digest("hex");
}
