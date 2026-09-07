import assert from "node:assert/strict";
import { test } from "node:test";

import type { KeychainStore } from "../src/keychain.js";
import type { SlackLogger } from "../src/logger.js";
import { SlackReminderConnector } from "../src/reminder-connector.js";
import { SlackApiError, type SlackApiClient } from "../src/slack-api.js";
import { SlackWorkspaceRegistry } from "../src/workspace-registry.js";

const keychain: KeychainStore = { async get() { return "xoxb-test"; }, async set() {} };
const logger: SlackLogger = { debug() {}, info() {}, warn() {}, error() {} };
async function connector(post: (input: { channelId: string }) => Promise<{ channelId: string; messageTs: string; threadTs?: string }>, getChannel: (channelId: string) => Promise<{ id: string; isPrivate: boolean; isArchived: boolean; isMember: boolean; isShared: boolean; isMpim?: boolean }> = async () => ({ id: "C1", isPrivate: false, isArchived: false, isMember: true, isShared: false })) {
  const client = { authenticate: async () => ({ teamId: "T1", botUserId: "U_BOT" }), getChannel,
    getUser: async () => ({ id: "U1", isBot: false, isAppUser: false, isDeleted: false }), hasChannelMember: async () => true,
    postMessage: async (request: { channelId: string; threadTs?: string }) => ({ ...(request.threadTs ? { threadTs: request.threadTs } : {}), ...await post(request) }),
  } as unknown as SlackApiClient;
  const instance = new SlackReminderConnector(await SlackWorkspaceRegistry.load(["company"], keychain, logger, () => client));
  return { preflight: (value: unknown) => instance.deliver(value, true), deliverPrepared: (value: unknown) => instance.deliver(value), async deliver(value: unknown) {
    const preflight = await instance.deliver(value, true);
    return preflight.outcome === "prepared" ? await instance.deliver(value) : preflight;
  } };
}
const input = { schema_version: 1, action: "slack.reminder.post", outbox_id: "o1", run_id: "r1", idempotency_key: "k1", owner_id: "U1",
  expires_at: "2099-09-07T00:00:00Z", misfire_at: "2099-09-06T23:00:00Z", lease_until: "2099-09-06T23:04:00Z",
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

test("preflight ticket欠落をknown non-acceptance、thread receipt逸脱をunknownにする", async () => {
  const missing = await connector(async () => ({ channelId: "C1", messageTs: "1.000001" }));
  assert.deepEqual(await missing.deliverPrepared(input), { outcome: "not_accepted", code: "preflight_required", retry_after_seconds: 0 });
  const mismatch = await connector(async () => ({ channelId: "C1", messageTs: "1.000001", threadTs: "2.000002" }));
  const threadInput = { ...input, target: { kind: "thread", workspace_id: "T1", channel_id: "C1", thread_ts: "1.000001" } } as const;
  assert.equal((await mismatch.preflight(threadInput)).outcome, "prepared");
  assert.deepEqual(await mismatch.deliverPrepared(threadInput), { outcome: "acceptance_unknown", code: "receipt_mismatch" });
});

test("同一channelの同時preflightをremote認可前にthrottleする", async () => {
  let release!: () => void;
  let calls = 0;
  const gate = new Promise<void>((resolve) => void (release = resolve));
  const instance = await connector(async () => ({ channelId: "C1", messageTs: "1.000001" }), async () => {
    calls++;
    await gate;
    return { id: "C1", isPrivate: false, isArchived: false, isMember: true, isShared: false };
  });
  const first = instance.deliver(input);
  const second = instance.deliver({ ...input, outbox_id: "o2", run_id: "r2", idempotency_key: "k2" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await first;
  await second;
  assert.equal(calls, 1);
});

test("同一workspaceの異なるchannelでも認可methodをboundedにする", async () => {
  let release!: () => void;
  let authorizationCalls = 0;
  const gate = new Promise<void>((resolve) => void (release = resolve));
  const instance = await connector(async ({ channelId }) => ({ channelId, messageTs: "1.000001" }), async (channelId) => {
    authorizationCalls++;
    await gate;
    return { id: channelId, isPrivate: false, isArchived: false, isMember: true, isShared: false };
  });
  const first = instance.deliver(input);
  const second = instance.deliver({ ...input, outbox_id: "o2", run_id: "r2", idempotency_key: "k2", target: { ...input.target, channel_id: "C2" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(authorizationCalls, 1);
  release();
  assert.equal((await first).outcome, "accepted");
  assert.equal((await second).outcome, "unavailable");
});

test("認可rate limitをauthorization unavailableとして返す", async () => {
  const instance = await connector(async () => ({ channelId: "C1", messageTs: "1.000001" }), async () => {
    throw new SlackApiError("rate_limited", "rate", 901);
  });
  assert.deepEqual(await instance.deliver(input), {
    outcome: "authorization_unavailable", code: "authorization_rate_limited", retry_after_seconds: 901,
  });
  assert.equal((await instance.deliver({ ...input, outbox_id: "o2", run_id: "r2", idempotency_key: "k2" })).outcome, "authorization_unavailable");
});

test("認可methodのin-flight中は後続attemptを消費しない", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => void (release = resolve));
  const instance = await connector(async () => ({ channelId: "C1", messageTs: "1.000001" }), async (channelId) => {
    if (channelId === "C1") await gate;
    throw new SlackApiError("rate_limited", "rate", channelId === "C1" ? 1 : 60);
  });
  const short = instance.deliver(input);
  const long = await instance.deliver({ ...input, outbox_id: "o2", run_id: "r2", idempotency_key: "k2", target: { ...input.target, channel_id: "C2" } });
  assert.equal(long.outcome, "unavailable");
  release();
  assert.equal((await short).outcome, "authorization_unavailable");
});
