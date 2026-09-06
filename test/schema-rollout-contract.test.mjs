import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const rollout = JSON.parse(fs.readFileSync(new URL("../config/schema-rollout.json", import.meta.url)));
const target = JSON.parse(fs.readFileSync(new URL("../config/release-compatibility.json", import.meta.url)));
const previous = JSON.parse(fs.readFileSync(new URL("../config/release-compatibility.v2-v3-bridge.json", import.meta.url)));

test("the compatibility bridge implementation and metadata both keep schema v2", () => {
  assert.deepEqual(rollout, {
    schema_version: 1,
    phase: "compatibility_bridge",
    database_schema: 2,
    multi_job_enabled: false,
    capabilities: ["app_schema_read_v2_v3", "dispatcher_v2_to_v3_online_backup_v1"],
  });
  assert.deepEqual(
    [previous.app_schema_read_min, previous.app_schema_read_max, previous.app_schema_write, previous.rollback_safe],
    [2, 3, 2, true],
  );
  assert.deepEqual(
    [target.app_schema_read_min, target.app_schema_read_max, target.app_schema_write, target.rollback_safe],
    [2, 3, 2, true],
  );
  const databaseSource = fs.readFileSync(new URL("../dispatcher/src/database.ts", import.meta.url), "utf8");
  assert.match(databaseSource, /app_schema_write/);
  assert.match(databaseSource, /write !== 2 && write !== 3/);
  assert.match(databaseSource, /dispatcherSchemaCompatibility\.write >= 3/);
});
