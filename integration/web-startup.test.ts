import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { WebLoopbackStartup, WebStartupError, type WebStartupProviders } from "../sources/web/src/startup.js";
import { request, tlsPolicy, tlsProvider, wrongNameCertificate } from "../sources/web/test/tls-fixture.js";
import { fixtureSecret } from "../sources/web/test/fixtures.js";
import { fixture } from "./web-auth-fixture.js";

async function setup(t: TestContext) {
  const f=await fixture(t,await tlsPolicy()),policy={...f.local.policy,dispatcher_socket_path:f.socket};
  let idp=0;
  const providers:WebStartupProviders={keys:{...f.local.keys,active:f.local.key},protectedNow:f.local.now,
    serviceSigning:ref=>{assert.equal(ref,policy.service_credential_ref);return f.credential;},
    serviceVersion:(ref,version)=>{assert.equal(ref,policy.service_credential_ref);return f.lookup(version);},
    oidc:{clientSecret:ref=>{assert.equal(ref,policy.oidc.client_secret_ref);return fixtureSecret;}},tls:tlsProvider};
  const startup=new WebLoopbackStartup(policy,providers,{fetch:(async()=>{idp++;throw Error("startup must not call fixture IdP");}) as typeof fetch});
  t.after(()=>startup.close());
  const post=(target:string,cookie?:string,csrf?:string)=>request(policy,target,"POST",{
    "sec-fetch-site":"same-origin",origin:policy.origin,"content-type":"application/json",
    ...(cookie?{cookie}:{}),...(csrf?{"x-dona-csrf":csrf}:{})},"{}");
  return {...f,policy,providers,startup,post,idp:()=>idp};
}
test("起動前の監査失効と署名read-back後だけTLSを開き新世代loginへ接続する",async t=>{
  const f=await setup(t),sequence=f.audit.verify().sequence;
  await assert.rejects(request(f.policy,"/login"));await f.startup.start();
  const state=f.readState();assert.equal(state.bff_generation,2);assert.equal(f.audit.verify().sequence,sequence+1);
  assert.ok(state.sessions.every(row=>row.state.state==="revoked" && row.payload_ref===null && row.payload_digest===null));
  assert.equal(state.logins.length,0);assert.equal(state.consumed_logins.length,0);assert.equal(state.used_nonces.length,0);
  assert.equal((f.db.prepare("SELECT count(*) AS count FROM web_auth_payloads").get() as {count:number}).count,0);
  assert.equal((await request(f.policy,"/login")).status,200);
  const old=await request(f.policy,"/api/session","GET",{"sec-fetch-site":"same-origin",cookie:"__Host-dona_session="+f.local.cookie});
  assert.equal(old.status,401);assert.equal(f.idp(),0);
  const csrf=await f.post("/api/login/csrf");assert.equal(csrf.status,200,csrf.body);
  const cookie=csrf.headers["set-cookie"]![0]!.split(";",1)[0]!;
  const begin=await f.post("/api/login/start",cookie,JSON.parse(csrf.body).csrf_token);assert.equal(begin.status,200,begin.body);
  assert.equal(f.readState().logins[0]!.binding.bff_generation,2);
  await assert.rejects(f.startup.start(),WebStartupError);await f.startup.close();await assert.rejects(request(f.policy,"/login"));
});
test("鍵・inventory・OIDC設定・TLSが不完全ならsession失効write前に拒否する",async t=>{
  for(const fault of ["active_key","lookup_key","cookie_inventory","identity_inventory","registry_versions","context_key","client_secret","tls","service_scope"]){
    const f=await setup(t),sequence=f.audit.verify().sequence;
    if(fault==="active_key")f.providers.keys.active=purpose=>({...f.local.key(purpose),state:"revoked"});
    if(fault==="lookup_key")f.providers.keys.protection=(purpose,version)=>({...f.local.key(purpose),version,secret:Buffer.alloc(32,77)});
    if(fault==="cookie_inventory")f.providers.keys.cookies=()=>({retained_versions:[1,2],keys:[f.local.key("web_cookie_index")]});
    if(fault==="identity_inventory")f.providers.keys.identities=()=>({active_version:1,retained_versions:[1,2],keys:f.local.keys.identities().keys});
    if(fault==="registry_versions")f.providers.keys.identities=()=>({active_version:2,retained_versions:[1,2],keys:[
      {purpose:"web_identity_index",version:1,state:"lookup_only",secret:Buffer.alloc(32,8)},
      {purpose:"web_identity_index",version:2,state:"active",secret:Buffer.alloc(32,9)}]});
    if(fault==="client_secret")f.providers.oidc.clientSecret=()=>"invalid";
    if(fault==="context_key")f.providers.keys.context=()=>({...f.local.keys.context(),state:"revoked"});
    if(fault==="tls")f.providers.tls={...tlsProvider,certificate:()=>wrongNameCertificate};
    if(fault==="service_scope")f.providers.serviceSigning=()=>({...f.credential,tenant_id:"other"});
    await assert.rejects(f.startup.start(),WebStartupError);await assert.rejects(request(f.policy,"/login"));
    assert.equal(f.readState().bff_generation,1,fault);assert.equal(f.audit.verify().sequence,sequence,fault);assert.equal(f.idp(),0);
  }
});
test("restartのanchor不明ではlistenerを開かず同じ起動操作を再送しない",async t=>{
  for(const fault of ["reserve_before","reserve_after","finalize_before","finalize_after"] as const){
    const f=await setup(t);f.anchors.fault=fault;const calls=f.anchors.calls.length;
    await assert.rejects(f.startup.start(),WebStartupError);await assert.rejects(f.startup.start(),WebStartupError);
    await assert.rejects(request(f.policy,"/login"));assert.equal(f.anchors.calls.length-calls,fault.startsWith("finalize")?2:1);
    // Raw fixture inspection proves only SQL rollback/commit, not authenticated readiness.
    assert.equal(f.readState().bff_generation,fault.startsWith("finalize")?2:1);
  }
});
test("read-backまでに別のrestartが世代を進めたら旧起動を失敗させる",async t=>{
  const f=await setup(t),restart=f.repository.restart.bind(f.repository);let calls=0;
  t.mock.method(f.repository,"restart",(transaction:string,expected?:number)=>{
    calls++;const result=restart(transaction,expected);
    assert.equal(restart("fixture_competing_restart",2).status,"succeeded");return result;
  });
  await assert.rejects(f.startup.start(),WebStartupError);assert.equal(calls,1);assert.equal(f.readState().bff_generation,3);
  await assert.rejects(request(f.policy,"/login"));
});
test("restart送信中のcloseは受理済みwriteを取り消さずlistenerを開かない",async t=>{
  const f=await setup(t),sign=f.providers.serviceSigning;let calls=0,closing:Promise<void>|undefined;
  f.providers.serviceSigning=ref=>{calls++;if(calls===2)closing=f.startup.close();return sign(ref);};
  await assert.rejects(f.startup.start(),WebStartupError);await closing;
  assert.equal(calls,2);assert.equal(f.readState().bff_generation,2);await assert.rejects(request(f.policy,"/login"));
  assert.equal(f.startup.close(),f.startup.close());
});

test("起動中の保護clock巻戻り後は修復値へ戻しても同じ起動を再開しない",async t=>{
  const f=await setup(t),restart=f.repository.restart.bind(f.repository);let calls=0;
  t.mock.method(f.repository,"restart",(transaction:string,expected?:number)=>{
    calls++;const result=restart(transaction,expected);f.local.setNow("2026-09-19T00:00:00.000Z");return result;
  });
  await assert.rejects(f.startup.start(),WebStartupError);assert.equal(calls,1);
  f.local.setNow(f.local.initial);await assert.rejects(f.startup.start(),WebStartupError);
  assert.equal(f.readState().bff_generation,2);await assert.rejects(request(f.policy,"/login"));
});
