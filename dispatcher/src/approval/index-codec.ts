import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { assertSynchronousResult } from "../audit/synchronous.js";
import type { ApprovalRecordScope } from "./record-codec.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const scopeSchema = z.strictObject({ instance_id: id, workspace_id: id });
const listSchema = z.strictObject({
  record_kind: z.enum(["request", "decision", "consume", "execution", "notification", "event", "presentation"]),
  membership: z.enum(["all", "active"]),
}).refine(value => value.membership === "all" || !["decision", "consume"].includes(value.record_kind));
const selectorSchema = z.discriminatedUnion("name", [
  z.strictObject({ name: z.literal("request_creation"), creation_key: digest }),
  z.strictObject({ name: z.literal("decision_id"), decision_id: id }),
  z.strictObject({ name: z.literal("consume_id"), consume_id: id }),
  z.strictObject({ name: z.literal("consume_decision"), decision_id: id }),
  z.strictObject({ name: z.literal("consume_attempt"), attempt_id: id }),
  z.strictObject({ name: z.literal("execution_request"), request_id: id }),
  z.strictObject({ name: z.literal("execution_consume"), consume_id: id }),
  z.strictObject({ name: z.literal("notification_request_kind"), request_id: id, notification_kind: z.enum(["approval_card", "pending_notice"]) }),
  z.strictObject({ name: z.literal("notification_message"), message_ref: id }),
  z.strictObject({ name: z.literal("event_decision"), decision_id: id }),
  z.strictObject({ name: z.literal("presentation_revision"), notification_attempt_id: id, desired_revision: positive }),
  z.strictObject({ name: z.literal("presentation_active_message"), message_ref: id }),
]);
const manifestIdentity = { kind: z.literal("manifest"), list: listSchema };
const linkIdentity = { kind: z.literal("link"), list: listSchema, record_id: id };
const aliasIdentity = { kind: z.literal("alias"), selector: selectorSchema };
const identitySchema = z.discriminatedUnion("kind", [
  z.strictObject(manifestIdentity), z.strictObject(linkIdentity), z.strictObject(aliasIdentity),
]);
const envelope = { codec_version: z.literal(1), scope: scopeSchema };
const schema = z.discriminatedUnion("kind", [
  z.strictObject({ ...envelope, ...manifestIdentity, count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), head: id.nullable(), tail: id.nullable() })
    .refine(value => value.count === 0 ? value.head === null && value.tail === null
      : value.head !== null && value.tail !== null && (value.count === 1 ? value.head === value.tail : value.head !== value.tail)),
  z.strictObject({ ...envelope, ...linkIdentity, member: z.boolean(), previous: id.nullable(), next: id.nullable() })
    .refine(value => value.member ? value.previous !== value.record_id && value.next !== value.record_id
      && (value.previous === null || value.next === null || value.previous !== value.next)
      : value.list.membership === "active" && value.previous === null && value.next === null),
  z.strictObject({ ...envelope, ...aliasIdentity, target: id.nullable() })
    // 生涯uniqueなaliasを解放する操作はこのversionに存在しない。
    .refine(value => value.target !== null || value.selector.name === "presentation_active_message"),
]);
export type ApprovalIndex = z.infer<typeof schema>;
export type ApprovalIndexIdentity = z.infer<typeof identitySchema>;
export type ApprovalIndexList = z.infer<typeof listSchema>;
export const maximumApprovalIndexBytes = 2048;
export class ApprovalIndexError extends Error {
  constructor() { super("approval_index_unverified"); this.name = "ApprovalIndexError"; }
}
function guard<T>(operation: () => T): T { try { return operation(); } catch { throw new ApprovalIndexError(); } }
function canonical(value: unknown): string {
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return "{" + Object.keys(object).sort().map(key => JSON.stringify(key) + ":" + canonical(object[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function identity(index: ApprovalIndex): ApprovalIndexIdentity {
  switch (index.kind) {
    case "manifest": return { kind: index.kind, list: index.list };
    case "link": return { kind: index.kind, list: index.list, record_id: index.record_id };
    case "alias": return { kind: index.kind, selector: index.selector };
  }
}
/** 固定のlist/alias identityのみをpoint keyへ変換する。keyの所持は権限ではない。 */
export function approvalIndexKey(scopeInput: ApprovalRecordScope, input: ApprovalIndexIdentity): string {
  return guard(() => {
    assertSynchronousResult(scopeInput); assertSynchronousResult(input);
    const scope = scopeSchema.parse(scopeInput), selected = identitySchema.parse(input);
    return "index_" + createHash("sha256").update("dona.approval-index-key.v1\0")
      .update(canonical({ scope, identity: selected })).digest("hex");
  });
}
/** 構造・scope・canonical表現のみを検証する。current root、隣接関係、
 * 完全な件数、rowとの整合性は監査済みrepositoryで別途検証する。 */
export function encodeApprovalIndex(input: unknown, scopeInput: ApprovalRecordScope) {
  return guard(() => {
    assertSynchronousResult(input); assertSynchronousResult(scopeInput);
    const index = schema.parse(input), scope = scopeSchema.parse(scopeInput);
    if (canonical(scope) !== canonical(index.scope)) throw Error();
    const wire = canonical(index); if (Buffer.byteLength(wire) > maximumApprovalIndexBytes) throw Error();
    return { wire, digest: createHash("sha256").update("dona.approval-index.v1\0").update(wire).digest("hex"),
      key: approvalIndexKey(scope, identity(index)), index: freeze(index) };
  });
}
export function decodeApprovalIndex(wire: string, expectedDigest: string, scope: ApprovalRecordScope) {
  return guard(() => {
    if (typeof wire !== "string" || Buffer.byteLength(wire) > maximumApprovalIndexBytes) throw Error();
    digest.parse(expectedDigest); const decoded = encodeApprovalIndex(JSON.parse(wire), scope);
    if (decoded.wire !== wire || !timingSafeEqual(Buffer.from(decoded.digest, "hex"), Buffer.from(expectedDigest, "hex"))) throw Error();
    return decoded;
  });
}
