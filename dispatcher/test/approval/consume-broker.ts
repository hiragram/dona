import { openSecurityDatabase } from "../../src/audit/coordination.js";
import { installApprovalSchema } from "../../src/approval/schema.js";
import { ApprovalRecordRepository } from "../../src/approval/record-repository.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalConsumeBroker, ApprovalConsumeError, type ApprovalConsumeCommand, type ApprovalConsumeGrant } from "../../src/approval/consume-broker.js";
import { openApprovalPayload } from "../../src/approval/payload-protection.js";
import { decisionFixture } from "./fixtures/decision.js";
import { fixtureConsumeAuthority } from "./fixtures/consume-authority.js";
import { scope, content, wrapping, notification, body } from "./fixtures/broker.js";
function setup(t: {after(fn:()=>void):void}, approve=true) {
  const f=decisionFixture(t);
  if(approve) assert.equal(f.decision.decide("approve",f.command("approve")).status,"decided");
  const auth=fixtureConsumeAuthority(f.records);let override:((g:ApprovalConsumeGrant)=>ApprovalConsumeGrant)|null=null,rotated=false,revoked=false;
  const rotatedWrap={...wrapping,version:2,secret:Buffer.alloc(32,91)};
  const broker=new ApprovalConsumeBroker(f.db,f.providers,scope,(...args)=>{const grant=auth(...args);return override?override(grant):grant;},
    ()=>({...content,state:revoked?"revoked":rotated?"verification_only":"active"}),version=>version===null&&rotated?rotatedWrap:wrapping,()=>notification);
  const command:ApprovalConsumeCommand={request_handle:f.requestId,authority_ref:"fixture_consumer_connection",expected_revision:f.read().row.revision};
  const rows=(table:"approval_consumes"|"approval_execution_attempts"|"approval_payload_secrets")=>Number(f.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get());
  return {...f,consume:broker,consumeCommand:command,rows,rotate:()=>{rotated=true;},revoke:()=>{revoked=true;},rotatedWrap,setConsumeGrant:(fn:typeof override)=>{override=fn;}};
}

test("consumeは一つのledgerとclaimed attemptを作りpayloadを別DEKへ原子的に移す",t=>{
  const f=setup(t),old=f.payloads.inspect("request",f.requestId)!;assert.equal(old.secret.status,"present");
  f.setNow("2026-09-19T00:01:00.000Z");const result=f.consume.consume("consume",f.consumeCommand);assert.equal(result.status,"claimed");if(result.status!=="claimed")throw Error();
  assert.deepEqual(Object.keys(result).sort(),["attempt_handle","attempt_state","consume_handle","status"]);
  assert.equal(f.read().row.state,"consumed");assert.equal(f.read().row.revision,4);
  assert.deepEqual([f.rows("approval_consumes"),f.rows("approval_execution_attempts"),f.rows("approval_payload_secrets")],[1,1,1]);
  assert.equal(f.payloads.inspect("request",f.requestId)!.secret.status,"deleted");
  const saved=f.payloads.inspect("attempt",result.attempt_handle)!;if(saved.secret.status!=="present"||old.secret.status!=="present")throw Error();
  assert.equal(saved.metadata.consume_id,result.consume_handle);assert.notEqual(saved.secret.envelope.wrapped_key,old.secret.envelope.wrapped_key);
  assert.equal(openApprovalPayload(saved.secret.envelope,saved.metadata.binding,wrapping,content,f.marks.read()),body);
  assert.throws(()=>openApprovalPayload(saved.secret.envelope,old.metadata.binding,wrapping,content,f.marks.read()));
  const attempt=f.records.read("execution",result.attempt_handle)!;
  assert.equal(attempt.row.execution_expires_at,"2026-09-19T00:01:30.000Z");assert.equal(attempt.row.payload_expires_at,"2026-09-20T00:01:00.000Z");
  const text=JSON.stringify(f.db.prepare("SELECT record_json FROM security_audit_records").all());assert.equal(text.includes(body),false);
});

test("duplicate consumeは期限後も同じattemptを返し再暗号化と再claimをしない",t=>{
  const f=setup(t),first=f.consume.consume("first",f.consumeCommand);if(first.status!=="claimed")throw Error();
  const prior=f.payloads.inspect("attempt",first.attempt_handle);f.setNow("2026-09-19T00:06:00.000Z");
  assert.deepEqual(f.consume.consume("repeat",f.consumeCommand),{...first,status:"reused"});
  assert.deepEqual(f.payloads.inspect("attempt",first.attempt_handle),prior);assert.equal(f.rows("approval_execution_attempts"),1);
});

test("consumeとcancelの先着だけがapprovedを確定させる",t=>{
  const c=setup(t);c.decision.decide("cancel",c.command("cancel",3));assert.equal(c.consume.consume("late",c.consumeCommand).status,"denied");
  assert.equal(c.rows("approval_consumes"),0);assert.equal(c.rows("approval_payload_secrets"),0);
  const f=setup(t);const first=f.consume.consume("first",f.consumeCommand);assert.equal(first.status,"claimed");
  assert.deepEqual(f.decision.decide("late",f.command("cancel",4)),{status:"denied",reason:"decision_conflict"});
  assert.equal(f.read().row.state,"consumed");assert.equal(f.rows("approval_consumes"),1);
});

test("consumeの5分境界を延長せず直前claimの実行開始期限も上限内にする",t=>{
  const f=setup(t);f.setNow("2026-09-19T00:04:59.999Z");const result=f.consume.consume("edge",f.consumeCommand);if(result.status!=="claimed")throw Error();
  assert.equal(f.records.read("execution",result.attempt_handle)!.row.execution_expires_at,"2026-09-19T00:05:00.000Z");
  const expired=setup(t);expired.setNow("2026-09-19T00:05:00.000Z");
  assert.deepEqual(expired.consume.consume("expired",expired.consumeCommand),{status:"changed",request_state:"consume_expired"});
  assert.equal(expired.rows("approval_consumes"),0);assert.equal(expired.rows("approval_payload_secrets"),0);
});

test("未承認・違うscope/decision/eventとstale revisionはclaimせず状態不変",t=>{
  const unapproved=setup(t,false);assert.equal(unapproved.consume.consume("bad",unapproved.consumeCommand).status,"denied");
  for(const fault of ["scope","decision","event","revision","denied"] as const){
    const f=setup(t),before=f.read();f.setConsumeGrant(g=>{
      if(g.status!=="verified")throw Error();return fault==="denied"?{status:"denied",reason:"proof_invalid"}:{...g,
        ...(fault==="scope"?{scope:{...scope,workspace_id:"other"}}:{}),...(fault==="decision"?{decision_id:"other"}:{}),...(fault==="event"?{event_id:"other"}:{})};
    });
    const command=fault==="revision"?{...f.consumeCommand,expected_revision:2}:f.consumeCommand;
    assert.equal(f.consume.consume("bad",command).status,"denied");assert.deepEqual(f.read(),before);assert.equal(f.rows("approval_consumes"),0);
  }
});

test("current binding/policy/visibilityとsnapshot driftでは承認を無効化し本文を削除する",t=>{
  for(const fault of ["binding","policy","snapshot","authorization","visibility"] as const){
    const f=setup(t);f.setConsumeGrant(g=>{if(g.status!=="verified")throw Error();return {...g,
      ...(fault==="binding"?{binding_revision:4}:{}),...(fault==="policy"?{policy_revision:2}:{}),...(fault==="snapshot"?{semantic_hash:"b".repeat(64)}:{}),
      ...(fault==="authorization"?{requester_authorization_revision:8}:{}),...(fault==="visibility"?{stale_reason:"resource_not_visible" as const}:{})};});
    assert.deepEqual(f.consume.consume("stale",f.consumeCommand),{status:"changed",request_state:"needs_review"});
    assert.equal(f.rows("approval_consumes"),0);assert.equal(f.rows("approval_payload_secrets"),0);
  }
});

test("rotation後は旧content検証鍵と新wrapping鍵でimmutable snapshotの本文を移す",t=>{
  const f=setup(t);f.rotate();const before=f.read().row.snapshot_json,result=f.consume.consume("rotate",f.consumeCommand);if(result.status!=="claimed")throw Error();
  const payload=f.payloads.inspect("attempt",result.attempt_handle)!;if(payload.secret.status!=="present")throw Error();
  assert.equal(payload.secret.envelope.key_version,2);assert.equal(f.read().row.snapshot_json,before);assert.equal(payload.metadata.binding.content.key_version,1);
  assert.equal(openApprovalPayload(payload.secret.envelope,payload.metadata.binding,f.rotatedWrap,{...content,state:"verification_only"},f.marks.read()),body);
});

test("本文欠落・content key失効ではattemptを作らずneeds_reviewへする",t=>{
  for(const fault of ["missing","revoked"] as const){
    const f=setup(t);
    if(fault==="revoked")f.revoke();else{
      const trigger=f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='approval_payload_secret_delete_guard'").pluck().get() as string;
      f.db.exec("DROP TRIGGER approval_payload_secret_delete_guard");try{f.db.exec("DELETE FROM approval_payload_secrets");}finally{f.db.exec(trigger);}
    }
    assert.deepEqual(f.consume.consume("bad",f.consumeCommand),{status:"changed",request_state:"needs_review"});
    assert.equal(f.rows("approval_execution_attempts"),0);assert.equal(f.rows("approval_payload_secrets"),0);
  }
});

test("client actorと非同期authorityを拒否しSQL/anchor障害で移動を部分commitしない",t=>{
  const invalid=setup(t),before=invalid.anchors.calls.length;
  assert.throws(()=>invalid.consume.consume("client",{...invalid.consumeCommand,actor_id:"executor"} as unknown as ApprovalConsumeCommand),ApprovalConsumeError);
  assert.equal(invalid.anchors.calls.length,before);
  assert.throws(()=>new ApprovalConsumeBroker(invalid.db,invalid.providers,scope,(async()=>({status:"denied",reason:"unauthorized"})) as never,()=>content,()=>wrapping,()=>notification),ApprovalConsumeError);
  for(const fault of ["sql","reserve_before","reserve_after","finalize_before","finalize_after"] as const){
    const f=setup(t);
    if(fault==="sql"){
      const prepare=f.db.prepare.bind(f.db);f.db.prepare=((...args:Parameters<typeof f.db.prepare>)=>{if(args[0].startsWith("INSERT INTO main.approval_payload_secrets"))throw Error("fixture SQL failure");return prepare(...args);}) as typeof f.db.prepare;t.after(()=>{f.db.prepare=prepare;});
    }else f.anchors.fault=fault;
    assert.throws(()=>f.consume.consume("failed",f.consumeCommand),ApprovalConsumeError);
    const committed=fault.startsWith("finalize");assert.deepEqual([f.rows("approval_consumes"),f.rows("approval_execution_attempts"),f.rows("approval_payload_secrets")],committed?[1,1,1]:[0,0,1]);
    if(fault==="finalize_after")assert.equal(f.read().row.state,"consumed");
  }
});


test("再open後のconsumeも同じattemptへ収束しrequest payloadを復活させない",t=>{
  const f=setup(t),first=f.consume.consume("first",f.consumeCommand);if(first.status!=="claimed")throw Error();f.db.close();
  const db=openSecurityDatabase(f.filename);
  try{
    db.pragma("journal_mode=WAL");db.pragma("synchronous=FULL");db.pragma("foreign_keys=ON");installApprovalSchema(db);
    const records=new ApprovalRecordRepository(db,f.providers.auditAnchors,f.providers.auditKeys,scope);
    const broker=new ApprovalConsumeBroker(db,f.providers,scope,fixtureConsumeAuthority(records),()=>content,()=>wrapping,()=>notification);
    assert.deepEqual(broker.consume("reopened",f.consumeCommand),{...first,status:"reused"});
    assert.equal(db.prepare("SELECT count(*) FROM approval_execution_attempts").pluck().get(),1);
    assert.deepEqual(db.prepare("SELECT owner_kind,state FROM approval_payload_metadata ORDER BY owner_kind").all(),[{owner_kind:"attempt",state:"active"},{owner_kind:"request",state:"deleted"}]);
  }finally{db.close();}
});

test("consumeでも失効notification keyを拒否し旧検証鍵だけならclaimできる",t=>{
  const f=setup(t),before=f.anchors.calls.length,auth=fixtureConsumeAuthority(f.records);
  const revoked=new ApprovalConsumeBroker(f.db,f.providers,scope,auth,()=>content,()=>wrapping,()=>({...notification,state:"revoked"}));
  assert.throws(()=>revoked.consume("revoked_marker",f.consumeCommand),ApprovalConsumeError);
  assert.equal(f.anchors.calls.length,before);assert.equal(f.rows("approval_consumes"),0);assert.equal(f.read().row.state,"approved");
  const retained=new ApprovalConsumeBroker(f.db,f.providers,scope,auth,()=>content,()=>wrapping,()=>({...notification,state:"verification_only"}));
  assert.equal(retained.consume("retained_marker",f.consumeCommand).status,"claimed");
});
