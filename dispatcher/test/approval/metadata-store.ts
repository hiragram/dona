import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setup, scope as auditScope } from "../web/fixtures.js";
import { installApprovalSchema, installApprovalMetadataSchema, verifyApprovalMetadataSchema, ApprovalSchemaError } from "../../src/approval/schema.js";
import { openSecurityDatabase } from "../../src/audit/coordination.js";
import { ApprovalMetadataNodes, MetadataStoreError } from "../../src/approval/metadata-store.js";
import { emptyMetadataRoot, prepareMetadataUpdate, readMetadataValue, MetadataConflictError, type MetadataTreeNodeReader } from "../../src/approval/metadata-tree.js";
import { ApprovalTransactionError } from "../../src/approval/transaction.js";
import type { AuditEvent } from "../../src/audit/codec.js";
const scope = { instance_id: auditScope.instance_id, workspace_id: auditScope.tenant_id, collection: "approval_records_v1" } as const;
const digest = createHash("sha256").update("fixture business state").digest("hex");
const event: Omit<AuditEvent, "occurred_at"> = { scope: auditScope, actor: { kind: "system", id: "fixture" }, action: "approval_request", operation: "slack.post_thread_reply.v1", resource_id: "approval_records", outcome: "succeeded", reason: "none", session_ref: null, receipt_id: null, attempt_id: null, policy_revision: 1, binding_revision: 1, authz_revision: 1 };
function schemaFixture(t: { after(fn: () => void): void }) {
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.homedir()),".dona-metadata-schema-"));
 const filename=path.join(directory,"fixture.sqlite");fs.writeFileSync(filename,"",{mode:0o600,flag:"wx"});
 let db=openSecurityDatabase(filename);
 const configure=()=>{db.pragma("journal_mode=WAL");db.pragma("foreign_keys=ON");db.pragma("synchronous=FULL");};
 configure();installApprovalSchema(db);
 t.after(()=>{if(db.open)db.close();fs.rmSync(directory,{recursive:true,force:true});});
 return {filename,get db(){return db;},reopen(){db.close();db=openSecurityDatabase(filename);configure();}};
}
function fixture(t: { after(fn: () => void): void }) {
 const f=setup(t); installApprovalMetadataSchema(f.db); const nodes=new ApprovalMetadataNodes(f.db);
 f.db.exec("CREATE TABLE fixture_business (value TEXT NOT NULL) STRICT");
 return { ...f, nodes };
}
function commit(f: ReturnType<typeof fixture>, fail = false) {
 return f.transaction.runPrepared("metadata_commit", (_mark, verified) => {
  assert.equal(verified.resource_bindings.some(binding => binding.resource_id === "approval_records"), false);
  assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM fixture_business").get(), {n:0});
  // 明示的な空fixtureからのみrootを作成。runtime bootstrap APIではない。
  const plan=f.nodes.read(reader=>prepareMetadataUpdate(scope,emptyMetadataRoot(scope),"fixture_record",null,digest,reader));
  return {event,resource_digest:plan.proposed_root,mutation:()=>{
   f.nodes.stage(plan.nodes);f.db.prepare("INSERT INTO fixture_business VALUES (?)").run(digest);
   if(fail)throw new Error("fixture rollback"); return plan.proposed_root;
  }};
 });
}

test("nodeと業務fixtureを同じ監査commitへ結びWeb schemaとも共存する",t=>{
 const f=fixture(t);const root=commit(f);
 assert.equal(f.audit.readVerifiedState(state=>{
  const binding=state.resource_bindings.find(item=>item.resource_id==="approval_records");assert.equal(binding?.resource_digest,root);
  return f.nodes.read(reader=>readMetadataValue(scope,binding!.resource_digest,"fixture_record",reader));
 }),digest);
 assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_metadata_nodes").get(),{n:257});
 assert.equal(f.store.initialize("web_initialize").status,"succeeded");verifyApprovalMetadataSchema(f.db);
});

test("業務mutation失敗ではnodeもrollbackする",t=>{
 const f=fixture(t);assert.throws(()=>commit(f,true),ApprovalTransactionError);
 assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_metadata_nodes").get(),{n:0});
 assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM fixture_business").get(),{n:0});
 assert.deepEqual(f.anchors.calls,["reserve"]);
});

test("読取の前後でDBの移動・置換を検出し旧inodeの結果を返さない",t=>{
 for(const when of ["before","during","conflict"] as const){
  const f=fixture(t),root=commit(f);
  const replace=()=>{fs.renameSync(f.filename,f.filename+".detached");fs.copyFileSync(f.filename+".detached",f.filename);fs.chmodSync(f.filename,0o600);};
  if(when==="before")replace();
  let rejected=false;
  assert.throws(()=>f.audit.readVerified(()=>{
   try{return f.nodes.read(reader=>{
    const value=readMetadataValue(scope,root,"fixture_record",reader);
    if(when!=="before")replace();
    if(when==="conflict")throw new MetadataConflictError();
    return value;
   });}catch(error){
    assert.ok(error instanceof MetadataStoreError);assert.equal(error.message,"approval_metadata_store_unverified");rejected=true;throw error;
   }
  }),{name:"AuditIntegrityError",message:"audit_integrity_unverified"});
  assert.equal(rejected,true);
 }
});

test("codecの通常競合はstore障害にせず同じ監査transactionでdenialへできる",t=>{
 const f=fixture(t),root=commit(f);
 const result=f.transaction.runPrepared("metadata_conflict",(_mark,state)=>{
  assert.equal(state.resource_bindings.find(item=>item.resource_id==="approval_records")?.resource_digest,root);
  try {
   f.nodes.read(reader=>prepareMetadataUpdate(scope,root,"fixture_record","0".repeat(64),"b".repeat(64),reader));
   throw new Error("expected conflict");
  } catch(error) {
   assert.ok(error instanceof MetadataConflictError);
   return {event:{...event,outcome:"denied",reason:"idempotency_conflict"},resource_digest:root,
    mutation:()=>({status:"denied",reason:"idempotency_conflict"})};
  }
 });
 assert.deepEqual(result,{status:"denied",reason:"idempotency_conflict"});
 assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_metadata_nodes").get(),{n:257});
 assert.deepEqual(f.anchors.calls,["reserve","finalize","reserve","finalize"]);
 f.audit.readVerifiedState(state=>{assert.equal(state.resource_bindings.find(item=>item.resource_id==="approval_records")?.resource_digest,root);return null;});
 assert.throws(()=>f.db.transaction(()=>f.nodes.read(()=>{throw Object.assign(new MetadataConflictError(),{message:"private detail"});}))(),
  {name:"MetadataConflictError",message:"metadata_value_conflict"});
});

test("anchor不明を再試行せずnodeとbusinessのcommit境界を区別する",t=>{
 for(const fault of ["reserve_after","finalize_before","finalize_after"] as const){
  const f=fixture(t);f.anchors.fault=fault;
  assert.throws(()=>commit(f),ApprovalTransactionError);
  assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_metadata_nodes").get(),{n:fault==="reserve_after"?0:257});
  assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM fixture_business").get(),{n:fault==="reserve_after"?0:1});
  assert.deepEqual(f.anchors.calls,fault==="reserve_after"?["reserve"]:["reserve","finalize"]);
 }
});

test("read専用phaseのstageとcallback終了後のreader再利用を拒否する",t=>{
 const f=fixture(t); const plan=prepareMetadataUpdate(scope,emptyMetadataRoot(scope),"fixture_record",null,digest,()=>undefined);
 assert.throws(()=>f.nodes.stage(plan.nodes),MetadataStoreError);
 assert.throws(()=>f.audit.readVerified(()=>f.nodes.stage(plan.nodes)));
 let leaked: MetadataTreeNodeReader | undefined;
 f.audit.readVerified(()=>f.nodes.read(reader=>{leaked=reader;return null;}));
 assert.throws(()=>leaked!(plan.proposed_root),MetadataStoreError);
 assert.throws(()=>f.db.transaction(()=>leaked!(plan.proposed_root))(),MetadataStoreError);
 assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_metadata_nodes").get(),{n:0});
});

test("v1の既存requestを保持して明示migrationし再openでもnodeを読む",t=>{
 const f=schemaFixture(t);
 f.db.prepare("INSERT INTO approval_clock_reservations VALUES (?,?)").run("prior",JSON.stringify({codec_version:1,transaction_id:"prior"}));
 // schema migration用の既存row。本人性やcanonical snapshotの採用fixtureではない。
 const snapshot=JSON.stringify({codec_version:1,operation_kind:"slack.post_thread_reply.v1",instance_id:"instance",workspace_id:"tenant",policy_revision:1});
 f.db.prepare(`INSERT INTO approval_requests(request_id,instance_id,workspace_id,creation_key,snapshot_json,semantic_hash,binding_id,binding_revision,policy_revision,model_version,state,revision,created_at,expires_at,clock_transaction_id)
 VALUES ('prior','instance','tenant',?,?,?,'binding',1,1,'fixture','requested',1,'2026-09-19T00:00:00.000Z','2026-09-19T00:15:00.000Z','prior')`).run("a".repeat(64),snapshot,digest);
 const prior=f.db.prepare("SELECT * FROM approval_requests").all();
 assert.throws(()=>new ApprovalMetadataNodes(f.db),MetadataStoreError);
 assert.deepEqual(f.db.prepare("SELECT version FROM approval_schema").get(),{version:1});
 installApprovalMetadataSchema(f.db);installApprovalMetadataSchema(f.db);installApprovalSchema(f.db);
 assert.deepEqual(f.db.prepare("SELECT * FROM approval_requests").all(),prior);
 const nodes=new ApprovalMetadataNodes(f.db),plan=prepareMetadataUpdate(scope,emptyMetadataRoot(scope),"fixture_record",null,digest,()=>undefined);
 f.db.transaction(()=>nodes.stage(plan.nodes)).immediate();
 f.reopen();verifyApprovalMetadataSchema(f.db);const reopened=new ApprovalMetadataNodes(f.db);
 assert.equal(f.db.transaction(()=>reopened.read(reader=>readMetadataValue(scope,plan.proposed_root,"fixture_record",reader)))(),digest);
 assert.deepEqual(f.db.prepare("SELECT * FROM approval_requests").all(),prior);
});

test("v1の未知DDL・version・TEMP shadowをmigrationで修復しない",t=>{
 for(const sql of ["CREATE TABLE approval_unknown(value TEXT)","CREATE TEMP VIEW approval_requests AS SELECT 1 AS request_id","PRAGMA ignore_check_constraints=ON;UPDATE approval_schema SET version=99;PRAGMA ignore_check_constraints=OFF"]){
  const f=schemaFixture(t);f.db.exec(sql);
  const before=f.db.prepare("SELECT type,name,sql FROM main.sqlite_master ORDER BY name").all();
  assert.throws(()=>installApprovalMetadataSchema(f.db),ApprovalSchemaError);
  assert.deepEqual(f.db.prepare("SELECT type,name,sql FROM main.sqlite_master ORDER BY name").all(),before);
  assert.equal(f.db.prepare("SELECT 1 FROM main.sqlite_master WHERE name='approval_metadata_nodes'").get(),undefined);
 }
});

test("v1移行末尾と既存v2の早期returnでもDB置換を検出して成功にしない",t=>{
 for(const version of [1,2]){
  const f=schemaFixture(t);if(version===2)installApprovalMetadataSchema(f.db);
  const prepare=f.db.prepare.bind(f.db);let checks=0,replaced=false;
  // 固定FK検証の直後に別processのrenameを再現するtest-only hook。
  f.db.prepare=((...args:Parameters<typeof f.db.prepare>)=>{
   const statement=prepare(...args);
   if(args[0]==="PRAGMA main.foreign_key_check"){
    const get=statement.get.bind(statement);
    statement.get=((...bindings:Parameters<typeof statement.get>)=>{
     const value=get(...bindings);
     if(++checks===(version===1?2:1)){
      fs.renameSync(f.filename,f.filename+".detached");fs.copyFileSync(f.filename+".detached",f.filename);fs.chmodSync(f.filename,0o600);replaced=true;
     }
     return value;
    }) as typeof statement.get;
   }
   return statement;
  }) as typeof f.db.prepare;
  try{assert.throws(()=>installApprovalMetadataSchema(f.db),ApprovalSchemaError);}finally{f.db.prepare=prepare;}
  assert.equal(replaced,true);assert.deepEqual(f.db.prepare("SELECT version FROM approval_schema").get(),{version});
 }
});

test("v2の改変trigger・追加column・TEMP shadow・未知versionを拒否する",t=>{
 for(const sql of ["DROP TRIGGER approval_metadata_nodes_no_delete","ALTER TABLE approval_metadata_nodes ADD COLUMN extra TEXT","CREATE TEMP TABLE approval_metadata_nodes(digest TEXT,wire TEXT)","PRAGMA ignore_check_constraints=ON;UPDATE approval_schema SET version=99;PRAGMA ignore_check_constraints=OFF"]){
  const f=schemaFixture(t);installApprovalMetadataSchema(f.db);f.db.exec(sql);
  assert.throws(()=>verifyApprovalMetadataSchema(f.db),ApprovalSchemaError);
  assert.throws(()=>new ApprovalMetadataNodes(f.db),MetadataStoreError);
  assert.throws(()=>installApprovalMetadataSchema(f.db),ApprovalSchemaError);
 }
});

test("不正nodeと重複batchを拒否しimmutable nodeを更新・削除・置換できない",t=>{
 const f=fixture(t),plan=prepareMetadataUpdate(scope,emptyMetadataRoot(scope),"fixture_record",null,digest,()=>undefined);
 const other=prepareMetadataUpdate(scope,emptyMetadataRoot(scope),"other_record",null,digest,()=>undefined);
 const oversized=[...new Map([...plan.nodes,...other.nodes].map(node=>[node.digest,node])).values()];assert.ok(oversized.length>257);
 const emptyInner=Buffer.from(plan.nodes[256]!.wire,"base64");
 for(const right of [false,true]){
  const child=Buffer.from(emptyInner.subarray(0,67));child[0]=0x45;child.writeUInt16BE(1,33);if(right)child[35]=0x80;
  createHash("sha256").update("dona.metadata-tree-node.v1\0").update(child).digest().copy(emptyInner,right?99:67);
 }
 const noncanonical={wire:emptyInner.toString("base64"),digest:createHash("sha256").update("dona.metadata-tree-node.v1\0").update(emptyInner).digest("hex")};
 for(const batch of [[],oversized,[noncanonical],[plan.nodes[0]!,plan.nodes[0]!],[{...plan.nodes[0]!,wire:"A".repeat(177)}],[{...plan.nodes[0]!,digest:"0".repeat(64)}]]){
  assert.throws(()=>f.db.transaction(()=>f.nodes.stage(batch)).immediate(),MetadataStoreError);
  assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_metadata_nodes").get(),{n:0});
 }
 f.db.transaction(()=>f.nodes.stage(plan.nodes)).immediate();
 f.db.transaction(()=>f.nodes.stage(plan.nodes)).immediate();
 assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_metadata_nodes").get(),{n:257});
 for(const sql of ["UPDATE approval_metadata_nodes SET wire=wire","DELETE FROM approval_metadata_nodes","INSERT OR REPLACE INTO approval_metadata_nodes SELECT digest,wire FROM approval_metadata_nodes"])
  assert.throws(()=>f.db.exec(sql),/approval_metadata_node_immutable/);
});

test("保存後のwire破損と過大値をboundedに拒否する",t=>{
 const f=fixture(t),root=commit(f);
 f.db.exec("DROP TRIGGER approval_metadata_nodes_no_update; PRAGMA ignore_check_constraints=ON");
 f.db.prepare("UPDATE approval_metadata_nodes SET wire=? WHERE digest=?").run("A".repeat(1000000),root);
 f.db.exec("PRAGMA ignore_check_constraints=OFF; CREATE TRIGGER approval_metadata_nodes_no_update BEFORE UPDATE ON approval_metadata_nodes\n          BEGIN SELECT RAISE(ABORT,'approval_metadata_node_immutable'); END");
 verifyApprovalMetadataSchema(f.db);
 assert.throws(()=>f.audit.readVerified(()=>f.nodes.read(reader=>readMetadataValue(scope,root,"fixture_record",reader))));
});

test("同じreaderでも直前に保存したnodeをSQLから読み直す", t => {
 const f=fixture(t),plan=prepareMetadataUpdate(scope,emptyMetadataRoot(scope),"fixture_record",null,digest,()=>undefined);
 f.db.transaction(()=>f.nodes.read(reader=>{
  assert.equal(reader(plan.proposed_root),undefined);
  f.nodes.stage(plan.nodes);
  assert.equal(reader(plan.proposed_root),plan.nodes.find(node=>node.digest===plan.proposed_root)!.wire);
  assert.equal(readMetadataValue(scope,plan.proposed_root,"fixture_record",reader),digest);
  return null;
 }))();
});
test("同じreaderの先行結果をcacheせず後続SQL破損をboundedに拒否する", t => {
 const f=fixture(t),root=commit(f);
 assert.throws(()=>f.db.transaction(()=>f.nodes.read(reader=>{
  assert.equal(readMetadataValue(scope,root,"fixture_record",reader),digest);
  // 外部改変を再現するtest専用の非audit transaction。DDLもrollbackする。
  f.db.exec("DROP TRIGGER approval_metadata_nodes_no_update; PRAGMA ignore_check_constraints=ON");
  f.db.prepare("UPDATE approval_metadata_nodes SET wire=? WHERE digest=?").run("A".repeat(1000000),root);
  f.db.exec("PRAGMA ignore_check_constraints=OFF; CREATE TRIGGER approval_metadata_nodes_no_update BEFORE UPDATE ON approval_metadata_nodes\n          BEGIN SELECT RAISE(ABORT,'approval_metadata_node_immutable'); END");
  reader(root);
  return null;
 }))(),MetadataStoreError);
 assert.equal(f.audit.readVerified(()=>f.nodes.read(reader=>readMetadataValue(scope,root,"fixture_record",reader))),digest);
});
