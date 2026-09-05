import assert from "node:assert/strict";
import test from "node:test";

import { parseJobProgressRequest, SlackJobProgressReporter } from "../src/job-progress.js";

const request = { schema_version: 1 as const, progress_id: "job_abc:2" };
const resolved = { workspace_id: "T123", channel_id: "C123", thread_ts: "1234567890.123", status: "2件中1件目: テスト中" };

test("progress transport rejects arbitrary destinations and control characters", () => {
  assert.deepEqual(parseJobProgressRequest(request), request);
  assert.throws(() => parseJobProgressRequest({ ...request, destination: "C999" }));
  assert.throws(() => parseJobProgressRequest({ ...request, status: "test" }));
});

test("reporter uses assistant thread status rather than session title", async () => {
  let observed: unknown;
  const registry = { getByTeamId(teamId: string) { assert.equal(teamId, "T123"); return {
    teamId, client: { async setAssistantThreadProgress(input: unknown) { observed = input; } },
  }; } };
  const reporter = new SlackJobProgressReporter(registry as never, async () => resolved);
  assert.deepEqual(await reporter.deliver(request), { progress_id: "job_abc:2" });
  assert.deepEqual(observed, { channelId: "C123", threadTs: "1234567890.123", status: resolved.status });
});

test("reporter treats resolver and workspace failures as definitely unsent", async () => {
  const registry = { getByTeamId() { throw new Error("unknown workspace"); } };
  await assert.rejects(new SlackJobProgressReporter(registry as never, async () => resolved).deliver(request),
    (error: Error & { definitelyUnsent?:boolean }) => error.definitelyUnsent === true);
  await assert.rejects(new SlackJobProgressReporter(registry as never, async () => { throw new Error("resolver unavailable"); }).deliver(request),
    (error: Error & { definitelyUnsent?:boolean }) => error.definitelyUnsent === true);
});
