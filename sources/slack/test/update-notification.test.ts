import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { KeychainStore } from "../src/keychain.js";
import type { SlackLogger } from "../src/logger.js";
import type {
  SlackAgentSessionStatusResult,
  SlackApiClient,
  SlackChannel,
  SlackChannelPage,
  SlackFileInfo,
  SlackPostResult,
  SlackReactionSnapshot,
  SlackThread,
  SlackThreadMessage,
  SlackUser,
  SlackUserPage,
} from "../src/slack-api.js";
import {
  parseUpdateNotificationRequest,
  SlackUpdateNotificationReporter,
  type UpdateNotificationRequest,
} from "../src/update-notification.js";
import { SlackWorkspaceRegistry } from "../src/workspace-registry.js";

const logger: SlackLogger = { debug() {}, info() {}, warn() {}, error() {} };
const request: UpdateNotificationRequest = {
  schema_version: 1,
  notification_id: "update:upd_01m1es03xy5cf8d9pm5cwx4srv:terminal:2",
  request_id: "upd_01m1es03xy5cf8d9pm5cwx4srv",
  terminal_fence: 2,
  terminal_status: "succeeded",
  workspace_id: "T123",
  channel_id: "C123",
  thread_ts: "1756722030.123456",
  text: "セルフアップデートが完了しました。",
  desired_session_status: "active",
};

class MemoryKeychain implements KeychainStore {
  async get() { return "xoxb-test"; }
  async set(): Promise<void> { throw new Error("must not write"); }
}

class FakeSlackClient implements SlackApiClient {
  readonly messages: SlackThreadMessage[] = [];
  threadPages: SlackThread[] | undefined;
  threadPageReader: ((cursor?: string) => SlackThread) | undefined;
  postCount = 0;
  statusCount = 0;
  failStatusOnce = false;
  async authenticate() { return { teamId: "T123", botId: "B_TEST", botUserId: "U_TEST" }; }
  async listChannels(): Promise<SlackChannelPage> { return { channels: [] }; }
  async getChannel(): Promise<SlackChannel> {
    return { id: "C123", isPrivate: false, isArchived: false, isMember: true, isShared: false };
  }
  async listUsers(): Promise<SlackUserPage> { return { users: [] }; }
  async getUser(): Promise<SlackUser> { return { id: "U_TEST", isBot: false, isAppUser: false, isDeleted: false }; }
  async getThread(_channelId: string, _threadTs: string, _limit: number, cursor?: string): Promise<SlackThread> {
    if (this.threadPageReader) return this.threadPageReader(cursor);
    if (!this.threadPages) return { messages: [...this.messages], hasMore: false };
    const index = cursor ? Number(cursor) : 0;
    const page = this.threadPages[index]!;
    return index + 1 < this.threadPages.length ? { ...page, nextCursor: String(index + 1) } : page;
  }
  async getReactions(): Promise<SlackReactionSnapshot> {
    return { channelId: "C123", messageTs: "1.1", messageText: "", reactions: [] };
  }
  async getFile(): Promise<SlackFileInfo> { return { id: "F_TEST", channelIds: [], contentTruncated: false }; }
  async postMessage(input: { channelId: string; text: string; threadTs?: string; replyBroadcast: boolean; identityBlockId?: string }): Promise<SlackPostResult> {
    this.postCount += 1;
    const messageTs = `1788390700.${this.postCount}`;
    this.messages.push({
      ts: messageTs,
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
      userId: "U_TEST",
      botId: "B_TEST",
      text: input.text,
      fileIds: [],
      blockIds: input.identityBlockId ? [input.identityBlockId] : [],
      reactions: [],
    });
    return {
      channelId: input.channelId,
      messageTs,
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
    };
  }
  async setAgentSessionStatus(): Promise<SlackAgentSessionStatusResult> {
    this.statusCount += 1;
    if (this.failStatusOnce) {
      this.failStatusOnce = false;
      throw new Error("status response lost");
    }
    return { status: "active", agentStatus: "active" };
  }
  async addReaction(): Promise<void> {}
}

async function reporterFixture() {
  const client = new FakeSlackClient();
  const registry = await SlackWorkspaceRegistry.load(
    ["company"], new MemoryKeychain(), logger, () => client,
  );
  return { client, reporter: new SlackUpdateNotificationReporter(registry) };
}

describe("SlackUpdateNotificationReporter", () => {
  test("strictly binds the notification identity to the request and terminal fence", () => {
    assert.deepEqual(parseUpdateNotificationRequest(request), request);
    assert.throws(
      () => parseUpdateNotificationRequest({ ...request, terminal_fence: 3 }),
      /identity does not match/,
    );
    assert.throws(
      () => parseUpdateNotificationRequest({ ...request, command: "ignored" }),
      /fields do not match/,
    );
    assert.throws(
      () => parseUpdateNotificationRequest({ ...request, text: "x".repeat(3_001) }),
      /notification is invalid/,
    );
    const cancelled = {
      ...request,
      notification_id: `update:${request.request_id}:terminal:0`,
      terminal_fence: 0,
      terminal_status: "cancelled" as const,
      desired_session_status: "active" as const,
    };
    assert.deepEqual(parseUpdateNotificationRequest(cancelled), cancelled);
    assert.throws(
      () => parseUpdateNotificationRequest({ ...cancelled, terminal_status: "failed" }),
      /unclaimed cancellation/,
    );
    const missingStatus = { ...cancelled } as Record<string, unknown>;
    delete missingStatus.terminal_status;
    assert.throws(() => parseUpdateNotificationRequest(missingStatus), /unclaimed cancellation/);
  });

  test("reconciles an ambiguous partial delivery by identity block without posting twice", async () => {
    const { client, reporter } = await reporterFixture();
    client.failStatusOnce = true;
    await assert.rejects(reporter.deliver(request), /status response lost/);
    assert.equal(client.postCount, 1);
    const result = await reporter.deliver(request);
    assert.equal(result.post_status, "existing");
    assert.equal(result.message_ts, "1788390700.1");
    assert.equal(client.postCount, 1);
    assert.equal(client.statusCount, 2);
    assert.deepEqual(client.messages[0]?.blockIds, [
      `dona_update_notification:${request.notification_id}`,
    ]);
  });

  test("fails closed when duplicate identity blocks are already present", async () => {
    const { client, reporter } = await reporterFixture();
    const blockIds = [`dona_update_notification:${request.notification_id}`];
    client.messages.push(
      { ts: "1.1", botId: "B_TEST", text: "one", fileIds: [], blockIds, reactions: [] },
      { ts: "1.2", botId: "B_TEST", text: "two", fileIds: [], blockIds, reactions: [] },
    );
    await assert.rejects(reporter.deliver(request), /duplicate update notifications/);
    assert.equal(client.postCount, 0);
    assert.equal(client.statusCount, 0);
  });

  test("does not trust a matching identity block from another author", async () => {
    const { client, reporter } = await reporterFixture();
    client.messages.push({
      ts: "1.1",
      botId: "B_OTHER",
      text: "conflict",
      fileIds: [],
      blockIds: [`dona_update_notification:${request.notification_id}`],
      reactions: [],
    });
    await assert.rejects(reporter.deliver(request), /another author/);
    assert.equal(client.postCount, 0);
    assert.equal(client.statusCount, 0);
  });

  test("detects duplicate notification identity blocks across all thread pages", async () => {
    const { client, reporter } = await reporterFixture();
    const blockIds = [`dona_update_notification:${request.notification_id}`];
    client.threadPages = [
      { messages: [{ ts: "1.1", botId: "B_TEST", text: "one", fileIds: [], blockIds, reactions: [] }], hasMore: true },
      { messages: [{ ts: "1.2", botId: "B_TEST", text: "two", fileIds: [], blockIds, reactions: [] }], hasMore: false },
    ];
    await assert.rejects(reporter.deliver(request), /duplicate update notifications/);
    assert.equal(client.postCount, 0);
    assert.equal(client.statusCount, 0);
  });

  test("does not post when Slack claims another page but omits its cursor", async () => {
    const { client, reporter } = await reporterFixture();
    client.threadPageReader = () => ({ messages: [], hasMore: true });
    await assert.rejects(reporter.deliver(request), /pagination ended before all identity blocks/);
    assert.equal(client.postCount, 0);
    assert.equal(client.statusCount, 0);
  });

  test("does not post when Slack repeats a pagination cursor", async () => {
    const { client, reporter } = await reporterFixture();
    client.threadPageReader = () => ({ messages: [], hasMore: true, nextCursor: "repeated" });
    await assert.rejects(reporter.deliver(request), /pagination cursor repeated/);
    assert.equal(client.postCount, 0);
    assert.equal(client.statusCount, 0);
  });

  test("classifies an unknown workspace as a permanent delivery error", async () => {
    const { reporter } = await reporterFixture();
    await assert.rejects(
      reporter.deliver({ ...request, workspace_id: "T999" }),
      (error: unknown) => error instanceof Error &&
        error.name === "UpdateNotificationPermanentError" &&
        error.message === "Unknown Slack workspace ID: T999",
    );
  });

  test("confirms the persisted identity block by read-back after posting", async () => {
    const { client, reporter } = await reporterFixture();
    const original = client.postMessage.bind(client);
    client.postMessage = async (input) => {
      const posted = await original(input);
      return posted;
    };
    const result = await reporter.deliver(request);
    assert.equal(result.post_status, "created");
    assert.equal(result.message_ts, "1788390700.1");
    assert.equal(client.postCount, 1);
    assert.equal(client.statusCount, 1);
  });

  test("recovers a lost post response only when the exact identity block is visible", async () => {
    const { client, reporter } = await reporterFixture();
    const original = client.postMessage.bind(client);
    client.postMessage = async (input) => {
      await original(input);
      throw new Error("post response lost");
    };
    const result = await reporter.deliver(request);
    assert.equal(result.post_status, "created");
    assert.equal(result.message_ts, "1788390700.1");
    assert.equal(client.postCount, 1);
    assert.equal(client.statusCount, 1);
  });

  test("does not retry an ambiguous post whose exact identity block is absent", async () => {
    const { client, reporter } = await reporterFixture();
    const original = client.postMessage.bind(client);
    client.postMessage = async (input) => {
      await original(input);
      client.messages.at(-1)!.blockIds = [];
      throw new Error("post response lost");
    };
    await assert.rejects(
      reporter.deliver(request),
      (error: unknown) => error instanceof Error &&
        error.name === "UpdateNotificationPermanentError" &&
        (error as { code?: unknown }).code === "ambiguous_update_notification",
    );
    assert.equal(client.postCount, 1);
    assert.equal(client.statusCount, 0);
  });

  test("returns a permanent partial receipt when Slack does not persist the identity block", async () => {
    const { client, reporter } = await reporterFixture();
    const original = client.postMessage.bind(client);
    client.postMessage = async (input) => {
      const posted = await original(input);
      client.messages.at(-1)!.blockIds = [];
      return {
        channelId: posted.channelId,
        messageTs: posted.messageTs,
        ...(posted.threadTs ? { threadTs: posted.threadTs } : {}),
      };
    };
    await assert.rejects(
      reporter.deliver(request),
      (error: unknown) => error instanceof Error &&
        error.name === "UpdateNotificationPermanentError" &&
        (error as { code?: unknown }).code === "identity_block_not_persisted" &&
        (error as { receipt?: { message_ts?: unknown } }).receipt?.message_ts === "1788390700.1",
    );
    assert.equal(client.postCount, 1);
    assert.equal(client.statusCount, 1);
  });
});
