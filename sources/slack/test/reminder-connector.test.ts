import assert from "node:assert/strict";
import { test } from "node:test";

import type { KeychainStore } from "../src/keychain.js";
import type { SlackLogger } from "../src/logger.js";
import { SlackReminderConnector } from "../src/reminder-connector.js";
import { SlackApiError, type SlackApiClient } from "../src/slack-api.js";
import { SlackWorkspaceRegistry } from "../src/workspace-registry.js";

const keychain: KeychainStore = { async get() { return "xoxb-test"; }, async set() {} };
const logger: SlackLogger = { debug() {}, info() {}, warn() {}, error() {} };
async function connector(post: () => Promise<{ channelId: string; messageTs: string }>) {
  const client = { authenticate: async () => ({ teamId: "T1" }), getChannel: async () => ({ id: "C1", isPrivate: false, isArchived: false, isMember: true, isShared: false }),
    getUser: async () => ({ id: "U1", isBot: false, isAppUser: false, isDeleted: false }), hasChannelMember: async () => true, postMessage: post } as unknown as SlackApiClient;
  return new SlackReminderConnector(await SlackWorkspaceRegistry.load(["company"], keychain, logger, () => client));
}
const input = { schema_version: 1, action: "slack.reminder.post", outbox_id: "o1", run_id: "r1", idempotency_key: "k1", owner_id: "U1",
  target: { kind: "channel", workspace_id: "T1", channel_id: "C1" }, text: "確認してください" } as const;

test("target・本文を制限しSlack結果を分類する", async () => {
  assert.deepEqual(await (await connector(async () => ({ channelId: "C1", messageTs: "1.000001" }))).deliver(input), { outcome: "accepted", receipt_id: "1.000001" });
  assert.equal((await (await connector(async () => { throw new SlackApiError("rate_limited", "rate", 3); })).deliver(input)).outcome, "not_accepted");
  assert.equal((await (await connector(async () => { throw new SlackApiError("slack_transport_error", "reset"); })).deliver(input)).outcome, "acceptance_unknown");
  assert.equal((await (await connector(async () => ({ channelId: "C1", messageTs: "1.0" }))).deliver({ ...input, text: "<!channel>" })).outcome, "rejected");
  assert.equal((await (await connector(async () => ({ channelId: "C1", messageTs: "1.0" }))).deliver({ ...input, target: { ...input.target, workspace_id: "T2" } })).outcome, "rejected");
});
