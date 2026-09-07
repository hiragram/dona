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

test("以前のfolder memberは離脱・権限喪失時もtombstoneとして配送する", async (t) => {
  const db = fixture(t); const client = { list: async () => ({ changes: [
    { fileId: "moved", changeType: "file", time: "2026-09-07T00:00:00Z", file: { id: "moved", parents: ["other"] } },
    { fileId: "lost", removed: true, changeType: "file", time: "2026-09-07T00:00:01Z" },
  ], newStartPageToken: "next" }) };
  await drainDriveChanges(db, binding, client, { fileIds:new Set(),folderIds:new Set(["folder-1"]),driveIds:new Set(),priorFileIds:new Set(["moved","lost"]) });
  assert.equal(db.list().length, 2);
});

test("credential失効とcursor期限切れをretryable page失敗から分離する", async (t) => {
  for (const [status, code] of [[401,"credential_unavailable"],[403,"credential_unavailable"],[410,"cursor_conflict"],[429,"incomplete_batch"]] as const) {
    const db = fixture(t); const client = { list: async () => { throw { status }; } };
    await assert.rejects(drainDriveChanges(db,binding,client,{fileIds:new Set(),folderIds:new Set(),driveIds:new Set()}),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === code);
  }
});
