import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const integration = fs.readFileSync(new URL("../dispatcher/test/scheduler-integration-gate.test.ts", import.meta.url), "utf8");
const fixtures = JSON.parse(fs.readFileSync(new URL("../docs/adr/fixtures/scheduler-v1/cases.json", import.meta.url), "utf8"));

test("scheduler integration gateは4 vertical sliceとfailure matrixを0件にしない", () => {
  for (const name of ["one-shot reminder", "recurring reminder", "one-shot work", "recurring work",
    "restartとduplicate wake", "transaction partial failure", "provider timeout after send", "shared harness self-test"]) assert.match(integration, new RegExp(name));
  assert.equal((integration.match(/test\(/g) ?? []).length, 5);
});

test("ADR fixtureの全case IDをdecision gateへ列挙できる", () => {
  const ids = Object.values(fixtures).filter(Array.isArray).flatMap(group => group.map(item => item.id));
  assert.ok(ids.length >= 20);
  assert.equal(ids.length, new Set(ids).size);
  for (const required of ["ny_gap", "ny_overlap_first", "month_31", "leap_2028", "long_sleep", "overlap", "expiry_equal"]) assert.ok(ids.includes(required));
});
