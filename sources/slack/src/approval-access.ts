import type { SlackWorkspaceRegistry } from "./workspace-registry.js";
import { createHmac } from "node:crypto";
import { z } from "zod";

const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const thread = /^[0-9]{10}\.[0-9]{6}$/;
export class SlackApprovalAccessError extends Error {
  constructor() { super("approval_access_unverified"); this.name = "SlackApprovalAccessError"; }
}
export interface SlackApprovalAccessTarget { channel_id: string; thread_ts: string }
export interface SlackApprovalAccessBinding {
  instance_id: string; workspace_id: string; alias: string; team_id: string; supervisor_user_id: string;
}
export interface SlackApprovalAccessObservation {
  transaction_id: string; phase: "create" | "delivery" | "decision" | "consume" | "execution";
  instance_id: string; workspace_id: string; alias: string; team_id: string; user_id: string;
  operation_kind: "slack.post_thread_reply.v1"; target: SlackApprovalAccessTarget;
  active: true; can_approve: true; target_visible: true; shared: false;
  observed_at: string; expires_at: string;
}
const signedSchema = z.strictObject({
  transaction_id: z.string().regex(identifier),
  phase: z.enum(["create", "delivery", "decision", "consume", "execution"]),
  instance_id: z.string().regex(identifier), workspace_id: z.string().regex(identifier),
  alias: z.string().regex(identifier), team_id: z.string().regex(identifier), user_id: z.string().regex(identifier),
  operation_kind: z.literal("slack.post_thread_reply.v1"),
  target: z.strictObject({ channel_id: z.string().regex(identifier), thread_ts: z.string().regex(thread) }),
  active: z.literal(true), can_approve: z.literal(true), target_visible: z.literal(true), shared: z.literal(false),
  observed_at: z.iso.datetime({ offset: false }), expires_at: z.iso.datetime({ offset: false }),
});
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Keychainから読み出した専用鍵で認証済み観測だけを署名する。 */
export function signSlackApprovalAccessObservation(observationInput: SlackApprovalAccessObservation,
  key: { version: number; secret: Uint8Array }) {
  try {
    const observation = signedSchema.parse(observationInput);
    if (!Number.isSafeInteger(key.version) || key.version < 1 || !(key.secret instanceof Uint8Array) || key.secret.byteLength !== 32) throw Error();
    const mac = createHmac("sha256", key.secret).update("dona.approval.access.v1\0")
      .update(canonical({ key_version: key.version, observation })).digest("hex");
    return { key_version: key.version, observation, mac };
  } catch { throw new SlackApprovalAccessError(); }
}
/** trusted adapter側のfresh access観測。Dispatcherへ渡す際は認証済みの
 * transaction/phase/operation/target bindingを別途付ける。raw MCP入力は不可。 */
export class SlackApprovalAccessProbe {
  constructor(private readonly registry: Pick<SlackWorkspaceRegistry, "get" | "getByTeamId">,
    private readonly now: () => Date = () => new Date()) {}
  async observe(binding: SlackApprovalAccessBinding, target: SlackApprovalAccessTarget,
    transactionId: string, phase: SlackApprovalAccessObservation["phase"]): Promise<SlackApprovalAccessObservation> {
    try {
      if (![binding.instance_id, binding.workspace_id, binding.alias, binding.team_id,
        binding.supervisor_user_id, target.channel_id, transactionId].every(value => identifier.test(value))
        || !thread.test(target.thread_ts) || !["create", "delivery", "decision", "consume", "execution"].includes(phase)) throw Error();
      const connection = this.registry.get(binding.alias);
      const byTeam = this.registry.getByTeamId(binding.team_id);
      if (connection !== byTeam || connection.teamId !== binding.team_id || binding.workspace_id !== binding.team_id) throw Error();
      const [user, channel] = await Promise.all([
        connection.client.getUser(binding.supervisor_user_id),
        connection.client.getChannel(target.channel_id),
      ]);
      if (user.id !== binding.supervisor_user_id || user.teamId !== binding.team_id || user.deletionKnown !== true || user.isDeleted || user.isBot
        || user.isAppUser || user.isStranger !== false || user.isSuspended !== false
        || channel.id !== target.channel_id || channel.isArchived || channel.isShared
        || (channel.isIm !== true && (channel.sharingKnown !== true || !channel.isMember))) throw Error();
      const members = connection.client.getChannelMembers;
      if (typeof members !== "function") throw Error();
      let cursor: string | undefined;
      const seen = new Set<string>();
      let found = false;
      for (let page = 0; page < 20; page++) {
        const result = await members.call(connection.client, channel.id, 1000, cursor);
        if (!Array.isArray(result.members) || result.members.some(value => typeof value !== "string" || !identifier.test(value))) throw Error();
        if (result.members.includes(user.id)) { found = true; break; }
        if (!result.nextCursor) break;
        if (seen.has(result.nextCursor)) throw Error();
        seen.add(result.nextCursor); cursor = result.nextCursor;
      }
      if (!found) throw Error();
      const at = this.now();
      if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw Error();
      return { transaction_id: transactionId, phase, instance_id: binding.instance_id,
        workspace_id: binding.workspace_id, alias: binding.alias, team_id: binding.team_id,
        user_id: binding.supervisor_user_id, operation_kind: "slack.post_thread_reply.v1", target: { ...target },
        active: true, can_approve: true,
        target_visible: true, shared: false, observed_at: at.toISOString(),
        expires_at: new Date(at.getTime() + 30_000).toISOString() };
    } catch { throw new SlackApprovalAccessError(); }
  }
}
