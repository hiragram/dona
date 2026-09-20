import assert from "node:assert/strict";
import { test } from "node:test";
import { setup, scope as auditScope } from "../web/fixtures.js";
import { installApprovalMetadataSchema, installApprovalIndexSchema } from "../../src/approval/schema.js";
import { ApprovalMetadataNodes } from "../../src/approval/metadata-store.js";
import { ApprovalIndexBlobs } from "../../src/approval/index-store.js";
import { ApprovalMetadataPlan, ApprovalMetadataPlanError, type PreparedApprovalMetadata } from "../../src/approval/metadata-plan.js";
import { ApprovalMetadataPlanWriter, ApprovalMetadataPlanStoreError } from "../../src/approval/metadata-plan-store.js";
import { appendApprovalList, removeActiveApprovalList, readApprovalListHead } from "../../src/approval/index-list.js";
import { encodeApprovalIndex, type ApprovalIndex, type ApprovalIndexList } from "../../src/approval/index-codec.js";
import { encodeApprovalRecord, type ApprovalRecord } from "../../src/approval/record-codec.js";
import { emptyMetadataRoot, MetadataConflictError, prepareMetadataUpdate } from "../../src/approval/metadata-tree.js";
import { assertSynchronousResult } from "../../src/audit/synchronous.js";
import { ApprovalTransactionError } from "../../src/approval/transaction.js";
import type { AuditEvent } from "../../src/audit/codec.js";
const scope = { instance_id: auditScope.instance_id, workspace_id: auditScope.tenant_id };
const treeScope = { ...scope, collection: "approval_records_v1" } as const;
const empty = emptyMetadataRoot(treeScope);
const all = { record_kind: "request", membership: "all" } as const;
const active = { record_kind: "request", membership: "active" } as const;
const event: Omit<AuditEvent, "occurred_at"> = { scope: auditScope, actor: { kind: "system", id: "fixture" }, action: "approval_request", operation: "slack.post_thread_reply.v1", resource_id: "approval_records", outcome: "succeeded", reason: "none", session_ref: null, receipt_id: null, attempt_id: null, policy_revision: 1, binding_revision: 1, authz_revision: 1 };
const blank = (list: ApprovalIndexList): ApprovalIndex => ({ codec_version: 1, scope, kind: "manifest", list, count: 0, head: null, tail: null });
const alias = (index: number): ApprovalIndex => ({ codec_version: 1, scope, kind: "alias", selector: { name: "decision_id", decision_id: `decision_${index}` }, target: `request_${index}` });
function fixture(t: { after(fn: () => void): void }) {
  const f = setup(t); installApprovalMetadataSchema(f.db); installApprovalIndexSchema(f.db);
  return { ...f, nodes: new ApprovalMetadataNodes(f.db), indexes: new ApprovalIndexBlobs(f.db, scope), writer: new ApprovalMetadataPlanWriter(f.db, scope) };
}
type Fixture = ReturnType<typeof fixture>;
function prepare(f: Fixture, root: string, work: (plan: ApprovalMetadataPlan) => void): PreparedApprovalMetadata {
  return f.nodes.read(nodes => f.indexes.read(indexes => {
    const plan = new ApprovalMetadataPlan(scope, root, nodes, indexes); work(plan); return plan.finish();
  }));
}
function commit(f: Fixture, transactionId: string, work: (plan: ApprovalMetadataPlan) => void, fail = false) {
  return f.transaction.runPrepared(transactionId, (_mark, state) => {
    const binding = state.resource_bindings.find(value => value.resource_id === "approval_records");
    // 既知の空fixtureのみでgenesisを選ぶ。runtimeの欠落binding fallbackではない。
    if (!binding) assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_metadata_nodes").get(), { n: 0 });
    const plan = prepare(f, binding?.resource_digest ?? empty, work);
    return { event, resource_digest: plan.proposed_root, mutation: () => {
      f.writer.stage(plan); if (fail) throw Error("fixture rollback"); return plan.proposed_root;
    } };
  });
}
function head(f: Fixture, list: ApprovalIndexList, limit = 32) {
  return f.audit.readVerifiedState(state => {
    const root = state.resource_bindings.find(value => value.resource_id === "approval_records")!.resource_digest;
    return f.nodes.read(nodes => f.indexes.read(indexes => readApprovalListHead(new ApprovalMetadataPlan(scope, root, nodes, indexes), list, limit)));
  });
}

test("all/activeを1rootで追加・除外し履歴とactive tombstoneを保持する", t => {
  const f = fixture(t);
  commit(f, "initialize", plan => { plan.putIndex(null, blank(all)); plan.putIndex(null, blank(active)); });
  for (const id of ["a", "b", "c", "d"]) commit(f, "append_" + id, plan => { appendApprovalList(plan, all, id); appendApprovalList(plan, active, id); });
  assert.deepEqual(head(f, all), { count: 4, ids: ["a", "b", "c", "d"], truncated: false });
  assert.deepEqual(head(f, active, 2), { count: 4, ids: ["a", "b"], truncated: true });
  for (const id of ["b", "a", "d", "c"]) commit(f, "remove_" + id, plan => removeActiveApprovalList(plan, active, id));
  assert.deepEqual(head(f, active), { count: 0, ids: [], truncated: false });
  assert.equal(head(f, all).count, 4);
  commit(f, "reactivate_b", plan => appendApprovalList(plan, active, "b"));
  assert.deepEqual(head(f, active), { count: 1, ids: ["b"], truncated: false });
});

test("record pointとalias/listを同じ更新案へ結び変更なしは検証後に省略する", t => {
  const f = fixture(t);
  const record: ApprovalRecord = { codec_version: 1, scope, kind: "event", row: { event_id: "event", decision_id: "decision", kind: "dona_approval.decision.v1", state: "pending", delivered_at: null } };
  const encoded = encodeApprovalRecord(record, scope);
  const root = commit(f, "point", plan => { plan.putRecord(null, record); plan.putIndex(null, alias(1)); plan.putIndex(null, blank(all)); });
  f.db.transaction(() => {
    const plan = prepare(f, root, p => {
      assert.equal(p.readRecordDigest("event", "event"), encoded.digest);
      assert.equal(p.readRecordDigest("request", "event"), null);
      p.putRecord(encoded.digest, record); p.putIndex(alias(1), alias(1));
    });
    assert.equal(plan.proposed_root, root); assert.deepEqual(plan.node_wires, []); assert.deepEqual(plan.index_wires, []);
    f.writer.stage(plan);
  })();
});

test("32point更新が既存同期result budgetとbatch上限内で保存される", t => {
  const f = fixture(t); let size = 0;
  commit(f, "maximum", plan => {
    for (let index = 0; index < 32; index++) plan.putIndex(null, alias(index));
    for (let index = 0; index < 32; index++) plan.putIndex(alias(index), { ...alias(index), target: `latest_${index}` } as ApprovalIndex);
  });
  const values = f.db.prepare("SELECT wire FROM approval_metadata_nodes").all() as { wire: string }[];
  size = values.length; assert.ok(size > 257 && size <= 32 * 257);
  assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_index_blobs").get(), { n: 32 });
  f.audit.readVerifiedState(state => f.nodes.read(nodes => f.indexes.read(indexes => {
    const plan = new ApprovalMetadataPlan(scope, state.resource_bindings.find(value => value.resource_id === "approval_records")!.resource_digest, nodes, indexes);
    for (let index = 0; index < 32; index++) assert.deepEqual(plan.readIndex({ kind: "alias", selector: { name: "decision_id", decision_id: `decision_${index}` } }), { ...alias(index), target: `latest_${index}` });
    assertSynchronousResult(plan.finish()); return null;
  })));
});

test("競合・上限・callback障害・finish後のplanは再利用できない", () => {
  const make = () => new ApprovalMetadataPlan(scope, empty, () => undefined, () => undefined);
  const conflict = make(); conflict.putIndex(null, alias(0));
  assert.throws(() => conflict.putIndex(null, alias(0)), MetadataConflictError); assert.throws(() => conflict.finish(), ApprovalMetadataPlanError);
  const cap = make(); for (let index = 0; index < 32; index++) cap.putIndex(null, alias(index));
  assert.throws(() => cap.putIndex(null, alias(32)), ApprovalMetadataPlanError); assert.throws(() => cap.finish(), ApprovalMetadataPlanError);
  const reads = make(); for (let index = 0; index < 256; index++) reads.readRecordDigest("event", "event");
  assert.throws(() => reads.readRecordDigest("event", "event"), ApprovalMetadataPlanError); assert.throws(() => reads.finish(), ApprovalMetadataPlanError);
  const sealed = make(); sealed.putIndex(null, blank(all)); const result = sealed.finish();
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.node_wires)); assert.throws(() => sealed.finish(), ApprovalMetadataPlanError);
  assert.throws(() => sealed.putIndex(null, alias(0)), ApprovalMetadataPlanError);
  assert.throws(() => make().finish(), ApprovalMetadataPlanError);
  const blob = encodeApprovalIndex(blank(all), scope), tree = prepareMetadataUpdate(treeScope, empty, blob.key, null, blob.digest, () => undefined);
  const nodes = new Map(tree.nodes.map(node => [node.digest, node.wire]));
  for (const source of [() => undefined, () => { throw new MetadataConflictError(); }, () => "{}"] ) {
    const plan = new ApprovalMetadataPlan(scope, tree.proposed_root, hash => nodes.get(hash), source);
    assert.throws(() => plan.readIndex({ kind: "manifest", list: all }), ApprovalMetadataPlanError);
    assert.throws(() => plan.finish(), ApprovalMetadataPlanError);
  }
  const wrong = encodeApprovalIndex(alias(7), scope);
  const rebound = prepareMetadataUpdate(treeScope, empty, blob.key, null, wrong.digest, () => undefined);
  const reboundNodes = new Map(rebound.nodes.map(node => [node.digest, node.wire]));
  const mismatched = new ApprovalMetadataPlan(scope, rebound.proposed_root, hash => reboundNodes.get(hash), () => wrong.wire);
  assert.throws(() => mismatched.readIndex({ kind: "manifest", list: all }), ApprovalMetadataPlanError);
});

test("同じpointの64回更新は最終node/blobだけを保持して中間値を保存しない", t => {
  const f = fixture(t);
  const versions = Array.from({ length: 65 }, (_, index): ApprovalIndex => ({ codec_version: 1, scope, kind: "alias",
    selector: { name: "presentation_active_message", message_ref: "message" }, target: `update_${index}` }));
  const plan = f.db.transaction(() => prepare(f, empty, p => {
    for (let index = 0; index < 64; index++) p.putIndex(index === 0 ? null : versions[index - 1]!, versions[index]!);
  }))();
  assert.equal(plan.node_wires.length, 257); assert.equal(plan.index_wires.length, 1); assertSynchronousResult(plan);
  f.db.transaction(() => f.writer.stage(plan)).immediate();
  assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_index_blobs").get(), { n: 1 });
  f.db.transaction(() => f.nodes.read(nodes => f.indexes.read(indexes => {
    const p = new ApprovalMetadataPlan(scope, plan.proposed_root, nodes, indexes);
    assert.deepEqual(p.readIndex({ kind: "alias", selector: { name: "presentation_active_message", message_ref: "message" } }), versions[63]);
    return null;
  })))();
  const cap = new ApprovalMetadataPlan(scope, empty, () => undefined, () => undefined);
  for (let index = 0; index < 64; index++) cap.putIndex(index === 0 ? null : versions[index - 1]!, versions[index]!);
  assert.throws(() => cap.putIndex(versions[63]!, versions[64]!), ApprovalMetadataPlanError);
  assert.throws(() => cap.finish(), ApprovalMetadataPlanError);
});

test("欠落manifest・重複追加・all除外を拒否し複合操作失敗後のplanを破棄する", () => {
  const make = () => new ApprovalMetadataPlan(scope, empty, () => undefined, () => undefined);
  const missing = make(); missing.putIndex(null, alias(0));
  assert.throws(() => appendApprovalList(missing, all, "a"), ApprovalMetadataPlanError); assert.throws(() => missing.finish(), ApprovalMetadataPlanError);
  const duplicate = make(); duplicate.putIndex(null, blank(all)); appendApprovalList(duplicate, all, "a");
  assert.throws(() => appendApprovalList(duplicate, all, "a"), MetadataConflictError); assert.throws(() => duplicate.finish(), ApprovalMetadataPlanError);
  const remove = make(); remove.putIndex(null, blank(all)); appendApprovalList(remove, all, "a");
  assert.throws(() => removeActiveApprovalList(remove, all, "a"), ApprovalMetadataPlanError); assert.throws(() => remove.finish(), ApprovalMetadataPlanError);
  const absent = make(); absent.putIndex(null, blank(active));
  assert.throws(() => removeActiveApprovalList(absent, active, "a"), MetadataConflictError);
  const invalid = make(); invalid.putIndex(null, blank(all)); assert.throws(() => readApprovalListHead(invalid, all, 33), ApprovalMetadataPlanError);
  assert.throws(() => invalid.finish(), ApprovalMetadataPlanError);
});

test("reciprocal link・件数・末端が不整合なら部分一覧を完全扱いしない", () => {
  const make = () => new ApprovalMetadataPlan(scope, empty, () => undefined, () => undefined);
  for (const fault of ["previous", "count", "tail", "cycle"] as const) {
    const plan = make(); plan.putIndex(null, blank(active)); for (const id of ["a", "b", "c"]) appendApprovalList(plan, active, id);
    if (fault === "count") {
      const current = plan.readIndex({ kind: "manifest", list: active }); assert.equal(current?.kind, "manifest");
      plan.putIndex(current, { ...current!, count: 4 } as ApprovalIndex);
    } else {
      const current = plan.readIndex({ kind: "link", list: active, record_id: fault === "tail" ? "c" : "b" }); assert.equal(current?.kind, "link");
      plan.putIndex(current, { ...current!, ...(fault === "previous" ? { previous: null } : fault === "tail" ? { next: "d" } : { next: "a", previous: null }) } as ApprovalIndex);
    }
    assert.throws(() => readApprovalListHead(plan, active, 32), ApprovalMetadataPlanError);
    assert.throws(() => plan.finish(), ApprovalMetadataPlanError);
  }
});

test("後続batch失敗とanchor応答喪失で全node/blobが同じ境界に従う", t => {
  for (const fault of ["mutation", "second_batch", "reserve_after", "finalize_before", "finalize_after"] as const) {
    const f = fixture(t); if (fault !== "mutation" && fault !== "second_batch") f.anchors.fault = fault;
    const prepare = f.db.prepare.bind(f.db); let insertBatches = 0;
    if (fault === "second_batch") f.db.prepare = ((...args: Parameters<typeof f.db.prepare>) => {
      if (args[0] === "INSERT INTO main.approval_metadata_nodes(digest,wire) VALUES (?,?)" && ++insertBatches === 2) {
        assert.deepEqual(prepare("SELECT count(*) AS n FROM approval_metadata_nodes").get(), { n: 257 });
        throw Error("fixture second batch failure");
      }
      return prepare(...args);
    }) as typeof f.db.prepare;
    try { assert.throws(() => commit(f, "fault", plan => { for (let index = 0; index < 4; index++) plan.putIndex(null, alias(index)); }, fault === "mutation"), ApprovalTransactionError); }
    finally { f.db.prepare = prepare; }
    if (fault === "second_batch") assert.equal(insertBatches, 2);
    const committed = fault.startsWith("finalize");
    assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_index_blobs").get(), { n: committed ? 4 : 0 });
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM approval_metadata_nodes").get() as { n: number }).n > 257, committed);
    assert.deepEqual(f.anchors.calls, committed ? ["reserve", "finalize"] : ["reserve"]);
  }
});

test("writerは別scope・過大plan・改変wire・独立transaction呼出しを拒否する", t => {
  const f = fixture(t); const plan = f.db.transaction(() => prepare(f, empty, p => p.putIndex(null, blank(all))))();
  assert.throws(() => f.writer.stage(plan), ApprovalMetadataPlanStoreError);
  for (const changed of [
    { ...plan, scope: { ...scope, workspace_id: "other" } }, { ...plan, node_wires: [...plan.node_wires, plan.node_wires[0]!] },
    { ...plan, node_wires: ["x"] }, { ...plan, index_wires: ["x".repeat(2049)] },
    { ...plan, proposed_root: "0".repeat(64) }, { ...plan, node_wires: Array(32 * 257 + 1).fill(plan.node_wires[0]) },
  ]) assert.throws(() => f.db.transaction(() => f.writer.stage(changed))(), ApprovalMetadataPlanStoreError);
  assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_metadata_nodes").get(), { n: 0 });
  assert.throws(() => f.audit.readVerified(() => f.writer.stage(plan)));
});
