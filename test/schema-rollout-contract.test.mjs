import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const rollout = JSON.parse(fs.readFileSync(new URL("../config/schema-rollout.json", import.meta.url)));
const compatibility = JSON.parse(fs.readFileSync(new URL("../config/release-compatibility.json", import.meta.url)));
const bridge = JSON.parse(fs.readFileSync(new URL("../config/release-compatibility.v2-v3-bridge.json", import.meta.url)));

test("bridge release expands reads while keeping schema v2 and multi-job disabled", () => {
  assert.deepEqual(rollout, {
    schema_version: 1,
    phase: "compatibility_bridge",
    database_schema: 2,
    multi_job_enabled: false,
    capabilities: ["app_schema_read_v2_v3"],
  });
  for (const manifest of [compatibility, bridge]) {
    assert.equal(manifest.app_schema_read_min, 2);
    assert.equal(manifest.app_schema_read_max, 3);
    assert.equal(manifest.app_schema_write, 2);
    assert.equal(manifest.rollback_safe, true);
  }
  assert.equal(JSON.stringify(rollout).includes('"multi_job_enabled":true'), false);
});
