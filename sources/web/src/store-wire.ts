import { createHash } from "node:crypto";
import { z } from "zod";
import { sessionStateSchema } from "./domain.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const utc = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
export const storedWebSessionSchema = z.strictObject({ state: sessionStateSchema, cookie_key_version: revision, cookie_digest: digest,
  csrf_key_version: revision, token_key_version: revision, payload_ref: id.nullable(), payload_digest: digest.nullable() })
  .refine(value => (value.state.state === "active") === (value.payload_ref !== null && value.payload_digest !== null)
    && (value.state.state !== "revoked" || (value.payload_ref === null && value.payload_digest === null)));
export type StoredWebSession = z.infer<typeof storedWebSessionSchema>;
const loginBindingSchema=z.strictObject({instance_id:id,tenant_id:id,login_ref:id,bff_generation:revision,
 cookie_key_version:revision,cookie_digest:digest,created_at:utc,expires_at:utc})
 .refine(value=>Date.parse(value.expires_at)-Date.parse(value.created_at)===300000);
export const storedWebLoginSchema=z.strictObject({binding:loginBindingSchema,payload_ref:id,payload_digest:digest,key_version:revision,previous_session_ref:id.nullable()});
export type StoredWebLogin=z.infer<typeof storedWebLoginSchema>;
function base64(value: string, maximum: number, exact?: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.toString("base64url") === value && bytes.length <= maximum && (exact === undefined || bytes.length === exact);
}
const envelopeSchema = z.strictObject({ codec_version: z.literal(1), key_version: revision, sealed_at: utc,
  nonce: z.string().length(16).refine(value => base64(value, 12, 12)),
  ciphertext: z.string().min(1).max(10923).refine(value => base64(value, 8192)),
  tag: z.string().length(22).refine(value => base64(value, 16, 16)) });
export const storedPayloadSchema = z.strictObject({ codec_version: z.literal(1), purpose: z.enum(["web_access_token", "web_login_transaction"]),
  payload_ref: id, binding_digest: digest, envelope: envelopeSchema })
  .refine(value => value.purpose !== "web_login_transaction" || base64(value.envelope.ciphertext, 1024));
export type StoredWebPayload = z.infer<typeof storedPayloadSchema>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
/** Dispatcher-compatible sealed payload codec only. Hashes do not establish
 * authority: use the authenticated service and AEAD with protected keys. */
function guard<T>(operation: () => T): T { try { return operation(); } catch { throw Error("web_payload_invalid"); } }
export function encodeWebPayload(input:unknown):{payload:StoredWebPayload;canonical:string;digest:string} {
 return guard(()=>{const payload=storedPayloadSchema.parse(input),encoded=canonical(payload);
  return {payload,canonical:encoded,digest:hash("dona.web.sealed-payload.v1\0"+encoded)};});
}
export function webPayloadBinding(owner:StoredWebSession|StoredWebLogin):string {
 return guard(()=>{
  if("binding" in owner)return hash("dona.web.login-binding.v1\0"+canonical(storedWebLoginSchema.parse(owner).binding));
  const session=storedWebSessionSchema.parse(owner).state;
  const binding={instance_id:session.instance_id,tenant_id:session.tenant_id,principal_id:session.principal_id,
   session_ref:session.session_ref,session_generation:session.session_generation,identity_binding_revision:session.identity_binding_revision,
   authz_revision:session.authz_revision,issued_at:session.authenticated_at,expires_at:session.expires_at};
  return hash("dona.web.session-binding.v1\0"+canonical(binding));
 });
}
export function verifyWebPayload(input:unknown,owner:StoredWebSession|StoredWebLogin):StoredWebPayload {
 return guard(()=>{const {payload,digest:actual}=encodeWebPayload(input),login="binding" in owner;
  const value=login?storedWebLoginSchema.parse(owner):storedWebSessionSchema.parse(owner);
  const issued=login?(value as StoredWebLogin).binding.created_at:(value as StoredWebSession).state.authenticated_at;
  const expires=login?(value as StoredWebLogin).binding.expires_at:(value as StoredWebSession).state.expires_at;
  const key=login?(value as StoredWebLogin).key_version:(value as StoredWebSession).token_key_version;
  if(payload.purpose!==(login?"web_login_transaction":"web_access_token") || payload.payload_ref!==value.payload_ref
   || actual!==value.payload_digest || payload.binding_digest!==webPayloadBinding(owner) || payload.envelope.key_version!==key
   || Date.parse(payload.envelope.sealed_at)<Date.parse(issued) || Date.parse(payload.envelope.sealed_at)>=Date.parse(expires))throw Error("web_payload_invalid");
  return payload;});
}
