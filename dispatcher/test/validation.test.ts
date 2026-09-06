import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseEventEnvelope, parseInternalScheduleEventEnvelope, parseInternalUpdateEventEnvelope, parseResultEnvelope } from "../src/validation.js";
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

  test("accepts dona_update only through the typed internal validator", () => {
    const envelope = {
      schema_version: 1,
      source: "dona_update",
      external_event_id: "update:upd_01m1es03xy5cf8d9pm5cwx4srv:terminal:1",
      type: "update_needs_review",
      occurred_at: "2026-09-02T00:00:00.000Z",
      subject: { request_id: "upd_01m1es03xy5cf8d9pm5cwx4srv" },
      payload: {
        request_id: "upd_01m1es03xy5cf8d9pm5cwx4srv", update_status: "needs_review",
        current_sha: "1".repeat(40), target_sha: "2".repeat(40), previous_sha: null,
        plan_hash: "a".repeat(64), policy_version: "2026-09-02.1", rollback_compatible: true,
        active_sha: null,
        error: { code: "build_failed", message: "tests failed" },
      },
      reply_target: { kind: "slack_thread", workspace_id: "T_TEST", channel_id: "C_TEST", thread_ts: "1756722030.123456" },
    };
    assert.throws(() => parseEventEnvelope(envelope), /source/);
    assert.equal(parseInternalUpdateEventEnvelope(envelope).source, "dona_update");
    assert.throws(() => parseInternalUpdateEventEnvelope({ ...envelope, type: "update_succeeded" }), /type\/status mismatch/);
  });

  test("dona_scheduleをinternal typed validatorだけで受理しstable identityを照合する", () => {
    const envelope = {
      schema_version: 1,
      source: "dona_schedule",
      external_event_id: "schedule:v1:s1:2026-09-05T00:01:00Z",
      type: "schedule_due",
      occurred_at: "2026-09-05T00:01:00Z",
      subject: { tenant_id: "T1", owner_id: "U1", schedule_id: "s1" },
      payload: { run_id: "run_1", revision: 1, occurrence_key: '["s1","2026-09-05T00:01:00Z"]',
        work: { objective: "read-only調査", scope: "read_only", allowed_external_writes: [], result_destination: { kind: "none" } } },
      reply_target: null,
      trace: { schedule_id: "s1", run_id: "run_1" },
    };
    assert.throws(() => parseEventEnvelope(envelope), /source/);
    assert.equal(parseInternalScheduleEventEnvelope(envelope).source, "dona_schedule");
    assert.throws(() => parseInternalScheduleEventEnvelope({ ...envelope, external_event_id: "schedule:v1:s2:2026-09-05T00:01:00Z" }), /mismatch/);
  });
});
