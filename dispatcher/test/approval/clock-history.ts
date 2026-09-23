import assert from "node:assert/strict";
import { test } from "node:test";
import { setup, scope as auditScope } from "./fixtures/storage.js";
import { ApprovalClockHistory, ApprovalClockHistoryError, approvalClockHistoryResource } from "../../src/approval/clock-history.js";
import { ApprovalHistoryTransaction } from "../../src/approval/history-transaction.js";
import { ApprovalTransactionError } from "../../src/approval/transaction.js";
import { installApprovalMetadataSchema, installApprovalSchema } from "../../src/approval/schema.js";
import { emptyMetadataRoot } from "../../src/approval/metadata-tree.js";
import { AuditRepository } from "../../src/audit/repository.js";
import { type AuditEvent, type VerifiedAuditState } from "../../src/audit/codec.js";
import type { ClockMark } from "../../src/approval/clock.js";
import { openSecurityDatabase } from "../../src/audit/coordination.js";
const scope = { instance_id: auditScope.instance_id, workspace_id: auditScope.tenant_id };
const start = "2026-09-19T00:00:00.000Z";
const event: Omit<AuditEvent,"occurred_at"> = {scope:auditScope,actor:{kind:"system",id:"fixture"},action:"approval_request",operation:"slack.post_thread_reply.v1",resource_id:"fixture_operation",outcome:"succeeded",reason:"none",session_ref:null,receipt_id:null,attempt_id:null,policy_revision:1,binding_revision:1,authz_revision:1};
function fixture(t:{after(fn:()=>void):void},initialize=true) {
 const f=setup(t);installApprovalMetadataSchema(f.db);f.setNow(start);
 if(initialize)f.transaction.runPrepared("fixture_history_root",()=>({event,resource_commitments:[{scope:auditScope,resource_id:approvalClockHistoryResource,
  resource_digest:emptyMetadataRoot({...scope,collection:"approval_clock_marks_v1"})}],mutation:()=>null}));
 // Explicit empty fixture admission only, never a runtime initialization path.
 return {...f,history:new ApprovalClockHistory(f.db,scope),tracked:new ApprovalHistoryTransaction(f.db,f.providers,scope)};
}
type Fixture=ReturnType<typeof fixture>;
const commit=(f:Fixture,id="first")=>f.tracked.runPrepared(id,mark=>({event,resource_digest:null,mutation:()=>mark}));
const read=(f:Fixture,id:string)=>f.audit.readVerifiedState(state=>f.history.readInState(state,id));
function replaceMark(f:Fixture,id:string,wire:string) {
 const trigger=f.db.prepare("SELECT sql FROM sqlite_master WHERE name='approval_clock_immutable'").pluck().get() as string;
 f.db.exec("DROP TRIGGER approval_clock_immutable");
 try{f.db.prepare("UPDATE approval_clock_reservations SET mark_json=? WHERE transaction_id=?").run(wire,id);}finally{f.db.exec(trigger);}
}

test("history transactionは現在markと業務rootを同じ共有監査recordへ保存する",t=>{
 const f=fixture(t),first=commit(f);f.setNow("2026-09-19T00:01:00.000Z");
 const second=f.tracked.runPrepared("second",(mark,state)=>{
  assert.deepEqual(f.history.readInState(state,"first"),first);
  return {event,resource_digest:"a".repeat(64),mutation:()=>mark};
 });
 assert.deepEqual(read(f,"first"),first);assert.deepEqual(read(f,"second"),second);assert.equal(read(f,"absent"),null);
 const row=JSON.parse(f.db.prepare("SELECT record_json FROM security_audit_records WHERE transaction_id='second'").pluck().get() as string);
 assert.equal(row.codec_version,3);assert.deepEqual(row.resource_commitments.map((r:{resource_id:string})=>r.resource_id),[approvalClockHistoryResource,"fixture_operation"]);
 assert.equal(Object.isFrozen(read(f,"first")),true);
 assert.throws(()=>commit(f,"first"),ApprovalTransactionError);assert.deepEqual(read(f,"first"),first);
});

test("boot・continuous・UTC・前mark・wireのSQL-only改変を現在rootで検出する",t=>{
 for(const fault of ["boot","continuous","utc","previous","whitespace","unknown","oversize"] as const){
  const f=fixture(t),mark=commit(f);let altered={...mark};
  if(fault==="boot")altered.boot_id="another_boot";
  if(fault==="continuous")altered.continuous_ms++;
  if(fault==="utc")altered.effective_utc="2026-09-19T00:00:01.000Z";
  if(fault==="previous")altered.previous_transaction_id="other";
  const wire=fault==="whitespace"?JSON.stringify(altered,null,2):JSON.stringify({...altered,...(fault==="unknown"?{unexpected:true}:fault==="oversize"?{boot_id:"x".repeat(5000)}:{})});
  replaceMark(f,"first",wire);assert.throws(()=>read(f,"first"));
  const count=f.anchors.calls.length;
  assert.throws(()=>f.tracked.runPrepared("bad_read",(_mark,state)=>{f.history.readInState(state,"first");return {event,resource_digest:null,mutation:()=>null};}),ApprovalTransactionError);
  assert.equal(f.anchors.calls.length,count);
 }
});

test("root欠落・未追跡のlegacy mark・別scope・偽stateを証拠として返さない",t=>{
 const missing=fixture(t,false);assert.throws(()=>commit(missing),ApprovalTransactionError);assert.equal(missing.anchors.calls.length,0);
 const f=fixture(t);commit(f);assert.throws(()=>read(f,"fixture_history_root"));
 const other=new ApprovalClockHistory(f.db,{...scope,workspace_id:"other"});let saved:VerifiedAuditState|undefined;
 f.audit.readVerifiedState(state=>{
  saved=state;assert.throws(()=>other.readInState(state,"first"),ApprovalClockHistoryError);
  assert.throws(()=>f.history.readInState(structuredClone(state),"first"),ApprovalClockHistoryError);return null;
 });
 assert.ok(saved);assert.throws(()=>f.history.readInState(saved!,"first"),ApprovalClockHistoryError);
 f.db.transaction(()=>assert.throws(()=>f.history.readInState(saved!,"first"),ApprovalClockHistoryError))();
});

test("履歴準備済みclosureは偽mark・別transaction・二重実行からcommitしない",t=>{
 for(const fault of ["mark","outside","different","twice"] as const){
  const f=fixture(t);let captured:ReturnType<ApprovalClockHistory["prepare"]>|undefined;
  if(fault==="mark" || fault==="twice"){
   assert.throws(()=>f.transaction.runPrepared("bad",(mark,state)=>{
    const plan=f.history.prepare(fault==="mark"?{...mark,boot_id:"forged"}:mark,state);
    return {event,resource_commitments:plan.resource_commitments,mutation:()=>{plan.mutation();return fault==="twice"?plan.mutation():null;}};
   }),ApprovalTransactionError);
   assert.equal(f.db.prepare("SELECT count(*) FROM approval_clock_reservations WHERE transaction_id='bad'").pluck().get(),0);
  }else{
   f.transaction.runPrepared("capture",(mark,state)=>{captured=f.history.prepare(mark,state);return {event,resource_digest:null,mutation:()=>null};});
   assert.ok(captured);
   if(fault==="outside")assert.throws(()=>f.db.transaction(()=>captured!.mutation())(),ApprovalClockHistoryError);
   else assert.throws(()=>f.transaction.runPrepared("different",()=>({event,...captured!})),ApprovalTransactionError);
  }
  assert.equal(f.db.prepare("SELECT count(*) FROM approval_metadata_nodes").pluck().get(),0);
 }
});

test("wrapperはhistory root上書き・別scope・重複root・非同期planを監査予約前に拒否する",t=>{
 for(const fault of ["history","scope","event","duplicate","empty","async","accessor"] as const){
  const f=fixture(t),count=f.anchors.calls.length;let calls=0;
  assert.throws(()=>f.tracked.runPrepared("bad",()=>{
   const resource={scope:fault==="scope"?{...auditScope,tenant_id:"other"}:auditScope,resource_id:fault==="history"?approvalClockHistoryResource:"record",resource_digest:"a".repeat(64)};
   if(fault==="accessor")return {event,get resource_digest(){calls++;return null;},mutation:()=>null};
   if(fault==="async")return {event,resource_digest:null,mutation:(async()=>{calls++;return null;}) as unknown as ()=>null};
   return {event:fault==="event"?{...event,scope:{...auditScope,instance_id:"other"}}:event,resource_commitments:fault==="empty"?[]:fault==="duplicate"?[resource,resource]:[resource],mutation:()=>{calls++;return null;}};
  }),ApprovalTransactionError);
  assert.equal(calls,0);assert.equal(f.anchors.calls.length,count);assert.equal(f.db.prepare("SELECT count(*) FROM approval_metadata_nodes").pluck().get(),0);
 }
});

test("history node書込とanchor reserve/finalizeの障害は部分成功を返さない",t=>{
 for(const fault of ["nodes","reserve_before","reserve_after","finalize_before","finalize_after"] as const){
  const f=fixture(t);
  if(fault==="nodes"){
   const prepare=f.db.prepare.bind(f.db);f.db.prepare=((...args:Parameters<typeof f.db.prepare>)=>{
    if(args[0].startsWith("INSERT INTO main.approval_metadata_nodes"))throw Error("fixture node failure");return prepare(...args);
   }) as typeof f.db.prepare;t.after(()=>{f.db.prepare=prepare;});
  }else f.anchors.fault=fault;
  assert.throws(()=>commit(f),ApprovalTransactionError);
  assert.equal(f.db.prepare("SELECT count(*) FROM approval_clock_reservations WHERE transaction_id='first'").pluck().get(),fault.startsWith("finalize")?1:0);
  if(fault==="finalize_after")assert.equal(read(f,"first")!.transaction_id,"first");
  else if(fault==="reserve_before")assert.equal(read(f,"first"),null);
  else assert.throws(()=>read(f,"first"));
 }
});

test("認証済みrootが参照するhistory node欠落を空履歴に変換しない",t=>{
 const f=fixture(t);commit(f);const root=f.audit.readVerifiedState(state=>state.resource_bindings.find(r=>r.resource_id===approvalClockHistoryResource)!.resource_digest);
 const trigger=f.db.prepare("SELECT sql FROM sqlite_master WHERE name='approval_metadata_nodes_no_delete'").pluck().get() as string;
 assert.equal(typeof trigger,"string");f.db.exec("DROP TRIGGER approval_metadata_nodes_no_delete");
 try{f.db.prepare("DELETE FROM approval_metadata_nodes WHERE digest=?").run(root);}finally{f.db.exec(trigger);}
 assert.throws(()=>read(f,"first"));
});

test("再openしたSQL markを同じ外部anchorのhistory rootへ照合する",t=>{
 const f=fixture(t),before=commit(f);f.db.close();const db=openSecurityDatabase(f.filename);
 try{
  db.pragma("journal_mode=WAL");db.pragma("synchronous=FULL");db.pragma("foreign_keys=ON");installApprovalSchema(db);
  const history=new ApprovalClockHistory(db,scope),audit=new AuditRepository(db,f.providers.auditAnchors,f.providers.auditKeys);
  assert.deepEqual(audit.readVerifiedState(state=>history.readInState(state,"first")),before);
 }finally{db.close();}
});
