import http from "node:http";

export class UpdaterClientError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UpdaterClientError";
  }
}

function structuredError(input: unknown): { code: string; message: string } | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const body = input as Record<string, unknown>;
  if (body.schema_version !== 1 || !body.error || typeof body.error !== "object" || Array.isArray(body.error)) {
    return undefined;
  }
  const error = body.error as Record<string, unknown>;
  if (typeof error.code !== "string" || !/^[a-z0-9_]{1,128}$/.test(error.code) ||
    typeof error.message !== "string" || error.message.length > 2_000) {
    return undefined;
  }
  return { code: error.code, message: error.message };
}

export class UpdaterClient {
  constructor(private readonly socketPath: string, private readonly timeoutMs = 10_000) {}

  plan(input: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/plan", input);
  }

  apply(input: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/apply", input);
  }

  status(requestId?: string): Promise<Record<string, unknown>> {
    return this.request("GET", requestId ? `/v1/status?request_id=${encodeURIComponent(requestId)}` : "/v1/status");
  }

  cancel(input: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/cancel", input);
  }

  private request(method: "GET" | "POST", route: string, body?: unknown): Promise<Record<string, unknown>> {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = http.request({
        socketPath: this.socketPath,
        method,
        path: route,
        headers: encoded ? { "content-type": "application/json", "content-length": encoded.length } : undefined,
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= 1_048_576) chunks.push(chunk);
        });
        response.on("end", () => {
          if (size > 1_048_576) return void reject(new Error("Updater response exceeded 1 MiB"));
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            return void reject(new Error("Updater returned invalid JSON"));
          }
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            const error = structuredError(parsed);
            if (error && (response.statusCode ?? 0) >= 400 && (response.statusCode ?? 0) < 600) {
              return void reject(new UpdaterClientError(response.statusCode!, error.code, error.message));
            }
            return void reject(new Error("Updater returned an incompatible error response"));
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
            (parsed as Record<string, unknown>).schema_version !== 1) {
            return void reject(new Error("Updater response protocol version is incompatible"));
          }
          resolve(parsed as Record<string, unknown>);
        });
      });
      request.once("error", reject);
      request.setTimeout(this.timeoutMs, () => request.destroy(new Error("Updater request acceptance unknown after timeout")));
      request.end(encoded);
    });
  }
}
