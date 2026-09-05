import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  canonicalJobPayload,
  canonicalJobPayloadSha256,
  jobObjectiveCharacterMax,
  parseCreateJobRequest,
  parseEventEnvelope,
  parseInternalUpdateEventEnvelope,
  parseResultEnvelope,
  stableStringify,
} from "../src/validation.js";
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
});

describe("job creation validation", () => {
  test("accepts job key boundaries and reserves legacy-default for omission", () => {
    const base = {
      source_event_id: " evt_source ",
      objective: " investigate ",
      workspace: { kind: "scratch", ignored: true },
      ignored: true,
    };
    const omitted = parseCreateJobRequest(base);
    assert.equal(omitted.job_key, undefined);
    assert.equal(omitted.source_event_id, "evt_source");
    assert.equal(omitted.objective, "investigate");
    assert.deepEqual(omitted.workspace, { kind: "scratch" });

    assert.equal(parseCreateJobRequest({ ...base, job_key: "a" }).job_key, "a");
    assert.equal(parseCreateJobRequest({ ...base, job_key: " report.daily " }).job_key, "report.daily");
    assert.equal(parseCreateJobRequest({ ...base, job_key: `a${"._-0".repeat(15)}abc` }).job_key?.length, 64);
    for (const jobKey of ["", "A", "-starts-wrong", `${"a".repeat(65)}`, "legacy-default"]) {
      assert.throws(() => parseCreateJobRequest({ ...base, job_key: jobKey }), /job_key|lowercase|reserved/);
    }
  });

  test("canonicalizes only the validated objective and workspace", () => {
    const first = parseCreateJobRequest({
      source_event_id: "evt_source",
      job_key: "one",
      objective: "  investigate  ",
      workspace: { kind: "github", repository: " owner/repo ", base_ref: " main ", ignored: "value" },
      ignored: "value",
    });
    const second = parseCreateJobRequest({
      source_event_id: "evt_source",
      job_key: "two",
      objective: "investigate",
      workspace: { kind: "github", repository: "owner/repo", base_ref: "main" },
    });
    assert.equal(
      stableStringify(canonicalJobPayload(first)),
      stableStringify(canonicalJobPayload(second)),
    );
    assert.equal(canonicalJobPayloadSha256(first), canonicalJobPayloadSha256(second));
  });

  test("counts objective characters independently from UTF-8 bytes", () => {
    const base = {
      source_event_id: "evt_source",
      job_key: "unicode.boundary",
      workspace: { kind: "scratch" },
    };
    const objective = "😀".repeat(jobObjectiveCharacterMax);
    const parsed = parseCreateJobRequest({ ...base, objective });
    assert.equal(Array.from(parsed.objective).length, jobObjectiveCharacterMax);
    assert.equal(Buffer.byteLength(parsed.objective, "utf8"), 400_000);
    assert.throws(
      () => parseCreateJobRequest({ ...base, objective: `${objective}😀` }),
      /at most 100000 characters/,
    );
  });
});
