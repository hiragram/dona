import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { afterEach, describe, test } from "node:test";

import Database from "better-sqlite3";

import { DispatcherApi } from "../src/api.js";
import { DispatcherDatabase } from "../src/database.js";
import { readEventJobBinding } from "../src/job-routing.js";
import type { Logger } from "../src/logger.js";
import { WorkerMessageError } from "../src/worker-messaging.js";
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

  test("coalescing、silence deadline、retentionをdurable stateとして保持する",async()=>{
    const {database,source,job,config}=await fixture();
    try {
      const one=database.workerMessages.appendReport(job.job_id,report(source.event_id,1),new Date("2026-07-01T00:00:00Z"));
      const two=database.workerMessages.appendReport(job.job_id,report(source.event_id,2),new Date("2026-07-01T00:00:01Z"));
      assert.equal(database.workerMessages.operationalSnapshot(new Date("2026-07-01T00:20:00Z")).due_silence_deadlines,1);
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
      assert.equal(reopened.workerMessages.purge(new Date("2026-08-02T00:00:00Z")),2);
      reopened.close();
    } finally { try { database.close(); } catch {} }
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
    const sqlite=new Database(config.databasePath);
    assert.deepEqual(readEventJobBinding(sqlite,internal.event_id)?.owner,readEventJobBinding(sqlite,source.event_id)?.owner);
    sqlite.close();
    assert.deepEqual(JSON.parse(internal.payload_json),{schema_version:1,message_id:messageId,job_id:job.job_id,source_event_id:source.event_id,kind:"checkpoint"});
    assert.doesNotMatch(internal.payload_json,/checkpoint 1/);
    const read=await request(config.socketPath,"GET",`/v1/jobs/${job.job_id}/messages/${messageId}?source_event_id=${source.event_id}`);
    assert.equal(read.status,200); assert.equal(((read.body.message as {payload:{kind:string}}).payload.kind),"checkpoint");
    const reconcile=await request(config.socketPath,"GET",`/v1/jobs/${job.job_id}/messages/reconcile?source_event_id=${source.event_id}&producer=worker&idempotency_key=report-1`);
    assert.equal(reconcile.status,200); assert.equal(reconcile.body.reconciliation,"matched");
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
