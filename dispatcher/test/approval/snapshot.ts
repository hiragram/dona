import assert from "node:assert/strict";
import test from "node:test";
import { approvalCreationKey, encodeApprovalSnapshot, decodeApprovalSnapshot, ApprovalSnapshotError, type ApprovalSnapshot, type ApprovalSourceContext } from "../../src/approval/snapshot.js";
const context: ApprovalSourceContext = { instance_id: "instance_a", workspace_id: "workspace_a",
  request_source: { source_event_id: "event_a", source_job_id: null, owner_kind: "authenticated_event_actor", owner_id: "requester_a", operation_slot: "reply_1" } };
function fixture(): ApprovalSnapshot {
  return { codec_version: 1, operation_kind: "slack.post_thread_reply.v1", ...structuredClone(context),
    target: { channel_id: "channel_a", thread_ts: "1700000000.000001" }, policy_revision: 1,
    policy: { reply_broadcast: false, special_mentions: "deny_all", allowed_user_mentions: ["user_a"], max_user_mentions: 3, shared_channel: "deny", reconcile_marker: "block_id_attempt_id_mac_v1" },
    encrypted_content_ref: "payload-store:content_a", content_hmac_sha256: "a".repeat(64), content_hmac_key_version: 1,
    preconditions: { thread_exists: true, channel_is_shared: false, root_message_revision: { edited_ts: null, content_hmac_sha256: "b".repeat(64) },
      ordered_thread_revision: { complete: true, items: [{ message_ts: "1700000000.000001", edited_ts: null, content_hmac_sha256: "b".repeat(64) },
        { message_ts: "1700000001.000001", edited_ts: null, content_hmac_sha256: "c".repeat(64) }] }, workspace_binding_revision: 3, requester_authorization_revision: 7 } };
}
test("snapshotはfield順序非依存で保存形式からdecodeでき、immutableになる", () => {
  const value = fixture(); const encoded = encodeApprovalSnapshot(value, context);
  const reordered = Object.fromEntries(Object.entries(value).reverse());
  assert.equal(encodeApprovalSnapshot(reordered, context).canonical, encoded.canonical);
  assert.deepEqual(decodeApprovalSnapshot(encoded.canonical, encoded.semantic_hash, context), encoded);
  assert.equal(Object.isFrozen(encoded.snapshot.preconditions.ordered_thread_revision.items), true);
  assert.throws(() => encoded.snapshot.policy.allowed_user_mentions.push("user_b"), TypeError);
  value.policy.allowed_user_mentions.push("user_b");
  assert.deepEqual(encoded.snapshot.policy.allowed_user_mentions, ["user_a"]);
});
test("payload参照以外のsemantic変更はhashを変え、同じcreation keyへconflictを通知できる", () => {
  const original = encodeApprovalSnapshot(fixture(), context);
  const payload = fixture(); payload.encrypted_content_ref = "payload-store:content_b";
  assert.equal(encodeApprovalSnapshot(payload, context).semantic_hash, original.semantic_hash);
  for (const change of [(s: ApprovalSnapshot) => { s.target.channel_id = "channel_b"; },
    (s: ApprovalSnapshot) => { s.policy_revision++; }, (s: ApprovalSnapshot) => { s.content_hmac_key_version++; },
    (s: ApprovalSnapshot) => { s.preconditions.requester_authorization_revision++; },
    (s: ApprovalSnapshot) => { s.preconditions.ordered_thread_revision.items[1]!.content_hmac_sha256 = "d".repeat(64); }]) {
    const changed = fixture(); change(changed); const encoded = encodeApprovalSnapshot(changed, context);
    assert.notEqual(encoded.semantic_hash, original.semantic_hash); assert.equal(encoded.creation_key, original.creation_key);
    assert.throws(() => decodeApprovalSnapshot(encoded.canonical, original.semantic_hash, context), ApprovalSnapshotError);
  }
});
test("source/owner越境、unknown codec/operation/field、本文とprivate URLを拒否する", () => {
  for (const invalid of [
    { ...fixture(), codec_version: 2 }, { ...fixture(), operation_kind: "shell.exec" }, { ...fixture(), body: "private text" },
    { ...fixture(), encrypted_content_ref: "https://private.example/file" },
    { ...fixture(), request_source: { ...context.request_source, owner_id: "other" } },
    { ...fixture(), workspace_id: "other" },
    { ...fixture(), request_source: { ...context.request_source, source_job_id: "job_a" } },
  ]) assert.throws(() => encodeApprovalSnapshot(invalid, context), ApprovalSnapshotError);
  assert.throws(() => encodeApprovalSnapshot(fixture(), { ...context, instance_id: "other" }), ApprovalSnapshotError);
});
test("threadの欠落・並べ替え・root不一致と広範なmentionを受理しない", () => {
  const invalid: ApprovalSnapshot[] = [];
  let value = fixture(); value.preconditions.ordered_thread_revision.items.reverse(); invalid.push(value);
  value = fixture(); value.preconditions.ordered_thread_revision.items.shift(); invalid.push(value);
  value = fixture(); value.preconditions.ordered_thread_revision.items[0]!.edited_ts = "1700000002.000001"; invalid.push(value);
  value = fixture(); value.policy.allowed_user_mentions = ["user_b", "user_a"]; invalid.push(value);
  value = fixture(); value.policy.allowed_user_mentions = ["user_a", "user_a"]; invalid.push(value);
  for (const snapshot of invalid) assert.throws(() => encodeApprovalSnapshot(snapshot, context), ApprovalSnapshotError);
  assert.throws(() => encodeApprovalSnapshot({ ...fixture(), policy: { ...fixture().policy, reply_broadcast: true } }, context), ApprovalSnapshotError);
});
test("canonical保存bytes以外と重複keyを拒否する", () => {
  const encoded = encodeApprovalSnapshot(fixture(), context);
  for (const raw of [" " + encoded.canonical, encoded.canonical.replace('"codec_version":1', '"codec_version":2,"codec_version":1'), "x".repeat(256 * 1024 + 1)]) {
    assert.throws(() => decodeApprovalSnapshot(raw, encoded.semantic_hash, context), ApprovalSnapshotError);
  }
});

test("creation keyを先行lookupへ使っても既存codecと互換でowner認可の代わりにしない",()=>{
 const original=encodeApprovalSnapshot(fixture(),context);
 assert.equal(approvalCreationKey(context),original.creation_key);
 assert.equal(approvalCreationKey({...context,request_source:{...context.request_source,owner_id:"other"}}),original.creation_key);
 assert.notEqual(approvalCreationKey({...context,request_source:{...context.request_source,operation_slot:"other"}}),original.creation_key);
 let calls=0;assert.throws(()=>approvalCreationKey(new Proxy(context,{get(){calls++;throw Error();}})),ApprovalSnapshotError);assert.equal(calls,0);
});
