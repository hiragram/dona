import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { TaskProjector, verifyTaskIssue, type GitHubQuery } from "../src/task-github.js";
import { taskRequestSchema } from "../src/task-execution.js";
import { DispatcherDatabase } from "../src/database.js";
import { eventEnvelope,tempConfig } from "./helpers.js";

test("Projectへの応答喪失はread-backして続行し、成功したfieldを再送しない",async()=>{
  const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath);
  try{
    const event=db.enqueue(eventEnvelope("projection")).row;
    const request=taskRequestSchema.parse({source_event_id:event.event_id,task_key:"issue",objective:"提出",workspace:{kind:"github",repository:"org/repo"},issue_number:1});
    const task=db.tasks.create(request,config.jobsWorkspaceRoot,config.jobResultsDir,{node_id:"I_1",repository:"org/repo",number:1,
      project:{item_id:"item",project_id:"project",issue_id:"I_1",task_field_id:"task",status_field_id:"status",options:{"Todo":"todo","In Progress":"working","Merge Ready":"ready"},completion_status:"Merge Ready"}}).task;
    let id:string|undefined,status:string|undefined,writes=0;
    const query:GitHubQuery=async(q,vars)=>{
      if(q.startsWith("query"))return {node:{project:{id:"project"},content:{id:"I_1"},task:id?{text:id}:null,progress:status?{optionId:status}:null}};
      writes++;if(vars.field==="task")id=String(vars.value);else status=String(vars.value);
      throw Error("response lost after GitHub committed");
    };
    const p=new TaskProjector(db,query);
    await assert.rejects(p.sync(task),/response lost/);
    await p.sync(db.tasks.get(task.task_id)!);assert.equal(writes,1);
    await assert.rejects(p.sync(db.tasks.get(task.task_id)!),/response lost/);
    await p.sync(db.tasks.get(task.task_id)!);await p.sync(db.tasks.get(task.task_id)!);
    assert.equal(writes,2);assert.equal(db.tasks.get(task.task_id)!.project_state,"synced");
  }finally{db.close();await fs.rm(root,{recursive:true,force:true});}
});

test("成否不明でread-backが一致しないProject writeを再送しない",async()=>{
  const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath);
  try{
    const event=db.enqueue(eventEnvelope("projection-unknown")).row;
    const task=db.tasks.create(taskRequestSchema.parse({source_event_id:event.event_id,task_key:"issue",objective:"調査",workspace:{kind:"github",repository:"org/repo"},issue_number:1}),config.jobsWorkspaceRoot,config.jobResultsDir,{node_id:"I_1",repository:"org/repo",number:1,
      project:{item_id:"item",project_id:"project",issue_id:"I_1",task_field_id:"task",status_field_id:"status",options:{"Todo":"todo","In Progress":"working"},completion_status:"In Progress"}}).task;
    let writes=0;const query:GitHubQuery=async(q)=>{if(q.startsWith("query"))return {node:{project:{id:"project"},content:{id:"I_1"}}};writes++;throw Error("lost");};
    const p=new TaskProjector(db,query);await assert.rejects(p.sync(task));await p.sync(db.tasks.get(task.task_id)!);await p.sync(db.tasks.get(task.task_id)!);
    assert.equal(writes,1);assert.equal(db.tasks.get(task.task_id)!.project_state,"unknown");
  }finally{db.close();await fs.rm(root,{recursive:true,force:true});}
});

test("Issue番号の自由入力だけでclaimせず、GitHub node identityを検証する",async()=>{
  const input=taskRequestSchema.parse({source_event_id:"evt_01K00000000000000000000000",task_key:"issue",objective:"作業",workspace:{kind:"github",repository:"org/repo"},issue_number:2});
  await assert.rejects(verifyTaskIssue(input,async()=>({repository:{nameWithOwner:"other/repo",issue:{id:"I_2",number:2}}})),/identity_unverified/);
  assert.deepEqual(await verifyTaskIssue(input,async()=>({repository:{nameWithOwner:"org/repo",issue:{id:"I_2",number:2}}})),{node_id:"I_2",repository:"org/repo",number:2});
});
