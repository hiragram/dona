import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { approvalIndexKey, encodeApprovalIndex, decodeApprovalIndex, ApprovalIndexError, type ApprovalIndex } from "../../src/approval/index-codec.js";
const scope = { instance_id: "instance", workspace_id: "tenant" };
const list = { record_kind: "request", membership: "all" } as const;
const base = { codec_version: 1, scope } as const;
const manifest = { ...base, kind: "manifest", list, count: 1, head: "a", tail: "a" } as const;
const link = { ...base, kind: "link", list, record_id: "a", member: true, previous: null, next: null } as const;
const alias = { ...base, kind: "alias", selector: { name: "request_creation", creation_key: "a".repeat(64) }, target: "a" } as const;
function encoded(input: unknown) { return encodeApprovalIndex(input, scope); }

test("manifest・link・aliasをscope付きcanonical blobとして独立したpointへ結ぶ", () => {
  const keys = new Set<string>();
  for (const input of [manifest, link, alias]) {
    const value = encoded(input); keys.add(value.key);
    assert.deepEqual(decodeApprovalIndex(value.wire, value.digest, scope).index, input);
    assert.ok(Object.isFrozen(value.index) && Object.isFrozen(value.index.scope));
    assert.equal(encoded(Object.fromEntries(Object.entries(input).reverse())).wire, value.wire);
    const otherScope = { ...scope, workspace_id: "other" };
    const other = encodeApprovalIndex({ ...input, scope: otherScope }, otherScope);
    assert.notEqual(other.key, value.key); assert.notEqual(other.digest, value.digest);
    assert.throws(() => decodeApprovalIndex(value.wire, value.digest, otherScope), ApprovalIndexError);
  }
  assert.equal(keys.size, 3);
  const changed = encoded({ ...manifest, count: 2, head: "a", tail: "b" });
  assert.equal(changed.key, encoded(manifest).key); assert.notEqual(changed.digest, encoded(manifest).digest);
  assert.equal(approvalIndexKey(scope, { kind: "manifest", list }), changed.key);
  assert.notEqual(approvalIndexKey(scope, { kind: "manifest", list: { ...list, membership: "active" } }), changed.key);
});

test("空・単一・複数manifestとactive tombstoneの局所不変条件を検証する", () => {
  for (const input of [
    { ...manifest, count: 0, head: null, tail: null },
    { ...manifest, count: 2, head: "a", tail: "b" },
    { ...link, previous: "b", next: "c" },
    { ...link, list: { ...list, membership: "active" }, member: false },
  ]) encoded(input);
  for (const input of [
    { ...manifest, count: -1 }, { ...manifest, count: 0 }, { ...manifest, count: 2 },
    { ...manifest, count: 1.5 }, { ...manifest, count: Number.MAX_SAFE_INTEGER + 1 },
    { ...manifest, head: null }, { ...manifest, tail: "b" },
    { ...link, previous: "a" }, { ...link, next: "a" }, { ...link, previous: "b", next: "b" },
    { ...link, member: false }, { ...link, member: false, list: { ...list, membership: "active" }, next: "b" },
    { ...manifest, list: { record_kind: "decision", membership: "active" } },
    { ...manifest, list: { record_kind: "consume", membership: "active" } },
  ]) assert.throws(() => encoded(input), ApprovalIndexError);
});

test("固定secondary selectorは衝突せずactive message枠だけ明示的に解放できる", () => {
  const selectors: Extract<ApprovalIndex, { kind: "alias" }>["selector"][] = [
    alias.selector, { name: "decision_id", decision_id: "x" }, { name: "consume_id", consume_id: "x" },
    { name: "consume_decision", decision_id: "x" }, { name: "consume_attempt", attempt_id: "x" },
    { name: "execution_request", request_id: "x" }, { name: "execution_consume", consume_id: "x" },
    { name: "notification_request_kind", request_id: "x", notification_kind: "approval_card" },
    { name: "notification_request_kind", request_id: "x", notification_kind: "pending_notice" },
    { name: "notification_message", message_ref: "x" }, { name: "event_decision", decision_id: "x" },
    { name: "presentation_revision", notification_attempt_id: "x", desired_revision: 1 },
    { name: "presentation_revision", notification_attempt_id: "x", desired_revision: 2 },
    { name: "presentation_active_message", message_ref: "x" },
  ];
  assert.equal(new Set(selectors.map(selector => encoded({ ...alias, selector }).key)).size, selectors.length);
  for (const selector of selectors) {
    const operation = () => encoded({ ...alias, selector, target: null });
    if (selector.name === "presentation_active_message") operation();
    else assert.throws(operation, ApprovalIndexError);
  }
  for (const selector of [{ name: "arbitrary", sql: "private" }, { name: "decision_id", decision_id: "https://private.invalid" },
    { name: "presentation_revision", notification_attempt_id: "x", desired_revision: 0 }])
    assert.throws(() => encoded({ ...alias, selector }), ApprovalIndexError);
});

test("改変・非canonical・過大入力・accessorを固定errorで拒否する", () => {
  const value = encoded(manifest);
  const digestFor = (wire: string) => createHash("sha256").update("dona.approval-index.v1\0").update(wire).digest("hex");
  for (const wire of [" " + value.wire, value.wire.replace('"count":1', '"count":1.0'), value.wire.replace('"count":1', '"count":1,"count":1'),
    "x".repeat(2049), "null", "[]", "{}"])
    assert.throws(() => decodeApprovalIndex(wire, digestFor(wire), scope), ApprovalIndexError);
  assert.throws(() => decodeApprovalIndex(value.wire, "0".repeat(64), scope), ApprovalIndexError);
  let invoked = false;
  const getter = { ...manifest }; Object.defineProperty(getter, "count", { enumerable: true, get() { invoked = true; throw Error("private"); } });
  for (const input of [getter, new Proxy(manifest, {}), { ...manifest, codec_version: 2 }, { ...manifest, raw: "private" },
    { ...manifest, scope: { ...scope, raw: "private" } }, { ...manifest, head: "x".repeat(129) }])
    assert.throws(() => encoded(input), { name: "ApprovalIndexError", message: "approval_index_unverified" });
  assert.equal(invoked, false);
  const largeScope = { instance_id: "i".repeat(128), workspace_id: "w".repeat(128) };
  const large = encodeApprovalIndex({ ...alias, scope: largeScope,
    selector: { name: "presentation_revision", notification_attempt_id: "n".repeat(128), desired_revision: Number.MAX_SAFE_INTEGER }, target: "t".repeat(128) }, largeScope);
  assert.ok(large.wire.length < 2048);
});
