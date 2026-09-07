import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DispatcherDatabase } from "../src/database.js";
import { drainDriveChanges, initializeDriveCursor, verifyDrivePush, type DriveChannelBinding } from "../src/providers/google-drive.js";

const now = 1_800_000_000_000;
const clock = { now: () => now };
const channel: DriveChannelBinding = { connectionId: "drive-pilot", account: "test-account", revision: 1,
  credentialRevision: 1, resource: "root", generation: 1, channelId: "channel-1", channelToken: "secret-token", resourceId: "resource-1" };
const binding = { connectionId: channel.connectionId, account: channel.account, revision: channel.revision,
  credentialRevision: channel.credentialRevision, resource: channel.resource, generation: channel.generation };
const headers = (state = "change", number = "7") => [
  ["X-Goog-Channel-ID", "channel-1"], ["X-Goog-Channel-Token", "secret-token"],
  ["X-Goog-Resource-ID", "resource-1"], ["X-Goog-Resource-State", state], ["X-Goog-Message-Number", number],
] as const;

test("push headerは空body・channel/token/resourceを束縛し、syncと非連番message numberを区別する", () => {
  assert.deepEqual(verifyDrivePush(Buffer.alloc(0), headers("sync", "1"), [channel]).kind, "sync");
  assert.equal(verifyDrivePush(Buffer.alloc(0), headers("change", "9"), [channel]).messageNumber, 9n);
  assert.equal(verifyDrivePush(Buffer.alloc(0), headers("change", "200"), [channel]).messageNumber, 200n);
  assert.throws(() => verifyDrivePush(Buffer.from("{}"), headers(), [channel]), /invalid_input/);
  assert.throws(() => verifyDrivePush(Buffer.alloc(0), headers().map((h) => h[0].toLowerCase() === "x-goog-channel-token" ? [h[0], "wrong"] : h), [channel]), /not_authorized/);
  assert.throws(() => verifyDrivePush(Buffer.alloc(0), [...headers(), ["x-goog-channel-id", "channel-1"]], [channel]), /not_authorized/);
  assert.throws(() => verifyDrivePush(Buffer.alloc(0), headers("update"), [channel]), /not_authorized/);
});

test("同じdrain内のfolder加入後のparent snapshot変化をreconciliationへ隔離する", async (t) => {
  const db=fixture(t); let page=0;
  const client={list:async()=> ++page===1 ? {changes:[{fileId:"moving",changeType:"file",time:"2026-09-07T00:00:00Z",file:{id:"moving",parents:["folder-1"]}}],nextPageToken:"page-2"} :
    {changes:[{fileId:"moving",changeType:"file",time:"2026-09-07T00:00:01Z",file:{id:"moving",parents:["outside"],name:"private"}}],newStartPageToken:"next"}};
  await assert.rejects(drainDriveChanges(db,binding,client,{fileIds:new Set(),folderIds:new Set(["folder-1"]),driveIds:new Set()}),/operation_pending/);
  assert.equal(db.list().length,1);
});

test("page continuationとmembershipを同時commitし再起動後のparent変化を隔離する", async (t) => {
  const db=fixture(t);
  const first={list:async()=>({changes:[{fileId:"moving",changeType:"file",time:"2026-09-07T00:00:00Z",file:{id:"moving",parents:["folder-1"]}}],nextPageToken:"page-2"})};
  await assert.rejects(drainDriveChanges(db,binding,first,{fileIds:new Set(),folderIds:new Set(["folder-1"]),driveIds:new Set()},
    {kind:"user"},{pages:1,events:10,bytes:10000,timeoutMs:1000}),/incomplete_batch/);
  assert.deepEqual(db.connections.membership(channel.connectionId,channel.resource),["moving"]);
  const second={list:async()=>({changes:[{fileId:"moving",changeType:"file",time:"2026-09-07T00:00:01Z",file:{id:"moving",parents:["outside"]}}],newStartPageToken:"next"})};
  await assert.rejects(drainDriveChanges(db,binding,second,{fileIds:new Set(),folderIds:new Set(["folder-1"]),driveIds:new Set()}),/operation_pending/);
  assert.equal(db.connections.cursor(channel.connectionId,channel.resource).checkpoint,"page-2");
  assert.deepEqual(db.connections.membership(channel.connectionId,channel.resource),["moving"]);
});

test("静的prior membershipのfolder外snapshotをreconciliationへ隔離する", async (t) => {
  const db=fixture(t); const client={list:async()=>({changes:[
    {fileId:"leaving",changeType:"file",time:"2026-09-07T00:00:00Z",file:{id:"leaving",parents:["outside"]}},
    {fileId:"leaving",changeType:"file",time:"2026-09-07T00:00:01Z",file:{id:"leaving",parents:["outside"],name:"private"}},
  ],newStartPageToken:"next"})};
  await assert.rejects(drainDriveChanges(db,binding,client,{fileIds:new Set(),folderIds:new Set(["folder-1"]),driveIds:new Set(),priorFileIds:new Set(["leaving"])}),/operation_pending/);
  assert.equal(db.list().length,0);
});

test("changes省略の正常な空pageでもnewStartPageTokenをcommitする", async (t) => {
  const db=fixture(t); await drainDriveChanges(db,binding,{list:async()=>({kind:"drive#changeList",newStartPageToken:"empty-next"})},
    {fileIds:new Set(),folderIds:new Set(),driveIds:new Set()});
  assert.equal(db.list().length,0); assert.equal(db.connections.cursor(channel.connectionId,channel.resource).checkpoint,"empty-next");
});

test("shared drive routing IDと全drive allowlistを分離して個別fileだけ許可する", async (t) => {
  const db=fixture(t); const client={list:async()=>({changes:[
    {fileId:"allowed",driveId:"drive-1",changeType:"file",time:"2026-09-07T00:00:00Z",file:{id:"allowed"}},
    {fileId:"denied",driveId:"drive-1",changeType:"file",time:"2026-09-07T00:00:01Z",file:{id:"denied"}},
  ],newStartPageToken:"next"})};
  await drainDriveChanges(db,binding,client,{fileIds:new Set(["allowed"]),folderIds:new Set(),driveIds:new Set()}, {kind:"drive",driveId:"drive-1"});
  assert.equal(db.list().length,1);
});

test("user feedの既存memberがshared driveへ移動したchangeをtombstone化する",async(t)=>{
  const db=fixture(t); const client={list:async()=>({changes:[{fileId:"moving",driveId:"drive-2",changeType:"file",time:"2026-09-07T00:00:00Z",file:{id:"moving"}}],newStartPageToken:"next"})};
  await drainDriveChanges(db,binding,client,{fileIds:new Set(),folderIds:new Set(),driveIds:new Set(),priorFileIds:new Set(["moving"])});
  assert.deepEqual(JSON.parse(db.list()[0]!.payload_json),{removed:true,drive_id:null,file:null});
});

test("明示file allowlistでもuser feedからshared driveへの離脱を優先してtombstone化する",async(t)=>{
  const db=fixture(t); const client={list:async()=>({changes:[{fileId:"moving",driveId:"drive-2",changeType:"file",time:"2026-09-07T00:00:00Z",file:{id:"moving"}}],newStartPageToken:"next"})};
  await drainDriveChanges(db,binding,client,{fileIds:new Set(["moving"]),folderIds:new Set(),driveIds:new Set(),priorFileIds:new Set(["moving"])});
  assert.deepEqual(JSON.parse(db.list()[0]!.payload_json),{removed:true,drive_id:null,file:null});
  assert.deepEqual(db.connections.membership(channel.connectionId,channel.resource),[]);
});

test("prior membershipなしの明示file離脱をtombstone化しTrash snapshotはreconciliationへ隔離する",async(t)=>{
  const db=fixture(t); const allowlist={fileIds:new Set(["moving","trashed"]),folderIds:new Set<string>(),driveIds:new Set<string>()};
  await drainDriveChanges(db,binding,{list:async()=>({changes:[
    {fileId:"moving",driveId:"drive-2",changeType:"file",time:"2026-09-07T00:00:00Z",file:{id:"moving"}}],newStartPageToken:"next-1"})},allowlist);
  assert.deepEqual(JSON.parse(db.list()[0]!.payload_json),{removed:true,drive_id:null,file:null});
  await assert.rejects(drainDriveChanges(db,binding,{list:async()=>({changes:[
    {fileId:"trashed",changeType:"file",time:"2026-09-07T00:00:01Z",file:{id:"trashed",trashed:true}}],newStartPageToken:"next-2"})},allowlist),/operation_pending/);
  assert.equal(db.connections.cursor(channel.connectionId,channel.resource).checkpoint,"next-1");
});

test("pages上限を事前検証しallowlisted drive removalはreconciliationへ隔離する",async(t)=>{
  const db=fixture(t);let calls=0;const client={list:async()=>{calls++;return {changes:[],newStartPageToken:"next"};}};
  await assert.rejects(drainDriveChanges(db,binding,client,{fileIds:new Set(),folderIds:new Set(),driveIds:new Set()}, {kind:"user"},{pages:1.5,events:1,bytes:1,timeoutMs:1}),/invalid_input/);
  assert.equal(calls,0);
  await assert.rejects(drainDriveChanges(db,binding,{list:async()=>({changes:[{changeType:"drive",driveId:"drive-1",removed:true}],newStartPageToken:"next"})},
    {fileIds:new Set(),folderIds:new Set(),driveIds:new Set(["drive-1"])},{kind:"drive",driveId:"drive-1"}),/operation_pending/);
  assert.equal(db.connections.cursor(channel.connectionId,channel.resource).checkpoint,"start-token");
});

test("個別fileだけを許可したshared driveでもdrive削除をreconciliationへ隔離する",async(t)=>{
  const db=fixture(t);
  await assert.rejects(drainDriveChanges(db,binding,{list:async()=>({changes:[{changeType:"drive",driveId:"drive-1",removed:true}],newStartPageToken:"next"})},
    {fileIds:new Set(["allowed"]),folderIds:new Set(),driveIds:new Set()},{kind:"drive",driveId:"drive-1"}),/operation_pending/);
  assert.equal(db.connections.cursor(channel.connectionId,channel.resource).checkpoint,"start-token");
});

test("全shared drive許可ではfolder離脱用membershipを蓄積しない",async(t)=>{
  const db=fixture(t); await drainDriveChanges(db,binding,{list:async()=>({changes:[
    {fileId:"one",driveId:"drive-1",changeType:"file",time:"2026-09-07T00:00:00Z",file:{id:"one"}},
    {fileId:"two",driveId:"drive-1",changeType:"file",time:"2026-09-07T00:00:01Z",file:{id:"two"}},
  ],newStartPageToken:"next"})},{fileIds:new Set(),folderIds:new Set(),driveIds:new Set(["drive-1"])},{kind:"drive",driveId:"drive-1"});
  assert.equal(db.list().length,2);
  assert.deepEqual(db.connections.membership(channel.connectionId,channel.resource),[]);
});

test("drain全体の循環page tokenをcommit前に拒否する",async(t)=>{
  const db=fixture(t); const client={list:async({pageToken}:{pageToken:string})=>
    pageToken==="start-token"?{changes:[],nextPageToken:"page-2"}:{changes:[],nextPageToken:"start-token"}};
  await assert.rejects(drainDriveChanges(db,binding,client,{fileIds:new Set(),folderIds:new Set(),driveIds:new Set()}),/incomplete_batch/);
  assert.equal(db.connections.cursor(channel.connectionId,channel.resource).checkpoint,"page-2");
  await assert.rejects(drainDriveChanges(db,binding,client,{fileIds:new Set(),folderIds:new Set(),driveIds:new Set()}),/incomplete_batch/);
  assert.equal(db.connections.cursor(channel.connectionId,channel.resource).checkpoint,"page-2");
});

test("allowlisted folder自身の削除はcursor commit前にreconciliationへ隔離する",async(t)=>{
  const db=fixture(t);
  await assert.rejects(drainDriveChanges(db,binding,{list:async()=>({changes:[
    {fileId:"folder-1",removed:true,changeType:"file",time:"2026-09-07T00:00:00Z"}],newStartPageToken:"next"})},
    {fileIds:new Set(),folderIds:new Set(["folder-1"]),driveIds:new Set()}),/operation_pending/);
  assert.equal(db.connections.cursor(channel.connectionId,channel.resource).checkpoint,"start-token");
});

test("allowlisted folder自身のshared drive移動もreconciliationへ隔離する",async(t)=>{
  const db=fixture(t);
  await assert.rejects(drainDriveChanges(db,binding,{list:async()=>({changes:[
    {fileId:"folder-1",driveId:"drive-2",changeType:"file",time:"2026-09-07T00:00:00Z",file:{id:"folder-1"}}],newStartPageToken:"next"})},
    {fileIds:new Set(),folderIds:new Set(["folder-1"]),driveIds:new Set()}),/operation_pending/);
  assert.equal(db.connections.cursor(channel.connectionId,channel.resource).checkpoint,"start-token");
});

test("変更のない空pageでは現在tokenと同じnewStartPageTokenを許容する",async(t)=>{
  const db=fixture(t);
  await drainDriveChanges(db,binding,{list:async()=>({changes:[],newStartPageToken:"start-token"})},
    {fileIds:new Set(),folderIds:new Set(),driveIds:new Set()});
  assert.equal(db.connections.cursor(channel.connectionId,channel.resource).checkpoint,"start-token");
});

test("folder/drive経路で初観測したTrash fileもreconciliationへ隔離する",async(t)=>{
  for(const [allowlist,feed,change] of [
    [{fileIds:new Set<string>(),folderIds:new Set(["folder-1"]),driveIds:new Set<string>()},{kind:"user"} as const,
      {fileId:"trashed-folder",changeType:"file",time:"2026-09-07T00:00:00Z",file:{id:"trashed-folder",parents:["folder-1"],trashed:true}}],
    [{fileIds:new Set<string>(),folderIds:new Set<string>(),driveIds:new Set(["drive-1"])},{kind:"drive",driveId:"drive-1"} as const,
      {fileId:"trashed-drive",driveId:"drive-1",changeType:"file",time:"2026-09-07T00:00:00Z",file:{id:"trashed-drive",trashed:true}}],
  ] as const){
    const db=fixture(t);
    await assert.rejects(drainDriveChanges(db,binding,{list:async()=>({changes:[change],newStartPageToken:"next"})},allowlist,feed),/operation_pending/);
    assert.equal(db.connections.cursor(channel.connectionId,channel.resource).checkpoint,"start-token");
  }
});

test("newStartPageTokenが既訪問tokenへ戻るresponseをcommitしない",async(t)=>{
  const db=fixture(t); let page=0;
  await assert.rejects(drainDriveChanges(db,binding,{list:async()=>++page===1?{changes:[],nextPageToken:"page-2"}:
    {changes:[],newStartPageToken:"start-token"}},{fileIds:new Set(),folderIds:new Set(),driveIds:new Set()}),/incomplete_batch/);
  assert.equal(db.connections.cursor(channel.connectionId,channel.resource).checkpoint,"page-2");
});

function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dona-drive-"));
  const db = new DispatcherDatabase(path.join(dir, "db.sqlite"), clock);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  db.connections.register({ id: channel.connectionId, provider: "google-drive", account: channel.account,
    allowlist: [{ resource: channel.resource, events: ["changed"] }], credentialRef: "cred_drive", credentialRevision: 1,
    capability: { kind: "managed", cursor: true, renewal: "replace", windowMs: 86_400_000 } });
  const operation = db.connections.claim(channel.connectionId, 1, channel.resource, 1000);
  db.connections.observe(channel.connectionId, 1, channel.resource, 1,
    { providerId: channel.channelId, expiresAt: now + 7 * 86_400_000, verified: true, cutoverConfirmed: false }, operation);
  initializeDriveCursor(db, binding, "start-token");
  assert.throws(() => initializeDriveCursor(db, binding, "replacement-token"), /cursor_conflict/);
  return db;
}

test("multi-pageを全取得してallowlist後にだけnormalizeし、最終tokenをcommitする", async (t) => {
  const db = fixture(t); const calls: unknown[] = [];
  const client = { list: async (input: unknown) => { calls.push(input); return calls.length === 1 ? {
    changes: [
      { fileId: "file-1", changeType: "file", time: "2026-09-07T00:00:00Z", file: { id: "file-1", parents: ["folder-1"] } },
      { fileId: "denied", changeType: "file", time: "2026-09-07T00:00:01Z", file: { id: "denied", parents: ["other"] } },
    ], nextPageToken: "page-2",
  } : { changes: [{ fileId: "gone", removed: true, changeType: "file", time: "2026-09-07T00:00:02Z" }], newStartPageToken: "next-start" }; } };
  await drainDriveChanges(db, binding, client, { fileIds: new Set(["gone"]), folderIds: new Set(["folder-1"]), driveIds: new Set() });
  assert.equal(calls.length, 2);
  assert.equal((calls[0] as {pageToken:string}).pageToken, "start-token");
  assert.equal((calls[1] as {pageToken:string}).pageToken, "page-2");
  assert.match((calls[0] as {fields:string}).fields, /newStartPageToken/);
  assert.equal(db.list().length, 2);
  assert.equal(db.connections.cursor(channel.connectionId, channel.resource).checkpoint, "next-start");
  assert.equal(JSON.parse(db.list()[1]!.payload_json).removed, true);
});

test("page 2失敗ではdurable continuationから再開して一意に収束する", async (t) => {
  const db = fixture(t); let fail = true;
  const first = { changes: [{ fileId: "file-1", changeType: "file", time: "2026-09-07T00:00:00Z", file: { id: "file-1" } }], nextPageToken: "page-2" };
  const client = { list: async ({pageToken}: {pageToken:string}) => {
    if (pageToken === "start-token") return first;
    if (fail) throw new Error("500");
    return { changes: [], newStartPageToken: "next-start" };
  } };
  const allowlist = { fileIds: new Set(["file-1"]), folderIds: new Set<string>(), driveIds: new Set<string>() };
  await assert.rejects(drainDriveChanges(db, binding, client, allowlist), /incomplete_batch/);
  assert.equal(db.list().length, 1); assert.equal(db.connections.cursor(channel.connectionId, channel.resource).checkpoint, "page-2");
  fail = false; await drainDriveChanges(db, binding, client, allowlist);
  assert.equal(db.list().length, 1); assert.equal(db.connections.cursor(channel.connectionId, channel.resource).checkpoint, "next-start");
});

test("shared drive allowlistと同時poll cursor競合をfail closedにする", async (t) => {
  const db = fixture(t);
  const calls: unknown[] = []; const client = { list: async (input: unknown) => { calls.push(input); return { kind: "drive#changeList", changes: [{ changeType: "drive", driveId: "drive-1" }, { fileId: "shared-file", driveId: "drive-1", changeType: "file", time: "2026-09-07T00:00:00Z", file: { id: "shared-file", extra: true } }], newStartPageToken: "next" }; } };
  const allowlist = { fileIds: new Set<string>(), folderIds: new Set<string>(), driveIds: new Set(["drive-1"]) };
  const results = await Promise.allSettled([drainDriveChanges(db, binding, client, allowlist, {kind:"drive",driveId:"drive-1"}), drainDriveChanges(db, binding, client, allowlist, {kind:"drive",driveId:"drive-1"})]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(db.list().length, 1);
  assert.ok(calls.every((call) => (call as {driveId?:string}).driveId === "drive-1"));
});

test("以前のfolder memberのremoved changeはtombstoneとして配送する", async (t) => {
  const db = fixture(t); const client = { list: async () => ({ changes: [
    { fileId: "lost", removed: true, changeType: "file", time: "2026-09-07T00:00:01Z" },
  ], newStartPageToken: "next" }) };
  await drainDriveChanges(db, binding, client, { fileIds:new Set(),folderIds:new Set(["folder-1"]),driveIds:new Set(),priorFileIds:new Set(["lost"]) });
  assert.equal(db.list().length, 1);
  for (const row of db.list()) assert.deepEqual(JSON.parse(row.payload_json), { removed:true,drive_id:null,file:null });
});

test("quota系403はretryable、可変snapshotはdedupし明示fileのfeed離脱はtombstone化する", async (t) => {
  const db = fixture(t); let round = 0;
  const retry = { list: async () => { throw { status:403, errors:[{reason:"dailyLimitExceeded"}] }; } };
  await assert.rejects(drainDriveChanges(db,binding,retry,{fileIds:new Set(),folderIds:new Set(),driveIds:new Set()}),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "incomplete_batch");
  const client = { list: async () => { round++; return { changes: [
    { fileId:"same",changeType:"file",time:"2026-09-07T00:00:00Z",file:{id:"same",name:`snapshot-${round}`},unknown:round },
    ...(round === 2 ? [{ fileId:"shared",driveId:"drive-1",changeType:"file",time:"2026-09-07T00:00:01Z",file:{id:"shared"} }] : []),
  ],...(round === 1 ? {nextPageToken:"page-2"} : {newStartPageToken:"next"}) }; } };
  const allowlist={fileIds:new Set(["same","shared"]),folderIds:new Set<string>(),driveIds:new Set(["drive-1"])};
  await drainDriveChanges(db,binding,client,allowlist);
  assert.equal(db.list().length,2);
  assert.deepEqual(JSON.parse(db.list()[1]!.payload_json),{removed:true,drive_id:null,file:null});
});

test("API pageSizeを残りevent budget以下に固定する",async(t)=>{
  const db=fixture(t); const calls:unknown[]=[];
  await drainDriveChanges(db,binding,{list:async(input)=>{calls.push(input);return {changes:[],newStartPageToken:"next"};}},
    {fileIds:new Set(),folderIds:new Set(),driveIds:new Set()},{kind:"user"},{pages:2,events:50,bytes:10000,timeoutMs:1000});
  assert.equal((calls[0] as {pageSize:number}).pageSize,50);
});

test("複数pageでevent/byte/time上限を共有しdurable continuationで停止する", async (t) => {
  const db=fixture(t); let page=0;
  const client={list:async()=>({changes:[{fileId:`file-${++page}`,changeType:"file",time:`2026-09-07T00:00:0${page}Z`,file:{id:`file-${page}`}}],nextPageToken:`page-${page+1}`})};
  await assert.rejects(drainDriveChanges(db,binding,client,{fileIds:new Set(["file-1","file-2"]),folderIds:new Set(),driveIds:new Set()},
    {kind:"user"},{pages:10,events:1,bytes:10000,timeoutMs:1000}),/incomplete_batch/);
  assert.equal(page,1); assert.equal(db.list().length,1);
  assert.equal(db.connections.cursor(channel.connectionId,channel.resource).checkpoint,"page-2");
});

test("credential失効とcursor期限切れをretryable page失敗から分離する", async (t) => {
  for (const [status, code,reason] of [[401,"credential_unavailable",undefined],[403,"credential_unavailable","insufficientPermissions"],[410,"cursor_conflict",undefined],[429,"incomplete_batch",undefined]] as const) {
    const db = fixture(t); const client = { list: async () => { throw { status,errors:reason?[{reason}]:[] }; } };
    await assert.rejects(drainDriveChanges(db,binding,client,{fileIds:new Set(),folderIds:new Set(),driveIds:new Set()}),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === code);
  }
  const db=fixture(t); const circular:{status:number;response?:unknown}={status:410}; circular.response={data:{error:{errors:[{reason:"pageTokenExpired"}]}},request:circular};
  await assert.rejects(drainDriveChanges(db,binding,{list:async()=>{throw circular;}},{fileIds:new Set(),folderIds:new Set(),driveIds:new Set()}),
    (error:unknown)=>typeof error==="object"&&error!==null&&"code" in error&&error.code==="cursor_conflict");
  for (const [status, code,reason] of [[401,"credential_unavailable",undefined],[403,"credential_unavailable","insufficientPermissions"],[410,"cursor_conflict",undefined]] as const) {
    const responseDb=fixture(t); const client={list:async()=>{throw {response:{status,data:{error:{errors:reason?[{reason}]:[]}}}};}};
    await assert.rejects(drainDriveChanges(responseDb,binding,client,{fileIds:new Set(),folderIds:new Set(),driveIds:new Set()}),
      (error:unknown)=>typeof error==="object"&&error!==null&&"code" in error&&error.code===code);
  }
  const revoked=fixture(t);
  await assert.rejects(drainDriveChanges(revoked,binding,{list:async()=>{throw {response:{status:400,data:{error:"invalid_grant"}}};}},
    {fileIds:new Set(),folderIds:new Set(),driveIds:new Set()}),
    (error:unknown)=>typeof error==="object"&&error!==null&&"code" in error&&error.code==="credential_unavailable");
});
