import { z } from "zod";
import type { ApprovalRecord } from "./record-codec.js";
import type { ClockMark } from "./clock.js";
import type { VerifiedAuditState } from "../audit/codec.js";
const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const scope=z.strictObject({instance_id:id,workspace_id:id});
const denied=z.strictObject({status:z.literal("denied"),reason:z.enum(["unauthenticated","unauthorized","scope_mismatch","proof_invalid","unavailable"])});
export const notificationCommandSchema=z.strictObject({notification_handle:id,authority_ref:id,expected_fence:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)});
export type NotificationCommand=z.infer<typeof notificationCommandSchema>;
type Request=Extract<ApprovalRecord,{kind:"request"}>;
type Notification=Extract<ApprovalRecord,{kind:"notification"}>;
export const notificationClaimGrantSchema=z.discriminatedUnion("status",[denied,z.strictObject({status:z.literal("verified"),scope,notification_id:id,consumer_id:id,
 binding_id:id,binding_revision:positive,policy_revision:positive,semantic_hash:z.string().regex(/^[a-f0-9]{64}$/),requester_authorization_revision:positive,
 stale_reason:z.enum(["binding_revoked","revision_mismatch","snapshot_mismatch","resource_not_visible"]).nullable()})]);
/** 内部配送workerの認証、target membership、current binding/policy、
 * supervisor visibility、shared状態、ordered thread snapshotを同じstateで照合。
 * body復号またはdispatch fenceより前に必須。実providerは別component。 */
export type NotificationClaimAuthority=(command:Readonly<NotificationCommand>,request:Request,notification:Notification,mark:Readonly<ClockMark>,state:VerifiedAuditState)=>z.infer<typeof notificationClaimGrantSchema>;
export const notificationRecoveryGrantSchema=z.discriminatedUnion("status",[denied,z.strictObject({status:z.literal("verified"),scope,notification_id:id,consumer_id:id})]);
export type NotificationRecoveryAuthority=(command:Readonly<NotificationCommand>,request:Request,notification:Notification,mark:Readonly<ClockMark>,state:VerifiedAuditState)=>z.infer<typeof notificationRecoveryGrantSchema>;
export const notificationReceiptSchema=z.discriminatedUnion("outcome",[
 z.strictObject({outcome:z.literal("sent"),presentation_ref:id}),
 z.strictObject({outcome:z.literal("rejected"),reason:z.enum(["unauthorized","resource_not_visible","invalid_input","scope_denied"])}),
 z.strictObject({outcome:z.literal("unknown")}),z.strictObject({outcome:z.literal("ambiguous")})]);
export const notificationReceiptGrantSchema=z.discriminatedUnion("status",[denied,z.strictObject({status:z.literal("verified"),scope,notification_id:id,consumer_id:id,
 delivery_fence:positive,proof_kind:z.enum(["callback","reconcile"]),receipt:notificationReceiptSchema})]);
/** authenticated transportのexact message/author/target/保存markerへ結合した
 * receiptだけを返す。callback/reconcile fenceは別に確認。text類似・近接時刻・
 * user入力のresultを証拠にしない。0件はunknownで、再送を許可しない。 */
export type NotificationReceiptAuthority=(command:Readonly<NotificationCommand>,request:Request,notification:Notification,mark:Readonly<ClockMark>,state:VerifiedAuditState)=>z.infer<typeof notificationReceiptGrantSchema>;
