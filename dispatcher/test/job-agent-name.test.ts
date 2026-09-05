import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { jobAgentName, jobAgentSlug } from "../src/job-agent-name.js";

describe("Herdr job agent names", () => {
  test("embeds a fixed human-readable task class while preserving the job ID contract", () => {
    const name = jobAgentName("job_01m1ne631mt99zdpwfmrwsvjdg", "一覧を改善してください");

    assert.equal(name, "job_01m1ne631mt99zdpwfmrwsenhc");
    assert.equal(name.length, 30);
    assert.match(name, /^job_[0-9a-hjkmnp-tv-z]{26}$/);
    assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
  });

  test("returns only fixed vocabulary and falls back for arbitrary external text", () => {
    const cases = [
      ["improve the list", "enhc"],
      ["fix the worker", "mend"],
      ["Implement the feature", "feat"],
      ["テストする", "test"],
      ["READMEを更新する", "read"],
      ["監査する", "rvwx"],
      ["調査する", "rsch"],
      ["upgrade dependencies", "sync"],
      ["deploy the service", "send"],
      ["publish a release", "tags"],
      ["my-secret.example/api-key-123", "task"],
    ] as const;
    for (const [objective, expected] of cases) {
      const slug = jobAgentSlug(objective);
      assert.equal(slug, expected);
      assert.match(slug, /^[0-9a-hjkmnp-tv-z]{4}$/);
    }
    assert.doesNotMatch(
      jobAgentName("job_01m1ne631mt99zdpwfmrwsvjdg", "my-secret.example/api-key-123"),
      /secret|example|key/,
    );
  });

  test("rejects identifiers outside the internal job ID contract", () => {
    assert.throws(() => jobAgentName("../../job", "実装"), /Invalid job ID/);
  });
});
