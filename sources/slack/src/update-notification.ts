import type { SlackAgentSessionStatus, SlackApiClient, SlackThreadMessage } from "./slack-api.js";
import type { SlackWorkspaceRegistry } from "./workspace-registry.js";

const notificationIdPattern = /^update:upd_[0-9a-hjkmnp-tv-z]{26}:terminal:\d+$/;
const idPattern = /^[A-Z][A-Z0-9]{1,31}$/;
const timestampPattern = /^\d{10,}\.?\d*$/;

export interface UpdateNotificationRequest {
  schema_version: 1;
  notification_id: string;
  request_id: string;
  terminal_fence: number;
  terminal_status?: "succeeded" | "failed" | "rolled_back" | "needs_review" | "cancelled";
  workspace_id: string;
  channel_id: string;
  thread_ts: string;
  text: string;
  desired_session_status: "active" | "suspended";
}

export interface UpdateNotificationResult {
  notification_id: string;
  workspace_id: string;
  channel_id: string;
  thread_ts: string;
  message_ts: string;
  post_status: "created" | "existing";
  session_status: SlackAgentSessionStatus;
}

export interface UpdateNotificationPort {
  deliver(input: UpdateNotificationRequest): Promise<UpdateNotificationResult>;
}

export class UpdateNotificationPermanentError extends Error {
  constructor(
    readonly code: "unknown_workspace" | "duplicate_update_notification" | "conflicting_update_notification" |
      "identity_block_not_persisted" | "ambiguous_update_notification",
    message: string,
    readonly receipt?: UpdateNotificationResult,
  ) {
    super(message);
    this.name = "UpdateNotificationPermanentError";
  }
}

function exactObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("notification must be an object");
  return input as Record<string, unknown>;
}

export function parseUpdateNotificationRequest(input: unknown): UpdateNotificationRequest {
  const value = exactObject(input);
  const keys = [
    "schema_version", "notification_id", "request_id", "terminal_fence", "workspace_id",
    "channel_id", "thread_ts", "text", "desired_session_status", "terminal_status",
  ];
  const requiredKeys = keys.filter((key) => key !== "terminal_status");
  if (Object.keys(value).some((key) => !keys.includes(key)) || requiredKeys.some((key) => !(key in value))) {
    throw new Error("notification fields do not match schema");
  }
  if (value.schema_version !== 1 || typeof value.notification_id !== "string" ||
    !notificationIdPattern.test(value.notification_id) || typeof value.request_id !== "string" ||
    !/^upd_[0-9a-hjkmnp-tv-z]{26}$/.test(value.request_id) ||
    !Number.isSafeInteger(value.terminal_fence) || (value.terminal_fence as number) < 0 ||
    (value.terminal_status !== undefined && ![
      "succeeded", "failed", "rolled_back", "needs_review", "cancelled",
    ].includes(value.terminal_status as string)) ||
    typeof value.workspace_id !== "string" || !idPattern.test(value.workspace_id) ||
    typeof value.channel_id !== "string" || !idPattern.test(value.channel_id) ||
    typeof value.thread_ts !== "string" || !timestampPattern.test(value.thread_ts) ||
    typeof value.text !== "string" || value.text.length < 1 || value.text.length > 3_000 ||
    (value.desired_session_status !== "active" && value.desired_session_status !== "suspended")) {
    throw new Error("notification is invalid");
  }
  if (value.notification_id !== `update:${value.request_id}:terminal:${value.terminal_fence}`) {
    throw new Error("notification identity does not match request and fence");
  }
  if (value.terminal_fence === 0 && (
    value.terminal_status !== "cancelled" || value.desired_session_status !== "active"
  )) {
    throw new Error("terminal fence 0 is reserved for an unclaimed cancellation");
  }
  return value as unknown as UpdateNotificationRequest;
}

function identityBlockId(input: UpdateNotificationRequest): string {
  return `dona_update_notification:${input.notification_id}`;
}

function authoredByReporter(message: SlackThreadMessage, botId: string | undefined, botUserId: string | undefined): boolean {
  return (botId !== undefined && message.botId === botId) ||
    (botUserId !== undefined && message.userId === botUserId);
}

async function existingMessage(
  client: SlackApiClient,
  input: UpdateNotificationRequest,
  botId: string | undefined,
  botUserId: string | undefined,
): Promise<string | undefined> {
  if (!botId && !botUserId) {
    throw new UpdateNotificationPermanentError(
      "ambiguous_update_notification",
      "Slack bot identity is unavailable for update notification reconciliation",
    );
  }
  let cursor: string | undefined;
  let found: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const thread = await client.getThread(input.channel_id, input.thread_ts, 200, cursor);
    const matching = thread.messages.filter((message) =>
      message.blockIds.includes(identityBlockId(input)),
    );
    if (matching.some((message) => !authoredByReporter(message, botId, botUserId))) {
      throw new UpdateNotificationPermanentError(
        "conflicting_update_notification",
        "an update notification identity block exists on a message from another author",
      );
    }
    if (matching.length > 1 || (found !== undefined && matching.length === 1)) {
      throw new UpdateNotificationPermanentError(
        "duplicate_update_notification",
        "duplicate update notifications already exist",
      );
    }
    if (matching[0]) found = matching[0].ts;
    if (thread.hasMore && !thread.nextCursor) {
      throw new Error("Slack thread pagination ended before all identity blocks could be checked");
    }
    cursor = thread.nextCursor;
    if (cursor && seenCursors.has(cursor)) throw new Error("Slack thread pagination cursor repeated");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return found;
}

export class SlackUpdateNotificationReporter implements UpdateNotificationPort {
  constructor(private readonly registry: SlackWorkspaceRegistry) {}

  async deliver(input: UpdateNotificationRequest): Promise<UpdateNotificationResult> {
    const connection = (() => {
      try {
        return this.registry.getByTeamId(input.workspace_id);
      } catch {
        throw new UpdateNotificationPermanentError(
          "unknown_workspace",
          `Unknown Slack workspace ID: ${input.workspace_id}`,
        );
      }
    })();
    let messageTs = await existingMessage(connection.client, input, connection.botId, connection.botUserId);
    let postStatus: "created" | "existing" = "existing";
    if (!messageTs) {
      postStatus = "created";
      try {
        const posted = await connection.client.postMessage({
          channelId: input.channel_id,
          text: input.text,
          threadTs: input.thread_ts,
          replyBroadcast: false,
          identityBlockId: identityBlockId(input),
        });
        messageTs = posted.messageTs;
      } catch {
        try {
          messageTs = await existingMessage(connection.client, input, connection.botId, connection.botUserId);
        } catch (error) {
          if (error instanceof UpdateNotificationPermanentError) throw error;
          throw new UpdateNotificationPermanentError(
            "ambiguous_update_notification",
            "Slack post acceptance and identity block could not be reconciled",
          );
        }
        if (!messageTs) {
          throw new UpdateNotificationPermanentError(
            "ambiguous_update_notification",
            "Slack post acceptance is unknown and the exact identity block was not observed",
          );
        }
      }
    }
    const session = await connection.client.setAgentSessionStatus({
      channelId: input.channel_id,
      threadTs: input.thread_ts,
      status: input.desired_session_status,
    });
    if (session.status !== input.desired_session_status || session.agentStatus !== input.desired_session_status) {
      throw new Error("Slack Agent Session did not reach the requested status");
    }
    const result: UpdateNotificationResult = {
      notification_id: input.notification_id,
      workspace_id: connection.teamId,
      channel_id: input.channel_id,
      thread_ts: input.thread_ts,
      message_ts: messageTs,
      post_status: postStatus,
      session_status: session.status,
    };
    if (postStatus === "created") {
      const observedMessageTs = await existingMessage(
        connection.client,
        input,
        connection.botId,
        connection.botUserId,
      );
      if (observedMessageTs !== messageTs) {
        throw new UpdateNotificationPermanentError(
          "identity_block_not_persisted",
          "Slack posted the notification without the exact identity block",
          result,
        );
      }
    }
    return result;
  }
}
