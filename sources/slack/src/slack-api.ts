import {
  ErrorCode,
  LogLevel,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebClient,
  type Logger,
} from "@slack/web-api";

import type { SlackLogger } from "./logger.js";

export interface SlackWorkspaceIdentity {
  teamId: string;
  teamName?: string;
  botUserId?: string;
  botId?: string;
}

export interface SlackThreadMessage {
  ts: string;
  threadTs?: string;
  userId?: string;
  botId?: string;
  text: string;
  fileIds: string[];
  reactions: SlackReaction[];
  blockIds: string[];
}

export interface SlackThread {
  messages: SlackThreadMessage[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface SlackPostResult {
  channelId: string;
  messageTs: string;
  threadTs?: string;
}

export type SlackAgentSessionStatus = "active" | "processing" | "suspended" | "closed";

export interface SlackAgentSessionStatusResult {
  status: SlackAgentSessionStatus;
  agentStatus: SlackAgentSessionStatus;
  title?: string;
  warning?: string;
}

export interface SlackChannel {
  id: string;
  name?: string;
  isPrivate: boolean;
  isArchived: boolean;
  isMember: boolean;
  isShared: boolean;
  topic?: string;
  purpose?: string;
  memberCount?: number;
  isIm?: boolean;
  userId?: string;
}

export interface SlackChannelPage {
  channels: SlackChannel[];
  nextCursor?: string;
}

export interface SlackUser {
  id: string;
  username?: string;
  displayName?: string;
  realName?: string;
  title?: string;
  timezone?: string;
  isBot: boolean;
  isAppUser: boolean;
  isDeleted: boolean;
}

export interface SlackUserPage {
  users: SlackUser[];
  nextCursor?: string;
}

export interface SlackReaction {
  name: string;
  count: number;
  userIds: string[];
}

export interface SlackReactionSnapshot {
  channelId: string;
  messageTs: string;
  messageUserId?: string;
  messageText: string;
  reactions: SlackReaction[];
}

export interface SlackFileInfo {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  sizeBytes?: number;
  userId?: string;
  createdAt?: string;
  permalink?: string;
  channelIds: string[];
  content?:
    | { kind: "text"; text: string; variant: "original" | "snippet" }
    | {
        kind: "image";
        dataBase64: string;
        mimetype: string;
        variant: "original" | "thumbnail";
      };
  contentTruncated: boolean;
  contentUnavailableReason?: string;
}

export interface SlackApiClient {
  authenticate(): Promise<SlackWorkspaceIdentity>;
  listChannels(limit: number, cursor?: string): Promise<SlackChannelPage>;
  getChannel(channelId: string): Promise<SlackChannel>;
  hasChannelMember?(channelId: string, userId: string): Promise<boolean>;
  listUsers(limit: number, cursor?: string): Promise<SlackUserPage>;
  getUser(userId: string): Promise<SlackUser>;
  getThread(channelId: string, threadTs: string, limit: number, cursor?: string): Promise<SlackThread>;
  getReactions(channelId: string, messageTs: string): Promise<SlackReactionSnapshot>;
  getFile(fileId: string): Promise<SlackFileInfo>;
  postMessage(input: {
    channelId: string;
    text: string;
    threadTs?: string;
    replyBroadcast: boolean;
    identityBlockId?: string;
    mrkdwn?: boolean;
  }): Promise<SlackPostResult>;
  setAgentSessionStatus(input: {
    channelId: string;
    threadTs: string;
    status: SlackAgentSessionStatus;
    initiatorUserId?: string;
    title?: string;
  }): Promise<SlackAgentSessionStatusResult>;
  addReaction(channelId: string, messageTs: string, emojiName: string): Promise<void>;
}

const maxTextFileBytes = 1_048_576;
const maxImageFileBytes = 5_242_880;

function isAgentSessionStatus(value: unknown): value is SlackAgentSessionStatus {
  return value === "active" || value === "processing" || value === "suspended" || value === "closed";
}

function optionalCursor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function epochSecondsToIso(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return new Date(value * 1_000).toISOString();
}

function channelFromResponse(channel: {
  id?: string;
  name?: string;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  is_shared?: boolean;
  is_ext_shared?: boolean;
  topic?: { value?: string };
  purpose?: { value?: string };
  num_members?: number;
  is_im?: boolean;
  user?: string;
}): SlackChannel {
  return {
    id: nonEmpty(channel.id, "channel.id"),
    ...(channel.name ? { name: channel.name } : {}),
    isPrivate: channel.is_private ?? false,
    isArchived: channel.is_archived ?? false,
    isMember: channel.is_member ?? false,
    isShared: channel.is_shared ?? channel.is_ext_shared ?? false,
    ...(channel.topic?.value ? { topic: channel.topic.value } : {}),
    ...(channel.purpose?.value ? { purpose: channel.purpose.value } : {}),
    ...(channel.num_members !== undefined ? { memberCount: channel.num_members } : {}),
    ...(channel.is_im !== undefined ? { isIm: channel.is_im } : {}),
    ...(channel.user ? { userId: channel.user } : {}),
  };
}

function userFromResponse(user: {
  id?: string;
  name?: string;
  real_name?: string;
  tz?: string;
  is_bot?: boolean;
  is_app_user?: boolean;
  deleted?: boolean;
  profile?: { display_name?: string; real_name?: string; title?: string };
}): SlackUser {
  return {
    id: nonEmpty(user.id, "user.id"),
    ...(user.name ? { username: user.name } : {}),
    ...(user.profile?.display_name ? { displayName: user.profile.display_name } : {}),
    ...(user.profile?.real_name ?? user.real_name
      ? { realName: user.profile?.real_name ?? user.real_name! }
      : {}),
    ...(user.profile?.title ? { title: user.profile.title } : {}),
    ...(user.tz ? { timezone: user.tz } : {}),
    isBot: user.is_bot ?? false,
    isAppUser: user.is_app_user ?? false,
    isDeleted: user.deleted ?? false,
  };
}

function isReadableTextMime(mimetype: string | undefined): boolean {
  if (!mimetype) return false;
  return (
    mimetype.startsWith("text/") ||
    mimetype === "application/json" ||
    mimetype === "application/xml" ||
    mimetype.endsWith("+json") ||
    mimetype.endsWith("+xml")
  );
}

function isAllowedSlackFileHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "slack.com" ||
    host.endsWith(".slack.com") ||
    host === "slack-edge.com" ||
    host.endsWith(".slack-edge.com") ||
    host === "slack-files.com" ||
    host.endsWith(".slack-files.com")
  );
}

function isSupportedImageMime(mimetype: string | undefined): boolean {
  return new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]).has(mimetype ?? "");
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  return { text: bytes.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

export class SlackApiError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}

class StderrOnlyWebApiLogger implements Logger {
  private level = LogLevel.INFO;
  private name = "slack_web_api";

  constructor(private readonly logger: SlackLogger) {}

  debug(..._details: unknown[]): void {}
  info(..._details: unknown[]): void {}
  warn(..._details: unknown[]): void {
    this.logger.warn("Slack Web API SDK warning", { sdk_name: this.name, detail: "omitted" });
  }
  error(..._details: unknown[]): void {
    this.logger.error("Slack Web API SDK error", { sdk_name: this.name, detail: "omitted" });
  }
  setLevel(level: LogLevel): void {
    this.level = level;
  }
  getLevel(): LogLevel {
    return this.level;
  }
  setName(name: string): void {
    this.name = name;
  }
}

function nonEmpty(value: string | undefined, field: string): string {
  if (value) return value;
  throw new SlackApiError("invalid_slack_response", `Slack response did not include ${field}`);
}

function mapSlackError(error: unknown): SlackApiError {
  if (error instanceof SlackApiError) return error;
  if (error instanceof WebAPIPlatformError) {
    return new SlackApiError(error.data.error, `Slack API rejected the request: ${error.data.error}`);
  }
  if (error instanceof WebAPIRateLimitedError) {
    return new SlackApiError("rate_limited", "Slack API rate limit exceeded", error.retryAfter);
  }
  if (error instanceof Error && "code" in error && error.code === ErrorCode.RequestError) {
    return new SlackApiError(
      "slack_transport_error",
      "Slack API transport failed; a write may have been accepted, so do not retry it automatically",
    );
  }
  if (error instanceof Error && "code" in error && error.code === ErrorCode.HTTPError) {
    return new SlackApiError(
      "slack_http_error",
      "Slack API returned an unexpected HTTP response; do not retry a write automatically",
    );
  }
  return new SlackApiError("slack_api_error", "Slack API request failed");
}

async function callSlack<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw mapSlackError(error);
  }
}

export class SlackWebApiClient implements SlackApiClient {
  private readonly client: WebClient;
  private readonly botToken: string;

  constructor(botToken: string, logger: SlackLogger) {
    this.botToken = botToken;
    this.client = new WebClient(botToken, {
      logger: new StderrOnlyWebApiLogger(logger),
      retryConfig: { retries: 0 },
      timeout: 15_000,
      rejectRateLimitedCalls: true,
    });
  }

  async authenticate(): Promise<SlackWorkspaceIdentity> {
    const response = await callSlack(() => this.client.auth.test());
    return {
      teamId: nonEmpty(response.team_id, "team_id"),
      ...(response.team ? { teamName: response.team } : {}),
      ...(response.user_id ? { botUserId: response.user_id } : {}),
      ...(response.bot_id ? { botId: response.bot_id } : {}),
    };
  }

  async listChannels(limit: number, cursor?: string): Promise<SlackChannelPage> {
    const response = await callSlack(() =>
      this.client.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit,
        ...(optionalCursor(cursor) ? { cursor: optionalCursor(cursor)! } : {}),
      }),
    );
    const nextCursor = optionalCursor(response.response_metadata?.next_cursor);
    return {
      channels: (response.channels ?? []).flatMap((channel) =>
        channel.id ? [channelFromResponse(channel)] : [],
      ),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  async getChannel(channelId: string): Promise<SlackChannel> {
    const response = await callSlack(() =>
      this.client.conversations.info({ channel: channelId, include_num_members: true }),
    );
    if (!response.channel) {
      throw new SlackApiError("invalid_slack_response", "Slack response did not include channel");
    }
    return channelFromResponse(response.channel);
  }

  async hasChannelMember(channelId: string, userId: string): Promise<boolean> {
    let cursor: string | undefined;
    do {
      const response = await callSlack(() => this.client.conversations.members({ channel: channelId, limit: 200, ...(cursor ? { cursor } : {}) }));
      if ((response.members ?? []).includes(userId)) return true;
      cursor = optionalCursor(response.response_metadata?.next_cursor);
    } while (cursor);
    return false;
  }

  async listUsers(limit: number, cursor?: string): Promise<SlackUserPage> {
    const response = await callSlack(() =>
      this.client.users.list({
        limit,
        ...(optionalCursor(cursor) ? { cursor: optionalCursor(cursor)! } : {}),
      }),
    );
    const nextCursor = optionalCursor(response.response_metadata?.next_cursor);
    return {
      users: (response.members ?? []).flatMap((user) => (user.id ? [userFromResponse(user)] : [])),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  async getUser(userId: string): Promise<SlackUser> {
    const response = await callSlack(() => this.client.users.info({ user: userId }));
    if (!response.user) {
      throw new SlackApiError("invalid_slack_response", "Slack response did not include user");
    }
    return userFromResponse(response.user);
  }

  async getThread(channelId: string, threadTs: string, limit: number, cursor?: string): Promise<SlackThread> {
    const response = await callSlack(() =>
      this.client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit,
        ...(cursor ? { cursor } : {}),
      }),
    );
    const nextCursor = optionalCursor(response.response_metadata?.next_cursor);
    return {
      messages: (response.messages ?? []).flatMap((message) => {
        if (!message.ts) return [];
        return [
          {
            ts: message.ts,
            ...(message.thread_ts ? { threadTs: message.thread_ts } : {}),
            ...(message.user ? { userId: message.user } : {}),
            ...(message.bot_id ? { botId: message.bot_id } : {}),
            text: message.text ?? "",
            fileIds: (message.files ?? []).flatMap((file) => (file.id ? [file.id] : [])),
            blockIds: (message.blocks ?? []).flatMap((block) => {
              const blockId = (block as { block_id?: unknown }).block_id;
              return typeof blockId === "string" ? [blockId] : [];
            }),
            reactions: (message.reactions ?? []).flatMap((reaction) =>
              reaction.name
                ? [
                    {
                      name: reaction.name,
                      count: reaction.count ?? 0,
                      userIds: reaction.users ?? [],
                    },
                  ]
                : [],
            ),
          },
        ];
      }),
      hasMore: response.has_more ?? false,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  async getReactions(channelId: string, messageTs: string): Promise<SlackReactionSnapshot> {
    const response = await callSlack(() =>
      this.client.reactions.get({ channel: channelId, timestamp: messageTs, full: true }),
    );
    const message = response.message;
    if (!message) {
      throw new SlackApiError("invalid_slack_response", "Slack response did not include message");
    }
    return {
      channelId: response.channel ?? channelId,
      messageTs: message.ts ?? messageTs,
      ...(message.user ? { messageUserId: message.user } : {}),
      messageText: message.text ?? "",
      reactions: (message.reactions ?? []).flatMap((reaction) =>
        reaction.name
          ? [
              {
                name: reaction.name,
                count: reaction.count ?? 0,
                userIds: reaction.users ?? [],
              },
            ]
          : [],
      ),
    };
  }

  async getFile(fileId: string): Promise<SlackFileInfo> {
    const response = await callSlack(() => this.client.files.info({ file: fileId }));
    const file = response.file;
    if (!file) {
      throw new SlackApiError("invalid_slack_response", "Slack response did not include file");
    }

    const result: SlackFileInfo = {
      id: nonEmpty(file.id, "file.id"),
      ...(file.name ? { name: file.name } : {}),
      ...(file.title ? { title: file.title } : {}),
      ...(file.mimetype ? { mimetype: file.mimetype } : {}),
      ...(file.filetype ? { filetype: file.filetype } : {}),
      ...(file.size !== undefined ? { sizeBytes: file.size } : {}),
      ...(file.user ? { userId: file.user } : {}),
      ...(epochSecondsToIso(file.created) ? { createdAt: epochSecondsToIso(file.created)! } : {}),
      ...(file.permalink ? { permalink: file.permalink } : {}),
      channelIds: [...new Set([...(file.channels ?? []), ...(file.groups ?? [])])],
      contentTruncated: false,
    };

    const embeddedText = response.content ?? file.plain_text ?? file.preview_plain_text;
    if (isReadableTextMime(file.mimetype) && embeddedText) {
      const content = truncateUtf8(embeddedText, maxTextFileBytes);
      result.content = { kind: "text", text: content.text, variant: "snippet" };
      result.contentTruncated = content.truncated;
      return result;
    }

    if (isSupportedImageMime(file.mimetype)) {
      const useThumbnail = (file.size ?? 0) > maxImageFileBytes;
      const downloadUrl = useThumbnail
        ? (file.thumb_1024 ?? file.thumb_960 ?? file.thumb_720 ?? file.thumb_480)
        : (file.url_private_download ?? file.url_private);
      if (!downloadUrl) {
        result.contentUnavailableReason = "image_download_url_missing";
        return result;
      }
      const downloaded = await this.downloadFile(downloadUrl, maxImageFileBytes);
      const imageMimetype = isSupportedImageMime(downloaded.mimetype)
        ? downloaded.mimetype
        : file.mimetype;
      if (!isSupportedImageMime(imageMimetype)) {
        result.contentUnavailableReason = "unsupported_downloaded_image_type";
        return result;
      }
      result.content = {
        kind: "image",
        dataBase64: downloaded.bytes.toString("base64"),
        mimetype: imageMimetype!,
        variant: useThumbnail ? "thumbnail" : "original",
      };
      result.contentTruncated = useThumbnail;
      return result;
    }

    if (isReadableTextMime(file.mimetype)) {
      const downloadUrl = file.url_private_download ?? file.url_private;
      if (!downloadUrl || (file.size ?? 0) > maxTextFileBytes) {
        result.contentUnavailableReason = downloadUrl ? "text_file_too_large" : "file_download_url_missing";
        return result;
      }
      const downloaded = await this.downloadFile(downloadUrl, maxTextFileBytes);
      result.content = {
        kind: "text",
        text: downloaded.bytes.toString("utf8"),
        variant: "original",
      };
      return result;
    }

    result.contentUnavailableReason = "unsupported_binary_file_type";
    return result;
  }

  private async downloadFile(
    rawUrl: string,
    maxBytes: number,
  ): Promise<{ bytes: Buffer; mimetype: string }> {
    let current = new URL(rawUrl);
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      if (current.protocol !== "https:" || !isAllowedSlackFileHost(current.hostname)) {
        throw new SlackApiError("invalid_file_url", "Slack returned an unsupported file download URL");
      }
      const response = await fetch(current, {
        headers: { Authorization: `Bearer ${this.botToken}` },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new SlackApiError("file_download_failed", "Slack file redirect had no location");
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        throw new SlackApiError("file_download_failed", `Slack file download returned HTTP ${response.status}`);
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new SlackApiError("file_too_large", `Slack file exceeds the ${maxBytes} byte MCP limit`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) {
        throw new SlackApiError("file_too_large", `Slack file exceeds the ${maxBytes} byte MCP limit`);
      }
      const mimetype = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      return { bytes, mimetype: mimetype || "application/octet-stream" };
    }
    throw new SlackApiError("file_redirect_limit", "Slack file download exceeded the redirect limit");
  }

  async postMessage(input: {
    channelId: string;
    text: string;
    threadTs?: string;
    replyBroadcast: boolean;
    identityBlockId?: string;
    mrkdwn?: boolean;
  }): Promise<SlackPostResult> {
    const base = {
      channel: input.channelId,
      text: input.text,
      mrkdwn: input.mrkdwn ?? true,
      unfurl_links: false,
      unfurl_media: false,
      ...(input.identityBlockId ? {
        blocks: [{
          type: "section" as const,
          block_id: input.identityBlockId,
          text: input.mrkdwn === false ? { type: "plain_text" as const, text: input.text } : { type: "mrkdwn" as const, text: input.text },
        }],
      } : {}),
    };
    const response = await callSlack(() => {
      if (input.threadTs && input.replyBroadcast) {
        return this.client.chat.postMessage({
          ...base,
          thread_ts: input.threadTs,
          reply_broadcast: true,
        });
      }
      if (input.threadTs) {
        return this.client.chat.postMessage({ ...base, thread_ts: input.threadTs });
      }
      return this.client.chat.postMessage(base);
    });
    return {
      channelId: nonEmpty(response.channel, "channel"),
      messageTs: nonEmpty(response.ts, "ts"),
      ...(response.message?.thread_ts ? { threadTs: response.message.thread_ts } : {}),
    };
  }

  async setAgentSessionStatus(input: {
    channelId: string;
    threadTs: string;
    status: SlackAgentSessionStatus;
    initiatorUserId?: string;
    title?: string;
  }): Promise<SlackAgentSessionStatusResult> {
    const response = await callSlack(() =>
      this.client.apiCall("agents.sessions.setStatus", {
        channel_id: input.channelId,
        thread_ts: input.threadTs,
        status: input.status,
        ...(input.initiatorUserId ? { initiator_user_id: input.initiatorUserId } : {}),
        ...(input.title ? { title: input.title } : {}),
      }),
    );
    const payload = response as unknown as {
      status?: unknown;
      agent_status?: unknown;
      title?: unknown;
      warning?: unknown;
    };
    const sessionStatus = isAgentSessionStatus(payload.status) ? payload.status : input.status;
    const agentStatus = isAgentSessionStatus(payload.agent_status)
      ? payload.agent_status
      : input.status;
    return {
      status: sessionStatus,
      agentStatus,
      ...(typeof payload.title === "string" && payload.title ? { title: payload.title } : {}),
      ...(typeof payload.warning === "string" && payload.warning
        ? { warning: payload.warning }
        : {}),
    };
  }

  async addReaction(channelId: string, messageTs: string, emojiName: string): Promise<void> {
    try {
      await callSlack(() =>
        this.client.reactions.add({ channel: channelId, timestamp: messageTs, name: emojiName }),
      );
    } catch (error) {
      // The desired external state already exists, so repeated calls remain idempotent.
      if (error instanceof SlackApiError && error.errorCode === "already_reacted") return;
      throw error;
    }
  }
}
