import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { openSecurityDatabase } from "../../src/audit/coordination.js";
import { SqliteUsedTransactionNodes, installUsedTransactionNodeSchema, UsedTransactionStoreError, type ImmutableUsedTransactionNodes } from "../../src/approval/used-transaction-store.js";
import { emptyUsedTransactionRoot, prepareUsedTransactionInsert, type UsedTransactionScope } from "../../src/approval/used-transactions.js";
import { ProtectedClockMarks, ProtectedAuditAnchors, encodeProtectedHead, ProtectedHeadError,
  type ProtectedHeadPort, type ProtectedHeadEntry } from "../../src/approval/protected-heads.js";
import { advanceClockMark, reserveClockMark, type ClockMark } from "../../src/approval/clock.js";
import type { AuditAnchor } from "../../src/audit/codec.js";
import { AuditRepository } from "../../src/audit/repository.js";
import { WebAuthRepository } from "../../src/web/repository.js";
import { setup as webFixture, scope as webScope } from "../web/fixtures.js";
const initial: ClockMark = { codec_version: 1, transaction_id: "initial", previous_transaction_id: null,
  boot_id: "fixture_boot", continuous_ms: 1000, effective_utc: "2026-09-19T00:00:00.000Z" };
const initialAnchor: AuditAnchor = { chain_id: "fixture_chain", sequence: 0, mac: "0".repeat(64), checkpoint_mac: "1".repeat(64), pending_transaction_id: null };
const clockScope: UsedTransactionScope = { instance_id: "fixture", ledger_id: "clock_1", purpose: "clock_mark" };
const auditScope: UsedTransactionScope = { instance_id: "fixture", ledger_id: "audit_1", purpose: "audit_anchor" };
// Explicit in-memory fault model; not an OS-protected or production port.
class FixturePort implements ProtectedHeadPort {
  reads = 0; writes = 0;
  fault: "none" | "before" | "after" | "response" | "readback" = "none";
  constructor(public current: ProtectedHeadEntry) {}
  read(): ProtectedHeadEntry {
    this.reads++; if (this.fault === "readback" && this.writes) throw Error("fixture readback lost"); return { ...this.current };
  }
  compareExchange(expected: ProtectedHeadEntry, proposed: string): ProtectedHeadEntry {
    this.writes++; assert.deepEqual(expected, this.current);
    if (this.fault === "before") throw Error("fixture conflict");
    this.current = { revision: expected.revision + 1, value: proposed };
    if (this.fault === "after") throw Error("fixture reply lost");
    return this.fault === "response" ? { ...this.current, revision: this.current.revision + 1 } : { ...this.current };
  }
}
function fixture(t: TestContext, scope = clockScope) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.homedir()), ".dona-used-id-fixture-"));
  const filename = path.join(directory, "nodes.sqlite"); fs.writeFileSync(filename, "", { flag: "wx", mode: 0o600 });
  const db = openSecurityDatabase(filename); db.pragma("journal_mode=WAL"); db.pragma("synchronous=FULL");
  assert.throws(() => new SqliteUsedTransactionNodes(db), UsedTransactionStoreError);
  installUsedTransactionNodeSchema(db); installUsedTransactionNodeSchema(db);
  const nodes = new SqliteUsedTransactionNodes(db);
  const plan = prepareUsedTransactionInsert(scope, emptyUsedTransactionRoot(scope), "initial", digest => nodes.read(digest)); nodes.stage(plan.nodes);
  const port = new FixturePort({ revision: 1, value: encodeProtectedHead({ codec_version: 1, kind: scope.purpose, scope,
    used_root: plan.proposed_root, last_reservation_id: "initial", state: scope.purpose === "clock_mark" ? initial : initialAnchor }) });
  t.after(() => { if (db.open) db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { db, filename, nodes, port, initialNodes: plan.nodes };
}
function next(mark: ClockMark, transactionId: string): ClockMark {
  return advanceClockMark(mark, { boot_id: mark.boot_id, continuous_ms: mark.continuous_ms + 1000,
    wall_utc: new Date(Date.parse(mark.effective_utc) + 1000).toISOString() }, transactionId, 0);
}

test("SQLite node storeは初期化・immutable stage・再openを検証する", t => {
  const f = fixture(t); f.nodes.stage(f.initialNodes);
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM used_transaction_nodes").get() as { n: number }).n, 257);
  assert.throws(() => f.db.prepare("UPDATE used_transaction_nodes SET wire=wire").run());
  assert.throws(() => f.db.prepare("DELETE FROM used_transaction_nodes").run());
  for (const node of f.initialNodes) assert.equal(f.nodes.read(node.digest), node.wire);
  assert.equal(f.nodes.read("0".repeat(64)), undefined);
  f.db.close(); const reopened = openSecurityDatabase(f.filename); reopened.pragma("synchronous=FULL");
  try { const store = new SqliteUsedTransactionNodes(reopened); assert.equal(store.read(f.initialNodes[0]!.digest), f.initialNodes[0]!.wire); }
  finally { reopened.close(); }
});

test("TEMP shadowやtriggerをCAS前に拒否し再open後も元headを検証できる", t => {
  for (const sql of [
    "CREATE TEMP TABLE used_transaction_node_schema AS SELECT * FROM main.used_transaction_node_schema; CREATE TEMP TABLE used_transaction_nodes AS SELECT * FROM main.used_transaction_nodes",
    "CREATE TEMP VIEW used_transaction_nodes AS SELECT * FROM main.used_transaction_nodes",
    "CREATE TEMP TRIGGER temporary_insert AFTER INSERT ON main.used_transaction_nodes BEGIN SELECT 1; END",
  ]) {
    const f = fixture(t), store = new ProtectedClockMarks(clockScope, f.port, f.nodes);
    const plan = prepareUsedTransactionInsert(clockScope, JSON.parse(f.port.current.value).used_root, "shadowed", digest => f.nodes.read(digest));
    f.db.exec(sql);
    assert.throws(() => new SqliteUsedTransactionNodes(f.db), UsedTransactionStoreError);
    assert.throws(() => installUsedTransactionNodeSchema(f.db), UsedTransactionStoreError);
    assert.throws(() => f.nodes.read(f.initialNodes[0]!.digest), UsedTransactionStoreError);
    assert.throws(() => f.nodes.stage(plan.nodes), UsedTransactionStoreError);
    assert.throws(() => store.reserve(initial, next(initial, "shadowed")), ProtectedHeadError);
    assert.equal(f.port.writes, 0);
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM main.used_transaction_nodes").get() as { n: number }).n, 257);
    f.db.close(); const reopened = openSecurityDatabase(f.filename); reopened.pragma("synchronous=FULL");
    try {
      const restored = new ProtectedClockMarks(clockScope, f.port, new SqliteUsedTransactionNodes(reopened));
      assert.deepEqual(restored.read(), initial);
      assert.equal(restored.reserve(initial, next(initial, "durable")).transaction_id, "durable");
    } finally { reopened.close(); }
  }
  const f = fixture(t);
  const lateShadow: ImmutableUsedTransactionNodes = { read: digest => f.nodes.read(digest), stage: nodes => {
    f.db.exec("CREATE TEMP TABLE used_transaction_nodes AS SELECT * FROM main.used_transaction_nodes");
    return f.nodes.stage(nodes);
  } };
  const store = new ProtectedClockMarks(clockScope, f.port, lateShadow);
  assert.throws(() => store.reserve(initial, next(initial, "late_shadow")), ProtectedHeadError);
  assert.equal(f.port.writes, 0);
});

test("clock headとused rootを同じCASで進め初期IDを含む過去IDを拒否する", t => {
  const f = fixture(t), store = new ProtectedClockMarks(clockScope, f.port, f.nodes);
  assert.deepEqual(store.read(), initial);
  const first = reserveClockMark(store, { observe: () => ({ boot_id: initial.boot_id, continuous_ms: 2000, wall_utc: "2026-09-19T00:00:01.000Z" }) }, "first", 0);
  const second = store.reserve(first, next(first, "second")); assert.equal(f.port.writes, 2);
  for (const id of ["initial", "first", "second"]) assert.throws(() => store.reserve(second, { ...next(second, "unused"), transaction_id: id }), ProtectedHeadError);
  assert.equal(f.port.writes, 2); assert.deepEqual(store.read(), second);
  const head = JSON.parse(f.port.current.value); assert.equal(head.last_reservation_id, "second"); assert.deepEqual(head.state, second);
  f.db.close(); const reopened = openSecurityDatabase(f.filename); reopened.pragma("synchronous=FULL");
  try { const restored = new ProtectedClockMarks(clockScope, f.port, new SqliteUsedTransactionNodes(reopened)); assert.deepEqual(restored.read(), second);
    assert.throws(() => restored.reserve(second, next(second, "first")), ProtectedHeadError); }
  finally { reopened.close(); }
});

test("clockのstale field・boot変更・時刻巻戻しをstage/CAS前に拒否する", t => {
  const f = fixture(t), store = new ProtectedClockMarks(clockScope, f.port, f.nodes), proposed = next(initial, "next");
  for (const bad of [{ ...proposed, previous_transaction_id: "other" }, { ...proposed, boot_id: "other" },
    { ...proposed, continuous_ms: 999 }, { ...proposed, effective_utc: initial.effective_utc }, { ...proposed, transaction_id: "bad\n" }]) {
    assert.throws(() => store.reserve(initial, bad), ProtectedHeadError);
  }
  assert.throws(() => store.reserve({ ...initial, boot_id: "other" }, proposed), ProtectedHeadError);
  assert.equal(f.port.writes, 0); assert.equal((f.db.prepare("SELECT count(*) AS n FROM used_transaction_nodes").get() as { n: number }).n, 257);
});

test("audit reserve/finalizeはexact pendingとrootを維持しretention IDも再使用しない", t => {
  const f = fixture(t, auditScope), store = new ProtectedAuditAnchors(auditScope, f.port, f.nodes);
  assert.deepEqual(store.read(), initialAnchor);
  for (const proposed of [{ ...initialAnchor, pending_transaction_id: "invalid" },
    { ...initialAnchor, sequence: 2, mac: "2".repeat(64), pending_transaction_id: "invalid" },
    { ...initialAnchor, chain_id: "other", sequence: 1, mac: "2".repeat(64), pending_transaction_id: "invalid" },
    { ...initialAnchor, sequence: 1, mac: "2".repeat(64), checkpoint_mac: "3".repeat(64), pending_transaction_id: "invalid" }]) {
    assert.throws(() => store.reserve(initialAnchor, proposed), ProtectedHeadError);
  }
  assert.equal(f.port.writes, 0);
  const pending = store.reserve(initialAnchor, { ...initialAnchor, sequence: 1, mac: "2".repeat(64), pending_transaction_id: "append" });
  const root = JSON.parse(f.port.current.value).used_root;
  assert.throws(() => store.reserve(pending, { ...pending, sequence: 2, mac: "3".repeat(64), pending_transaction_id: "second" }), ProtectedHeadError);
  assert.throws(() => store.finalize({ ...pending, pending_transaction_id: "other" }), ProtectedHeadError);
  const stable = store.finalize(pending); assert.equal(stable.pending_transaction_id, null);
  assert.equal(JSON.parse(f.port.current.value).used_root, root); assert.throws(() => store.finalize(pending), ProtectedHeadError);
  const retained = store.reserve(stable, { ...stable, checkpoint_mac: "3".repeat(64), pending_transaction_id: "retention" });
  const after = store.finalize(retained); assert.equal(after.sequence, 1); assert.equal(f.port.writes, 4);
  for (const id of ["initial", "append", "retention"]) assert.throws(() => store.reserve(after, { ...after, sequence: 2, mac: "4".repeat(64), pending_transaction_id: id }), ProtectedHeadError);
  assert.equal(f.port.writes, 4);
});

test("stage/CAS/readbackの不明結果で再試行せず未使用rootへ戻さない", t => {
  for (const fault of ["before", "after", "response", "readback"] as const) {
    const f = fixture(t); f.port.fault = fault; const store = new ProtectedClockMarks(clockScope, f.port, f.nodes);
    assert.throws(() => store.reserve(initial, next(initial, "uncertain")), ProtectedHeadError); assert.equal(f.port.writes, 1);
    f.port.fault = "none";
    const current = store.read(); assert.equal(current.transaction_id, fault === "before" ? "initial" : "uncertain");
    if (fault !== "before") assert.throws(() => store.reserve(current, { ...next(current, "unused"), transaction_id: "uncertain" }), ProtectedHeadError);
    assert.equal(f.port.writes, 1);
  }
  for (const fault of ["stage_after", "stage_missing", "head_drift"] as const) {
    const f = fixture(t); let staged = false;
    const nodes: ImmutableUsedTransactionNodes = { read: digest => staged && fault === "stage_missing" ? undefined : f.nodes.read(digest),
      stage: values => { f.nodes.stage(values); staged = true;
        if (fault === "stage_after") throw Error("fixture stage response lost");
        if (fault === "head_drift") f.port.current = { ...f.port.current, revision: f.port.current.revision + 1 }; return undefined; } };
    const store = new ProtectedClockMarks(clockScope, f.port, nodes);
    assert.throws(() => store.reserve(initial, next(initial, "uncertain")), ProtectedHeadError); assert.equal(f.port.writes, 0);
  }
});

test("補助DB rollback・scope/codec/last ID改変・最大revisionはfail closed", t => {
  const f = fixture(t), store = new ProtectedClockMarks(clockScope, f.port, f.nodes);
  const current = store.reserve(initial, next(initial, "first")); const valid = { ...f.port.current };
  for (const mutate of [(head: any) => { head.scope.ledger_id = "other"; }, (head: any) => { head.codec_version = 2; },
    (head: any) => { head.last_reservation_id = "missing"; }, (head: any) => { head.used_root = emptyUsedTransactionRoot(clockScope); }]) {
    const head = JSON.parse(valid.value); mutate(head); f.port.current = { ...valid, value: JSON.stringify(head) };
    assert.throws(() => store.read(), ProtectedHeadError);
  }
  f.port.current = { ...valid, revision: Number.MAX_SAFE_INTEGER };
  assert.throws(() => store.reserve(current, next(current, "next")), ProtectedHeadError); assert.equal(f.port.writes, 1);
  f.port.current = valid;
  const trigger = (f.db.prepare("SELECT sql FROM sqlite_master WHERE name='used_transaction_nodes_no_delete'").get() as { sql: string }).sql;
  f.db.exec("DROP TRIGGER used_transaction_nodes_no_delete");
  const initialKeys = new Set(f.initialNodes.map(node => node.digest));
  for (const row of f.db.prepare("SELECT digest FROM used_transaction_nodes").all() as Array<{ digest: string }>) if (!initialKeys.has(row.digest)) f.db.prepare("DELETE FROM used_transaction_nodes WHERE digest=?").run(row.digest);
  f.db.exec(trigger); assert.throws(() => store.read(), ProtectedHeadError); assert.equal(f.port.writes, 1);
});

test("nodeの不正wire・容量・schema変更とdeferred providerを拒否する", t => {
  const f = fixture(t), value = f.initialNodes[0]!;
  for (const nodes of [[], Array.from({ length: 258 }, () => value), [value, value], [{ ...value, wire: value.wire + "\n" }],
    [{ ...value, digest: "0".repeat(64) }], [{ ...value, wire: "x".repeat(177) }]]) assert.throws(() => f.nodes.stage(nodes), UsedTransactionStoreError);
  let effects = 0;
  const badPort = { read: async () => { effects++; return f.port.current; }, compareExchange: f.port.compareExchange.bind(f.port) };
  // @ts-expect-error asynchronous protected ports do not meet the synchronous contract
  assert.throws(() => new ProtectedClockMarks(clockScope, badPort, f.nodes), ProtectedHeadError);
  const badNodes = { read: f.nodes.read.bind(f.nodes), stage: async () => { effects++; } };
  // @ts-expect-error asynchronous staging cannot prove durable completion
  assert.throws(() => new ProtectedClockMarks(clockScope, f.port, badNodes), ProtectedHeadError);
  assert.equal(effects, 0); assert.equal(f.port.reads, 0);
  f.db.exec("CREATE TABLE unexpected(value TEXT)"); assert.throws(() => f.nodes.read(value.digest), UsedTransactionStoreError);
});

test("既存の監査transactionへ接続しanchor reserve不明時に業務DBをcommitしない", t => {
  const business = webFixture(t), auxiliary = fixture(t);
  const clockScope = { instance_id: webScope.instance_id, ledger_id: "integration_clock", purpose: "clock_mark" as const };
  const auditScope = { instance_id: webScope.instance_id, ledger_id: "integration_audit", purpose: "audit_anchor" as const };
  const seed = (scope: UsedTransactionScope, state: ClockMark | AuditAnchor, initialId: string) => {
    const plan = prepareUsedTransactionInsert(scope, emptyUsedTransactionRoot(scope), initialId, digest => auxiliary.nodes.read(digest));
    auxiliary.nodes.stage(plan.nodes);
    return new FixturePort({ revision: 1, value: encodeProtectedHead({ codec_version: 1, kind: scope.purpose, scope,
      used_root: plan.proposed_root, last_reservation_id: initialId, state }) });
  };
  const clockPort = seed(clockScope, business.marks.read(), "initial_mark"), auditPort = seed(auditScope, business.anchors.read(), "genesis");
  const clockMarks = new ProtectedClockMarks(clockScope, clockPort, auxiliary.nodes);
  const auditAnchors = new ProtectedAuditAnchors(auditScope, auditPort, auxiliary.nodes);
  const providers = { ...business.providers, clockMarks, auditAnchors };
  const store = new WebAuthRepository(business.db, providers, webScope), audit = new AuditRepository(business.db, auditAnchors, providers.auditKeys);
  assert.equal(store.initialize("integrated_initialize").status, "succeeded");
  assert.equal(store.restart("integrated_restart").status, "succeeded");
  assert.equal(audit.verify().sequence, 2); assert.equal(clockPort.writes, 2); assert.equal(auditPort.writes, 4);
  const before = business.readState(); auditPort.fault = "after";
  assert.throws(() => store.restart("unknown_reservation"));
  assert.deepEqual(business.readState(), before); assert.equal(auditPort.writes, 5);
  auditPort.fault = "none";
  assert.equal(auditAnchors.read().pending_transaction_id, "unknown_reservation");
  assert.equal(clockMarks.read().transaction_id, "unknown_reservation");
  assert.throws(() => audit.verify()); assert.throws(() => store.restart("later"));
  assert.equal(auditPort.writes, 5); assert.equal(clockPort.writes, 3);
});
