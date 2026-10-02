import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { DispatcherDatabase } from "../src/database.js";
import { HerdrJobAgentRuntime } from "../src/job-runtime.js";
import { eventEnvelope, tempConfig } from "./helpers.js";

test("実processの観測・停止read-backをHerdr CLI境界から通し、session欠落と通信障害を区別する",async()=>{
  const {root,config}=await tempConfig();
  const db=new DispatcherDatabase(config.databasePath);
  const e=db.enqueue(eventEnvelope("runtime-observe")).row;
  const created=db.createJob({source_event_id:e.event_id,objective:"test",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
  db.beginJobPreparation(created.job_id);db.setJobRuntime(created.job_id,"w1","w1:p1");
  const row=db.getJob(created.job_id)!;
  const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});
  await once(child,"spawn");const exit=once(child,"exit");
  const statePath=path.join(root,"state");await fs.writeFile(statePath,"idle");
  const exe=path.join(root,"herdr.mjs");
  await fs.writeFile(exe,`#!/usr/bin/env node
import fs from 'node:fs';
const args=process.argv.slice(4),state=fs.readFileSync(${JSON.stringify(statePath)},'utf8');
const reply=result=>{console.log(JSON.stringify({result}));process.exit(0)};
const fail=code=>{console.error(JSON.stringify({error:{code}}));process.exit(1)};
if(state==='network')fail('transport_failure');
if(args[0]==='agent'&&args[1]==='list')reply({type:'agent_list',agents:state==='retired'?[]:[{name:${JSON.stringify(row.agent_name)},pane_id:'w1:p1'}]});
if(args[0]==='agent'&&args[1]==='get'){
  if(state==='retired'||state==='empty')fail('agent_not_found');
  reply({type:'agent_info',agent:{name:state==='mismatch'?'other':${JSON.stringify(row.agent_name)},workspace_id:'w1',pane_id:'w1:p1',agent_status:state}});
}
if(args[0]==='pane'&&args[1]==='get'){
  if(state==='retired')fail('pane_not_found');
  reply({type:'pane_info',pane:{pane_id:'w1:p1',workspace_id:'w1'}});
}
if(args[0]==='pane'&&args[1]==='process-info'&&args[2]==='--pane'&&args[3]==='w1:p1')reply({type:'pane_process_info',process_info:{pane_id:'w1:p1',shell_pid:${child.pid}}});
if(args[0]==='pane'&&args[1]==='close'){
  process.kill(${child.pid},'SIGTERM');fs.writeFileSync(${JSON.stringify(statePath)},'retired');reply({type:'pane_closed'});
}
fail('unexpected');
`,{mode:0o700});
  const runtime=new HerdrJobAgentRuntime({...config,herdrPath:exe});
  try {
    const initial=await runtime.observeWorker(row);assert.equal(initial.state,"inactive");assert.ok(initial.process_ids.includes(child.pid!));
    assert.equal(await runtime.workerRetired(row,initial),false);
    for(const [state,expected] of [["working","working"],["blocked","waiting"],["network","unknown"],["mismatch","unknown"]]){
      await fs.writeFile(statePath,state!);assert.equal((await runtime.observeWorker(row)).state,expected);
    }
    await fs.writeFile(statePath,"idle");await runtime.retireWorker(row);await exit;
    assert.equal(await runtime.workerRetired(row,initial),true);
    assert.equal((await runtime.observeWorker(row)).state,"unknown"); // no historical process evidence at the runtime layer
    await fs.writeFile(statePath,"network");assert.equal(await runtime.workerRetired(row,initial),false);
  } finally {child.kill();await exit;db.close();await fs.rm(root,{recursive:true,force:true});}
});
