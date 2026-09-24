import assert from "node:assert/strict";
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
    const job=database.createJob({source_event_id:source.event_id,objective:"legacy",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
    const calls:string[]=[];const supervisor=new JobSupervisor(database,runtimeWith(()=>{throw new Error("must not run");},calls),config,logger,()=>{});
    const receipt=await supervisor.observeLiveSession(job.job_id,source.event_id);
    assert.equal(receipt.live_session.query_status,"not_addressable");
    assert.equal(receipt.reconciliation.state,"not_addressable");
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
