import { AuditRepository } from "../../src/audit/repository.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { openSecurityDatabase } from "../../src/audit/coordination.js";
import { setup, scope as auditScope } from "../web/fixtures.js";
import { recordFixtures, snapshotFixture } from "./fixtures/records.js";
import { encodeApprovalSnapshot } from "../../src/approval/snapshot.js";
import { ApprovalRecordMutation } from "../../src/approval/record-mutation.js";
import { ApprovalRecordRepository } from "../../src/approval/record-repository.js";
import { ApprovalMetadataNodes } from "../../src/approval/metadata-store.js";
import { ApprovalIndexBlobs } from "../../src/approval/index-store.js";
import { ApprovalMetadataPlan } from "../../src/approval/metadata-plan.js";
import { ApprovalMetadataPlanWriter } from "../../src/approval/metadata-plan-store.js";
import { emptyMetadataRoot } from "../../src/approval/metadata-tree.js";
import { installApprovalSchema, installApprovalMetadataSchema, installApprovalIndexSchema, installApprovalPayloadSchema } from "../../src/approval/schema.js";
import { ApprovalPayloadSql } from "../../src/approval/payload-sql.js";
import { ApprovalPayloadMutation } from "../../src/approval/payload-mutation.js";
import { ApprovalPayloadRepository, ApprovalPayloadRepositoryError } from "../../src/approval/payload-repository.js";
import { createApprovalContentBinding, sealApprovalPayload, openApprovalPayload, type ApprovalPayloadKey, type ApprovalPayloadBinding } from "../../src/approval/payload-protection.js";
import { encodeApprovalPayloadEnvelope, type ApprovalPayloadMetadata } from "../../src/approval/payload-metadata.js";
import { ApprovalTransactionError } from "../../src/approval/transaction.js";
import type { ApprovalRecordKind } from "../../src/approval/record-codec.js";
import type { ClockMark } from "../../src/approval/clock.js";
import type { AuditEvent, VerifiedAuditState } from "../../src/audit/codec.js";
const scope={instance_id:auditScope.instance_id,workspace_id:auditScope.tenant_id};
const start="2026-09-19T00:00:00.000Z",text="fixture-only approval body";
const contentKey:ApprovalPayloadKey={version:1,purpose:"approval_content",state:"active",activated_at:"2026-09-01T00:00:00.000Z",signing_expires_at:"2026-11-01T00:00:00.000Z",secret:Buffer.alloc(32,61)};
const wrappingKey:ApprovalPayloadKey={...contentKey,purpose:"approval_payload_wrap",secret:Buffer.alloc(32,62)};
const event:Omit<AuditEvent,"occurred_at">={scope:auditScope,actor:{kind:"system",id:"fixture"},action:"approval_request",operation:"slack.post_thread_reply.v1",resource_id:"fixture_operation",outcome:"succeeded",reason:"none",session_ref:null,receipt_id:null,attempt_id:null,policy_revision:1,binding_revision:3,authz_revision:1};
const kinds:ApprovalRecordKind[]=["request","decision","consume","execution","notification","event","presentation"];
function fixture(t:{after(fn:()=>void):void},initialize=true){
  const f=setup(t);installApprovalMetadataSchema(f.db);installApprovalIndexSchema(f.db);installApprovalPayloadSchema(f.db);f.setNow(start);
  const nodes=new ApprovalMetadataNodes(f.db),indexes=new ApprovalIndexBlobs(f.db,scope),writer=new ApprovalMetadataPlanWriter(f.db,scope);
  if(initialize)f.transaction.runPrepared("fixture_roots",()=>{
    // Fixture-only initialization of known empty storage; no production bypass.
    assert.equal(f.db.prepare("SELECT count(*) FROM approval_requests").pluck().get(),0);
    assert.equal(f.db.prepare("SELECT count(*) FROM approval_payload_metadata").pluck().get(),0);
    const plan=nodes.read(n=>indexes.read(i=>{
      const p=new ApprovalMetadataPlan(scope,emptyMetadataRoot({...scope,collection:"approval_records_v1"}),n,i);
      for(const record_kind of kinds)for(const membership of ["all","active"] as const){
        if(membership==="active" && ["decision","consume"].includes(record_kind))continue;
        p.putIndex(null,{codec_version:1,scope,kind:"manifest",list:{record_kind,membership},count:0,head:null,tail:null});
      }
      return p.finish();
    }));
    return {event,resource_commitments:[{scope:auditScope,resource_id:"approval_payloads",resource_digest:emptyMetadataRoot({...scope,collection:"approval_payloads_v1"})},
      {scope:auditScope,resource_id:"approval_records",resource_digest:plan.proposed_root}],mutation:()=>{writer.stage(plan);return null;}};
  });
  return {...f,recordMutation:new ApprovalRecordMutation(f.db,scope),records:new ApprovalRecordRepository(f.db,f.providers.auditAnchors,f.providers.auditKeys,scope),
    payloadMutation:new ApprovalPayloadMutation(f.db,scope),payloads:new ApprovalPayloadRepository(f.db,f.providers.auditAnchors,f.providers.auditKeys,scope),payloadSql:new ApprovalPayloadSql(f.db,scope)};
}
type Fixture=ReturnType<typeof fixture>;
function sealed(binding:ApprovalPayloadBinding,mark:ClockMark){
  const envelope=sealApprovalPayload(text,binding,wrappingKey,contentKey,mark);
  const metadata:ApprovalPayloadMetadata={codec_version:1,binding,consume_id:binding.owner_kind==="attempt"?"consume":null,
    envelope_digest:encodeApprovalPayloadEnvelope(envelope).digest,state:"active",deleted_at:null};
  return {previous:null,next:metadata,envelope};
}
function create(f:Fixture){
  return f.transaction.runPrepared("create",(mark,state)=>{
    const content=createApprovalContentBinding(text,scope,"draft",contentKey,mark);
    const input={...snapshotFixture(),...scope,encrypted_content_ref:"payload-store:request_payload",content_hmac_sha256:content.mac,content_hmac_key_version:content.key_version};
    const snapshot=encodeApprovalSnapshot(input,{...scope,request_source:input.request_source});
    const request=recordFixtures().request;request.scope=scope;
    Object.assign(request.row,scope,{created_at:mark.effective_utc,clock_transaction_id:mark.transaction_id,snapshot_json:snapshot.canonical,semantic_hash:snapshot.semantic_hash,creation_key:snapshot.creation_key});
    const change=sealed({codec_version:1,scope,owner_kind:"request",owner_id:"request",request_id:"request",semantic_hash:snapshot.semantic_hash,payload_ref:"request_payload",content,created_at:mark.effective_utc,expires_at:"2026-09-19T00:20:00.000Z"},mark);
    const record=f.recordMutation.prepare(mark,state,[{previous:null,next:request}]),payload=f.payloadMutation.prepare(mark,state,[change]);
    return {event,resource_commitments:[...payload.resource_commitments,...record.resource_commitments],mutation:()=>{record.mutation();payload.mutation();return null;}};
  });
}
function remove(f:Fixture,transactionId="remove"){
  const old=f.payloads.inspect("request","request")!.metadata,request=f.records.read("request","request")!;
  return f.transaction.runPrepared(transactionId,(mark,state)=>{
    const record=f.recordMutation.prepare(mark,state,[{previous:request,next:{...request,row:{...request.row,state:"needs_review",revision:request.row.revision+1}}}]);
    const payload=f.payloadMutation.prepare(mark,state,[{previous:old,next:{...old,state:"deleted",deleted_at:mark.effective_utc},envelope:null}]);
    return {event,resource_commitments:[...payload.resource_commitments,...record.resource_commitments],mutation:()=>{record.mutation();payload.mutation();return null;}};
  });
}
function consume(f:Fixture){
  f.setNow("2026-09-19T00:01:00.000Z");
  const request=f.records.read("request","request")!;
  f.transaction.runPrepared("approve",(mark,state)=>{
    const decision=recordFixtures().decision;decision.scope=scope;Object.assign(decision.row,scope,{semantic_hash:request.row.semantic_hash,decided_at:mark.effective_utc,clock_transaction_id:mark.transaction_id});
    return {event,...f.recordMutation.prepare(mark,state,[{previous:request,next:{...request,row:{...request.row,state:"approved",revision:2,consume_expires_at:"2026-09-19T00:06:00.000Z"}}},{previous:null,next:decision}])};
  });
  f.setNow("2026-09-19T00:02:00.000Z");
  const old=f.payloads.inspect("request","request")!,approved=f.records.read("request","request")!;
  assert.equal(old.secret.status,"present");
  f.transaction.runPrepared("consume",(mark,state)=>{
    assert.equal(old.secret.status,"present");if(old.secret.status!=="present")throw Error();
    assert.equal(openApprovalPayload(old.secret.envelope,old.metadata.binding,wrappingKey,contentKey,mark),text);
    const values=recordFixtures();values.consume.scope=scope;values.execution.scope=scope;
    Object.assign(values.consume.row,{claimed_at:mark.effective_utc,clock_transaction_id:mark.transaction_id});
    Object.assign(values.execution.row,{claimed_at:mark.effective_utc,execution_expires_at:"2026-09-19T00:02:30.000Z",payload_expires_at:"2026-09-20T00:02:00.000Z",clock_transaction_id:mark.transaction_id});
    const record=f.recordMutation.prepare(mark,state,[{previous:approved,next:{...approved,row:{...approved.row,state:"consumed",revision:3}}},{previous:null,next:values.consume},{previous:null,next:values.execution}]);
    const next=sealed({...old.metadata.binding,owner_kind:"attempt",owner_id:"attempt",payload_ref:"attempt_payload",created_at:mark.effective_utc,expires_at:values.execution.row.payload_expires_at},mark);
    const payload=f.payloadMutation.prepare(mark,state,[{previous:old.metadata,next:{...old.metadata,state:"deleted",deleted_at:mark.effective_utc},envelope:null},next]);
    return {event,resource_commitments:[...payload.resource_commitments,...record.resource_commitments],mutation:()=>{record.mutation();payload.mutation();return null;}};
  });
}

test("request record・暗号文・payload rootを同一監査commitで保存する",t=>{
  const f=fixture(t);assert.equal(f.payloads.inspect("request","request"),null);create(f);
  const value=f.payloads.inspect("request","request")!;assert.equal(value.secret.status,"present");
  assert.equal(value.metadata.binding.semantic_hash,f.records.read("request","request")!.row.semantic_hash);
  if(value.secret.status!=="present")throw Error();
  assert.equal(openApprovalPayload(value.secret.envelope,value.metadata.binding,wrappingKey,contentKey,f.marks.read()),text);
  assert.ok(Object.isFrozen(value)&&Object.isFrozen(value.metadata)&&Object.isFrozen(value.secret));
  assert.equal(f.db.prepare("SELECT count(*) FROM approval_payload_secrets").pluck().get(),1);
});

test("consumeでrequest payload削除とattempt再暗号化を両rootと同時にcommitする",t=>{
  const f=fixture(t);create(f);consume(f);
  assert.equal(f.records.read("request","request")!.row.state,"consumed");
  assert.equal(f.records.read("execution","attempt")!.row.state,"claimed");
  assert.equal(f.payloads.inspect("request","request")!.secret.status,"deleted");
  const attempt=f.payloads.inspect("attempt","attempt")!;assert.equal(attempt.secret.status,"present");
  if(attempt.secret.status!=="present")throw Error();
  assert.equal(openApprovalPayload(attempt.secret.envelope,attempt.metadata.binding,wrappingKey,contentKey,f.marks.read()),text);
  assert.equal(f.db.prepare("SELECT count(*) FROM approval_payload_metadata").pluck().get(),2);
  assert.equal(f.db.prepare("SELECT payload_ref FROM approval_payload_secrets").pluck().get(),"attempt_payload");
});

test("期限後も本文を再利用せずneeds_reviewとpayload削除を同時に保存する",t=>{
  const f=fixture(t);create(f);f.setNow("2026-09-19T00:21:00.000Z");remove(f);
  assert.equal(f.records.read("request","request")!.row.state,"needs_review");
  assert.equal(f.payloads.inspect("request","request")!.secret.status,"deleted");
  assert.equal(f.db.prepare("SELECT count(*) FROM approval_payload_secrets").pluck().get(),0);
});

function withoutTrigger(f:Fixture,name:string,work:()=>void){
  const saved=f.db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(name) as {sql:string};
  assert.ok(saved);f.db.exec(`DROP TRIGGER ${name}`);
  try{work();}finally{f.db.exec(saved.sql);}
}

test("payload欠落・改変・過大wireを本文成功とせずneeds_reviewへの削除はcommitできる",t=>{
  for(const fault of ["missing","invalid","oversized"] as const){
    const f=fixture(t);create(f);
    if(fault==="missing")withoutTrigger(f,"approval_payload_secret_delete_guard",()=>f.db.exec("DELETE FROM approval_payload_secrets"));
    else withoutTrigger(f,"approval_payload_secret_no_update",()=>{
      if(fault==="oversized")f.db.pragma("ignore_check_constraints=ON");
      try{f.db.prepare("UPDATE approval_payload_secrets SET envelope_json=json_set(envelope_json,'$.ciphertext',?)").run(fault==="oversized"?"A".repeat(400000):"AA");}
      finally{f.db.pragma("ignore_check_constraints=OFF");}
    });
    const read=f.payloads.inspect("request","request")!;
    assert.equal(read.secret.status,fault==="missing"?"missing":"invalid");assert.equal(read.secret.envelope,null);
    assert.equal(read.metadata.state,"active");
    f.setNow("2026-09-19T00:01:00.000Z");remove(f);
    assert.equal(f.records.read("request","request")!.row.state,"needs_review");
    assert.equal(f.payloads.inspect("request","request")!.secret.status,"deleted");
    assert.equal(f.db.prepare("SELECT count(*) FROM approval_payload_secrets").pluck().get(),0);
  }
});

test("current root欠落・別scope・SQLだけの状態変更と復活secretを拒否する",t=>{
  const missing=fixture(t,false);assert.throws(()=>missing.payloads.inspect("request","request"),ApprovalPayloadRepositoryError);
  for(const fault of ["scope","sql_only","revived_secret"] as const){
    const f=fixture(t);create(f);
    if(fault==="scope"){
      const other=new ApprovalPayloadRepository(f.db,f.providers.auditAnchors,f.providers.auditKeys,{...scope,workspace_id:"other"});
      assert.throws(()=>other.inspect("request","request"),ApprovalPayloadRepositoryError);
    }else if(fault==="sql_only"){
      f.db.exec("UPDATE approval_payload_metadata SET state='deleted',deleted_at='2026-09-19T00:01:00.000Z'");
      assert.throws(()=>f.payloads.inspect("request","request"),ApprovalPayloadRepositoryError);
    }else{
      const wire=f.db.prepare("SELECT envelope_json FROM approval_payload_secrets").pluck().get() as string;
      f.setNow("2026-09-19T00:01:00.000Z");remove(f);
      withoutTrigger(f,"approval_payload_secret_active",()=>f.db.prepare("INSERT INTO approval_payload_secrets VALUES('request_payload',?)").run(wire));
      assert.throws(()=>f.payloads.inspect("request","request"),ApprovalPayloadRepositoryError);
    }
  }
});

test("SQL保存後のnode障害と監査reserve/finalize応答喪失で部分成功を返さない",t=>{
  for(const fault of ["nodes","reserve_before","reserve_after","finalize_before","finalize_after"] as const){
    const f=fixture(t);
    if(fault==="nodes"){
      const prepare=f.db.prepare.bind(f.db);
      f.db.prepare=((...args:Parameters<typeof f.db.prepare>)=>{
        if(args[0].startsWith("INSERT INTO main.approval_metadata_nodes") && prepare("SELECT count(*) FROM approval_payload_secrets").pluck().get()===1)
          throw Error("fixture payload node failure");
        return prepare(...args);
      }) as typeof f.db.prepare;
      t.after(()=>{f.db.prepare=prepare;});
    }else f.anchors.fault=fault;
    assert.throws(()=>create(f),ApprovalTransactionError);
    const committed=fault.startsWith("finalize");
    for(const table of ["approval_requests","approval_payload_metadata","approval_payload_secrets"])
      assert.equal(f.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get(),committed?1:0);
    if(fault==="finalize_after")assert.equal(f.payloads.inspect("request","request")!.secret.status,"present");
    else if(fault==="reserve_before")assert.equal(f.payloads.inspect("request","request"),null);
    else assert.throws(()=>f.payloads.inspect("request","request"),ApprovalPayloadRepositoryError);
  }
});

test("payload prepared mutationは保護clockの外・別transaction・二重実行を拒否する",t=>{
  for(const mode of ["plain","outside","different","twice"] as const){
    const f=fixture(t);create(f);const old=f.payloads.inspect("request","request")!.metadata;
    let captured:ReturnType<ApprovalPayloadMutation["prepare"]>|undefined;
    if(mode==="twice"){
      assert.throws(()=>f.transaction.runPrepared("twice",(mark,state)=>{
        const plan=f.payloadMutation.prepare(mark,state,[{previous:old,next:{...old,state:"deleted",deleted_at:mark.effective_utc},envelope:null}]);
        return {event,resource_commitments:plan.resource_commitments,mutation:()=>{plan.mutation();return plan.mutation();}};
      }),ApprovalTransactionError);
    }else{
      f.transaction.runPrepared("prepare_only",(mark,state)=>{
        captured=f.payloadMutation.prepare(mark,state,[{previous:old,next:{...old,state:"deleted",deleted_at:mark.effective_utc},envelope:null}]);
        return {event,resource_digest:null,mutation:()=>null};
      });
      assert.ok(captured);
      if(mode==="plain")assert.throws(()=>f.db.transaction(()=>captured!.mutation())());
      else if(mode==="outside")assert.throws(()=>captured!.mutation());
      else assert.throws(()=>f.transaction.runPrepared("different",()=>({event,...captured!})),ApprovalTransactionError);
    }
    assert.equal(f.db.prepare("SELECT state FROM approval_payload_metadata").pluck().get(),"active");
    assert.equal(f.db.prepare("SELECT count(*) FROM approval_payload_secrets").pluck().get(),1);
  }
});

test("clock不一致・stale metadata・immutable変更・重複ownerは監査reserve前に拒否する",t=>{
  for(const fault of ["clock","stale","immutable","duplicate"] as const){
    const f=fixture(t);create(f);const old=f.payloads.inspect("request","request")!.metadata;
    f.setNow("2026-09-19T00:01:00.000Z");const count=f.anchors.calls.length;
    assert.throws(()=>f.transaction.runPrepared("bad",(mark,state)=>{
      const change={previous:fault==="stale"?{...old,envelope_digest:"0".repeat(64)}:old,
        next:{...old,state:"deleted" as const,deleted_at:fault==="clock"?start:mark.effective_utc,
          ...(fault==="immutable"?{envelope_digest:"0".repeat(64)}:{})},envelope:null};
      return {event,...f.payloadMutation.prepare(mark,state,fault==="duplicate"?[change,change]:[change])};
    }),ApprovalTransactionError);
    assert.equal(f.anchors.calls.length,count);
    assert.equal(f.payloads.inspect("request","request")!.secret.status,"present");
  }
});


test("削除済みpayload refを別ownerの新規payloadへ再利用しない",t=>{
  const f=fixture(t);create(f);const old=f.payloads.inspect("request","request")!.metadata;
  f.setNow("2026-09-19T00:01:00.000Z");remove(f);const count=f.anchors.calls.length;
  assert.throws(()=>f.transaction.runPrepared("reuse",(mark,state)=>{
    const change=sealed({...old.binding,owner_id:"another",request_id:"another",created_at:mark.effective_utc,
      content:createApprovalContentBinding(text,scope,"draft",contentKey,mark)},mark);
    return {event,...f.payloadMutation.prepare(mark,state,[change])};
  }),ApprovalTransactionError);
  assert.equal(f.anchors.calls.length,count);assert.equal(f.payloads.inspect("request","request")!.secret.status,"deleted");
  assert.equal(f.payloads.inspect("request","another"),null);
});

test("再open後も同じ監査anchorとpayload metadata・暗号文を照合する",t=>{
  const f=fixture(t);create(f);const before=f.payloads.inspect("request","request");f.db.close();
  const db=openSecurityDatabase(f.filename);
  try{
    db.pragma("journal_mode=WAL");db.pragma("synchronous=FULL");db.pragma("foreign_keys=ON");installApprovalSchema(db);
    const reopened=new ApprovalPayloadRepository(db,f.providers.auditAnchors,f.providers.auditKeys,scope);
    assert.deepEqual(reopened.inspect("request","request"),before);
  }finally{db.close();}
});

test("同一prepareでrecord・alias・list・payloadを照合して無効化と削除をcommitする",t=>{
 const f=fixture(t);create(f);f.setNow("2026-09-19T00:01:00.000Z");
 f.transaction.runPrepared("read_and_remove",(mark,state)=>{
  const request=f.records.readInState(state,"request","request")!,payload=f.payloads.inspectInState(state,"request","request")!;
  assert.deepEqual(f.records.readAliasInState(state,{name:"request_creation",creation_key:request.row.creation_key}),request);
  assert.deepEqual(f.records.readListHeadInState(state,{record_kind:"request",membership:"active"},4),{count:1,records:[request],truncated:false});
  assert.equal(payload.secret.status,"present");assert.equal(payload.metadata.binding.semantic_hash,request.row.semantic_hash);
  assert.throws(()=>f.records.read("request","request"));assert.throws(()=>f.payloads.inspect("request","request"));
  const record=f.recordMutation.prepare(mark,state,[{previous:request,next:{...request,row:{...request.row,state:"needs_review",revision:request.row.revision+1}}}]);
  const removal=f.payloadMutation.prepare(mark,state,[{previous:payload.metadata,next:{...payload.metadata,state:"deleted",deleted_at:mark.effective_utc},envelope:null}]);
  return {event,resource_commitments:[...removal.resource_commitments,...record.resource_commitments],mutation:()=>{record.mutation();removal.mutation();return null;}};
 });
 const audit=new AuditRepository(f.db,f.providers.auditAnchors,f.providers.auditKeys);
 audit.readVerifiedState(state=>{
  const request=f.records.readInState(state,"request","request")!;
  assert.equal(request.row.state,"needs_review");assert.equal(f.payloads.inspectInState(state,"request","request")!.secret.status,"deleted");
  assert.deepEqual(f.records.readAliasInState(state,{name:"request_creation",creation_key:request.row.creation_key}),request);
  assert.deepEqual(f.records.readListHeadInState(state,{record_kind:"request",membership:"active"},4),{count:0,records:[],truncated:false});return null;
 });
});

test("同一transaction読取は偽state・別connection・callback後・mutation phaseを拒否する",t=>{
 const f=fixture(t),other=fixture(t);create(f);create(other);let captured:VerifiedAuditState|undefined;
 const bad=(state:VerifiedAuditState)=>{
  assert.throws(()=>f.records.readInState(state,"request","request"));
  assert.throws(()=>f.records.readAliasInState(state,{name:"request_creation",creation_key:"0".repeat(64)}));
  assert.throws(()=>f.records.readListHeadInState(state,{record_kind:"request",membership:"all"},4));
  assert.throws(()=>f.payloads.inspectInState(state,"request","request"));
 };
 f.transaction.runPrepared("capture",(_mark,state)=>{
  captured=state;bad(structuredClone(state));
  assert.throws(()=>other.records.readInState(state,"request","request"));
  assert.throws(()=>other.payloads.inspectInState(state,"request","request"));
  return {event,resource_digest:null,mutation:()=>{bad(state);return null;}};
 });
 assert.ok(captured);bad(captured);
 f.db.pragma("query_only=ON");try{f.db.transaction(()=>bad(captured!))();}finally{f.db.pragma("query_only=OFF");}
 f.transaction.runPrepared("next",(_mark,state)=>{bad(captured!);assert.equal(f.records.readInState(state,"request","request")!.row.state,"requested");return {event,resource_digest:null,mutation:()=>null};});
});

test("同一transactionの読取でもSQL-only改変は監査reserve前に拒否する",t=>{
 for(const fault of ["record","payload"] as const){
  const f=fixture(t);create(f);
  if(fault==="record")f.db.exec("UPDATE approval_requests SET state='needs_review',revision=2");
  else f.db.exec("UPDATE approval_payload_metadata SET state='deleted',deleted_at='2026-09-19T00:01:00.000Z'");
  const before=f.anchors.calls.length;
  assert.throws(()=>f.transaction.runPrepared("tampered",(_mark,state)=>{
   f.records.readInState(state,"request","request");f.payloads.inspectInState(state,"request","request");
   return {event,resource_digest:null,mutation:()=>assert.fail("unverified data must not commit")};
  }),ApprovalTransactionError);
  assert.equal(f.anchors.calls.length,before);
 }
});
