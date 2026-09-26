import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {afterEach, test} from "node:test";
import Database from "better-sqlite3";
import {DispatcherDatabase,migrateDispatcherDatabase} from "../src/database.js";
import {eventEnvelope, tempConfig} from "./helpers.js";

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
const digest=(text:string)=>createHash("sha256").update(text).digest("hex");

async function setup(cause="legacy_agent_sandbox_unknown",attempted=true){
  const {root,config}=await tempConfig();roots.push(root);
  const database=new DispatcherDatabase(config.databasePath);
  const source=database.enqueue(eventEnvelope(`source-${root}`)).row;
  const created=database.createJob({source_event_id:source.event_id,objective:"recover",workspace:{kind:"scratch"}},
    config.jobsWorkspaceRoot,config.jobResultsDir).row;
  if(attempted)database.beginJobPreparation(created.job_id);
  database.markJobNeedsReview(created.job_id,cause,"legacy worker state unknown");
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
      expectedResultSha256:preview.result_sha256,sideEffectsEvidenceSha256,residualRisksAccepted:true,
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
  assert.equal(state.database.operatorAssertionRecoveryRecord(state.job.job_id)?.assertion_event_id,
    state.assertion.event_id);
  assert.equal(state.database.operatorAssertionRecoveryRecord(state.job.job_id)?.operator_role,"job_owner");
  assert.equal(state.database.operatorAssertionRecoveryRecord(state.job.job_id)?.authorization_principal,
    "slack:U_TEST");
  assert.equal(state.database.operatorAssertionRecoveryRecord(state.job.job_id)?.stop_time_status,"unknown");
  assert.equal(state.database.operatorAssertionRecoveryRecord(state.job.job_id)?.evidence_class,"operator_assertion");
  assert.throws(()=>state.database.recoverWithOperatorAssertion(input),/already_recorded/);
  const raw=new Database(state.config.databasePath,{readonly:true});
  try {
    assert.equal((raw.prepare("SELECT result_class FROM job_operator_assertion_recoveries WHERE job_id=?")
      .get(state.job.job_id) as {result_class:string}).result_class,"valid");
    assert.equal(raw.prepare("SELECT 1 FROM job_terminal_worker_stop_proofs WHERE job_id=?").get(state.job.job_id),undefined);
  } finally {raw.close();}
});

test("別の旧needs_review原因でも妥当Resultを受理する",async()=>{
  const state=await setup("stale_preparing_agent_unverified");
  await fs.mkdir(path.dirname(state.job.result_path),{recursive:true});
  await fs.writeFile(state.job.result_path,JSON.stringify({schema_version:1,job_id:state.job.job_id,
    status:"failed",summary:"未完了",completed_at:new Date().toISOString()}));
  assert.equal(state.database.recoverWithOperatorAssertion(state.input()).status,"failed");
  assert.equal(state.database.getJob(state.job.job_id)?.result_json!==null,true);
});

test("prompt前のResult collisionから成功を作らない",async()=>{
  const state=await setup("result_path_exists",false);
  await fs.mkdir(path.dirname(state.job.result_path),{recursive:true});
  await fs.writeFile(state.job.result_path,JSON.stringify({schema_version:1,job_id:state.job.job_id,
    status:"completed",summary:"別の出力",completed_at:new Date().toISOString()}));
  assert.throws(()=>state.database.recoverWithOperatorAssertion(state.input()),/pre_dispatch_unavailable/);
  assert.equal(state.database.getJob(state.job.job_id)?.result_json,null);
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
  const otherActor=state.database.enqueue({...eventEnvelope("other-actor"),occurred_at:new Date().toISOString(),
    subject:{workspace_id:"T_TEST",channel_id:"C_TEST",actor_id:"U_OTHER"}}).row;
  state.database.manualComplete(otherActor.event_id);
  assert.throws(()=>state.database.recoverWithOperatorAssertion({...updated,assertionEventId:otherActor.event_id}),
    /scope_or_time_mismatch/);
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

test("配送中の旧通知は申告があっても再送せず状態を維持する",async()=>{
  const state=await setup();
  const event=state.database.enqueueJobNotification(state.job.job_id).row;
  const raw=new Database(state.config.databasePath);
  try {raw.prepare("UPDATE events SET status='dispatching' WHERE event_id=?").run(event.event_id);}
  finally {raw.close();}
  const assertion=state.database.enqueue({...eventEnvelope("after-notification"),
    occurred_at:new Date().toISOString(),payload:{text:"worker停止済み"}}).row;
  state.database.manualComplete(assertion.event_id);
  const input={...state.input(),assertionEventId:assertion.event_id};
  assert.throws(()=>state.database.recoverWithOperatorAssertion(input),/notification_requires_reconciliation/);
  assert.equal(state.database.getJob(state.job.job_id)?.status,"needs_review");
  assert.equal(state.database.get(event.event_id)?.status,"dispatching");
});

test("旧Result pathの再openはCASを動かさず別CLI起動で回復できる",async()=>{
  const {root,config}=await tempConfig();roots.push(root);
  const createdDb=new DispatcherDatabase(config.databasePath);
  const source=createdDb.enqueue(eventEnvelope(`legacy-source-${root}`)).row;
  const created=createdDb.createJob({source_event_id:source.event_id,objective:"legacy",workspace:{kind:"scratch"}},
    config.jobsWorkspaceRoot,config.jobResultsDir).row;
  createdDb.beginJobPreparation(created.job_id);
  createdDb.markJobNeedsReview(created.job_id,"prompt_acceptance_unknown","unknown");
  createdDb.sealJobGroup(source.event_id);
  createdDb.close();
  const raw=new Database(config.databasePath);
  try {raw.prepare("UPDATE jobs SET result_path=? WHERE job_id=?")
    .run(path.join(path.dirname(path.dirname(created.result_path)),`${created.job_id}.json`),created.job_id);}
  finally {raw.close();}
  const first=new DispatcherDatabase(config.databasePath);
  const migrated=first.getJob(created.job_id)!;
  assert.equal(migrated.last_error_code,"legacy_agent_sandbox_unknown");
  first.close();
  const inspect=new DispatcherDatabase(config.databasePath);
  assert.equal(inspect.getJob(created.job_id)?.updated_at,migrated.updated_at);
  const assertion=inspect.enqueue({...eventEnvelope(`legacy-assertion-${root}`),occurred_at:new Date().toISOString(),
    payload:{text:"worker停止済み"}}).row;
  inspect.manualComplete(assertion.event_id);
  const preview=inspect.inspectOperatorAssertionRecovery(created.job_id);
  inspect.close();
  const recover=new DispatcherDatabase(config.databasePath);
  try {
    assert.equal(recover.getJob(created.job_id)?.updated_at,preview.updated_at);
    const row=recover.recoverWithOperatorAssertion({jobId:created.job_id,assertionEventId:assertion.event_id,
      operatorPrincipal:"local:test:501",expectedUpdatedAt:preview.updated_at,expectedCause:preview.cause!,
      expectedResultClass:preview.result_class,expectedResultSha256:preview.result_sha256,
      sideEffectsEvidenceSha256:digest("reviewed"),notificationEvidenceSha256:preview.notification_evidence_sha256,
      residualRisksAccepted:true});
    assert.equal(row.status,"failed");
  } finally {recover.close();}
});

test("v2 bridgeのoperator台帳をv3 job再構築後も保持する",async()=>{
  const {root,config}=await tempConfig();roots.push(root);
  const initial=new Database(config.databasePath);
  initial.exec(await fs.readFile(new URL("./fixtures/schema-v2.sql",import.meta.url),"utf8"));
  initial.close();
  const bridge=new DispatcherDatabase(config.databasePath);
  const source=bridge.enqueue(eventEnvelope(`v2-source-${root}`)).row;
  const created=bridge.createJob({source_event_id:source.event_id,objective:"v2 recovery",workspace:{kind:"scratch"}},
    config.jobsWorkspaceRoot,config.jobResultsDir).row;
  bridge.beginJobPreparation(created.job_id);
  bridge.markJobNeedsReview(created.job_id,"legacy_agent_sandbox_unknown","unknown");
  bridge.sealJobGroup(source.event_id);
  const assertion=bridge.enqueue({...eventEnvelope(`v2-assertion-${root}`),occurred_at:new Date().toISOString(),
    payload:{text:"worker停止済み"}}).row;
  bridge.manualComplete(assertion.event_id);
  const preview=bridge.inspectOperatorAssertionRecovery(created.job_id);
  bridge.recoverWithOperatorAssertion({jobId:created.job_id,assertionEventId:assertion.event_id,
    operatorPrincipal:"local:test:501",expectedUpdatedAt:preview.updated_at,expectedCause:preview.cause!,
    expectedResultClass:preview.result_class,expectedResultSha256:preview.result_sha256,
    sideEffectsEvidenceSha256:digest("reviewed"),notificationEvidenceSha256:preview.notification_evidence_sha256,
    residualRisksAccepted:true});
  const before=bridge.operatorAssertionRecoveryRecord(created.job_id);
  bridge.close();
  const migrate=new Database(config.databasePath);
  migrate.pragma("foreign_keys = ON");
  try {
    assert.throws(()=>migrateDispatcherDatabase(migrate,(step)=>{
      if(step==="indexes_recreated")throw new Error("injected migration failure");
    },false,3),/injected migration failure/);
    assert.equal(migrate.pragma("user_version",{simple:true}),2);
    assert.equal((migrate.prepare("SELECT recorded_at FROM job_operator_assertion_recoveries WHERE job_id=?")
      .get(created.job_id) as {recorded_at:string}).recorded_at,before?.recorded_at);
    migrateDispatcherDatabase(migrate,()=>{},false,3);
    assert.equal(migrate.pragma("user_version",{simple:true}),3);
  } finally {migrate.close();}
  const after=new DispatcherDatabase(config.databasePath);
  try {assert.deepEqual(after.operatorAssertionRecoveryRecord(created.job_id),before);}
  finally {after.close();}
});
