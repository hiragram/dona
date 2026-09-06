import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const rollout = JSON.parse(fs.readFileSync(new URL("../config/schema-rollout.json", import.meta.url)));
const compatibility = JSON.parse(fs.readFileSync(new URL("../config/release-compatibility.json", import.meta.url)));
const bridge = JSON.parse(fs.readFileSync(new URL("../config/release-compatibility.v2-v3-bridge.json", import.meta.url)));

test("bootstrap release stays on schema v2 while installing the widening planner", () => {
  assert.deepEqual(rollout, {
    schema_version: 1,
    phase: "compatibility_bootstrap",
    database_schema: 2,
    multi_job_enabled: false,
    capabilities: ["safe_read_max_widening_planner"],
  });
  assert.deepEqual(compatibility, {
    schema_version: 1, protocol: 1, config: 1, app_schema_read_min: 2,
    app_schema_read_max: 2, app_schema_write: 2, rollback_safe: true,
  });
  assert.equal(bridge.app_schema_read_min, 2);
  assert.equal(bridge.app_schema_read_max, 3);
  assert.equal(bridge.app_schema_write, 2);
  assert.equal(bridge.rollback_safe, true);
  assert.equal(JSON.stringify(rollout).includes('"multi_job_enabled":true'), false);
});
