import { createHash } from "node:crypto";

import { SlackApiError, type SlackApiClient, type SlackChannel, type SlackUser } from "./slack-api.js";

export type SlackDestinationKind = "public_channel" | "private_channel" | "im" | "mpim";
export type SlackRequiredRole = "member" | "admin" | "owner";

export interface SlackCurrentAccessEvidence {
  version: 1;
  status: "current";
  observed_at: string;
  event_id: string;
  workspace_id: string;
  principal_id: string;
  destination_id: string;
  destination_kind: SlackDestinationKind;
  visibility_revision: string;
  required_role: SlackRequiredRole;
  channel_id: string;
  user_id: string;
  channel_kind: "im" | "other";
  channel_user_id: string | null;
}

function destinationKind(channel: SlackChannel): SlackDestinationKind | undefined {
  if (channel.isIm && channel.id.startsWith("D")) return "im";
  if (channel.isMpim && channel.id.startsWith("G")) return "mpim";
  if (!channel.isIm && !channel.isMpim && /^[CG]/.test(channel.id)) return channel.isPrivate ? "private_channel" : "public_channel";
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
    user_roles: [user.isAdmin === true, user.isOwner === true, user.isPrimaryOwner === true,
      user.isRestricted === true, user.isUltraRestricted === true],
  })).digest("hex");
}

function unavailable(): never {
  throw new SlackApiError("access_unavailable", "Current Slack access could not be verified");
}

export async function verifyCurrentSlackAccess(
  client: SlackApiClient,
  workspaceId: string,
  input: { eventId: string; channelId: string; userId: string; requiredRole?: SlackRequiredRole },
): Promise<SlackCurrentAccessEvidence> {
  if (!client.hasChannelMember) unavailable();
  const observedAt = new Date(Date.now());
  let user: SlackUser, channel: SlackChannel, member: boolean;
  try {
    [user, channel] = await Promise.all([client.getUser(input.userId), client.getChannel(input.channelId)]);
    member = await client.hasChannelMember(input.channelId, input.userId);
  } catch {
    unavailable();
  }
  const kind = destinationKind(channel!);
  const requiredRole=input.requiredRole??"member";
  const roleAllowed=requiredRole==="member"||requiredRole==="admin"&&(user!.isAdmin===true||user!.isOwner===true)
    ||requiredRole==="owner"&&user!.isOwner===true;
  if (user!.id !== input.userId || user!.teamId !== workspaceId || user!.stateKnown !== true || user!.isDeleted || user!.isBot || user!.isAppUser
    || channel!.id !== input.channelId || kind !== "im" && channel!.visibilityKnown !== true || channel!.isArchived || channel!.isShared || !kind || !member! || !roleAllowed
    || kind === "public_channel" && !channel!.isMember) unavailable();
  if (kind === "im" && channel!.userId !== input.userId) unavailable();
  return {
    version: 1,
    status: "current",
    observed_at: observedAt.toISOString(),
    event_id: input.eventId,
    workspace_id: workspaceId,
    principal_id: input.userId,
    destination_id: input.channelId,
    destination_kind: kind,
    visibility_revision: revision(user!, channel!, member!),
    required_role: requiredRole,
    channel_id: input.channelId,
    user_id: input.userId,
    channel_kind: kind === "im" ? "im" : "other",
    channel_user_id: kind === "im" ? channel!.userId ?? null : null,
  };
}
