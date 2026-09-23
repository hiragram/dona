import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { DispatcherDatabase } from "../../src/database.js";
import { AuditRepository, assertCurrentAuditReadState, installAuditSchema, type AuditAnchorStore } from "../../src/audit/repository.js";
import { AuditIntegrityError, signAuditCheckpoint, verifyAuditRecord, type VerifiedAuditState, type AuditAnchor, type AuditEvent, type AuditKey } from "../../src/audit/codec.js";

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

test("複数の業務rootを単一監査recordへ結びeventの実resourceを保持する",t=>{
 const {db,repository,store}=setup(t);
 const roots=[{scope:event.scope,resource_id:"jobs",resource_digest:"a".repeat(64)},
  {scope:event.scope,resource_id:"web_auth_state",resource_digest:"b".repeat(64)}];
 const result=repository.appendPrepared("atomic_roots",1,()=>({event,resource_commitments:roots,mutation:()=>{
  db.exec("INSERT INTO decisions VALUES ('job','created'),('nonce','consumed')");return "committed";
 }}));
 assert.equal(result.result,"committed");assert.equal(result.record.codec_version,3);assert.equal(result.record.event.resource_id,"request_1");
 assert.deepEqual(store.calls,["reserve","finalize"]);assert.equal(count(db,"decisions"),2);
 assert.deepEqual(repository.readVerifiedState(state=>state.resource_bindings),roots.map(root=>({...root,sequence:1})));
 const peer=new Database(db.name);peer.pragma("synchronous=FULL");
 try{assert.deepEqual(new AuditRepository(peer,store,keys).readVerifiedState(state=>state.resource_bindings),roots.map(root=>({...root,sequence:1})));}finally{peer.close();}
});
test("複数rootの途中SQL失敗では全業務行と監査をrollbackし未確定anchorを保持する",t=>{
 const {db,repository,store}=setup(t);
 assert.throws(()=>repository.appendPrepared("atomic_failure",1,()=>({event,resource_commitments:[
  {scope:event.scope,resource_id:"jobs",resource_digest:"a".repeat(64)},
  {scope:event.scope,resource_id:"web_auth_state",resource_digest:"b".repeat(64)}],mutation:()=>{
   db.exec("INSERT INTO decisions VALUES ('job','created')");throw Error("fixture second write failed");
  }})));
 assert.equal(count(db,"decisions"),0);assert.equal(count(db,"security_audit_records"),0);
 assert.equal(store.value.pending_transaction_id,"atomic_failure");assert.deepEqual(store.calls,["reserve"]);
});
test("曖昧なroot計画・container超過・65個目のrootをanchor予約前に拒否する",t=>{
 const root={scope:event.scope,resource_id:"root",resource_digest:"a".repeat(64)};
 for(const plan of [
  {event:{...event,resource_id:null},resource_commitments:[root],mutation:()=>{assert.fail("missing target must fail before mutation");}},
  {event,resource_digest:null,resource_commitments:[root],mutation:()=>null},
  {event,resource_commitments:[root,root],mutation:()=>null},
  {event,resource_commitments:[],mutation:()=>null},
  {event,get resource_commitments(){throw Error("getter must not run");},mutation:()=>null},
  {event,resource_commitments:Array.from({length:64},(_,i)=>({...root,resource_id:"r"+String(i).padStart(3,"0")+"r".repeat(120),scope:{instance_id:"i".repeat(128),tenant_id:"t".repeat(128)}})),mutation:()=>null},
 ]){const {repository,store}=setup(t);assert.throws(()=>repository.appendPrepared("bad_plan",1,(()=>plan) as never));assert.deepEqual(store.calls,[]);}
 const {repository,store}=setup(t);
 for(let i=0;i<64;i++)repository.appendPrepared("root_"+i,1,()=>({event:{...event,resource_id:"root_"+i},resource_digest:"a".repeat(64),mutation:()=>null}));
 const before=store.calls.length;
 assert.throws(()=>repository.appendPrepared("overflow",1,()=>({event,resource_commitments:[root],mutation:()=>null})));
 assert.equal(store.calls.length,before);assert.equal(repository.verify().sequence,64);
});

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

test("重複を通常の監査結果へ収束させ、anchorを未確定で残さない", t => {
  const { db, repository, store } = setup(t);
  const create = (tx: string) => repository.appendPrepared(tx, 1, () => {
    const existing = db.prepare("SELECT id FROM decisions WHERE id='request_1'").get();
    return { event: { ...event, outcome: existing ? "denied" : "allowed", reason: existing ? "decision_conflict" : "none" },
      resource_digest: existing ? null : "a".repeat(64),
      mutation: () => { if (!existing) db.exec("INSERT INTO decisions VALUES ('request_1','approved')"); return existing ? "conflict" : "created"; } };
  });
  const first = create("prepared_1"); const duplicate = create("prepared_2");
  assert.equal(first.result,"created"); assert.equal(first.record.codec_version,2);
  assert.equal(duplicate.result,"conflict"); assert.equal(duplicate.record.event.outcome,"denied");
  assert.equal(count(db,"decisions"),1); assert.equal(store.value.pending_transaction_id,null); assert.equal(repository.verify().sequence,2);
});
test("事前判定のSQL更新を予約前に拒否し、接続設定を復元する", t => {
  const { db, repository, store } = setup(t);
  assert.throws(() => repository.appendPrepared("prepared_1",1,() => {
    db.exec("INSERT INTO decisions VALUES ('bad','approved')"); return {event,resource_digest:null,mutation:()=>null};
  }), AuditIntegrityError);
  assert.equal(count(db,"decisions"),0);assert.deepEqual(store.calls,[]);assert.equal(db.pragma("query_only",{simple:true}),0);
  repository.append("prepared_2",1,event,()=>{ db.exec("INSERT INTO decisions VALUES ('request_1','approved')"); });
  assert.equal(repository.verify().sequence,1);
});
test("事前判定の非同期処理は本体もawait後も実行せずanchor予約前に拒否する", async t => {
  const { repository, store } = setup(t);
  let effects=0;
  assert.throws(() => repository.appendPrepared("prepared_1",1,(async () => {
    effects++;await Promise.resolve();effects++;
    return {event,resource_digest:null,mutation:()=>null};
  }) as never),AuditIntegrityError);
  await Promise.resolve();assert.equal(effects,0);
  assert.deepEqual(store.calls,[]);assert.equal(repository.verify().sequence,0);
});
test("検証付き読み取りは更新とpeer commit後の古い結果を拒否する", t => {
  const { db, filename, repository, store } = setup(t);
  assert.throws(() => repository.readVerified(() => { db.exec("INSERT INTO decisions VALUES ('bad','approved')"); }),AuditIntegrityError);
  assert.equal(count(db,"decisions"),0);assert.deepEqual(store.calls,[]);
  const peer = new Database(filename); peer.pragma("synchronous=FULL"); const peerRepository = new AuditRepository(peer,store,keys);
  try {
    assert.throws(() => repository.readVerified(() => {
      const before = count(db,"decisions");
      peerRepository.append("peer_1",1,event,()=>{ peer.exec("INSERT INTO decisions VALUES ('request_1','approved')"); });
      return before;
    }),AuditIntegrityError);
    assert.equal(repository.readVerified(()=>count(db,"decisions")),1);
  } finally {peer.close();}
});

test("record v2の業務digestを認証しv1混在chainも検証する", t => {
  const { repository } = setup(t);
  const legacy = repository.append("legacy_1",1,event,()=>null);
  const current = repository.appendPrepared("current_1",1,()=>({event,resource_digest:"a".repeat(64),mutation:()=>null}));
  assert.equal(legacy.record.codec_version,1);assert.equal(current.record.codec_version,2);
  assert.deepEqual(verifyAuditRecord(JSON.parse(JSON.stringify(current.record)),keys),current.record);
  assert.equal(repository.verify().sequence,2);
  assert.throws(()=>verifyAuditRecord({...current.record,resource_digest:"b".repeat(64)},keys),AuditIntegrityError);
  const downgraded = {...current.record} as Record<string,unknown>;
  downgraded.codec_version=1;delete downgraded.resource_digest;
  assert.throws(()=>verifyAuditRecord(downgraded,keys),AuditIntegrityError);
  assert.throws(()=>verifyAuditRecord({...current.record,codec_version:3},keys),AuditIntegrityError);
  const checkpoint2=signAuditCheckpoint({codec_version:1,chain_id:current.record.chain_id,transaction_id:'checkpoint_2',signed_at:at,key_version:1},keys,current.record);
  assert.equal(checkpoint2.sequence,2);assert.equal(checkpoint2.through_mac,current.record.mac);
});

test("不正な更新計画とread-only接続ではanchorを予約しない", t => {
  const { db, repository, store } = setup(t);
  const plans = [
    {event,resource_digest:undefined,mutation:()=>null},
    {event,resource_digest:null,mutation:null},
    {event:{...event,resource_id:null},resource_digest:"a".repeat(64),mutation:()=>null},
  ];
  for (const plan of plans) {
    assert.throws(()=>repository.appendPrepared("bad_plan",1,()=>plan as never),AuditIntegrityError);
    assert.deepEqual(store.calls,[]);
  }
  db.pragma("query_only=ON");
  assert.throws(()=>repository.append("readonly",1,event,()=>null),AuditIntegrityError);
  assert.deepEqual(store.calls,[]);
  assert.equal(repository.readVerified(()=>count(db,"decisions")),0);
  assert.equal(db.pragma("query_only",{simple:true}),1);
  db.pragma("query_only=OFF");
  repository.append("valid",1,event,()=>null);
  assert.equal(repository.verify().sequence,1);
});


test("事前判定と検証付きreadではtransaction切替とquery_only解除を拒否する", t => {
  for (const mode of ["read", "prepare"]) {
    for (const sql of ["COMMIT", "SAVEPOINT guard_point", "PRAGMA query_only=OFF"]) {
      const { db, repository, store } = setup(t);
      const callback = () => { db.exec(sql); return { event, resource_digest: null, mutation: () => {} }; };
      assert.throws(() => mode === "read" ? repository.readVerified(callback as never)
        : repository.appendPrepared("blocked_plan", 1, callback));
      assert.equal(db.inTransaction, false); assert.equal(db.pragma("query_only", { simple: true }), 0);
      assert.deepEqual(store.calls, []); assert.equal(repository.verify().sequence, 0);
    }
  }
});

test("事前prepareしたwriteも検証付きreadで実行できない", t => {
  const { db, repository, store } = setup(t);
  const statement = db.prepare("INSERT INTO decisions VALUES ('request_1','approved')");
  assert.throws(() => repository.readVerified(() => { statement.run(); }));
  assert.equal(count(db, "decisions"), 0); assert.deepEqual(store.calls, []);
  assert.equal(repository.verify().sequence, 0);
});

test("v1 schemaの拡張は既存の監査データとanchorを保持する",t=>{
 const {db,repository,store}=setup(t);repository.append("prior",1,event,()=>{});
 const before=db.prepare("SELECT * FROM security_audit_checkpoint").all(),rows=db.prepare("SELECT * FROM security_audit_records").all();
 db.exec(`DROP TABLE security_audit_checkpoint;
 CREATE TABLE security_audit_checkpoint ( singleton INTEGER PRIMARY KEY CHECK (singleton = 1), transaction_id TEXT,
 checkpoint_json TEXT NOT NULL CHECK (length(checkpoint_json) <= 4096) );
 DROP TABLE security_audit_schema;
 CREATE TABLE security_audit_schema (version INTEGER PRIMARY KEY CHECK (version = 1)); INSERT INTO security_audit_schema VALUES (1);`);
 const old=before[0] as {singleton:number;transaction_id:string|null;checkpoint_json:string};
 db.prepare("INSERT INTO security_audit_checkpoint VALUES (?,?,?)").run(old.singleton,old.transaction_id,old.checkpoint_json);
 const anchored=store.read();assert.throws(()=>repository.verify(),AuditIntegrityError);
 installAuditSchema(db);assert.equal(repository.verify().sequence,1);
 assert.deepEqual(db.prepare("SELECT * FROM security_audit_checkpoint").all(),before);
 assert.deepEqual(db.prepare("SELECT * FROM security_audit_records").all(),rows);assert.deepEqual(store.read(),anchored);
 assert.deepEqual(db.prepare("SELECT version FROM security_audit_schema").all(),[{version:2}]);
 installAuditSchema(db);assert.deepEqual(store.read(),anchored);
});
test("同じsnapshotのcommitmentをreadと事前更新判定へ渡し業務row差替えを検出する",t=>{
 const {db,repository}=setup(t);
 repository.appendPrepared("first",1,state=>{
  assert.deepEqual(state.resource_bindings,[]);
  return {event,resource_digest:"a".repeat(64),mutation:()=>{db.prepare("INSERT INTO decisions VALUES (?,?)").run("request_1","a".repeat(64));return null;}};
 });
 const read=()=>repository.readVerifiedState(state=>{
  const root=state.resource_bindings.find(value=>value.resource_id==="request_1" && value.scope.instance_id==="instance_1" && value.scope.tenant_id==="tenant_1");
  const row=db.prepare("SELECT state FROM decisions WHERE id='request_1'").get() as {state:string}|undefined;
  if(root?.resource_digest!==row?.state || !root || !row)throw new Error("metadata_unverified");
  return row.state;
 });
 assert.equal(read(),"a".repeat(64));
 repository.appendPrepared("second",1,state=>{
  assert.equal(state.resource_bindings[0]?.resource_digest,"a".repeat(64));
  return {event,resource_digest:"b".repeat(64),mutation:()=>{db.prepare("UPDATE decisions SET state=?").run("b".repeat(64));return null;}};
 });
 assert.equal(read(),"b".repeat(64));db.prepare("UPDATE decisions SET state=?").run("a".repeat(64));
 assert.throws(read,AuditIntegrityError);db.exec("DELETE FROM decisions");assert.throws(read,AuditIntegrityError);
});
test("v2 recordをすべてretentionしてもmetadataの照合根拠を保持する",t=>{
 const {db,repository,store}=setup(t);
 repository.appendPrepared("first",1,()=>({event,resource_digest:"a".repeat(64),mutation:()=>null}));
 repository.appendPrepared("second",1,()=>({event:{...event,resource_id:"second_resource"},resource_digest:"b".repeat(64),mutation:()=>null}));
 const before=repository.readVerifiedState(state=>state.resource_bindings);
 const retained=retentionRepository(db,store);
 retained.retain("retention_first",2,1,"2027-11-01T00:00:00.000Z");
 assert.equal(count(db,"security_audit_records"),1);
 assert.deepEqual(retained.readVerifiedState(state=>state.resource_bindings),before);
 retained.retain("retention_second",2,2,"2027-11-01T00:00:00.000Z");
 assert.equal(count(db,"security_audit_records"),0);
 assert.deepEqual(retained.readVerifiedState(state=>state.resource_bindings),before);
 const saved=db.prepare("SELECT checkpoint_json FROM security_audit_checkpoint").get() as {checkpoint_json:string};
 const cp=JSON.parse(saved.checkpoint_json);cp.resource_bindings.pop();
 db.prepare("UPDATE security_audit_checkpoint SET checkpoint_json=?").run(JSON.stringify(cp));
 assert.throws(()=>retained.readVerifiedState(state=>state),AuditIntegrityError);
});
test("state readerのwrite・非同期・transaction切替えを拒否する",t=>{
 const {repository,db,store}=setup(t);
 assert.throws(()=>repository.readVerifiedState(()=>{db.exec("INSERT INTO decisions VALUES ('bad','bad')");}),AuditIntegrityError);
 assert.throws(()=>repository.readVerifiedState((async()=>true) as never),AuditIntegrityError);
 assert.throws(()=>repository.readVerifiedState(()=>{db.exec("COMMIT");}),AuditIntegrityError);
 assert.equal(count(db,"decisions"),0);assert.deepEqual(store.calls,[]);
});

test("集約rootの容量超過は予約前に拒否し最大長rootをcheckpointに保持する",t=>{
 const {repository,db,store}=setup(t);
 for(let i=0;i<64;i++)repository.appendPrepared(`root_${i}`,1,()=>({
  event:{...event,scope:{instance_id:"i".repeat(128),tenant_id:"t".repeat(128)},resource_id:String(i).padStart(128,"r")},
  resource_digest:"a".repeat(64),mutation:()=>null}));
 const calls=store.calls.length;
 assert.throws(()=>repository.appendPrepared("overflow",1,()=>({event:{...event,resource_id:"overflow"},resource_digest:"b".repeat(64),mutation:()=>null})),AuditIntegrityError);
 assert.equal(store.calls.length,calls);assert.equal(store.value.pending_transaction_id,null);
 const retained=retentionRepository(db,store);retained.retain("large_retention",2,64,"2027-11-01T00:00:00.000Z");
 const row=db.prepare("SELECT checkpoint_json FROM security_audit_checkpoint").get() as {checkpoint_json:string};
 assert.ok(Buffer.byteLength(row.checkpoint_json)>4096);assert.ok(Buffer.byteLength(row.checkpoint_json)<65536);
 assert.equal(retained.readVerifiedState(state=>state.resource_bindings.length),64);
 assert.equal(count(db,"security_audit_records"),0);
});

test("旧版retentionでrootが失われたDBでは読取と更新とcheckpoint変換を予約前に拒否する",t=>{
 const {repository,db,store}=setup(t);
 const first=repository.appendPrepared("before_retention",1,()=>({event,resource_digest:"a".repeat(64),mutation:()=>null}));
 repository.append("after_retention",1,event,()=>null);
 const legacy=signAuditCheckpoint({codec_version:1,chain_id:"shared_1",transaction_id:"legacy_retention",signed_at:at,key_version:1},keys,first.record);
 // A fully finalized historical retention, not an incomplete current write.
 db.prepare("UPDATE security_audit_checkpoint SET transaction_id=?,checkpoint_json=?").run("legacy_retention",JSON.stringify(legacy));
 db.prepare("DELETE FROM security_audit_records WHERE sequence=1").run();
 store.value={...store.value,checkpoint_mac:legacy.mac};
 assert.equal(repository.verify().sequence,2);
 const before=store.read(),calls=store.calls.length;let readers=0,planners=0;
 assert.throws(()=>repository.readVerifiedState(()=>{readers++;return null;}),AuditIntegrityError);
 assert.throws(()=>repository.appendPrepared("unsafe_continue",1,()=>{planners++;return {event,resource_digest:null,mutation:()=>null};}),AuditIntegrityError);
 assert.throws(()=>retentionRepository(db,store).retain("unsafe_conversion",2,2,"2027-11-01T00:00:00.000Z"),AuditIntegrityError);
 assert.equal(readers,0);assert.equal(planners,0);assert.equal(store.calls.length,calls);assert.deepEqual(store.read(),before);
 assert.equal(count(db,"security_audit_records"),1);
});

test("verified read stateはcallback中のexact objectとconnectionだけで有効",t=>{
 const f=setup(t),other=setup(t);let saved:VerifiedAuditState|undefined;let traps=0;
 f.repository.readVerifiedState(state=>{
  saved=state;assertCurrentAuditReadState(f.db,state);
  for(const invalid of [{...state},structuredClone(state),new Proxy(state,{get(){traps++;throw Error();}})])
   assert.throws(()=>assertCurrentAuditReadState(f.db,invalid),AuditIntegrityError);
  assert.throws(()=>assertCurrentAuditReadState(other.db,state),AuditIntegrityError);
  other.repository.readVerifiedState(peer=>{
   assertCurrentAuditReadState(other.db,peer);assertCurrentAuditReadState(f.db,state);
   assert.throws(()=>assertCurrentAuditReadState(f.db,peer),AuditIntegrityError);
   assert.throws(()=>assertCurrentAuditReadState(other.db,state),AuditIntegrityError);return null;
  });
  assertCurrentAuditReadState(f.db,state);return null;
 });
 assert.ok(saved);assert.equal(traps,0);
 assert.throws(()=>assertCurrentAuditReadState(f.db,saved!),AuditIntegrityError);
 f.db.pragma("query_only=ON");
 try{f.db.transaction(()=>{
  assert.throws(()=>assertCurrentAuditReadState(f.db,saved!),AuditIntegrityError);
  assert.throws(()=>assertCurrentAuditReadState(f.db,undefined as unknown as VerifiedAuditState),AuditIntegrityError);
 })();}finally{f.db.pragma("query_only=OFF");}
});

test("例外で終わったread stateも失効し次のverified callbackへ持ち込めない",t=>{
 const f=setup(t);let old:VerifiedAuditState|undefined;
 assert.throws(()=>f.repository.readVerifiedState(state=>{old=state;throw Error("fixture failure");}),AuditIntegrityError);
 assert.ok(old);assert.throws(()=>assertCurrentAuditReadState(f.db,old!),AuditIntegrityError);
 f.repository.readVerifiedState(state=>{
  assertCurrentAuditReadState(f.db,state);assert.throws(()=>assertCurrentAuditReadState(f.db,old!),AuditIntegrityError);return null;
 });
 assert.equal(f.store.calls.length,0);
});

test("prepare stateはmutation前に失効しprepare例外はanchorを予約しない",t=>{
 const f=setup(t);let prepared:VerifiedAuditState|undefined;
 f.repository.appendPrepared("phases",1,state=>{
  prepared=state;assertCurrentAuditReadState(f.db,state);
  assert.throws(()=>f.db.exec("INSERT INTO decisions VALUES('early','invalid')"));
  return {event,resource_digest:null,mutation:()=>{
   assert.throws(()=>assertCurrentAuditReadState(f.db,state),AuditIntegrityError);
   f.db.exec("INSERT INTO decisions VALUES('expected','valid')");return null;
  }};
 });
 assert.ok(prepared);assert.throws(()=>assertCurrentAuditReadState(f.db,prepared!),AuditIntegrityError);
 const before=f.store.calls.length;
 assert.throws(()=>f.repository.appendPrepared("throw",1,state=>{
  prepared=state;assertCurrentAuditReadState(f.db,state);throw Error("fixture failure");
 }),AuditIntegrityError);
 assert.equal(f.store.calls.length,before);assert.throws(()=>assertCurrentAuditReadState(f.db,prepared!),AuditIntegrityError);
 assert.equal(count(f.db,"decisions"),1);
});
