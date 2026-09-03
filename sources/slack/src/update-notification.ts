import type { SlackAgentSessionStatus, SlackApiClient, SlackMessageMetadata } from "./slack-api.js";
import type { SlackWorkspaceRegistry } from "./workspace-registry.js";

const notificationIdPattern = /^update:upd_[0-9a-hjkmnp-tv-z]{26}:terminal:\d+$/;
const idPattern = /^[A-Z][A-Z0-9]{1,31}$/;
const timestampPattern = /^\d{10,}\.?\d*$/;

export interface UpdateNotificationRequest {
  schema_version: 1;
  notification_id: string;
  request_id: string;
  terminal_fence: number;
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
      "metadata_not_persisted" | "ambiguous_update_notification",
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
    "channel_id", "thread_ts", "text", "desired_session_status",
  ];
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value))) {
    throw new Error("notification fields do not match schema");
  }
  if (value.schema_version !== 1 || typeof value.notification_id !== "string" ||
    !notificationIdPattern.test(value.notification_id) || typeof value.request_id !== "string" ||
    !/^upd_[0-9a-hjkmnp-tv-z]{26}$/.test(value.request_id) ||
    !Number.isSafeInteger(value.terminal_fence) || (value.terminal_fence as number) < 1 ||
    typeof value.workspace_id !== "string" || !idPattern.test(value.workspace_id) ||
    typeof value.channel_id !== "string" || !idPattern.test(value.channel_id) ||
    typeof value.thread_ts !== "string" || !timestampPattern.test(value.thread_ts) ||
    typeof value.text !== "string" || value.text.length < 1 || value.text.length > 12_000 ||
    (value.desired_session_status !== "active" && value.desired_session_status !== "suspended")) {
    throw new Error("notification is invalid");
  }
  if (value.notification_id !== `update:${value.request_id}:terminal:${value.terminal_fence}`) {
    throw new Error("notification identity does not match request and fence");
  }
  return value as unknown as UpdateNotificationRequest;
}

function metadata(input: UpdateNotificationRequest): SlackMessageMetadata {
  return {
    eventType: "dona.update_notification",
    eventPayload: {
      notification_id: input.notification_id,
      request_id: input.request_id,
      terminal_fence: input.terminal_fence,
    },
  };
}

function metadataMatches(actual: SlackMessageMetadata | undefined, expected: SlackMessageMetadata): boolean {
  if (!actual || actual.eventType !== expected.eventType) return false;
  const actualEntries = Object.entries(actual.eventPayload).sort(([left], [right]) => left.localeCompare(right));
  const expectedEntries = Object.entries(expected.eventPayload).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}

async function existingMessage(
  client: SlackApiClient,
  input: UpdateNotificationRequest,
): Promise<string | undefined> {
  let cursor: string | undefined;
  let found: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const thread = await client.getThread(input.channel_id, input.thread_ts, 200, cursor);
    const matching = thread.messages.filter((message) =>
      message.metadata?.eventType === "dona.update_notification" &&
      message.metadata.eventPayload.notification_id === input.notification_id,
    );
    if (matching.some((message) => !metadataMatches(message.metadata, metadata(input)))) {
      throw new UpdateNotificationPermanentError(
        "conflicting_update_notification",
        "an update notification with conflicting identity metadata already exists",
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
      throw new Error("Slack thread pagination ended before all metadata could be checked");
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
    let messageTs = await existingMessage(connection.client, input);
    let postStatus: "created" | "existing" = "existing";
    let postedMetadata: SlackMessageMetadata | undefined;
    if (!messageTs) {
      const expectedMetadata = metadata(input);
      postStatus = "created";
      try {
        const posted = await connection.client.postMessage({
          channelId: input.channel_id,
          text: input.text,
          threadTs: input.thread_ts,
          replyBroadcast: false,
          metadata: expectedMetadata,
        });
        messageTs = posted.messageTs;
        postedMetadata = posted.metadata;
      } catch {
        try {
          messageTs = await existingMessage(connection.client, input);
        } catch (error) {
          if (error instanceof UpdateNotificationPermanentError) throw error;
          throw new UpdateNotificationPermanentError(
            "ambiguous_update_notification",
            "Slack post acceptance and identity metadata could not be reconciled",
          );
        }
        if (!messageTs) {
          throw new UpdateNotificationPermanentError(
            "ambiguous_update_notification",
            "Slack post acceptance is unknown and exact identity metadata was not observed",
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
    if (postStatus === "created" && !metadataMatches(postedMetadata, metadata(input))) {
      const observedMessageTs = await existingMessage(connection.client, input);
      if (observedMessageTs !== messageTs) {
        throw new UpdateNotificationPermanentError(
          "metadata_not_persisted",
          "Slack posted the notification without the exact registered identity metadata",
          result,
        );
      }
    }
    return result;
  }
}
