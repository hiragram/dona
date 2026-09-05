import type { SlackWorkspaceRegistry } from "./workspace-registry.js";

const idPattern = /^[A-Z][A-Z0-9]{1,31}$/;
const timestampPattern = /^\d{10,}\.?\d*$/;

export interface JobProgressRequest {
  schema_version: 1;
  progress_id: string;
  delivery_token: string;
}

export function parseJobProgressRequest(input: unknown): JobProgressRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("progress must be an object");
  const value = input as Record<string, unknown>;
  const keys = ["schema_version", "progress_id", "delivery_token"];
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value)) ||
    value.schema_version !== 1 || typeof value.progress_id !== "string" || !/^job_[0-9a-z]+:\d+$/.test(value.progress_id) ||
    typeof value.delivery_token !== "string" || !/^[0-9a-f]{64}$/.test(value.delivery_token)) {
    throw new Error("progress is invalid");
  }
  return value as unknown as JobProgressRequest;
}

export class SlackJobProgressReporter {
  constructor(private readonly registry: SlackWorkspaceRegistry, private readonly resolve: (progressId:string,deliveryToken:string)=>Promise<unknown>) {}

  async deliver(input: JobProgressRequest): Promise<{ progress_id: string }> {
    let resolved: ReturnType<typeof parseResolvedProgress>;
    try { resolved = parseResolvedProgress(await this.resolve(input.progress_id,input.delivery_token)); }
    catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { definitelyUnsent:true, progressPermanent:true }); }
    let connection: ReturnType<SlackWorkspaceRegistry["getByTeamId"]>;
    try { connection = this.registry.getByTeamId(resolved.workspace_id); }
    catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { definitelyUnsent:true, progressPermanent:true }); }
    if (!connection.client.setAssistantThreadProgress) throw Object.assign(new Error("progress API is unavailable"), { definitelyUnsent:true, progressPermanent:true });
    await connection.client.setAssistantThreadProgress({
      channelId: resolved.channel_id,
      threadTs: resolved.thread_ts,
      status: resolved.status,
    });
    return { progress_id: input.progress_id };
  }
}

function parseResolvedProgress(input: unknown): { workspace_id:string; channel_id:string; thread_ts:string; status:string } {
  if (!input || typeof input !== "object") throw Object.assign(new Error("progress resolution failed"), { definitelyUnsent:true });
  const value = input as Record<string, unknown>;
  if (typeof value.workspace_id !== "string" || !idPattern.test(value.workspace_id) || typeof value.channel_id !== "string" ||
    !idPattern.test(value.channel_id) || typeof value.thread_ts !== "string" || !timestampPattern.test(value.thread_ts) ||
    typeof value.status !== "string" || value.status.length < 1 || value.status.length > 120 || /[\u0000-\u001f\u007f]/u.test(value.status))
    throw Object.assign(new Error("resolved progress is invalid"), { definitelyUnsent:true });
  return value as never;
}
