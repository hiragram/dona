import assert from "node:assert/strict";
import fs from "node:fs/promises";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { createRequire } from "node:module";
import { DispatcherDatabase } from "../dispatcher/src/database.js";
import { WebJobReadBroker } from "../dispatcher/src/web/job-read-broker.js";
import { tempConfig } from "../dispatcher/test/helpers.js";
import { WebJobReadClient } from "../sources/web/src/job-read-client.js";
import { WebLoopbackTlsListener } from "../sources/web/src/tls-listener.js";
import { loginOidcFixture } from "../sources/web/test/login-oidc-fixture.js";
import { certificate, request, tlsPolicy, tlsProvider } from "../sources/web/test/tls-fixture.js";
import { fixture } from "./web-auth-fixture.js";
import { scope } from "../dispatcher/test/web/fixtures.js";
const Database=createRequire(import.meta.url)("../dispatcher/node_modules/better-sqlite3") as new(path:string)=>{
  pragma(value:string):unknown;prepare(sql:string):{run(...values:unknown[]):unknown};close():void};

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
