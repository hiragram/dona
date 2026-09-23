import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { emptyUsedTransactionRoot, isTransactionUsed, prepareUsedTransactionInsert,
  TransactionAlreadyUsedError, UsedTransactionError, type UsedTransactionScope } from "../../src/approval/used-transactions.js";

const scope: UsedTransactionScope = { instance_id: "fixture", ledger_id: "generation_1", purpose: "clock_mark" };
function fixture() {
  const nodes = new Map<string, string>(); let root = emptyUsedTransactionRoot(scope); let reads = 0;
  const reader = (key: string) => { reads++; return nodes.get(key); };
  return { nodes, reader, get root() { return root; }, get reads() { return reads; },
    insert(id: string) {
      const before = reads; const plan = prepareUsedTransactionInsert(scope, root, id, reader);
      assert.equal(plan.expected_root, root); assert.equal(plan.nodes.length, 257); assert.ok(reads - before <= 257);
      assert.ok(Buffer.byteLength(JSON.stringify(plan)) < 128 * 1024);
      for (const node of plan.nodes) { assert.ok(node.wire.length <= 176); nodes.set(node.digest, node.wire); }
      root = plan.proposed_root; return plan;
    } };
}

// Independent recursive reference: construct only populated subtrees from the
// whole set rather than following persisted branches or reusing the insert plan.
function referenceRoot(ids: string[], selectedScope = scope): string {
  const namespace = createHash("sha256").update("dona.used-transaction-scope.v1\0")
    .update([selectedScope.instance_id, selectedScope.ledger_id, selectedScope.purpose].join("\0")).digest();
  const indices = ids.map(id => createHash("sha256").update("dona.used-transaction-key.v1\0").update(namespace).update(id).digest("hex"))
    .map(hex => BigInt("0x" + hex));
  const visit = (items: bigint[], address: bigint, depth: number): Buffer => {
    const value = Buffer.alloc(67); value[0] = items.length === 0 ? 0x45 : depth === 256 ? 0x4c : 0x49;
    namespace.copy(value, 1); value.writeUInt16BE(depth, 33);
    Buffer.from(address.toString(16).padStart(64, "0"), "hex").copy(value, 35);
    let encoded = value;
    if (items.length && depth < 256) {
      const mask = 1n << BigInt(255 - depth);
      encoded = Buffer.concat([value, visit(items.filter(index => (index & mask) === 0n), address, depth + 1),
        visit(items.filter(index => (index & mask) !== 0n), address | mask, depth + 1)]);
    }
    return createHash("sha256").update("dona.used-transaction-node.v1\0").update(encoded).digest();
  };
  return visit(indices, 0n, 0).toString("hex");
}

test("used transaction tree matches an independent recursive tree and preserves old IDs", () => {
  const store = fixture(); const ids: string[] = [];
  assert.equal(store.root, referenceRoot(ids));
  assert.equal(isTransactionUsed(scope, store.root, "first", store.reader), false);
  assert.equal(store.reads, 0);
  for (const id of ["first", "second", "a", "A", "_", "-", "x".repeat(128), ...Array.from({ length: 17 }, (_, i) => `tx_${i}`)]) {
    ids.push(id); store.insert(id); assert.equal(store.root, referenceRoot(ids));
    for (const previous of ids) assert.equal(isTransactionUsed(scope, store.root, previous, store.reader), true);
  }
  assert.throws(() => prepareUsedTransactionInsert(scope, store.root, "first", store.reader), TransactionAlreadyUsedError);
  assert.equal(isTransactionUsed(scope, store.root, "unused", store.reader), false);
  const reverse = fixture(); for (const id of [...ids].reverse()) reverse.insert(id);
  assert.equal(reverse.root, store.root);
});

test("missing or rolled back auxiliary data never proves an unused transaction", () => {
  const store = fixture(); store.insert("old"); const oldRoot = store.root; const oldNodes = new Map(store.nodes);
  store.insert("new");
  assert.throws(() => isTransactionUsed(scope, store.root, "new", key => oldNodes.get(key)), UsedTransactionError);
  assert.throws(() => prepareUsedTransactionInsert(scope, store.root, "old", () => undefined), UsedTransactionError);
  const before = store.nodes.size;
  const plan = prepareUsedTransactionInsert(scope, store.root, "planned", store.reader);
  assert.equal(store.nodes.size, before); // No publication or reservation side effect.
  assert.throws(() => isTransactionUsed(scope, plan.proposed_root, "planned", store.reader), UsedTransactionError);
  for (const node of plan.nodes) store.nodes.set(node.digest, node.wire);
  assert.equal(isTransactionUsed(scope, plan.proposed_root, "planned", store.reader), true);
  assert.equal(isTransactionUsed(scope, store.root, "planned", store.reader), false); // Root CAS remains necessary.
  assert.equal(isTransactionUsed(scope, oldRoot, "new", key => oldNodes.get(key)), false); // Old roots are not current authority.
});

test("each populated path rejects record corruption, missing nodes, and another position", () => {
  const store = fixture(); const plan = store.insert("target");
  for (const node of plan.nodes) {
    const original = store.nodes.get(node.digest)!;
    store.nodes.delete(node.digest);
    assert.throws(() => isTransactionUsed(scope, store.root, "target", store.reader), UsedTransactionError);
    const changed = Buffer.from(original, "base64"); changed[changed.length - 1]! ^= 1;
    store.nodes.set(node.digest, changed.toString("base64"));
    assert.throws(() => isTransactionUsed(scope, store.root, "target", store.reader), UsedTransactionError);
    store.nodes.set(node.digest, original);
  }
  const other = fixture(); other.insert("other");
  assert.throws(() => isTransactionUsed(scope, store.root, "target", other.reader), UsedTransactionError);
  for (const changed of [{ ...scope, ledger_id: "generation_2" }, { ...scope, instance_id: "other" },
    { ...scope, purpose: "audit_anchor" as const }]) {
    assert.throws(() => isTransactionUsed(changed, store.root, "target", store.reader), UsedTransactionError);
    assert.notEqual(emptyUsedTransactionRoot(changed), emptyUsedTransactionRoot(scope));
  }
});

test("tree decoding is canonical and rejects malformed inputs before node reads", () => {
  const store = fixture(); store.insert("a");
  for (const invalid of ["", " ", "a\n", "a/b", "a\0b", "é", "x".repeat(129)]) {
    let reads = 0;
    assert.throws(() => isTransactionUsed(scope, store.root, invalid, () => { reads++; return undefined; }), UsedTransactionError);
    assert.equal(reads, 0);
  }
  for (const invalid of ["", store.root.toUpperCase(), store.root + "\n", "0".repeat(63), "z".repeat(64)]) {
    assert.throws(() => isTransactionUsed(scope, invalid, "a", store.reader), UsedTransactionError);
  }
  for (const invalid of [null, { ...scope, extra: true }, { ...scope, instance_id: "a\n" }, { ...scope, purpose: "other" }]) {
    assert.throws(() => emptyUsedTransactionRoot(invalid), UsedTransactionError);
  }
  let getterCalls = 0;
  assert.throws(() => emptyUsedTransactionRoot({ get instance_id() { getterCalls++; return "fixture"; } }), UsedTransactionError);
  assert.equal(getterCalls, 0);
  const raw = store.nodes.get(store.root)!;
  for (const invalid of [raw + "\n", raw.replace(/=+$/, ""), "x".repeat(177), "", "%%%%"])
    assert.throws(() => isTransactionUsed(scope, store.root, "a", () => invalid), UsedTransactionError);
});

test("tree reads are synchronous, bounded, and errors are redacted", () => {
  const store = fixture(); store.insert("a"); let calls = 0;
  const asynchronous = async () => { calls++; return "secret fixture detail"; };
  // @ts-expect-error asynchronous providers cannot meet the synchronous wire contract
  assert.throws(() => isTransactionUsed(scope, store.root, "a", asynchronous), UsedTransactionError);
  assert.equal(calls, 0);
  const proxy = new Proxy(store.reader, { apply() { calls++; return undefined; } });
  assert.throws(() => isTransactionUsed(scope, store.root, "a", proxy), UsedTransactionError); assert.equal(calls, 0);
  assert.throws(() => isTransactionUsed(scope, store.root, "a", () => { calls++; throw new Error("secret fixture detail"); }),
    error => error instanceof UsedTransactionError && error.message === "used_transaction_unverified");
  assert.equal(calls, 1);
  const before = store.reads; assert.equal(isTransactionUsed(scope, store.root, "a", store.reader), true);
  assert.equal(store.reads - before, 257);
  const plan = prepareUsedTransactionInsert(scope, store.root, "b", store.reader);
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.nodes) && plan.nodes.every(Object.isFrozen));
});
