import { createHash } from "node:crypto";

import { SlackApiError, type SlackApiClient, type SlackChannel, type SlackUser } from "./slack-api.js";

export type SlackDestinationKind = "public_channel" | "private_channel" | "im" | "mpim";

export interface SlackCurrentAccessEvidence {
  version: 1;
  status: "current";
  event_id: string;
  workspace_id: string;
  principal_id: string;
  destination_id: string;
  destination_kind: SlackDestinationKind;
  visibility_revision: string;
  channel_id: string;
  user_id: string;
  channel_kind: "im" | "other";
  channel_user_id: string | null;
}

function destinationKind(channel: SlackChannel): SlackDestinationKind | undefined {
  if (channel.isIm) return "im";
  if (channel.isMpim) return "mpim";
  if (channel.id.startsWith("C") && !channel.isPrivate) return "public_channel";
  if (channel.id.startsWith("G") && channel.isPrivate) return "private_channel";
  return undefined;
}

function revision(user: SlackUser, channel: SlackChannel, member: boolean): string {
  return createHash("sha256").update(JSON.stringify({
    channel_id: channel.id,
    channel_kind: destinationKind(channel) ?? "unknown",
    channel_user_id: channel.userId ?? null,
    is_archived: channel.isArchived,
    is_shared: channel.isShared,
    member,
    user_deleted: user.isDeleted,
    user_id: user.id,
    user_revision: user.updatedAt ?? null,
  })).digest("hex");
}

function unavailable(): never {
  throw new SlackApiError("access_unavailable", "Current Slack access could not be verified");
}

export async function verifyCurrentSlackAccess(
  client: SlackApiClient,
  workspaceId: string,
  input: { eventId: string; channelId: string; userId: string },
): Promise<SlackCurrentAccessEvidence> {
  if (!client.hasChannelMember) unavailable();
  let user: SlackUser, channel: SlackChannel, member: boolean;
  try {
    [user, channel] = await Promise.all([client.getUser(input.userId), client.getChannel(input.channelId)]);
    member = await client.hasChannelMember(input.channelId, input.userId);
  } catch {
    unavailable();
  }
  const kind = destinationKind(channel!);
  if (user!.id !== input.userId || user!.teamId && user!.teamId !== workspaceId || user!.isDeleted || user!.isBot || user!.isAppUser
    || channel!.id !== input.channelId || channel!.isArchived || channel!.isShared || !kind || !member!) unavailable();
  if (kind === "im" && channel!.userId !== input.userId) unavailable();
  return {
    version: 1,
    status: "current",
    event_id: input.eventId,
    workspace_id: workspaceId,
    principal_id: input.userId,
    destination_id: input.channelId,
    destination_kind: kind,
    visibility_revision: revision(user!, channel!, member!),
    channel_id: input.channelId,
    user_id: input.userId,
    channel_kind: kind === "im" ? "im" : "other",
    channel_user_id: kind === "im" ? channel!.userId ?? null : null,
  };
}
