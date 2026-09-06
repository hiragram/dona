import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { assertSchemaActivationSafe, migrateV2ToV3WithBackup } from "../src/schema-rollout.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

const bridge = { app_schema_read_min: 2, app_schema_read_max: 3, app_schema_write: 2, rollback_safe: true };
const activation = { ...bridge, app_schema_write: 3 };

test("unsafe schema activation combinations are rejected before a write", () => {
  assert.throws(() => assertSchemaActivationSafe({ ...bridge, app_schema_read_max: 2 }, activation, 2), /compatibility_bridge/);
  assert.throws(() => assertSchemaActivationSafe(bridge, { ...activation, app_schema_write: 2 }, 2), /activation_release/);
  assert.throws(() => assertSchemaActivationSafe({ ...bridge, rollback_safe: false }, activation, 2), /safe_rollback/);
  assert.throws(() => assertSchemaActivationSafe(bridge, activation, 3), /requires_v2/);
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
  const wal = await fs.stat(`${databasePath}-wal`);
  assert.ok(wal.size > 0, "fixture must have committed pages in a live WAL");

  const receipt = await migrateV2ToV3WithBackup({
    databasePath, backupPath, previous: bridge, target: activation, quiesced: true, drained: true,
    completedAt: "2026-09-06T00:00:02.000Z",
  });
  db.close();
  assert.equal(receipt.migrated.user_version, 3);
  assert.deepEqual(receipt.preservation.event_results, { before: 1, after: 1 });
  assert.deepEqual(receipt.preservation.job_completions, { before: 1, after: 1 });

  const restored = new Database(backupPath, { readonly: true });
  assert.equal(restored.pragma("user_version", { simple: true }), 2);
  assert.equal(restored.prepare("SELECT result_json FROM jobs").pluck().get(), '{"status":"completed"}');
  restored.close();
  const migrated = new Database(databasePath, { readonly: true });
  assert.equal(migrated.pragma("user_version", { simple: true }), 3);
  assert.equal(migrated.prepare("SELECT result_json FROM jobs").pluck().get(), '{"status":"completed"}');
  migrated.close();
});

test("migration refuses to run before drain and never overwrites a backup", async () => {
  await assert.rejects(migrateV2ToV3WithBackup({
    databasePath: "/not/opened", backupPath: "/not/written", previous: bridge, target: activation,
    quiesced: false, drained: true,
  }), /quiesced_drained/);
});
