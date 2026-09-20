import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { assertSynchronousResult } from "../audit/synchronous.js";
import { parseClockMark, type ClockMark } from "./clock.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const utc = z.string().length(24).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const schema = z.strictObject({ codec_version: z.literal(1), instance_id: id, workspace_id: id,
  request_id: id, notification_attempt_id: id, kind: z.enum(["approval_card", "pending_notice"]),
  semantic_hash: z.string().regex(/^[a-f0-9]{64}$/), created_at: utc, key_version: version });
export type ApprovalNotificationMarker = z.infer<typeof schema>;
export interface ApprovalNotificationKey {
  purpose: "approval_notification_marker";
  version: number;
  state: "active" | "verification_only" | "revoked";
  activated_at: string;
  signing_expires_at: string;
  secret: Uint8Array;
}
export class ApprovalNotificationMarkerError extends Error {
  constructor() { super("approval_notification_marker_unverified"); this.name = "ApprovalNotificationMarkerError"; }
}
function guard<T>(operation: () => T): T { try { return operation(); } catch { throw new ApprovalNotificationMarkerError(); } }
function checkedKey(key: ApprovalNotificationKey, marker: ApprovalNotificationMarker, signing: boolean): void {
  if (key.purpose !== "approval_notification_marker" || !["active", "verification_only"].includes(key.state)
    || (signing && key.state !== "active") || !(key.secret instanceof Uint8Array) || key.secret.byteLength !== 32
    || version.parse(key.version) !== marker.key_version) throw Error();
  const from = Date.parse(utc.parse(key.activated_at)), until = Date.parse(utc.parse(key.signing_expires_at)), at = Date.parse(marker.created_at);
  if (until <= from || until - from > 90 * 86400000 || at < from || at >= until) throw Error();
}
function mac(marker: ApprovalNotificationMarker, key: ApprovalNotificationKey): string {
  return createHmac("sha256", key.secret).update("dona.approval.notification-marker.v1\0")
    .update(JSON.stringify([marker.codec_version, marker.instance_id, marker.workspace_id, marker.request_id,
      marker.notification_attempt_id, marker.kind, marker.semantic_hash, marker.created_at, marker.key_version])).digest("hex");
}
/** 認可・配送は行わない。server側の作成markと用途別keyだけでmarkerを作る。 */
export function signApprovalNotificationMarker(input: ApprovalNotificationMarker, key: ApprovalNotificationKey, markInput: ClockMark): string {
  return guard(() => {
    assertSynchronousResult(input); assertSynchronousResult(markInput);
    const marker = schema.parse(input), mark = parseClockMark(markInput);
    if (marker.created_at !== mark.effective_utc) throw Error(); checkedKey(key, marker, true); return mac(marker, key);
  });
}
/** 署名一致だけを検証する。transport author、exact message、現在のscopeや
 * visibilityはadapter/brokerが別途照合し、markerだけを権限にしない。 */
export function verifyApprovalNotificationMarker(input: ApprovalNotificationMarker, expectedMac: string, key: ApprovalNotificationKey): void {
  guard(() => {
    assertSynchronousResult(input); const marker = schema.parse(input);
    if (typeof expectedMac !== "string" || !/^[a-f0-9]{64}$/.test(expectedMac)) throw Error(); checkedKey(key, marker, false);
    if (!timingSafeEqual(Buffer.from(expectedMac, "hex"), Buffer.from(mac(marker, key), "hex"))) throw Error();
  });
}
