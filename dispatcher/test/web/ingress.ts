import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {WebAuthRepository} from "../../src/web/repository.js";
import {encodeWebAuthState} from "../../src/web/model.js";
import {openSecurityDatabase} from "../../src/audit/coordination.js";
import {prepareSessionIngress} from "../../src/web/ingress.js";
import type {ContextKey} from "../../src/web/context.js";
import {setup,scope,activeSession,wire} from "./fixtures.js";
const contexts=JSON.parse(fs.readFileSync(new URL("../../../test-fixtures/web-ingress-context-v1.json",import.meta.url),"utf8"));
const context=contexts.fixtures.find((row:{target:string})=>row.target==="/api/session");
const key:ContextKey={purpose:"web_ingress_context",version:1,state:"active",activated_at:"2026-09-01T00:00:00.000Z",signing_expires_at:"2026-11-01T00:00:00.000Z",secret:Buffer.alloc(32,contexts.key_byte)};
const lookup=(version:number)=>version===1?key:undefined;
test("current sessionと署名を照合しnonceを一回だけ監査へ確定する",t=>{
 const f=setup(t);activeSession(f);const store=new WebAuthRepository(f.db,f.providers,scope,lookup);
 const before=f.readState(),sequence=f.audit.verify().sequence;
 const result=store.verifySessionIngress("confirm",context.token,"GET","/api/session",Buffer.alloc(0));
 assert.equal(result.status,"succeeded");if(result.status!=="succeeded" || result.kind!=="session_verified")assert.fail();
 assert.equal(result.principal.principal_id,"principal");assert.equal(f.readState().used_nonces.length,1);
 assert.deepEqual(f.readState().sessions,before.sessions);assert.equal(f.audit.verify().sequence,sequence+1);
 const record=JSON.parse((f.db.prepare("SELECT record_json FROM security_audit_records WHERE transaction_id='confirm'").get() as {record_json:string}).record_json);
 assert.equal(record.codec_version,3);assert.equal(record.event.resource_id,"session");assert.equal(record.event.session_ref,"session");
 assert.equal(record.resource_commitments[0].resource_id,"web_auth_state");assert.equal(record.event.operation,"web.session.v1");
 assert.deepEqual(store.verifySessionIngress("replay",context.token,"GET","/api/session",Buffer.alloc(0)),{status:"denied",reason:"already_consumed"});
 assert.equal(f.readState().used_nonces.length,1);
 const replay=JSON.parse((f.db.prepare("SELECT record_json FROM security_audit_records WHERE transaction_id='replay'").get() as {record_json:string}).record_json);
 assert.deepEqual(replay.event.actor,{kind:"principal",id:"principal"});
 assert.ok(!JSON.stringify(f.readState()).includes(context.token));
 assert.ok(!JSON.stringify(f.db.prepare("SELECT record_json FROM security_audit_records").all()).includes(context.token));
});

test("metadataだけを過去へ戻しても外部anchorに結ばれたnonce消費を消せない",t=>{
 const f=setup(t);activeSession(f);const store=new WebAuthRepository(f.db,f.providers,scope,lookup);
 const old=encodeWebAuthState(f.readState()).canonical;
 assert.equal(store.verifySessionIngress("before_rollback",context.token,"GET","/api/session",Buffer.alloc(0)).status,"succeeded");
 const anchor=structuredClone(f.anchors.value),calls=f.anchors.calls.length;
 f.db.prepare("UPDATE web_auth_state SET state_json=?").run(old);
 assert.throws(()=>store.verifySessionIngress("after_rollback",context.token,"GET","/api/session",Buffer.alloc(0)));
 assert.deepEqual(f.anchors.value,anchor);assert.equal(f.anchors.calls.length,calls);
});
test("body・resource・署名・期限・current世代の不一致ではnonceを消費しない",t=>{
 for(const fault of ["body","resource","signature","expired","restart"]){
  const f=setup(t);activeSession(f);const store=new WebAuthRepository(f.db,f.providers,scope,lookup);
  if(fault==="expired")f.setNow("2026-09-19T00:00:11.000Z");
  if(fault==="restart")f.store.restart("restart");
  const token=fault==="signature"?context.token.slice(0,-1)+(context.token.endsWith("A")?"B":"A"):context.token;
  const result=store.verifySessionIngress("reject",token,"GET",fault==="resource"?"/api/jobs/job_2":"/api/session",fault==="body"?Buffer.from("x"):Buffer.alloc(0));
  assert.equal(result.status,"denied");assert.equal(f.readState().used_nonces.length,0);
 }
});
test("payload欠落・監査確定失敗では成功を返さず暗黙再送しない",t=>{
 for(const fault of ["payload_missing","reserve_after","finalize_before","finalize_after"] as const){
  const f=setup(t);activeSession(f);const store=new WebAuthRepository(f.db,f.providers,scope,lookup);
  if(fault==="payload_missing")f.db.exec("DELETE FROM web_auth_payloads");else f.anchors.fault=fault;
  const calls=f.anchors.calls.length;
  assert.throws(()=>store.verifySessionIngress("uncertain",context.token,"GET","/api/session",Buffer.alloc(0)));
  assert.equal(f.anchors.calls.length-calls,fault==="payload_missing"?0:fault==="reserve_after"?1:2);
  assert.equal(f.readState().used_nonces.length,fault.startsWith("finalize")?1:0);
 }
});
test("途中のmetadata SQL失敗はnonceと監査をrollbackする",t=>{
 const f=setup(t);activeSession(f);const store=new WebAuthRepository(f.db,f.providers,scope,lookup);
 const before=encodeWebAuthState(f.readState()).canonical,original=f.db.prepare.bind(f.db);
 t.mock.method(f.db,"prepare",((sql:string)=>{if(sql.startsWith("UPDATE web_auth_state"))throw Error("fixture metadata failure");return original(sql);}) as typeof f.db.prepare);
 assert.throws(()=>store.verifySessionIngress("sql_failed",context.token,"GET","/api/session",Buffer.alloc(0)));
 assert.equal(encodeWebAuthState(f.readState()).canonical,before);assert.equal(f.anchors.value.pending_transaction_id,"sql_failed");
});

test("別connectionも確定済みnonceを拒否しpollでidle期限を延長しない",t=>{
 const f=setup(t);activeSession(f);
 const first=new WebAuthRepository(f.db,f.providers,scope,lookup);
 const sessions=structuredClone(f.readState().sessions);
 assert.equal(first.verifySessionIngress("first_connection",context.token,"GET","/api/session",Buffer.alloc(0)).status,"succeeded");
 const other=openSecurityDatabase(f.filename);
 try {
  other.pragma("foreign_keys=ON");other.pragma("synchronous=FULL");
  const second=new WebAuthRepository(other,f.providers,scope,lookup);
  assert.deepEqual(second.verifySessionIngress("second_connection",context.token,"GET","/api/session",Buffer.alloc(0)),{status:"denied",reason:"already_consumed"});
  assert.deepEqual(f.readState().sessions,sessions);
 } finally {other.close();}
});

test("nonce保持数の上限を拒否し保護時刻で期限切れだけ除去する",t=>{
 const f=setup(t);activeSession(f);
 const state=f.readState();
 state.used_nonces=Array.from({length:2048},(_,i)=>({nonce_digest:i.toString(16).padStart(64,"0"),session_ref:"session",issued_at:contexts.now,expires_at:"2026-09-19T00:00:11.000Z"}));
 const full=prepareSessionIngress(state,context.token,"GET","/api/session",Buffer.alloc(0),contexts.now,lookup);
 assert.deepEqual(full.result,{status:"denied",reason:"quota_exceeded"});
 assert.equal(full.next.used_nonces.length,2048);
 state.used_nonces[0]={...state.used_nonces[0]!,issued_at:"2026-09-19T00:00:00.000Z",expires_at:contexts.now};
 const freed=prepareSessionIngress(state,context.token,"GET","/api/session",Buffer.alloc(0),contexts.now,lookup);
 assert.equal(freed.result.status,"succeeded");assert.equal(freed.next.used_nonces.length,2048);
 assert.ok(!freed.next.used_nonces.some(row=>row.nonce_digest==="0".repeat(64)));
 assert.throws(()=>prepareSessionIngress(state,context.token,"GET","/api/session",Buffer.alloc(0),"2026-09-19T00:00:00.000Z",lookup));
 assert.throws(()=>prepareSessionIngress(state,context.token,"GET","/api/session",Buffer.alloc(0),"invalid",lookup));
});

test("署名済みsession bindingから現行revision失効を分類し権限を付与しない",t=>{
 for(const change of ["state","revoke_generation","identity_binding_revision","authz_revision","bff_generation"] as const){
  const f=setup(t);activeSession(f);const state=f.readState();
  if(change==="state")state.principals[0]!.state="revoked";
  else if(change==="bff_generation")state.bff_generation++;
  else state.principals[0]![change]++;
  const plan=prepareSessionIngress(state,context.token,"GET","/api/session",Buffer.alloc(0),contexts.now,lookup);
  assert.deepEqual(plan.result,{status:"denied",reason:change==="identity_binding_revision" || change==="authz_revision"?"revision_mismatch":"session_revoked"});
  assert.equal(plan.next.used_nonces.length,0);
  const altered=context.token+"x";
  assert.deepEqual(prepareSessionIngress(state,altered,"GET","/api/session",Buffer.alloc(0),contexts.now,lookup).result,{status:"denied",reason:"proof_invalid"});
 }
});
