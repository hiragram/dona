import { z } from "zod";

import { SlackApiError } from "./slack-api.js";
import type { SlackWorkspaceRegistry } from "./workspace-registry.js";

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
const thread = z.string().regex(/^\d{1,20}\.\d{6}$/);
const target = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("channel"), workspace_id: id, channel_id: id }),
  z.strictObject({ kind: z.literal("thread"), workspace_id: id, channel_id: id, thread_ts: thread }),
  z.strictObject({ kind: z.literal("owner_dm"), workspace_id: id, channel_id: id, owner_id: id }),
]);
const command = z.strictObject({
  schema_version: z.literal(1),
  action: z.literal("slack.reminder.post"),
  outbox_id: id,
  run_id: id,
  idempotency_key: id,
  owner_id: id,
  target,
  text: z.string().min(1).refine((value) => [...value].length <= 2_000),
});
export type SlackReminderCommand = Readonly<z.infer<typeof command>>;
export type SlackReminderResult =
  | { outcome: "accepted"; receipt_id: string }
  | { outcome: "not_accepted"; code: string; retry_after_seconds: number }
  | { outcome: "rejected"; code: string }
  | { outcome: "acceptance_unknown"; code: string };

const forbidden = /<!(?:channel|here|everyone)>|<!subteam\^[A-Z0-9]+(?:\|[^>]+)?>|<@[A-Z0-9]+>|(?:token|password|secret)\s*[:=]|https?:\/\/[^\s]*(?:token=|signature=|files\.slack\.com)|https?:\/\/hooks\.slack\.com\/services\/|xox[a-z]-|xapp-|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{8,}/i;

export function parseSlackReminderCommand(value: unknown): SlackReminderCommand {
  const parsed = command.safeParse(value);
  if (!parsed.success || forbidden.test(parsed.data.text)) throw new Error("invalid_reminder_command");
  return parsed.data;
}

export class SlackReminderConnector {
  constructor(private readonly registry: SlackWorkspaceRegistry) {}

  async deliver(value: unknown): Promise<SlackReminderResult> {
    let input: SlackReminderCommand;
    try { input = parseSlackReminderCommand(value); } catch { return { outcome: "rejected", code: "invalid_command" }; }
    let connection;
    try { connection = this.registry.getByTeamId(input.target.workspace_id); }
    catch { return { outcome: "rejected", code: "workspace_not_allowed" }; }
    let channel;
    try {
      channel = await connection.client.getChannel(input.target.channel_id);
      const owner = await connection.client.getUser(input.owner_id);
      if (owner.isDeleted || owner.isBot || owner.isAppUser || !connection.client.hasChannelMember ||
        !(await connection.client.hasChannelMember(input.target.channel_id, input.owner_id))) return { outcome: "rejected", code: "owner_not_authorized" };
    } catch (error) {
      return { outcome: "not_accepted", code: error instanceof SlackApiError ? error.errorCode : "authorization_check_failed", retry_after_seconds: 1 };
    }
    try {
      if (channel.isArchived || !channel.isMember || channel.isShared) return { outcome: "rejected", code: "target_not_allowed" };
      if (input.target.kind === "owner_dm" && (!channel.isIm || channel.userId !== input.owner_id)) return { outcome: "rejected", code: "target_not_allowed" };
      const posted = await connection.client.postMessage({
        channelId: input.target.channel_id,
        text: input.text,
        ...(input.target.kind === "thread" ? { threadTs: input.target.thread_ts } : {}),
        replyBroadcast: false,
        identityBlockId: `dona_reminder_${input.run_id}`.slice(0, 255),
      });
      if (posted.channelId !== input.target.channel_id) return { outcome: "acceptance_unknown", code: "receipt_mismatch" };
      return { outcome: "accepted", receipt_id: posted.messageTs };
    } catch (error) {
      if (!(error instanceof SlackApiError)) return { outcome: "acceptance_unknown", code: "unexpected_error" };
      if (error.errorCode === "rate_limited") return { outcome: "not_accepted", code: "rate_limited", retry_after_seconds: error.retryAfterSeconds ?? 1 };
      if (error.errorCode === "slack_server_error_before_send") return { outcome: "not_accepted", code: error.errorCode, retry_after_seconds: 1 };
      if (["slack_transport_error", "slack_http_error", "slack_api_error", "invalid_slack_response"].includes(error.errorCode)) {
        return { outcome: "acceptance_unknown", code: error.errorCode };
      }
      return { outcome: "rejected", code: error.errorCode };
    }
  }
}
