import http from "node:http";

export class DispatcherClientError extends Error {
  constructor(readonly statusCode: number | undefined, message: string, readonly body?: unknown) {
    super(message);
    this.name = "DispatcherClientError";
  }
}

export class DispatcherApiClient {
  constructor(private readonly socketPath: string, private readonly timeoutMs = 10_000) {}

  createJob(input: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/jobs", input);
  }

  getJob(jobId: string, sourceEventId?: string): Promise<Record<string, unknown>> {
    const query = sourceEventId === undefined ? "" : `?${new URLSearchParams({ source_event_id: sourceEventId })}`;
    return this.request("GET", `/v1/jobs/${encodeURIComponent(jobId)}${query}`);
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
    return this.request("GET", `/v1/events/${encodeURIComponent(sourceEventId)}/jobs${suffix}`);
  }

  listThreadJobs(workspaceId: string, channelId: string, threadTs: string): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({
      workspace_id: workspaceId,
      channel_id: channelId,
      thread_ts: threadTs,
    });
    return this.request("GET", `/v1/jobs?${query}`);
  }

  steerJob(jobId: string, input: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/jobs/${encodeURIComponent(jobId)}/steer`, input);
  }

  cancelJob(jobId: string, input: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/jobs/${encodeURIComponent(jobId)}/cancel`, input);
  }

  planSelfUpdate(input: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/self-update/plan", input);
  }

  applySelfUpdate(input: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/self-update/apply", input);
  }

  getSelfUpdateStatus(requestId?: string): Promise<Record<string, unknown>> {
    return this.request("GET", requestId ? `/v1/self-update/status?request_id=${encodeURIComponent(requestId)}` : "/v1/self-update/status");
  }

  cancelSelfUpdate(input: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/self-update/cancel", input);
  }

  private request(method: string, route: string, body?: unknown): Promise<Record<string, unknown>> {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = http.request({
        socketPath: this.socketPath,
        method,
        path: route,
        headers: encoded ? {
          "content-type": "application/json",
          "content-length": encoded.length,
        } : undefined,
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
