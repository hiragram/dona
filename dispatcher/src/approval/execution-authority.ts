// 内部状態brokerの必須authority契約。runtime登録や実authorityは提供しない。
import { z } from "zod";
import type { ApprovalRecord } from "./record-codec.js";
import type { ClockMark } from "./clock.js";
import type { VerifiedAuditState } from "../audit/codec.js";
import type { SealedApprovalExecutionMarker } from "./execution-marker.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const executionCommandSchema = z.strictObject({ attempt_handle: id, authority_ref: id, expected_fence: positive });
export type ExecutionCommand = z.infer<typeof executionCommandSchema>;
type Request = Extract<ApprovalRecord, { kind: "request" }>;
type Attempt = Extract<ApprovalRecord, { kind: "execution" }>;
const scope = z.strictObject({ instance_id: id, workspace_id: id });
const denied = z.strictObject({ status: z.literal("denied"), reason: z.enum(["unauthenticated", "unauthorized", "scope_mismatch", "proof_invalid", "unavailable"]) });
export const executionStartGrantSchema = z.discriminatedUnion("status", [denied,
  z.strictObject({ status: z.literal("verified"), scope, attempt_id: id, consumer_id: id,
    binding_id: id, binding_revision: positive, policy_revision: positive, semantic_hash: z.string().regex(/^[a-f0-9]{64}$/),
    requester_authorization_revision: positive, stale_reason: z.enum(["binding_revoked", "revision_mismatch", "snapshot_mismatch", "resource_not_visible"]).nullable() })]);
/** 認証済み内部executorとcurrent target membership、binding/policy、ordered
 * thread revision、supervisor visibility、shared state、closed operationを照合。
 * client由来fieldをverifiedへ単に写さず、同じstate内の確定sourceから導出する。 */
export type ExecutionStartAuthority = (command: Readonly<ExecutionCommand>, request: Request, attempt: Attempt,
  mark: Readonly<ClockMark>, state: VerifiedAuditState) => z.infer<typeof executionStartGrantSchema>;
export const executionRecoveryGrantSchema = z.discriminatedUnion("status", [denied,
  z.strictObject({ status: z.literal("verified"), scope, attempt_id: id, consumer_id: id })]);
/** 復旧workerの認証とattempt管理scope。元operationの再送権限ではない。 */
export type ExecutionRecoveryAuthority = (command: Readonly<ExecutionCommand>, request: Request, attempt: Attempt,
  mark: Readonly<ClockMark>, state: VerifiedAuditState) => z.infer<typeof executionRecoveryGrantSchema>;
export const executionReceiptSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("accepted"), receipt_ref: id }),
  z.strictObject({ outcome: z.literal("rejected"), receipt_ref: id, reason: z.enum(["unauthorized", "resource_not_visible", "invalid_input", "scope_denied", "operation_unsupported"]) }),
  z.strictObject({ outcome: z.literal("unknown") }),
  z.strictObject({ outcome: z.literal("ambiguous") }),
]);
export const executionReceiptGrantSchema = z.discriminatedUnion("status", [denied,
  z.strictObject({ status: z.literal("verified"), scope, attempt_id: id, consumer_id: id, execution_fence: positive, proof_kind: z.enum(["callback", "reconcile"]), receipt: executionReceiptSchema })]);
/** current callback/reconcile fenceへ結合した認証済みreceiptを解決する。
 * 送信応答またはexact app author/target/保存marker/全page/pagination fenceを
 * 検証する。reconcileの0件はunknown、複数/不完全はambiguous。text類似や
 * 時刻近接を証拠にしない。clientからoutcome/receiptを受け取らない。 */
export type ExecutionReceiptAuthority = (command: Readonly<ExecutionCommand>, request: Request, attempt: Attempt,
  marker: SealedApprovalExecutionMarker, mark: Readonly<ClockMark>, state: VerifiedAuditState) => z.infer<typeof executionReceiptGrantSchema>;
