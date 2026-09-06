import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

const rollout = JSON.parse(fs.readFileSync(new URL("../config/schema-rollout.json", import.meta.url)));
const target = JSON.parse(fs.readFileSync(new URL("../config/release-compatibility.json", import.meta.url)));
const previous = JSON.parse(fs.readFileSync(new URL("../config/release-compatibility.v2-v3-bridge.json", import.meta.url)));

test("schema activation names the exact buildable compatibility bridge", () => {
  assert.deepEqual(rollout, {
    schema_version: 1,
    phase: "activation",
    database_schema: 3,
    multi_job_enabled: true,
    previous_release_sha: "5e9bbf235f2f48c6f5675dbba3ab723a956cf64d",
    previous_release_contract: "release-compatibility.v2-v3-bridge.json",
    required_control_plane_capability: "dispatcher_v2_to_v3_online_backup_v1",
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
  const bridgeCompatibility = JSON.parse(execFileSync("git", ["show", `${rollout.previous_release_sha}:config/release-compatibility.json`], { encoding: "utf8" }));
  assert.deepEqual(bridgeCompatibility, previous);
  const bridgeDatabase = execFileSync("git", ["show", `${rollout.previous_release_sha}:dispatcher/src/database.ts`], { encoding: "utf8" });
  assert.match(bridgeDatabase, /configuredSchemaWrite/);
  assert.match(bridgeDatabase, /dispatcherSchemaCompatibility\.write >= 3/);
});
