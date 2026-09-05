import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { eventEnvelope } from "./helpers.js";
import { DispatcherDatabase } from "../src/database.js";
import { externalEventSource, scopedExternalEventId } from "../src/ingress.js";
import { ConnectionLifecycle } from "../src/connections/lifecycle.js";
import { ConnectionRegistry } from "../src/connections/registry.js";
import { migrateConnections } from "../src/connections/schema.js";
import { runConnectionCli } from "../src/connections/cli.js";
import type { Capability, Clock, Connection, ConnectionConfig, DeliveryBinding, Driver, Operation, ProviderObservation, Subscription } from "../src/connections/domain.js";
import type { EventEnvelope } from "../src/types.js";

class FakeClock implements Clock { value = 1_800_000_000_000; now() { return this.value; } }
const managed: Capability = { kind: "managed", cursor: true, renewal: "replace", windowMs: 1000 };
const config: ConnectionConfig = { id: "pilot", provider: "drive", account: "account1", credentialRef: "cred_fixture",
  credentialRevision: 1, allowlist: [{ resource: "folder1", events: ["changed"] }], capability: managed };
class FakeDriver implements Driver {
  provider = "drive";
  capability: Capability = managed; creates = 0; stops = 0; available = true; loss = false; timeout = false; cutover = false;
  observations = new Map<string, ProviderObservation>();
  constructor(readonly clock: FakeClock) {}
  async credentialAvailable() { return this.available; }
  async create(_c: Connection, operation: Operation) {
    this.creates++;
    const result = { providerId: `channel${operation.generation}`, verified: true, cutoverConfirmed: this.cutover, expiresAt: this.clock.now() + 10_000 };
    this.observations.set(operation.id, result);
    if (this.timeout) return new Promise<ProviderObservation>(() => {});
    if (this.loss) throw new Error("secret-response-must-not-leak");
    return result;
  }
  async lookup(_c: Connection, operation: Operation) { return this.observations.get(operation.id) ?? null; }
  async inspect(_c: Connection, subscription: Subscription) {
    return { providerId: subscription.providerId!, expiresAt: this.clock.now() + 10_000, verified: true, cutoverConfirmed: this.cutover };
  }
  async stop() { this.stops++; }
}
function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dona-connections-"));
  const file = path.join(dir, "dispatcher.sqlite"); const clock = new FakeClock();
  const db = new DispatcherDatabase(file, clock); const driver = new FakeDriver(clock);
  const lifecycle = new ConnectionLifecycle(db.connections, driver, { authorize: async () => true }, 20);
  t.after(() => { try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  db.connections.register(config);
  return { db, clock, file, driver, lifecycle, dir };
}
function binding(generation = 1): DeliveryBinding { return { connectionId: config.id, account: config.account, revision: 1,
  credentialRevision: 1, resource: "folder1", generation }; }
function event(id = "change1"): EventEnvelope {
  const source = externalEventSource("drive");
  return { schema_version: 1, source, external_event_id: scopedExternalEventId(source, "pilot", id), type: "changed",
    occurred_at: "2026-09-05T00:00:00.000Z", subject: { resource: "folder1" }, payload: { value: 1 }, reply_target: null };
}

test("create→verify→renew→overlap dedup→cutover→stop→disable は永続化される", async (t) => {
  const {db,clock,driver,lifecycle,file} = fixture(t);
  await lifecycle.createOrRenew("pilot","folder1");
  assert.equal(db.connections.get("pilot").state,"active");
  assert.throws(() => db.connections.claim("pilot",1,"folder1",20), /invalid_transition/);
  clock.value += 9000;
  await lifecycle.createOrRenew("pilot","folder1");
  const first = db.enqueueExternal(event(),binding(1));
  const second = db.enqueueExternal(event(),binding(2));
  assert.equal(first.outcome,"created"); assert.equal(second.outcome,"duplicate_same");
  assert.equal(first.row.event_id,second.row.event_id);
  assert.throws(() => db.connections.claim("pilot",1,"folder1",20,"stop",1),/invalid_transition/);
  driver.cutover = true; await lifecycle.verify("pilot","folder1",2);
  assert.equal(db.connections.subscriptions("pilot")[0]!.state,"stop_candidate");
  await lifecycle.stop("pilot","folder1",1); assert.equal(driver.stops,1);
  db.connections.disable("pilot",1);
  assert.throws(() => db.enqueueExternal(event("later"),binding(2)),/disabled/);
  assert.equal(db.nextAvailable(),undefined);
  assert.throws(() => db.beginDispatch(first.row.event_id,"fixture.json"),/no longer dispatchable/);
  const reopened = new DispatcherDatabase(file,clock);
  try { assert.equal(reopened.connections.get("pilot").state,"disabled"); assert.equal(reopened.get(first.row.event_id)!.status,"queued"); }
  finally { reopened.close(); }
});

test("同時 renewal と lease expiry は新 generation を再createしない", async (t) => {
  const {db,clock,file,driver,lifecycle} = fixture(t);
  await lifecycle.createOrRenew("pilot","folder1"); clock.value += 9000;
  const peer = new DispatcherDatabase(file,clock); t.after(() => peer.close());
  const other = new ConnectionLifecycle(peer.connections,driver,{authorize:async()=>true},20);
  const results = await Promise.allSettled([lifecycle.createOrRenew("pilot","folder1"),other.createOrRenew("pilot","folder1")]);
  assert.equal(results.filter((r)=>r.status==="fulfilled").length,1); assert.equal(driver.creates,2);
  clock.value += 9000; driver.loss=true;
  const operation = await lifecycle.createOrRenew("pilot","folder1");
  assert.equal(db.connections.operations("pilot").at(-1)!.state,"unknown");
  clock.value += 1000;
  await assert.rejects(other.createOrRenew("pilot","folder1"), /operation_pending/);
  await other.reconcile("pilot",operation.id);
  assert.equal(driver.creates,3); assert.equal(db.connections.operations("pilot").at(-1)!.state,"done");
  assert.doesNotMatch(JSON.stringify(db.connections.inspect()), /secret-response/);
});

test("create成功後timeoutとrestartはlookupのみで復旧する", async (t) => {
  const {db,clock,file,driver,lifecycle} = fixture(t); driver.timeout=true;
  const operation = await lifecycle.createOrRenew("pilot","folder1");
  assert.equal(db.connections.subscriptions("pilot")[0]!.state,"renewal_unknown");
  const peer = new DispatcherDatabase(file,clock); t.after(()=>peer.close());
  const resumed = new ConnectionLifecycle(peer.connections,driver,{authorize:async()=>true},20);
  await resumed.reconcile("pilot",operation.id); assert.equal(driver.creates,1);
  assert.equal(peer.connections.get("pilot").state,"active");
});

test("claim直後crashとnot-found lookupはblind createへ戻らない", async (t) => {
  const {db,clock,file,driver} = fixture(t);
  const op = db.connections.claim("pilot",1,"folder1",10); clock.value += 11;
  const peer = new DispatcherDatabase(file,clock); t.after(()=>peer.close());
  const resumed = new ConnectionLifecycle(peer.connections,driver,{authorize:async()=>true},20);
  await assert.rejects(resumed.reconcile("pilot",op.id),/operation_pending/);
  await assert.rejects(resumed.createOrRenew("pilot","folder1"),/operation_pending/);
  assert.equal(driver.creates,0);
});

test("credential unavailable、権限拒否、capability mismatchは外部writeを0回にする", async (t) => {
  const {db,driver,lifecycle} = fixture(t); driver.available=false;
  await assert.rejects(lifecycle.createOrRenew("pilot","folder1"),/credential_unavailable/);
  assert.equal(db.connections.get("pilot").state,"degraded"); driver.available=true;
  const denied = new ConnectionLifecycle(db.connections,driver,{authorize:async()=>false});
  await assert.rejects(denied.createOrRenew("pilot","folder1"),/not_authorized/);
  driver.capability={kind:"manual",cursor:true};
  await assert.rejects(lifecycle.createOrRenew("pilot","folder1"),/capability_mismatch/);
  assert.equal(driver.creates,0);
});

test("capability matrix: UI/manualはcreate不可、non-renewableは期限更新を強制しない", (t) => {
  const {db} = fixture(t);
  for (const [index, capability] of ([{kind:"manual",cursor:false},{kind:"managed",cursor:false,renewal:"none"}] as Capability[]).entries()) {
    const id = `matrix${index}`; db.connections.register({...config,id,capability});
    if (capability.kind === "manual") {
      assert.throws(()=>db.connections.claim(id,1,"folder1",10),/capability_mismatch/);
      db.connections.attachManual(id,1,"folder1","manual-id",null);
      db.connections.observe(id,1,"folder1",1,{providerId:"manual-id",expiresAt:null,verified:true,cutoverConfirmed:false});
    } else {
      const op = db.connections.claim(id,1,"folder1",10);
      db.connections.observe(id,1,"folder1",1,{providerId:"api-id",expiresAt:null,verified:true,cutoverConfirmed:false},op);
      assert.throws(()=>db.connections.claim(id,1,"folder1",10),/invalid_transition/);
    }
    assert.equal(db.connections.get(id).state,"active");
  }
});

test("allowlistとcredential revisionを同時bindingし変更時はfail closed", async (t) => {
  const {db,lifecycle} = fixture(t); await lifecycle.createOrRenew("pilot","folder1");
  for (const b of [{...binding(),account:"other"},{...binding(),credentialRevision:2},{...binding(),resource:"other"},{...binding(),revision:2}])
    assert.throws(()=>db.enqueueExternal(event(),b));
  assert.throws(()=>db.enqueueExternal({...event(),type:"deleted"},binding()),/not_authorized/);
  const accepted = db.enqueueExternal(event(),binding());
  db.connections.revise("pilot",1,{...config,credentialRevision:2});
  assert.equal(db.connections.get("pilot").state,"degraded");
  assert.throws(()=>db.enqueueExternal(event("later"),binding()),/revision_conflict/);
  assert.equal(db.nextAvailable(),undefined);
  await lifecycle.verify("pilot","folder1",1);
  assert.equal(db.connections.get("pilot").state,"active");
  assert.throws(()=>db.beginDispatch(accepted.row.event_id,"fixture"),/no longer dispatchable/);
  assert.equal(db.enqueueExternal(event("fresh"),{...binding(),revision:2,credentialRevision:2}).outcome,"created");
});

test("cursor compare/commitはbatchと同一transaction、競合・partial page・crashをrollback", async (t) => {
  const {db,lifecycle,file,clock} = fixture(t); await lifecycle.createOrRenew("pilot","folder1");
  const expected = db.connections.cursor("pilot","folder1");
  const batch = {binding:binding(),expected,checkpoint:"private-page-token",complete:true,events:[{providerEventId:"change1",envelope:event()}]};
  assert.throws(()=>db.commitConnectionBatch({...batch,complete:false}),/incomplete_batch/);
  assert.deepEqual(db.connections.cursor("pilot","folder1"),expected);
  const raw = new Database(file); t.after(()=>raw.close());
  // SQLite failure exactly at checkpoint write, after event insert.
  raw.exec("CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON connection_cursors BEGIN SELECT RAISE(ABORT,'crash-before-checkpoint'); END");
  assert.throws(()=>db.commitConnectionBatch(batch),/crash-before-checkpoint/);
  assert.equal(db.list().length,0); assert.deepEqual(db.connections.cursor("pilot","folder1"),expected);
  raw.exec("DROP TRIGGER fail_checkpoint");
  const peer = new DispatcherDatabase(file,clock); t.after(()=>peer.close());
  const results = await Promise.allSettled([Promise.resolve().then(()=>db.commitConnectionBatch(batch)),Promise.resolve().then(()=>peer.commitConnectionBatch(batch))]);
  assert.equal(results.filter((r)=>r.status==="fulfilled").length,1); assert.equal(db.list().length,1);
  assert.equal(peer.connections.cursor("pilot","folder1").version,1);
  // response loss after commit: stale compare does not advance again.
  assert.throws(()=>peer.commitConnectionBatch(batch),/cursor_conflict/);
  assert.doesNotMatch(JSON.stringify(db.connections.inspect()),/private-page-token/);
  assert.equal(db.connections.cursor("pilot","folder1").checkpoint,"private-page-token");
});

test("batch中のduplicate conflictは前のeventもrollbackする", async (t) => {
  const {db,lifecycle}=fixture(t); await lifecycle.createOrRenew("pilot","folder1");
  db.enqueueExternal(event(),binding()); const expected=db.connections.cursor("pilot","folder1");
  assert.throws(()=>db.commitConnectionBatch({binding:binding(),expected,checkpoint:"next",complete:true,events:[
    {providerEventId:"new",envelope:event("new")},{providerEventId:"change1",envelope:{...event(),payload:{value:2}}},
  ]}),/duplicate_conflict/);
  assert.equal(db.list().length,1); assert.equal(db.connections.cursor("pilot","folder1").version,0);
});

test("expiry-windowの境界、clock rewind、期限切れdeliveryを拒否", async (t) => {
  const {db,clock,lifecycle}=fixture(t); await lifecycle.createOrRenew("pilot","folder1");
  const initial=clock.value; clock.value+=8999;
  assert.throws(()=>db.connections.claim("pilot",1,"folder1",10),/invalid_transition/);
  clock.value++; assert.equal(db.connections.health().expiring,1);
  const operation=db.connections.claim("pilot",1,"folder1",10); assert.equal(operation.generation,2);
  clock.value=initial-1; assert.throws(()=>db.enqueueExternal(event(),binding()),/clock_skew/);
  clock.value=initial+10000; assert.throws(()=>db.enqueueExternal(event(),binding()),/not_authorized/);
});

test("DB busyはclaimを残さずprovider writeを呼ばない", async (t) => {
  const {db,file,lifecycle,driver}=fixture(t);
  const raw=new Database(file); t.after(()=>raw.close()); raw.exec("BEGIN IMMEDIATE");
  try { await assert.rejects(lifecycle.createOrRenew("pilot","folder1"),/locked/); }
  finally { raw.exec("ROLLBACK"); }
  assert.equal(driver.creates,0); assert.equal(db.connections.operations("pilot").length,0);
});

test("disableとdeliveryの競合および未bindingのmanaged sourceはfail closed", async (t) => {
  const {db,file,clock,lifecycle}=fixture(t); await lifecycle.createOrRenew("pilot","folder1");
  const peer=new DispatcherDatabase(file,clock); t.after(()=>peer.close());
  const legacy=db.enqueue(event("unbound"));
  assert.equal(db.nextAvailable(),undefined);
  assert.throws(()=>db.beginDispatch(legacy.row.event_id,"fixture"),/no longer dispatchable/);
  await Promise.all([Promise.resolve().then(()=>peer.connections.disable("pilot",1)),Promise.resolve().then(()=>assert.throws(()=>db.enqueueExternal(event(),binding()),/disabled/))]);
  assert.equal(db.list().length,1);
});

test("additive migrationはlegacy user_version/event/jobを保ちrollbackとFKを検証", (t) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"dona-migration-")); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,"legacy.sqlite");
  const initial=new DispatcherDatabase(file);
  const oldEvent=initial.enqueue(eventEnvelope("legacy-fixture")).row;
  const oldJob=initial.createJob({source_event_id:oldEvent.event_id,objective:"互換fixture",workspace:{kind:"scratch"}},dir,dir).row;
  initial.close();
  const raw=new Database(file); t.after(()=>raw.close());
  // 旧 schema の table/rows を保ったまま component table を外した fixture。
  raw.exec("DROP TABLE connection_audit; DROP TABLE connection_event_bindings; DROP TABLE connection_cursors; DROP TABLE connection_operations; DROP TABLE connection_subscriptions; DROP TABLE connections; DROP TABLE connection_schema");
  const legacySchema=raw.prepare("SELECT sql FROM sqlite_master WHERE name IN ('events','jobs') ORDER BY name").all();
  const version=raw.pragma("user_version",{simple:true});
  const events=raw.prepare("SELECT * FROM events").all(), jobs=raw.prepare("SELECT * FROM jobs").all();
  migrateConnections(raw);
  assert.equal(raw.pragma("user_version",{simple:true}),version);
  assert.deepEqual(raw.prepare("SELECT * FROM events").all(),events);
  assert.deepEqual(raw.prepare("SELECT * FROM jobs").all(),jobs);
  const upgraded=new DispatcherDatabase(file);
  assert.deepEqual(upgraded.get(oldEvent.event_id),oldEvent); assert.deepEqual(upgraded.getJob(oldJob.job_id),oldJob); upgraded.close();
  assert.deepEqual(raw.prepare("SELECT sql FROM sqlite_master WHERE name IN ('events','jobs') ORDER BY name").all(),legacySchema);
  assert.equal(raw.pragma("integrity_check",{simple:true}),"ok"); assert.deepEqual(raw.pragma("foreign_key_check"),[]);
  assert.throws(()=>raw.prepare("INSERT INTO connection_event_bindings VALUES('missing','missing',1,'missing',1)").run(),/FOREIGN KEY/);
  const broken=new Database(":memory:"); t.after(()=>broken.close());
  broken.exec("CREATE TABLE connections(id TEXT)"); assert.throws(()=>migrateConnections(broken));
  assert.equal(broken.prepare("SELECT name FROM sqlite_master WHERE name='connection_schema'").get(),undefined);
});

test("CLI inspectionはreadonly、config secret field拒否・reference/cursorをredact", (t) => {
  const {db,file,dir}=fixture(t);
  const before=fs.statSync(file).mode;
  assert.doesNotMatch(JSON.stringify(runConnectionCli(file,["list"])),/cred_fixture/);
  assert.equal(fs.statSync(file).mode,before);
  assert.throws(()=>db.connections.register({...config,id:"other",token:"secret"}),/invalid_input/);
  assert.throws(()=>db.connections.register({...config,id:"other",credentialRef:"raw-secret"}),/invalid_input/);
  assert.throws(()=>runConnectionCli(file,["disable","pilot","1"]),/not_authorized/);
  const configPath=path.join(dir,"config.json"); fs.writeFileSync(configPath,'{"secret":"do-not-print",BROKEN}');
  assert.throws(()=>runConnectionCli(file,["register",configPath,"--confirm"]),/^ConnectionError: invalid_input$/);
  runConnectionCli(file,["disable","pilot","1","--confirm"]);
  assert.equal(db.connections.get("pilot").state,"disabled");
});

// 別process/別SQLite connectionを同じbarrierから起動し、実lock競合を検証する。
async function raceProcesses(file: string, now: number, actions: string[]): Promise<{ok:boolean; code?:string}[]> {
  const {spawn} = await import("node:child_process");
  const {pathToFileURL} = await import("node:url");
  const databaseModule=pathToFileURL(path.resolve("src/database.ts")).href;
  const script=`import {DispatcherDatabase} from ${JSON.stringify(databaseModule)};
    const db=new DispatcherDatabase(process.argv[1],{now:()=>Number(process.argv[2])});
    process.send('ready'); process.on('message',()=>{try {
      const action=process.argv[3];
      if(action==='claim') db.connections.claim('pilot',1,'folder1',20);
      else if(action==='disable') db.connections.disable('pilot',1);
      else db.commitConnectionBatch(JSON.parse(action));
      process.send({ok:true});
    }catch(e){process.send({ok:false,code:e.code??e.message});}finally{db.close();process.disconnect();}});`;
  const children=actions.map((action)=>spawn(process.execPath,["--import","tsx","--input-type=module","-e",script,file,String(now),action],{stdio:["ignore","ignore","pipe","ipc"]}));
  try {
    await Promise.all(children.map((child)=>new Promise<void>((resolve,reject)=>{
      child.once("message",()=>resolve()); child.once("error",reject); child.once("exit",(code)=>{if(code)reject(new Error(`child exit ${code}`));});
    })));
    const results=children.map((child)=>new Promise<{ok:boolean;code?:string}>((resolve,reject)=>{
      child.once("message",(message)=>resolve(message as {ok:boolean;code?:string}));child.once("error",reject);
    }));
    children.forEach((child)=>child.send("go")); return await Promise.all(results);
  } finally { children.forEach((child)=>child.kill()); }
}

test("別processの同時renewal/cursor commit/disable-deliveryが直列化される", async (t) => {
  const {db,clock,file,lifecycle}=fixture(t); await lifecycle.createOrRenew("pilot","folder1"); clock.value+=9000;
  const claims=await raceProcesses(file,clock.now(),["claim","claim"]);
  assert.equal(claims.filter((r)=>r.ok).length,1);
  const expected=db.connections.cursor("pilot","folder1");
  const batch={binding:binding(),expected,checkpoint:"page2",complete:true,events:[{providerEventId:"change1",envelope:event()}]};
  const commits=await raceProcesses(file,clock.now(),[JSON.stringify(batch),JSON.stringify(batch)]);
  assert.equal(commits.filter((r)=>r.ok).length,1); assert.equal(db.connections.cursor("pilot","folder1").version,1);
  const next={...batch,expected:db.connections.cursor("pilot","folder1"),checkpoint:"page3",events:[{providerEventId:"next",envelope:event("next")}]};
  const disabled=await raceProcesses(file,clock.now(),["disable",JSON.stringify(next)]);
  assert.equal(disabled[0]!.ok,true);
  assert.equal(db.connections.cursor("pilot","folder1").version,disabled[1]!.ok ? 2 : 1);
  assert.equal(db.nextAvailable(),undefined);
});

test("stop応答不明は再stopせずlookupで停止を確定する",async(t)=>{
  const {db,clock,driver,lifecycle}=fixture(t); await lifecycle.createOrRenew("pilot","folder1");
  clock.value+=9000; driver.cutover=true; await lifecycle.createOrRenew("pilot","folder1");
  driver.stop=async()=>{driver.stops++;throw new Error("private-stop-response");};
  const operation=await lifecycle.stop("pilot","folder1",1);
  assert.equal(db.connections.operations("pilot").at(-1)!.state,"unknown");
  await assert.rejects(lifecycle.stop("pilot","folder1",1),/operation_pending/);
  await lifecycle.reconcile("pilot",operation.id);
  assert.equal(db.connections.subscriptions("pilot")[0]!.state,"stopped");assert.equal(driver.stops,1);
});

test("cursor revision変更後は明示rebindまで再開せずcheckpointを保持する",async(t)=>{
  const {db,lifecycle}=fixture(t);await lifecycle.createOrRenew("pilot","folder1");
  db.commitConnectionBatch({binding:binding(),expected:db.connections.cursor("pilot","folder1"),checkpoint:"page2",complete:true,events:[]});
  const old=db.connections.cursor("pilot","folder1");
  db.connections.revise("pilot",1,{...config,credentialRevision:2});await lifecycle.verify("pilot","folder1",1);
  const batch={binding:{...binding(),revision:2,credentialRevision:2},expected:old,checkpoint:"page3",complete:true,events:[]};
  assert.throws(()=>db.commitConnectionBatch(batch),/cursor_conflict/);
  db.connections.rebindCursor("pilot","folder1",old,2);
  assert.equal(db.connections.cursor("pilot","folder1").checkpoint,"page2");
  db.commitConnectionBatch({...batch,expected:db.connections.cursor("pilot","folder1")});
  assert.equal(db.connections.cursor("pilot","folder1").version,3);
});

test("実page fetchの途中失敗/timeout/循環ではeventとcursorをcommitしない",async(t)=>{
  const {pollConnectionBatch}=await import("../src/connections/poll.js");
  const {db,lifecycle}=fixture(t);await lifecycle.createOrRenew("pilot","folder1");
  let pages=0;
  await assert.rejects(pollConnectionBatch(db,binding(),async()=>{
    if(++pages===2)throw new Error("private-page-secret");
    return {done:false,nextPage:"page2",events:[{providerEventId:"change1",envelope:event()}]};
  }),/incomplete_batch/);
  assert.equal(pages,2);assert.equal(db.list().length,0);assert.equal(db.connections.cursor("pilot","folder1").version,0);
  await assert.rejects(pollConnectionBatch(db,binding(),async()=>new Promise(()=>{}),{pages:2,events:2,timeoutMs:10}),/incomplete_batch/);
  await assert.rejects(pollConnectionBatch(db,binding(),async()=>({done:false,nextPage:"page2",events:[]})),/incomplete_batch/);
  pages=0;
  await pollConnectionBatch(db,binding(),async(_checkpoint,page)=>{
    pages++;return page===null?{done:false,nextPage:"page2",events:[{providerEventId:"change1",envelope:event()}]}:
      {done:true,checkpoint:"final",events:[]};
  });
  assert.equal(pages,2);assert.equal(db.list().length,1);assert.equal(db.connections.cursor("pilot","folder1").checkpoint,"final");
});

test("未解決create/stopのrevision変更は拒否しreconcile可能性を維持する",async(t)=>{
  const {db,driver,lifecycle,clock}=fixture(t);driver.loss=true;
  const op=await lifecycle.createOrRenew("pilot","folder1");
  assert.throws(()=>db.connections.revise("pilot",1,{...config,credentialRevision:2}),/operation_pending/);
  assert.equal(db.connections.get("pilot").revision,1);
  await lifecycle.reconcile("pilot",op.id);driver.loss=false;driver.cutover=true;clock.value+=9000;
  await lifecycle.createOrRenew("pilot","folder1");
  const stop=db.connections.claim("pilot",1,"folder1",20,"stop",1);
  assert.throws(()=>db.connections.revise("pilot",1,config),/operation_pending/);
  clock.value+=21;await lifecycle.reconcile("pilot",stop.id);
  assert.equal(db.connections.revise("pilot",1,{...config,credentialRevision:2}).revision,2);
});

test("queue待機中の期限切れはdispatch不可、新generation再送でbindingを更新する",async(t)=>{
  const {db,clock,lifecycle}=fixture(t);await lifecycle.createOrRenew("pilot","folder1");
  const accepted=db.enqueueExternal(event(),binding());clock.value+=9000;await lifecycle.createOrRenew("pilot","folder1");
  clock.value+=1000;
  assert.equal(db.nextAvailable(new Date(clock.now())),undefined);
  assert.throws(()=>db.beginDispatch(accepted.row.event_id,"fixture",new Date(clock.now())),/no longer dispatchable/);
  assert.equal(db.enqueueExternal(event(),binding(2)).outcome,"duplicate_same");
  assert.equal(db.nextAvailable(new Date(clock.now()))!.event_id,accepted.row.event_id);
  assert.equal(db.beginDispatch(accepted.row.event_id,"fixture",new Date(clock.now())).status,"dispatching");
});

test("resource Aの検証失敗はBの成功後もquarantineを維持する",async(t)=>{
  const {db,driver,lifecycle,clock}=fixture(t);
  db.connections.revise("pilot",1,{...config,allowlist:[...config.allowlist,{resource:"folder2",events:["changed"]}]});
  // 複数resourceに異なるprovider IDを返すdriver。
  driver.create=async(_c,op)=>({providerId:op.resource,verified:true,cutoverConfirmed:false,expiresAt:clock.now()+10000});
  await lifecycle.createOrRenew("pilot","folder1");await lifecycle.createOrRenew("pilot","folder2");
  const b={...binding(),revision:2};const accepted=db.enqueueExternal(event(),b);
  driver.inspect=async(_c,s)=>{
    if(s.resource==='folder1')throw new Error("private-read-failure");
    return {providerId:s.providerId!,verified:true,cutoverConfirmed:false,expiresAt:clock.now()+10000};
  };
  await assert.rejects(lifecycle.verify("pilot","folder1",1),/not_authorized/);
  await lifecycle.verify("pilot","folder2",1);
  assert.equal(db.connections.get("pilot").state,"active");
  assert.throws(()=>db.enqueueExternal(event("blocked"),b),/not_authorized/);
  assert.throws(()=>db.beginDispatch(accepted.row.event_id,"fixture",new Date(clock.now())),/no longer dispatchable/);
  assert.equal(db.connections.subscriptions("pilot")[0]!.verifiedAt,null);
});

test("未commitの初期cursorもrevision変更後は明示rebindが必要",async(t)=>{
  const {db,lifecycle}=fixture(t);const original=db.connections.cursor("pilot","folder1");
  await lifecycle.createOrRenew("pilot","folder1");db.connections.revise("pilot",1,{...config,credentialRevision:2});
  await lifecycle.verify("pilot","folder1",1);
  assert.deepEqual(db.connections.cursor("pilot","folder1"),original);
  const batch={binding:{...binding(),revision:2,credentialRevision:2},expected:original,checkpoint:"page1",complete:true,events:[]};
  assert.throws(()=>db.commitConnectionBatch(batch),/cursor_conflict/);
  db.connections.rebindCursor("pilot","folder1",original,2);
  db.commitConnectionBatch({...batch,expected:db.connections.cursor("pilot","folder1")});
  assert.equal(db.connections.cursor("pilot","folder1").version,2);
});

test("同じcapabilityの別provider driverはcredential確認前に拒否する",async(t)=>{
  const {db,driver,lifecycle}=fixture(t);driver.provider="wrong-provider";let reads=0;
  driver.credentialAvailable=async()=>{reads++;return true;};
  await assert.rejects(lifecycle.createOrRenew("pilot","folder1"),/capability_mismatch/);
  assert.equal(reads,0);assert.equal(driver.creates,0);assert.equal(db.connections.operations("pilot").length,0);
});
