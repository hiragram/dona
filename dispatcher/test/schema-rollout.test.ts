import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { markDatabasePayloadHistory, verifyDatabasePayloadHistory } from "../src/payload-backup-boundary.js";
import { installWebAuthSchema, verifyWebAuthSchema } from "../src/web/schema.js";

import {
  assertReceiptMatchesDatabases,
  assertSchemaActivationSafe,
  migrateV2ToV3WithBackup,
  publishMigrationReceipt,
} from "../src/schema-rollout.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

const bridge = { app_schema_read_min: 2, app_schema_read_max: 3, app_schema_write: 2, rollback_safe: true };
const activation = { ...bridge, app_schema_write: 3 };

async function runRolloutCli(databasePath: string, backupPath: string, receiptPath: string) {
  const child = spawn(path.resolve("node_modules/.bin/tsx"), [
    fileURLToPath(new URL("../src/schema-rollout-cli.ts", import.meta.url)),
    databasePath, backupPath, receiptPath, JSON.stringify(bridge), JSON.stringify(activation),
  ]);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exit = await new Promise<number | null>((resolve) => child.once("close", resolve));
  return { exit, stdout, stderr };
}

test("unsafe schema activation combinations are rejected before a write", () => {
  assert.throws(() => assertSchemaActivationSafe({ ...bridge, app_schema_read_min: 3 }, activation, 2), /schema_v2_source/);
  assert.throws(() => assertSchemaActivationSafe(bridge, { ...activation, app_schema_write: 2 }, 2), /activation_release/);
  assert.throws(() => assertSchemaActivationSafe({ ...bridge, rollback_safe: false }, activation, 2), /safe_rollback/);
  assert.throws(() => assertSchemaActivationSafe(bridge, activation, 3), /requires_v2/);
});

test("CLI treats only absent backup and receipt files as a fresh migration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-schema-cli-fresh-"));
  roots.push(root);
  const databasePath = path.join(root, "dispatcher.sqlite3");
  const backupPath = path.join(root, "backup.sqlite3");
  const receiptPath = path.join(root, "migration-receipt.json");
  const db = new Database(databasePath);
  db.exec(await fs.readFile(new URL("fixtures/schema-v2.sql", import.meta.url), "utf8"));
  db.close();

  const fresh = await runRolloutCli(databasePath, backupPath, receiptPath);
  assert.equal(fresh.exit, 0, fresh.stderr);
  assert.equal(JSON.parse(fresh.stdout).migrated.user_version, 3);
  assert.equal((await fs.stat(backupPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(receiptPath)).mode & 0o777, 0o600);

  const completed = await runRolloutCli(databasePath, backupPath, receiptPath);
  assert.equal(completed.exit, 0, completed.stderr);
  assert.deepEqual(JSON.parse(completed.stdout), JSON.parse(fresh.stdout));

  const savedBackupPath = path.join(root, "saved-backup.sqlite3");
  await fs.rename(backupPath, savedBackupPath);
  await fs.symlink(savedBackupPath, backupPath);
  const completedWithBackupLink = await runRolloutCli(databasePath, backupPath, receiptPath);
  assert.notEqual(completedWithBackupLink.exit, 0);
  assert.match(completedWithBackupLink.stderr, /schema_rollout_backup_is_not_a_regular_file/);
  await fs.unlink(backupPath);
  await fs.rename(savedBackupPath, backupPath);

  await fs.copyFile(backupPath, databasePath);
  await fs.unlink(receiptPath);
  const backupOnly = await runRolloutCli(databasePath, backupPath, receiptPath);
  assert.equal(backupOnly.exit, 0, backupOnly.stderr);
  assert.equal(JSON.parse(backupOnly.stdout).migrated.user_version, 3);
});

test("CLI rejects symlink backup and receipt paths instead of treating them as absent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-schema-cli-link-"));
  roots.push(root);
  const databasePath = path.join(root, "dispatcher.sqlite3");
  const db = new Database(databasePath);
  db.exec(await fs.readFile(new URL("fixtures/schema-v2.sql", import.meta.url), "utf8"));
  db.close();
  const target = path.join(root, "target");
  await fs.writeFile(target, "not a database");

  const backupPath = path.join(root, "backup.sqlite3");
  await fs.symlink(target, backupPath);
  const backupLink = await runRolloutCli(databasePath, backupPath, path.join(root, "missing-receipt.json"));
  assert.notEqual(backupLink.exit, 0);
  assert.match(backupLink.stderr, /schema_rollout_backup_is_not_a_regular_file/);

  await fs.unlink(backupPath);
  const receiptPath = path.join(root, "migration-receipt.json");
  await fs.symlink(target, receiptPath);
  const receiptLink = await runRolloutCli(databasePath, backupPath, receiptPath);
  assert.notEqual(receiptLink.exit, 0);
  assert.match(receiptLink.stderr, /schema_rollout_receipt_is_not_a_regular_file/);
  await assert.rejects(fs.access(backupPath));
});

test("WAL v2 database is backed up, restored, migrated transactionally, and preserves results", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-schema-rollout-"));
  roots.push(root);
  const databasePath = path.join(root, "dispatcher.sqlite3");
  const backupPath = path.join(root, "backup.sqlite3");
  const fixture = await fs.readFile(new URL("fixtures/schema-v2.sql", import.meta.url), "utf8");
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0");
  db.exec(fixture);
  const at = "2026-09-06T00:00:00.000Z";
  db.prepare(`INSERT INTO events (
    event_id, schema_version, source, external_event_id, event_type, occurred_at,
    subject_json, payload_json, status, available_at, completed_at, result_json, created_at, updated_at
  ) VALUES (?, 1, 'slack', 'Ev-rollout', 'message', ?, '{}', '{}', 'completed', ?, ?, ?, ?, ?)`)
    .run("evt_01M1ES03XY5CF8D9PM5CWX4SRV", at, at, at, '{"status":"completed"}', at, at);
  db.prepare(`INSERT INTO jobs (
    job_id, source_event_id, source, objective, workspace_json, status, available_at,
    workspace_path, result_path, agent_name, completed_at, result_json, created_at, updated_at
  ) VALUES (?, ?, 'slack', 'read only', '{}', 'completed', ?, '/fixture/workspace',
    '/fixture/result.json', 'dona-job-fixture', ?, ?, ?, ?)`)
    .run("job_01m1es03xy5cf8d9pm5cwx4srv", "evt_01M1ES03XY5CF8D9PM5CWX4SRV", at,
      "2026-09-06T00:00:01.000Z", '{"status":"completed"}', at, at);
  db.exec("ALTER TABLE jobs ADD COLUMN job_key TEXT NOT NULL DEFAULT 'legacy-default'");
  db.prepare("UPDATE jobs SET job_key = ? WHERE job_id = ?")
    .run("research.primary", "job_01m1es03xy5cf8d9pm5cwx4srv");
  const wal = await fs.stat(`${databasePath}-wal`);
  assert.ok(wal.size > 0, "fixture must have committed pages in a live WAL");

  const receipt = await migrateV2ToV3WithBackup({
    databasePath, backupPath, previous: bridge, target: activation, quiesced: true, drained: true,
    completedAt: "2026-09-06T00:00:02.000Z",
  });
  db.close();
  assert.equal(receipt.migrated.user_version, 3);
  assert.equal((await fs.stat(backupPath)).mode & 0o777, 0o600);
  assert.equal(receipt.preservation.event_results?.before, 1);
  assert.equal(receipt.preservation.event_results?.after, 1);
  assert.equal(receipt.preservation.event_results?.before_digest, receipt.preservation.event_results?.after_digest);
  assert.equal(receipt.preservation.job_completions?.before, 1);
  assert.equal(receipt.preservation.job_completions?.after, 1);
  assert.equal(receipt.preservation.job_completions?.before_digest, receipt.preservation.job_completions?.after_digest);

  const restored = new Database(backupPath, { readonly: true });
  assert.equal(restored.pragma("user_version", { simple: true }), 2);
  assert.equal(restored.prepare("SELECT result_json FROM jobs").pluck().get(), '{"status":"completed"}');
  restored.close();
  const migrated = new Database(databasePath, { readonly: true });
  assert.equal(migrated.pragma("user_version", { simple: true }), 3);
  assert.equal(migrated.prepare("SELECT result_json FROM jobs").pluck().get(), '{"status":"completed"}');
  assert.equal(migrated.prepare("SELECT job_key FROM jobs").pluck().get(), "research.primary");
  migrated.close();

  const legacyReceiptPath = path.join(root, "legacy-false-receipt.json");
  await fs.writeFile(legacyReceiptPath, JSON.stringify({
    ...receipt,
    rollback: { ...receipt.rollback, backup_restore_opened: false },
  }));
  const legacyReceiptChild = spawn(path.resolve("node_modules/.bin/tsx"), [
    fileURLToPath(new URL("../src/schema-rollout-cli.ts", import.meta.url)),
    databasePath,
    backupPath,
    legacyReceiptPath,
    JSON.stringify(bridge),
    JSON.stringify(activation),
  ]);
  let legacyReceiptStderr = "";
  legacyReceiptChild.stderr.setEncoding("utf8");
  legacyReceiptChild.stderr.on("data", (chunk: string) => { legacyReceiptStderr += chunk; });
  const legacyReceiptExit = await new Promise<number | null>((resolve) => legacyReceiptChild.once("close", resolve));
  assert.notEqual(legacyReceiptExit, 0);
  assert.match(legacyReceiptStderr, /schema_rollout_receipt_invalid/);

  const changed = new Database(databasePath);
  changed.prepare("UPDATE jobs SET attempt_count = attempt_count + 1 WHERE job_id = ?")
    .run("job_01m1es03xy5cf8d9pm5cwx4srv");
  const contentChangedRead = new Database(databasePath, { readonly: true });
  const contentBackupRead = new Database(backupPath, { readonly: true });
  assert.doesNotThrow(() => assertReceiptMatchesDatabases(receipt, contentChangedRead, contentBackupRead));
  contentChangedRead.close();
  contentBackupRead.close();
  changed.prepare("UPDATE jobs SET attempt_count = attempt_count - 1 WHERE job_id = ?")
    .run("job_01m1es03xy5cf8d9pm5cwx4srv");
  changed.prepare(`INSERT INTO events (
    event_id, schema_version, source, external_event_id, event_type, occurred_at,
    subject_json, payload_json, status, available_at, created_at, updated_at
  ) VALUES (?, 1, 'slack', 'Ev-after-receipt', 'message', ?, '{}', '{}', 'queued', ?, ?, ?)`)
    .run("evt_01M1ES03XY5CF8D9PM5CWX4SRX", at, at, at, at);
  changed.close();
  const changedRead = new Database(databasePath, { readonly: true });
  const backupRead = new Database(backupPath, { readonly: true });
  assert.doesNotThrow(() => assertReceiptMatchesDatabases(receipt, changedRead, backupRead));
  changedRead.close();
  backupRead.close();

  const recoveryReceiptPath = path.join(root, "recovered-receipt.json");
  const child = spawn(path.resolve("node_modules/.bin/tsx"), [
    fileURLToPath(new URL("../src/schema-rollout-cli.ts", import.meta.url)),
    databasePath,
    backupPath,
    recoveryReceiptPath,
    JSON.stringify(bridge),
    JSON.stringify(activation),
  ]);
  let recoveryStderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { recoveryStderr += chunk; });
  const recoveryExit = await new Promise<number | null>((resolve) => child.once("close", resolve));
  assert.notEqual(recoveryExit, 0);
  assert.match(recoveryStderr, /schema_backup_content_mismatch/);
  await assert.rejects(fs.access(recoveryReceiptPath));
});

test("migration refuses to run before drain and never overwrites a backup", async () => {
  await assert.rejects(migrateV2ToV3WithBackup({
    databasePath: "/not/opened", backupPath: "/not/written", previous: bridge, target: activation,
    quiesced: false, drained: true,
  }), /quiesced_drained/);
});

test("v2-only source receipt requires backup restore instead of claiming direct rollback readability", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-schema-v2-source-"));
  roots.push(root);
  const databasePath = path.join(root, "dispatcher.sqlite3");
  const backupPath = path.join(root, "dispatcher.v2.sqlite3");
  const db = new Database(databasePath);
  db.exec(await fs.readFile(new URL("fixtures/schema-v2.sql", import.meta.url), "utf8"));
  db.close();
  const receipt = await migrateV2ToV3WithBackup({
    databasePath, backupPath,
    previous: { ...bridge, app_schema_read_max: 2 }, target: activation,
    quiesced: true, drained: true,
  });
  assert.equal(receipt.rollback.previous_release_can_read, false);
  assert.equal(receipt.rollback.backup_restore_opened, true);

  const receiptPath = path.join(root, "migration-receipt.json");
  await publishMigrationReceipt(receiptPath, receipt);
  await fs.copyFile(backupPath, databasePath);
  const child = spawn(path.resolve("node_modules/.bin/tsx"), [
    fileURLToPath(new URL("../src/schema-rollout-cli.ts", import.meta.url)),
    databasePath, backupPath, receiptPath,
    JSON.stringify({ ...bridge, app_schema_read_max: 2 }), JSON.stringify(activation),
  ]);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exit = await new Promise<number | null>((resolve) => child.once("close", resolve));
  assert.equal(exit, 0, stderr);
  const retried = new Database(databasePath, { readonly: true });
  assert.equal(retried.pragma("user_version", { simple: true }), 3);
  retried.close();
});

test("receipt publication is not blocked by a stale legacy temporary file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-schema-receipt-"));
  roots.push(root);
  const receiptPath = path.join(root, "migration-receipt.json");
  await fs.writeFile(`${receiptPath}.tmp`, "stale", { mode: 0o600 });
  const receipt = {
    schema_version: 1 as const,
    from_schema: 2 as const,
    to_schema: 3 as const,
    backup: { opened: true as const, integrity_check: "ok" as const, foreign_key_violations: 0 as const },
    migrated: { integrity_check: "ok" as const, foreign_key_violations: 0 as const, user_version: 3 as const },
    preservation: {},
    rollback: { target_schema: 3 as const, previous_release_can_read: true as const, backup_restore_opened: true as const },
    completed_at: "2026-09-06T00:00:00.000Z",
  };
  await publishMigrationReceipt(receiptPath, receipt);
  assert.deepEqual(JSON.parse(await fs.readFile(receiptPath, "utf8")), receipt);
  assert.equal(await fs.readFile(`${receiptPath}.tmp`, "utf8"), "stale");
});

test("a wrong source path creates no database file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-schema-missing-"));
  roots.push(root);
  const databasePath = path.join(root, "missing.sqlite3");
  await assert.rejects(migrateV2ToV3WithBackup({
    databasePath, backupPath: path.join(root, "backup.sqlite3"), previous: bridge, target: activation,
    quiesced: true, drained: true,
  }), /unable to open database file/);
  await assert.rejects(fs.access(databasePath));
});

test("a failed post-migration check rolls the source back to v2", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-schema-rollback-"));
  roots.push(root);
  const databasePath = path.join(root, "dispatcher.sqlite3");
  const db = new Database(databasePath);
  db.exec(await fs.readFile(new URL("fixtures/schema-v2.sql", import.meta.url), "utf8"));
  db.close();
  await assert.rejects(migrateV2ToV3WithBackup({
    databasePath, backupPath: path.join(root, "backup.sqlite3"), previous: bridge, target: activation,
    quiesced: true, drained: true, postMigrationHook: () => { throw new Error("injected_post_check_failure"); },
  }), /injected_post_check_failure/);
  const reopened = new Database(databasePath, { readonly: true });
  assert.equal(reopened.pragma("user_version", { simple: true }), 2);
  assert.equal(reopened.prepare("SELECT name FROM sqlite_master WHERE name='job_groups'").get(), undefined);
  reopened.close();
});

async function payloadBackupFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-payload-backup-")); roots.push(root);
  const databasePath = path.join(root,"source.sqlite"), backupPath = path.join(root,"backup.sqlite"), receiptPath = path.join(root,"receipt.json");
  const db = new Database(databasePath); db.pragma("journal_mode=WAL");
  db.exec(await fs.readFile(new URL("fixtures/schema-v2.sql", import.meta.url), "utf8"));
  db.close();
  return {databasePath,backupPath,receiptPath,previous:bridge,target:activation,quiesced:true,drained:true};
}

test("payload tableが空でもDB全体backupをコピー前に拒否する", async () => {
  for (const name of ["approval_payload_secrets","WEB_AUTH_PAYLOADS"]) {
    const input = await payloadBackupFixture(); const db = new Database(input.databasePath);
    db.exec(`CREATE TABLE ${name}(value TEXT)`); db.close();
    await assert.rejects(migrateV2ToV3WithBackup(input), /schema_full_backup_payload_store_forbidden/);
    await assert.rejects(fs.access(input.backupPath));
    const source = new Database(input.databasePath);
    try { assert.equal(source.pragma("user_version",{simple:true}),2); } finally { source.close(); }
  }
});

test("backup中の別connectionによるpayload追加はsnapshotへ混入せずmigrationも拒否する", async t => {
  const input = await payloadBackupFixture(); const other = new Database(input.databasePath);
  other.exec("CREATE TABLE large_fixture(value BLOB); INSERT INTO large_fixture VALUES(zeroblob(2097152))");
  t.after(() => other.close());
  const original = Database.prototype.backup;
  let injected = false;
  const replacement: typeof original = function (this: Database.Database, destination, options) {
    assert.equal(this.inTransaction, true);
    return original.call(this, destination, {...options, progress: () => {
      if (!injected) {
        injected = true;
        other.exec("CREATE TABLE approval_payload_secrets(value TEXT); INSERT INTO approval_payload_secrets VALUES('fixture-only')");
      }
      return 32;
    }});
  };
  t.mock.method(Database.prototype,"backup",replacement);
  await assert.rejects(migrateV2ToV3WithBackup(input), /schema_full_backup_payload_store_forbidden/);
  assert.equal(injected,true);
  const copied = new Database(input.backupPath);
  try {
    assert.equal(copied.prepare("SELECT 1 FROM sqlite_schema WHERE name='approval_payload_secrets'").get(),undefined);
    assert.equal(copied.pragma("user_version",{simple:true}),2);
  } finally { copied.close(); }
  assert.equal(other.pragma("user_version",{simple:true}),2);
  assert.equal(other.prepare("SELECT value FROM approval_payload_secrets").pluck().get(),"fixture-only");
});

test("payload入り既存backupとsourceをreceipt再利用・復旧の各経路で拒否する", async () => {
  for (const location of ["source","backup"] as const) for (const state of ["v2","v3","receipt"] as const) {
    const input = await payloadBackupFixture();
    const receipt = await migrateV2ToV3WithBackup(input);
    if (state === "v2") await fs.copyFile(input.backupPath,input.databasePath);
    if (state === "receipt") await publishMigrationReceipt(input.receiptPath,receipt);
    const db = new Database(location === "source" ? input.databasePath : input.backupPath);
    db.exec("CREATE TABLE web_auth_payloads(value TEXT); INSERT INTO web_auth_payloads VALUES('fixture-only')"); db.close();
    const result = await runRolloutCli(input.databasePath,input.backupPath,input.receiptPath);
    assert.notEqual(result.exit,0); assert.match(result.stderr,/schema_full_backup_payload_store_forbidden/);
    if (state !== "receipt") await assert.rejects(fs.access(input.receiptPath));
    else assert.deepEqual(JSON.parse(await fs.readFile(input.receiptPath,"utf8")),receipt);
  }
});


test("payload導入履歴はrename・drop後のfreelistを含む全体backupを拒否する",async()=>{
  for(const kind of ["web","approval"] as const) for(const operation of ["rename","drop"] as const){
    const input=await payloadBackupFixture();const db=new Database(input.databasePath);
    const marker="fixture-only-payload-page-".repeat(300);db.pragma("foreign_keys=ON");db.pragma("secure_delete=OFF");
    if(kind==="web"){
      installWebAuthSchema(db);verifyWebAuthSchema(db);
      db.exec("INSERT INTO web_auth_state VALUES('i','w','{}')");
      db.prepare("INSERT INTO web_auth_payloads VALUES('i','w','p',?)").run(JSON.stringify({fixture:marker}));
    }else db.transaction(()=>{
      // Approval's real v4 installer is tested in approval/schema.ts. This
      // rollout fixture exercises its shared persistent-history primitive.
      markDatabasePayloadHistory(db);db.exec("CREATE TABLE approval_payload_secrets(value TEXT)");
      db.prepare("INSERT INTO approval_payload_secrets VALUES(?)").run(marker);
    })();
    verifyDatabasePayloadHistory(db);
    const table=kind==="web"?"web_auth_payloads":"approval_payload_secrets";
    db.pragma("foreign_keys=OFF");
    db.exec(operation==="rename"?`ALTER TABLE ${table} RENAME TO historical_fixture`:`DROP TABLE ${table}`);
    if(kind==="web")db.exec("DROP TABLE web_auth_state; DROP TABLE web_auth_schema");
    if(operation==="drop")assert.ok(Number(db.pragma("freelist_count",{simple:true}))>0);
    db.close();
    assert.ok((await fs.readFile(input.databasePath)).includes(Buffer.from("fixture-only-payload-page-")));
    const reopened=new Database(input.databasePath);try{verifyDatabasePayloadHistory(reopened);}finally{reopened.close();}
    await assert.rejects(migrateV2ToV3WithBackup(input),/schema_full_backup_payload_store_forbidden/);
    await assert.rejects(fs.access(input.backupPath));
  }
});

test("旧Web schemaの明示admissionは履歴を記録しmarker不明の読取を拒否する",async()=>{
  const input=await payloadBackupFixture();const db=new Database(input.databasePath);db.pragma("foreign_keys=ON");
  try{
    installWebAuthSchema(db);db.pragma("application_id=0");
    assert.throws(()=>verifyWebAuthSchema(db));
    installWebAuthSchema(db);verifyDatabasePayloadHistory(db);verifyWebAuthSchema(db);
    db.pragma("application_id=123");assert.throws(()=>installWebAuthSchema(db));
    assert.equal(db.pragma("application_id",{simple:true}),123);
  }finally{db.close();}
});
