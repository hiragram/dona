import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { assertSynchronousResult } from "../audit/synchronous.js";
import { parseClockMark, type ClockMark } from "./clock.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const utc = z.string().length(24).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const scopeSchema = z.strictObject({ instance_id: id, workspace_id: id });
const schema = z.strictObject({ codec_version: z.literal(1), scope: scopeSchema, request_id: id, consume_id: id, attempt_id: id,
  operation: z.literal("slack.post_thread_reply.v1"), semantic_hash: digest, execution_fence: positive,
  created_at: utc, clock_transaction_id: id, key_version: positive });
export type ApprovalExecutionMarker = z.infer<typeof schema>;
export interface ApprovalExecutionMarkerKey {
  purpose: "approval_execution_marker"; version: number; state: "active" | "verification_only" | "revoked";
  activated_at: string; signing_expires_at: string; secret: Uint8Array;
}
const sealedSchema = z.strictObject({ marker: schema, mac: digest });
export type SealedApprovalExecutionMarker = z.infer<typeof sealedSchema>;
export class ApprovalExecutionMarkerError extends Error {
  constructor() { super("approval_execution_marker_unverified"); this.name = "ApprovalExecutionMarkerError"; }
}
function guard<T>(operation: () => T): T { try { return operation(); } catch { throw new ApprovalExecutionMarkerError(); } }
function canonical(marker: ApprovalExecutionMarker): string {
  return JSON.stringify([marker.codec_version, marker.scope.instance_id, marker.scope.workspace_id, marker.request_id, marker.consume_id,
    marker.attempt_id, marker.operation, marker.semantic_hash, marker.execution_fence, marker.created_at, marker.clock_transaction_id, marker.key_version]);
}
function checkedKey(key: ApprovalExecutionMarkerKey, marker: ApprovalExecutionMarker, signing: boolean): void {
  if (key.purpose !== "approval_execution_marker" || !["active", "verification_only"].includes(key.state)
    || (signing && key.state !== "active") || !(key.secret instanceof Uint8Array) || key.secret.byteLength !== 32
    || positive.parse(key.version) !== marker.key_version) throw Error();
  const from = Date.parse(utc.parse(key.activated_at)), until = Date.parse(utc.parse(key.signing_expires_at)), at = Date.parse(marker.created_at);
  if (until <= from || until - from > 90 * 86400000 || at < from || at >= until) throw Error();
}
function mac(marker: ApprovalExecutionMarker, key: ApprovalExecutionMarkerKey): string {
  return createHmac("sha256", key.secret).update("dona.approval.execution-marker.v1\0").update(canonical(marker)).digest("hex");
}
/** 実行の認可・送信は行わない。用途を分離したkeyでcurrent clockへ結ぶ。 */
export function signApprovalExecutionMarker(input: ApprovalExecutionMarker, key: ApprovalExecutionMarkerKey, markInput: ClockMark): SealedApprovalExecutionMarker {
  return guard(() => {
    assertSynchronousResult(input); assertSynchronousResult(markInput);
    const marker = schema.parse(input), mark = parseClockMark(markInput);
    if (marker.created_at !== mark.effective_utc || marker.clock_transaction_id !== mark.transaction_id) throw Error();
    checkedKey(key, marker, true); return encodeApprovalExecutionMarker({ marker, mac: mac(marker, key) }).sealed;
  });
}
/** currentな認可・message author・target・全pageの照合は呼出側の責務。
 * 検証時に新しいmarkerを生成せず、保存したversionの保持鍵を使う。 */
export function verifyApprovalExecutionMarker(input: SealedApprovalExecutionMarker, key: ApprovalExecutionMarkerKey): void {
  guard(() => {
    const { sealed } = encodeApprovalExecutionMarker(input); checkedKey(key, sealed.marker, false);
    if (!timingSafeEqual(Buffer.from(sealed.mac, "hex"), Buffer.from(mac(sealed.marker, key), "hex"))) throw Error();
  });
}
/** metadata codecのみ。MACの真正性はverifyで別途検証する。 */
export function encodeApprovalExecutionMarker(input: SealedApprovalExecutionMarker) {
  return guard(() => {
    assertSynchronousResult(input); const sealed = sealedSchema.parse(input);
    Object.freeze(sealed.marker.scope); Object.freeze(sealed.marker); Object.freeze(sealed);
    const wire = JSON.stringify(sealed);
    if (Buffer.byteLength(wire) > 2048) throw Error();
    const hash = createHash("sha256").update("dona.approval.execution-marker-record.v1\0").update(wire).digest("hex");
    const key = "execution_" + createHash("sha256").update("dona.approval.execution-marker-key.v1\0")
      .update(JSON.stringify([sealed.marker.scope.instance_id, sealed.marker.scope.workspace_id, sealed.marker.attempt_id])).digest("hex");
    return Object.freeze({ sealed, wire, digest: hash, key });
  });
}
/** 最大202 ASCII文字。Slack section block_idの255文字上限内。
 * この文字列だけを認可や受理の証明にはしない。 */
export function approvalExecutionBlockId(input: SealedApprovalExecutionMarker): string {
  const { sealed } = encodeApprovalExecutionMarker(input);
  return `dona.ex1.${sealed.marker.attempt_id}.${sealed.mac}`;
}
