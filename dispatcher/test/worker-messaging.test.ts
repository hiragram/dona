import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { afterEach, describe, test } from "node:test";

import Database from "better-sqlite3";

import { DispatcherApi } from "../src/api.js";
import { DispatcherDatabase, migrateDispatcherDatabase } from "../src/database.js";
import { readEventJobBinding } from "../src/job-routing.js";
import type { Logger } from "../src/logger.js";
import { buildEventPrompt, envelopeFromRow } from "../src/prompt.js";
import { WorkerMessageError, WorkerMessagePublisher } from "../src/worker-messaging.js";
import { eventEnvelope, tempConfig } from "./helpers.js";

const roots: string[] = [];
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const jobs = { isRunning:()=>true, wake(){}, async steer(){throw new Error("unused");}, async cancel(){throw new Error("unused");} };

afterEach(async()=>{ await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true}))); });

async function fixture() {
  const {root,config}=await tempConfig(); roots.push(root);
  const database=new DispatcherDatabase(config.databasePath);
  const source=database.enqueue(eventEnvelope(`Ev-worker-message-${roots.length}`)).row;
  const job=database.createJob({source_event_id:source.event_id,job_key:"primary",objective:"worker message",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
  return {database,source,job,config};
}

function report(sourceEventId:string,sequence=1,key=`report-${sequence}`) {
  return {schema_version:1,source_event_id:sourceEventId,producer_sequence:sequence,idempotency_key:key,
    occurred_at:`2026-09-21T00:00:0${sequence}.000Z`,payload:{kind:"checkpoint",summary:`checkpoint ${sequence}`}};
}

describe("worker messaging ledger",()=>{
  test("strict contract、sequence、idempotency、terminal fenceを維持する",async()=>{
    const {database,source,job}=await fixture();
    try {
      assert.throws(()=>database.workerMessages.appendReport(job.job_id,{...report(source.event_id),unknown:true}),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="invalid_worker_message");
      assert.throws(()=>database.workerMessages.appendReport(job.job_id,{...report(source.event_id),occurred_at:"2026-02-31T00:00:00Z"}),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="invalid_worker_message");
      assert.throws(()=>database.workerMessages.appendReport(job.job_id,{...report(source.event_id),payload:{kind:"decision_request",question:"界".repeat(4_000),options:Array.from({length:8},()=>"界".repeat(1_000))}}),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_message_too_large");
      assert.throws(()=>database.workerMessages.appendReport(job.job_id,report(source.event_id,2)),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_message_sequence_gap");
      const created=database.workerMessages.appendReport(job.job_id,report(source.event_id),new Date("2026-09-21T00:01:00Z"));
      assert.equal(created.outcome,"created");
      const reused=database.workerMessages.appendReport(job.job_id,report(source.event_id),new Date("2026-09-21T00:02:00Z"));
      assert.equal(reused.outcome,"reused"); assert.equal(reused.message.message_id,created.message.message_id); assert.equal(reused.receipt_id,created.receipt_id);
      assert.throws(()=>database.workerMessages.appendReport(job.job_id,{...report(source.event_id),payload:{kind:"checkpoint",summary:"different"}}),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_message_idempotency_conflict");
      assert.throws(()=>database.workerMessages.appendReport(job.job_id,{...report(source.event_id),conversation_revision:1}),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_message_idempotency_conflict");
      assert.throws(()=>database.workerMessages.appendReport(job.job_id,{...report(source.event_id),correlation_message_id:"msg_00000000000000000000000000"}),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_message_idempotency_conflict");
      database.beginJobPreparation(job.job_id); database.setJobRuntime(job.job_id,"workspace","pane");
      database.beginJobDispatch(job.job_id); database.markJobRunning(job.job_id);
      database.saveJobResult(job.job_id,{schema_version:1,job_id:job.job_id,status:"completed",summary:"done",completed_at:"2026-09-21T00:03:00Z"},job.result_path);
      assert.throws(()=>database.workerMessages.appendReport(job.job_id,report(source.event_id,2)),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_message_terminal_fence");
      assert.equal(database.workerMessages.reconcile(job.job_id,source.event_id,"worker","report-1").reconciliation,"matched");
      assert.equal(database.workerMessages.reconcile(job.job_id,source.event_id,"worker","missing").reconciliation,"not_found");
    } finally { database.close(); }
  });

  test("report／instruction deliveryをlease・fence・receiptでrestart後も一意に処理する",async()=>{
    const {database,source,job,config}=await fixture();
    const first=database.workerMessages.appendReport(job.job_id,report(source.event_id),new Date("2026-09-21T00:00:10Z"));
    const instruction=database.workerMessages.appendInstruction(job.job_id,{schema_version:1,source_event_id:source.event_id,producer_sequence:1,
      idempotency_key:"instruction-1",occurred_at:"2026-09-21T00:00:11Z",correlation_message_id:first.message.message_id,
      conversation_revision:3,payload:{operation:"answer",text:"continue"}},new Date("2026-09-21T00:00:11Z"));
    const workerClaim=database.workerMessages.claim(job.job_id,source.event_id,"worker","runtime-1",1,10_000,new Date("2026-09-21T00:00:12Z"));
    assert.equal(workerClaim.length,1); assert.equal(workerClaim[0]!.delivery.message_id,instruction.message.message_id);
    assert.throws(()=>database.workerMessages.acknowledge(job.job_id,source.event_id,workerClaim[0]!.delivery.delivery_id,"runtime-1","wrong",workerClaim[0]!.delivery.fence,new Date("2026-09-21T00:00:13Z")),
      (error:unknown)=>error instanceof WorkerMessageError&&error.code==="delivery_fence_mismatch");
    const ack=database.workerMessages.acknowledge(job.job_id,source.event_id,workerClaim[0]!.delivery.delivery_id,"runtime-1",workerClaim[0]!.lease_token,workerClaim[0]!.delivery.fence,new Date("2026-09-21T00:00:13Z"));
    assert.equal(ack.outcome,"delivered");
    const replay=database.workerMessages.acknowledge(job.job_id,source.event_id,workerClaim[0]!.delivery.delivery_id,"runtime-1",workerClaim[0]!.lease_token,workerClaim[0]!.delivery.fence,new Date("2026-09-21T00:00:14Z"));
    assert.equal(replay.outcome,"reused");
    assert.throws(()=>database.workerMessages.acknowledge(job.job_id,source.event_id,workerClaim[0]!.delivery.delivery_id,"runtime-2",workerClaim[0]!.lease_token,workerClaim[0]!.delivery.fence,new Date("2026-09-21T00:00:14Z")),
      (error:unknown)=>error instanceof WorkerMessageError&&error.code==="delivery_fence_mismatch");
    database.workerMessages.appendInstruction(job.job_id,{schema_version:1,source_event_id:source.event_id,producer_sequence:2,
      idempotency_key:"instruction-expiry",occurred_at:"2026-09-21T00:00:15Z",payload:{operation:"answer",text:"境界"}},new Date("2026-09-21T00:00:15Z"));
    const expiryClaim=database.workerMessages.claim(job.job_id,source.event_id,"worker","runtime-1",1,1_000,new Date("2026-09-21T00:00:15Z"));
    assert.throws(()=>database.workerMessages.acknowledge(job.job_id,source.event_id,expiryClaim[0]!.delivery.delivery_id,"runtime-1",expiryClaim[0]!.lease_token,expiryClaim[0]!.delivery.fence,new Date("2026-09-21T00:00:16Z")),
      (error:unknown)=>error instanceof WorkerMessageError&&error.code==="delivery_fence_mismatch");
    database.close();

    const restarted=new DispatcherDatabase(config.databasePath);
    try {
      const reconciled=restarted.workerMessages.reconcile(job.job_id,source.event_id,"dona-main","instruction-1");
      assert.equal(reconciled.reconciliation,"matched");
      assert.equal((reconciled as {delivery:{state:string}}).delivery.state,"delivered");
      const reportClaim=restarted.workerMessages.claim(job.job_id,source.event_id,"dona-main","dona-main-1",1,1_000,new Date("2026-09-21T00:00:12Z"));
      assert.equal(reportClaim.length,1);
      const fence=reportClaim[0]!.delivery.fence;
      const reclaimed=restarted.workerMessages.claim(job.job_id,source.event_id,"dona-main","dona-main-2",1,1_000,new Date("2026-09-21T00:00:14Z"));
      assert.equal(reclaimed.length,1); assert.equal(reclaimed[0]!.delivery.fence,fence+1);
      assert.throws(()=>restarted.workerMessages.acknowledge(job.job_id,source.event_id,reclaimed[0]!.delivery.delivery_id,"dona-main-1",reportClaim[0]!.lease_token,fence,new Date("2026-09-21T00:00:14Z")),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="delivery_fence_mismatch");
    } finally { restarted.close(); }
  });

  test("同時刻のinstructionをproducer sequence順にclaimする",async()=>{
    const {database,source,job}=await fixture();
    try {
      const at=new Date("2026-09-21T00:00:10Z");
      for(const sequence of [1,2]) database.workerMessages.appendInstruction(job.job_id,{schema_version:1,source_event_id:source.event_id,
        producer_sequence:sequence,idempotency_key:`ordered-${sequence}`,occurred_at:`2026-09-21T00:00:0${sequence}Z`,
        payload:{operation:"add_condition",text:`condition ${sequence}`}},at);
      const claimed=database.workerMessages.claim(job.job_id,source.event_id,"worker","runtime-ordered",2,10_000,new Date("2026-09-21T00:00:11Z"));
      assert.deepEqual(claimed.map(value=>value.delivery.producer_sequence),[1,2]);
    } finally { database.close(); }
  });

  test("宛先のないreportはdeliveryをpendingに保つ",async()=>{
    const {database,source,job,config}=await fixture();
    try {
      const sqlite=new Database(config.databasePath);
      sqlite.prepare("UPDATE jobs SET workspace_id=NULL,channel_id=NULL,thread_ts=NULL WHERE job_id=?").run(job.job_id);
      sqlite.close();
      const created=database.workerMessages.appendReport(job.job_id,report(source.event_id),new Date("2026-09-21T00:00:10Z"));
      assert.equal(database.workerMessages.publishPendingReports(100,new Date("2026-09-21T00:00:11Z")),0);
      assert.equal((database.workerMessages.reconcile(job.job_id,source.event_id,"worker","report-1") as {delivery:{state:string}}).delivery.state,"pending");
      assert.equal(database.getByExternalId("dona_message",`worker-message:${created.message.message_id}`),undefined);
    } finally { database.close(); }
  });

  test("terminal遷移でworker向けpending／leased deliveryをsupersededにする",async()=>{
    const {database,source,job}=await fixture();
    try {
      for(const sequence of [1,2]) database.workerMessages.appendInstruction(job.job_id,{schema_version:1,source_event_id:source.event_id,
        producer_sequence:sequence,idempotency_key:`terminal-${sequence}`,occurred_at:`2026-09-21T00:00:0${sequence}Z`,
        payload:{operation:"answer",text:`answer ${sequence}`}},new Date(`2026-09-21T00:00:0${sequence}Z`));
      database.workerMessages.claim(job.job_id,source.event_id,"worker","runtime-terminal",1,10_000,new Date("2026-09-21T00:00:03Z"));
      database.beginJobPreparation(job.job_id); database.setJobRuntime(job.job_id,"workspace","pane");
      database.beginJobDispatch(job.job_id); database.markJobRunning(job.job_id);
      database.saveJobResult(job.job_id,{schema_version:1,job_id:job.job_id,status:"completed",summary:"done",completed_at:"2026-09-21T00:00:04Z"},job.result_path);
      const states=[1,2].map(sequence=>(database.workerMessages.reconcile(job.job_id,source.event_id,"dona-main",`terminal-${sequence}`) as {delivery:{state:string}}).delivery.state);
      assert.deepEqual(states,["superseded","superseded"]);
      assert.equal(database.workerMessages.operationalSnapshot().degraded,false);
    } finally { database.close(); }
  });

  test("coalescing、silence deadline、retentionをdurable stateとして保持する",async()=>{
    const {database,source,job,config}=await fixture();
    try {
      const one=database.workerMessages.appendReport(job.job_id,report(source.event_id,1),new Date("2026-07-01T00:00:00Z"));
      const two=database.workerMessages.appendReport(job.job_id,report(source.event_id,2),new Date("2026-07-01T00:00:01Z"));
      assert.equal(database.workerMessages.operationalSnapshot(new Date("2026-07-01T00:20:00Z")).due_silence_deadlines,1);
      assert.equal(database.workerMessages.publishDueSilenceEvents(100,new Date("2026-07-01T00:20:00Z")),1);
      assert.equal(database.workerMessages.publishDueSilenceEvents(100,new Date("2026-07-01T00:40:00Z")),0);
      database.close();
      const sqlite=new Database(config.databasePath);
      const rows=sqlite.prepare("SELECT message_id,state FROM worker_message_deliveries ORDER BY created_at").all() as Array<{message_id:string;state:string}>;
      assert.deepEqual(rows,[{message_id:one.message.message_id,state:"superseded"},{message_id:two.message.message_id,state:"pending"}]);
      sqlite.close();
      const reopened=new DispatcherDatabase(config.databasePath);
      const claimed=reopened.workerMessages.claim(job.job_id,source.event_id,"dona-main","consumer",1,10_000,new Date("2026-07-01T00:02:00Z"));
      assert.equal(claimed[0]!.delivery.message_id,two.message.message_id);
      reopened.workerMessages.acknowledge(job.job_id,source.event_id,claimed[0]!.delivery.delivery_id,"consumer",claimed[0]!.lease_token,
        claimed[0]!.delivery.fence,new Date("2026-07-01T00:02:01Z"));
      reopened.beginJobPreparation(job.job_id); reopened.setJobRuntime(job.job_id,"workspace","pane");
      reopened.beginJobDispatch(job.job_id); reopened.markJobRunning(job.job_id);
      reopened.saveJobResult(job.job_id,{schema_version:1,job_id:job.job_id,status:"completed",summary:"done",completed_at:"2026-07-01T00:03:00Z"},job.result_path);
      const sqliteAfterTerminal=new Database(config.databasePath);
      sqliteAfterTerminal.prepare("UPDATE worker_message_cadence SET pending_message_id=? WHERE job_id=?").run(one.message.message_id,job.job_id);
      sqliteAfterTerminal.close();
      const publisher=new WorkerMessagePublisher(reopened.workerMessages,()=>{});
      publisher.runOnce(new Date("2026-08-02T00:00:00Z"));
      const sqliteAfterPurge=new Database(config.databasePath);
      assert.equal((sqliteAfterPurge.prepare("SELECT COUNT(*) AS count FROM worker_messages").get() as {count:number}).count,0);
      assert.equal((sqliteAfterPurge.prepare("SELECT pending_message_id FROM worker_message_cadence WHERE job_id=?").get(job.job_id) as {pending_message_id:string|null}).pending_message_id,null);
      sqliteAfterPurge.close();
      reopened.close();
    } finally { try { database.close(); } catch {} }
  });

  test("retentionは存続する相関messageの親を削除しない",async()=>{
    const {database,source,job}=await fixture();
    try {
      const parent=database.workerMessages.appendReport(job.job_id,report(source.event_id),new Date("2026-07-01T00:00:00Z"));
      database.workerMessages.appendInstruction(job.job_id,{schema_version:1,source_event_id:source.event_id,producer_sequence:1,
        idempotency_key:"instruction-retained",occurred_at:"2026-07-20T00:00:00Z",correlation_message_id:parent.message.message_id,
        conversation_revision:1,payload:{operation:"answer",text:"継続"}},new Date("2026-07-20T00:00:00Z"));
      database.beginJobPreparation(job.job_id); database.setJobRuntime(job.job_id,"workspace","pane");
      database.beginJobDispatch(job.job_id); database.markJobRunning(job.job_id);
      database.saveJobResult(job.job_id,{schema_version:1,job_id:job.job_id,status:"completed",summary:"done",completed_at:"2026-07-20T00:01:00Z"},job.result_path);
      assert.equal(database.workerMessages.publishPendingReports(100,new Date("2026-07-20T00:01:00Z")),0);
      assert.equal(database.workerMessages.purge(new Date("2026-08-02T00:00:00Z")),0);
      assert.equal(database.workerMessages.reconcile(job.job_id,source.event_id,"worker","report-1").reconciliation,"matched");
    } finally { database.close(); }
  });

  test("緊急reportは後続の通常reportでcoalescingされない",async()=>{
    const {database,source,job}=await fixture();
    try {
      const first=database.workerMessages.appendReport(job.job_id,report(source.event_id,1),new Date("2026-09-21T00:00:01Z"));
      const urgent=database.workerMessages.appendReport(job.job_id,{schema_version:1,source_event_id:source.event_id,producer_sequence:2,
        idempotency_key:"urgent-2",occurred_at:"2026-09-21T00:00:02.000Z",payload:{kind:"question",question:"確認が必要です"}},new Date("2026-09-21T00:00:02Z"));
      const latest=database.workerMessages.appendReport(job.job_id,report(source.event_id,3),new Date("2026-09-21T00:00:03Z"));
      const states=[first,urgent,latest].map(value=>(database.workerMessages.reconcile(job.job_id,source.event_id,"worker",value.message.idempotency_key) as {delivery:{state:string}}).delivery.state);
      assert.deepEqual(states,["superseded","pending","pending"]);
    } finally {database.close();}
  });

  test("workspace frequencyは同時にdueとなった別jobも直列化する",async()=>{
    const {database,source,job,config}=await fixture();
    try {
      const second=database.createJob({source_event_id:source.event_id,job_key:"second",objective:"second worker message",workspace:{kind:"scratch"}},
        config.jobsWorkspaceRoot,config.jobResultsDir).row;
      const at=new Date("2026-09-21T00:00:10Z");
      database.workerMessages.appendReport(job.job_id,report(source.event_id),at);
      database.workerMessages.appendReport(second.job_id,report(source.event_id),at);
      assert.equal(database.workerMessages.publishPendingReports(100,at),1);
      const deliveries=[database.workerMessages.reconcile(job.job_id,source.event_id,"worker","report-1"),
        database.workerMessages.reconcile(second.job_id,source.event_id,"worker","report-1")]
        .map(value=>(value as {delivery:{state:string;available_at:string}}).delivery);
      assert.deepEqual(deliveries.map(value=>value.state).sort(),["delivered","pending"]);
      assert.equal(deliveries.find(value=>value.state==="pending")?.available_at,"2026-09-21T00:01:10.000Z");
      assert.equal(database.workerMessages.publishPendingReports(100,new Date("2026-09-21T00:01:10Z")),1);
    } finally {database.close();}
  });
});

test("schema v2 bridgeのledgerをjobs v3再構築後も保全する",async()=>{
  const {root,config}=await tempConfig(); roots.push(root);
  const v2=new Database(config.databasePath);
  v2.pragma("foreign_keys = ON");
  migrateDispatcherDatabase(v2,()=>{},false,2);
  v2.close();
  const bridge=new DispatcherDatabase(config.databasePath);
  const source=bridge.enqueue(eventEnvelope("Ev-worker-message-v2-preservation")).row;
  const job=bridge.createJob({source_event_id:source.event_id,objective:"worker message",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
  const created=bridge.workerMessages.appendReport(job.job_id,report(source.event_id),new Date("2026-09-21T00:00:00Z"));
  bridge.close();

  const activation=new Database(config.databasePath);
  activation.pragma("foreign_keys = ON");
  migrateDispatcherDatabase(activation,()=>{},false,3);
  assert.deepEqual(activation.pragma("foreign_key_check"),[]);
  activation.close();

  const reopened=new DispatcherDatabase(config.databasePath);
  try {
    const reconciled=reopened.workerMessages.reconcile(job.job_id,source.event_id,"worker","report-1");
    assert.equal(reconciled.reconciliation,"matched");
    assert.equal((reconciled as {message:{message_id:string}}).message.message_id,created.message.message_id);
  } finally {reopened.close();}
});

function request(socketPath:string,method:string,route:string,body?:unknown) {
  const encoded=body===undefined?undefined:Buffer.from(JSON.stringify(body));
  return new Promise<{status:number;body:Record<string,unknown>}>((resolve,reject)=>{
    const req=http.request({socketPath,method,path:route,headers:encoded?{"content-type":"application/json","content-length":String(encoded.length)}:undefined},response=>{
      const chunks:Buffer[]=[];response.on("data",(chunk:Buffer)=>chunks.push(chunk));response.on("end",()=>resolve({status:response.statusCode??0,body:JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string,unknown>}));
    });req.once("error",reject);req.end(encoded);
  });
}

test("APIはbinding済みmessageだけをboundedにwrite/read/reconcileする",async()=>{
  const {database,source,job,config}=await fixture();
  const api=new DispatcherApi(database,{isRunning:()=>true,wake(){}},jobs,config,logger); await api.start();
  try {
    const created=await request(config.socketPath,"POST",`/v1/jobs/${job.job_id}/messages/reports`,report(source.event_id));
    assert.equal(created.status,202);
    const messageId=((created.body.message as Record<string,unknown>).message_id as string);
    const internal=database.getByExternalId("dona_message",`worker-message:${messageId}`);
    assert.ok(internal); assert.equal(internal.event_type,"worker_message_report");
    assert.equal(envelopeFromRow(internal).source,"dona_message");
    const prompt=buildEventPrompt(internal.event_id,"/tmp/result.json",envelopeFromRow(internal));
    assert.match(prompt,/通常Slack messageの宛先判定を適用せず必ず処理対象/);
    assert.match(prompt,/get_worker_messageへsource_event_idとして現在のevent_id/);
    assert.match(prompt,/questionまたはdecision_request.*suspended/);
    const sqlite=new Database(config.databasePath);
    assert.deepEqual(readEventJobBinding(sqlite,internal.event_id)?.owner,readEventJobBinding(sqlite,source.event_id)?.owner);
    sqlite.close();
    assert.deepEqual(JSON.parse(internal.payload_json),{schema_version:1,message_id:messageId,job_id:job.job_id,source_event_id:source.event_id,kind:"checkpoint"});
    assert.doesNotMatch(internal.payload_json,/checkpoint 1/);
    const read=await request(config.socketPath,"GET",`/v1/jobs/${job.job_id}/messages/${messageId}?source_event_id=${source.event_id}`);
    assert.equal(read.status,200); assert.equal(((read.body.message as {payload:{kind:string}}).payload.kind),"checkpoint");
    const reconcile=await request(config.socketPath,"GET",`/v1/jobs/${job.job_id}/messages/reconcile?source_event_id=${source.event_id}&producer=worker&idempotency_key=report-1`);
    assert.equal(reconcile.status,200); assert.equal(reconcile.body.reconciliation,"matched");
    const forbiddenClaim=await request(config.socketPath,"POST",`/v1/jobs/${job.job_id}/messages/deliveries/claim`,{
      source_event_id:source.event_id,consumer:"dona-main",lease_owner:"worker-bridge",limit:1,lease_ms:10_000});
    assert.equal(forbiddenClaim.status,400);
    const direct=database.workerMessages.appendReport(job.job_id,report(source.event_id,2,"report-api-2"),new Date());
    const claimed=database.workerMessages.claim(job.job_id,source.event_id,"dona-main","internal-publisher",1,10_000,new Date(Date.now()+61_000));
    assert.equal(claimed[0]!.delivery.message_id,direct.message.message_id);
    const forbiddenAck=await request(config.socketPath,"POST",`/v1/jobs/${job.job_id}/messages/deliveries/${claimed[0]!.delivery.delivery_id}/ack`,{
      source_event_id:source.event_id,lease_owner:"internal-publisher",lease_token:claimed[0]!.lease_token,fence:claimed[0]!.delivery.fence});
    assert.equal(forbiddenAck.status,409);
    const health=await request(config.socketPath,"GET","/health/ready");
    assert.equal((health.body.worker_messaging as {protocol_version:number}).protocol_version,1);
  } finally { await api.stop(); database.close(); }
});

test("同じownerのfollow-up eventだけがinstructionとreadを認可される",async()=>{
  const {database,source,job}=await fixture();
  try {
    const followup=database.enqueue(eventEnvelope(`Ev-worker-followup-${roots.length}`)).row;
    const foreignEnvelope=eventEnvelope(`Ev-worker-foreign-${roots.length}`);
    foreignEnvelope.reply_target={...foreignEnvelope.reply_target!,thread_ts:"1756722030.654321"};
    foreignEnvelope.subject={...foreignEnvelope.subject,thread_ts:"1756722030.654321"};
    const foreign=database.enqueue(foreignEnvelope).row;
    const instruction=database.workerMessages.appendInstruction(job.job_id,{schema_version:1,source_event_id:followup.event_id,producer_sequence:1,
      idempotency_key:"followup-1",occurred_at:"2026-09-21T00:00:01Z",payload:{operation:"add_condition",text:"安全境界を維持"}});
    assert.equal(instruction.message.source_event_id,followup.event_id);
    assert.ok(database.workerMessages.getMessage(job.job_id,instruction.message.message_id,followup.event_id));
    assert.throws(()=>database.workerMessages.getMessage(job.job_id,instruction.message.message_id,foreign.event_id),
      (error:unknown)=>error instanceof WorkerMessageError&&error.code==="job_binding_mismatch");
  } finally {database.close();}
});

test("既存DBへのadditive migrationはrow・user_version・FKを保持する",async()=>{
  const {database,source,job,config}=await fixture();
  database.close();
  const legacy=new Database(config.databasePath);
  const version=legacy.pragma("user_version",{simple:true}) as number;
  legacy.exec(`DROP TABLE worker_message_workspace_cadence; DROP TABLE worker_message_cadence; DROP TABLE worker_message_receipts;
    DROP TABLE worker_message_deliveries; DROP TABLE worker_messages;`);
  legacy.close();
  const upgraded=new DispatcherDatabase(config.databasePath);
  try {
    assert.equal(upgraded.get(source.event_id)?.event_id,source.event_id);
    assert.equal(upgraded.getJob(job.job_id)?.job_id,job.job_id);
    const sqlite=new Database(config.databasePath);
    assert.equal(sqlite.pragma("user_version",{simple:true}),version);
    assert.deepEqual(sqlite.pragma("foreign_key_check"),[]);
    assert.ok(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_messages'").get());
    sqlite.close();
  } finally {upgraded.close();}
});

test("DB busyではcommitせずread-only reconcileがnot_foundを返す",async()=>{
  const {database,source,job,config}=await fixture();
  const lock=new Database(config.databasePath); lock.pragma("busy_timeout=1"); lock.exec("BEGIN EXCLUSIVE");
  try {
    assert.throws(()=>database.workerMessages.appendReport(job.job_id,report(source.event_id)),/locked|busy/i);
  } finally {lock.exec("ROLLBACK");lock.close();}
  try {assert.equal(database.workerMessages.reconcile(job.job_id,source.event_id,"worker","report-1").reconciliation,"not_found");}
  finally {database.close();}
});

test("report delivery障害をaccepted messageと独立したdegraded stateに隔離する",async()=>{
  const {database,source,job,config}=await fixture();
  const sqlite=new Database(config.databasePath);
  sqlite.exec(`CREATE TRIGGER fail_worker_message_event BEFORE INSERT ON events WHEN NEW.source='dona_message'
    BEGIN SELECT RAISE(ABORT,'publisher unavailable'); END;`);
  const api=new DispatcherApi(database,{isRunning:()=>true,wake(){}},jobs,config,logger); await api.start();
  try {
    const created=await request(config.socketPath,"POST",`/v1/jobs/${job.job_id}/messages/reports`,report(source.event_id));
    assert.equal(created.status,202); assert.equal(database.workerMessages.operationalSnapshot().pending_deliveries,1);
    assert.equal(database.workerMessages.operationalSnapshot().degraded,true);
    sqlite.exec("DROP TRIGGER fail_worker_message_event");
    assert.equal(database.workerMessages.publishPendingReports(),1);
  } finally { sqlite.close(); await api.stop(); database.close(); }
});
