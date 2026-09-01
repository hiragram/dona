import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { KeychainStore } from "../src/keychain.js";
import type { SlackLogger } from "../src/logger.js";
import type {
  SlackApiClient,
  SlackChannel,
  SlackChannelPage,
  SlackFileInfo,
  SlackPostResult,
  SlackReactionSnapshot,
  SlackThread,
  SlackUser,
  SlackUserPage,
  SlackWorkspaceIdentity,
} from "../src/slack-api.js";
import { SlackWorkspaceRegistry } from "../src/workspace-registry.js";

class MemoryKeychain implements KeychainStore {
  constructor(private readonly values: Record<string, string>) {}
  async get(account: string) {
    return this.values[account];
  }
  async set(): Promise<void> {
    throw new Error("must not write");
  }
}

class FakeSlackClient implements SlackApiClient {
  constructor(private readonly identity: SlackWorkspaceIdentity) {}
  async authenticate() {
    return this.identity;
  }
  async listChannels(): Promise<SlackChannelPage> {
    return { channels: [] };
  }
  async getChannel(): Promise<SlackChannel> {
    return {
      id: "C1",
      isPrivate: false,
      isArchived: false,
      isMember: true,
      isShared: false,
    };
  }
  async listUsers(): Promise<SlackUserPage> {
    return { users: [] };
  }
  async getUser(): Promise<SlackUser> {
    return { id: "U1", isBot: false, isAppUser: false, isDeleted: false };
  }
  async getThread(): Promise<SlackThread> {
    return { messages: [], hasMore: false };
  }
  async getReactions(): Promise<SlackReactionSnapshot> {
    return { channelId: "C1", messageTs: "1.1", messageText: "", reactions: [] };
  }
  async getFile(): Promise<SlackFileInfo> {
    return { id: "F1", channelIds: [], contentTruncated: false };
  }
  async postMessage(): Promise<SlackPostResult> {
    return { channelId: "C1", messageTs: "1.1" };
  }
  async addReaction(): Promise<void> {}
}

const logger: SlackLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe("SlackWorkspaceRegistry", () => {
  test("authenticates each alias with its own Keychain bot token", async () => {
    const seenTokens: string[] = [];
    const registry = await SlackWorkspaceRegistry.load(
      ["company", "community"],
      new MemoryKeychain({
        "company.slack-bot-token": "xoxb-company",
        "community.slack-bot-token": "xoxb-community",
      }),
      logger,
      (token) => {
        seenTokens.push(token);
        return new FakeSlackClient({ teamId: token === "xoxb-company" ? "T1" : "T2" });
      },
    );

    assert.deepEqual(seenTokens, ["xoxb-company", "xoxb-community"]);
    assert.deepEqual(
      registry.list().map(({ alias, teamId }) => ({ alias, teamId })),
      [
        { alias: "company", teamId: "T1" },
        { alias: "community", teamId: "T2" },
      ],
    );
    assert.equal(registry.get("community").teamId, "T2");
  });

  test("rejects aliases that accidentally point to the same Slack workspace", async () => {
    await assert.rejects(
      SlackWorkspaceRegistry.load(
        ["one", "two"],
        new MemoryKeychain({
          "one.slack-bot-token": "xoxb-one",
          "two.slack-bot-token": "xoxb-two",
        }),
        logger,
        () => new FakeSlackClient({ teamId: "T1" }),
      ),
      /同じSlack workspace/,
    );
  });
});
