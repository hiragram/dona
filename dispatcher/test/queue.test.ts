import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";
import Database from "better-sqlite3";
import { DispatcherDatabase } from "../src/database.js";
import { externalEventSource } from "../src/ingress.js";
import { queueIdentity, queuePolicySchema, QueueAdmissionError, admissionCodes } from "../src/queue.js";
import { eventEnvelope, tempConfig } from "./helpers.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root,{recursive:true,force:true}))); });
const at = new Date("2026-09-05T00:00:00Z");
const policy = { defaults: {depth:1000,bytes:8_388_608,rate:1000,burst:1000,coalescing:true} };
function provider(id: string, source="fake") { return {...eventEnvelope(id),source:externalEventSource(source),reply_target:null}; }
const context = {connectionId:"tenant-a"};
const signal = {...context,coalesce:{resourceKey:"resource-a",signalKey:"changed",requiresFetch:true as const}};
async function fixture(options: unknown=policy) {
  const {root,config}=await tempConfig(); roots.push(root);
  return {root,config,db:new DispatcherDatabase(config.databasePath,options)};
}
function code(expected:string) { return (e:unknown) => e instanceof QueueAdmissionError && e.code===expected && !e.ackAllowed; }

test("lane identities use authenticated connections and never payload keys",()=>{
  for (const [a,b,same] of [["a","a",true],["a","b",false],["a_b","a.b",false]] as const) {
    assert.equal(queueIdentity(provider("1"),{connectionId:a}).lane===queueIdentity(provider("2"),{connectionId:b}).lane,same);
  }
  assert.throws(()=>queueIdentity(provider("1")),code("queue_identity"));
  const forged=provider("1");forged.subject.connection_id="other";
  assert.equal(queueIdentity(forged,context).lane,queueIdentity(provider("1"),context).lane);
  assert.notEqual(queueIdentity(provider("1","other"),context).lane,queueIdentity(provider("1"),context).lane);
  assert.throws(()=>queuePolicySchema.parse({depth:100}),/reservations/);
  assert.equal(new Set(admissionCodes).size,admissionCodes.length);
});

test("provider bursts reserve Slack/internal/update depth and bytes atomically",async()=>{
  const {db}=await fixture({...policy,depth:20,reservations:{slack:2,internal:2,update:2}});
  for(let i=0;i<14;i++)db.enqueue(provider(String(i)),at,{connectionId:`tenant-${i}`});
  assert.throws(()=>db.enqueue(provider("over"),at,context),code("queue_depth"));
  const slack=db.enqueue(eventEnvelope("slack"),at).row;
  db.enqueue({...eventEnvelope("job"),source:"dona_job"},at);
  const update=db.enqueue({...eventEnvelope("update"),source:"dona_update"},at).row;
  assert.equal(db.nextAvailable(at)?.event_id,slack.event_id);
  assert.equal(db.updateEventsNeedingNotification()[0]?.event_id,update.event_id);
  assert.ok(db.queueHealth(at).metrics.some((m:any)=>m.code==="queue_depth"&&m.count===1));
  db.close();
});

test("weighted reserved selection proves finite Slack steps, lane FIFO and provider progress",async()=>{
  const {db}=await fixture();
  const expected=new Map<string,string[]>();
  for(let lane=0;lane<20;lane++){
    const ids=[];
    for(let i=0;i<20;i++)ids.push(db.enqueue(provider(`${lane}-${i}`),at,{connectionId:`tenant-${lane}`}).row.event_id);
    expected.set(`tenant-${lane}`,ids);
  }
  const slackIds=Array.from({length:20},(_,i)=>db.enqueue(eventEnvelope(`s-${i}`),at).row.event_id);
  let slackSteps:number[]=[]; const seen=new Set<string>();
  for(let step=0;step<150;step++) {
    const row=db.nextAvailable(at)!; assert.ok(row); assert.ok(!seen.has(row.event_id)); seen.add(row.event_id);
    if(row.source==="slack") {assert.equal(row.event_id,slackIds.shift());slackSteps.push(step);}
    else { const lane=`tenant-${row.external_event_id.split("-")[0]}`; assert.equal(row.event_id,expected.get(lane)!.shift()); }
    db.beginDispatch(row.event_id,"test-result",at);db.manualComplete(row.event_id,at);
  }
  assert.equal(slackSteps[0],0);
  for(let i=1;i<slackSteps.length;i++)assert.ok(slackSteps[i]!-slackSteps[i-1]!<=5);
  assert.equal(slackIds.length,0);
  for(const remaining of expected.values())assert.ok(remaining.length<20);
  db.close();
});

test("blocked/retry/dead-letter/ambiguous lane barriers permit other lanes only",async()=>{
  for(const state of ["blocked","retry","dead_letter","needs_review"]){
    const {db}=await fixture();
    const first=db.enqueue(provider("a1"),at,context).row;
    db.enqueue(provider("a2"),at,context);
    const other=db.enqueue(provider("b1"),at,{connectionId:"b"}).row;
    if(state==="blocked")db.markBlocked(first.event_id,"blocked");
    if(state==="retry")db.recordPreDispatchFailure(first.event_id,"offline","offline",5,at);
    if(state==="dead_letter")db.manualDeadLetter(first.event_id,at);
    if(state==="needs_review"){db.beginDispatch(first.event_id,"test",at);db.recoverStaleDispatching(at);}
    assert.equal(db.nextAvailable(at)?.event_id,other.event_id,state);
    db.beginDispatch(other.event_id,"test",at); db.manualComplete(other.event_id,at);
    assert.equal(db.nextAvailable(at),undefined);
    if(state==="needs_review"||state==="blocked")assert.throws(()=>db.manualRetry(first.event_id,false,at),/force/);
    db.manualComplete(first.event_id,at);
    assert.equal(db.nextAvailable(at)?.external_event_id,"a2");
    db.close();
  }
});

test("coalescing retains delivery identity, rejects mismatch and never crosses another event",async()=>{
  const {db,config}=await fixture();
  const leader=db.enqueue(provider("first"),at,signal).row;
  const combined=db.enqueue(provider("second"),at,signal);
  assert.equal(combined.admission,"coalesced");assert.equal(combined.row.event_id,leader.event_id);
  assert.equal(db.coalescedDeliveries(leader.event_id).length,1);
  assert.equal(db.getByExternalId("fake","second")?.event_id,leader.event_id);
  assert.equal(db.enqueue(provider("second"),at,signal).outcome,"duplicate_same");
  assert.equal(db.enqueue({...provider("second"),payload:{different:true}},at,signal).outcome,"duplicate_conflict");
  const mismatch=db.enqueue({...provider("different"),payload:{different:true}},at,signal);
  assert.equal(mismatch.admission,undefined);
  const tail=db.enqueue(provider("tail"),at,signal);
  assert.notEqual(tail.row.event_id,leader.event_id);
  const plain=db.enqueue(provider("plain"),at,context);
  assert.equal(plain.admission,undefined);
  const otherTenant=db.enqueue(provider("other"),at,{...signal,connectionId:"other"});
  assert.notEqual(otherTenant.row.event_id,leader.event_id);
  db.close();
  const reopen=new DispatcherDatabase(config.databasePath,policy);
  assert.equal(reopen.enqueue(provider("second"),at,signal).outcome,"duplicate_same");
  assert.equal(reopen.coalescedDeliveries(leader.event_id).length,1);
  reopen.close();
});

test("quota table covers payload bytes, source/tenant depth, burst, clocks and delivery bounds",async()=>{
  for(const scenario of ["bytes","depth","rate","deliveries"]){
    const opts={...policy,defaults:{...policy.defaults,...(scenario==="bytes"?{bytes:1}:scenario==="depth"?{depth:1}:scenario==="rate"?{burst:1}: {})},maxDeliveries:1};
    const {db}=await fixture(opts);
    if(scenario!=="bytes")db.enqueue(provider("first"),at,signal);
    assert.throws(()=>db.enqueue(provider("next"),at,scenario==="deliveries"?signal:context),code(`queue_${scenario}`));
    assert.equal(db.list().length,scenario==="bytes"?0:1);
    db.close();
  }
  const {db}=await fixture({...policy,defaults:{...policy.defaults,burst:1,rate:1}});
  db.enqueue(provider("first"),at,context);
  assert.throws(()=>db.enqueue(provider("past"),new Date(at.getTime()-10000),context),code("queue_rate"));
  assert.equal(db.enqueue(provider("future"),new Date(at.getTime()+1000),context).outcome,"created");
  assert.throws(()=>db.enqueue(provider("past2"),at,context),code("queue_rate"));
  db.close();
});

function stripQueue(raw:Database.Database){raw.exec("DROP TABLE queue_deliveries; DROP TABLE queue_events; DROP TABLE queue_lanes; DROP TABLE queue_sources; DROP TABLE queue_metrics; DROP TABLE queue_selector; PRAGMA user_version=2;");}
test("v2 migration preserves every event field, rolls back DDL and checks indexes/integrity",async()=>{
  const {db,config}=await fixture();
  const first=db.enqueue(eventEnvelope("one"),at).row;
  db.manualComplete(first.event_id,at);
  db.enqueue(provider("legacy"),at,context);
  const before=db.list();db.close();
  const raw=new Database(config.databasePath);stripQueue(raw);
  raw.exec("CREATE TABLE queue_metrics (collision INTEGER)");raw.close();
  assert.throws(()=>new DispatcherDatabase(config.databasePath),/already exists/);
  const check=new Database(config.databasePath);
  assert.equal(check.pragma("user_version",{simple:true}),2);
  assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='queue_events'").get(),undefined);
  check.exec("DROP TABLE queue_metrics");check.close();
  const migrated=new DispatcherDatabase(config.databasePath);
  assert.deepEqual(migrated.list(),before);migrated.close();
  const verify=new Database(config.databasePath);
  assert.equal(verify.pragma("integrity_check",{simple:true}),"ok");assert.deepEqual(verify.pragma("foreign_key_check"),[]);
  assert.ok(verify.prepare("SELECT name FROM sqlite_master WHERE name='queue_events_coalesce'").get());
  assert.equal(verify.pragma("user_version",{simple:true}),4);verify.close();
});

test("independent producers serialize quotas and independent claim attempts dispatch once",async()=>{
  const {db,config,root}=await fixture({...policy,defaults:{...policy.defaults,depth:2}});db.close();
  const script=path.join(root,"producer.mjs");
  const databaseModule=new URL("../src/database.ts",import.meta.url).href;
  await fs.writeFile(script,`import { DispatcherDatabase } from ${JSON.stringify(databaseModule)};\nconst d=new DispatcherDatabase(process.argv[2],${JSON.stringify({...policy,defaults:{...policy.defaults,depth:2}})});\ntry { d.enqueue({...${JSON.stringify(provider("dynamic"))},external_event_id:process.argv[3]},new Date(${JSON.stringify(at.toISOString())}),${JSON.stringify(context)});process.stdout.write('created'); } catch(e) {process.stdout.write(e.code??e.message);} finally {d.close();}`);
  const results=await Promise.all(Array.from({length:6},(_,i)=>promisify(execFile)(process.execPath,["--import","tsx",script,config.databasePath,String(i)])));
  assert.equal(results.filter(r=>r.stdout==="created").length,2);
  assert.equal(results.filter(r=>r.stdout==="queue_depth").length,4);
  const a=new DispatcherDatabase(config.databasePath,policy),b=new DispatcherDatabase(config.databasePath,policy);
  const row=a.nextAvailable(at)!;assert.equal(b.nextAvailable(at)?.event_id,row.event_id);
  a.beginDispatch(row.event_id,"test",at);assert.throws(()=>b.beginDispatch(row.event_id,"test",at),/no longer/);
  assert.equal(b.nextAvailable(at),undefined);a.close();b.close();
});

test("DB busy is explicit, crash after coalesce commit is durable, shutdown closes claims",async()=>{
  const {db,config,root}=await fixture();db.enqueue(provider("first"),at,signal);
  const lock=new Database(config.databasePath);lock.exec("BEGIN IMMEDIATE");
  assert.throws(()=>db.enqueue(provider("busy"),at,context),(e:any)=>e.code==="SQLITE_BUSY");
  lock.exec("ROLLBACK");lock.close();assert.equal(db.getByExternalId("fake","busy"),undefined);
  const script=path.join(root,"crash.mjs");
  await fs.writeFile(script,`import {DispatcherDatabase} from ${JSON.stringify(new URL("../src/database.ts",import.meta.url).href)};const d=new DispatcherDatabase(process.argv[2],${JSON.stringify(policy)});d.enqueue(${JSON.stringify(provider("second"))},new Date(${JSON.stringify(at.toISOString())}),${JSON.stringify(signal)});process.kill(process.pid,'SIGKILL');`);
  const outcome=await new Promise<string|null>(resolve=>{const child=spawn(process.execPath,["--import","tsx",script,config.databasePath],{stdio:"ignore"});child.on("exit",(_code,signal)=>resolve(signal));});
  assert.equal(outcome,"SIGKILL");
  assert.equal(db.enqueue(provider("second"),at,signal).outcome,"duplicate_same");
  assert.equal(db.list().length,1);
  const row=db.nextAvailable(at)!;db.closeClaims();
  assert.equal(db.nextAvailable(at),undefined);assert.throws(()=>db.beginDispatch(row.event_id,"test",at),/closed/);
  assert.throws(()=>db.enqueue(provider("late"),at,context),code("queue_quiescing"));
  assert.equal(db.queueHealth(at).queued,1);assert.equal(db.queueHealth(at).in_flight,0);db.close();
});

test("source quota spans connections and property names do not select inherited policies",async()=>{
  const {db}=await fixture({...policy,sources:{fake:{...policy.defaults,depth:1}}});
  db.enqueue(provider("a"),at,{connectionId:"a"});
  assert.throws(()=>db.enqueue(provider("b"),at,{connectionId:"b"}),code("queue_depth"));
  assert.equal(db.enqueue(provider("other","constructor"),at,context).outcome,"created");db.close();
});
