import assert from "node:assert/strict";
import fs from "node:fs/promises";
import https from "node:https";
import http, { type IncomingMessage } from "node:http";
import test from "node:test";
import { createRequire } from "node:module";
import { createHmac } from "node:crypto";
import { DispatcherDatabase } from "../dispatcher/src/database.js";
import { WebJobReadBroker } from "../dispatcher/src/web/job-read-broker.js";
import { tempConfig } from "../dispatcher/test/helpers.js";
import { WebJobReadClient } from "../sources/web/src/job-read-client.js";
import { WebLoopbackTlsListener } from "../sources/web/src/tls-listener.js";
import { loginOidcFixture } from "../sources/web/test/login-oidc-fixture.js";
import { certificate, request, tlsPolicy, tlsProvider } from "../sources/web/test/tls-fixture.js";
import { fixture } from "./web-auth-fixture.js";
import { scope } from "../dispatcher/test/web/fixtures.js";
import { encodeWebAuthState } from "../dispatcher/src/web/model.js";
const Database=createRequire(import.meta.url)("../dispatcher/node_modules/better-sqlite3") as new(path:string)=>{
  pragma(value:string):unknown;prepare(sql:string):{run(...values:unknown[]):unknown};close():void};
function operatorGrant(socketPath:string,key:Uint8Array,payload:Record<string,unknown>){const encoded=Buffer.from(JSON.stringify(payload));
  return new Promise<{status:number;body:Record<string,unknown>}>((resolve,reject)=>{const request=http.request({socketPath,method:"POST",
    path:"/v1/admin/web-job-read-grants",agent:false,headers:{host:"dona-web-job-read-grants","content-type":"application/json",
      "content-length":String(encoded.length),connection:"close","x-dona-operator-proof":createHmac("sha256",key)
        .update("dona.web-job-read-grant.operator.v1\0").update(encoded).digest("base64url")}},response=>{const chunks:Buffer[]=[];response.on("data",chunk=>chunks.push(chunk));
      response.once("error",reject);response.once("end",()=>resolve({status:response.statusCode??0,body:JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown>}));});
    request.once("error",reject);request.end(encoded);});}

test("local operator grantは監査済みcurrent observerだけを許可しregistry不調後もrevokeできる",async t=>{
  const {root,config}=await tempConfig();t.after(()=>fs.rm(root,{recursive:true,force:true}));const jobs=new DispatcherDatabase(config.databasePath);t.after(()=>jobs.close());
  const raw=new Database(config.databasePath);raw.pragma("foreign_keys=ON");t.after(()=>raw.close());
  const created="2026-09-19T00:00:00.000Z",event=jobs.enqueue({schema_version:1,source:"web",external_event_id:"grant-integration",
    type:"web_job_submit",occurred_at:created,subject:{workspace_id:scope.tenant_id,actor_id:"principal",...scope,principal_id:"principal"},
    payload:{},reply_target:null} as never).row;
  const job=jobs.createJob({source_event_id:event.event_id,job_key:"grant",objective:"private",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
  const configured=await tlsPolicy(),operatorKey=Buffer.alloc(32,0x64);const f=await fixture(t,configured,
    {jobReads:repository=>new WebJobReadBroker(repository,jobs),grantOperatorKey:()=>operatorKey});
  const observer={codec_version:1 as const,...scope,principal_id:"observer",state:"active" as const,revoke_generation:1,
    identity_binding_revision:3,authz_revision:5,role_ids:["observer" as const],scopes:["job:read:granted" as const]};
  f.transaction.runPrepared("fixture_grant_observer",(_mark,verified)=>{const before=f.readState(),prior=encodeWebAuthState(before);
    assert.equal(verified.resource_bindings.find(binding=>binding.resource_id==="web_auth_state")?.resource_digest,prior.digest);
    const next=encodeWebAuthState({...before,principals:[...before.principals,observer].sort((a,b)=>a.principal_id.localeCompare(b.principal_id))});
    return{event:{scope,actor:{kind:"system" as const,id:"fixture_registry_seed"},action:"identity_change" as const,operation:"identity.change.v1" as const,
      resource_id:"web_auth_state",outcome:"succeeded" as const,reason:"none" as const,session_ref:null,receipt_id:null,attempt_id:null,
      policy_revision:1,binding_revision:3,authz_revision:5},resource_digest:next.digest,
      mutation:()=>{f.db.prepare("UPDATE web_auth_state SET state_json=? WHERE instance_id=? AND tenant_id=?").run(next.canonical,scope.instance_id,scope.tenant_id);return null;}};});
  const issue={schema_version:1,operation_id:"grant_runtime_issue",operation:"grant",job_id:job.job_id,expected_owner_principal_id:"principal",
    principal_id:"observer",principal_identity_binding_revision:3,principal_authz_revision:5,expected_grant_revision:0,
    expires_at:"2026-09-22T00:00:00.000Z"};
  await assert.rejects(operatorGrant(f.socket,Buffer.alloc(32,0x65),issue));
  const issued=await operatorGrant(f.socket,operatorKey,issue);assert.equal(issued.status,200);assert.equal(issued.body.outcome,"created");
  assert.equal((await operatorGrant(f.socket,operatorKey,issue)).body.outcome,"reused");
  const state=f.readState(),tampered=encodeWebAuthState({...state,principals:state.principals.map(row=>row.principal_id==="observer"?{...row,authz_revision:6}:row)});
  f.db.prepare("UPDATE web_auth_state SET state_json=? WHERE instance_id=? AND tenant_id=?").run(tampered.canonical,scope.instance_id,scope.tenant_id);
  await assert.rejects(operatorGrant(f.socket,operatorKey,{...issue,operation_id:"grant_runtime_regrant",expected_grant_revision:1,principal_authz_revision:6}));
  assert.equal((await operatorGrant(f.socket,operatorKey,issue)).body.outcome,"reused");
  const conflict=await operatorGrant(f.socket,operatorKey,{...issue,principal_authz_revision:6});assert.equal(conflict.status,409);
  assert.equal((conflict.body.error as Record<string,unknown>).code,"web_job_read_grant_idempotency_conflict");
  const revoked=await operatorGrant(f.socket,operatorKey,{...issue,operation_id:"grant_runtime_revoke",operation:"revoke",expected_grant_revision:1,expires_at:undefined});
  assert.equal(revoked.status,200);assert.equal(revoked.body.state,"revoked");assert.equal(revoked.body.grant_revision,2);
});

test("TLSからprincipal-scoped snapshotとSSE再接続へ収束しprivate fieldを返さない",async t=>{
  const {root,config}=await tempConfig();t.after(()=>fs.rm(root,{recursive:true,force:true}));const jobs=new DispatcherDatabase(config.databasePath);t.after(()=>jobs.close());
  const raw=new Database(config.databasePath);raw.pragma("foreign_keys=ON");t.after(()=>raw.close());
  const seed=(principal:string,id:string,created:string)=>{const eventId=`evt_${id}`;raw.prepare(`INSERT INTO events(event_id,schema_version,source,external_event_id,event_type,occurred_at,subject_json,payload_json,reply_target_json,status,available_at,completed_at,created_at,updated_at)
      VALUES(?,1,'web',?,'web_job_submit',?,?,'{}',NULL,'completed',?,?,?,?)`).run(eventId,id,created,JSON.stringify({instance_id:scope.instance_id,tenant_id:scope.tenant_id,principal_id:principal}),created,created,created,created);
    raw.prepare(`INSERT INTO jobs(job_id,source_event_id,job_key,source,workspace_id,actor_id,objective,workspace_json,status,attempt_count,available_at,workspace_path,result_path,agent_name,created_at,updated_at)
      VALUES(?,?,?,'web',?,?,'SECRET objective','{}','running',0,?,'/private/work','/private/result',?,?,?)`)
      .run(id,eventId,id,scope.tenant_id,principal,created,`agent-${id}`,created,created);return id;};
  const owned=seed("principal","job_owned","2026-09-19T00:00:00.000Z");seed("other","job_foreign","2026-09-19T00:00:01.000Z");
  const configured=await tlsPolicy();const f=await fixture(t,configured,{jobReads:repository=>new WebJobReadBroker(repository,jobs)});
  const policy=f.local.policy,client=new WebJobReadClient(f.socket,scope,()=>f.credential,f.lookup,f.local.now);
  const oidc=await loginOidcFixture(policy,f.local.now,f.local.token),connections={...f.connections,jobRead:client,
    oidc:{...oidc.connection,introspect:f.connections.oidc.introspect.bind(f.connections.oidc)}};
  const start=async()=>{const listener=new WebLoopbackTlsListener(policy,{connections,keys:{...f.local.keys,active:f.local.key},protectedNow:f.local.now,generation:1,tls:tlsProvider});await listener.start();return listener;};
  let listener=await start();t.after(()=>listener.close());const headers={cookie:"__Host-dona_session="+f.local.cookie,"sec-fetch-site":"same-origin"};
  const session=await request(policy,"/api/session","GET",headers);assert.equal(session.status,200,session.body);
  const list=await request(policy,"/api/jobs?limit=1","GET",headers);assert.equal(list.status,200,list.body);const listed=JSON.parse(list.body);
  assert.deepEqual(listed.items.map((item:{job_id:string})=>item.job_id),[owned]);assert.equal(list.body.includes("SECRET"),false);assert.equal(list.body.includes("/private"),false);
  const detail=await request(policy,`/api/jobs/${owned}`,"GET",headers);assert.equal(detail.status,200,detail.body);const snapshot=JSON.parse(detail.body);
  raw.prepare("UPDATE jobs SET status='completed',completed_at=?,result_json=?,updated_at=? WHERE job_id=?").run("2026-09-19T00:00:02.000Z",
    JSON.stringify({schema_version:1,job_id:owned,status:"completed",summary:"done",output:{format:"text",text:"PRIVATE"},artifacts:[{name:"report",kind:"report",path:"/private"}],completed_at:"2026-09-19T00:00:02.000Z"}),"2026-09-19T00:00:02.000Z",owned);
  await listener.close();listener=await start();
  const events=await request(policy,`/api/jobs/${owned}/events`,"GET",{...headers,"last-event-id":snapshot.event_cursor});assert.equal(events.status,200,events.body);
  assert.match(String(events.headers["content-type"]),/^text\/event-stream/);assert.match(events.body,/event: job/);assert.match(events.body,/"status":"completed"/);
  assert.equal(events.body.includes("PRIVATE"),false);assert.equal(events.body.includes("/private"),false);
  const next=/^id: ([A-Za-z0-9_-]{43})$/m.exec(events.body)?.[1];assert.ok(next);
  const replay=await request(policy,`/api/jobs/${owned}/events`,"GET",{...headers,"last-event-id":next!});assert.match(replay.body,/event: heartbeat/);
  const hidden=await request(policy,"/api/jobs/job_foreign","GET",headers);assert.equal(hidden.status,404);assert.deepEqual(JSON.parse(hidden.body),{error:"not_found"});
  const audited=(f.db.prepare("SELECT record_json FROM security_audit_records ORDER BY sequence").all() as Array<{record_json:string}>)
    .map(row=>(JSON.parse(row.record_json) as {event:{operation:string;resource_id:string;outcome:string;reason:string}}).event)
    .filter(event=>["web.job_list.v1","web.job_read.v1","web.sse_subscribe.v1"].includes(event.operation));
  assert.deepEqual(audited.map(event=>[event.operation,event.resource_id,event.outcome,event.reason]),[
    ["web.job_list.v1","web_jobs","succeeded","none"],["web.job_read.v1",owned,"succeeded","none"],
    ["web.sse_subscribe.v1",owned,"succeeded","none"],["web.sse_subscribe.v1",owned,"succeeded","none"],
    ["web.job_read.v1","job_foreign","denied","resource_not_visible"],
  ]);
  const artifacts=Array.from({length:32},(_,index)=>({name:`${"report".repeat(18)}-${index}`,kind:"report",media_type:`application/${"x".repeat(116)}`,size_bytes:index}));
  for(let index=0;index<49;index++){const id=seed("principal",`job_large_${index}`,`2026-09-19T00:${String(index+1).padStart(2,"0")}:00.000Z`);
    raw.prepare("UPDATE jobs SET status='completed',completed_at=?,result_json=?,updated_at=? WHERE job_id=?").run("2026-09-19T01:00:00.000Z",
      JSON.stringify({schema_version:1,job_id:id,status:"completed",summary:"\ud800".repeat(2000),artifacts,completed_at:"2026-09-19T01:00:00.000Z"}),"2026-09-19T01:00:00.000Z",id);}
  const maximum=await request(policy,"/api/jobs?limit=50","GET",headers);assert.equal(maximum.status,200,maximum.body.slice(0,200));assert.ok(Buffer.byteLength(maximum.body)>131072);
  const paused=await new Promise<IncomingMessage>((resolve,reject)=>{const pending=https.request({host:"127.0.0.1",port:Number(new URL(policy.origin).port),servername:"localhost",ca:certificate,
    agent:false,path:"/api/jobs?limit=50",headers:{host:new URL(policy.origin).host,...headers}},response=>{response.pause();resolve(response);});pending.once("error",reject);pending.end();});
  const slowStarted=Date.now(),disconnected=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("slow consumer was not disconnected")),12000);
    const resume=setTimeout(()=>paused.resume(),10500),done=()=>{clearTimeout(timer);clearTimeout(resume);resolve();};paused.once("end",done);paused.once("aborted",done);paused.socket.once("close",done);paused.socket.once("error",reject);});
  const whilePaused=await request(policy,`/api/jobs/${owned}`,"GET",headers);assert.equal(whilePaused.status,200);await disconnected;assert.ok(Date.now()-slowStarted>=9000);
  const afterSlow=await request(policy,`/api/jobs/${owned}`,"GET",headers);assert.equal(afterSlow.status,200);
  await f.gateway.close();const unavailable=await request(policy,"/api/jobs","GET",headers);assert.equal(unavailable.status,503);assert.deepEqual(JSON.parse(unavailable.body),{error:"identity_unavailable"});
});
