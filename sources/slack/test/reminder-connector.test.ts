import assert from "node:assert/strict";
import { test } from "node:test";

import type { KeychainStore } from "../src/keychain.js";
import type { SlackLogger } from "../src/logger.js";
import { SlackReminderConnector } from "../src/reminder-connector.js";
import { SlackApiError, type SlackApiClient } from "../src/slack-api.js";
import { SlackWorkspaceRegistry } from "../src/workspace-registry.js";

const keychain: KeychainStore = { async get() { return "xoxb-test"; }, async set() {} };
const logger: SlackLogger = { debug() {}, info() {}, warn() {}, error() {} };
async function connector(post: () => Promise<{ channelId: string; messageTs: string }>, getChannel = async () => ({ id: "C1", isPrivate: false, isArchived: false, isMember: true, isShared: false })) {
  const client = { authenticate: async () => ({ teamId: "T1", botUserId: "U_BOT" }), getChannel,
    getUser: async () => ({ id: "U1", isBot: false, isAppUser: false, isDeleted: false }), hasChannelMember: async () => true, postMessage: post } as unknown as SlackApiClient;
  return new SlackReminderConnector(await SlackWorkspaceRegistry.load(["company"], keychain, logger, () => client));
}
const input = { schema_version: 1, action: "slack.reminder.post", outbox_id: "o1", run_id: "r1", idempotency_key: "k1", owner_id: "U1",
  expires_at: "2099-09-07T00:00:00Z", misfire_at: "2099-09-06T23:00:00Z",
  target: { kind: "channel", workspace_id: "T1", channel_id: "C1" }, text: "確認してください" } as const;

test("target・本文を制限しSlack結果を分類する", async () => {
  assert.deepEqual(await (await connector(async () => ({ channelId: "C1", messageTs: "1.000001" }))).deliver(input), { outcome: "accepted", receipt_id: "1.000001" });
  assert.equal((await (await connector(async () => { throw new SlackApiError("rate_limited", "rate", 3); })).deliver(input)).outcome, "not_accepted");
  assert.equal((await (await connector(async () => { throw new SlackApiError("slack_transport_error", "reset"); })).deliver(input)).outcome, "acceptance_unknown");
  assert.equal((await (await connector(async () => ({ channelId: "C1", messageTs: "1.0" }))).deliver({ ...input, text: "<!channel>" })).outcome, "rejected");
  assert.equal((await (await connector(async () => ({ channelId: "C1", messageTs: "1.0" }))).deliver({ ...input, target: { ...input.target, workspace_id: "T2" } })).outcome, "revoked");
  assert.deepEqual(await (await connector(async () => ({ channelId: "C1", messageTs: "1.0" }), async () => {
    throw new SlackApiError("token_revoked", "revoked");
  })).deliver(input), { outcome: "revoked", code: "token_revoked" });
  assert.deepEqual(await (await connector(async () => ({ channelId: "C1", messageTs: "1.0" }), async () => {
    throw new SlackApiError("invalid_auth", "invalid");
  })).deliver(input), { outcome: "revoked", code: "invalid_auth" });
  assert.equal((await (await connector(async () => ({ channelId: "C1", messageTs: "1.0" }), async () => ({
    id: "C1", isPrivate: false, isArchived: false, isMember: true, isShared: true,
  }))).deliver(input)).outcome, "accepted");
  assert.equal((await (await connector(async () => ({ channelId: "C1", messageTs: "1.0" }), async () => ({
    id: "C1", isPrivate: true, isArchived: false, isMember: false, isShared: false, isMpim: true,
  }))).deliver(input)).outcome, "accepted");
  assert.deepEqual(await (await connector(async () => {
    throw new SlackApiError("restricted_action_thread_locked", "locked");
  })).deliver(input), { outcome: "revoked", code: "restricted_action_thread_locked" });
});

test("同一channelの同時postを待機せずthrottleする", async () => {
  let release!: () => void;
  let calls = 0;
  const instance = await connector(async () => {
    calls++;
    if (calls === 1) await new Promise<void>((resolve) => void (release = resolve));
    return { channelId: "C1", messageTs: `1.00000${calls}` };
  });
  const first = instance.deliver(input);
  const second = await instance.deliver({ ...input, outbox_id: "o2", run_id: "r2", idempotency_key: "k2" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.deepEqual(second, { outcome: "not_accepted", code: "channel_throttled", retry_after_seconds: 1 });
  release();
  await first;
  assert.equal(calls, 1);
});
