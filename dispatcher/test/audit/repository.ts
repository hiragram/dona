import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { DispatcherDatabase } from "../../src/database.js";
import { AuditRepository, installAuditSchema, type AuditAnchorStore } from "../../src/audit/repository.js";
import { AuditIntegrityError, signAuditCheckpoint, type AuditAnchor, type AuditEvent, type AuditKey } from "../../src/audit/codec.js";

const key: AuditKey = { version: 1, purpose: "audit", state: "active", activated_at: "2026-09-01T00:00:00.000Z",
  signing_expires_at: "2026-11-01T00:00:00.000Z", secret: Buffer.alloc(32, 0x42) };
const keys = (version: number) => version === 1 ? key : undefined;
const at = "2026-09-19T00:00:00.000Z";
const checkpoint = signAuditCheckpoint({ codec_version: 1, chain_id: "shared_1", transaction_id: "genesis_1", signed_at: at, key_version: 1 }, keys);
const event: AuditEvent = { occurred_at: at, scope: { instance_id: "instance_1", tenant_id: "tenant_1" },
  actor: { kind: "system", id: "dispatcher" }, action: "approval_decision", operation: "approval.approve.v1", resource_id: "request_1",
  outcome: "allowed", reason: "none", session_ref: null, receipt_id: "receipt_1", attempt_id: null,
  policy_revision: 1, binding_revision: 1, authz_revision: 1 };

// Test fixture only: deliberately not a durable or rollback-resistant production store.
class AnchorFixture implements AuditAnchorStore {
  value: AuditAnchor = { chain_id: "shared_1", sequence: 0, mac: "0".repeat(64),
    checkpoint_mac: checkpoint.mac, pending_transaction_id: null };
  calls: string[] = [];
  used = new Set<string>();
  fault: "none" | "reserve_before" | "reserve_after" | "finalize_before" | "finalize_after" = "none";
  read(): AuditAnchor { return structuredClone(this.value); }
  reserve(expected: AuditAnchor, proposed: AuditAnchor): AuditAnchor {
    this.calls.push("reserve");
    assert.deepEqual(expected, this.value);
    if (this.value.pending_transaction_id !== null || this.fault === "reserve_before") throw new Error("fixture failure");
    if (proposed.pending_transaction_id === null || this.used.has(proposed.pending_transaction_id)) throw new Error("duplicate fixture transaction");
    this.used.add(proposed.pending_transaction_id);
    this.value = structuredClone(proposed);
    if (this.fault === "reserve_after") throw new Error("fixture response loss");
    return this.read();
  }
  finalize(reservation: AuditAnchor): AuditAnchor {
    this.calls.push("finalize");
    assert.deepEqual(reservation, this.value);
    if (this.fault === "finalize_before") throw new Error("fixture failure");
    this.value = { ...this.value, pending_transaction_id: null };
    if (this.fault === "finalize_after") throw new Error("fixture response loss");
    return this.read();
  }
}
function setup(t: { after(fn: () => void): void }, existing = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-repository-"));
  const filename = path.join(root, "dispatcher.sqlite");
  if (existing) new DispatcherDatabase(filename).close();
  const db = new Database(filename); db.pragma("synchronous=FULL"); db.pragma("journal_mode = WAL"); db.pragma("foreign_keys = ON");
  const version = db.pragma("user_version", { simple: true });
  installAuditSchema(db);
  db.exec("CREATE TABLE decisions (id TEXT PRIMARY KEY, state TEXT NOT NULL)");
  const store = new AnchorFixture(); const repository = new AuditRepository(db, store, keys);
  repository.initialize(checkpoint);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, filename, store, repository, version };
}
const count = (db: Database.Database, table: "decisions" | "security_audit_records") =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

test("cleanと既存Dispatcher DBへopt-in schemaを追加し、再openでも正本を保持する", (t) => {
  for (const existing of [false, true]) {
    const { db, filename, store, repository, version } = setup(t, existing);
    const response = repository.append("tx_1", 1, event, () => {
      assert.equal(store.value.pending_transaction_id, "tx_1");
      db.prepare("INSERT INTO decisions VALUES (?, ?)").run("request_1", "approved");
      return "receipt_1";
    });
    assert.equal(response.result, "receipt_1");
    assert.deepEqual(store.calls, ["reserve", "finalize"]);
    assert.equal(store.value.pending_transaction_id, null);
    const reopened = new Database(filename); reopened.pragma("synchronous=FULL");
    try {
      installAuditSchema(reopened);
      assert.equal(new AuditRepository(reopened, store, keys).verify().sequence, 1);
      assert.equal(count(reopened, "decisions"), 1);
      assert.equal(reopened.pragma("user_version", { simple: true }), version);
      assert.deepEqual(reopened.pragma("foreign_key_check"), []);
      assert.equal(reopened.pragma("integrity_check", { simple: true }), "ok");
    } finally { reopened.close(); }
    assert.throws(() => repository.initialize(checkpoint), AuditIntegrityError);
  }
});

test("reserve失敗・受理不明ではdecisionとauditをwriteせずblind retryしない", (t) => {
  for (const fault of ["reserve_before", "reserve_after"] as const) {
    const { db, store, repository } = setup(t); store.fault = fault;
    let mutations = 0;
    assert.throws(() => repository.append("tx_1", 1, event, () => { mutations++; }), AuditIntegrityError);
    assert.equal(mutations, 0); assert.equal(count(db, "security_audit_records"), 0);
    assert.deepEqual(store.calls, ["reserve"]);
    if (fault === "reserve_after") {
      assert.throws(() => repository.verify(), AuditIntegrityError);
      assert.throws(() => repository.append("tx_2", 1, event, () => {}), AuditIntegrityError);
      assert.deepEqual(store.calls, ["reserve"]);
    }
  }
});

test("audit insertとdecision mutationの失敗は両方rollbackしreservationを残す", (t) => {
  for (const failAudit of [false, true]) {
    const { db, store, repository } = setup(t);
    const prepare = db.prepare.bind(db); let failures = 0;
    if (failAudit) t.mock.method(db, "prepare", ((sql: string) => {
      if (sql.startsWith("INSERT INTO security_audit_records")) { failures++; throw new Error("injected SQL prepare failure"); }
      return prepare(sql);
    }) as typeof db.prepare);
    assert.throws(() => repository.append("tx_1", 1, event, () => {
      db.exec("INSERT INTO decisions VALUES ('request_1','approved')");
      throw new Error("private mutation error");
    }), AuditIntegrityError);
    assert.equal(count(db, "decisions"), 0); assert.equal(count(db, "security_audit_records"), 0);
    assert.equal(store.value.pending_transaction_id, "tx_1"); assert.deepEqual(store.calls, ["reserve"]);
    assert.equal(failures, failAudit ? 1 : 0);
    assert.throws(() => repository.verify(), AuditIntegrityError);
  }
});

test("DB commit後のfinalize失敗・応答喪失を成功にせず、read-onlyで確定状態を区別する", (t) => {
  for (const fault of ["finalize_before", "finalize_after"] as const) {
    const { db, store, repository } = setup(t); store.fault = fault;
    assert.throws(() => repository.append("tx_1", 1, event, () => {
      db.exec("INSERT INTO decisions VALUES ('request_1','approved')");
    }), AuditIntegrityError);
    assert.equal(count(db, "decisions"), 1); assert.equal(count(db, "security_audit_records"), 1);
    assert.deepEqual(store.calls, ["reserve", "finalize"]);
    if (fault === "finalize_before") assert.throws(() => repository.verify(), AuditIntegrityError);
    else assert.equal(repository.verify().sequence, 1);
    assert.deepEqual(store.calls, ["reserve", "finalize"]);
  }
});

test("別connectionからstale anchor・DB restore・レコード欠落を拒否する", (t) => {
  const { db, filename, store, repository } = setup(t);
  const second = new Database(filename); second.pragma("synchronous=FULL");
  try {
    const peer = new AuditRepository(second, store, keys);
    const genesis = store.read();
    repository.append("tx_1", 1, event, () => {});
    assert.equal(peer.verify().sequence, 1);
    const tail = store.read(); store.value = genesis;
    assert.throws(() => peer.verify(), AuditIntegrityError);
    store.value = tail; db.exec("DELETE FROM security_audit_records");
    assert.throws(() => peer.verify(), AuditIntegrityError);
    assert.throws(() => peer.append("tx_2", 1, event, () => {}), AuditIntegrityError);
    assert.deepEqual(store.calls, ["reserve", "finalize"]);
  } finally { second.close(); }
});

test("duplicate transaction・時刻巻戻り・outer transactionは外部reserve前に拒否する", (t) => {
  const { db, store, repository } = setup(t);
  repository.append("tx_1", 1, event, () => {});
  assert.throws(() => repository.append("tx_1", 1, event, () => {}), AuditIntegrityError);
  assert.throws(() => repository.append("tx_2", 1, { ...event, occurred_at: "2026-09-18T00:00:00.000Z" }, () => {}), AuditIntegrityError);
  assert.throws(() => db.transaction(() => repository.append("tx_2", 1, event, () => {}))(), AuditIntegrityError);
  assert.deepEqual(store.calls, ["reserve", "finalize"]);
  assert.equal(repository.verify().sequence, 1);
});

test("unknown schema・部分schemaを修復せず、非同期callbackもcommitしない", (t) => {
  const { db, store, repository } = setup(t);
  assert.throws(() => repository.append("tx_1", 1, event, (() => Promise.resolve("late")) as never), AuditIntegrityError);
  assert.equal(count(db, "security_audit_records"), 0); assert.equal(store.value.pending_transaction_id, "tx_1");
  db.exec("DROP TABLE security_audit_schema; CREATE TABLE security_audit_schema(version); INSERT INTO security_audit_schema VALUES (2)");
  assert.throws(() => installAuditSchema(db), AuditIntegrityError);
  assert.throws(() => repository.verify(), AuditIntegrityError);
  db.exec("DELETE FROM security_audit_schema; INSERT INTO security_audit_schema VALUES (1); DROP TABLE security_audit_checkpoint");
  assert.throws(() => installAuditSchema(db), AuditIntegrityError);
});

function retentionRepository(db: Database.Database, store: AnchorFixture) {
  const next: AuditKey = { ...key, version: 2, activated_at: "2027-10-01T00:00:00.000Z",
    signing_expires_at: "2027-12-01T00:00:00.000Z", secret: Buffer.alloc(32, 0x43) };
  return new AuditRepository(db, store, (version) => version === 1 ? { ...key, state: "verification_only" } : version === 2 ? next : undefined);
}

test("400日のretention境界を守り、checkpointと外部anchor確定後だけprefixを削除する", (t) => {
  const { db, store, repository } = setup(t);
  repository.append("tx_1", 1, event, () => {});
  repository.append("tx_2", 1, { ...event, occurred_at: "2026-09-20T00:00:00.000Z" }, () => {});
  const retention = retentionRepository(db, store);
  const boundary = new Date(Date.parse(at) + 400 * 24 * 60 * 60 * 1000).toISOString();
  const earlier = new Date(Date.parse(boundary) - 1).toISOString();
  assert.throws(() => retention.retain("retention_1", 2, 1, earlier), AuditIntegrityError);
  assert.equal(count(db, "security_audit_records"), 2);
  assert.deepEqual(store.calls, ["reserve", "finalize", "reserve", "finalize"]);
  retention.retain("retention_1", 2, 1, boundary);
  assert.equal(count(db, "security_audit_records"), 1);
  assert.equal(retention.verify().sequence, 2);
  assert.equal((db.prepare("SELECT transaction_id FROM security_audit_checkpoint").get() as { transaction_id: string }).transaction_id, "retention_1");
  retention.pruneRetainedPrefix();
  assert.equal(count(db, "security_audit_records"), 1);
  assert.throws(() => retention.retain("retention_2", 2, 2, boundary), AuditIntegrityError);
});

test("retention finalizeの失敗・応答喪失では旧recordを保持し、自動再送しない", (t) => {
  for (const fault of ["finalize_before", "finalize_after"] as const) {
    const { db, store, repository } = setup(t);
    repository.append("tx_1", 1, event, () => {});
    store.fault = fault;
    const retention = retentionRepository(db, store);
    assert.throws(() => retention.retain("retention_1", 2, 1, "2027-11-01T00:00:00.000Z"), AuditIntegrityError);
    assert.equal(count(db, "security_audit_records"), 1);
    assert.deepEqual(store.calls, ["reserve", "finalize", "reserve", "finalize"]);
    if (fault === "finalize_before") {
      assert.throws(() => retention.pruneRetainedPrefix(), AuditIntegrityError);
      assert.equal(count(db, "security_audit_records"), 1);
    } else {
      assert.equal(retention.verify().sequence, 1);
      retention.pruneRetainedPrefix();
      assert.equal(count(db, "security_audit_records"), 0);
      assert.equal(retention.verify().sequence, 1);
    }
    assert.deepEqual(store.calls, ["reserve", "finalize", "reserve", "finalize"]);
  }
});

test("原子的CASの競合応答をDB成功に変換しない", (t) => {
  const { db, store, repository } = setup(t);
  store.reserve = () => { store.calls.push("reserve"); return { ...store.read(), pending_transaction_id: "other_tx" }; };
  assert.throws(() => repository.append("tx_1", 1, event, () => {
    db.exec("INSERT INTO decisions VALUES ('request_1','approved')");
  }), AuditIntegrityError);
  assert.equal(count(db, "decisions"), 0); assert.equal(count(db, "security_audit_records"), 0);
  assert.deepEqual(store.calls, ["reserve"]);
});

test("SQLite commit自体の失敗でもdecisionとauditをrollbackする", (t) => {
  const { db, store, repository } = setup(t);
  db.exec("CREATE TABLE parent(id PRIMARY KEY); CREATE TABLE child(id REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)");
  assert.throws(() => repository.append("tx_commit_failure", 1, event, () => {
    db.exec("INSERT INTO decisions VALUES ('request_1','approved'); INSERT INTO child VALUES ('missing')");
  }), AuditIntegrityError);
  assert.equal(count(db, "decisions"), 0); assert.equal(count(db, "security_audit_records"), 0);
  assert.equal(store.value.pending_transaction_id, "tx_commit_failure");
  assert.deepEqual(store.calls, ["reserve"]);
});

test("checkpoint確定後の削除失敗は検証可能なprefixを残し、明示cleanupで復旧する", (t) => {
  const { db, store, repository } = setup(t);
  repository.append("tx_1", 1, event, () => {});
  const retention = retentionRepository(db, store);
  const prepare = db.prepare.bind(db); let failures = 0;
  const injected = t.mock.method(db, "prepare", ((sql: string) => {
    if (sql.startsWith("DELETE FROM security_audit_records")) { failures++; throw new Error("injected SQL prepare failure"); }
    return prepare(sql);
  }) as typeof db.prepare);
  assert.throws(() => retention.retain("retention_1", 2, 1, "2027-11-01T00:00:00.000Z"), AuditIntegrityError);
  assert.equal(store.value.pending_transaction_id, null);
  assert.equal(count(db, "security_audit_records"), 1); assert.equal(retention.verify().sequence, 1);
  assert.equal(failures, 1); injected.mock.restore();
  retention.pruneRetainedPrefix();
  assert.equal(count(db, "security_audit_records"), 0);
  assert.deepEqual(store.calls, ["reserve", "finalize", "reserve", "finalize"]);
});

test("finalize直後の別connection appendを直列化し、確定済み業務更新を失敗扱いしない", (t) => {
  const { db, filename, store, repository } = setup(t);
  const otherDb = new Database(filename); otherDb.pragma("synchronous=FULL"); otherDb.pragma("busy_timeout = 0");
  try {
    const other = new AuditRepository(otherDb, store, keys);
    const finalize = store.finalize.bind(store);
    let attempted = false; let blocked = false;
    store.finalize = (reservation) => {
      const response = finalize(reservation);
      if (!attempted) {
        attempted = true;
        try { other.append("tx_competing", 1, event, () => {
          otherDb.exec("INSERT INTO decisions VALUES ('competing','approved')");
        }); } catch (error) { assert.ok(error instanceof AuditIntegrityError); blocked = true; }
      }
      return response;
    };
    const response = repository.append("tx_first", 1, event, () => {
      db.exec("INSERT INTO decisions VALUES ('first','approved')"); return "first_receipt";
    });
    assert.equal(response.result, "first_receipt"); assert.equal(attempted, true); assert.equal(blocked, true);
    assert.equal(count(db, "decisions"), 1); assert.equal(repository.verify().sequence, 1);
    assert.deepEqual(store.calls, ["reserve", "finalize"]);
    other.append("tx_after", 1, event, () => {});
    assert.equal(repository.verify().sequence, 2);
  } finally { otherDb.close(); }
});

test("mutationが監査schemaを変更したら業務SQLとDDLをrollbackしanchorをfinalizeしない", t => {
  for (const sql of [
    "DROP TRIGGER security_audit_no_update",
    "CREATE INDEX security_audit_extra ON decisions(id)",
    "CREATE TEMP TRIGGER injected AFTER INSERT ON security_audit_records BEGIN SELECT 1; END",
  ]) {
    const { db, repository, store } = setup(t);
    assert.throws(() => repository.append("shape_tx", 1, event, () => {
      db.exec("INSERT INTO decisions VALUES ('request_1','approved')"); db.exec(sql);
    }), AuditIntegrityError);
    assert.equal(count(db, "decisions"), 0); assert.equal(count(db, "security_audit_records"), 0);
    assert.deepEqual(store.calls, ["reserve"]); assert.equal(store.value.pending_transaction_id, "shape_tx");
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='security_audit_no_update'").get());
    assert.equal(db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name='injected'").get(), undefined);
  }
});

test("監査schemaの欠落・未知object・TEMP shadowをverifyとinstallerで拒否する", t => {
  for (const sql of [
    "DROP TRIGGER security_audit_no_update",
    "CREATE INDEX security_audit_extra ON decisions(id)",
    "CREATE TEMP TRIGGER injected AFTER INSERT ON security_audit_records BEGIN SELECT 1; END",
    "CREATE TEMP TABLE security_audit_schema(version INTEGER); INSERT INTO temp.security_audit_schema VALUES (1)",
  ]) {
    const { db, repository, store } = setup(t); db.exec(sql);
    assert.throws(() => repository.verify(), AuditIntegrityError);
    assert.throws(() => installAuditSchema(db), AuditIntegrityError);
    assert.throws(() => repository.append("shape_tx", 1, event, () => {}), AuditIntegrityError);
    assert.deepEqual(store.calls, []);
  }
});


test("大文字TEMP tableにchainを複製してもdurable auditの代用にできない", t => {
  for(const name of ["SECURITY_AUDIT_RECORDS","Security_Audit_Checkpoint","SECURITY_AUDIT_SCHEMA"]) {
    const {db,repository,store}=setup(t);db.exec(`CREATE TEMP TABLE ${name} AS SELECT * FROM main.${name}`);
    assert.throws(()=>repository.verify(),AuditIntegrityError);assert.throws(()=>installAuditSchema(db),AuditIntegrityError);
    assert.throws(()=>repository.append("shadow_tx",1,event,()=>{}),AuditIntegrityError);
    assert.deepEqual(store.calls,[]);
    assert.equal((db.prepare("SELECT count(*) AS n FROM main.security_audit_records").get() as {n:number}).n,0);
  }
});


test("共通auditの更新もjournal・同期設定不足なら予約前に拒否する",t=>{
  for(const pragma of ["journal_mode=OFF","journal_mode=MEMORY","journal_mode=DELETE","synchronous=NORMAL"]) {
    const {db,repository,store}=setup(t);db.unsafeMode(true);db.pragma(pragma);
    assert.throws(()=>repository.append("bad_durability",1,event,()=>{}),AuditIntegrityError);
    assert.throws(()=>repository.retain("bad_retention",1,1,"2027-11-01T00:00:00.000Z"),AuditIntegrityError);
    assert.throws(()=>repository.pruneRetainedPrefix(),AuditIntegrityError);
    assert.deepEqual(store.calls,[]);assert.equal(repository.verify().sequence,0);
  }
});
