import assert from "node:assert/strict";
import test from "node:test";
import { buildEventPrompt } from "../src/prompt.js";
import type { EventEnvelope } from "../src/types.js";

const envelope: EventEnvelope = {
  schema_version: 1,
  source: "slack",
  external_event_id: "event-1",
  type: "message",
  occurred_at: "2026-09-24T00:00:00Z",
  subject: {},
  payload: {},
  reply_target: { workspace_id: "T1", channel_id: "C1", thread_ts: "1.0" },
};

test("通常のSlack eventとdona_jobだけにスレッド開示方針と安全な拒否時要約を渡す", () => {
  for (const source of ["slack", "dona_job"] as const) {
    const prompt = buildEventPrompt("evt-1", "/tmp/result.json", { ...envelope, source });
    assert.match(prompt, /保存済みreply_targetと同じworkspace、channel、thread/);
    assert.match(prompt, /PR\/Issue URL、CI・review結果、worker進捗/);
    assert.match(prompt, /group.transitionがprogressの中間通知ではSlackへ投稿せず/);
    assert.match(prompt, /group.attention_resolution_stateがnot_requiredまたはresolved/);
    assert.match(prompt, /automatic approvalで拒否された場合/);
    assert.match(prompt, /実質的に安全な短い要約を同じスレッドへ1回だけ投稿/);
    assert.match(prompt, /安全な要約も拒否されたら繰り返さず失敗として記録/);
    assert.match(prompt, /送信結果が曖昧な場合やtimeoutでは再送せず/);
  }
  for (const source of ["dona_schedule", "dona_update"] as const) {
    const prompt = buildEventPrompt("evt-1", "/tmp/result.json", { ...envelope, source });
    assert.doesNotMatch(prompt, /automatic approvalで拒否された場合/);
    assert.doesNotMatch(prompt, /保存済みreply_targetと同じworkspace、channel、thread/);
  }
  const scheduledResult = buildEventPrompt("evt-1", "/tmp/result.json", {
    ...envelope,
    source: "dona_job",
    payload: { owner_kind: "schedule" },
    reply_target: { kind: "owner_dm" },
  });
  assert.doesNotMatch(scheduledResult, /保存済みreply_targetと同じworkspace、channel、thread/);
  assert.doesNotMatch(scheduledResult, /automatic approvalで拒否された場合/);
});
