import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { afterEach, describe, test } from "node:test";

import Database from "better-sqlite3";

import { DispatcherDatabase, migrateDispatcherDatabase } from "../src/database.js";
import type { HerdrCommandResult } from "../src/herdr.js";
import type { JobAgentRuntime } from "../src/job-runtime.js";
import { JobSupervisor } from "../src/job-supervisor.js";
import { buildLiveSessionReceipt, migrateLiveSession } from "../src/live-session.js";
import type { Logger } from "../src/logger.js";
import type { JobRow } from "../src/types.js";
import { eventEnvelope, tempConfig } from "./helpers.js";

const roots:string[]=[];
const logger:Logger={debug(){},info(){},warn(){},error(){}};

afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});

function runtimeWith(result:(agentName:string)=>HerdrCommandResult,calls:string[]):JobAgentRuntime{
  return {
    async prepare(){throw new Error("not used");},
    async get(agentName){calls.push(`get:${agentName}`);return result(agentName);},
    async prompt(){calls.push("prompt");throw new Error("control command must not be called");},
    async wait(){calls.push("wait");throw new Error("control command must not be called");},
    async cancel(){calls.push("cancel");throw new Error("control command must not be called");},
  };
}

async function addressableJob(status:"dispatching"|"needs_review"="needs_review",jobKey?:string){
  const {root,config}=await tempConfig();roots.push(root);
  const database=new DispatcherDatabase(config.databasePath);
  const source=database.enqueue(eventEnvelope(`Ev-live-${root.slice(-6)}`)).row;
  const created=database.createJob({source_event_id:source.event_id,objective:"private objective",workspace:{kind:"scratch"},...(jobKey?{job_key:jobKey}:{})},config.jobsWorkspaceRoot,config.jobResultsDir).row;
  database.beginJobPreparation(created.job_id);
  database.setJobRuntime(created.job_id,"workspace-private","pane-private","session-private");
  database.beginJobDispatch(created.job_id);
  if(status==="needs_review")database.markJobNeedsReview(created.job_id,"prompt_acceptance_unknown","unknown");
  return {database,config,source,job:database.getJob(created.job_id)!};
}

describe("read-only live session reconciliation",()=>{
  test("operatorだけが停止receiptと固定digestで遅延Resultを受理し再起動後も同一要求を再読できる",async()=>{
    const state=await addressableJob("needs_review","late-result");
    state.database.markJobNeedsReview(state.job.job_id,"result_missing","missing at terminal observation");
    state.database.sealJobGroup(state.source.event_id);
    state.database.enqueueJobNotification(state.job.job_id);
    const current=state.database.getJob(state.job.job_id)!;
    const result={schema_version:1,job_id:current.job_id,status:"completed",summary:"作業完了",completed_at:new Date().toISOString()} as const;
    await fs.mkdir(current.result_path.slice(0,current.result_path.lastIndexOf("/")),{recursive:true});
    await fs.writeFile(current.result_path,JSON.stringify(result));
    const supervisor=new JobSupervisor(state.database,runtimeWith(()=>({ok:false,stdout:"",stderr:"",exitCode:1,timedOut:false,aborted:false,errorCode:"agent_not_found"}),[]),state.config,logger,()=>{});
    const receipt=await supervisor.observeLiveSession(current.job_id,state.source.event_id);
    const preview=state.database.inspectLateJobResult(current.job_id);
    const sideEffects=createHash("sha256").update("reviewed side effects").digest("hex");
    assert.throws(()=>state.database.saveJobResult(current.job_id,result,current.result_path),/Invalid status transition/);
    const args=[current.job_id,current.updated_at,"result_missing",preview.result_sha256,receipt.receipt_id,sideEffects,preview.notification_evidence_sha256] as const;
    assert.throws(()=>state.database.acceptLateJobResult(current.job_id,current.updated_at,"result_missing",preview.result_sha256,"wrong",sideEffects,preview.notification_evidence_sha256),/worker_stop_unproven/);
    const accepted=state.database.acceptLateJobResult(...args);
    assert.equal(accepted.status,"completed");
    assert.equal(JSON.parse(accepted.result_json!).summary,"作業完了");
    assert.ok(accepted.completion_event_id);
    const stopProofDb=new Database(state.config.databasePath);
    assert.ok(stopProofDb.prepare("SELECT 1 FROM job_terminal_worker_stop_proofs WHERE job_id=?").get(current.job_id));
    stopProofDb.close();
    state.database.close();
    const reopened=new DispatcherDatabase(state.config.databasePath);
    assert.equal(reopened.acceptLateJobResult(...args).updated_at,accepted.updated_at);
    assert.equal(reopened.liveSessionRetentionPlan("9999-01-01T00:00:00.000Z").receipt_rows,0);
    reopened.purgeLiveSessionReceipts("9999-01-01T00:00:00.000Z");
    assert.ok(reopened.getLiveSessionReceipt(current.job_id,receipt.receipt_id));
    const raw=new Database(state.config.databasePath);
    assert.throws(()=>raw.prepare("DELETE FROM live_session_query_receipts WHERE receipt_id=?").run(receipt.receipt_id),/FOREIGN KEY/);
    raw.close();
    assert.throws(()=>reopened.acceptLateJobResult(current.job_id,current.updated_at,"invalid_result",preview.result_sha256,receipt.receipt_id,sideEffects,preview.notification_evidence_sha256),/reconciliation_conflict/);
    reopened.close();
  });

  test("遅延Resultはdigest drift、CAS、停止証跡欠落、通知曖昧を拒否する",async()=>{
    const state=await addressableJob("needs_review","late-rejections");
    state.database.markJobNeedsReview(state.job.job_id,"invalid_result","invalid at terminal observation");
    state.database.sealJobGroup(state.source.event_id);
    const current=state.database.getJob(state.job.job_id)!;
    await fs.mkdir(current.result_path.slice(0,current.result_path.lastIndexOf("/")),{recursive:true});
    await fs.writeFile(current.result_path,JSON.stringify({schema_version:1,job_id:current.job_id,status:"failed",summary:"失敗",completed_at:new Date().toISOString()}));
    const preview=state.database.inspectLateJobResult(current.job_id);
    const digest=createHash("sha256").update("reviewed").digest("hex");
    assert.throws(()=>state.database.acceptLateJobResult(current.job_id,current.updated_at,"invalid_result",preview.result_sha256,"missing",digest,preview.notification_evidence_sha256),/worker_stop_unproven/);
    const supervisor=new JobSupervisor(state.database,runtimeWith(()=>({ok:false,stdout:"",stderr:"",exitCode:1,timedOut:false,aborted:false,errorCode:"agent_not_found"}),[]),state.config,logger,()=>{});
    const receipt=await supervisor.observeLiveSession(current.job_id,state.source.event_id);
    const args=[current.job_id,current.updated_at,"invalid_result",preview.result_sha256,receipt.receipt_id,digest,preview.notification_evidence_sha256] as const;
    assert.throws(()=>state.database.acceptLateJobResult(current.job_id,"stale","invalid_result",preview.result_sha256,receipt.receipt_id,digest,preview.notification_evidence_sha256),/job_changed/);
    await fs.appendFile(current.result_path," ");
    assert.throws(()=>state.database.acceptLateJobResult(...args),/digest_drift/);
    assert.equal(state.database.getJob(current.job_id)?.status,"needs_review");
    await fs.writeFile(current.result_path,JSON.stringify({schema_version:1,job_id:current.job_id,status:"failed",summary:"失敗",completed_at:new Date().toISOString()}));
    const refreshed=state.database.inspectLateJobResult(current.job_id);
    const prior=state.database.enqueueJobNotification(current.job_id).row;
    state.database.beginDispatch(prior.event_id,`${state.config.resultsDir}/ambiguous.json`);
    const latestJob=state.database.getJob(current.job_id)!;
    const latestReceipt=await supervisor.observeLiveSession(current.job_id,state.source.event_id);
    assert.throws(()=>state.database.acceptLateJobResult(current.job_id,latestJob.updated_at,"invalid_result",refreshed.result_sha256,latestReceipt.receipt_id,digest,state.database.inspectLateJobResult(current.job_id).notification_evidence_sha256),/notification_requires_reconciliation/);
    state.database.close();
  });
  test("配送済みattentionのidentityを保持し、確定Resultの通知を作る",async()=>{
    const state=await addressableJob("needs_review","late-delivered");
    state.database.markJobNeedsReview(state.job.job_id,"result_missing","missing");
    state.database.sealJobGroup(state.source.event_id);
    const attention=state.database.enqueueJobNotification(state.job.job_id).row;
    state.database.beginDispatch(attention.event_id,`${state.config.resultsDir}/attention.json`);
    state.database.markWaiting(attention.event_id);
    state.database.saveCompleted(attention.event_id,{schema_version:1,event_id:attention.event_id,status:"completed",
      summary:"attention delivered",completed_at:new Date().toISOString(),actions:[
        {tool:"dona_slack.post_message",workspace_id:"T_TEST",channel_id:"C_TEST",thread_ts:"1756722030.123456",message_ts:"123.456"},
        {tool:"dona_slack.set_agent_session_status",workspace_id:"T_TEST",channel_id:"C_TEST",thread_ts:"1756722030.123456",status:"suspended"}]},
      `${state.config.resultsDir}/attention.json`);
    const current=state.database.getJob(state.job.job_id)!;
    await fs.mkdir(current.result_path.slice(0,current.result_path.lastIndexOf("/")),{recursive:true});
    await fs.writeFile(current.result_path,JSON.stringify({schema_version:1,job_id:current.job_id,status:"completed",summary:"完了",completed_at:new Date().toISOString()}));
    const supervisor=new JobSupervisor(state.database,runtimeWith(()=>({ok:false,stdout:"",stderr:"",exitCode:1,timedOut:false,aborted:false,errorCode:"agent_not_found"}),[]),state.config,logger,()=>{});
    const receipt=await supervisor.observeLiveSession(current.job_id,state.source.event_id);
    const preview=state.database.inspectLateJobResult(current.job_id);
    const digest=createHash("sha256").update("reviewed").digest("hex");
    const accepted=state.database.acceptLateJobResult(current.job_id,current.updated_at,"result_missing",preview.result_sha256,
      receipt.receipt_id,digest,preview.notification_evidence_sha256);
    assert.equal(state.database.get(attention.event_id)?.status,"completed");
    assert.equal(state.database.getJobGroup(state.source.event_id)?.attention_event_id,attention.event_id);
    assert.notEqual(accepted.completion_event_id,attention.event_id);
    state.database.close();
  });
  test("FIFOのfinal Resultを待たずに拒否する",async()=>{
    const state=await addressableJob();
    await fs.mkdir(state.job.result_path.slice(0,state.job.result_path.lastIndexOf("/")),{recursive:true});
    execFileSync("mkfifo",[state.job.result_path]);
    assert.throws(()=>state.database.inspectLateJobResult(state.job.job_id),/late_result_file_invalid/);
    state.database.close();
  });
  test("同groupの完了済みprogress通知は外部操作なしの場合に受理する",async()=>{
    const state=await addressableJob("needs_review","late-progress");
    state.database.markJobNeedsReview(state.job.job_id,"result_missing","missing");
    const sibling=state.database.createJob({source_event_id:state.source.event_id,job_key:"attention-owner",
      objective:"別作業",workspace:{kind:"scratch"}},state.config.jobsWorkspaceRoot,state.config.jobResultsDir).row;
    state.database.beginJobPreparation(sibling.job_id);
    state.database.setJobRuntime(sibling.job_id,"other-workspace","other-pane","other-session");
    state.database.beginJobDispatch(sibling.job_id);
    state.database.markJobNeedsReview(sibling.job_id,"prompt_acceptance_unknown","unknown");
    state.database.sealJobGroup(state.source.event_id);
    const attention=state.database.enqueueJobNotification(sibling.job_id).row;
    const progress=state.database.enqueueJobNotification(state.job.job_id).row;
    assert.equal((JSON.parse(progress.payload_json) as {group:{transition:string}}).group.transition,"progress");
    state.database.beginDispatch(progress.event_id,`${state.config.resultsDir}/progress.json`);
    state.database.markWaiting(progress.event_id);
    state.database.saveCompleted(progress.event_id,{schema_version:1,event_id:progress.event_id,status:"completed",
      summary:"progress",actions:[],completed_at:new Date().toISOString()},`${state.config.resultsDir}/progress.json`);
    const current=state.database.getJob(state.job.job_id)!;
    await fs.mkdir(current.result_path.slice(0,current.result_path.lastIndexOf("/")),{recursive:true});
    await fs.writeFile(current.result_path,JSON.stringify({schema_version:1,job_id:current.job_id,status:"completed",summary:"完了",completed_at:new Date().toISOString()}));
    const supervisor=new JobSupervisor(state.database,runtimeWith(()=>({ok:false,stdout:"",stderr:"",exitCode:1,timedOut:false,aborted:false,errorCode:"agent_not_found"}),[]),state.config,logger,()=>{});
    const receipt=await supervisor.observeLiveSession(current.job_id,state.source.event_id);
    const preview=state.database.inspectLateJobResult(current.job_id);
    const digest=createHash("sha256").update("reviewed").digest("hex");
    const accepted=state.database.acceptLateJobResult(current.job_id,current.updated_at,"result_missing",preview.result_sha256,
      receipt.receipt_id,digest,preview.notification_evidence_sha256);
    assert.equal(accepted.status,"completed");
    assert.equal(state.database.get(progress.event_id)?.status,"completed");
    assert.equal(state.database.getJobGroup(state.source.event_id)?.attention_event_id,attention.event_id);
    state.database.close();
  });
  test("needs_reviewのattentionは最新のlive receiptとoperator確認でのみ解消する",async()=>{
    const state=await addressableJob("needs_review","review-attention");
    state.database.sealJobGroup(state.source.event_id);
    const attention=state.database.enqueueJobNotification(state.job.job_id).row;
    const supervisor=new JobSupervisor(state.database,runtimeWith(()=>({ok:false,stdout:"",stderr:"",exitCode:1,timedOut:false,aborted:false,errorCode:"agent_not_found"}),[]),state.config,logger,()=>{});
    const receipt=await supervisor.observeLiveSession(state.job.job_id,state.source.event_id);
    const current=state.database.getJob(state.job.job_id)!;
    assert.throws(()=>state.database.resolveNeedsReviewAttention(state.source.event_id,current.job_id,"wrong-event",
      receipt.receipt_id,current.updated_at),/binding_mismatch/);
    assert.throws(()=>state.database.resolveNeedsReviewAttention(state.source.event_id,current.job_id,attention.event_id,
      "wrong-receipt",current.updated_at),/receipt_mismatch/);
    const resolved=state.database.resolveNeedsReviewAttention(state.source.event_id,current.job_id,attention.event_id,
      receipt.receipt_id,current.updated_at);
    assert.equal(resolved.status,"failed");
    assert.equal(state.database.get(attention.event_id)?.last_error_code,"job_result_superseded");
    assert.ok(state.database.getJobGroup(state.source.event_id)?.all_terminal_event_id);
    state.database.close();
  });
  test("invalid Resultのoperator解決は最新receiptと状態の一致を要求する",async()=>{
    const state=await addressableJob("needs_review","invalid-result-first");
    state.database.markJobNeedsReview(state.job.job_id,"invalid_result","malformed Result");
    state.database.sealJobGroup(state.source.event_id);
    const prior=state.database.enqueueJobNotification(state.job.job_id).row;
    const supervisor=new JobSupervisor(state.database,runtimeWith(()=>({ok:false,stdout:"",stderr:"",exitCode:1,timedOut:false,aborted:false,errorCode:"agent_not_found"}),[]),state.config,logger,()=>{});
    const receipt=await supervisor.observeLiveSession(state.job.job_id,state.source.event_id);
    const current=state.database.getJob(state.job.job_id)!;
    assert.throws(()=>state.database.resolveInvalidJobResult(current.job_id,"unknown",current.updated_at),/live_session_receipt_mismatch/);
    assert.throws(()=>state.database.resolveInvalidJobResult(current.job_id,receipt.receipt_id,"stale"),/job_changed_since_review/);
    const newer=await supervisor.observeLiveSession(state.job.job_id,state.source.event_id);
    assert.throws(()=>state.database.resolveInvalidJobResult(current.job_id,receipt.receipt_id,current.updated_at),/newer_live_session_receipt_exists/);
    const resolved=state.database.resolveInvalidJobResult(current.job_id,newer.receipt_id,current.updated_at);
    assert.equal(resolved.status,"failed");
    assert.equal(resolved.last_error_code,"invalid_result_operator_resolved");
    assert.equal(resolved.result_json,null);
    assert.equal(state.database.get(prior.event_id)?.last_error_code,"job_result_superseded");
    assert.notEqual(resolved.completion_event_id,prior.event_id);
    assert.equal(state.database.get(resolved.completion_event_id!)?.event_type,"job_failed");
    assert.ok(state.database.getJobGroup(state.source.event_id)?.all_terminal_event_id);
    assert.throws(()=>state.database.resolveInvalidJobResult(current.job_id,receipt.receipt_id,resolved.updated_at),/job_invalid_result_reconciliation_unavailable/);
    state.database.close();
  });
  test("停止receipt後のidentity世代差し替えをoperator解決で拒否する",async()=>{
    const state=await addressableJob("needs_review","identity-generation-drift");
    state.database.markJobNeedsReview(state.job.job_id,"invalid_result","malformed Result");
    state.database.sealJobGroup(state.source.event_id);
    const attention=state.database.enqueueJobNotification(state.job.job_id).row;
    const supervisor=new JobSupervisor(state.database,runtimeWith(()=>({ok:false,stdout:"",stderr:"",exitCode:1,timedOut:false,aborted:false,errorCode:"agent_not_found"}),[]),state.config,logger,()=>{});
    const receipt=await supervisor.observeLiveSession(state.job.job_id,state.source.event_id);
    assert.ok(receipt.identity_generation_sha256);
    const current=state.database.getJob(state.job.job_id)!;
    const raw=new Database(state.config.databasePath);
    raw.prepare("UPDATE job_live_session_identities SET generation_nonce=? WHERE job_id=?")
      .run("replacement-generation",state.job.job_id);
    raw.close();
    assert.throws(()=>state.database.resolveInvalidJobResult(current.job_id,receipt.receipt_id,current.updated_at),
      /late_result_worker_stop_unproven/);
    assert.throws(()=>state.database.resolveNeedsReviewAttention(state.source.event_id,current.job_id,
      attention.event_id,receipt.receipt_id,current.updated_at),/late_result_worker_stop_unproven/);
    assert.equal(state.database.getJob(current.job_id)?.status,"needs_review");
    state.database.close();
  });
  test("receipt保存直前のidentity差し替えをunknownとして監査する",async()=>{
    const state=await addressableJob();
    const identity=state.database.getJobLiveSessionIdentity(state.job.job_id)!;
    const job=state.database.getJob(state.job.job_id)!;
    const startedAt="2026-09-26T00:00:00.000Z",completedAt="2026-09-26T00:00:01.000Z";
    const expectedIdentity=JSON.stringify(["workspace-private","pane-private",job.agent_name,"session-private"]);
    const absent=buildLiveSessionReceipt({before:job,after:job,bootId:"boot",startedAt,completedAt,
      expectedIdentity,result:{ok:false,stdout:"",stderr:"",exitCode:1,timedOut:false,aborted:false,errorCode:"agent_not_found"}});
    const observed=buildLiveSessionReceipt({before:job,after:job,bootId:"boot",startedAt,completedAt,
      expectedIdentity,result:{ok:true,stdout:"",stderr:"",exitCode:0,timedOut:false,aborted:false,
        agentStatus:"working",agentIdentity:expectedIdentity,stateChangeSeq:99}});
    const raw=new Database(state.config.databasePath);
    raw.prepare("UPDATE job_live_session_identities SET generation_nonce=? WHERE job_id=?")
      .run("replacement-generation",job.job_id);
    raw.close();
    for(const candidate of [absent,observed]) {
      const saved=state.database.appendLiveSessionReceipt(state.source.event_id,candidate,startedAt,identity);
      assert.equal(saved.reconciliation.state,"unknown");
      assert.equal(saved.identity_generation_sha256,null);
      assert.ok(saved.reconciliation.reason_codes.includes("identity_generation_changed_during_query"));
      assert.equal(state.database.getLiveSessionReceipt(job.job_id,saved.receipt_id)?.reconciliation.state,"unknown");
    }
    assert.equal(state.database.getJobLiveSessionIdentity(job.job_id)?.max_state_change_seq,null);
    state.database.close();
  });
  test("別jobのattentionではinvalid Resultを解消済みと記録しない",async()=>{
    const state=await addressableJob("needs_review","attention-owner");
    const sibling=state.database.createJob({source_event_id:state.source.event_id,job_key:"invalid-sibling",
      objective:"別調査",workspace:{kind:"scratch"}},state.config.jobsWorkspaceRoot,state.config.jobResultsDir).row;
    state.database.beginJobPreparation(sibling.job_id);
    state.database.setJobRuntime(sibling.job_id,"workspace-second","pane-second","session-second");
    state.database.beginJobDispatch(sibling.job_id);
    state.database.markJobNeedsReview(sibling.job_id,"invalid_result","malformed Result");
    state.database.sealJobGroup(state.source.event_id);
    const attention=state.database.enqueueJobNotification(state.job.job_id).row;
    state.database.enqueueJobNotification(sibling.job_id);
    state.database.beginDispatch(attention.event_id,`${state.config.resultsDir}/attention.json`);
    state.database.markWaiting(attention.event_id);
    state.database.saveCompleted(attention.event_id,{schema_version:1,event_id:attention.event_id,status:"completed",
      summary:"attention delivered",completed_at:"2026-09-05T00:00:00.000Z",
      actions:[{tool:"dona_slack.post_message",workspace_id:"T_TEST",channel_id:"C_TEST",thread_ts:"1756722030.123456",message_ts:"123.456"},
        {tool:"dona_slack.set_agent_session_status",workspace_id:"T_TEST",channel_id:"C_TEST",thread_ts:"1756722030.123456",status:"suspended"}]},
      `${state.config.resultsDir}/attention.json`);
    const supervisor=new JobSupervisor(state.database,runtimeWith(()=>({ok:false,stdout:"",stderr:"",exitCode:1,timedOut:false,aborted:false,errorCode:"agent_not_found"}),[]),state.config,logger,()=>{});
    const receipt=await supervisor.observeLiveSession(sibling.job_id,state.source.event_id);
    const current=state.database.getJob(sibling.job_id)!;
    const resolved=state.database.resolveInvalidJobResult(sibling.job_id,receipt.receipt_id,current.updated_at);
    assert.equal(resolved.status,"failed");
    const raw=new Database(state.config.databasePath);
    assert.equal(raw.prepare("SELECT 1 FROM job_attention_resolutions WHERE job_id=?").get(sibling.job_id),undefined);
    raw.close();
    assert.equal(state.database.getJobGroup(state.source.event_id)?.attention_event_id,attention.event_id);
    assert.equal(state.database.getJobGroup(state.source.event_id)?.all_terminal_event_id,null);
    state.database.close();
  });
  test("別のneeds_review原因で得たreceiptは後のinvalid Resultに使えない",async()=>{
    const state=await addressableJob();
    const supervisor=new JobSupervisor(state.database,runtimeWith(()=>({ok:false,stdout:"",stderr:"",exitCode:1,timedOut:false,aborted:false,errorCode:"agent_not_found"}),[]),state.config,logger,()=>{});
    const receipt=await supervisor.observeLiveSession(state.job.job_id,state.source.event_id);
    await new Promise(resolve=>setTimeout(resolve,5));
    state.database.markJobNeedsReview(state.job.job_id,"invalid_result","malformed Result");
    const current=state.database.getJob(state.job.job_id)!;
    assert.throws(()=>state.database.resolveInvalidJobResult(current.job_id,receipt.receipt_id,current.updated_at),/live_session_receipt_precedes_job_state/);
    assert.equal(state.database.getJob(current.job_id)?.status,"needs_review");
    state.database.close();
  });
  test("配達済みの旧通知を保持し確定状態の通知を追加する",async()=>{
    const state=await addressableJob("needs_review","invalid-result-delivered");
    state.database.markJobNeedsReview(state.job.job_id,"invalid_result","malformed Result");
    state.database.sealJobGroup(state.source.event_id);
    const prior=state.database.enqueueJobNotification(state.job.job_id).row;
    state.database.beginDispatch(prior.event_id,`${state.config.resultsDir}/attention.json`);
    state.database.markWaiting(prior.event_id);
    state.database.saveCompleted(prior.event_id,{schema_version:1,event_id:prior.event_id,status:"completed",
      summary:"attention delivered",completed_at:"2026-09-05T00:00:00.000Z",
      actions:[{tool:"dona_slack.post_message",workspace_id:"T_TEST",channel_id:"C_TEST",thread_ts:"1756722030.123456",message_ts:"123.456"},
        {tool:"dona_slack.set_agent_session_status",workspace_id:"T_TEST",channel_id:"C_TEST",thread_ts:"1756722030.123456",status:"suspended"}]},
      `${state.config.resultsDir}/attention.json`);
    const supervisor=new JobSupervisor(state.database,runtimeWith(()=>({ok:false,stdout:"",stderr:"",exitCode:1,timedOut:false,aborted:false,errorCode:"agent_not_found"}),[]),state.config,logger,()=>{});
    const receipt=await supervisor.observeLiveSession(state.job.job_id,state.source.event_id);
    const current=state.database.getJob(state.job.job_id)!;
    const resolved=state.database.resolveInvalidJobResult(current.job_id,receipt.receipt_id,current.updated_at);
    assert.equal(state.database.get(prior.event_id)?.status,"completed");
    assert.notEqual(resolved.completion_event_id,prior.event_id);
    assert.equal(state.database.get(resolved.completion_event_id!)?.event_type,"job_failed");
    assert.ok(state.database.getJobGroup(state.source.event_id)?.all_terminal_event_id);
    state.database.close();
  });
  test("exact identityのworkingを永続receiptへ記録しcontrol commandを呼ばない",async()=>{
    const state=await addressableJob();
    const calls:string[]=[];
    const runtime=runtimeWith(agentName=>({ok:true,stdout:"PRIVATE RAW",stderr:"",exitCode:0,timedOut:false,aborted:false,
      agentStatus:"working",agentIdentity:JSON.stringify(["workspace-private","pane-private",agentName,"session-private"]),stateChangeSeq:42}),calls);
    const supervisor=new JobSupervisor(state.database,runtime,state.config,logger,()=>{});
    const receipt=await supervisor.observeLiveSession(state.job.job_id,state.source.event_id);
    assert.equal(receipt.live_session.query_status,"observed");
    assert.equal(receipt.live_session.identity_match,true);
    assert.equal(receipt.reconciliation.state,"prompt_acceptance_possible_running");
    assert.deepEqual(calls,[`get:${state.job.agent_name}`]);
    assert.doesNotMatch(JSON.stringify(receipt),/workspace-private|pane-private|session-private|PRIVATE RAW|private objective/);
    const id=receipt.receipt_id;
    state.database.close();
    const reopened=new DispatcherDatabase(state.config.databasePath);
    assert.deepEqual(reopened.getLiveSessionReceipt(state.job.job_id,id),receipt);
    reopened.close();
  });

  test("identity mismatch・timeout・absence・malformedをfail closedに分類する",async()=>{
    for(const [name,result,query,state] of [
      ["mismatch",{ok:true,stdout:"",stderr:"",exitCode:0,timedOut:false,aborted:false,agentStatus:"working",agentIdentity:JSON.stringify(["other","pane-private","agent","session-private"]),stateChangeSeq:1},"observed","identity_conflict"],
      ["timeout",{ok:false,stdout:"",stderr:"secret",exitCode:null,timedOut:true,aborted:false},"query_timeout","unknown"],
      ["absent",{ok:false,stdout:"",stderr:"secret",exitCode:1,timedOut:false,aborted:false,errorCode:"agent_not_found"},"agent_not_found","session_absent"],
      ["stopped",{ok:false,stdout:"",stderr:"secret",exitCode:1,timedOut:false,aborted:false,errorCode:"agent_not_running"},"agent_not_found","session_absent"],
      ["malformed",{ok:true,stdout:"secret",stderr:"",exitCode:0,timedOut:false,aborted:false,agentStatus:"working"},"malformed_response","unknown"],
    ] as const){
      const current=await addressableJob();const calls:string[]=[];
      const supervisor=new JobSupervisor(current.database,runtimeWith(()=>result as HerdrCommandResult,calls),current.config,logger,()=>{});
      const receipt=await supervisor.observeLiveSession(current.job.job_id,current.source.event_id);
      assert.equal(receipt.live_session.query_status,query,name);
      assert.equal(receipt.reconciliation.state,state,name);
      assert.equal(receipt.reconciliation.confidence,"fail_closed",name);
      assert.equal(receipt.reconciliation.safe_next_action,"do_not_retry",name);
      assert.equal(calls.length,1,name);current.database.close();
    }
  });

  test("legacy identity欠落ではHerdrを探索せずnot_addressableを監査する",async()=>{
    const {root,config}=await tempConfig();roots.push(root);const database=new DispatcherDatabase(config.databasePath);
    const source=database.enqueue(eventEnvelope("Ev-live-legacy")).row;
    const job=database.createJob({source_event_id:source.event_id,job_key:"legacy-identity",objective:"legacy",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
    const calls:string[]=[];const supervisor=new JobSupervisor(database,runtimeWith(()=>{throw new Error("must not run");},calls),config,logger,()=>{});
    const receipt=await supervisor.observeLiveSession(job.job_id,source.event_id);
    assert.equal(receipt.live_session.query_status,"not_addressable");
    assert.equal(receipt.reconciliation.state,"not_addressable");
    database.markJobNeedsReview(job.job_id,"invalid_result","malformed Result");
    const after=await supervisor.observeLiveSession(job.job_id,source.event_id);
    const current=database.getJob(job.job_id)!;
    assert.throws(()=>database.resolveInvalidJobResult(job.job_id,after.receipt_id,current.updated_at),
      /late_result_worker_stop_unproven/);
    database.sealJobGroup(source.event_id);
    const attention=database.enqueueJobNotification(job.job_id).row;
    const refreshed=database.getJob(job.job_id)!;
    const latest=await supervisor.observeLiveSession(job.job_id,source.event_id);
    assert.throws(()=>database.resolveNeedsReviewAttention(source.event_id,job.job_id,attention.event_id,
      latest.receipt_id,refreshed.updated_at),/late_result_worker_stop_unproven/);
    assert.equal(database.getJob(job.job_id)?.status,"needs_review");
    assert.deepEqual(calls,[]);database.close();
  });

  test("durable/live state tableは自動復活せずResult有無とterminal conflictを分離する",()=>{
    const base={job_id:"job_table",status:"needs_review",prompt_accepted_at:null,result_json:null} as JobRow;
    const observed={ok:true,stdout:"",stderr:"",exitCode:0,timedOut:false,aborted:false,agentStatus:"done",agentIdentity:"expected",stateChangeSeq:9} as HerdrCommandResult;
    const missing=buildLiveSessionReceipt({before:base,after:base,bootId:"boot",startedAt:"2026-09-21T00:00:00Z",completedAt:"2026-09-21T00:00:01Z",expectedIdentity:"expected",result:observed});
    assert.equal(missing.reconciliation.state,"terminal_result_missing");
    const withResult={...base,result_json:"{}"};
    assert.equal(buildLiveSessionReceipt({before:withResult,after:withResult,bootId:"boot",startedAt:"2026-09-21T00:00:00Z",completedAt:"2026-09-21T00:00:01Z",expectedIdentity:"expected",result:observed}).reconciliation.state,"terminal_result_available");
    const terminal={...base,status:"completed" as const,result_json:"{}"};
    const working={...observed,agentStatus:"working" as const};
    assert.equal(buildLiveSessionReceipt({before:terminal,after:terminal,bootId:"boot",startedAt:"2026-09-21T00:00:00Z",completedAt:"2026-09-21T00:00:01Z",expectedIdentity:"expected",result:working}).reconciliation.state,"durable_live_conflict");
  });

  test("独立schemaはcore user_versionとjobs列を変えず旧binary互換、receiptはupdate不可でretention削除可能",async()=>{
    const state=await addressableJob();const calls:string[]=[];
    const supervisor=new JobSupervisor(state.database,runtimeWith(agentName=>({ok:true,stdout:"",stderr:"",exitCode:0,timedOut:false,aborted:false,
      agentStatus:"blocked",agentIdentity:JSON.stringify(["workspace-private","pane-private",agentName,"session-private"]),stateChangeSeq:3}),calls),state.config,logger,()=>{});
    const receipt=await supervisor.observeLiveSession(state.job.job_id,state.source.event_id);state.database.close();
    const raw=new Database(state.config.databasePath);raw.pragma("foreign_keys=ON");
    assert.equal(raw.pragma("user_version",{simple:true}),3);
    const columns=(raw.prepare("PRAGMA table_info(jobs)").all() as Array<{name:string}>).map(row=>row.name);
    assert.equal(columns.includes("herdr_agent_session_id"),false);
    assert.doesNotThrow(()=>raw.prepare("UPDATE jobs SET updated_at=updated_at WHERE job_id=?").run(state.job.job_id));
    assert.throws(()=>raw.prepare("UPDATE live_session_query_receipts SET duration_ms=0 WHERE receipt_id=?").run(receipt.receipt_id),/append_only/);
    raw.close();
    const reopened=new DispatcherDatabase(state.config.databasePath);
    assert.equal(reopened.liveSessionRetentionPlan("9999-01-01T00:00:00Z").receipt_rows,1);
    assert.equal(reopened.purgeLiveSessionReceipts("9999-01-01T00:00:00Z").receipt_rows,1);
    assert.equal(reopened.getLiveSessionReceipt(state.job.job_id,receipt.receipt_id),undefined);reopened.close();
  });

  test("core v2で作成した独立schemaは旧binary rollback後のv3 migrationを妨げない",()=>{
    const raw=new Database(":memory:");raw.pragma("foreign_keys=ON");
    migrateDispatcherDatabase(raw,()=>{},false,2);
    migrateLiveSession(raw);
    assert.equal(raw.pragma("user_version",{simple:true}),2);
    assert.deepEqual(raw.prepare("PRAGMA foreign_key_list(job_live_session_identities)").all(),[]);
    assert.deepEqual(raw.prepare("PRAGMA foreign_key_list(live_session_query_receipts)").all(),[]);
    assert.doesNotThrow(()=>migrateDispatcherDatabase(raw,()=>{},false,3));
    assert.equal(raw.pragma("user_version",{simple:true}),3);raw.close();
  });

  test("初期version 1 identity tableへruntime世代列をadditive migrationする",()=>{
    const raw=new Database(":memory:");
    raw.exec(`CREATE TABLE live_session_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version=1));
      INSERT INTO live_session_schema VALUES(1,1);
      CREATE TABLE job_live_session_identities(job_id TEXT PRIMARY KEY,identity_version INTEGER NOT NULL CHECK(identity_version=1),
        herdr_agent_session_id TEXT NOT NULL,recorded_at TEXT NOT NULL);
      INSERT INTO job_live_session_identities VALUES('job_old',1,'session-old','2026-09-21T00:00:00Z');`);
    migrateLiveSession(raw);
    const columns=new Set((raw.prepare("PRAGMA table_info(job_live_session_identities)").all() as Array<{name:string}>).map(row=>row.name));
    assert.equal(columns.has("herdr_workspace_id"),true);assert.equal(columns.has("herdr_pane_id"),true);assert.equal(columns.has("agent_name"),true);assert.equal(columns.has("max_state_change_seq"),true);
    const migrated=raw.prepare("SELECT herdr_workspace_id,herdr_pane_id,agent_name,max_state_change_seq FROM job_live_session_identities").get() as Record<string,unknown>;
    assert.deepEqual(migrated,{herdr_workspace_id:null,herdr_pane_id:null,agent_name:null,max_state_change_seq:null});raw.close();
  });

  test("fresh schemaは旧version 1 writerの4列INSERTを許可する",()=>{
    const raw=new Database(":memory:");migrateLiveSession(raw);
    assert.doesNotThrow(()=>raw.prepare(`INSERT INTO job_live_session_identities(
      job_id,identity_version,herdr_agent_session_id,recorded_at) VALUES(?,1,?,?)`).run("job_old","session-old","2026-09-21T00:00:00Z"));
    const row=raw.prepare("SELECT herdr_workspace_id,herdr_pane_id,agent_name,max_state_change_seq FROM job_live_session_identities").get() as Record<string,unknown>;
    assert.deepEqual(row,{herdr_workspace_id:null,herdr_pane_id:null,agent_name:null,max_state_change_seq:null});raw.close();
  });

  test("並行queryは独立したappend-only receiptを作る",async()=>{
    const state=await addressableJob();const calls:string[]=[];
    const supervisor=new JobSupervisor(state.database,runtimeWith(agentName=>({ok:true,stdout:"",stderr:"",exitCode:0,timedOut:false,aborted:false,
      agentStatus:"working",agentIdentity:JSON.stringify(["workspace-private","pane-private",agentName,"session-private"]),stateChangeSeq:7}),calls),state.config,logger,()=>{});
    const receipts=await Promise.all(Array.from({length:8},()=>supervisor.observeLiveSession(state.job.job_id,state.source.event_id)));
    assert.equal(new Set(receipts.map(row=>row.receipt_id)).size,8);assert.equal(calls.length,8);state.database.close();
  });

  test("同一identityのstate sequence退行はfail closedにする",async()=>{
    const state=await addressableJob();const calls:string[]=[];let sequence=12;
    const supervisor=new JobSupervisor(state.database,runtimeWith(agentName=>({ok:true,stdout:"",stderr:"",exitCode:0,timedOut:false,aborted:false,
      agentStatus:"working",agentIdentity:JSON.stringify(["workspace-private","pane-private",agentName,"session-private"]),stateChangeSeq:sequence}),calls),state.config,logger,()=>{});
    assert.equal((await supervisor.observeLiveSession(state.job.job_id,state.source.event_id)).reconciliation.confidence,"bounded_observation");
    sequence=11;const regressed=await supervisor.observeLiveSession(state.job.job_id,state.source.event_id);
    assert.equal(regressed.reconciliation.state,"unknown");assert.equal(regressed.reconciliation.confidence,"fail_closed");
    assert.equal(regressed.reconciliation.safe_next_action,"do_not_retry");
    assert.ok(regressed.reconciliation.reason_codes.includes("state_sequence_regressed"));
    const repeated=await supervisor.observeLiveSession(state.job.job_id,state.source.event_id);
    assert.equal(repeated.reconciliation.state,"unknown");assert.ok(repeated.reconciliation.reason_codes.includes("state_sequence_regressed"));state.database.close();
  });

  test("事前分類が並行してもreceipt追記transaction内でsequence退行をfail closedにする",async()=>{
    const state=await addressableJob();
    const identity=state.database.getJobLiveSessionIdentity(state.job.job_id)!;
    const expectedIdentity=JSON.stringify(["workspace-private","pane-private",state.job.agent_name,"session-private"]);
    const result=(sequence:number):HerdrCommandResult=>({ok:true,stdout:"",stderr:"",exitCode:0,timedOut:false,aborted:false,
      agentStatus:"working",agentIdentity:expectedIdentity,stateChangeSeq:sequence});
    const receipt=(sequence:number,offset:number)=>buildLiveSessionReceipt({before:state.job,after:state.job,bootId:"boot",
      startedAt:`2026-09-21T00:00:0${offset}Z`,completedAt:`2026-09-21T00:00:0${offset+1}Z`,
      expectedIdentity,result:result(sequence)});
    const newer=state.database.appendLiveSessionReceipt(state.source.event_id,receipt(12,0),"2026-09-21T00:00:00Z",identity);
    assert.equal(newer.reconciliation.confidence,"bounded_observation");
    const stale=state.database.appendLiveSessionReceipt(state.source.event_id,receipt(11,2),"2026-09-21T00:00:02Z",identity);
    assert.equal(stale.reconciliation.state,"unknown");assert.equal(stale.reconciliation.confidence,"fail_closed");
    assert.equal(stale.reconciliation.safe_next_action,"do_not_retry");
    assert.ok(stale.reconciliation.reason_codes.includes("state_sequence_regressed"));
    assert.deepEqual(state.database.getLiveSessionReceipt(state.job.job_id,stale.receipt_id),stale);state.database.close();
  });

  test("同じruntime identityで再準備してもgenerationとsequence high-waterを保持する",async()=>{
    const state=await addressableJob();const calls:string[]=[];
    const firstSupervisor=new JobSupervisor(state.database,runtimeWith(agentName=>({ok:true,stdout:"",stderr:"",exitCode:0,timedOut:false,aborted:false,
      agentStatus:"working",agentIdentity:JSON.stringify(["workspace-private","pane-private",agentName,"session-private"]),stateChangeSeq:12}),calls),state.config,logger,()=>{});
    await firstSupervisor.observeLiveSession(state.job.job_id,state.source.event_id);
    const originalIdentity=state.database.getJobLiveSessionIdentity(state.job.job_id)!;state.database.close();
    const raw=new Database(state.config.databasePath);
    raw.prepare("UPDATE jobs SET status='retryable_failed',available_at=? WHERE job_id=?")
      .run("2026-09-21T00:00:00Z",state.job.job_id);raw.close();
    const reopened=new DispatcherDatabase(state.config.databasePath);
    reopened.beginJobPreparation(state.job.job_id,new Date("2026-09-21T00:00:01Z"));
    reopened.setJobRuntime(state.job.job_id,"workspace-private","pane-private","session-private",new Date("2026-09-21T01:00:00Z"));
    assert.deepEqual(reopened.getJobLiveSessionIdentity(state.job.job_id),originalIdentity);
    reopened.beginJobDispatch(state.job.job_id);reopened.markJobNeedsReview(state.job.job_id,"prompt_acceptance_unknown","unknown");
    const retrySupervisor=new JobSupervisor(reopened,runtimeWith(agentName=>({ok:true,stdout:"",stderr:"",exitCode:0,timedOut:false,aborted:false,
      agentStatus:"working",agentIdentity:JSON.stringify(["workspace-private","pane-private",agentName,"session-private"]),stateChangeSeq:11}),calls),state.config,logger,()=>{});
    const regressed=await retrySupervisor.observeLiveSession(state.job.job_id,state.source.event_id);
    assert.equal(regressed.reconciliation.state,"unknown");assert.ok(regressed.reconciliation.reason_codes.includes("state_sequence_regressed"));reopened.close();
  });

  test("rollback中にruntime列だけ更新されたidentity世代は照合しない",async()=>{
    const state=await addressableJob();state.database.close();
    const raw=new Database(state.config.databasePath);
    raw.prepare("UPDATE jobs SET herdr_workspace_id=?,herdr_pane_id=? WHERE job_id=?").run("rollback-workspace","rollback-pane",state.job.job_id);
    raw.close();
    const reopened=new DispatcherDatabase(state.config.databasePath);const calls:string[]=[];
    const supervisor=new JobSupervisor(reopened,runtimeWith(()=>{throw new Error("must not query stale identity");},calls),state.config,logger,()=>{});
    const receipt=await supervisor.observeLiveSession(state.job.job_id,state.source.event_id);
    assert.equal(receipt.live_session.query_status,"not_addressable");assert.deepEqual(calls,[]);reopened.close();
  });

  test("query中にidentity世代が変わった観測はfail closedにする",async()=>{
    const state=await addressableJob();const calls:string[]=[];
    const supervisor=new JobSupervisor(state.database,runtimeWith(agentName=>{
      const raw=new Database(state.config.databasePath);
      raw.transaction(()=>{
        raw.prepare("UPDATE jobs SET herdr_workspace_id=?,herdr_pane_id=? WHERE job_id=?").run("workspace-new","pane-new",state.job.job_id);
        raw.prepare(`UPDATE job_live_session_identities SET herdr_agent_session_id=?,herdr_workspace_id=?,herdr_pane_id=?,recorded_at=? WHERE job_id=?`)
          .run("session-new","workspace-new","pane-new","2026-09-21T01:00:00Z",state.job.job_id);
      })();raw.close();
      return {ok:true,stdout:"",stderr:"",exitCode:0,timedOut:false,aborted:false,agentStatus:"working",
        agentIdentity:JSON.stringify(["workspace-private","pane-private",agentName,"session-private"]),stateChangeSeq:20};
    },calls),state.config,logger,()=>{});
    const receipt=await supervisor.observeLiveSession(state.job.job_id,state.source.event_id);
    assert.equal(receipt.reconciliation.state,"unknown");assert.equal(receipt.reconciliation.confidence,"fail_closed");
    assert.equal(receipt.live_session.identity_match,null);assert.ok(receipt.reconciliation.reason_codes.includes("identity_generation_changed_during_query"));state.database.close();
  });

  test("retentionでreceiptを削除してもidentity世代のsequence high-waterを保持する",async()=>{
    const state=await addressableJob();const calls:string[]=[];let sequence=12;
    const supervisor=new JobSupervisor(state.database,runtimeWith(agentName=>({ok:true,stdout:"",stderr:"",exitCode:0,timedOut:false,aborted:false,
      agentStatus:"working",agentIdentity:JSON.stringify(["workspace-private","pane-private",agentName,"session-private"]),stateChangeSeq:sequence}),calls),state.config,logger,()=>{});
    await supervisor.observeLiveSession(state.job.job_id,state.source.event_id);
    assert.equal(state.database.purgeLiveSessionReceipts("9999-01-01T00:00:00Z").receipt_rows,1);
    sequence=11;const regressed=await supervisor.observeLiveSession(state.job.job_id,state.source.event_id);
    assert.equal(regressed.reconciliation.state,"unknown");assert.ok(regressed.reconciliation.reason_codes.includes("state_sequence_regressed"));state.database.close();
  });
});
