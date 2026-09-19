import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {DispatcherDatabase} from "../src/database.js";
import {HerdrJobAgentRuntime} from "../src/job-runtime.js";
import {tempConfig,eventEnvelope} from "./helpers.js";
import {test} from "node:test";
import {scheduledPermissionArguments,verifyScheduledPermissionContext,verifyScheduledSandbox} from "../src/scheduled-sandbox.js";

const context=(directory:string,extra="")=>JSON.stringify([{content:[{text:`<environment_context><file_system type="restricted"><entry access="deny" escalatable="false"><special>:root</special></entry><entry access="read"><special>:minimal</special></entry><entry access="read"><path>/usr/bin/codex</path></entry><entry access="write"><path>${directory}</path></entry>${extra}</file_system></environment_context>`}]}]);

test("scheduled permission contextはlegacy/full-readと余分なgrantを拒否する",()=>{
  assert.doesNotThrow(()=>verifyScheduledPermissionContext(context("/tmp/result"),"/tmp/result",["/usr/bin/codex"]));
  for(const bad of ["[]",context("/tmp/other"),context("/tmp/result",'<entry access="read"><path>/Users</path></entry>'),context("/tmp/result",'<entry access="write"><path>/tmp</path></entry>'),context("/tmp/result").replace('access=\\"deny\\"','access=\\"read\\"')])
    assert.throws(()=>verifyScheduledPermissionContext(bad,"/tmp/result",["/usr/bin/codex"]));
  assert.throws(()=>scheduledPermissionArguments("/tmp/result",[]));
  const args=scheduledPermissionArguments("/tmp/result",["/usr/bin/codex"]);
  assert.equal(args.includes("--sandbox"),false);
  assert.ok(args.some(value=>value.includes('inherit = "none"')));
  for(const feature of ["memories","shell_snapshot","browser_use"]) assert.ok(args.includes(feature));
});

for(const mode of ["success","wrong-context","sandbox-failure","missing-proof"] as const) test(`read isolation probe ${mode}は開始条件とcleanupを検証する`,async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-sandbox-test-"));const result=path.join(root,"result");await fs.mkdir(result);
  const calls:string[][]=[];
  try {
    const run=async(_executable:string,args:string[])=>{
      calls.push(args);
      if(args.includes("prompt-input"))return {ok:true,stdout:mode==="wrong-context"?"[]":context(result),stderr:"",exitCode:0,timedOut:false,aborted:false};
      const output=args.at(-1)!;const canary=args.at(-3)!;const link=args.at(-2)!;
      assert.equal(await fs.readFile(canary,"utf8"),"fixture-only");assert.equal(await fs.readlink(link),canary);
      if(mode==="success")await fs.writeFile(output,"verified");
      return {ok:mode!=="sandbox-failure",stdout:"",stderr:"",exitCode:0,timedOut:false,aborted:false};
    };
    const promise=verifyScheduledSandbox(result,["/usr/bin/codex"],1000,run);
    if(mode==="success")await promise;else await assert.rejects(promise,/isolation/);
    assert.equal(calls.length,mode==="wrong-context"?1:2);
    assert.deepEqual(await fs.readdir(root),["result"]);assert.deepEqual(await fs.readdir(result),[]);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test("isolation未確認ではHerdr workspaceやworkerを開始しない",async()=>{
  const {root,config}=await tempConfig();const database=new DispatcherDatabase(config.databasePath);
  try {
    const source=database.enqueue(eventEnvelope("Ev-sandbox-unverified")).row;
    const job=database.createJob({source_event_id:source.event_id,objective:"確認する",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
    const runtime=new HerdrJobAgentRuntime({...config,codexPath:"/usr/bin/false",herdrPath:"/must-not-be-invoked"});
    await assert.rejects(runtime.prepare({...job,source:"dona_schedule"}),/permission context could not be verified/);
    await assert.rejects(fs.access(job.workspace_path));
    assert.deepEqual(await fs.readdir(path.dirname(job.result_path)),[]);
  }finally{database.close();await fs.rm(root,{recursive:true,force:true});}
});
