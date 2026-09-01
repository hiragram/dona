import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseEventEnvelope, parseResultEnvelope } from "../src/validation.js";
import { eventEnvelope } from "./helpers.js";

describe("event validation", () => {
  test("ignores unknown top-level fields", () => {
    const input = { ...eventEnvelope("Ev-1"), future_field: true };
    assert.equal("future_field" in parseEventEnvelope(input), false);
  });

  test("rejects non-UTC timestamps and wrong field types", () => {
    assert.throws(
      () => parseEventEnvelope({ ...eventEnvelope("Ev-1"), occurred_at: "2026-09-01T19:20:30+09:00" }),
      /UTC RFC 3339/,
    );
    assert.throws(() => parseEventEnvelope({ ...eventEnvelope("Ev-1"), payload: "text" }), /payload/);
  });

  test("rejects a result for another event", () => {
    assert.throws(
      () =>
        parseResultEnvelope(
          {
            schema_version: 1,
            event_id: "evt_other",
            status: "completed",
            completed_at: "2026-09-01T10:21:12Z",
          },
          "evt_expected",
        ),
      /does not match/,
    );
  });
});
