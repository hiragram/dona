import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {afterEach, test} from "node:test";
import Database from "better-sqlite3";
import {DispatcherDatabase} from "../src/database.js";
import {eventEnvelope, tempConfig} from "./helpers.js";

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
const digest=(text:string)=>createHash("sha256").update(text).digest("hex");

async function setup(){
  const {root,config}=await tempConfig();roots.push(root);
  const database=new DispatcherDatabase(config.databasePath);
  const source=database.enqueue(eventEnvelope(`source-${root}`)).row;
  const created=database.createJob({source_event_id:source.event_id,objective:"recover",workspace:{kind:"scratch"}},
    config.jobsWorkspaceRoot,config.jobResultsDir).row;
  database.markJobNeedsReview(created.job_id,"legacy_agent_sandbox_unknown","legacy worker state unknown");
  database.sealJobGroup(source.event_id);
  const assertion=database.enqueue({...eventEnvelope(`assertion-${root}`),occurred_at:new Date().toISOString(),
    payload:{text:"対象の待機 worker を終了した"}}).row;
  database.manualComplete(assertion.event_id);
  const job=database.getJob(created.job_id)!;
  const sideEffectsEvidenceSha256=digest("reviewed side effects");
  const input=()=>{
    const preview=database.inspectOperatorAssertionRecovery(job.job_id);
    return {jobId:job.job_id,assertionEventId:assertion.event_id,operatorPrincipal:"local:test:501",
      expectedUpdatedAt:preview.updated_at,expectedCause:preview.cause!,expectedResultClass:preview.result_class,
      expectedResultSha256:preview.result_sha256,sideEffectsEvidenceSha256,
      notificationEvidenceSha256:preview.notification_evidence_sha256};
  };
  return {database,config,job,assertion,input};
}

test("妥当な Result は申告と個別照合を記録して受理する",async()=>{
  const state=await setup();
  await fs.mkdir(path.dirname(state.job.result_path),{recursive:true});
  await fs.writeFile(state.job.result_path,JSON.stringify({schema_version:1,job_id:state.job.job_id,
    status:"completed",summary:"完了",completed_at:new Date().toISOString()}));
  const input=state.input();
  assert.equal(state.database.recoverWithOperatorAssertion(input).status,"completed");
  assert.equal(state.database.getJob(state.job.job_id)?.result_json!==null,true);
  assert.throws(()=>state.database.recoverWithOperatorAssertion(input),/already_recorded/);
  const raw=new Database(state.config.databasePath,{readonly:true});
  try {
    assert.equal((raw.prepare("SELECT result_class FROM job_operator_assertion_recoveries WHERE job_id=?")
      .get(state.job.job_id) as {result_class:string}).result_class,"valid");
    assert.equal(raw.prepare("SELECT 1 FROM job_terminal_worker_stop_proofs WHERE job_id=?").get(state.job.job_id),undefined);
  } finally {raw.close();}
});

test("無効な Result と欠落 Result は成功を作らず失敗へ確定する",async()=>{
  for(const invalid of [true,false]){
    const state=await setup();
    if(invalid){await fs.mkdir(path.dirname(state.job.result_path),{recursive:true});await fs.writeFile(state.job.result_path,"{invalid");}
    const input=state.input();
    assert.equal(input.expectedResultClass,invalid?"invalid":"missing");
    const row=state.database.recoverWithOperatorAssertion(input);
    assert.equal(row.status,"failed");
    assert.equal(row.result_json,null);
    assert.equal(row.last_error_code,"operator_assertion_result_unaccepted");
  }
});

test("申告以降の状態変更、Result差し替え、異なるworkspaceを拒否する",async()=>{
  const state=await setup();
  const input=state.input();
  await fs.mkdir(path.dirname(state.job.result_path),{recursive:true});
  await fs.writeFile(state.job.result_path,"changed");
  assert.throws(()=>state.database.recoverWithOperatorAssertion(input),/result_drift/);
  const updated=state.input();
  assert.throws(()=>state.database.recoverWithOperatorAssertion({...updated,expectedUpdatedAt:"stale"}),/job_changed/);
  const foreign=state.database.enqueue({...eventEnvelope("foreign"),occurred_at:new Date().toISOString(),
    subject:{workspace_id:"T_OTHER",channel_id:"C_TEST",actor_id:"U_TEST"}}).row;
  state.database.manualComplete(foreign.event_id);
  assert.throws(()=>state.database.recoverWithOperatorAssertion({...updated,assertionEventId:foreign.event_id}),/scope_or_time_mismatch/);
});

test("旧shared grantは申告の監査記録と終状態が一致する場合だけ安全判定を通す",async()=>{
  const state=await setup();
  const raw=new Database(state.config.databasePath);
  try {raw.prepare("INSERT INTO legacy_job_agents_to_stop(job_id) VALUES(?)").run(state.job.job_id);}
  finally {raw.close();}
  assert.equal(state.database.updateSafetyStatus().safe,false);
  const row=state.database.recoverWithOperatorAssertion(state.input());
  assert.equal(row.status,"failed");
  assert.equal(state.database.updateSafetyStatus().safe,true);
  const verify=new Database(state.config.databasePath);
  try {
    assert.equal((verify.prepare("SELECT stopped_at FROM legacy_job_agents_to_stop WHERE job_id=?")
      .get(row.job_id) as {stopped_at:string|null}).stopped_at,null);
    verify.prepare("UPDATE jobs SET updated_at=? WHERE job_id=?").run(new Date(Date.now()+1000).toISOString(),row.job_id);
  } finally {verify.close();}
  assert.equal(state.database.updateSafetyStatus().safe,false);
});
