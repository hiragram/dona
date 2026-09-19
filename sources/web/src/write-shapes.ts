import { createHash } from "node:crypto";
import { z } from "zod";
import { storedWebSessionSchema, storedWebLoginSchema, storedPayloadSchema, verifyWebPayload } from "./store-wire.js";
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).refine(value => !/\s/.test(value));
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().length(64).regex(/^[a-f0-9]+$/);
const utc = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const index = z.strictObject({ key_version: revision, digest });
const indexes = z.array(index).min(1).max(128).refine(values => new Set(values.map(value => value.key_version)).size === values.length);
const authDenialReason = z.enum(["identity_invalid", "identity_unavailable", "identity_mismatch", "session_invalid", "session_revoked",
  "session_expired", "origin_invalid", "csrf_invalid", "cookie_invalid", "cookie_ambiguous"]);
const denialReason = z.enum(["deployment_invalid", "revision_mismatch", "idempotency_conflict", "identity_unavailable", "cookie_ambiguous",
  "already_consumed", "expired", "quota_exceeded", "cookie_invalid", "identity_mismatch", "session_invalid", "identity_invalid",
  "session_revoked", "session_expired", "origin_invalid", "csrf_invalid"]);
export const authWriteInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ codec_version: z.literal(1), operation: z.literal("restart"), expected_generation: revision }),
  z.strictObject({ codec_version: z.literal(1), operation: z.literal("create_login"), login: storedWebLoginSchema.omit({ previous_session_ref: true }),
    payload: storedPayloadSchema, browser_session_cookies: indexes.nullable() }),
  z.strictObject({ codec_version: z.literal(1), operation: z.literal("consume_login"), cookie_indexes: indexes }),
  z.strictObject({ codec_version: z.literal(1), operation: z.literal("create_session"), receipt_id: id, subject_indexes: indexes,
    session: storedWebSessionSchema, payload: storedPayloadSchema }),
  z.strictObject({ codec_version: z.literal(1), operation: z.literal("revoke_session"), session_ref: id, cookie: index }),
  z.strictObject({ codec_version: z.literal(1), operation: z.literal("revoke_inactive"), session_ref: id, cookie: index }),
  z.strictObject({ codec_version: z.literal(1), operation: z.literal("record_denial"), cookie_indexes: indexes.nullable(), reason: authDenialReason }),
  z.strictObject({ codec_version: z.literal(1), operation: z.literal("expire") }),
]).superRefine((value, ctx) => {
  try {
    if (value.operation === "create_login") verifyWebPayload(value.payload, { ...value.login, previous_session_ref: null });
    if (value.operation === "create_session") verifyWebPayload(value.payload, value.session);
  } catch { ctx.addIssue({ code: "custom", message: "web_write_payload_invalid" }); }
});
export type AuthWriteInput = z.infer<typeof authWriteInputSchema>;
const result = z.union([
  z.strictObject({ status: z.literal("denied"), reason: denialReason }),
  z.strictObject({ status: z.literal("succeeded"), kind: z.enum(["restarted", "login_created", "session_created", "revoked", "expired"]), generation: revision }),
  z.strictObject({ status: z.literal("succeeded"), kind: z.literal("login_consumed"), login: storedWebLoginSchema,
    payload: storedPayloadSchema, receipt_id: id }),
]);
export const authWriteResultSchema = z.strictObject({ operation: z.enum(["restart", "create_login", "consume_login", "create_session",
  "revoke_session", "revoke_inactive", "record_denial", "expire"]), result }).superRefine((value, ctx) => {
  if (value.result.status !== "succeeded") return;
  const expected = { restart: "restarted", create_login: "login_created", consume_login: "login_consumed", create_session: "session_created",
    revoke_session: "revoked", revoke_inactive: null, record_denial: null, expire: "expired" }[value.operation];
  if (value.result.kind !== expected) ctx.addIssue({ code: "custom", message: "web_write_result_invalid" });
  if (value.result.kind === "login_consumed") {
    try { verifyWebPayload(value.result.payload, value.result.login); }
    catch { ctx.addIssue({ code: "custom", message: "web_write_result_invalid" }); }
  }
});
export type AuthWriteResult = z.infer<typeof authWriteResultSchema>;
/** Derivation only, not authorization. The server verifies the proof first,
 * then lets the shared protected clock consume this ID exactly once. */
export function writeTransactionId(proof: string): string {
  if (typeof proof !== "string" || proof.length > 2048 || !/^[A-Za-z0-9_.-]+$/.test(proof)) throw Error("web_write_proof_invalid");
  return "web_auth_" + createHash("sha256").update("dona.web-auth-write.transaction.v1\0").update(proof, "ascii").digest("hex");
}
export function validateWriteInputScope(input: AuthWriteInput, scope: { instance_id: string; tenant_id: string }): void {
  id.parse(scope.instance_id); id.parse(scope.tenant_id);
  const owner = input.operation === "create_login" ? input.login.binding : input.operation === "create_session" ? input.session.state : null;
  if (owner && (owner.instance_id !== scope.instance_id || owner.tenant_id !== scope.tenant_id)) throw Error("web_write_scope_invalid");
}
export function validateWriteBinding(input: AuthWriteInput, output: AuthWriteResult, scope: { instance_id: string; tenant_id: string }, proof: string, now: string): void {
  validateWriteInputScope(input, scope);
  const at = Date.parse(utc.parse(now));
  if (input.operation !== output.operation) throw Error("web_write_result_invalid");
  if (output.result.status !== "succeeded") return;
  const result = output.result;
  if (result.kind === "login_consumed") {
    const owner = result.login.binding;
    if (input.operation !== "consume_login" || owner.instance_id !== scope.instance_id || owner.tenant_id !== scope.tenant_id
      || !input.cookie_indexes.some(candidate => candidate.key_version === owner.cookie_key_version && candidate.digest === owner.cookie_digest)
      || result.receipt_id !== writeTransactionId(proof) || at < Date.parse(owner.created_at) || at >= Date.parse(owner.expires_at)) throw Error("web_write_result_invalid");
    return;
  }
  const expectedGeneration = input.operation === "restart" ? input.expected_generation + 1
    : input.operation === "create_login" ? input.login.binding.bff_generation
    : input.operation === "create_session" ? input.session.state.bff_generation : undefined;
  if (expectedGeneration !== undefined && result.generation !== expectedGeneration) throw Error("web_write_result_invalid");
  if (input.operation === "create_login" && (at < Date.parse(input.login.binding.created_at) || at >= Date.parse(input.login.binding.expires_at))) throw Error("web_write_result_invalid");
  if (input.operation === "create_session" && (at < Date.parse(input.session.state.authenticated_at) || at >= Date.parse(input.session.state.expires_at))) throw Error("web_write_result_invalid");
}
