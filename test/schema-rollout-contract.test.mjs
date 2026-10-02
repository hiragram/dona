import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
const rollout=JSON.parse(fs.readFileSync(new URL("../config/schema-rollout.json",import.meta.url)));
const target=JSON.parse(fs.readFileSync(new URL("../config/release-compatibility.json",import.meta.url)));
test("Task世代は旧DBのonline migrationと旧binaryへのrollbackを許可しない",()=>{
  assert.equal(rollout.phase,"fresh_generation");
  assert.equal(rollout.database_schema,4);
  assert.equal(rollout.online_migration,false);
  assert.equal(rollout.rollback_to_legacy,false);
  assert.equal(rollout.requires_old_worker_stop,true);
  assert.equal(rollout.requires_no_recreation_fence,true);
  assert.equal(rollout.preserve_old_database_and_artifacts,true);
  assert.deepEqual([target.app_schema_read_min,target.app_schema_read_max,target.app_schema_write,target.rollback_safe],[4,4,4,false]);
});
