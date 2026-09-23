import assert from "node:assert/strict";
import test from "node:test";
import { encodeApprovalRecord, decodeApprovalRecord, approvalRecordKey, ApprovalRecordError, maximumApprovalRecordBytes } from "../../src/approval/record-codec.js";
import { encodeApprovalSnapshot } from "../../src/approval/snapshot.js";
import { recordFixtures, recordScope, snapshotFixture } from "./fixtures/records.js";

test("7種のrecordをcanonical round-tripしkind・scope・主キーへdigestを結合する", () => {
  const keys = new Set<string>(), digests = new Set<string>();
  for (const record of Object.values(recordFixtures())) {
    const value = encodeApprovalRecord(record, recordScope), reversed = { ...record, row: Object.fromEntries(Object.entries(record.row).reverse()) };
    assert.deepEqual(decodeApprovalRecord(value.canonical, value.digest, recordScope), value);
    assert.equal(encodeApprovalRecord(reversed, recordScope).canonical, value.canonical);
    assert.ok(Object.isFrozen(value.record.row)); keys.add(value.key); digests.add(value.digest);
    assert.throws(() => decodeApprovalRecord(value.canonical, "0".repeat(64), recordScope), ApprovalRecordError);
    assert.throws(() => decodeApprovalRecord(value.canonical, value.digest, { ...recordScope, workspace_id: "other" }), ApprovalRecordError);
  }
  assert.equal(keys.size, 7); assert.equal(digests.size, 7);
  assert.notEqual(approvalRecordKey(recordScope, "request", "request"), approvalRecordKey({ ...recordScope, instance_id: "other" }, "request", "request"));
  assert.notEqual(approvalRecordKey(recordScope, "request", "request"), approvalRecordKey(recordScope, "request", "other"));
});
test("保存snapshotのcanonical bytes・hash・creation・policy・bindingを再照合する", () => {
  const record = recordFixtures().request;
  for (const changed of [{ semantic_hash: "f".repeat(64) }, { creation_key: "f".repeat(64) }, { policy_revision: 2 }, { binding_revision: 2 },
    { snapshot_json: " " + record.row.snapshot_json }, { snapshot_json: record.row.snapshot_json.replace('"codec_version":1', '"codec_version":2,"codec_version":1') },
    { snapshot_json: "x".repeat(262145) }, { snapshot_json: "あ".repeat(262144) }, { instance_id: "other" }])
    assert.throws(() => encodeApprovalRecord({ ...record, row: { ...record.row, ...changed } }, recordScope), ApprovalRecordError);
  const snapshot = snapshotFixture(); snapshot.preconditions.ordered_thread_revision.items = Array.from({ length: 1000 }, (_, n) => ({
    message_ts: (1700000000 + n) + ".000001", edited_ts: null, content_hmac_sha256: "b".repeat(64) }));
  const large = encodeApprovalSnapshot(snapshot, { ...recordScope, request_source: snapshot.request_source });
  const value = encodeApprovalRecord({ ...record, row: { ...record.row, snapshot_json: large.canonical, semantic_hash: large.semantic_hash } }, recordScope);
  assert.ok(Buffer.byteLength(value.canonical) > Buffer.byteLength(large.canonical)); assert.ok(Buffer.byteLength(value.canonical) <= maximumApprovalRecordBytes);
  assert.deepEqual(decodeApprovalRecord(value.canonical, value.digest, recordScope), value);
});
test("request TTLとconsume TTLを分けて時刻・state・安全整数の不正を拒否する", () => {
  const record = recordFixtures().request;
  const approved = { ...record, row: { ...record.row, state: "approved", consume_expires_at: "2026-09-19T00:19:00.000Z" } };
  assert.doesNotThrow(() => encodeApprovalRecord(approved, recordScope));
  for (const changed of [{ expires_at: record.row.created_at }, { expires_at: "2026-09-19T00:15:00.001Z" },
    { created_at: "2026-09-19T00:00:00Z" }, { state: "approved", consume_expires_at: null },
    { consume_expires_at: "2026-09-19T00:05:00.000Z" }, { state: "approved", consume_expires_at: "2026-09-19T00:20:00.001Z" },
    { revision: Number.MAX_SAFE_INTEGER + 1 }, { revision: 1.5 }, { model_version: "https://private.invalid" }])
    assert.throws(() => encodeApprovalRecord({ ...record, row: { ...record.row, ...changed } }, recordScope), ApprovalRecordError);
});
test("decisionのactor形・outboxのstate/ref・fence・payload保持の同一row条件を守る", () => {
  const records = recordFixtures();
  for (const [record, changed] of [
    [records.decision, { actor_kind: "requester" }], [records.decision, { presentation_revision: null }],
    [records.decision, { kind: "expire", actor_kind: "supervisor" }], [records.decision, { workspace_id: "other" }],
    [records.consume, { decision_kind: "reject" }], [records.execution, { receipt_ref: "https://private.invalid" }],
    [records.execution, { failure_code: "raw private error" }], [records.execution, { payload_expires_at: "2026-09-20T00:18:00.001Z" }],
    [records.notification, { state: "sent", fence: 1, message_ref: null }], [records.notification, { state: "dispatching", fence: 0 }],
    [records.notification, { message_ref: "adapter_message" }], [records.event, { state: "delivered", delivered_at: null }],
    [records.event, { delivered_at: "2026-09-19T00:15:00.000Z" }], [records.presentation, { state: "dispatching", fence: 0 }],
  ] as const) assert.throws(() => encodeApprovalRecord({ ...record, row: { ...record.row, ...changed } }, recordScope), ApprovalRecordError);
});
test("unknown version/field・重複JSON key・本文・実行可能な入力を固定errorで拒否する", () => {
  const record = recordFixtures().request, value = encodeApprovalRecord(record, recordScope);
  for (const invalid of [{ ...record, codec_version: 2 }, { ...record, kind: "unknown" }, { ...record, body: "private text" },
    { ...record, row: { ...record.row, token: "private credential" } }, new Proxy(record, {})])
    assert.throws(() => encodeApprovalRecord(invalid, recordScope), { name: "ApprovalRecordError", message: "approval_record_unverified" });
  let invoked = false; const getter = { ...record }; Object.defineProperty(getter, "row", { get: () => { invoked = true; return record.row; }, enumerable: true });
  assert.throws(() => encodeApprovalRecord(getter, recordScope), ApprovalRecordError); assert.equal(invoked, false);
  for (const raw of [" " + value.canonical, value.canonical.replace('"codec_version":1', '"codec_version":2,"codec_version":1'), "x".repeat(maximumApprovalRecordBytes + 1)])
    assert.throws(() => decodeApprovalRecord(raw, value.digest, recordScope), ApprovalRecordError);
});
