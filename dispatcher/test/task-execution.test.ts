import { once } from "node:events";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { DispatcherDatabase } from "../src/database.js";
import { taskRequestSchema } from "../src/task-execution.js";
import { JobSupervisor } from "../src/job-supervisor.js";
import type { JobAgentRuntime } from "../src/job-runtime.js";
import type { WorkerObservation } from "../src/job-handoff.js";
import { DispatcherApi } from "../src/api.js";
import { DispatcherApiClient } from "../src/client.js";
import { eventEnvelope,tempConfig } from "./helpers.js";
const logger={debug(){},info(){},warn(){},error(){}};
async function fixture(){
  const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath);
  const event=db.enqueue(eventEnvelope("task")).row;
  const request=taskRequestSchema.parse({source_event_id:event.event_id,task_key:"implementation",objective:"実装して検証済みPRを提出",workspace:{kind:"scratch"},policy:{max_attempts:3,retry_delay_ms:1000}});
  const task=db.tasks.create(request,config.jobsWorkspaceRoot,config.jobResultsDir).task;
  let observed:WorkerObservation={state:"inactive",reason:"agent_idle",observed_at:new Date().toISOString(),process_ids:[123,124],process_groups:[123]};
  let stopped=false,sends=0;
  const runtime:JobAgentRuntime={async prepare(){return {herdrWorkspaceId:"w",herdrPaneId:"p"};},async prompt(){throw Error("unexpected");},async get(){throw Error("unexpected");},async wait(){throw Error("unexpected");},async cancel(){throw Error("unexpected");},
    async observeWorker(){return observed;},async retireWorker(){sends++;stopped=true;},async workerRetired(){return stopped;}};
  const supervisor=()=>new JobSupervisor(db,runtime,config,logger,()=>{});
  const start=(id=task.current_attempt_id)=>{db.beginJobPreparation(id,new Date(db.getJob(id)!.available_at));db.setJobRuntime(id,"w","p");db.beginJobDispatch(id);db.markJobRunning(id);};
  const interrupt=(id=task.current_attempt_id)=>db.markJobNeedsReview(id,"result_missing","interrupted");
  const due=()=>{const t=db.tasks.get(task.task_id)!;db.tasks.wait(t,t.wait_reason??"observation_unknown",-1);};
  return {root,config,db,event,request,task,runtime,supervisor,start,interrupt,due,sends:()=>sends,setObserved:(o:Partial<WorkerObservation>)=>{observed={...observed,...o};},setStopped:(s:boolean)=>{stopped=s;},async dispose(){db.close();await fs.rm(root,{recursive:true,force:true});}};
}

test("Task作成の冪等性と異内容conflict、Issueのeventを跨ぐ排他",async()=>{
  const f=await fixture();try{
    assert.equal(f.db.tasks.create(f.request,f.config.jobsWorkspaceRoot,f.config.jobResultsDir).task.task_id,f.task.task_id);
    assert.throws(()=>f.db.tasks.create({...f.request,objective:"別作業"},f.config.jobsWorkspaceRoot,f.config.jobResultsDir),/idempotency_conflict/);
    const request=taskRequestSchema.parse({...f.request,task_key:"issue",workspace:{kind:"github",repository:"org/repo"},issue_number:1});
    f.db.tasks.create(request,f.config.jobsWorkspaceRoot,f.config.jobResultsDir,{node_id:"I_1",repository:"org/repo",number:1});
    const next=f.db.enqueue(eventEnvelope("another-event")).row;
    assert.throws(()=>f.db.tasks.create({...request,source_event_id:next.event_id},f.config.jobsWorkspaceRoot,f.config.jobResultsDir,{node_id:"I_1",repository:"org/repo",number:1}),/resource_already_claimed/);
    assert.equal(f.db.listEventJobs(next.event_id).length,0);
  }finally{await f.dispose();}
});

test("停止確認後は同じTaskの次Attemptへ差分を引継ぎ、旧Resultは拒否",async()=>{
  const f=await fixture();try{
    f.start();f.interrupt();const old=f.db.getJob(f.task.current_attempt_id)!;
    await fs.mkdir(old.workspace_path,{recursive:true});await fs.writeFile(path.join(old.workspace_path,"unfinished"),"変更");
    f.db.sealJobGroup(f.event.event_id);
    await f.supervisor().reconcileTasks();
    const task=f.db.tasks.get(f.task.task_id)!;assert.equal(task.attempt_number,2);assert.notEqual(task.current_attempt_id,old.job_id);
    assert.equal(f.sends(),1);assert.equal(f.db.tasks.forAttempt(old.job_id)!.task_id,task.task_id);
    const next=f.db.getJob(task.current_attempt_id)!;assert.equal(next.workspace_path,old.workspace_path);assert.notEqual(next.result_path,old.result_path);
    assert.equal(await fs.readFile(path.join(next.workspace_path,"unfinished"),"utf8"),"変更");
    assert.equal(f.db.tasks.mayNotify(f.db.getJob(old.job_id)!),false);
    assert.throws(()=>f.db.saveJobResult(old.job_id,{schema_version:1,job_id:old.job_id,status:"completed",summary:"late",completed_at:new Date().toISOString()},old.result_path),/superseded/);
    f.start(next.job_id);f.db.saveJobResult(next.job_id,{schema_version:1,job_id:next.job_id,status:"completed",summary:"完了",completed_at:new Date().toISOString()},next.result_path);
    assert.equal(f.db.tasks.get(task.task_id)!.state,"completed");
    const notification=f.db.enqueueJobNotification(next.job_id).row;
    const group=JSON.parse(notification.payload_json).group;assert.equal(group.total,1);assert.equal(group.transition,"all_terminal");
  }finally{await f.dispose();}
});

for(const state of ["working","waiting","unknown"] as const)test(`${state}から自動でworkerを交換しない`,async()=>{
  const f=await fixture();try{f.start();f.interrupt();f.setObserved({state});await f.supervisor().reconcileTasks();
    assert.equal(f.sends(),0);assert.equal(f.db.tasks.get(f.task.task_id)!.attempt_number,1);
    assert.equal(f.db.tasks.get(f.task.task_id)!.wait_reason,state==="working"?null:state==="waiting"?"human_input":"observation_unknown");
  }finally{await f.dispose();}
});

test("停止応答喪失は再送せず、Supervisor再生成後のread-backで続行",async()=>{
  const f=await fixture();try{
    f.start();f.interrupt();let writes=0;
    f.runtime.retireWorker=async()=>{writes++;throw new Error("connection lost");};
    await f.supervisor().reconcileTasks();assert.equal(f.db.tasks.get(f.task.task_id)!.stop_state,"attempting");
    f.due();await f.supervisor().reconcileTasks();assert.equal(writes,1);
    f.setStopped(true);f.due();await f.supervisor().reconcileTasks();
    assert.equal(f.db.tasks.get(f.task.task_id)!.attempt_number,2);assert.equal(writes,1);
  }finally{await f.dispose();}
});

test("worker停止中の取消が後継起動より優先される",async()=>{
  const f=await fixture();try{
    f.start();f.interrupt();
    f.runtime.retireWorker=async()=>{const task=f.db.tasks.get(f.task.task_id)!;const event=f.db.enqueue(eventEnvelope("cancel")).row;f.db.tasks.control(task.task_id,event.event_id,task.revision,"cancel");f.setStopped(true);};
    await f.supervisor().reconcileTasks();assert.equal(f.db.tasks.get(f.task.task_id)!.state,"cancelled");assert.equal(f.db.tasks.get(f.task.task_id)!.attempt_number,1);
  }finally{await f.dispose();}
});

test("pauseは停止を待ち、resume後もTaskと予算を保持する",async()=>{
  const f=await fixture();try{
    f.start();const event=f.db.enqueue(eventEnvelope("pause")).row;
    f.db.tasks.control(f.task.task_id,event.event_id,f.db.tasks.get(f.task.task_id)!.revision,"pause");await f.supervisor().reconcileTasks();
    const paused=f.db.tasks.get(f.task.task_id)!;assert.equal(paused.state,"paused");assert.equal(paused.stop_state,"stopped");assert.equal(paused.attempt_number,1);
    const resume=f.db.enqueue(eventEnvelope("resume")).row;
    f.db.tasks.control(paused.task_id,resume.event_id,paused.revision,"resume");await f.supervisor().reconcileTasks();
    assert.equal(f.db.tasks.get(paused.task_id)!.attempt_number,2);assert.equal(f.sends(),1);
  }finally{await f.dispose();}
});

test("再試行上限では新Attemptを作らず、人間待ちを通知できる",async()=>{
  const f=await fixture();try{
    for(let i=0;i<3;i++){const task=f.db.tasks.get(f.task.task_id)!;f.start(task.current_attempt_id);f.interrupt(task.current_attempt_id);await f.supervisor().reconcileTasks();}
    const task=f.db.tasks.get(f.task.task_id)!;assert.equal(task.attempt_number,3);assert.equal(task.wait_reason,"retry_exhausted");assert.equal(f.db.tasks.mayNotify(f.db.getJob(task.current_attempt_id)!),true);
  }finally{await f.dispose();}
});

test("別actor・別channel・古いrevisionではTaskを操作できない",async()=>{
  const f=await fixture();try{
    const e=eventEnvelope("other");e.subject.actor_id="U_OTHER";const other=f.db.enqueue(e).row;
    assert.throws(()=>f.db.tasks.assertOwner(f.task.task_id,other.event_id),/owner_mismatch/);
    const follow=f.db.enqueue(eventEnvelope("follow")).row;
    assert.throws(()=>f.db.tasks.control(f.task.task_id,follow.event_id,2,"cancel"),/revision_conflict/);
    const task=f.db.tasks.control(f.task.task_id,follow.event_id,1,"pause");assert.equal(task.state,"paused");
    assert.equal(f.db.tasks.control(task.task_id,follow.event_id,1,"pause").revision,task.revision);
    assert.throws(()=>f.db.tasks.control(task.task_id,follow.event_id,1,"cancel"),/control_conflict/);
  }finally{await f.dispose();}
});

test("Task APIの入口から作成・照会・pause・cancelを通す",async()=>{
  const f=await fixture(),s=f.supervisor(),api=new DispatcherApi(f.db,{isRunning:()=>true,wake(){}},s,f.config,logger);
  try{
    await api.start();const client=new DispatcherApiClient(f.config.socketPath);
    const result=await client.createTask({...f.request,task_key:"api"});const task=result.task as any;
    assert.match(task.task_id,/^task_/);assert.equal(JSON.stringify(result).includes("workspace_path"),false);
    const found=await client.getTask(task.task_id,f.event.event_id);assert.equal((found.task as any).current_attempt_id,task.current_attempt_id);
    const control=f.db.enqueue(eventEnvelope("api-cancel")).row;
    const cancelled=await client.controlTask(task.task_id,"cancel",{source_event_id:control.event_id,revision:task.revision});assert.equal((cancelled.task as any).state,"cancelled");
  }finally{await api.stop();await f.dispose();}
});

test("旧jobの暗黙移行を拒否し、管理済みTaskは再起動可能",async()=>{
  const f=await fixture();try{
    f.db.tasks.assertFreshExecutionModel();
    f.db.createJob({source_event_id:f.event.event_id,job_key:"unmanaged",objective:"legacy",workspace:{kind:"scratch"}},f.config.jobsWorkspaceRoot,f.config.jobResultsDir);
    assert.throws(()=>f.db.tasks.assertFreshExecutionModel(),/fresh_generation/);
  }finally{await f.dispose();}
});

test("利用上限のcheckpointは確認時刻まで再起動せず、承認待ちも迂回しない",async()=>{
  const f=await fixture();try{
    f.start();f.interrupt();const job=f.db.getJob(f.task.current_attempt_id)!;
    await fs.mkdir(path.dirname(job.result_path),{recursive:true});
    const checkpoint={schema_version:1,task_id:f.task.task_id,attempt_id:job.job_id,sequence:1,summary:"実装途中",remaining:["テスト"],artifacts:[],unresolved_operations:[],waiting:"usage_limit",retry_after:new Date(Date.now()+3_600_000).toISOString()};
    await fs.writeFile(path.join(path.dirname(job.result_path),"checkpoint.json"),JSON.stringify(checkpoint));
    await f.supervisor().reconcileTasks();assert.equal(f.sends(),0);assert.equal(f.db.tasks.get(f.task.task_id)!.wait_reason,"capacity_wait");
    f.due();await fs.writeFile(path.join(path.dirname(job.result_path),"checkpoint.json"),JSON.stringify({...checkpoint,sequence:2,waiting:"human_input"}));
    await f.supervisor().reconcileTasks();assert.equal(f.sends(),0);assert.equal(f.db.tasks.get(f.task.task_id)!.wait_reason,"human_input");
  }finally{await f.dispose();}
});

test("実DBを再openしても停止intentと使用済みAttemptを維持する",async()=>{
  const f=await fixture();let reopened:DispatcherDatabase|undefined;
  try{
    f.start();f.interrupt();let sends=0;f.runtime.retireWorker=async()=>{sends++;throw Error("lost");};
    await f.supervisor().reconcileTasks();f.db.close();
    reopened=new DispatcherDatabase(f.config.databasePath);reopened.tasks.assertFreshExecutionModel();
    const task=reopened.tasks.get(f.task.task_id)!;assert.equal(task.stop_state,"attempting");
    reopened.tasks.wait(task,"worker_stop_pending",-1);f.setStopped(true);
    const s=new JobSupervisor(reopened,f.runtime,f.config,logger,()=>{});await s.reconcileTasks();
    assert.equal(reopened.tasks.get(task.task_id)!.attempt_number,2);assert.equal(sends,1);assert.equal(reopened.schemaCompatibility().actual,4);
  }finally{reopened?.close();await f.dispose();}
});

test("再試行予算の明示追加は使用済みAttemptを保持し、曖昧応答も二重起動しない",async()=>{
  const f=await fixture();try{
    for(let i=0;i<3;i++){const task=f.db.tasks.get(f.task.task_id)!;f.start(task.current_attempt_id);f.interrupt(task.current_attempt_id);await f.supervisor().reconcileTasks();}
    const task=f.db.tasks.get(f.task.task_id)!;const follow=f.db.enqueue(eventEnvelope("extend-budget")).row;
    const extended=f.db.tasks.retry(task.task_id,follow.event_id,task.revision,4);
    assert.equal(extended.attempt_number,3);assert.equal(extended.max_attempts,4);
    await f.supervisor().reconcileTasks();assert.equal(f.db.tasks.get(task.task_id)!.attempt_number,4);
    f.db.tasks.retry(task.task_id,follow.event_id,task.revision,4);await f.supervisor().reconcileTasks();assert.equal(f.db.tasks.get(task.task_id)!.attempt_number,4);
  }finally{await f.dispose();}
});

test("一つのTaskをpauseしても別Taskの起動候補を塞がない",async()=>{
  const f=await fixture();try{
    const follow=f.db.enqueue(eventEnvelope("pause-queued")).row;
    f.db.tasks.control(f.task.task_id,follow.event_id,1,"pause");
    const second=f.db.tasks.create({...f.request,task_key:"second"},f.config.jobsWorkspaceRoot,f.config.jobResultsDir).task;
    assert.equal(f.db.nextRunnableJob()!.job_id,second.current_attempt_id);
  }finally{await f.dispose();}
});

test("steerの送信直前クラッシュでは指示を保持し、同じwriteを再送しない",async()=>{
  const f=await fixture();try{
    const follow=f.db.enqueue(eventEnvelope("steer")).row;
    assert.equal(f.db.tasks.prepareSteer(f.task.task_id,follow.event_id,1,"追加の検証"),true);
    assert.equal(f.db.tasks.prepareSteer(f.task.task_id,follow.event_id,1,"追加の検証"),false);
    assert.equal(f.db.tasks.get(f.task.task_id)!.wait_reason,"steer_acceptance_unknown");
    assert.match(f.db.tasks.get(f.task.task_id)!.objective,/追加の検証/);
  }finally{await f.dispose();}
});

test("UDS委任から実processの停止・後継Attempt・単一の完了通知まで通す",async()=>{
  const {spawn}=await import("node:child_process");
  const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath);
  const children:Array<ReturnType<typeof spawn>>=[];
  const processes=new Map<string,{child:ReturnType<typeof spawn>;exited:Promise<unknown>}>();
  let starts=0,stops=0;
  const ok={ok:true,stdout:"",stderr:"",exitCode:0,timedOut:false,aborted:false};
  const runtime:JobAgentRuntime={
    async prepare(job){
      starts++;await fs.mkdir(job.workspace_path,{recursive:true});await fs.mkdir(path.dirname(job.result_path),{recursive:true});
      const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});children.push(child);await once(child,"spawn");
      processes.set(job.job_id,{child,exited:once(child,"exit")});return {herdrWorkspaceId:job.job_id,herdrPaneId:`${job.job_id}:pane`};
    },
    async prompt(){return ok;},async get(){return {...ok,agentStatus:"idle"};},async cancel(){throw Error("unexpected legacy cancel");},
    async wait(id){
      const job=db.getJob(id)!;
      if(starts===1)await fs.writeFile(path.join(job.workspace_path,"work.txt"),"中断前の成果");
      else {
        assert.equal(await fs.readFile(path.join(job.workspace_path,"work.txt"),"utf8"),"中断前の成果");
        await fs.writeFile(job.result_path,JSON.stringify({schema_version:1,job_id:id,status:"completed",summary:"照合して続行",completed_at:new Date().toISOString()}));
      }
      return {...ok,agentStatus:"done"};
    },
    async observeWorker(job){const p=processes.get(job.job_id)!;return {state:"inactive",reason:"idle",observed_at:new Date().toISOString(),process_ids:[p.child.pid!],process_groups:[p.child.pid!]};},
    async retireWorker(job){stops++;const p=processes.get(job.job_id)!;p.child.kill("SIGTERM");await p.exited;},
    async workerRetired(job){const p=processes.get(job.job_id)!;try{process.kill(p.child.pid!,0);return false;}catch(error){return (error as NodeJS.ErrnoException).code==="ESRCH";}},
  };
  const supervisor=new JobSupervisor(db,runtime,config,logger,()=>{});
  const api=new DispatcherApi(db,{isRunning:()=>true,wake(){}},supervisor,config,logger);
  try{
    await api.start();const client=new DispatcherApiClient(config.socketPath),event=db.enqueue(eventEnvelope("native-e2e")).row;
    const response=await client.createTask({source_event_id:event.event_id,task_key:"e2e",objective:"続行",workspace:{kind:"scratch"},policy:{max_attempts:3,retry_delay_ms:1000}});
    const id=(response.task as any).task_id;db.sealJobGroup(event.event_id);supervisor.start();
    const {waitFor}=await import("./helpers.js");await waitFor(()=>db.tasks.get(id)?.state==="completed",5000);
    await waitFor(()=>db.getJob(db.tasks.get(id)!.current_attempt_id)!.completion_event_id!==null,5000);
    assert.equal(starts,2);assert.equal(stops,1);
    const notifications=db.list("queued").filter(e=>e.source==="dona_job");assert.equal(notifications.length,1);
    const payload=JSON.parse(notifications[0]!.payload_json);assert.equal(payload.task.task_id,id);assert.equal(payload.group.total,1);assert.equal(payload.group.transition,"all_terminal");
  }finally{await supervisor.stop();await api.stop();for(const child of children)child.kill("SIGTERM");await Promise.allSettled([...processes.values()].map(p=>p.exited));db.close();await fs.rm(root,{recursive:true,force:true});}
});

test("旧世代のpreflightはDBを変更せず拒否し、新Task世代は通す",async()=>{
  const {assertTaskGenerationFile}=await import("../src/task-execution.js");
  const {root,config}=await tempConfig();let db=new DispatcherDatabase(config.databasePath);
  try{
    const event=db.enqueue(eventEnvelope("legacy")).row;
    const before=db.schemaCompatibility().actual;assert.equal(before,3);
    assert.throws(()=>assertTaskGenerationFile(config.databasePath),/fresh_generation/);
    assert.equal(db.schemaCompatibility().actual,before);
    db.tasks.create(taskRequestSchema.parse({source_event_id:event.event_id,task_key:"new",objective:"作業",workspace:{kind:"scratch"}}),config.jobsWorkspaceRoot,config.jobResultsDir);
    assertTaskGenerationFile(config.databasePath);assert.deepEqual(db.schemaCompatibility(),{actual:4,read_min:4,read_max:4,write:4});
  }finally{db.close();await fs.rm(root,{recursive:true,force:true});}
});

test("停止直前にworkerがworkingへ戻れば停止writeを送らない",async()=>{
  const f=await fixture();try{
    f.start();f.interrupt();let reads=0;
    f.runtime.observeWorker=async()=>({state:++reads===1?"inactive":"working",reason:"changed",observed_at:new Date().toISOString(),process_ids:[123],process_groups:[123]});
    await f.supervisor().reconcileTasks();assert.equal(f.sends(),0);assert.equal(f.db.tasks.get(f.task.task_id)!.attempt_number,1);
  }finally{await f.dispose();}
});
