import { z } from "zod";

import { SlackApiError } from "./slack-api.js";
import type { SlackWorkspaceConnection, SlackWorkspaceRegistry } from "./workspace-registry.js";

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
  expires_at: z.string().datetime({ offset: false }),
  misfire_at: z.string().datetime({ offset: false }),
  target,
  text: z.string().min(1).refine((value) => [...value].length <= 2_000),
});
export type SlackReminderCommand = Readonly<z.infer<typeof command>>;
export type SlackReminderResult =
  | { outcome: "accepted"; receipt_id: string }
  | { outcome: "not_accepted"; code: string; retry_after_seconds: number }
  | { outcome: "authorization_unavailable"; code: string; retry_after_seconds: number }
  | { outcome: "rejected"; code: string }
  | { outcome: "revoked"; code: string }
  | { outcome: "misfire"; code: string }
  | { outcome: "acceptance_unknown"; code: string };

const forbidden = /<!(?:channel|here|everyone)>|<!subteam\^[A-Z0-9]+(?:\|[^>]+)?>|<@[A-Z0-9]+>|(?:token|password|secret)\s*[:=]|https?:\/\/[^\s]*(?:token=|signature=|files\.slack\.com)|https?:\/\/hooks\.slack\.com\/services\/|xox[a-z]-|xapp-|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{8,}/i;
const revokedSlackErrors = new Set([
  "channel_not_found", "user_not_found", "missing_scope", "not_in_channel", "thread_not_found", "is_archived",
  "token_revoked", "account_inactive", "invalid_auth", "not_authed", "not_allowed_token_type",
  "restricted_action_read_only_channel", "restricted_action_thread_locked",
]);

export function parseSlackReminderCommand(value: unknown): SlackReminderCommand {
  const parsed = command.safeParse(value);
  if (!parsed.success || forbidden.test(parsed.data.text)) throw new Error("invalid_reminder_command");
  return parsed.data;
}

export class SlackReminderConnector {
  private readonly channelQueues = new Map<string, Promise<void>>();
  private readonly blockedUntil = new Map<string, number>();
  constructor(private readonly registry: SlackWorkspaceRegistry) {}

  private post(workspaceId: string, channelId: string, operation: () => ReturnType<SlackWorkspaceConnection["client"]["postMessage"]>): ReturnType<SlackWorkspaceConnection["client"]["postMessage"]> {
    const key = `${workspaceId}:${channelId}`;
    const previous = this.channelQueues.get(key) ?? Promise.resolve();
    const result = previous.then(async () => {
      const delay = Math.max(0, (this.blockedUntil.get(key) ?? 0) - Date.now());
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      try { return await operation(); }
      catch (error) {
        if (error instanceof SlackApiError && error.errorCode === "rate_limited") {
          this.blockedUntil.set(key, Date.now() + (error.retryAfterSeconds ?? 1) * 1_000);
        }
        throw error;
      }
    });
    const tail = result.then(() => undefined, () => undefined);
    this.channelQueues.set(key, tail);
    void tail.finally(() => { if (this.channelQueues.get(key) === tail) this.channelQueues.delete(key); });
    return result;
  }

  async deliver(value: unknown): Promise<SlackReminderResult> {
    let input: SlackReminderCommand;
    try { input = parseSlackReminderCommand(value); } catch { return { outcome: "rejected", code: "invalid_command" }; }
    let connection;
    try { connection = this.registry.getByTeamId(input.target.workspace_id); }
    catch { return { outcome: "revoked", code: "workspace_not_allowed" }; }
    let channel;
    try {
      channel = await connection.client.getChannel(input.target.channel_id);
      const owner = await connection.client.getUser(input.owner_id);
      if (owner.isDeleted || owner.isBot || owner.isAppUser || (!channel.isIm && (!connection.client.hasChannelMember ||
        !(await connection.client.hasChannelMember(input.target.channel_id, input.owner_id))))) return { outcome: "revoked", code: "owner_not_authorized" };
      if (channel.isMpim && (!connection.botUserId || !connection.client.hasChannelMember ||
        !(await connection.client.hasChannelMember(input.target.channel_id, connection.botUserId)))) return { outcome: "revoked", code: "target_not_allowed" };
    } catch (error) {
      const code = error instanceof SlackApiError ? error.errorCode : "authorization_check_failed";
      return revokedSlackErrors.has(code)
        ? { outcome: "revoked", code }
        : { outcome: "authorization_unavailable", code, retry_after_seconds: error instanceof SlackApiError ? error.retryAfterSeconds ?? 1 : 1 };
    }
    try {
      if (channel.isArchived || (!channel.isIm && !channel.isMpim && input.target.kind !== "owner_dm" && !channel.isMember)) return { outcome: "revoked", code: "target_not_allowed" };
      if (channel.isIm && channel.userId !== input.owner_id) return { outcome: "revoked", code: "target_not_allowed" };
      if (input.target.kind === "owner_dm" && (!channel.isIm || channel.userId !== input.owner_id)) return { outcome: "revoked", code: "target_not_allowed" };
      const current = Date.now();
      if (current >= Date.parse(input.expires_at)) return { outcome: "revoked", code: "authorization_expired" };
      if (current > Date.parse(input.misfire_at)) return { outcome: "misfire", code: "misfire" };
      const posted = await this.post(input.target.workspace_id, input.target.channel_id, () => connection.client.postMessage({
        channelId: input.target.channel_id,
        text: input.text,
        ...(input.target.kind === "thread" ? { threadTs: input.target.thread_ts } : {}),
        replyBroadcast: false,
        mrkdwn: false,
        parse: "none",
      }));
      if (posted.channelId !== input.target.channel_id) return { outcome: "acceptance_unknown", code: "receipt_mismatch" };
      return { outcome: "accepted", receipt_id: posted.messageTs };
    } catch (error) {
      if (!(error instanceof SlackApiError)) return { outcome: "acceptance_unknown", code: "unexpected_error" };
      if (revokedSlackErrors.has(error.errorCode)) return { outcome: "revoked", code: error.errorCode };
      if (error.errorCode === "rate_limited") return { outcome: "not_accepted", code: "rate_limited", retry_after_seconds: error.retryAfterSeconds ?? 1 };
      if (error.errorCode === "slack_server_error_before_send") return { outcome: "not_accepted", code: error.errorCode, retry_after_seconds: 1 };
      if (["slack_transport_error", "slack_http_error", "slack_api_error", "invalid_slack_response"].includes(error.errorCode)) {
        return { outcome: "acceptance_unknown", code: error.errorCode };
      }
      return { outcome: "rejected", code: error.errorCode };
    }
  }
}
