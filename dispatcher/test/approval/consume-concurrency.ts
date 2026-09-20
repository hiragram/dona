import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { decisionFixture } from "./fixtures/decision.js";
import { fixtureHeadProviders, writeFixtureHeads } from "./fixtures/consume-heads.js";
import { ApprovalRecordRepository } from "../../src/approval/record-repository.js";
import { ApprovalPayloadRepository } from "../../src/approval/payload-repository.js";
import { scope } from "./fixtures/broker.js";
const waitForFile=async(filename:string)=>{
  const deadline=performance.now()+10000;
  while(!fs.existsSync(filename)){if(performance.now()>deadline)throw Error("fixture_hold_timeout");await new Promise(resolve=>setTimeout(resolve,10));}
};
function peer(args:string[]){
  const child=fork(new URL("./fixtures/consume-process.ts",import.meta.url),args,{execArgv:["--import","tsx"],stdio:["ignore","ignore","ignore","ipc"]});
  const exited=new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("exit",resolve);});
  const ready=new Promise<void>((resolve,reject)=>{child.on("message",message=>{if((message as {kind?:string}).kind==="ready")resolve();});child.once("error",reject);child.once("exit",()=>reject(Error("fixture_exited_before_ready")));});
  const result=new Promise<{kind:string;result?:{status:string;attempt_handle:string;consume_handle:string};error?:string}>((resolve,reject)=>{
    child.on("message",message=>{if((message as {kind?:string}).kind==="result")resolve(message as never);});child.once("error",reject);child.once("exit",()=>reject(Error("fixture_exited_before_result")));
  });
  // Attach immediately; a failed launch must not create an unhandled rejection.
  void ready.catch(()=>{});void result.catch(()=>{});void exited.catch(()=>{});
  return {child,ready,result,exited};
}
function stop(child:ChildProcess){if(child.exitCode===null)child.kill();}

test("別processの同時consumeはwriter lockで一件だけcommitしloserを再実行しない",{timeout:20000},async t=>{
  const f=decisionFixture(t);assert.equal(f.decision.decide("approve",f.command("approve")).status,"decided");
  const directory=path.dirname(f.filename),heads=path.join(directory,"fixture-heads.json"),held=path.join(directory,"held"),release=path.join(directory,"release");
  writeFixtureHeads(heads,{anchor:f.anchors.read(),mark:f.marks.read(),audit_used:[...f.anchors.used],clock_used:[...f.marks.used]});
  const one=peer([f.filename,heads,f.requestId,"consume_one",held,release]),two=peer([f.filename,heads,f.requestId,"consume_two",held,release]);
  try{
    await Promise.all([one.ready,two.ready]);one.child.send("start");await waitForFile(held);
    // First process is inside prepare while holding the actual shared writer lock.
    two.child.send("start");const loser=await two.result;assert.equal(loser.error,"approval_consume_unverified");assert.equal(await two.exited,0);
    fs.writeFileSync(release,"release",{mode:0o600,flag:"wx"});const winner=await one.result;assert.equal(winner.result?.status,"claimed");assert.equal(await one.exited,0);
    assert.ok(winner.result);const providers=fixtureHeadProviders(heads),records=new ApprovalRecordRepository(f.db,providers.auditAnchors,providers.auditKeys,scope);
    const payloads=new ApprovalPayloadRepository(f.db,providers.auditAnchors,providers.auditKeys,scope);
    const consume=records.read("consume",f.requestId)!;assert.equal(consume.row.consume_id,winner.result.consume_handle);assert.equal(consume.row.attempt_id,winner.result.attempt_handle);
    assert.equal(records.read("request",f.requestId)!.row.state,"consumed");assert.equal(records.read("execution",consume.row.attempt_id)!.row.state,"claimed");
    assert.equal(payloads.inspect("request",f.requestId)!.secret.status,"deleted");assert.equal(payloads.inspect("attempt",consume.row.attempt_id)!.secret.status,"present");
    assert.equal(f.db.prepare("SELECT count(*) FROM approval_consumes").pluck().get(),1);assert.equal(f.db.prepare("SELECT count(*) FROM approval_execution_attempts").pluck().get(),1);
    const shared=JSON.parse(fs.readFileSync(heads,"utf8"));assert.equal(shared.clock_used.includes("consume_two"),false);assert.equal(shared.audit_used.includes("consume_two"),false);
  }finally{
    if(!fs.existsSync(release))fs.writeFileSync(release,"release",{mode:0o600});stop(one.child);stop(two.child);await Promise.allSettled([one.exited,two.exited]);
  }
});
