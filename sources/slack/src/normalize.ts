export interface NormalizedSlackEvent {
  envelope: {
    schema_version: 1;
    source: "slack";
    external_event_id: string;
    type: "app_mention" | "message";
    occurred_at: string;
    subject: Record<string, unknown>;
    payload: Record<string, unknown>;
    reply_target: Record<string, unknown>;
    trace?: Record<string, unknown>;
  };
  usedReceivedAt: boolean;
}

interface SlackEventPayload {
  type?: unknown;
  event_id?: unknown;
  team_id?: unknown;
  event?: unknown;
  authorizations?: unknown;
}

const slackChannelTypes = new Set(["channel", "group", "im", "mpim"]);

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function slackTimestampToIso(value: unknown): string | undefined {
  const timestamp = nonEmptyString(value);
  if (!timestamp || !/^\d+(?:\.\d+)?$/.test(timestamp)) return undefined;
  const milliseconds = Number(timestamp) * 1_000;
  if (!Number.isFinite(milliseconds)) return undefined;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function ownBotUserIds(authorizations: unknown): Set<string> {
  if (!Array.isArray(authorizations)) return new Set();
  return new Set(
    authorizations
      .map((item) =>
        item !== null && typeof item === "object"
          ? nonEmptyString((item as Record<string, unknown>).user_id)
          : undefined,
      )
      .filter((value): value is string => value !== undefined),
  );
}

function normalizedFiles(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const file = item as Record<string, unknown>;
    const fileId = nonEmptyString(file.id);
    if (!fileId) return [];
    const normalized: Record<string, unknown> = { file_id: fileId };
    const name = nonEmptyString(file.name);
    const title = nonEmptyString(file.title);
    const mimetype = nonEmptyString(file.mimetype);
    const filetype = nonEmptyString(file.filetype);
    if (name) normalized.name = name;
    if (title) normalized.title = title;
    if (mimetype) normalized.mimetype = mimetype;
    if (filetype) normalized.filetype = filetype;
    if (typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0) {
      normalized.size_bytes = file.size;
    }
    return [normalized];
  });
}

export function normalizeSlackEvent(
  input: SlackEventPayload,
  receivedAt = new Date(),
  socketEnvelopeId?: string,
): NormalizedSlackEvent | null {
  if (input.type !== "event_callback") return null;
  const externalEventId = nonEmptyString(input.event_id);
  const workspaceId = nonEmptyString(input.team_id);
  if (!externalEventId || !workspaceId || input.event === null || typeof input.event !== "object") {
    throw new Error("Slack event_callback is missing event_id, team_id, or event");
  }

  const event = input.event as Record<string, unknown>;
  const type = nonEmptyString(event.type);
  if (type !== "app_mention" && type !== "message") return null;
  const subtype = nonEmptyString(event.subtype);
  if (event.bot_id !== undefined || (subtype !== undefined && subtype !== "file_share")) return null;
  const botUserIds = ownBotUserIds(input.authorizations);
  const actorId = nonEmptyString(event.user);
  if (actorId && botUserIds.has(actorId)) return null;

  const channelId = nonEmptyString(event.channel);
  const channelType = nonEmptyString(event.channel_type);
  const messageTs = nonEmptyString(event.ts);
  const threadTs = nonEmptyString(event.thread_ts) ?? messageTs;
  let text = typeof event.text === "string" ? event.text : "";
  if (
    type === "message" &&
    (channelType === "channel" || channelType === "group") &&
    [...botUserIds].some((botUserId) => text.includes(`<@${botUserId}>`))
  ) {
    return null;
  }
  if (type === "app_mention") {
    for (const botUserId of botUserIds) text = text.replaceAll(`<@${botUserId}>`, " ");
    text = text.trim();
  }
  if (!channelId || !threadTs) throw new Error("Slack event is missing channel or timestamp");

  const occurredAt = slackTimestampToIso(event.event_ts) ?? slackTimestampToIso(messageTs);
  const subject: Record<string, unknown> = {
    workspace_id: workspaceId,
    channel_id: channelId,
    thread_ts: threadTs,
  };
  if (actorId) subject.actor_id = actorId;
  if (channelType && slackChannelTypes.has(channelType)) subject.channel_type = channelType;
  const payload: Record<string, unknown> = { text };
  const eventTs = nonEmptyString(event.event_ts) ?? messageTs;
  if (eventTs) payload.event_ts = eventTs;
  const files = normalizedFiles(event.files);
  if (files.length > 0) payload.files = files;
  const envelope: NormalizedSlackEvent["envelope"] = {
    schema_version: 1,
    source: "slack",
    external_event_id: externalEventId,
    type,
    occurred_at: occurredAt ?? receivedAt.toISOString(),
    subject,
    payload,
    reply_target: {
      kind: "slack_thread",
      workspace_id: workspaceId,
      channel_id: channelId,
      thread_ts: threadTs,
    },
  };
  if (socketEnvelopeId) envelope.trace = { socket_envelope_id: socketEnvelopeId };
  return { envelope, usedReceivedAt: occurredAt === undefined };
}
