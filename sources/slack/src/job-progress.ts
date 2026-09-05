import type { SlackWorkspaceRegistry } from "./workspace-registry.js";

const idPattern = /^[A-Z][A-Z0-9]{1,31}$/;
const timestampPattern = /^\d{10,}\.?\d*$/;

export interface JobProgressRequest {
  schema_version: 1;
  progress_id: string;
  workspace_id: string;
  channel_id: string;
  thread_ts: string;
  status: string;
}

export function parseJobProgressRequest(input: unknown): JobProgressRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("progress must be an object");
  const value = input as Record<string, unknown>;
  const keys = ["schema_version", "progress_id", "workspace_id", "channel_id", "thread_ts", "status"];
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value)) ||
    value.schema_version !== 1 || typeof value.progress_id !== "string" ||
    !/^job_[0-9a-z]+:\d+$/.test(value.progress_id) || typeof value.workspace_id !== "string" ||
    !idPattern.test(value.workspace_id) || typeof value.channel_id !== "string" ||
    !idPattern.test(value.channel_id) || typeof value.thread_ts !== "string" ||
    !timestampPattern.test(value.thread_ts) || typeof value.status !== "string" ||
    value.status.length < 1 || value.status.length > 120 || /[\u0000-\u001f\u007f]/u.test(value.status)) {
    throw new Error("progress is invalid");
  }
  return value as unknown as JobProgressRequest;
}

export class SlackJobProgressReporter {
  constructor(private readonly registry: SlackWorkspaceRegistry) {}

  async deliver(input: JobProgressRequest): Promise<{ progress_id: string }> {
    const connection = this.registry.getByTeamId(input.workspace_id);
    if (!connection.client.setAssistantThreadProgress) throw new Error("progress API is unavailable");
    await connection.client.setAssistantThreadProgress({
      channelId: input.channel_id,
      threadTs: input.thread_ts,
      status: input.status,
    });
    return { progress_id: input.progress_id };
  }
}
