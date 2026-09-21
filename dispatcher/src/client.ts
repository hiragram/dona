import http from "node:http";
import fs from "node:fs/promises";

export class DispatcherClientError extends Error {
  constructor(readonly statusCode: number | undefined, message: string, readonly body?: unknown) {
    super(message);
    this.name = "DispatcherClientError";
  }
}

export class DispatcherApiClient {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 10_000,
    private readonly agentCredentialPath?: string,
  ) {}

  createJob(input: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/jobs", input, sourceEventId(input));
  }

  delegateScheduledWork(eventId: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/scheduled-jobs/${encodeURIComponent(eventId)}/delegate`, {}, eventId);
  }

  getJob(jobId: string, sourceEventId?: string): Promise<Record<string, unknown>> {
    const query = sourceEventId === undefined ? "" : `?${new URLSearchParams({ source_event_id: sourceEventId })}`;
    return this.request("GET", `/v1/jobs/${encodeURIComponent(jobId)}${query}`, undefined, sourceEventId);
  }

  listEventJobs(
    sourceEventId: string,
    jobKey?: string,
    canonicalPayloadSha256?: string,
  ): Promise<Record<string, unknown>> {
    const query = new URLSearchParams();
    if (jobKey !== undefined) query.set("job_key", jobKey);
    if (canonicalPayloadSha256 !== undefined) query.set("canonical_payload_sha256", canonicalPayloadSha256);
    const suffix = query.size === 0 ? "" : `?${query}`;
    return this.request("GET", `/v1/events/${encodeURIComponent(sourceEventId)}/jobs${suffix}`, undefined, sourceEventId, true);
  }

  authorizeJobNotification(eventId:string,receipt?:string):Promise<Record<string,unknown>> {
    return this.request("POST",`/v1/job-notifications/${encodeURIComponent(eventId)}/authorize`,receipt?{receipt}:{},eventId);
  }
  recordScheduleJobAccess(eventId:string,receipt:string):Promise<Record<string,unknown>> {
    return this.request("POST",`/v1/scheduled-jobs/${encodeURIComponent(eventId)}/access`,{receipt},eventId);
  }

  listThreadJobs(sourceEventId: string, workspaceId: string, channelId: string, threadTs: string): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({
      workspace_id: workspaceId,
      channel_id: channelId,
      thread_ts: threadTs,
    });
    return this.request("GET", `/v1/jobs?${query}`, undefined, sourceEventId);
  }

  listOwnerJobs(sourceEventId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/jobs?${new URLSearchParams({ source_event_id: sourceEventId })}`, undefined, sourceEventId);
  }

  listHumanWaits(sourceEventId:string,limit:number,cursor?:string):Promise<Record<string,unknown>> {
    const query=new URLSearchParams({limit:String(limit),...(cursor?{cursor}:{})});
    return this.request("GET",`/v1/human-waits?${query}`,undefined,sourceEventId);
  }

  presentHumanWaits(sourceEventId:string,limit:number,cursor?:string):Promise<Record<string,unknown>> {
    const query=new URLSearchParams({limit:String(limit),...(cursor?{cursor}:{})});
    return this.request("GET",`/v1/human-waits/presentation?${query}`,undefined,sourceEventId);
  }

  resolveHumanWaitOrigin(sourceEventId:string,originRef:string):Promise<Record<string,unknown>> {
    return this.request("GET",`/v1/human-waits/origins/${encodeURIComponent(originRef)}`,undefined,sourceEventId);
  }

  steerJob(jobId: string, input: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/jobs/${encodeURIComponent(jobId)}/steer`, input, sourceEventId(input));
  }

  cancelJob(jobId: string, input: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/jobs/${encodeURIComponent(jobId)}/cancel`, input, sourceEventId(input));
  }
  previewSchedule(input: unknown) { return this.request("POST", "/v1/schedules/preview", input, sourceEventId(input)); }
  createSchedule(input: unknown) { return this.request("POST", "/v1/schedules", input, sourceEventId(input)); }
  getSchedule(scheduleId: string, sourceEventId: string) { return this.request("GET", `/v1/schedules/${encodeURIComponent(scheduleId)}?source_event_id=${encodeURIComponent(sourceEventId)}`, undefined, sourceEventId); }
  listSchedules(sourceEventId: string, limit: number, cursor?: string) { const q = new URLSearchParams({ source_event_id: sourceEventId, limit: String(limit), ...(cursor ? { cursor } : {}) }); return this.request("GET", `/v1/schedules?${q}`, undefined, sourceEventId); }
  updateSchedule(scheduleId: string, input: unknown) { return this.request("PATCH", `/v1/schedules/${encodeURIComponent(scheduleId)}`, input, sourceEventId(input)); }
  transitionSchedule(scheduleId: string, action: "pause"|"resume"|"cancel", input: unknown) { return this.request("POST", `/v1/schedules/${encodeURIComponent(scheduleId)}/${action}`, input, sourceEventId(input)); }
  getScheduleHistory(scheduleId: string, sourceEventId: string, limit: number, cursor?: string) { const q = new URLSearchParams({ source_event_id: sourceEventId, limit: String(limit), ...(cursor ? { cursor } : {}) }); return this.request("GET", `/v1/schedules/${encodeURIComponent(scheduleId)}/runs?${q}`, undefined, sourceEventId); }

  planSelfUpdate(input: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/self-update/plan", input, sourceEventId(input));
  }

  applySelfUpdate(input: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/self-update/apply", input, sourceEventId(input));
  }

  getSelfUpdateStatus(sourceEventId: string, requestId?: string): Promise<Record<string, unknown>> {
    return this.request("GET", requestId ? `/v1/self-update/status?request_id=${encodeURIComponent(requestId)}` : "/v1/self-update/status", undefined, sourceEventId);
  }

  cancelSelfUpdate(input: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/self-update/cancel", input, sourceEventId(input));
  }

  private async request(
    method: string,
    route: string,
    body?: unknown,
    claimedEventId?: string,
    allowRelatedTarget = false,
  ): Promise<Record<string, unknown>> {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    let agentHeaders: Record<string, string> = {};
    if (this.agentCredentialPath) {
      let raw: {token?:unknown;event_id?:unknown};
      try { raw = JSON.parse(await fs.readFile(this.agentCredentialPath, "utf8")) as {token?:unknown;event_id?:unknown}; }
      catch { throw new DispatcherClientError(403, "Agent context is unavailable"); }
      if (typeof raw.token !== "string" || typeof raw.event_id !== "string") throw new DispatcherClientError(undefined, "Agent context is unavailable");
      if (!claimedEventId || (!allowRelatedTarget && claimedEventId !== raw.event_id)) {
        throw new DispatcherClientError(403, "Agent event context mismatch");
      }
      agentHeaders = { "x-dona-agent-token": raw.token, "x-dona-source-event-id": raw.event_id };
    }
    return new Promise((resolve, reject) => {
      const request = http.request({
        socketPath: this.socketPath,
        method,
        path: route,
        headers: {
          ...agentHeaders,
          ...(encoded ? {
          "content-type": "application/json",
          "content-length": encoded.length,
          } : {}),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= 1_048_576) chunks.push(chunk);
        });
        response.on("end", () => {
          if (size > 1_048_576) {
            reject(new DispatcherClientError(response.statusCode, "Dispatcher response exceeded 1 MiB"));
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            reject(new DispatcherClientError(response.statusCode, "Dispatcher returned invalid JSON"));
            return;
          }
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            const message = typeof parsed === "object" && parsed !== null
              ? JSON.stringify(parsed)
              : "Dispatcher request failed";
            reject(new DispatcherClientError(response.statusCode, message, parsed));
            return;
          }
          resolve(parsed as Record<string, unknown>);
        });
      });
      request.once("error", (error) => reject(new DispatcherClientError(undefined, error.message)));
      request.setTimeout(this.timeoutMs, () => {
        request.destroy(new Error(`Dispatcher request timed out after ${this.timeoutMs}ms`));
      });
      request.end(encoded);
    });
  }
}

function sourceEventId(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>).source_event_id;
  return typeof value === "string" ? value : undefined;
}
