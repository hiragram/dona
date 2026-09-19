import assert from "node:assert/strict";
import test from "node:test";
import {openSecurityDatabase} from "../../src/audit/coordination.js";
import {WebAuthRepository} from "../../src/web/repository.js";
import {encodeWebAuthState,encodeWebPayload,verifyWebPayload,webPayloadBinding,type StoredWebSession} from "../../src/web/model.js";
import {verifyWebAuthSchema,installWebAuthSchema} from "../../src/web/schema.js";
import {evaluateSession} from "../../src/web/domain.js";
import {restartWebAuthState,revokeWebPrincipal,pruneExpiredWebState} from "../../src/web/lifecycle.js";
import {setup,wire,scope,loginCookie,sessionCookie,activeSession} from "./fixtures.js";
import "./model.js";
const payloadCount=(f:ReturnType<typeof setup>)=>(f.db.prepare("SELECT count(*) AS n FROM web_auth_payloads").get() as {n:number}).n;

// Symbolic sealed bytes for repository atomicity tests only; actual BFF crypto
// interoperability is covered by the unchanged shared wire fixture test.
function replacementSession(){
 const session:StoredWebSession={...wire.session,state:{...wire.session.state,session_ref:"replacement"},cookie_digest:"b".repeat(64),payload_ref:"replacement_payload"};
 const payload={...wire.payload,payload_ref:session.payload_ref!,binding_digest:webPayloadBinding(session)};
 session.payload_digest=encodeWebPayload(payload).digest;
 return {session,payload};
}

test("再ログインは開始時のcookieへ結び旧sessionの失効とsecret削除を新規作成と同時に確定する",t=>{
 const f=setup(t);activeSession(f);
 assert.deepEqual(f.store.createLogin("missing_cookie_keys",wire.login,wire.login_payload,[]),{status:"denied",reason:"identity_unavailable"});
 assert.equal(f.store.createLogin("rotate_login",wire.login,wire.login_payload,[sessionCookie]).status,"succeeded");
 assert.equal(f.readState().logins[0]?.previous_session_ref,"session");
 f.store.consumeLogin("rotate_consume","login",loginCookie);
 assert.equal(f.readState().consumed_logins[0]?.previous_session_ref,"session");
 const pair=replacementSession();
 assert.equal(f.store.createSession("rotate_session","rotate_consume",[{key_version:1,digest:"a".repeat(64)}],pair.session,pair.payload).status,"succeeded");
 const old=f.store.lookupSession([sessionCookie]);assert.equal(old?.session.state.state,"revoked");assert.equal(old?.payload,null);
 assert.equal(f.store.lookupSession([{key_version:1,digest:pair.session.cookie_digest}])?.session.state.state,"active");
 assert.equal(payloadCount(f),1);assert.equal(f.readState().consumed_logins.length,0);
});
test("再ログインの新payload書込失敗では旧sessionもpayloadも失効せず監査を未確定で止める",t=>{
 const f=setup(t);activeSession(f);f.store.createLogin("rotate_login",wire.login,wire.login_payload,[sessionCookie]);
 f.store.consumeLogin("rotate_consume","login",loginCookie);const before=encodeWebAuthState(f.readState()).canonical;
 const original=f.db.prepare.bind(f.db);t.mock.method(f.db,"prepare",((sql:string)=>{
  if(sql.startsWith("INSERT INTO web_auth_payloads"))throw Error("fixture replacement failure");return original(sql);
 }) as typeof f.db.prepare);
 const pair=replacementSession();assert.throws(()=>f.store.createSession("rotate_fail","rotate_consume",[{key_version:1,digest:"a".repeat(64)}],pair.session,pair.payload));
 assert.equal(encodeWebAuthState(f.readState()).canonical,before);assert.equal(payloadCount(f),1);
 assert.equal(f.anchors.value.pending_transaction_id,"rotate_fail");assert.throws(()=>f.store.lookupSession([sessionCookie]));
});
test("idle・token・絶対期限ではsecretだけを消し絶対期限後24時間ちょうどでtombstoneを消す",t=>{
 for(const expiry of ["idle","token","absolute"] as const){
  const f=setup(t);activeSession(f);const state=f.readState();
  const session={...state.sessions[0]!,state:{...state.sessions[0]!.state}};
  if(expiry==="token")session.state.expires_at=session.state.access_token_expires_at="2026-09-19T00:10:01.000Z";
  const at=expiry==="idle"?"2026-09-19T00:30:01.000Z":expiry==="token"?"2026-09-19T00:10:01.000Z":session.state.expires_at;
  const expired=pruneExpiredWebState({...state,sessions:[session]},at);
  assert.equal(expired.sessions.length,1);assert.equal(expired.sessions[0]?.payload_ref,null);assert.equal(expired.sessions[0]?.state.state,"revoked");
  const tombstoneEnd=Date.parse(session.state.expires_at)+24*60*60*1000;
  assert.equal(pruneExpiredWebState(expired,new Date(tombstoneEnd-1).toISOString()).sessions.length,1);
  assert.equal(pruneExpiredWebState(expired,new Date(tombstoneEnd).toISOString()).sessions.length,0);
 }
 const f=setup(t);activeSession(f);f.setNow("2026-09-19T00:30:01.000Z");f.store.expire("idle_expiry");
 assert.equal(payloadCount(f),0);assert.equal(f.store.lookupSession([sessionCookie])?.session.state.state,"revoked");
});

test("初期化は空のmetadataだけを共通chainへ結び、重複を監査付きで拒否する",t=>{
 const f=setup(t);assert.equal(f.store.initialize("init").status,"succeeded");
 assert.deepEqual(f.store.initialize("duplicate"),{status:"denied",reason:"idempotency_conflict"});
 assert.deepEqual(f.readState().principals,[]);assert.deepEqual(f.readState().aliases,[]);assert.equal(payloadCount(f),0);
 assert.equal(f.audit.verify().sequence,2);
 assert.equal(f.audit.readVerifiedState(state=>state.resource_bindings[0])?.resource_digest,encodeWebAuthState(f.readState()).digest);
});
test("login消費はpayloadを削除し、再openと別connectionでも一回だけ成功する",t=>{
 const f=setup(t);f.store.initialize("init");f.store.createLogin("create",wire.login,wire.login_payload,null);
 const peer=openSecurityDatabase(f.filename);peer.pragma("foreign_keys=ON");peer.pragma("synchronous=FULL");
 try{
  const result=new WebAuthRepository(peer,f.providers,scope).consumeLogin("consume","login",loginCookie);
  if(result.status!=="succeeded" || result.kind!=="login_consumed")assert.fail();
  assert.deepEqual(result.payload,wire.login_payload);assert.equal(result.receipt_id,"consume");assert.equal(payloadCount(f),0);
  assert.deepEqual(f.store.consumeLogin("duplicate","login",loginCookie),{status:"denied",reason:"already_consumed"});
  assert.equal(f.readState().consumed_logins.length,1);assert.equal(f.readState().logins.length,0);
 }finally{peer.close();}
});
test("cookie不一致ではloginを消費せず、期限ちょうどで拒否し明示sweepでsecretを消す",t=>{
 const f=setup(t);f.store.initialize("init");f.store.createLogin("create",wire.login,wire.login_payload,null);
 assert.deepEqual(f.store.consumeLogin("wrong_cookie","login",{key_version:1,digest:"f".repeat(64)}),{status:"denied",reason:"cookie_invalid"});
 assert.equal(f.readState().logins.length,1);assert.equal(payloadCount(f),1);
 f.setNow(wire.login.binding.expires_at);assert.deepEqual(f.store.consumeLogin("expired","login",loginCookie),{status:"denied",reason:"expired"});
 f.store.expire("sweep");assert.equal(f.readState().logins.length,0);assert.equal(payloadCount(f),0);
});
test("sessionは消費receiptと全保持subject keyと単一principalへ結び再使用を拒否する",t=>{
 const f=setup(t);f.store.initialize("init");f.seedRegistry([1,2]);
 assert.deepEqual(f.store.createSession("no_receipt","none",[],wire.session,wire.payload),{status:"denied",reason:"already_consumed"});
 f.store.createLogin("login",wire.login,wire.login_payload,null);f.store.consumeLogin("consume","login",loginCookie);
 assert.deepEqual(f.store.createSession("missing_key","consume",[{key_version:1,digest:"a".repeat(64)}],wire.session,wire.payload),{status:"denied",reason:"identity_unavailable"});
 assert.deepEqual(f.store.createSession("wrong_subject","consume",[{key_version:1,digest:"b".repeat(64)},{key_version:2,digest:"b".repeat(64)}],wire.session,wire.payload),{status:"denied",reason:"identity_mismatch"});
 const candidates=[{key_version:1,digest:"a".repeat(64)},{key_version:2,digest:"a".repeat(64)}];
 assert.equal(f.store.createSession("session","consume",candidates,wire.session,wire.payload).status,"succeeded");
 assert.deepEqual(f.store.createSession("repeat_session","consume",candidates,wire.session,wire.payload),{status:"denied",reason:"already_consumed"});
 assert.equal(payloadCount(f),1);assert.deepEqual(f.store.lookupSession([sessionCookie])?.payload,wire.payload);assert.throws(()=>f.store.lookupSession([]));
 const records=f.db.prepare("SELECT record_json FROM security_audit_records").all() as Array<{record_json:string}>;
 const success=records.map(row=>JSON.parse(row.record_json)).find(row=>row.transaction_id==="session");
 assert.deepEqual(success.event.actor,{kind:"principal",id:"principal"});assert.equal(success.event.authz_revision,1);
});
test("local revokeはIdPに接続せずmetadataとpayloadを同時更新しreadbackで確認する",t=>{
 const f=setup(t);activeSession(f);
 assert.deepEqual(f.store.revokeSession("wrong_cookie","session",{key_version:1,digest:"a".repeat(64)}),{status:"denied",reason:"cookie_invalid"});
 assert.equal(payloadCount(f),1);assert.equal(f.store.revokeSession("logout","session",sessionCookie).status,"succeeded");
 const read=f.store.lookupSession([sessionCookie]);assert.equal(read?.session.state.state,"revoked");assert.equal(read?.payload,null);assert.equal(payloadCount(f),0);
 assert.equal(f.store.revokeSession("already_revoked","session",sessionCookie).status,"succeeded");
});
test("restart世代は旧sessionを失効させ保持indexを削除しない",t=>{
 const f=setup(t);activeSession(f);const old=f.readState();assert.equal(f.store.restart("restart").status,"succeeded");
 const state=f.readState();assert.equal(state.bff_generation,2);assert.deepEqual(state.aliases,old.aliases);assert.deepEqual(state.principals,old.principals);
 assert.equal(payloadCount(f),0);assert.equal(state.sessions[0]?.state.state,"revoked");assert.deepEqual(state.consumed_logins,[]);
 const read=f.store.lookupSession([sessionCookie])!;assert.equal(evaluateSession(read.principal,read.session.state,{...scope,bff_generation:read.bff_generation},wire.now).allowed,false);
});
test("署名済みrootと実metadataの旧値差替え・削除・cross-scopeを拒否する",t=>{
 const f=setup(t);f.store.initialize("init");const old=encodeWebAuthState(f.readState()).canonical;
 f.seedRegistry();f.store.createLogin("login",wire.login,wire.login_payload,null);const current=encodeWebAuthState(f.readState()).canonical;
 f.db.prepare("UPDATE web_auth_state SET state_json=?").run(old);const calls=f.anchors.calls.length;
 assert.throws(()=>f.store.lookupSession([sessionCookie]));assert.throws(()=>f.store.restart("tampered"));assert.equal(f.anchors.calls.length,calls);
 f.db.prepare("UPDATE web_auth_state SET state_json=?").run(current);
 assert.throws(()=>new WebAuthRepository(f.db,f.providers,{...scope,tenant_id:"other"}).lookupSession([sessionCookie]));
 f.db.exec("DELETE FROM web_auth_payloads; DELETE FROM web_auth_state");assert.throws(()=>f.store.lookupSession([sessionCookie]));
});
test("ciphertextの改変と欠落をmetadataの代用にせず予約前に拒否する",t=>{
 for(const missing of [false,true]){
  const f=setup(t);f.store.initialize("init");f.store.createLogin("login",wire.login,wire.login_payload,null);
  if(missing)f.db.exec("DELETE FROM web_auth_payloads");
  else f.db.prepare("UPDATE web_auth_payloads SET payload_json=?").run(encodeWebPayload({...wire.login_payload,envelope:{...wire.login_payload.envelope,ciphertext:Buffer.alloc(20,7).toString("base64url")}}).canonical);
  const calls=f.anchors.calls.length;assert.throws(()=>f.store.consumeLogin("consume","login",loginCookie));
  assert.equal(f.anchors.calls.length,calls);assert.equal(f.readState().logins.length,1);
 }
});
test("auditの予約失敗と確定応答喪失を成功に変換せず再送もしない",t=>{
 for(const fault of ["reserve_before","reserve_after","finalize_before","finalize_after"] as const){
  const f=setup(t);f.store.initialize("init");f.anchors.fault=fault;const calls=f.anchors.calls.length;
  assert.throws(()=>f.store.createLogin("create",wire.login,wire.login_payload,null));
  assert.equal(f.anchors.calls.length-calls,fault.startsWith("reserve")?1:2);assert.equal(payloadCount(f),fault.startsWith("reserve")?0:1);
  if(fault==="reserve_after" || fault==="finalize_before")assert.throws(()=>f.audit.verify());else assert.ok(f.audit.verify());
 }
});
test("session作成receiptは10秒境界で失効し古いloginからsessionを再作成しない",t=>{
 const f=setup(t);f.store.initialize("init");f.seedRegistry();f.store.createLogin("login",wire.login,wire.login_payload,null);f.store.consumeLogin("consume","login",loginCookie);
 f.setNow("2026-09-19T00:00:11.000Z");assert.deepEqual(f.store.createSession("late","consume",[{key_version:1,digest:"a".repeat(64)}],wire.session,wire.payload),{status:"denied",reason:"expired"});
 f.store.expire("expire");assert.deepEqual(f.readState().consumed_logins,[]);assert.equal(payloadCount(f),0);
});
test("秘密をauditとmetadataへ保存せず未知schemaとTEMP shadowを拒否する",t=>{
 const f=setup(t);activeSession(f);const text=JSON.stringify(f.readState())+JSON.stringify(f.db.prepare("SELECT record_json FROM security_audit_records").all());
 for(const secret of ["fixture-access-token",wire.payload.envelope.ciphertext,wire.login_payload.envelope.ciphertext])assert.ok(!text.includes(secret));
 assert.doesNotThrow(()=>installWebAuthSchema(f.db));f.db.exec("CREATE TEMP TABLE WEB_AUTH_STATE(instance_id,tenant_id,state_json)");
 assert.throws(()=>verifyWebAuthSchema(f.db));assert.throws(()=>f.store.lookupSession([sessionCookie]));
});
test("pure lifecycleはclock巻戻りと世代overflowを拒否しprincipalとaliasを保持する",t=>{
 const f=setup(t);activeSession(f);const state=f.readState();const revoked=revokeWebPrincipal(state,"principal",wire.now);
 assert.equal(revoked.principals[0]?.revoke_generation,2);assert.equal(revoked.sessions[0]?.payload_ref,null);
 assert.deepEqual(revoked.aliases,state.aliases);assert.deepEqual(revokeWebPrincipal(revoked,"principal",wire.now),revoked);
 const expired=pruneExpiredWebState(revoked,"2026-09-19T00:30:01.000Z");assert.equal(expired.sessions.length,1);assert.equal(expired.sessions[0]?.state.state,"revoked");assert.deepEqual(expired.aliases,state.aliases);
 assert.throws(()=>restartWebAuthState(state,"2026-09-18T23:59:59.000Z"));assert.throws(()=>restartWebAuthState({...state,bff_generation:Number.MAX_SAFE_INTEGER},wire.now));
});
test("BFFの固定fixtureをDispatcher codecで検証しwire契約を維持する",()=>{
 assert.deepEqual(verifyWebPayload(wire.payload,wire.session),wire.payload);assert.deepEqual(verifyWebPayload(wire.login_payload,wire.login),wire.login_payload);
 assert.equal(evaluateSession(wire.principal,wire.session.state,{...scope,bff_generation:1},wire.now).allowed,true);
 for(const entry of wire.session_cases)assert.deepEqual(evaluateSession({...wire.principal,...entry.principal},
  {...wire.session.state,...entry.session},{...scope,bff_generation:1,...entry.runtime},entry.now??wire.now),{allowed:false,reason:entry.reason});
});

test("payload insertが失敗したらmetadataとclock参照とauditをまとめてrollbackする",t=>{
 const f=setup(t);f.store.initialize("init");const original=f.db.prepare.bind(f.db);
 t.mock.method(f.db,"prepare",((sql:string)=>{
  if(sql.startsWith("INSERT INTO web_auth_payloads"))throw new Error("fixture payload write failure");
  return original(sql);
 }) as typeof f.db.prepare);
 assert.throws(()=>f.store.createLogin("failed_insert",wire.login,wire.login_payload,null));
 assert.deepEqual(f.readState().logins,[]);assert.equal(payloadCount(f),0);
 assert.equal(f.anchors.value.pending_transaction_id,"failed_insert");
 assert.equal((f.db.prepare("SELECT count(*) AS n FROM approval_clock_reservations").get() as {n:number}).n,1);
 assert.equal((f.db.prepare("SELECT count(*) AS n FROM security_audit_records").get() as {n:number}).n,1);
});
test("監査chainだけが正常でもWeb schemaの変更を許可しない",t=>{
 const f=setup(t);f.store.initialize("init");f.db.exec("ALTER TABLE web_auth_state ADD COLUMN unexpected TEXT");
 assert.equal(f.audit.verify().sequence,1);const calls=f.anchors.calls.length;
 assert.throws(()=>verifyWebAuthSchema(f.db));assert.throws(()=>installWebAuthSchema(f.db));
 assert.throws(()=>f.store.lookupSession([sessionCookie]));assert.throws(()=>f.store.restart("wrong_schema"));
 assert.equal(f.anchors.calls.length,calls);
});
