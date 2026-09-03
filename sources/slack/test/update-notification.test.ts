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
  SlackMessageMetadata,
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
  async authenticate() { return { teamId: "T123" }; }
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
  async postMessage(input: { channelId: string; text: string; threadTs?: string; replyBroadcast: boolean; metadata?: SlackMessageMetadata }): Promise<SlackPostResult> {
    this.postCount += 1;
    const messageTs = `1788390700.${this.postCount}`;
    this.messages.push({
      ts: messageTs,
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
      text: input.text,
      fileIds: [],
      reactions: [],
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    return {
      channelId: input.channelId,
      messageTs,
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
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
  });

  test("reconciles an ambiguous partial delivery by metadata without posting twice", async () => {
    const { client, reporter } = await reporterFixture();
    client.failStatusOnce = true;
    await assert.rejects(reporter.deliver(request), /status response lost/);
    assert.equal(client.postCount, 1);
    const result = await reporter.deliver(request);
    assert.equal(result.post_status, "existing");
    assert.equal(result.message_ts, "1788390700.1");
    assert.equal(client.postCount, 1);
    assert.equal(client.statusCount, 2);
    assert.deepEqual(client.messages[0]?.metadata, {
      eventType: "dona.update_notification",
      eventPayload: {
        notification_id: request.notification_id,
        request_id: request.request_id,
        terminal_fence: request.terminal_fence,
      },
    });
  });

  test("fails closed when duplicate metadata is already present", async () => {
    const { client, reporter } = await reporterFixture();
    const metadata = {
      eventType: "dona.update_notification",
      eventPayload: {
        notification_id: request.notification_id,
        request_id: request.request_id,
        terminal_fence: request.terminal_fence,
      },
    };
    client.messages.push(
      { ts: "1.1", text: "one", fileIds: [], reactions: [], metadata },
      { ts: "1.2", text: "two", fileIds: [], reactions: [], metadata },
    );
    await assert.rejects(reporter.deliver(request), /duplicate update notifications/);
    assert.equal(client.postCount, 0);
    assert.equal(client.statusCount, 0);
  });

  test("does not trust a matching notification ID with conflicting bound fields", async () => {
    const { client, reporter } = await reporterFixture();
    client.messages.push({
      ts: "1.1",
      text: "conflict",
      fileIds: [],
      reactions: [],
      metadata: {
        eventType: "dona.update_notification",
        eventPayload: {
          notification_id: request.notification_id,
          request_id: request.request_id,
          terminal_fence: request.terminal_fence + 1,
        },
      },
    });
    await assert.rejects(reporter.deliver(request), /conflicting identity metadata/);
    assert.equal(client.postCount, 0);
    assert.equal(client.statusCount, 0);
  });

  test("detects duplicate notification metadata across all thread pages", async () => {
    const { client, reporter } = await reporterFixture();
    const metadata = {
      eventType: "dona.update_notification",
      eventPayload: {
        notification_id: request.notification_id,
        request_id: request.request_id,
        terminal_fence: request.terminal_fence,
      },
    };
    client.threadPages = [
      { messages: [{ ts: "1.1", text: "one", fileIds: [], reactions: [], metadata }], hasMore: true },
      { messages: [{ ts: "1.2", text: "two", fileIds: [], reactions: [], metadata }], hasMore: false },
    ];
    await assert.rejects(reporter.deliver(request), /duplicate update notifications/);
    assert.equal(client.postCount, 0);
    assert.equal(client.statusCount, 0);
  });

  test("does not post when Slack claims another page but omits its cursor", async () => {
    const { client, reporter } = await reporterFixture();
    client.threadPageReader = () => ({ messages: [], hasMore: true });
    await assert.rejects(reporter.deliver(request), /pagination ended before all metadata/);
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

  test("confirms persisted metadata by read-back when the post response omits it", async () => {
    const { client, reporter } = await reporterFixture();
    const original = client.postMessage.bind(client);
    client.postMessage = async (input) => {
      const posted = await original(input);
      return {
        channelId: posted.channelId,
        messageTs: posted.messageTs,
        ...(posted.threadTs ? { threadTs: posted.threadTs } : {}),
      };
    };
    const result = await reporter.deliver(request);
    assert.equal(result.post_status, "created");
    assert.equal(result.message_ts, "1788390700.1");
    assert.equal(client.postCount, 1);
    assert.equal(client.statusCount, 1);
  });

  test("recovers a lost post response only when exact metadata is visible", async () => {
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

  test("does not retry an ambiguous post whose exact metadata is absent", async () => {
    const { client, reporter } = await reporterFixture();
    const original = client.postMessage.bind(client);
    client.postMessage = async (input) => {
      await original(input);
      delete client.messages.at(-1)?.metadata;
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

  test("returns a permanent partial receipt when Slack does not persist registered metadata", async () => {
    const { client, reporter } = await reporterFixture();
    const original = client.postMessage.bind(client);
    client.postMessage = async (input) => {
      const posted = await original(input);
      delete client.messages.at(-1)?.metadata;
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
        (error as { code?: unknown }).code === "metadata_not_persisted" &&
        (error as { receipt?: { message_ts?: unknown } }).receipt?.message_ts === "1788390700.1",
    );
    assert.equal(client.postCount, 1);
    assert.equal(client.statusCount, 1);
  });
});
