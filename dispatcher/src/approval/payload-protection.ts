import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { assertSynchronousResult } from "../audit/synchronous.js";
import { parseClockMark, type ClockMark, requestTtlMs, consumeTtlMs } from "./clock.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const utc = z.string().length(24).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const scopeSchema = z.strictObject({ instance_id: id, workspace_id: id });
const contentPurpose = z.enum(["draft", "thread_message"]);
export const maximumApprovalPayloadBytes = 256 * 1024;
export interface ApprovalPayloadKey {
  version: number;
  purpose: "approval_content" | "approval_payload_wrap";
  state: "active" | "verification_only" | "revoked";
  activated_at: string;
  signing_expires_at: string;
  secret: Uint8Array;
}
const contentBindingSchema = z.strictObject({ key_version: version, mac: digest, signed_at: utc });
const bindingSchema = z.strictObject({
  codec_version: z.literal(1), scope: scopeSchema, owner_kind: z.enum(["request", "attempt"]),
  owner_id: id, request_id: id, semantic_hash: digest, payload_ref: id,
  content: contentBindingSchema, created_at: utc, expires_at: utc,
}).superRefine((value, ctx) => {
  const created = Date.parse(value.created_at), expires = Date.parse(value.expires_at), signed = Date.parse(value.content.signed_at);
  if (signed > created || expires <= created
    || expires - created > (value.owner_kind === "request" ? requestTtlMs + consumeTtlMs : 24 * 3600000)
    || (value.owner_kind === "request" && (value.owner_id !== value.request_id || signed !== created)))
    ctx.addIssue({ code: "custom", message: "payload_binding_invalid" });
});
export type ApprovalPayloadBinding = z.infer<typeof bindingSchema>;
export type ApprovalContentBinding = z.infer<typeof contentBindingSchema>;
export type ApprovalContentScope = z.infer<typeof scopeSchema>;
export type ApprovalContentPurpose = z.infer<typeof contentPurpose>;
const envelopeSchema = z.strictObject({
  codec_version: z.literal(1), algorithm: z.literal("A256KW+A256GCM"), key_version: version,
  sealed_at: utc, wrapped_key: z.string().length(54), nonce: z.string().length(16),
  ciphertext: z.string().min(2).max(Math.ceil(maximumApprovalPayloadBytes * 4 / 3)), tag: z.string().length(22),
});
export type SealedApprovalPayload = z.infer<typeof envelopeSchema>;
export class ApprovalPayloadError extends Error {
  constructor() { super("approval_payload_unverified"); this.name = "ApprovalPayloadError"; }
}
function guard<T>(operation: () => T): T { try { return operation(); } catch { throw new ApprovalPayloadError(); } }
function time(value: string): number { return Date.parse(utc.parse(value)); }
function now(mark: ClockMark): string { assertSynchronousResult(mark); return utc.parse(parseClockMark(mark).effective_utc); }
function checkedKey(key: ApprovalPayloadKey, purpose: ApprovalPayloadKey["purpose"], signedAt: string, sign: boolean): void {
  if (key.purpose !== purpose || !["active", "verification_only"].includes(key.state)
    || (sign && key.state !== "active") || !(key.secret instanceof Uint8Array) || key.secret.byteLength !== 32) throw Error();
  version.parse(key.version);
  const start = time(key.activated_at), end = time(key.signing_expires_at), at = time(signedAt);
  if (end <= start || end - start > 90 * 86400000 || at < start || at >= end) throw Error();
}
function bytes(text: string, allowEmpty = false): Buffer {
  if (typeof text !== "string" || text.length > maximumApprovalPayloadBytes) throw Error();
  const result = Buffer.from(text, "utf8");
  if ((!allowEmpty && result.length < 1) || result.length > maximumApprovalPayloadBytes || result.toString("utf8") !== text) { result.fill(0); throw Error(); }
  return result;
}
function decode(value: string, length?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value || (length !== undefined && decoded.length !== length)) throw Error();
  return decoded;
}
function mac(data: Uint8Array, scope: ApprovalContentScope, purpose: ApprovalContentPurpose, key: ApprovalPayloadKey): string {
  return createHmac("sha256", key.secret).update("dona.approval.content.v1\0")
    .update(JSON.stringify([key.version, scope.instance_id, scope.workspace_id, purpose])).update("\0").update(data).digest("hex");
}
/** 保護clockと用途別keyは上位が取得する。codecはproviderやactorを認証しない。 */
export function createApprovalContentBinding(text: string, scopeInput: ApprovalContentScope, purposeInput: ApprovalContentPurpose, key: ApprovalPayloadKey, mark: ClockMark): ApprovalContentBinding {
  return guard(() => {
    assertSynchronousResult(scopeInput); const scope = scopeSchema.parse(scopeInput), purpose = contentPurpose.parse(purposeInput), at = now(mark);
    checkedKey(key, "approval_content", at, true); const data = bytes(text, purpose === "thread_message");
    try { return Object.freeze({ key_version: key.version, mac: mac(data, scope, purpose, key), signed_at: at }); }
    finally { data.fill(0); }
  });
}
function verifyContent(data: Uint8Array, scope: ApprovalContentScope, purpose: ApprovalContentPurpose, binding: ApprovalContentBinding, key: ApprovalPayloadKey): void {
  checkedKey(key, "approval_content", binding.signed_at, false);
  if (key.version !== binding.key_version || !timingSafeEqual(Buffer.from(binding.mac, "hex"), Buffer.from(mac(data, scope, purpose, key), "hex"))) throw Error();
}
export function verifyApprovalContentBinding(text: string, scopeInput: ApprovalContentScope, purposeInput: ApprovalContentPurpose, input: ApprovalContentBinding, key: ApprovalPayloadKey): void {
  guard(() => {
    assertSynchronousResult(scopeInput); assertSynchronousResult(input);
    const scope = scopeSchema.parse(scopeInput), purpose = contentPurpose.parse(purposeInput), binding = contentBindingSchema.parse(input), data = bytes(text, purpose === "thread_message");
    try { verifyContent(data, scope, purpose, binding, key); } finally { data.fill(0); }
  });
}
function bindingAt(input: ApprovalPayloadBinding, at: string): ApprovalPayloadBinding {
  assertSynchronousResult(input); const value = bindingSchema.parse(input);
  if (time(at) < time(value.created_at) || time(at) >= time(value.expires_at)) throw Error();
  return value;
}
function aad(binding: ApprovalPayloadBinding, keyVersion: number, sealedAt: string, wrappedKey: string): Buffer {
  return Buffer.from(JSON.stringify(["dona.approval.payload", 1, "A256KW+A256GCM", keyVersion, sealedAt, wrappedKey,
    binding.scope.instance_id, binding.scope.workspace_id, binding.owner_kind, binding.owner_id, binding.request_id,
    binding.semantic_hash, binding.payload_ref, binding.content.key_version, binding.content.mac, binding.content.signed_at,
    binding.created_at, binding.expires_at]));
}
function separateKeys(wrapping: ApprovalPayloadKey, content: ApprovalPayloadKey): void {
  if (timingSafeEqual(wrapping.secret, content.secret)) throw Error();
}
/** 暗号化は永続化/consumeを行わない。requestとattemptへ別binding・別DEKを
 * 作り、移動・削除は上位の同一監査transactionで実行する必要がある。 */
export function sealApprovalPayload(text: string, input: ApprovalPayloadBinding, wrappingKey: ApprovalPayloadKey, contentKey: ApprovalPayloadKey, mark: ClockMark): SealedApprovalPayload {
  return guard(() => {
    const at = now(mark), owner = bindingAt(input, at);
    checkedKey(wrappingKey, "approval_payload_wrap", at, true);
    const plaintext = bytes(text); let dataKey: Buffer | undefined;
    try {
      verifyContent(plaintext, owner.scope, "draft", owner.content, contentKey); separateKeys(wrappingKey, contentKey);
      dataKey = randomBytes(32);
      const wrap = createCipheriv("id-aes256-wrap", wrappingKey.secret, Buffer.alloc(8, 0xa6));
      const wrapped = Buffer.concat([wrap.update(dataKey), wrap.final()]).toString("base64url");
      const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", dataKey, nonce, { authTagLength: 16 });
      cipher.setAAD(aad(owner, wrappingKey.version, at, wrapped));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Object.freeze(envelopeSchema.parse({ codec_version: 1, algorithm: "A256KW+A256GCM", key_version: wrappingKey.version,
        sealed_at: at, wrapped_key: wrapped, nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") }));
    } finally { plaintext.fill(0); dataKey?.fill(0); }
  });
}
export function openApprovalPayload(input: unknown, ownerInput: ApprovalPayloadBinding, wrappingKey: ApprovalPayloadKey, contentKey: ApprovalPayloadKey, mark: ClockMark): string {
  return guard(() => {
    assertSynchronousResult(input); const envelope = envelopeSchema.parse(input), at = now(mark), owner = bindingAt(ownerInput, at);
    if (time(envelope.sealed_at) < time(owner.created_at) || time(envelope.sealed_at) > time(at) || envelope.key_version !== wrappingKey.version) throw Error();
    checkedKey(wrappingKey, "approval_payload_wrap", envelope.sealed_at, false);
    checkedKey(contentKey, "approval_content", owner.content.signed_at, false); separateKeys(wrappingKey, contentKey);
    const ciphertext = decode(envelope.ciphertext); if (ciphertext.length < 1 || ciphertext.length > maximumApprovalPayloadBytes) throw Error();
    let unwrapped: Buffer | undefined, dataKey: Buffer | undefined, first: Buffer | undefined, plaintext: Buffer | undefined;
    try {
      const unwrap = createDecipheriv("id-aes256-wrap", wrappingKey.secret, Buffer.alloc(8, 0xa6));
      unwrapped = unwrap.update(decode(envelope.wrapped_key, 40)); dataKey = Buffer.concat([unwrapped, unwrap.final()]);
      if (dataKey.length !== 32) throw Error();
      const decipher = createDecipheriv("aes-256-gcm", dataKey, decode(envelope.nonce, 12), { authTagLength: 16 });
      decipher.setAAD(aad(owner, wrappingKey.version, envelope.sealed_at, envelope.wrapped_key)); decipher.setAuthTag(decode(envelope.tag, 16));
      first = decipher.update(ciphertext); plaintext = Buffer.concat([first, decipher.final()]);
      verifyContent(plaintext, owner.scope, "draft", owner.content, contentKey);
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(plaintext);
    } finally { unwrapped?.fill(0); dataKey?.fill(0); first?.fill(0); plaintext?.fill(0); }
  });
}

/** 保存用shape parser。署名/GCMの検証や時刻・actorの認可を行わない。 */
export function parseApprovalPayloadBinding(input: unknown): ApprovalPayloadBinding {
  return guard(() => {
    assertSynchronousResult(input); const binding=bindingSchema.parse(input);
    Object.freeze(binding.scope); Object.freeze(binding.content); return Object.freeze(binding);
  });
}
export function parseSealedApprovalPayload(input: unknown): SealedApprovalPayload {
  return guard(() => {
    assertSynchronousResult(input); const envelope=envelopeSchema.parse(input);
    decode(envelope.wrapped_key,40); decode(envelope.nonce,12); decode(envelope.tag,16);
    const ciphertext=decode(envelope.ciphertext);
    if(ciphertext.length<1 || ciphertext.length>maximumApprovalPayloadBytes) throw Error();
    return Object.freeze(envelope);
  });
}
