import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { assertSynchronousResult } from "../audit/synchronous.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().regex(/^[0-9]{10}\.[0-9]{6}$/);
const sourceSchema = z.strictObject({ source_event_id: id, source_job_id: id.nullable(),
  owner_kind: z.enum(["authenticated_event_actor", "durable_job_owner"]), owner_id: id, operation_slot: id })
  .refine((source) => (source.owner_kind === "durable_job_owner") === (source.source_job_id !== null));
const contextSchema = z.strictObject({ instance_id: id, workspace_id: id, request_source: sourceSchema });
export type ApprovalSourceContext = z.infer<typeof contextSchema>;
const messageRevision = z.strictObject({ edited_ts: timestamp.nullable(), content_hmac_sha256: digest });
const schema = z.strictObject({
  codec_version: z.literal(1), operation_kind: z.literal("slack.post_thread_reply.v1"),
  instance_id: id, workspace_id: id, request_source: sourceSchema,
  target: z.strictObject({ channel_id: id, thread_ts: timestamp }),
  policy_revision: revision,
  policy: z.strictObject({ reply_broadcast: z.literal(false), special_mentions: z.literal("deny_all"),
    allowed_user_mentions: z.array(id).max(3).refine((ids) => ids.every((value, index) => index === 0 || value > ids[index - 1]!)),
    max_user_mentions: z.literal(3), shared_channel: z.literal("deny"), reconcile_marker: z.literal("block_id_attempt_id_mac_v1") }),
  encrypted_content_ref: z.string().regex(/^payload-store:[A-Za-z0-9_-]{1,128}$/),
  content_hmac_sha256: digest, content_hmac_key_version: revision,
  preconditions: z.strictObject({ thread_exists: z.literal(true), channel_is_shared: z.literal(false),
    root_message_revision: messageRevision,
    ordered_thread_revision: z.strictObject({ complete: z.literal(true), items: z.array(messageRevision.extend({ message_ts: timestamp })).min(1).max(1000) }),
    workspace_binding_revision: revision, requester_authorization_revision: revision }),
}).superRefine((snapshot, ctx) => {
  const items = snapshot.preconditions.ordered_thread_revision.items;
  const first = items[0]!; const root = snapshot.preconditions.root_message_revision;
  if (first.message_ts !== snapshot.target.thread_ts || first.edited_ts !== root.edited_ts || first.content_hmac_sha256 !== root.content_hmac_sha256
    || !items.every((item, index) => index === 0 || item.message_ts > items[index - 1]!.message_ts)) {
    ctx.addIssue({ code: "custom", message: "snapshot_revision_invalid" });
  }
});
export type ApprovalSnapshot = z.infer<typeof schema>;
export class ApprovalSnapshotError extends Error {
  constructor() { super("approval_snapshot_unverified"); this.name = "ApprovalSnapshotError"; }
}
const maximumBytes = 256 * 1024;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash("sha256").update(canonical(value), "utf8").digest("hex"); }
function guard<T>(operation: () => T): T { try { return operation(); } catch { throw new ApprovalSnapshotError(); } }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const nested of Object.values(value)) freeze(nested); Object.freeze(value); }
  return value;
}

/** Storage idempotency key only. Source ownership must be authenticated by
 * the server; possession of this key grants no access to an existing request. */
export function approvalCreationKey(contextInput: ApprovalSourceContext): string {
  return guard(() => {
    assertSynchronousResult(contextInput);
    const context = contextSchema.parse(contextInput);
    const { owner_kind: excludedOwnerKind, owner_id: excludedOwner, ...source } = context.request_source;
    return hash({ codec_version: 1, instance_id: context.instance_id, workspace_id: context.workspace_id, source });
  });
}

/** context must be derived from authenticated event identity or a persisted job
 * owner by the server. A parsed snapshot does not authenticate its requester. */
export function encodeApprovalSnapshot(input: unknown, contextInput: ApprovalSourceContext) {
  return guard(() => {
    const snapshot = schema.parse(input); const context = contextSchema.parse(contextInput);
    if (snapshot.instance_id !== context.instance_id || snapshot.workspace_id !== context.workspace_id
      || canonical(snapshot.request_source) !== canonical(context.request_source)) throw new ApprovalSnapshotError();
    const { encrypted_content_ref: excludedPayload, ...semantic } = snapshot;
    const encoded = canonical(snapshot);
    if (Buffer.byteLength(encoded, "utf8") > maximumBytes) throw new ApprovalSnapshotError();
    const creation_key = approvalCreationKey(context);
    return { canonical: encoded, semantic_hash: hash(semantic), creation_key, snapshot: freeze(snapshot) };
  });
}

/** Stored representation is canonical bytes only: duplicate keys and alternate
 * serializations are rejected instead of letting JSON.parse silently choose. */
export function decodeApprovalSnapshot(encoded: string, expectedHash: string, context: ApprovalSourceContext) {
  return guard(() => {
    if (Buffer.byteLength(encoded, "utf8") > maximumBytes) throw new ApprovalSnapshotError();
    digest.parse(expectedHash);
    const decoded = encodeApprovalSnapshot(JSON.parse(encoded), context);
    if (decoded.canonical !== encoded || !timingSafeEqual(Buffer.from(decoded.semantic_hash, "hex"), Buffer.from(expectedHash, "hex"))) throw new ApprovalSnapshotError();
    return decoded;
  });
}
