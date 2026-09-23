import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import Database from "better-sqlite3";

import { DispatcherApi } from "../src/api.js";
import { DispatcherApiClient } from "../src/client.js";
import { DispatcherDatabase, migrateDispatcherDatabase } from "../src/database.js";
import { buildJobPrompt } from "../src/job-prompt.js";
import { readEventJobBinding } from "../src/job-routing.js";
import type { Logger } from "../src/logger.js";
import { buildEventPrompt, envelopeFromRow } from "../src/prompt.js";
import { migrateWorkerMessaging, workerReportMaxPerJob, WorkerInstructionBridge, WorkerMessageError, WorkerMessagePublisher } from "../src/worker-messaging.js";
import { eventEnvelope, tempConfig, waitFor } from "./helpers.js";

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

function bindRuntime(database:DispatcherDatabase,jobId:string,identity:string) {
  database.beginJobPreparation(jobId);
  database.setJobRuntime(jobId,`workspace-${jobId}`,`pane-${jobId}`,identity);
  database.beginJobDispatch(jobId);
  database.markJobRunning(jobId);
}

describe("worker messaging ledger",()=>{
  test("strict contract、sequence、idempotency、terminal fenceを維持する",async()=>{
    const {database,source,job}=await fixture();
    try {
      assert.throws(()=>database.workerMessages.appendReport(job.job_id,{...report(source.event_id),unknown:true}),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="invalid_worker_message");
      assert.throws(()=>database.workerMessages.appendReport(job.job_id,{...report(source.event_id),occurred_at:"2026-02-31T00:00:00Z"}),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="invalid_worker_message");
      assert.throws(()=>database.workerMessages.appendReport(job.job_id,{...report(source.event_id),conversation_revision:Number.MAX_SAFE_INTEGER,
        payload:{kind:"question",question:"回答が必要です"}}),
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
      idempotency_key:"instruction-1",occurred_at:"2026-09-21T00:00:11Z",
      payload:{operation:"add_condition",text:"continue"}},new Date("2026-09-21T00:00:11Z"));
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
      idempotency_key:"instruction-expiry",occurred_at:"2026-09-21T00:00:15Z",payload:{operation:"add_condition",text:"境界"}},new Date("2026-09-21T00:00:15Z"));
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
      const first=database.workerMessages.claim(job.job_id,source.event_id,"worker","runtime-ordered",2,10_000,new Date("2026-09-21T00:00:11Z"));
      assert.deepEqual(first.map(value=>value.delivery.producer_sequence),[1]);
      assert.deepEqual(database.workerMessages.claim(job.job_id,source.event_id,"worker","runtime-overlap",1,10_000,new Date("2026-09-21T00:00:12Z")),[]);
      database.workerMessages.acknowledge(job.job_id,source.event_id,first[0]!.delivery.delivery_id,"runtime-ordered",
        first[0]!.lease_token,first[0]!.delivery.fence,new Date("2026-09-21T00:00:12Z"));
      const second=database.workerMessages.claim(job.job_id,source.event_id,"worker","runtime-ordered",2,10_000,new Date("2026-09-21T00:00:13Z"));
      assert.deepEqual(second.map(value=>value.delivery.producer_sequence),[2]);
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
      database.beginJobPreparation(job.job_id); database.setJobRuntime(job.job_id,"workspace","pane");
      database.beginJobDispatch(job.job_id); database.markJobRunning(job.job_id);
      database.saveJobResult(job.job_id,{schema_version:1,job_id:job.job_id,status:"completed",summary:"done",completed_at:"2026-09-21T00:00:12Z"},job.result_path);
      assert.equal((database.workerMessages.reconcile(job.job_id,source.event_id,"worker","report-1") as {delivery:{state:string}}).delivery.state,"superseded");
      assert.equal(database.workerMessages.operationalSnapshot(new Date("2026-09-21T00:00:13Z")).pending_deliveries,0);
    } finally { database.close(); }
  });

  test("terminal後はqueue済みreport eventから本文を読めない",async()=>{
    const {database,source,job}=await fixture();
    try {
      const created=database.workerMessages.appendReport(job.job_id,{...report(source.event_id),payload:{kind:"question",question:"確認してください"}},new Date("2026-09-21T00:00:01Z"));
      assert.equal(database.workerMessages.publishPendingReports(1,new Date("2026-09-21T00:00:02Z")),1);
      const event=database.getByExternalId("dona_message",`worker-message:${created.message.message_id}`);
      assert.ok(event);
      bindRuntime(database,job.job_id,"runtime-terminal");
      database.saveJobResult(job.job_id,{schema_version:1,job_id:job.job_id,status:"completed",summary:"done",completed_at:"2026-09-21T00:00:03Z"},job.result_path);
      assert.throws(()=>database.workerMessages.getMessage(job.job_id,created.message.message_id,event.event_id),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_message_terminal_fence");
    } finally {database.close();}
  });

  test("question通知の安全なdispatch前失敗は上限後も再配送可能に保つ",async()=>{
    const {database,source,job}=await fixture();
    try {
      const question=database.workerMessages.appendReport(job.job_id,{...report(source.event_id),
        payload:{kind:"question",question:"確認してください"}},new Date("2026-09-21T00:00:01Z"));
      assert.equal(database.workerMessages.publishPendingReports(1,new Date("2026-09-21T00:00:02Z")),1);
      const event=database.getByExternalId("dona_message",`worker-message:${question.message.message_id}`);
      assert.ok(event);
      assert.equal(database.recordPreDispatchFailure(event.event_id,"herdr_unavailable","offline",1,new Date("2026-09-21T00:00:03Z")).status,"retryable_failed");
      assert.equal(database.recordPreDispatchFailure(event.event_id,"herdr_unavailable","offline",1,new Date("2026-09-21T00:01:03Z")).status,"retryable_failed");
      assert.equal(database.workerMessages.getMessage(job.job_id,question.message.message_id,event.event_id)?.message_id,question.message.message_id);
      assert.equal(database.workerMessages.publishPendingReports(1,new Date("2026-09-21T00:01:04Z")),0);
      database.beginDispatch(event.event_id,"/tmp/worker-message-result");
      assert.equal(database.recordSafePromptFailure(event.event_id,"prompt_unavailable","offline",1,new Date("2026-09-21T00:01:05Z")).status,"retryable_failed");
    } finally {database.close();}
  });

  test("未回答questionを次のtyped answer identityと共に投影する",async()=>{
    const {database,source,job}=await fixture();
    try {
      const question=database.workerMessages.appendReport(job.job_id,{schema_version:1,source_event_id:source.event_id,producer_sequence:1,
        idempotency_key:"question-1",occurred_at:"2026-09-21T00:00:01Z",conversation_revision:4,
        payload:{kind:"question",question:"どちらにしますか"}},new Date("2026-09-21T00:00:01Z"));
      assert.equal(database.workerMessages.publishPendingReports(1,new Date("2026-09-21T00:00:02Z")),1);
      assert.deepEqual(database.workerMessages.pendingQuestion(job.job_id),{ambiguous:false,message_id:question.message.message_id,kind:"question",
        next_producer_sequence:1,next_conversation_revision:5});
      database.workerMessages.appendInstruction(job.job_id,{schema_version:1,source_event_id:source.event_id,producer_sequence:1,
        idempotency_key:"answer-1",occurred_at:"2026-09-21T00:00:03Z",correlation_message_id:question.message.message_id,
        conversation_revision:5,payload:{operation:"answer",text:"Aで進めてください"}});
      assert.equal(database.workerMessages.pendingQuestion(job.job_id),undefined);
    } finally {database.close();}
  });

  test("answerは未回答questionとの相関と直後revisionを必須にする",async()=>{
    const {database,source,job}=await fixture();
    try {
      const checkpoint=database.workerMessages.appendReport(job.job_id,report(source.event_id));
      const question=database.workerMessages.appendReport(job.job_id,{schema_version:1,source_event_id:source.event_id,producer_sequence:2,
        idempotency_key:"answer-contract-question",occurred_at:"2026-09-21T00:00:02Z",conversation_revision:7,
        payload:{kind:"question",question:"回答してください"}});
      const base={schema_version:1,source_event_id:source.event_id,producer_sequence:1,
        idempotency_key:"answer-contract",occurred_at:"2026-09-21T00:00:03Z",payload:{operation:"answer" as const,text:"回答"}};
      assert.throws(()=>database.workerMessages.appendInstruction(job.job_id,base),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="invalid_worker_message");
      assert.throws(()=>database.workerMessages.appendInstruction(job.job_id,{...base,correlation_message_id:checkpoint.message.message_id,conversation_revision:1}),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_message_answer_target_invalid");
      assert.throws(()=>database.workerMessages.appendInstruction(job.job_id,{...base,correlation_message_id:question.message.message_id,conversation_revision:7}),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_message_answer_revision_mismatch");
      database.workerMessages.appendInstruction(job.job_id,{...base,correlation_message_id:question.message.message_id,conversation_revision:8});
      assert.throws(()=>database.workerMessages.appendInstruction(job.job_id,{...base,producer_sequence:2,idempotency_key:"answer-contract-second",
        correlation_message_id:question.message.message_id,conversation_revision:8}),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_message_answer_already_exists");
    } finally {database.close();}
  });

  test("needs_review jobはanswerを受理せず回答可能questionを投影しない",async()=>{
    const {database,source,job}=await fixture();
    try {
      const question=database.workerMessages.appendReport(job.job_id,{schema_version:1,source_event_id:source.event_id,
        producer_sequence:1,idempotency_key:"needs-review-question",occurred_at:"2026-09-21T00:00:01Z",conversation_revision:1,
        payload:{kind:"question",question:"回答できますか"}},new Date("2026-09-21T00:00:01Z"));
      assert.equal(database.workerMessages.publishPendingReports(1,new Date("2026-09-21T00:00:02Z")),1);
      database.markJobNeedsReview(job.job_id,"test","確認待ち");
      assert.throws(()=>database.workerMessages.appendReport(job.job_id,{schema_version:1,source_event_id:source.event_id,
        producer_sequence:2,idempotency_key:"needs-review-late-question",occurred_at:"2026-09-21T00:00:02Z",conversation_revision:2,
        payload:{kind:"question",question:"遅延した質問です"}},new Date("2026-09-21T00:00:02Z")),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_message_report_unavailable");
      assert.throws(()=>database.workerMessages.appendInstruction(job.job_id,{schema_version:1,source_event_id:source.event_id,
        producer_sequence:1,idempotency_key:"needs-review-answer",occurred_at:"2026-09-21T00:00:02Z",
        correlation_message_id:question.message.message_id,conversation_revision:2,payload:{operation:"answer",text:"回答"}}),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_message_instruction_unavailable");
      assert.equal(database.workerMessages.pendingQuestion(job.job_id),undefined);
    } finally {database.close();}
  });

  test("running jobのquestion受理をblocked遷移と同じtransactionで確定する",async()=>{
    const {database,source,job,config}=await fixture();
    try {
      bindRuntime(database,job.job_id,"runtime-question");
      const question=database.workerMessages.appendReport(job.job_id,{schema_version:1,source_event_id:source.event_id,
        producer_sequence:1,idempotency_key:"running-question",occurred_at:"2026-09-21T00:00:01Z",conversation_revision:3,
        payload:{kind:"question",question:"回答を待ちます"}},new Date("2026-09-21T00:00:01Z"));
      assert.equal(database.getJob(job.job_id)?.status,"blocked");
      assert.equal(database.getJob(job.job_id)?.last_error_code,"worker_message_question_pending");
      assert.equal(database.listJobsNeedingNotification().some(row=>row.job_id===job.job_id),false);
      assert.equal(database.workerMessages.publishDueSilenceEvents(1,new Date("2026-09-21T00:15:01Z")),1);
      assert.equal(database.beginJobSteer(job.job_id,source.event_id,"normal-condition").duplicate,false);
      database.markJobSteerAccepted(job.job_id,"normal-condition");
      assert.equal(database.getJob(job.job_id)?.status,"blocked");
      const answer=database.workerMessages.appendInstruction(job.job_id,{schema_version:1,source_event_id:source.event_id,
        producer_sequence:1,idempotency_key:"running-answer",occurred_at:"2026-09-21T00:00:02Z",
        correlation_message_id:question.message.message_id,conversation_revision:4,
        payload:{operation:"answer",text:"続行してください"}},new Date("2026-09-21T00:00:02Z"));
      assert.equal(answer.outcome,"created");
      assert.equal(database.beginJobSteer(job.job_id,source.event_id,answer.message.message_id).duplicate,false);
      database.markJobSteerAccepted(job.job_id,answer.message.message_id);
      assert.equal(database.getJob(job.job_id)?.status,"running");
      const sqlite=new Database(config.databasePath);
      const cadence=sqlite.prepare("SELECT generation,silence_due_at,updated_at FROM worker_message_cadence WHERE job_id=?").get(job.job_id) as
        {generation:number;silence_due_at:string|null;updated_at:string};
      sqlite.close();
      assert.equal(cadence.generation,2);
      assert.ok(cadence.silence_due_at);
      assert.ok(Date.parse(cadence.silence_due_at)>Date.parse(cadence.updated_at));
    } finally {database.close();}
  });

  test("既存blocked jobの質問は未配送attentionを失効させる",async()=>{
    const {database,source,job}=await fixture();
    try {
      bindRuntime(database,job.job_id,"runtime-blocked-question");
      database.markJobBlocked(job.job_id,"agent blocked");
      database.sealJobGroup(source.event_id);
      const attention=database.enqueueJobNotification(job.job_id);
      const question=database.workerMessages.appendReport(job.job_id,{...report(source.event_id),
        payload:{kind:"question",question:"回答してください"}},new Date("2026-09-21T00:00:01Z"));
      assert.equal(question.outcome,"created");
      assert.equal(database.get(attention.row.event_id)?.status,"completed");
      assert.equal(database.getJobGroup(source.event_id)?.attention_event_id,null);
      assert.equal(database.getJob(job.job_id)?.last_error_code,"worker_message_question_pending");
      assert.equal(database.getJob(job.job_id)?.completion_event_id,null);
      assert.equal(database.listJobsNeedingNotification().some(row=>row.job_id===job.job_id),false);
    } finally {database.close();}
  });

  test("配送中のblocked attentionがある質問は曖昧な重複通知を作らない",async()=>{
    const {database,source,job,config}=await fixture();
    try {
      bindRuntime(database,job.job_id,"runtime-attention-race");
      database.markJobBlocked(job.job_id,"agent blocked");
      database.sealJobGroup(source.event_id);
      const attention=database.enqueueJobNotification(job.job_id);
      database.beginDispatch(attention.row.event_id,path.join(config.resultsDir,"attention-race.json"));
      assert.throws(()=>database.workerMessages.appendReport(job.job_id,{...report(source.event_id),
        payload:{kind:"question",question:"回答してください"}},new Date("2026-09-21T00:00:01Z")),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_message_attention_conflict");
      assert.equal(database.workerMessages.reconcile(job.job_id,source.event_id,"worker","report-1").reconciliation,"not_found");
      assert.equal(database.getJob(job.job_id)?.last_error_code,"agent_blocked");
    } finally {database.close();}
  });

  test("queued instructionはobjective上限超過を受理前に拒否する",async()=>{
    const {root,config}=await tempConfig(); roots.push(root);
    const database=new DispatcherDatabase(config.databasePath,{jobsPerEventMax:8,jobObjectiveTotalMaxBytes:100});
    try {
      const source=database.enqueue(eventEnvelope("Ev-worker-instruction-cap")).row;
      const job=database.createJob({source_event_id:source.event_id,objective:"a".repeat(80),workspace:{kind:"scratch"}},
        config.jobsWorkspaceRoot,config.jobResultsDir).row;
      assert.throws(()=>database.workerMessages.appendInstruction(job.job_id,{schema_version:1,source_event_id:source.event_id,
        producer_sequence:1,idempotency_key:"over-cap",occurred_at:"2026-09-21T00:00:01Z",
        payload:{operation:"add_condition",text:"続行"}}),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_message_instruction_unavailable");
      assert.equal(database.workerMessages.reconcile(job.job_id,source.event_id,"dona-main","over-cap").reconciliation,"not_found");
    } finally {database.close();}
  });

  test("受理済みanswerをneeds_review遷移で失効し回答不能questionを非表示にする",async()=>{
    const {database,source,job}=await fixture();
    try {
      const question=database.workerMessages.appendReport(job.job_id,{schema_version:1,source_event_id:source.event_id,
        producer_sequence:1,idempotency_key:"transition-question",occurred_at:"2026-09-21T00:00:01Z",conversation_revision:1,
        payload:{kind:"question",question:"回答してください"}},new Date("2026-09-21T00:00:01Z"));
      assert.equal(database.workerMessages.publishPendingReports(1,new Date("2026-09-21T00:00:02Z")),1);
      database.workerMessages.appendInstruction(job.job_id,{schema_version:1,source_event_id:source.event_id,
        producer_sequence:1,idempotency_key:"transition-answer",occurred_at:"2026-09-21T00:00:03Z",
        correlation_message_id:question.message.message_id,conversation_revision:2,payload:{operation:"answer",text:"回答"}});
      assert.equal(database.workerMessages.pendingQuestion(job.job_id),undefined);
      database.markJobNeedsReview(job.job_id,"test","確認待ち");
      assert.equal((database.workerMessages.reconcile(job.job_id,source.event_id,"dona-main","transition-answer") as
        {delivery:{state:string}}).delivery.state,"superseded");
      assert.equal(database.workerMessages.pendingQuestion(job.job_id),undefined);
    } finally {database.close();}
  });

  test("restart時の曖昧なsteerはleased answerを失効し回答不能questionを非表示にする",async()=>{
    const {database,source,job}=await fixture();
    try {
      const question=database.workerMessages.appendReport(job.job_id,{schema_version:1,source_event_id:source.event_id,
        producer_sequence:1,idempotency_key:"restart-question",occurred_at:"2026-09-21T00:00:01Z",conversation_revision:1,
        payload:{kind:"question",question:"再起動後も回答待ちですか"}},new Date("2026-09-21T00:00:01Z"));
      assert.equal(database.workerMessages.publishPendingReports(1,new Date("2026-09-21T00:00:02Z")),1);
      database.workerMessages.appendInstruction(job.job_id,{schema_version:1,source_event_id:source.event_id,
        producer_sequence:1,idempotency_key:"restart-answer",occurred_at:"2026-09-21T00:00:03Z",
        correlation_message_id:question.message.message_id,conversation_revision:2,payload:{operation:"answer",text:"続行してください"}},
      new Date("2026-09-21T00:00:03Z"));
      bindRuntime(database,job.job_id,"runtime-restart");
      assert.equal(database.workerMessages.claim(job.job_id,source.event_id,"worker","runtime-restart",1,10_000,
        new Date("2026-09-21T00:00:04Z"))[0]?.delivery.state,"leased");
      assert.equal(database.beginJobSteer(job.job_id,source.event_id,"restart-answer").duplicate,false);
      assert.deepEqual(database.recoverStaleJobs(new Date("2026-09-21T00:00:05Z")),{retryable:0,needsReview:1});
      assert.equal(database.getJob(job.job_id)?.status,"needs_review");
      assert.equal((database.workerMessages.reconcile(job.job_id,source.event_id,"dona-main","restart-answer") as
        {delivery:{state:string}}).delivery.state,"superseded");
      assert.equal(database.workerMessages.pendingQuestion(job.job_id),undefined);
    } finally {database.close();}
  });

  test("pending questionの次revisionは無関係なmessage最大値ではなく相関元から生成する",async()=>{
    const {database,source,job}=await fixture();
    try {
      database.workerMessages.appendInstruction(job.job_id,{schema_version:1,source_event_id:source.event_id,producer_sequence:1,
        idempotency_key:"unrelated-max",occurred_at:"2026-09-21T00:00:01Z",conversation_revision:Number.MAX_SAFE_INTEGER,
        payload:{operation:"add_condition",text:"独立した条件"}});
      const question=database.workerMessages.appendReport(job.job_id,{schema_version:1,source_event_id:source.event_id,producer_sequence:1,
        idempotency_key:"bounded-question",occurred_at:"2026-09-21T00:00:02Z",conversation_revision:7,
        payload:{kind:"question",question:"回答してください"}},new Date("2026-09-21T00:00:02Z"));
      assert.equal(database.workerMessages.publishPendingReports(1,new Date("2026-09-21T00:00:03Z")),1);
      assert.deepEqual(database.workerMessages.pendingQuestion(job.job_id),{ambiguous:false,message_id:question.message.message_id,
        kind:"question",next_producer_sequence:2,next_conversation_revision:8});
    } finally {database.close();}
  });

  test("instruction bridgeがdurable typed messageを既存steer経路へ一度だけ配送する",async()=>{
    const {database,source,job}=await fixture();
    bindRuntime(database,job.job_id,"runtime-bridge");
    const question=database.workerMessages.appendReport(job.job_id,{schema_version:1,source_event_id:source.event_id,
      producer_sequence:1,idempotency_key:"bridge-question",occurred_at:"2026-09-21T00:00:00Z",conversation_revision:1,
      payload:{kind:"question",question:"この方針で続けますか"}});
    const instruction=database.workerMessages.appendInstruction(job.job_id,{schema_version:1,source_event_id:source.event_id,
      producer_sequence:1,idempotency_key:"bridge-answer",occurred_at:"2026-09-21T00:00:01Z",
      correlation_message_id:question.message.message_id,conversation_revision:2,
      payload:{operation:"answer",text:"この方針で続けてください"}});
    const calls:Array<{jobId:string;sourceEventId:string;instruction:string;operationId:string|undefined}>=[];
    const bridge=new WorkerInstructionBridge(database.workerMessages,{async steer(jobId,sourceEventId,typedInstruction,operationId){
      calls.push({jobId,sourceEventId,instruction:typedInstruction,operationId});
    }});
    try {
      assert.equal(await bridge.runOnce(),true);
      assert.equal(await bridge.runOnce(),false);
      assert.equal(calls.length,1);
      assert.deepEqual({jobId:calls[0]!.jobId,sourceEventId:calls[0]!.sourceEventId},{jobId:job.job_id,sourceEventId:source.event_id});
      assert.equal(calls[0]!.operationId,instruction.message.message_id);
      assert.match(calls[0]!.instruction,/DONA_TYPED_INSTRUCTION/);
      assert.match(calls[0]!.instruction,/この方針で続けてください/);
      assert.equal((database.workerMessages.reconcile(job.job_id,source.event_id,"dona-main","bridge-answer") as
        {delivery:{state:string;message_id:string}}).delivery.state,"delivered");
      assert.equal(instruction.message.message_id,(database.workerMessages.reconcile(job.job_id,source.event_id,"dona-main","bridge-answer") as
        {message:{message_id:string}}).message.message_id);
    } finally {await bridge.stop();database.close();}
  });

  test("instruction bridgeはshutdown開始後に次のdeliveryをclaimしない",async()=>{
    const {database,source,job}=await fixture();
    for(const sequence of [1,2])database.workerMessages.appendInstruction(job.job_id,{schema_version:1,source_event_id:source.event_id,
      producer_sequence:sequence,idempotency_key:`shutdown-${sequence}`,occurred_at:`2026-09-21T00:00:0${sequence}Z`,
      payload:{operation:"add_condition",text:`条件 ${sequence}`}},new Date(`2026-09-21T00:00:0${sequence}Z`));
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let calls=0;
    const bridge=new WorkerInstructionBridge(database.workerMessages,{async steer(){calls+=1;await gate;}},5);
    try {
      bridge.start();
      await waitFor(()=>calls===1);
      bridge.beginShutdown();
      release();
      await bridge.stop();
      assert.equal(calls,1);
      assert.equal((database.workerMessages.reconcile(job.job_id,source.event_id,"dona-main","shutdown-1") as {delivery:{state:string}}).delivery.state,"delivered");
      assert.equal((database.workerMessages.reconcile(job.job_id,source.event_id,"dona-main","shutdown-2") as {delivery:{state:string}}).delivery.state,"pending");
    } finally {release();await bridge.stop();database.close();}
  });

  test("bridge候補はleased先行instructionと配送不能jobを飛ばす",async()=>{
    const {database,source,job,config}=await fixture();
    try {
      for(const sequence of [1,2])database.workerMessages.appendInstruction(job.job_id,{schema_version:1,
        source_event_id:source.event_id,producer_sequence:sequence,idempotency_key:`ordered-${sequence}`,
        occurred_at:`2026-09-21T00:00:0${sequence}Z`,payload:{operation:"add_condition",text:`条件 ${sequence}`}},
        new Date(`2026-09-21T00:00:0${sequence}Z`));
      database.workerMessages.claim(job.job_id,source.event_id,"worker","crashed-bridge",1,10_000,new Date("2026-09-21T00:00:03Z"));
      const sibling=database.createJob({source_event_id:source.event_id,job_key:"claimable-sibling",objective:"sibling",workspace:{kind:"scratch"}},
        config.jobsWorkspaceRoot,config.jobResultsDir).row;
      const siblingInstruction=database.workerMessages.appendInstruction(sibling.job_id,{schema_version:1,source_event_id:source.event_id,
        producer_sequence:1,idempotency_key:"sibling-instruction",occurred_at:"2026-09-21T00:00:04Z",
        payload:{operation:"add_condition",text:"別jobの条件"}},new Date("2026-09-21T00:00:04Z"));
      assert.equal(database.workerMessages.claimNextWorkerInstruction("live-bridge",10_000,new Date("2026-09-21T00:00:05Z"))?.delivery.message_id,
        siblingInstruction.message.message_id);
      const unavailable=database.createJob({source_event_id:source.event_id,job_key:"unavailable",objective:"unavailable",workspace:{kind:"scratch"}},
        config.jobsWorkspaceRoot,config.jobResultsDir).row;
      bindRuntime(database,unavailable.job_id,"runtime-unavailable");
      database.workerMessages.appendInstruction(unavailable.job_id,{schema_version:1,source_event_id:source.event_id,
        producer_sequence:1,idempotency_key:"unavailable-instruction",occurred_at:"2026-09-21T00:00:06Z",
        payload:{operation:"add_condition",text:"配送不能"}},new Date("2026-09-21T00:00:06Z"));
      database.markJobNeedsReview(unavailable.job_id,"test","test");
      assert.equal(database.workerMessages.claimNextWorkerInstruction("live-bridge",10_000,new Date("2026-09-21T00:00:07Z")),undefined);
    } finally {database.close();}
  });

  test("未回答questionがある間は次のquestionを受理しない",async()=>{
    const {database,source,job}=await fixture();
    try {
      const first=database.workerMessages.appendReport(job.job_id,{schema_version:1,source_event_id:source.event_id,producer_sequence:1,
        idempotency_key:"question-1",occurred_at:"2026-09-21T00:00:01Z",conversation_revision:1,
        payload:{kind:"question",question:"質問 1"}},new Date("2026-09-21T00:00:01Z"));
      assert.throws(()=>database.workerMessages.appendReport(job.job_id,{schema_version:1,source_event_id:source.event_id,producer_sequence:2,
        idempotency_key:"question-2",occurred_at:"2026-09-21T00:00:02Z",conversation_revision:2,
        payload:{kind:"decision_request",question:"質問 2",options:["続行"]}},new Date("2026-09-21T00:00:02Z")),
      (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_message_question_pending");
      assert.equal(database.workerMessages.publishPendingReports(2,new Date("2026-09-21T00:00:03Z")),1);
      assert.deepEqual(database.workerMessages.pendingQuestion(job.job_id),{ambiguous:false,message_id:first.message.message_id,kind:"question",
        next_producer_sequence:1,next_conversation_revision:2});
    } finally {database.close();}
  });

  test("answerがworkerへ配送されるまで次のquestionを受理しない",async()=>{
    const {database,source,job}=await fixture();
    try {
      const first=database.workerMessages.appendReport(job.job_id,{...report(source.event_id),conversation_revision:1,
        payload:{kind:"question",question:"最初の質問"}},new Date("2026-09-21T00:00:01Z"));
      database.workerMessages.appendInstruction(job.job_id,{schema_version:1,source_event_id:source.event_id,
        producer_sequence:1,idempotency_key:"answer-pending",occurred_at:"2026-09-21T00:00:02Z",
        correlation_message_id:first.message.message_id,conversation_revision:2,payload:{operation:"answer",text:"回答"}},
        new Date("2026-09-21T00:00:02Z"));
      const next={...report(source.event_id,2),conversation_revision:2,payload:{kind:"question" as const,question:"次の質問"}};
      assert.throws(()=>database.workerMessages.appendReport(job.job_id,next,new Date("2026-09-21T00:00:03Z")),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_message_question_pending");
      const claim=database.workerMessages.claim(job.job_id,source.event_id,"worker","test-worker",1,10_000,new Date("2026-09-21T00:00:04Z"))[0]!;
      assert.throws(()=>database.workerMessages.appendReport(job.job_id,next,new Date("2026-09-21T00:00:05Z")),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_message_question_pending");
      database.workerMessages.acknowledge(job.job_id,source.event_id,claim.delivery.delivery_id,"test-worker",claim.lease_token,
        claim.delivery.fence,new Date("2026-09-21T00:00:06Z"));
      assert.equal(database.workerMessages.appendReport(job.job_id,next,new Date("2026-09-21T00:00:07Z")).outcome,"created");
    } finally {database.close();}
  });

  test("既存DBの複数未回答questionはboundedな選択候補を投影する",async()=>{
    const {database,source,job,config}=await fixture();
    try {
      const first=database.workerMessages.appendReport(job.job_id,{schema_version:1,source_event_id:source.event_id,producer_sequence:1,
        idempotency_key:"legacy-question-1",occurred_at:"2026-09-21T00:00:01Z",conversation_revision:1,
        payload:{kind:"question",question:"最初の質問"}},new Date("2026-09-21T00:00:01Z"));
      database.workerMessages.publishPendingReports(1,new Date("2026-09-21T00:00:02Z"));
      const sqlite=new Database(config.databasePath);
      sqlite.prepare("UPDATE worker_message_deliveries SET state='superseded' WHERE message_id=?").run(first.message.message_id);
      const second=database.workerMessages.appendReport(job.job_id,{schema_version:1,source_event_id:source.event_id,producer_sequence:2,
        idempotency_key:"legacy-question-2",occurred_at:"2026-09-21T00:00:03Z",conversation_revision:2,
        payload:{kind:"decision_request",question:"次の質問",options:["続行"]}},new Date("2026-09-21T00:00:03Z"));
      database.workerMessages.publishPendingReports(1,new Date("2026-09-21T00:00:04Z"));
      sqlite.prepare("UPDATE worker_message_deliveries SET state='delivered' WHERE message_id=?").run(first.message.message_id);
      sqlite.close();
      assert.deepEqual(database.workerMessages.pendingQuestion(job.job_id),{ambiguous:true,pending_count_at_least:2,candidates:[
        {message_id:second.message.message_id,kind:"decision_request",next_producer_sequence:1,next_conversation_revision:3,question:"次の質問"},
        {message_id:first.message.message_id,kind:"question",next_producer_sequence:1,next_conversation_revision:2,question:"最初の質問"},
      ]});
    } finally {database.close();}
  });

  test("worker reportはjob単位の永続件数上限を超えて増加しない",async()=>{
    const {database,source,job}=await fixture();
    try {
      for(let sequence=1;sequence<=workerReportMaxPerJob;sequence++) database.workerMessages.appendReport(job.job_id,
        {...report(source.event_id,sequence,`limit-${sequence}`),occurred_at:"2026-09-21T00:00:00Z"});
      assert.throws(()=>database.workerMessages.appendReport(job.job_id,
        {...report(source.event_id,workerReportMaxPerJob+1,"limit-overflow"),occurred_at:"2026-09-21T00:00:00Z"}),
        (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_message_report_limit_exceeded");
      assert.equal(database.workerMessages.appendReport(job.job_id,
        {...report(source.event_id,workerReportMaxPerJob,"limit-256"),occurred_at:"2026-09-21T00:00:00Z"}).outcome,"reused");
    } finally {database.close();}
  });

  test("宛先のない100件が後続の配送可能reportをstarveしない",async()=>{
    const {database,source,job,config}=await fixture();
    try {
      for(let sequence=1;sequence<=101;sequence++) database.workerMessages.appendReport(job.job_id,{schema_version:1,
        source_event_id:source.event_id,producer_sequence:sequence,idempotency_key:`bounded-${sequence}`,
        occurred_at:"2026-09-21T00:00:00Z",payload:{kind:"risk",severity:"high",summary:`risk ${sequence}`}},
        new Date(Date.parse("2026-09-21T00:00:00Z")+sequence));
      const sqlite=new Database(config.databasePath);
      sqlite.prepare(`UPDATE worker_messages SET workspace_id=NULL,channel_id=NULL,thread_ts=NULL
        WHERE job_id=? AND producer_sequence<=100`).run(job.job_id);
      sqlite.close();
      assert.equal(database.workerMessages.publishPendingReports(100,new Date("2026-09-21T00:00:01Z")),1);
      assert.equal((database.workerMessages.reconcile(job.job_id,source.event_id,"worker","bounded-101") as {delivery:{state:string}}).delivery.state,"delivered");
      assert.equal((database.workerMessages.reconcile(job.job_id,source.event_id,"worker","bounded-1") as {delivery:{state:string}}).delivery.state,"pending");
    } finally { database.close(); }
  });

  test("同時刻のreportをproducer sequence順にevent化する",async()=>{
    const {database,source,job,config}=await fixture();
    try {
      const at=new Date("2026-09-21T00:00:10Z");
      const messages=[1,2].map(sequence=>database.workerMessages.appendReport(job.job_id,{schema_version:1,
        source_event_id:source.event_id,producer_sequence:sequence,idempotency_key:`publish-order-${sequence}`,
        occurred_at:`2026-09-21T00:00:0${sequence}Z`,payload:{kind:"risk",severity:"high",summary:`risk ${sequence}`}},at).message.message_id);
      assert.equal(database.workerMessages.publishPendingReports(2,new Date("2026-09-21T00:00:11Z")),2);
      const sqlite=new Database(config.databasePath);
      const externalIds=(sqlite.prepare("SELECT external_event_id FROM events WHERE source='dona_message' ORDER BY rowid").all() as Array<{external_event_id:string}>).map(row=>row.external_event_id);
      sqlite.close();
      assert.deepEqual(externalIds,messages.map(messageId=>`worker-message:${messageId}`));
    } finally { database.close(); }
  });

  test("terminal遷移でworker向けpending／leased deliveryをsupersededにする",async()=>{
    const {database,source,job}=await fixture();
    try {
      for(const sequence of [1,2]) database.workerMessages.appendInstruction(job.job_id,{schema_version:1,source_event_id:source.event_id,
        producer_sequence:sequence,idempotency_key:`terminal-${sequence}`,occurred_at:`2026-09-21T00:00:0${sequence}Z`,
        payload:{operation:"add_condition",text:`condition ${sequence}`}},new Date(`2026-09-21T00:00:0${sequence}Z`));
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

  test("新しいreportは未処理の旧silence eventを失効させる",async()=>{
    const {database,source,job,config}=await fixture();
    try {
      database.workerMessages.appendReport(job.job_id,report(source.event_id),new Date("2026-09-21T00:00:00Z"));
      assert.equal(database.workerMessages.publishDueSilenceEvents(1,new Date("2026-09-21T00:15:00Z")),1);
      const sqliteBefore=new Database(config.databasePath);
      const silenceEvent=sqliteBefore.prepare("SELECT event_id FROM events WHERE event_type='worker_message_silence'").get() as {event_id:string};
      sqliteBefore.close();
      database.beginDispatch(silenceEvent.event_id,path.join(config.resultsDir,"silence.json"));
      database.markWaiting(silenceEvent.event_id);
      assert.deepEqual(database.workerMessages.silenceEventState(job.job_id,silenceEvent.event_id),{worker_message_silence:{
        event_id:silenceEvent.event_id,event_generation:1,current_generation:1,current:true}});
      database.workerMessages.appendReport(job.job_id,report(source.event_id,2),new Date("2026-09-21T00:15:01Z"));
      const sqlite=new Database(config.databasePath);
      const silence=sqlite.prepare("SELECT status,last_error_code FROM events WHERE event_type='worker_message_silence'").get() as
        {status:string;last_error_code:string|null};
      sqlite.close();
      assert.deepEqual(silence,{status:"completed",last_error_code:"worker_message_silence_superseded"});
      assert.deepEqual(database.workerMessages.silenceEventState(job.job_id,silenceEvent.event_id),{worker_message_silence:{
        event_id:silenceEvent.event_id,event_generation:1,current_generation:2,current:false}});
    } finally {database.close();}
  });

  test("terminal jobの処理中silence eventはcurrentではない",async()=>{
    const {database,source,job,config}=await fixture();
    try {
      database.workerMessages.appendReport(job.job_id,report(source.event_id),new Date("2026-09-21T00:00:00Z"));
      database.workerMessages.publishDueSilenceEvents(1,new Date("2026-09-21T00:15:00Z"));
      const sqlite=new Database(config.databasePath);
      const silenceEvent=sqlite.prepare("SELECT event_id FROM events WHERE event_type='worker_message_silence'").get() as {event_id:string};
      sqlite.close();
      database.beginDispatch(silenceEvent.event_id,path.join(config.resultsDir,"terminal-silence.json"));
      database.markWaiting(silenceEvent.event_id);
      database.beginJobPreparation(job.job_id); database.setJobRuntime(job.job_id,"workspace","pane");
      database.beginJobDispatch(job.job_id); database.markJobRunning(job.job_id);
      database.saveJobResult(job.job_id,{schema_version:1,job_id:job.job_id,status:"completed",summary:"done",completed_at:"2026-09-21T00:16:00Z"},job.result_path);
      assert.deepEqual(database.workerMessages.silenceEventState(job.job_id,silenceEvent.event_id),{worker_message_silence:{
        event_id:silenceEvent.event_id,event_generation:1,current_generation:1,current:false}});
    } finally {database.close();}
  });

  test("needs_review後は既存silenceを無効化し新規silenceも発行しない",async()=>{
    const {database,source,job,config}=await fixture();
    try {
      database.workerMessages.appendReport(job.job_id,report(source.event_id),new Date("2026-09-21T00:00:00Z"));
      assert.equal(database.workerMessages.publishDueSilenceEvents(1,new Date("2026-09-21T00:15:00Z")),1);
      const sqlite=new Database(config.databasePath);
      const event=sqlite.prepare("SELECT event_id FROM events WHERE event_type='worker_message_silence'").get() as {event_id:string};
      sqlite.close();
      database.beginDispatch(event.event_id,path.join(config.resultsDir,"needs-review-silence.json"));
      database.markWaiting(event.event_id);
      database.markJobNeedsReview(job.job_id,"test","review required");
      assert.equal(database.workerMessages.silenceEventState(job.job_id,event.event_id)?.worker_message_silence.current,false);
      const second=database.createJob({source_event_id:source.event_id,job_key:"silence-review",objective:"review",workspace:{kind:"scratch"}},
        config.jobsWorkspaceRoot,config.jobResultsDir).row;
      database.workerMessages.appendReport(second.job_id,report(source.event_id),new Date("2026-09-21T00:00:00Z"));
      database.markJobNeedsReview(second.job_id,"test","review required");
      assert.equal(database.workerMessages.publishDueSilenceEvents(2,new Date("2026-09-21T00:15:00Z")),0);
      assert.equal(database.workerMessages.operationalSnapshot(new Date("2026-09-21T00:15:00Z")).due_silence_deadlines,0);
    } finally {database.close();}
  });

  test("retentionは存続する相関messageの親を削除しない",async()=>{
    const {database,source,job}=await fixture();
    try {
      const parent=database.workerMessages.appendReport(job.job_id,{...report(source.event_id),conversation_revision:0,
        payload:{kind:"question",question:"継続しますか"}},new Date("2026-07-01T00:00:00Z"));
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

  test("新しい緊急reportは古いpending checkpointをsupersedeする",async()=>{
    const {database,source,job}=await fixture();
    try {
      const first=database.workerMessages.appendReport(job.job_id,report(source.event_id,1),new Date("2026-09-21T00:00:01Z"));
      const urgent=database.workerMessages.appendReport(job.job_id,{schema_version:1,source_event_id:source.event_id,producer_sequence:2,
        idempotency_key:"urgent-question",occurred_at:"2026-09-21T00:00:02Z",conversation_revision:1,
        payload:{kind:"question",question:"確認してください"}},new Date("2026-09-21T00:00:02Z"));
      const states=[first,urgent].map(value=>(database.workerMessages.reconcile(job.job_id,source.event_id,"worker",value.message.idempotency_key) as {delivery:{state:string}}).delivery.state);
      assert.deepEqual(states,["superseded","pending"]);
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

test("legacy job-level runtime identity migrationは複数候補をmessageへ推測帰属しない",async()=>{
  const {database,source,job,config}=await fixture();
  database.workerMessages.appendReport(job.job_id,report(source.event_id),new Date("2026-09-21T00:00:00Z"));
  database.close();
  const sqlite=new Database(config.databasePath);
  try {
    sqlite.exec(`DROP TABLE worker_message_runtime_identities;
      CREATE TABLE worker_message_runtime_identities (
        job_id TEXT NOT NULL,
        runtime_identity_sha256 TEXT NOT NULL,
        first_seen_at TEXT NOT NULL
      );`);
    sqlite.prepare("INSERT INTO worker_message_runtime_identities VALUES(?,?,?)")
      .run(job.job_id,"a".repeat(64),"2026-09-21T00:00:01Z");
    sqlite.prepare("INSERT INTO worker_message_runtime_identities VALUES(?,?,?)")
      .run(job.job_id,"b".repeat(64),"2026-09-21T00:00:02Z");
    migrateWorkerMessaging(sqlite);
    assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM worker_message_runtime_identities").get() as {count:number}).count,0);
  } finally {sqlite.close();}
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
  bindRuntime(bridge,job.job_id,"runtime-v2-preservation");
  const created=bridge.workerMessages.appendWorkerReport(job.job_id,"runtime-v2-preservation",report(source.event_id),new Date("2026-09-21T00:00:00Z"));
  bridge.close();

  const legacyBridge=new Database(config.databasePath);
  legacyBridge.exec(`
    ALTER TABLE worker_message_deliveries DROP COLUMN delivered_lease_owner;
    ALTER TABLE worker_message_deliveries DROP COLUMN delivered_lease_token_sha256;
    ALTER TABLE worker_message_deliveries DROP COLUMN delivered_fence;
  `);
  legacyBridge.close();

  const activation=new Database(config.databasePath);
  activation.pragma("foreign_keys = ON");
  migrateDispatcherDatabase(activation,()=>{},false,3);
  assert.deepEqual(activation.pragma("foreign_key_check"),[]);
  activation.close();

  const reopened=new DispatcherDatabase(config.databasePath);
  try {
    reopened.saveJobResult(job.job_id,{schema_version:1,job_id:job.job_id,status:"completed",summary:"done",
      completed_at:"2026-09-21T00:00:01Z"},job.result_path);
    reopened.markJobRuntimeCleaned(job.job_id);
    const reconciled=reopened.workerMessages.reconcileWorker(job.job_id,source.event_id,"runtime-v2-preservation","report-1");
    assert.equal(reconciled.reconciliation,"matched");
    assert.equal((reconciled as {message:{message_id:string}}).message.message_id,created.message.message_id);
  } finally {reopened.close();}
});

function request(socketPath:string,method:string,route:string,body?:unknown,headers:Record<string,string>={}) {
  const encoded=body===undefined?undefined:Buffer.from(JSON.stringify(body));
  return new Promise<{status:number;body:Record<string,unknown>}>((resolve,reject)=>{
    const req=http.request({socketPath,method,path:route,headers:{...headers,...(encoded?{"content-type":"application/json","content-length":String(encoded.length)}:{})}},response=>{
      const chunks:Buffer[]=[];response.on("data",(chunk:Buffer)=>chunks.push(chunk));response.on("end",()=>resolve({status:response.statusCode??0,body:JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string,unknown>}));
    });req.once("error",reject);req.end(encoded);
  });
}

test("APIはbinding済みmessageだけをboundedにwrite/read/reconcileする",async()=>{
  const {database,source,job,config}=await fixture();
  bindRuntime(database,job.job_id,"runtime-primary");
  const api=new DispatcherApi(database,{isRunning:()=>true,wake(){}},jobs,config,logger); await api.start();
  try {
    await fs.mkdir(path.dirname(config.updateInternalTokenPath),{recursive:true,mode:0o700});
    await fs.writeFile(config.updateInternalTokenPath,"i".repeat(64),{mode:0o600});
    assert.equal((await request(config.workerSocketPath,"POST","/v1/events",eventEnvelope("Ev-worker-socket-forbidden"))).status,404);
    const created=await request(config.workerSocketPath,"POST",`/v1/jobs/${job.job_id}/messages/reports`,report(source.event_id),{"x-dona-worker-runtime":"runtime-primary"});
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
    const sourceRead=await request(config.socketPath,"GET",`/v1/jobs/${job.job_id}/messages/${messageId}?source_event_id=${source.event_id}`);
    assert.equal(sourceRead.status,403);
    const read=await request(config.socketPath,"GET",`/v1/jobs/${job.job_id}/messages/${messageId}?source_event_id=${internal.event_id}`);
    assert.equal(read.status,200); assert.equal(((read.body.message as {payload:{kind:string}}).payload.kind),"checkpoint");
    const reconcile=await request(config.workerSocketPath,"GET",`/v1/jobs/${job.job_id}/messages/reconcile?source_event_id=${source.event_id}&producer=worker&idempotency_key=report-1`,undefined,{"x-dona-worker-runtime":"runtime-primary"});
    assert.equal(reconcile.status,200); assert.equal(reconcile.body.reconciliation,"matched");
    const instruction={schema_version:1,source_event_id:source.event_id,producer_sequence:1,idempotency_key:"api-instruction",
      occurred_at:"2026-09-21T00:00:02Z",payload:{operation:"add_condition",text:"認証済み条件"}};
    assert.equal((await request(config.socketPath,"POST",`/v1/jobs/${job.job_id}/messages/instructions`,instruction)).status,403);
    assert.equal((await request(config.socketPath,"POST",`/v1/jobs/${job.job_id}/messages/instructions`,instruction,
      {"x-dona-worker-runtime":"runtime-primary"})).status,403);
    const instructionResult=await new DispatcherApiClient(config.socketPath,1_000,config.updateInternalTokenPath)
      .sendWorkerInstruction(job.job_id,instruction);
    assert.equal(instructionResult.outcome,"created");
    const forbiddenClaim=await request(config.workerSocketPath,"POST",`/v1/jobs/${job.job_id}/messages/deliveries/claim`,{
      source_event_id:source.event_id,consumer:"dona-main",lease_owner:"worker-bridge",limit:1,lease_ms:10_000},{"x-dona-worker-runtime":"runtime-primary"});
    assert.equal(forbiddenClaim.status,404);
    const direct=database.workerMessages.appendReport(job.job_id,report(source.event_id,2,"report-api-2"),new Date());
    const claimed=database.workerMessages.claim(job.job_id,source.event_id,"dona-main","internal-publisher",1,10_000,new Date(Date.now()+61_000));
    assert.equal(claimed[0]!.delivery.message_id,direct.message.message_id);
    const forbiddenAck=await request(config.socketPath,"POST",`/v1/jobs/${job.job_id}/messages/deliveries/${claimed[0]!.delivery.delivery_id}/ack`,{
      source_event_id:source.event_id,lease_owner:"internal-publisher",lease_token:claimed[0]!.lease_token,fence:claimed[0]!.delivery.fence},{"x-dona-worker-runtime":"runtime-primary"});
    assert.equal(forbiddenAck.status,409);
    const health=await request(config.socketPath,"GET","/health/ready");
    assert.equal((health.body.worker_messaging as {protocol_version:number}).protocol_version,1);
    const snapshot=database.workerMessages.operationalSnapshot.bind(database.workerMessages);
    database.workerMessages.operationalSnapshot=()=>({...snapshot(),degraded:true});
    const degraded=await request(config.socketPath,"GET","/health/version");
    assert.equal(degraded.status,503);
    assert.equal(degraded.body.status,"not_ready");
    database.workerMessages.operationalSnapshot=()=>{throw new Error("worker message storage unavailable");};
    const unavailable=await request(config.socketPath,"GET","/health/ready");
    assert.equal(unavailable.status,503);
    assert.equal((unavailable.body.worker_messaging as {error_code:string}).error_code,"worker_message_storage_unavailable");
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

test("worker-facing APIは同じownerのsibling runtimeを拒否する",async()=>{
  const {database,source,job,config}=await fixture();
  const sibling=database.createJob({source_event_id:source.event_id,job_key:"sibling",objective:"sibling worker",workspace:{kind:"scratch"}},
    config.jobsWorkspaceRoot,config.jobResultsDir).row;
  bindRuntime(database,job.job_id,"runtime-primary");
  bindRuntime(database,sibling.job_id,"runtime-sibling");
  const api=new DispatcherApi(database,{isRunning:()=>true,wake(){}},jobs,config,logger); await api.start();
  try {
    const crossed=await request(config.workerSocketPath,"POST",`/v1/jobs/${sibling.job_id}/messages/reports`,
      report(source.event_id),{"x-dona-worker-runtime":"runtime-primary"});
    assert.equal(crossed.status,403);
    const accepted=await request(config.workerSocketPath,"POST",`/v1/jobs/${sibling.job_id}/messages/reports`,
      report(source.event_id),{"x-dona-worker-runtime":"runtime-sibling"});
    assert.equal(accepted.status,202);
    const prompt=buildJobPrompt(sibling,true,"runtime-sibling",config.workerSocketPath);
    const jobJson=JSON.parse(prompt.split("job_json:\n")[1]!.split("\n[DONA_JOB_END]")[0]!) as
      {runtime_identity:string;worker_messaging:{transport:{socket_path:string};report:{path:string}}};
    assert.equal(jobJson.runtime_identity,"runtime-sibling");
    assert.equal(jobJson.worker_messaging.transport.socket_path,config.workerSocketPath);
    assert.equal(jobJson.worker_messaging.report.path,`/v1/jobs/${sibling.job_id}/messages/reports`);
    assert.match(prompt,/他jobへ転用せず/);
  } finally {await api.stop();database.close();}
});

test("worker reportはterminal cleanup後も元runtimeでread-only reconcileできる",async()=>{
  const {database,source,job,config}=await fixture();
  bindRuntime(database,job.job_id,"runtime-terminal-reconcile");
  const api=new DispatcherApi(database,{isRunning:()=>true,wake(){}},jobs,config,logger); await api.start();
  try {
    const created=await request(config.workerSocketPath,"POST",`/v1/jobs/${job.job_id}/messages/reports`,
      report(source.event_id),{"x-dona-worker-runtime":"runtime-terminal-reconcile"});
    assert.equal(created.status,202);
    database.saveJobResult(job.job_id,{schema_version:1,job_id:job.job_id,status:"completed",summary:"done",
      completed_at:"2026-09-21T00:00:04Z"},job.result_path);
    database.markJobRuntimeCleaned(job.job_id);
    assert.equal(database.getJobLiveSessionIdentity(job.job_id),undefined);
    const reconciled=await request(config.workerSocketPath,"GET",
      `/v1/jobs/${job.job_id}/messages/reconcile?source_event_id=${source.event_id}&producer=worker&idempotency_key=report-1`,
      undefined,{"x-dona-worker-runtime":"runtime-terminal-reconcile"});
    assert.equal(reconciled.status,200);
    assert.equal(reconciled.body.reconciliation,"matched");
    const rejected=await request(config.workerSocketPath,"GET",
      `/v1/jobs/${job.job_id}/messages/reconcile?source_event_id=${source.event_id}&producer=worker&idempotency_key=report-1`,
      undefined,{"x-dona-worker-runtime":"runtime-foreign"});
    assert.equal(rejected.status,403);
  } finally {await api.stop();database.close();}
});

test("過去runtimeは自分が生成したmessageだけをreconcileできる",async()=>{
  const {database,source,job,config}=await fixture();
  bindRuntime(database,job.job_id,"runtime-first");
  database.workerMessages.appendWorkerReport(job.job_id,"runtime-first",report(source.event_id,1,"first-report"));
  const sqlite=new Database(config.databasePath);
  sqlite.prepare("UPDATE job_live_session_identities SET herdr_agent_session_id=? WHERE job_id=?").run("runtime-second",job.job_id);
  sqlite.close();
  database.workerMessages.appendWorkerReport(job.job_id,"runtime-second",report(source.event_id,2,"second-report"));
  assert.throws(()=>database.workerMessages.reconcileWorker(job.job_id,source.event_id,"runtime-second","first-report"),
    (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_runtime_mismatch");
  database.saveJobResult(job.job_id,{schema_version:1,job_id:job.job_id,status:"completed",summary:"done",
    completed_at:"2026-09-21T00:00:04Z"},job.result_path);
  database.markJobRuntimeCleaned(job.job_id);
  try {
    assert.equal(database.workerMessages.reconcileWorker(job.job_id,source.event_id,"runtime-first","first-report").reconciliation,"matched");
    assert.throws(()=>database.workerMessages.reconcileWorker(job.job_id,source.event_id,"runtime-first","second-report"),
      (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_runtime_mismatch");
    assert.equal(database.workerMessages.reconcileWorker(job.job_id,source.event_id,"runtime-second","second-report").reconciliation,"matched");
    assert.throws(()=>database.workerMessages.reconcileWorker(job.job_id,source.event_id,"runtime-second","first-report"),
      (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_runtime_mismatch");
  } finally {database.close();}
});

test("current runtimeは未記録reportをnot_foundとしてreconcileできる",async()=>{
  const {database,source,job}=await fixture();
  try {
    bindRuntime(database,job.job_id,"runtime-current");
    assert.deepEqual(database.workerMessages.reconcileWorker(job.job_id,source.event_id,"runtime-current","missing-report"),
      {reconciliation:"not_found"});
    assert.throws(()=>database.workerMessages.reconcileWorker(job.job_id,source.event_id,"runtime-foreign","missing-report"),
      (error:unknown)=>error instanceof WorkerMessageError&&error.code==="worker_runtime_mismatch");
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
  bindRuntime(database,job.job_id,"runtime-degraded");
  const sqlite=new Database(config.databasePath);
  sqlite.exec(`CREATE TRIGGER fail_worker_message_event BEFORE INSERT ON events WHEN NEW.source='dona_message'
    BEGIN SELECT RAISE(ABORT,'publisher unavailable'); END;`);
  const api=new DispatcherApi(database,{isRunning:()=>true,wake(){}},jobs,config,logger); await api.start();
  try {
    const created=await request(config.workerSocketPath,"POST",`/v1/jobs/${job.job_id}/messages/reports`,report(source.event_id),{"x-dona-worker-runtime":"runtime-degraded"});
    assert.equal(created.status,202); assert.equal(database.workerMessages.operationalSnapshot().pending_deliveries,1);
    const available=(sqlite.prepare("SELECT available_at FROM worker_message_deliveries WHERE consumer='dona-main'").get() as {available_at:string}).available_at;
    assert.equal(database.workerMessages.operationalSnapshot(new Date(Date.parse(available)+59_999)).degraded,false);
    assert.equal(database.workerMessages.operationalSnapshot(new Date(Date.parse(available)+60_000)).degraded,true);
    sqlite.exec("DROP TRIGGER fail_worker_message_event");
    assert.equal(database.workerMessages.publishPendingReports(),1);
  } finally { sqlite.close(); await api.stop(); database.close(); }
});
