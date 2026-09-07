import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import Database from "better-sqlite3";
import { DispatcherDatabase } from "../src/database.js";
import { PrivateFileSecretStore } from "../src/connections/secret-store.js";
import { ProviderRegistrationService } from "../src/connections/registration-service.js";
import { migrateConnections } from "../src/connections/schema.js";
import type { Clock, ConnectionConfig } from "../src/connections/domain.js";

class FakeClock implements Clock { value = 1_800_000_000_000; now() { return this.value; } }
const config: ConnectionConfig = { id: "pilot", provider: "notion", account: "workspace:one",
  credentialRef: "cred_pilot", credentialRevision: 1, allowlist: [{ resource: "page:one", events: ["updated"] }],
  capability: { kind: "manual", cursor: false } };

function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dona-registration-"));
  const secrets = path.join(dir, "secrets"); fs.mkdirSync(secrets, { mode: 0o700 });
  const file = path.join(dir, "dispatcher.sqlite"), clock = new FakeClock();
  const db = new DispatcherDatabase(file, clock), store = new PrivateFileSecretStore(secrets);
  t.after(() => { try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, secrets, file, clock, db, store };
}

function activate(db: DispatcherDatabase): ReturnType<DispatcherDatabase["providerRegistration"]["resolve"]> {
  db.connections.attachManual("pilot", 1, "page:one", "subscription:one", null);
  db.connections.observe("pilot", 1, "page:one", 1,
    { providerId: "subscription:one", expiresAt: null, verified: true, cutoverConfirmed: false });
  return db.providerRegistration.resolve({ provider: "notion", providerId: "subscription:one",
    connectionId: "pilot", account: "workspace:one", resource: "page:one" });
}

test("secret-storeはowner-only atomic fileだけを公開しsymlink/hard-link/path traversalを拒否する", async (t) => {
  const { secrets, store } = fixture(t);
  await store.write("cred_safe", 1, Buffer.from("0123456789abcdef0123456789abcdef"));
  const target = path.join(secrets, "cred_safe.1.secret");
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal((await store.read("cred_safe", 1)).toString(), "0123456789abcdef0123456789abcdef");
  assert.deepEqual(fs.readdirSync(secrets), ["cred_safe.1.secret"]);
  assert.rejects(store.write("../escape", 1, Buffer.alloc(32)), /invalid_input/);
  fs.symlinkSync(target, path.join(secrets, "cred_link.1.secret"));
  await assert.rejects(store.write("cred_link", 1, Buffer.alloc(32)), /not_authorized/);
  fs.linkSync(target, path.join(secrets, "cred_hard.1.secret"));
  await assert.rejects(store.write("cred_hard", 1, Buffer.alloc(32)), /not_authorized/);
  await assert.rejects(store.read("cred_safe", 1), /not_authorized/);
});

test("registration競合は既存secretを保ち、rotation失敗は旧revisionをactiveに保つ", async (t) => {
  const { db, store, secrets } = fixture(t); const service = new ProviderRegistrationService(db.connections, store);
  await service.register(config, Buffer.alloc(32, 1));
  assert.equal(db.connections.get("pilot").credentialRevision, 1);
  await assert.rejects(service.rotate("pilot", 99, { ...config, credentialRevision: 2 }, Buffer.alloc(32, 2)), /revision_conflict/);
  assert.equal(db.connections.get("pilot").credentialRevision, 1);
  assert.deepEqual(fs.readdirSync(secrets), ["cred_pilot.1.secret", "cred_pilot.2.secret"]);
  assert.equal((await service.register({ ...config, id: "pilot" }, Buffer.alloc(32, 1))).revision, 1);
  await assert.rejects(service.register({ ...config, allowlist: [{ resource: "page:one", events: ["deleted"] }] }, Buffer.alloc(32, 1)), /revision_conflict/);
  assert.equal((await store.read("cred_pilot", 1)).length, 32);
  assert.deepEqual(fs.readdirSync(secrets), ["cred_pilot.1.secret", "cred_pilot.2.secret"]);
});

test("durability未確認ではDB commitせず、次の明示reconcileでdirectory fsync後に継続する", async (t) => {
  const { db, store } = fixture(t); let writes = 0;
  const ambiguous = Object.create(store) as PrivateFileSecretStore;
  ambiguous.write = async (reference, revision, secret) => {
    writes++; await store.write(reference, revision, secret); throw new Error("durability_unconfirmed");
  };
  const service = new ProviderRegistrationService(db.connections, ambiguous);
  await assert.rejects(service.register(config, Buffer.alloc(32, 7)), /durability_unconfirmed/);
  assert.throws(() => db.connections.get("pilot"), /not_found/);
  const resumed = new ProviderRegistrationService(db.connections, store);
  assert.equal((await resumed.register(config, Buffer.alloc(32, 7))).revision, 1);
  assert.equal(writes, 1);
});

test("invalid secret lengthは既存fileとの一致でも成功へ昇格しない", async (t) => {
  const { db, secrets, store } = fixture(t);
  fs.writeFileSync(path.join(secrets, "cred_pilot.1.secret"), Buffer.alloc(8, 1), { mode: 0o600 });
  const service = new ProviderRegistrationService(db.connections, store);
  await assert.rejects(service.register(config, Buffer.alloc(8, 1)), /invalid_input/);
  assert.throws(() => db.connections.get("pilot"), /not_found/);
});

test("同一revisionの並行publishは既存targetを置換しない", async (t) => {
  const { store } = fixture(t), first = Buffer.alloc(32, 1), second = Buffer.alloc(32, 2);
  const results = await Promise.allSettled([store.write("cred_race", 1, first), store.write("cred_race", 1, second)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const stored = await store.read("cred_race", 1);
  assert.ok(stored.equals(first) || stored.equals(second));
});

test("link後crashで残った同一inodeのtemporary fileをreconcileが回収する", async (t) => {
  const { secrets, store } = fixture(t), secret = Buffer.alloc(32, 4);
  await store.write("cred_crash", 1, secret);
  const target = path.join(secrets, "cred_crash.1.secret");
  const temporary = path.join(secrets, ".cred_crash.1.0123456789abcdef01234567.tmp");
  fs.linkSync(target, temporary);
  assert.equal(fs.statSync(target).nlink, 2);
  assert.equal(await store.reconcile("cred_crash", 1, secret), true);
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(fs.statSync(target).nlink, 1);
});

test("resolverはcurrent active bindingだけを返しcross-workspace/provider/revision tamperを拒否する", async (t) => {
  const { db } = fixture(t); db.connections.register(config); const binding = activate(db);
  assert.deepEqual(binding, { connectionId: "pilot", provider: "notion", account: "workspace:one", revision: 1,
    credentialRevision: 1, resource: "page:one", generation: 1, providerId: "subscription:one" });
  for (const input of [
    { provider: "figma", providerId: "subscription:one", connectionId: "pilot" },
    { provider: "notion", providerId: "subscription:one", connectionId: "pilot", account: "workspace:two" },
    { provider: "notion", providerId: "subscription:one", connectionId: "pilot", resource: "page:two" },
  ]) assert.throws(() => db.providerRegistration.resolve(input), /not_authorized/);
  db.connections.revise("pilot", 1, { ...config, credentialRevision: 2 });
  assert.throws(() => db.providerRegistration.resolve({ provider: "notion", providerId: "subscription:one", connectionId: "pilot" }), /not_authorized/);
});

test("connectionId省略resolverも永続clockの後退を拒否する", (t) => {
  const { db, clock } = fixture(t); db.connections.register(config); activate(db); clock.value--;
  assert.throws(() => db.providerRegistration.resolve({ provider: "notion", providerId: "subscription:one" }), /clock_skew/);
});

test("verification attemptはdigestのみ永続化しexpiry/replay/restart/tamperを拒否する", (t) => {
  const { db, file, clock } = fixture(t); db.connections.register(config); const binding = activate(db);
  const attemptIdentity = { provider: binding.provider, providerId: binding.providerId, connectionId: binding.connectionId,
    account: binding.account, resource: binding.resource };
  const token = db.providerRegistration.issue(attemptIdentity, 5_000);
  const raw = new Database(file); t.after(() => raw.close());
  assert.deepEqual(raw.prepare("SELECT count(*) n FROM verification_attempts WHERE digest=?").get(token), { n: 0 });
  assert.doesNotMatch(JSON.stringify(raw.prepare("SELECT * FROM verification_attempts").all()), new RegExp(token));
  assert.throws(() => db.providerRegistration.claim(token, { ...binding, account: "workspace:two" }, 1_000), /not_authorized/);
  const claim = db.providerRegistration.claim(token, binding, 1_000);
  assert.throws(() => db.providerRegistration.claim(token, binding, 1_000), /operation_pending/);
  const reopened = new DispatcherDatabase(file, clock); t.after(() => reopened.close());
  assert.deepEqual(reopened.providerRegistration.consume(token, claim.claimId), binding);
  assert.throws(() => db.providerRegistration.consume(token, claim.claimId), /not_authorized/);
  const expired = reopened.providerRegistration.issue(attemptIdentity, 1_000); clock.value += 1_000;
  assert.throws(() => reopened.providerRegistration.claim(expired, binding, 100), /not_authorized/);
});

test("verification pending bindingでもattemptを発行・consumeでき、active resolverはfail closedにする", (t) => {
  const { db } = fixture(t); db.connections.register(config);
  db.connections.attachManual("pilot", 1, "page:one", "subscription:one", null);
  const identity = { provider: "notion", providerId: "subscription:one", connectionId: "pilot",
    account: "workspace:one", resource: "page:one" };
  assert.throws(() => db.providerRegistration.resolve(identity), /not_authorized/);
  const token = db.providerRegistration.issue(identity, 5_000);
  const expected = { ...identity, revision: 1, credentialRevision: 1, generation: 1 };
  const claim = db.providerRegistration.claim(token, expected, 1_000);
  assert.deepEqual(db.providerRegistration.consume(token, claim.claimId), expected);
});

test("停止済みbindingへのattempt発行とclaimを拒否する", (t) => {
  const { db, file } = fixture(t); db.connections.register(config); const binding = activate(db);
  const identity = { provider: binding.provider, providerId: binding.providerId, connectionId: binding.connectionId,
    account: binding.account, resource: binding.resource };
  const token = db.providerRegistration.issue(identity, 5_000);
  const raw = new Database(file); t.after(() => raw.close());
  raw.prepare("UPDATE connection_subscriptions SET state='stopped' WHERE connection_id=?").run("pilot");
  assert.throws(() => db.providerRegistration.issue(identity, 5_000), /not_authorized/);
  assert.throws(() => db.providerRegistration.claim(token, binding, 1_000), /not_authorized/);
});

test("claim後のrevision変更はconsumeをfail closedにする", (t) => {
  const { db } = fixture(t); db.connections.register(config); const binding = activate(db);
  const identity = { provider: binding.provider, providerId: binding.providerId, connectionId: binding.connectionId,
    account: binding.account, resource: binding.resource };
  const token = db.providerRegistration.issue(identity, 5_000), claim = db.providerRegistration.claim(token, binding, 1_000);
  db.connections.revise("pilot", 1, { ...config, credentialRevision: 2 });
  assert.throws(() => db.providerRegistration.consume(token, claim.claimId), /not_authorized/);
});

test("clock rewind時はverification attemptをfail closedにする", (t) => {
  const { db, clock } = fixture(t); db.connections.register(config); const binding = activate(db);
  const identity = { provider: binding.provider, providerId: binding.providerId, connectionId: binding.connectionId,
    account: binding.account, resource: binding.resource };
  const token2 = db.providerRegistration.issue(identity, 5_000);
  clock.value--;
  assert.throws(() => db.providerRegistration.claim(token2, binding, 1_000), /clock_skew/);
});

test("transactionは単一clock値をbinding検査・期限判定・保存に使う", (t) => {
  const { file, db, clock } = fixture(t); db.connections.register(config); const binding = activate(db);
  const identity = { provider: binding.provider, providerId: binding.providerId, connectionId: binding.connectionId,
    account: binding.account, resource: binding.resource };
  const original = clock.value; let calls = 0;
  clock.now = () => calls++ === 0 ? original : original - 1;
  db.providerRegistration.issue(identity, 5_000);
  const raw = new Database(file); t.after(() => raw.close());
  assert.equal((raw.prepare("SELECT last_clock FROM connections WHERE id='pilot'").get() as { last_clock: number }).last_clock, original);
  assert.equal(calls, 1);
});

test("commit済みrotationの再試行はsecret一致を照合して受理する", async (t) => {
  const { db, store } = fixture(t), service = new ProviderRegistrationService(db.connections, store);
  await service.register(config, Buffer.alloc(32, 1));
  const rotated = { ...config, credentialRevision: 2 };
  assert.equal((await service.rotate("pilot", 1, rotated, Buffer.alloc(32, 2))).revision, 2);
  assert.equal((await service.rotate("pilot", 1, rotated, Buffer.alloc(32, 2))).revision, 2);
  await assert.rejects(service.rotate("pilot", 1, rotated, Buffer.alloc(32, 3)), /revision_conflict/);
});

test("attempt発行時のretentionは期限切れrowをboundedに削除する", (t) => {
  const { db, file, clock } = fixture(t); db.connections.register(config); const binding = activate(db);
  const identity = { provider: binding.provider, providerId: binding.providerId, connectionId: binding.connectionId,
    account: binding.account, resource: binding.resource };
  const raw = new Database(file); t.after(() => raw.close());
  const insert = raw.prepare(`INSERT INTO verification_attempts(digest,connection_id,provider,account,revision,credential_revision,
    resource,generation,provider_id,expires_at,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?)`);
  for (let index = 0; index < 101; index++) insert.run(index.toString(16).padStart(64, "0"), "pilot", "notion", "workspace:one", 1, 1,
    "page:one", 1, "subscription:one", clock.value - 1, clock.value - 2);
  db.providerRegistration.issue(identity, 5_000);
  assert.equal((raw.prepare("SELECT count(*) n FROM verification_attempts").get() as { n: number }).n, 2);
});

async function raceClaims(file: string, now: number, token: string, binding: unknown): Promise<Array<{ ok: boolean; code?: string }>> {
  const module = pathToFileURL(path.resolve("src/database.ts")).href;
  const script = `import {DispatcherDatabase} from ${JSON.stringify(module)};
    const db=new DispatcherDatabase(process.argv[1],{now:()=>Number(process.argv[2])});
    process.send('ready');process.on('message',()=>{try{db.providerRegistration.claim(process.argv[3],JSON.parse(process.argv[4]),1000);process.send({ok:true});}
    catch(e){process.send({ok:false,code:e.code??e.message});}finally{db.close();process.disconnect();}});`;
  const children = [0, 1].map(() => spawn("/usr/bin/env", ["node", "--import", "tsx", "--eval", script, file, String(now), token, JSON.stringify(binding)],
    { cwd: process.cwd(), stdio: ["ignore", "ignore", "ignore", "ipc"] }));
  return Promise.all(children.map((child) => new Promise((resolve, reject) => {
    child.once("error", reject); child.once("message", () => { child.once("message", resolve as (message: unknown) => void); child.send("go"); });
  }))) as Promise<Array<{ ok: boolean; code?: string }>>;
}

test("別processの同時claimは1件だけ成功する", async (t) => {
  const { db, file, clock } = fixture(t); db.connections.register(config); const binding = activate(db);
  const token = db.providerRegistration.issue({ provider: binding.provider, providerId: binding.providerId,
    connectionId: binding.connectionId, account: binding.account, resource: binding.resource }, 5_000);
  const results = await raceClaims(file, clock.value, token, binding);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.code === "operation_pending").length, 1);
});

test("connection schemaへrollback-compatibleなadditive migrationを行い既存rowとuser_versionを維持する", (t) => {
  const { file, db } = fixture(t); db.connections.register(config); db.close();
  const raw = new Database(file); t.after(() => raw.close());
  raw.exec("DROP TABLE verification_attempts; UPDATE connection_schema SET version=1");
  const userVersion = raw.pragma("user_version", { simple: true });
  const before = raw.prepare("SELECT * FROM connections").all();
  migrateConnections(raw);
  assert.equal((raw.prepare("SELECT version FROM connection_schema").get() as { version: number }).version, 1);
  assert.equal(raw.pragma("user_version", { simple: true }), userVersion);
  assert.deepEqual(raw.prepare("SELECT * FROM connections").all(), before);
  assert.equal(raw.pragma("integrity_check", { simple: true }), "ok");
  assert.deepEqual(raw.pragma("foreign_key_check"), []);
});
