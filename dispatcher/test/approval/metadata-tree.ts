import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { emptyMetadataRoot, readMetadataValue, prepareMetadataUpdate, MetadataTreeError, MetadataConflictError } from "../../src/approval/metadata-tree.js";

const scope = { instance_id: "instance_a", workspace_id: "workspace_a", collection: "approval_records_v1" } as const;
const value = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture() {
  const nodes = new Map<string, string>(); let root = emptyMetadataRoot(scope);
  const reader = (digest: string) => nodes.get(digest);
  return { nodes, reader, get root() { return root; },
    update(key: string, old: string | null, next: string) {
      const plan = prepareMetadataUpdate(scope, root, key, old, next, reader);
      assert.equal(plan.expected_root, root); assert.equal(plan.nodes.length, 257);
      for (const node of plan.nodes) {
        const previous = nodes.get(node.digest);
        assert.ok(previous === undefined || previous === node.wire);
        nodes.set(node.digest, node.wire);
      }
      root = plan.proposed_root; return plan;
    } };
}

test("複数recordの作成と更新が他recordを維持し旧rootを変更しない", () => {
  const f = fixture(), initial = f.root;
  assert.equal(readMetadataValue(scope, initial, "request_a", f.reader), null);
  f.update("request_a", null, value("requested")); const first = f.root;
  f.update("request_b", null, value("other"));
  f.update("request_a", value("requested"), value("approved"));
  assert.equal(readMetadataValue(scope, f.root, "request_a", f.reader), value("approved"));
  assert.equal(readMetadataValue(scope, f.root, "request_b", f.reader), value("other"));
  assert.equal(readMetadataValue(scope, f.root, "request_c", f.reader), null);
  assert.equal(readMetadataValue(scope, first, "request_a", f.reader), value("requested"));
  const reopened = new Map<string, string>(JSON.parse(JSON.stringify([...f.nodes])));
  assert.equal(readMetadataValue(scope, f.root, "request_a", key => reopened.get(key)), value("approved"));
});

test("期待値不一致と重複作成はnodeを変更せず拒否する", () => {
  const f = fixture(); f.update("request_a", null, value("requested"));
  const before = [...f.nodes];
  assert.throws(() => f.update("request_a", null, value("new")), MetadataConflictError);
  assert.throws(() => f.update("request_a", value("stale"), value("new")), MetadataConflictError);
  assert.throws(() => f.update("absent", value("stale"), value("new")), MetadataConflictError);
  assert.throws(() => f.update("request_a", value("requested"), value("requested")), MetadataTreeError);
  assert.deepEqual([...f.nodes], before);
});

test("同じrecord集合は挿入順序と更新履歴によらず同じrootになる", () => {
  const first = fixture(), second = fixture();
  const keys = Array.from({ length: 12 }, (_, i) => `request_${i}`);
  for (const key of keys) first.update(key, null, value(key));
  for (const key of [...keys].reverse()) {
    second.update(key, null, value("previous"));
    second.update(key, value("previous"), value(key));
  }
  assert.equal(first.root, second.root);
  for (const key of keys) assert.equal(readMetadataValue(scope, second.root, key, second.reader), value(key));
});

test("node欠落を不在にせず破損として拒否する", () => {
  const f = fixture(); const plan = f.update("request_a", null, value("requested"));
  for (const node of [plan.nodes[0]!, plan.nodes[100]!, plan.nodes[256]!]) {
    const reader = (key: string) => key === node.digest ? undefined : f.reader(key);
    assert.throws(() => readMetadataValue(scope, f.root, "request_a", reader), MetadataTreeError);
    assert.throws(() => prepareMetadataUpdate(scope, f.root, "request_a", value("requested"), value("new"), reader), MetadataTreeError);
  }
});

test("別scopeと別pathのnodeを混ぜられない", () => {
  const f = fixture(); const a = f.update("request_a", null, value("a"));
  f.update("request_b", null, value("b"));
  assert.throws(() => readMetadataValue({ ...scope, workspace_id: "other" }, f.root, "request_a", f.reader), MetadataTreeError);
  assert.throws(() => readMetadataValue({ ...scope, instance_id: "other" }, f.root, "request_a", f.reader), MetadataTreeError);
  assert.throws(() => readMetadataValue(scope, f.root, "request_a", () => a.nodes[0]!.wire), MetadataTreeError);
  assert.throws(() => emptyMetadataRoot({ ...scope, collection: "unknown" }), MetadataTreeError);
});

test("破損と非canonicalまたは過大なwireを拒否する", () => {
  const f = fixture(); f.update("request_a", null, value("a"));
  const wire = f.reader(f.root)!;
  for (const bad of [wire.slice(1), wire + "\n", "A".repeat(177), "", Buffer.alloc(131).toString("base64")]) {
    assert.throws(() => readMetadataValue(scope, f.root, "request_a", () => bad), MetadataTreeError);
  }
  const malformed = Buffer.from(wire, "base64"); malformed[0] = 0x7f;
  const malformedRoot = createHash("sha256").update("dona.metadata-tree-node.v1\0").update(malformed).digest("hex");
  assert.throws(() => readMetadataValue(scope, malformedRoot, "request_a", () => malformed.toString("base64")), MetadataTreeError);
});

test("read数はtree深さに固定されreader例外を公開しない", () => {
  const f = fixture(); f.update("request_a", null, value("a"));
  let reads = 0;
  const reader = (key: string) => { reads++; return f.reader(key); };
  assert.equal(readMetadataValue(scope, f.root, "request_a", reader), value("a")); assert.equal(reads, 257);
  reads = 0; prepareMetadataUpdate(scope, f.root, "request_a", value("a"), value("b"), reader); assert.equal(reads, 257);
  assert.throws(() => readMetadataValue(scope, f.root, "request_a", () => { throw new Error("private-detail"); }), { message: "metadata_tree_unverified" });
});

test("実行可能scopeと不正digestを拒否し削除を提供しない", () => {
  const f = fixture(); let touched = false;
  assert.throws(() => emptyMetadataRoot({ ...scope, get extra() { touched = true; return "x"; } }), MetadataTreeError);
  assert.equal(touched, false);
  for (const bad of ["", "0".repeat(63), "G".repeat(64), value("a").toUpperCase()]) {
    assert.throws(() => prepareMetadataUpdate(scope, f.root, "request_a", null, bad, f.reader), MetadataTreeError);
    assert.throws(() => readMetadataValue(scope, bad, "request_a", f.reader), MetadataTreeError);
  }
  assert.throws(() => prepareMetadataUpdate(scope, f.root, "request_a", null, null as unknown as string, f.reader), MetadataTreeError);
});
