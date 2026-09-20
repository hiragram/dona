import { assertCurrentAuditReadState } from "../../src/audit/repository.js";
import type { VerifiedAuditState } from "../../src/audit/codec.js";
import { openSecurityDatabase } from "../../src/audit/coordination.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalCreateBroker, ApprovalCreateError, type ApprovalCreateGrant, type ApprovalCreateIntent } from "../../src/approval/create-broker.js";
import { installApprovalSchema } from "../../src/approval/schema.js";
import { approvalCreationKey } from "../../src/approval/snapshot.js";
import { openApprovalPayload, type ApprovalPayloadKey } from "../../src/approval/payload-protection.js";
import { verifyApprovalNotificationMarker } from "../../src/approval/notification-marker.js";
import { scope, start, body, content, wrapping, notification, intent, grant, fixture, count } from "./fixtures/broker.js";

test("createはrequest・通知2種・暗号文・clock履歴を同一監査commitへ保存する",t=>{
 const f=fixture(t),result=f.broker.create("create",intent);assert.equal(result.status,"created");
 assert.deepEqual(Object.keys(result).sort(),["expires_at","request_handle","request_state","status"]);assert.equal(result.request_state,"delivery_pending");assert.equal(result.expires_at,"2026-09-19T00:15:00.000Z");
 const request=f.records.read("request",result.request_handle)!;assert.equal(request.row.clock_transaction_id,"create");
 const payload=f.payloads.inspect("request",result.request_handle)!;assert.equal(payload.secret.status,"present");if(payload.secret.status!=="present")throw Error();
 assert.equal(openApprovalPayload(payload.secret.envelope,payload.metadata.binding,wrapping,content,f.marks.read()),body);
 for(const kind of ["approval_card","pending_notice"] as const){
  const row=f.records.readAlias({name:"notification_request_kind",request_id:result.request_handle,notification_kind:kind});
  assert.equal(row?.kind,"notification");if(row?.kind!=="notification")throw Error();assert.equal(row.row.state,"pending");assert.equal(row.row.fence,0);
  verifyApprovalNotificationMarker({codec_version:1,...scope,request_id:result.request_handle,notification_attempt_id:row.row.notification_attempt_id,kind,semantic_hash:request.row.semantic_hash,created_at:start,key_version:1},row.row.marker_mac,notification);
 }
 assert.deepEqual([count(f,"approval_requests"),count(f,"approval_notifications"),count(f,"approval_payload_secrets")],[1,2,1]);
 assert.equal(f.audit.readVerifiedState(state=>f.history.readInState(state,"create")!.effective_utc),start);
 const audit=JSON.stringify(f.db.prepare("SELECT record_json FROM security_audit_records").all());assert.equal(audit.includes(body),false);
 assert.equal(request.row.snapshot_json.includes(body),false);assert.equal(JSON.stringify(result).includes("semantic_hash"),false);
});

test("duplicateは鍵rotation後も同じhandleと通知へ収束し新規暗号化しない",t=>{
 const f=fixture(t),first=f.broker.create("first",intent);assert.equal(first.status,"created");f.rotate();
 const second=f.broker.create("second",intent);assert.deepEqual(second,{...first,status:"reused"});assert.deepEqual(f.counts(),{authorityCalls:2,activeCalls:1,wrapCalls:1});
 assert.deepEqual([count(f,"approval_requests"),count(f,"approval_notifications"),count(f,"approval_payload_secrets")],[1,2,1]);
});

test("異なる本文・current policy・bindingとownerは既存handleを返さず状態不変",t=>{
 for(const fault of ["body","policy","binding","owner"] as const){
  const f=fixture(t),first=f.broker.create("first",intent);if(first.status==="denied")throw Error();const old=f.records.read("request",first.request_handle);
  const next=grant();if(fault==="policy")next.snapshot.policy_revision++;if(fault==="binding")next.binding_id="different";if(fault==="owner")next.snapshot.request_source.owner_id="other_owner";f.setGrant(next);
  const result=f.broker.create("conflict",fault==="body"?{...intent,text:"another draft"}:intent);
  assert.deepEqual(result,{status:"denied",reason:fault==="owner"?"unauthorized":"idempotency_conflict"});assert.deepEqual(f.records.read("request",first.request_handle),old);
  assert.equal(count(f,"approval_notifications"),2);assert.equal(count(f,"approval_payload_secrets"),1);
  const audit=JSON.parse(f.db.prepare("SELECT record_json FROM security_audit_records WHERE transaction_id='conflict'").pluck().get() as string);assert.equal(audit.event.outcome,"denied");
 }
});

test("現在authorityの拒否はactor自己申告なしで監査されrequestを作らない",t=>{
 const f=fixture(t);f.setGrant({status:"denied",reason:"binding_revoked"});assert.deepEqual(f.broker.create("denied",intent),{status:"denied",reason:"binding_revoked"});
 assert.deepEqual([count(f,"approval_requests"),count(f,"approval_notifications"),count(f,"approval_payload_secrets")],[0,0,0]);
 const audit=JSON.parse(f.db.prepare("SELECT record_json FROM security_audit_records WHERE transaction_id='denied'").pluck().get() as string);assert.deepEqual(audit.event.actor,{kind:"unauthenticated",id:null});assert.equal(f.counts().activeCalls,0);
});

test("client actor・MAC・state、scope/target/slot drift、危険mentionと不正UTF8を拒否",t=>{
 for(const fault of ["client","scope","target","slot","special","user","utf8"] as const){
  const f=fixture(t),g=grant();let input=intent;
  if(fault==="scope")g.snapshot.workspace_id="other";if(fault==="target")g.snapshot.target.channel_id="another";if(fault==="slot")g.snapshot.request_source.operation_slot="another";
  if(fault==="client")input={...intent,actor_id:"supervisor",state:"approved",marker_mac:"a".repeat(64)} as ApprovalCreateIntent;
  if(fault==="special")input={...intent,text:"<!channel>"};if(fault==="user")input={...intent,text:"<@U123>"};if(fault==="utf8")input={...intent,text:"bad\ud800"};f.setGrant(g);
  const before=f.anchors.calls.length;assert.throws(()=>f.broker.create("bad",input),ApprovalCreateError);assert.equal(f.anchors.calls.length,before);assert.equal(count(f,"approval_requests"),0);
 }
});

test("allowlistの明示user mentionだけをexactな通知対象表示へ結び付ける",t=>{
 const f=fixture(t),g=grant();g.snapshot.policy.allowed_user_mentions=["U123"];g.display.mentioned_users=[{id:"U123",display_name:"Fixture User"}];f.setGrant(g);
 assert.equal(f.broker.create("allowed",{...intent,text:"Hello <@U123>"}).status,"created");
 const other=fixture(t);other.setGrant({...g,display:{...g.display,mentioned_users:[]}});assert.throws(()=>other.broker.create("bad",{...intent,text:"Hello <@U123>"}),ApprovalCreateError);
});

test("旧content keyが失効したduplicateを新規requestや通常conflictへ変換しない",t=>{
 const f=fixture(t);f.broker.create("first",intent);f.revoke();const before=f.anchors.calls.length;
 assert.throws(()=>f.broker.create("revoked",intent),ApprovalCreateError);assert.equal(f.anchors.calls.length,before);assert.equal(count(f,"approval_requests"),1);assert.equal(f.counts().activeCalls,1);
});

test("root欠落と非同期authority/key providerをallowへfallbackしない",t=>{
 const f=fixture(t,false);assert.throws(()=>f.broker.create("missing",intent),ApprovalCreateError);assert.equal(f.anchors.calls.length,0);
 assert.throws(()=>new ApprovalCreateBroker(f.db,f.providers,scope,(async()=>grant()) as unknown as ()=>ApprovalCreateGrant,f.lookup),ApprovalCreateError);
 assert.throws(()=>new ApprovalCreateBroker(f.db,f.providers,scope,()=>grant(),{...f.lookup,wrapping:(async()=>wrapping) as unknown as ()=>ApprovalPayloadKey}),ApprovalCreateError);
});

test("createのSQL/anchor障害で通知・payloadを部分commitせず受理不明を再送しない",t=>{
 for(const fault of ["sql","reserve_before","reserve_after","finalize_before","finalize_after"] as const){
  const f=fixture(t);
  if(fault==="sql"){
   const prepare=f.db.prepare.bind(f.db);f.db.prepare=((...args:Parameters<typeof f.db.prepare>)=>{if(args[0].startsWith("INSERT INTO main.approval_payload_secrets"))throw Error("fixture SQL failure");return prepare(...args);}) as typeof f.db.prepare;t.after(()=>{f.db.prepare=prepare;});
  }else f.anchors.fault=fault;
  assert.throws(()=>f.broker.create("failure",intent),ApprovalCreateError);const committed=fault.startsWith("finalize");
  assert.deepEqual([count(f,"approval_requests"),count(f,"approval_notifications"),count(f,"approval_payload_secrets")],committed?[1,2,1]:[0,0,0]);
  if(fault==="finalize_after"){
   const context={...scope,request_source:grant().snapshot.request_source};const record=f.records.readAlias({name:"request_creation",creation_key:approvalCreationKey(context)});assert.equal(record?.kind,"request");
  }
 }
});

test("model versionだけの変更は既存requestとassessmentを再生成しない",t=>{
 const f=fixture(t),first=f.broker.create("first",intent);if(first.status==="denied")throw Error();const g=grant();g.model_version="new_model";f.setGrant(g);
 assert.deepEqual(f.broker.create("model_only",intent),{...first,status:"reused"});assert.equal(f.records.read("request",first.request_handle)!.row.model_version,"fixture_model");
});

test("再open後もpending通知を保持しduplicateで別cardを作らない",t=>{
 const f=fixture(t),first=f.broker.create("first",intent);f.db.close();const db=openSecurityDatabase(f.filename);
 try{
  db.pragma("journal_mode=WAL");db.pragma("synchronous=FULL");db.pragma("foreign_keys=ON");installApprovalSchema(db);
  const broker=new ApprovalCreateBroker(db,f.providers,scope,()=>grant(),f.lookup);
  assert.deepEqual(broker.create("reopened",intent),{...first,status:"reused"});
  assert.deepEqual(db.prepare("SELECT state,count(*) AS n FROM approval_notifications GROUP BY state").all(),[{state:"pending",n:2}]);
 }finally{db.close();}
});

test("authority中のSQL writeは監査reserve前に拒否する",t=>{
 const f=fixture(t),before=f.anchors.calls.length;
 const broker=new ApprovalCreateBroker(f.db,f.providers,scope,()=>{
  f.db.prepare("INSERT INTO approval_payload_secrets VALUES('unauthorized','{}')").run();return grant();
 },f.lookup);
 assert.throws(()=>broker.create("bad_authority",intent),ApprovalCreateError);assert.equal(f.anchors.calls.length,before);assert.equal(count(f,"approval_requests"),0);
});


test("authorityは同じ監査stateで共有recordを読みcallback外へ持ち出せない",t=>{
 const f=fixture(t),first=f.broker.create("first",intent);if(first.status==="denied")throw Error();
 let captured:VerifiedAuditState|undefined;
 const broker=new ApprovalCreateBroker(f.db,f.providers,scope,(_intent,mark,state)=>{
  assertCurrentAuditReadState(f.db,state);captured=state;assert.equal(mark.transaction_id,"checked_authority");
  const prior=f.records.readAliasInState(state,{name:"request_creation",creation_key:approvalCreationKey({...scope,request_source:grant().snapshot.request_source})});
  assert.equal(prior?.kind,"request");if(prior?.kind!=="request")throw Error();assert.equal(prior.row.request_id,first.request_handle);
  return grant();
 },f.lookup);
 assert.deepEqual(broker.create("checked_authority",intent),{...first,status:"reused"});
 assert.ok(captured);assert.throws(()=>assertCurrentAuditReadState(f.db,captured!));
});
