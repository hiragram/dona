import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const rollout = JSON.parse(fs.readFileSync(new URL("../config/schema-rollout.json", import.meta.url)));
const target = JSON.parse(fs.readFileSync(new URL("../config/release-compatibility.json", import.meta.url)));
const previous = JSON.parse(fs.readFileSync(new URL("../config/release-compatibility.v2-v3-bridge.json", import.meta.url)));

test("schema activation is separated from its compatibility release", () => {
  assert.deepEqual(rollout, {
    schema_version: 1,
    phase: "activation",
    database_schema: 3,
    multi_job_enabled: true,
    previous_release_contract: "release-compatibility.v2-v3-bridge.json",
    migration: {
      from_schema: 2,
      to_schema: 3,
      requires_quiesce: true,
      requires_drain: true,
      backup: "sqlite_online_backup",
      restore_open_test: true,
    },
  });
  assert.deepEqual(
    [previous.app_schema_read_min, previous.app_schema_read_max, previous.app_schema_write, previous.rollback_safe],
    [2, 3, 2, true],
  );
  assert.deepEqual(
    [target.app_schema_read_min, target.app_schema_read_max, target.app_schema_write, target.rollback_safe],
    [2, 3, 3, true],
  );
});
