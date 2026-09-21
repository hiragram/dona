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

async function addressableJob(status:"dispatching"|"needs_review"="needs_review"){
  const {root,config}=await tempConfig();roots.push(root);
  const database=new DispatcherDatabase(config.databasePath);
  const source=database.enqueue(eventEnvelope(`Ev-live-${root.slice(-6)}`)).row;
  const created=database.createJob({source_event_id:source.event_id,objective:"private objective",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
  database.beginJobPreparation(created.job_id);
  database.setJobRuntime(created.job_id,"workspace-private","pane-private","session-private");
  database.beginJobDispatch(created.job_id);
  if(status==="needs_review")database.markJobNeedsReview(created.job_id,"prompt_acceptance_unknown","unknown");
  return {database,config,source,job:database.getJob(created.job_id)!};
}

describe("read-only live session reconciliation",()=>{
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
    assert.equal(columns.has("herdr_workspace_id"),true);assert.equal(columns.has("herdr_pane_id"),true);assert.equal(columns.has("agent_name"),true);
    const migrated=raw.prepare("SELECT herdr_workspace_id,herdr_pane_id,agent_name FROM job_live_session_identities").get() as Record<string,unknown>;
    assert.deepEqual(migrated,{herdr_workspace_id:null,herdr_pane_id:null,agent_name:null});raw.close();
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
});
