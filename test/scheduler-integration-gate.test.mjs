import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const runner = fs.readFileSync(new URL("../scripts/run-scheduler-integration-gate.mjs", import.meta.url), "utf8");
const fixtures = JSON.parse(fs.readFileSync(new URL("../docs/adr/fixtures/scheduler-v1/cases.json", import.meta.url), "utf8"));

test("scheduler integration gateは実runnerのpass/fail/skip件数を検査する", () => {
  assert.match(runner, /const expected = 8/);
  for (const field of ["tests", "pass", "fail", "skipped"]) assert.match(runner, new RegExp(`summary\\.${field}`));
  assert.match(runner, /child\.status !== 0/);
});

test("ADR fixtureの全case IDをdecision gateへ列挙できる", () => {
  const ids = Object.values(fixtures).filter(Array.isArray).flatMap(group => group.map(item => item.id));
  assert.ok(ids.length >= 20);
  assert.equal(ids.length, new Set(ids).size);
  for (const required of ["ny_gap", "ny_overlap_first", "month_31", "leap_2028", "long_sleep", "overlap", "expiry_equal"]) assert.ok(ids.includes(required));
});
