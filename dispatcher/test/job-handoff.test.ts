import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { DispatcherApi } from "../src/api.js";
import { DispatcherApiClient } from "../src/client.js";
import { DispatcherDatabase } from "../src/database.js";
import { JobSupervisor } from "../src/job-supervisor.js";
import type { JobAgentRuntime } from "../src/job-runtime.js";
import { processTree, workspaceJobId, type WorkerObservation } from "../src/job-handoff.js";
import { buildJobPrompt, jobProgressPath } from "../src/job-prompt.js";
import { eventEnvelope, tempConfig } from "./helpers.js";

const logger = {debug(){},info(){},warn(){},error(){}};
const inactive = (): WorkerObservation => ({state:"inactive",reason:"agent_idle",observed_at:new Date().toISOString(),process_ids:[123,124],process_groups:[123]});
async function fixture() {
  const {root,config} = await tempConfig();
  const db = new DispatcherDatabase(config.databasePath);
  const event = db.enqueue(eventEnvelope("original")).row;
  const job = db.createJob({source_event_id:event.event_id,job_key:"work",objective:"実装してPRを提出",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
  db.beginJobPreparation(job.job_id); db.setJobRuntime(job.job_id,"w1","w1:p1"); db.beginJobDispatch(job.job_id); db.markJobRunning(job.job_id);
  db.markJobNeedsReview(job.job_id,"agent_wait_failed","network interruption");
  const follow = db.enqueue(eventEnvelope("resume")).row;
  await fs.mkdir(job.workspace_path,{recursive:true});
  await fs.writeFile(path.join(job.workspace_path,"unfinished.txt"),"未完了の変更");
  let retired = false, closes = 0, observations = 0;
  const runtime: JobAgentRuntime = {
    async prepare(){throw new Error("not expected");}, async get(){throw new Error("not expected");},
    async prompt(){throw new Error("not expected");}, async wait(){throw new Error("not expected");}, async cancel(){throw new Error("not expected");},
    async observeWorker(){observations++;return inactive();}, async retireWorker(){closes++;retired=true;}, async workerRetired(){return retired;},
  };
  const supervisor = () => new JobSupervisor(db,runtime,config,logger,()=>{});
  return {root,config,db,job,follow,runtime,supervisor,closes:()=>closes,observations:()=>observations,retire:()=>{retired=true;},
    async dispose(){db.close();await fs.rm(root,{recursive:true,force:true});}};
}

test("停止確認後は新jobとResultを発行し、worktree・未保存成果・元依頼を継承する",async()=>{
  const f=await fixture();try {
    const result=await f.supervisor().resumeJob(f.job.job_id,f.follow.event_id,"残作業を引継ぐ");
    assert.equal(result.outcome,"created");assert.notEqual(result.job_id,f.job.job_id);
    const next=f.db.getJob(String(result.job_id))!;
    assert.equal(next.workspace_path,f.job.workspace_path);assert.notEqual(next.result_path,f.job.result_path);
    assert.equal(next.agent_name,next.job_id);assert.equal(next.status,"queued");assert.equal(workspaceJobId(next),f.job.job_id);
    assert.match(next.objective,/実装してPR/);assert.match(next.objective,/外部操作の受理状況/);
    assert.equal(await fs.readFile(path.join(next.workspace_path,"unfinished.txt"),"utf8"),"未完了の変更");
    assert.equal(f.db.getJob(f.job.job_id)!.status,"cancelled");
    assert.match(buildJobPrompt(next),new RegExp(f.job.job_id));
    assert.notEqual(jobProgressPath(next),jobProgressPath(f.job));
    assert.equal((await f.supervisor().resumeJob(f.job.job_id,f.follow.event_id,"残作業を引継ぐ")).job_id,next.job_id);
    assert.equal(f.closes(),1);
    await assert.rejects(f.supervisor().resumeJob(f.job.job_id,f.follow.event_id,"別の依頼"),/instruction_conflict/);
  } finally {await f.dispose();}
});

for (const state of ["working","waiting","unknown"] as const) test(`${state}はstatusだけで引継がず照会結果を返す`,async()=>{
  const f=await fixture();try {
    f.runtime.observeWorker=async()=>({...inactive(),state});
    const result=await f.supervisor().resumeJob(f.job.job_id,f.follow.event_id,"続ける");
    assert.equal(result.outcome,"not_resumed");assert.equal(f.closes(),0);
    assert.equal(f.db.getJob(f.job.job_id)!.status,"needs_review");
  } finally {await f.dispose();}
});

test("停止応答喪失は再送せず、再起動後も保存証拠をread-only照合して一度だけ引継ぐ",async()=>{
  const f=await fixture();try {
    let sends=0;
    f.runtime.retireWorker=async()=>{sends++;throw new Error("timeout");};
    const pending=await f.supervisor().resumeJob(f.job.job_id,f.follow.event_id,"続ける");
    assert.equal(pending.outcome,"retirement_pending");
    assert.equal((await f.supervisor().resumeJob(f.job.job_id,f.follow.event_id,"続ける")).outcome,"retirement_pending");
    await assert.rejects(f.supervisor().cancel(f.job.job_id,f.follow.event_id),/handoff_retirement_pending/);
    f.db.recoverStaleJobs();
    f.retire();
    assert.equal((await f.supervisor().resumeJob(f.job.job_id,f.follow.event_id,"続ける")).outcome,"created");
    assert.equal(sends,1);
  } finally {await f.dispose();}
});

test("並行再開は一つの停止要求と後継jobへ集約される",async()=>{
  const f=await fixture();try {
    const s=f.supervisor();const results=await Promise.all([s.resumeJob(f.job.job_id,f.follow.event_id,"続ける"),s.resumeJob(f.job.job_id,f.follow.event_id,"続ける")]);
    assert.equal(results[0]!.job_id,results[1]!.job_id);assert.equal(f.closes(),1);
  } finally {await f.dispose();}
});

test("観測中のdurable driftと直前の稼働再開を拒否する",async()=>{
  const f=await fixture();try {
    let count=0;f.runtime.observeWorker=async()=>{count++;if(count===2) f.db.markJobNeedsReview(f.job.job_id,"changed","changed");return inactive();};
    await assert.rejects(f.supervisor().resumeJob(f.job.job_id,f.follow.event_id,"続ける"),/job_changed/);
    assert.equal(f.closes(),0);
    count=0;f.runtime.observeWorker=async()=>({...inactive(),state:++count===2?"working":"inactive"});
    assert.equal((await f.supervisor().resumeJob(f.job.job_id,f.follow.event_id,"続ける")).outcome,"not_resumed");assert.equal(f.closes(),0);
  } finally {await f.dispose();}
});

test("別channelは観測前に拒否し、遅着Resultは後継へ取り込まない",async()=>{
  const f=await fixture();try {
    const other=eventEnvelope("other");other.reply_target={...other.reply_target,channel_id:"COTHER"};other.subject={...other.subject,channel_id:"COTHER"};
    const e=f.db.enqueue(other).row;
    await assert.rejects(f.supervisor().resumeJob(f.job.job_id,e.event_id,"続ける"),/owner/);assert.equal(f.observations(),0);
    f.runtime.retireWorker=async()=>{f.retire();await fs.mkdir(path.dirname(f.job.result_path),{recursive:true});await fs.writeFile(f.job.result_path,"{}");};
    await assert.rejects(f.supervisor().resumeJob(f.job.job_id,f.follow.event_id,"続ける"),/result_requires_reconciliation/);
    assert.equal(f.db.getJobHandoff(f.job.job_id)!.successor_job_id,null);
  } finally {await f.dispose();}
});

test("process inventoryは子孫を含め、欠落・不正データを停止とみなさない",()=>{
  assert.deepEqual(processTree(" 1 0\n 10 1\n 11 10\n 12 11\n 20 1\n",10),[10,11,12]);
  assert.throws(()=>processTree("1 0",10),/root_missing/);assert.throws(()=>processTree("10 x",10),/inventory_invalid/);
});

test("保存されたprocess証拠があれば、pane消失後も停止確認して再委譲できる",async()=>{
  const f=await fixture();try {
    const s=f.supervisor();
    const viewed=await s.inspectWorker(f.job.job_id,f.follow.event_id);
    assert.equal(JSON.stringify(viewed).includes("process_ids"),false);
    f.runtime.observeWorker=async()=>({...inactive(),state:"unknown",reason:"pane_identity_unavailable",process_ids:[]});
    f.retire();
    assert.equal((await f.supervisor().inspectWorker(f.job.job_id,f.follow.event_id)).worker instanceof Object,true);
    assert.equal((await f.supervisor().resumeJob(f.job.job_id,f.follow.event_id,"続ける")).outcome,"created");
    assert.equal(f.closes(),0);
  } finally {await f.dispose();}
});

test("UDS APIからowner照合・観測・再委譲とresponse再読まで通す",async()=>{
  const f=await fixture();const api=new DispatcherApi(f.db,{isRunning:()=>true,wake(){}},f.supervisor(),f.config,logger);
  try {
    await api.start();const client=new DispatcherApiClient(f.config.socketPath);
    const observed=await client.inspectWorker(f.job.job_id,f.follow.event_id);
    assert.equal((observed.worker as {state:string}).state,"inactive");
    const response=await client.resumeJob(f.job.job_id,{source_event_id:f.follow.event_id,instruction:"残作業"});
    assert.equal(response.outcome,"created");
    const saved=await client.inspectWorker(f.job.job_id,f.follow.event_id);
    assert.equal((saved.handoff as {successor_job_id:string}).successor_job_id,response.job_id);
    await assert.rejects(client.inspectWorker(f.job.job_id,"evt_01K00000000000000000000000"),/owner/);
  } finally {await api.stop();await f.dispose();}
});

test("後継の受付上限やkey競合は旧workerを停止する前に検出する",async()=>{
  const f=await fixture();try {
    const {handoffKey}=await import("../src/job-handoff.js");
    f.db.createJob({source_event_id:f.follow.event_id,job_key:handoffKey(f.job.job_id),objective:"別目的",workspace:{kind:"scratch"}},f.config.jobsWorkspaceRoot,f.config.jobResultsDir);
    await assert.rejects(f.supervisor().resumeJob(f.job.job_id,f.follow.event_id,"続ける"),/different canonical payload/);
    assert.equal(f.closes(),0);assert.equal(f.db.getJobHandoff(f.job.job_id),undefined);
    assert.equal(f.db.getJob(f.job.job_id)!.status,"needs_review");
  } finally {await f.dispose();}
});

test("複数回の引継ぎも元workspaceを維持し、各Resultを分離する",async()=>{
  const f=await fixture();try {
    const first=await f.supervisor().resumeJob(f.job.job_id,f.follow.event_id,"続ける");
    const next=f.db.getJob(String(first.job_id))!;
    f.db.beginJobPreparation(next.job_id);f.db.setJobRuntime(next.job_id,"w2","w2:p1");f.db.beginJobDispatch(next.job_id);f.db.markJobRunning(next.job_id);f.db.markJobBlocked(next.job_id,"interrupted");
    const follow=f.db.enqueue(eventEnvelope("resume-again")).row;
    const second=await f.supervisor().resumeJob(next.job_id,follow.event_id,"続ける");
    const latest=f.db.getJob(String(second.job_id))!;
    assert.equal(workspaceJobId(latest),f.job.job_id);assert.equal(latest.workspace_path,f.job.workspace_path);
    assert.notEqual(latest.result_path,next.result_path);assert.equal(f.closes(),2);
  } finally {await f.dispose();}
});
