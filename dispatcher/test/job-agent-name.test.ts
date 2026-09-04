import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { jobAgentName, jobAgentSlug } from "../src/job-agent-name.js";

describe("Herdr job agent names", () => {
  test("keeps the complete ULID and a fixed human-readable task class within Herdr limits", () => {
    const name = jobAgentName("job_01m1ne631mt99zdpwfmrwsvjdg", "一覧を改善してください");

    assert.equal(name, "j01m1ne631mt99zdpwfmrwsvjdg-impr");
    assert.equal(name.length, 32);
    assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
  });

  test("returns only fixed vocabulary and falls back for arbitrary external text", () => {
    assert.equal(jobAgentSlug("Implement the feature"), "impl");
    assert.equal(jobAgentSlug("テストする"), "test");
    assert.equal(jobAgentSlug("監査する"), "rvw");
    assert.equal(jobAgentSlug("my-secret.example/api-key-123"), "task");
    assert.doesNotMatch(
      jobAgentName("job_01m1ne631mt99zdpwfmrwsvjdg", "my-secret.example/api-key-123"),
      /secret|example|key/,
    );
  });

  test("rejects identifiers outside the internal job ID contract", () => {
    assert.throws(() => jobAgentName("../../job", "実装"), /Invalid job ID/);
  });
});
