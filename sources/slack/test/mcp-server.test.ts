import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { KeychainStore } from "../src/keychain.js";
import type { SlackLogger } from "../src/logger.js";
import { createSlackMcpServer } from "../src/mcp/server.js";
import type {
  SlackApiClient,
  SlackAgentSessionStatus,
  SlackAgentSessionStatusResult,
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
  async get() {
    return "xoxb-test";
  }
  async set(): Promise<void> {
    throw new Error("must not write");
  }
}

class FakeSlackClient implements SlackApiClient {
  readonly posts: Array<{
    channelId: string;
    text: string;
    threadTs?: string;
    replyBroadcast: boolean;
  }> = [];
  readonly sessionStatuses: Array<{
    channelId: string;
    threadTs: string;
    status: SlackAgentSessionStatus;
    initiatorUserId?: string;
    title?: string;
  }> = [];

  async authenticate(): Promise<SlackWorkspaceIdentity> {
    return { teamId: "T123", teamName: "Test", botUserId: "U_BOT" };
  }
  async listChannels(): Promise<SlackChannelPage> {
    return {
      channels: [
        {
          id: "C123",
          name: "general",
          isPrivate: false,
          isArchived: false,
          isMember: true,
          isShared: false,
        },
      ],
    };
  }
  async getChannel(): Promise<SlackChannel> {
    return {
      id: "C123",
      name: "general",
      isPrivate: false,
      isArchived: false,
      isMember: true,
      isShared: false,
    };
  }
  async hasChannelMember(_channelId:string,userId:string):Promise<boolean> { return userId==="U1"; }
  async listUsers(): Promise<SlackUserPage> {
    return { users: [await this.getUser()] };
  }
  async getUser(): Promise<SlackUser> {
    return {
      id: "U1",
      displayName: "Test User",
      isBot: false,
      isAppUser: false,
      isDeleted: false,
    };
  }
  async getThread(): Promise<SlackThread> {
    return {
      messages: [
        {
          ts: "1.2",
          userId: "U1",
        text: "external message",
        fileIds: ["F123"],
        blockIds: [],
        reactions: [{ name: "eyes", count: 1, userIds: ["U1"] }],
        },
      ],
      hasMore: false,
    };
  }
  async getReactions(): Promise<SlackReactionSnapshot> {
    return {
      channelId: "C123",
      messageTs: "1.2",
      messageText: "external message",
      reactions: [{ name: "eyes", count: 1, userIds: ["U1"] }],
    };
  }
  async getFile(): Promise<SlackFileInfo> {
    return {
      id: "F123",
      name: "pixel.png",
      mimetype: "image/png",
      channelIds: ["C123"],
      content: {
        kind: "image",
        dataBase64: "aW1hZ2U=",
        mimetype: "image/png",
        variant: "original",
      },
      contentTruncated: false,
    };
  }
  async postMessage(input: {
    channelId: string;
    text: string;
    threadTs?: string;
    replyBroadcast: boolean;
  }): Promise<SlackPostResult> {
    this.posts.push(input);
    return { channelId: input.channelId, messageTs: "2.3", ...(input.threadTs ? { threadTs: input.threadTs } : {}) };
  }
  async setAgentSessionStatus(input: {
    channelId: string;
    threadTs: string;
    status: SlackAgentSessionStatus;
    initiatorUserId?: string;
    title?: string;
  }): Promise<SlackAgentSessionStatusResult> {
    this.sessionStatuses.push(input);
    return {
      status: input.status,
      agentStatus: input.status,
      ...(input.title ? { title: input.title } : {}),
    };
  }
  async addReaction(): Promise<void> {}
}

const logger: SlackLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe("Dona Slack MCP server", () => {
  test("advertises read/write tools and routes writes through the selected workspace", async () => {
    const fake = new FakeSlackClient();
    const registry = await SlackWorkspaceRegistry.load(
      ["company"],
      new MemoryKeychain(),
      logger,
      () => fake,
    );
    const server = createSlackMcpServer(registry, logger);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map(({ name }) => name),
        [
          "list_workspaces",
          "list_channels",
          "get_channel",
          "check_user_channel_access",
          "list_users",
          "get_user",
          "get_thread",
          "get_reactions",
          "get_file",
          "set_agent_session_status",
          "post_message",
          "add_reaction",
        ],
      );
      assert.equal(
        listed.tools.find(({ name }) => name === "get_thread")?.annotations?.readOnlyHint,
        true,
      );
      const accessResult=await client.callTool({name:"check_user_channel_access",arguments:{workspace:"company",channel_id:"C123",user_id:"U1"}});
      assert.deepEqual(accessResult.structuredContent,{workspace:"company",workspace_id:"T123",channel_id:"C123",user_id:"U1",authorized:true});
      assert.equal(
        listed.tools.find(({ name }) => name === "post_message")?.annotations?.readOnlyHint,
        false,
      );
      assert.equal(
        listed.tools.find(({ name }) => name === "set_agent_session_status")?.annotations?.idempotentHint,
        true,
      );

      const statusResult = await client.callTool({
        name: "set_agent_session_status",
        arguments: {
          workspace: "company",
          channel_id: "C123",
          thread_ts: "1.2",
          status: "processing",
          initiator_user_id: "U1",
          title: "Test request",
        },
      });
      assert.equal(statusResult.isError, undefined);
      assert.deepEqual(fake.sessionStatuses, [
        {
          channelId: "C123",
          threadTs: "1.2",
          status: "processing",
          initiatorUserId: "U1",
          title: "Test request",
        },
      ]);
      assert.deepEqual(statusResult.structuredContent, {
        workspace: "company",
        channel_id: "C123",
        thread_ts: "1.2",
        status: "processing",
        agent_status: "processing",
        title: "Test request",
      });

      const result = await client.callTool({
        name: "post_message",
        arguments: {
          workspace: "company",
          channel_id: "C123",
          text: "hello",
          thread_ts: "1.2",
        },
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(fake.posts, [
        {
          channelId: "C123",
          text: "hello",
          threadTs: "1.2",
          replyBroadcast: false,
        },
      ]);
      assert.deepEqual(result.structuredContent, {
        workspace: "company",
        channel_id: "C123",
        message_ts: "2.3",
        thread_ts: "1.2",
      });

      const fileResult = await client.callTool({
        name: "get_file",
        arguments: { workspace: "company", file_id: "F123" },
      });
      const typedFileResult = fileResult as {
        content: Array<{ type: string; mimeType?: string; data?: string }>;
        structuredContent?: Record<string, unknown>;
      };
      const image = typedFileResult.content.find((item) => item.type === "image");
      assert.ok(image && image.type === "image");
      assert.equal(image.mimeType, "image/png");
      assert.equal(image.data, "aW1hZ2U=");
      assert.equal(typedFileResult.structuredContent?.content_kind, "image");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
