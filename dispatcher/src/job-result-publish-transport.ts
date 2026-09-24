import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import { TextDecoder } from "node:util";

import type { JobRow } from "./types.js";
import { JobResultPublishCapabilities, JobResultPublishError, jobResultEnvelopeMaxBytes, type AuthorizedJobResultPublish } from "./job-result-publish.js";

export interface JobResultPublishSink {
  /** Must compare candidate.fence in the same durable transaction as Result creation. */
  commit(candidate: AuthorizedJobResultPublish): Promise<{ outcome: "created" | "reused" | "conflict" }>;
  /** Must compare the durable digest and may never mutate a terminal Result. */
  reconcile(candidate: AuthorizedJobResultPublish): Promise<{ outcome: "reused" | "conflict" }>;
}

function reply(response: ServerResponse, status: number, code: string): void {
  const encoded = Buffer.from(JSON.stringify({ schema_version: 1, code }));
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": encoded.length });
  response.end(encoded);
}

/** Separate UDS. It is never registered on the general Dispatcher API or MCP server. */
export class JobResultPublishServer {
  private server: http.Server | undefined;
  private readonly sockets = new Set<net.Socket>();
  constructor(
    private readonly socketPath: string,
    private readonly grants: JobResultPublishCapabilities,
    private readonly getJob: (jobId: string) => JobRow | undefined,
    private readonly sink: JobResultPublishSink,
    private readonly bodyTimeoutMs = 15_000,
  ) {}

  async start(): Promise<void> {
    await fs.mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.socketPath), 0o700);
    try {
      const prior = await fs.lstat(this.socketPath);
      if (!prior.isSocket()) throw new Error("publish_socket_path_occupied");
      const alive = await new Promise<boolean>(resolve => {
        const socket = net.createConnection(this.socketPath);
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(value);
        };
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.setTimeout(500, () => finish(false));
      });
      if (alive) throw new Error("publish_socket_owned");
      const current = await fs.lstat(this.socketPath);
      if (!current.isSocket() || current.ino !== prior.ino || current.dev !== prior.dev) throw new Error("publish_socket_changed");
      await fs.unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.server = http.createServer((request, response) => void this.handle(request, response));
    this.server.on("connection", socket => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => { this.server!.off("error", reject); resolve(); });
    });
    await fs.chmod(this.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    if (!this.server.listening) { this.server = undefined; return; }
    const closing = new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()));
    for (const socket of this.sockets) socket.destroy();
    await closing;
    this.server = undefined;
    await fs.unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || !["/v1/job-result-publish", "/v1/job-result-publish/renew"].includes(request.url ?? "")) {
      reply(response, 404, "not_found"); return;
    }
    const capability = request.headers["x-dona-job-result-capability"];
    const encodedSession = request.headers["x-dona-worker-session"];
    if (typeof capability !== "string" || typeof encodedSession !== "string") {
      reply(response, 403, "capability_invalid"); return;
    }
    try {
      // JSON before base64url preserves every persisted 512-character session,
      // including Unicode, control characters and lone surrogates.
      if (!/^[A-Za-z0-9_-]{1,4099}$/.test(encodedSession)) throw new JobResultPublishError("capability_invalid");
      let session: unknown;
      try { session = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encodedSession, "base64url"))); }
      catch { throw new JobResultPublishError("capability_invalid"); }
      if (typeof session !== "string" || !session || session.length > 512 ||
        Buffer.from(JSON.stringify(session), "utf8").toString("base64url") !== encodedSession) {
        throw new JobResultPublishError("capability_invalid");
      }
      if (request.url === "/v1/job-result-publish/renew") {
        if ((request.headers["content-length"] ?? "0") !== "0" || request.headers["transfer-encoding"] !== undefined) {
          throw new JobResultPublishError("invalid_request");
        }
        const renewal = this.grants.renew(capability, session, this.getJob);
        const encoded = Buffer.from(JSON.stringify({ schema_version: 1, capability: renewal.capability, expires_at: renewal.expiresAt }));
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": encoded.length, "cache-control": "no-store" });
        response.end(encoded);
        return;
      }
      // Authenticate before consuming the body. A generic UDS connection has no grant.
      this.grants.authorize(capability, session, this.getJob);
      const chunks: Buffer[] = [];
      let bytes = 0;
      const deadline = setTimeout(() => request.destroy(), this.bodyTimeoutMs);
      deadline.unref();
      try {
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > jobResultEnvelopeMaxBytes) throw new JobResultPublishError("payload_too_large");
          chunks.push(Buffer.from(chunk));
        }
      } finally {
        clearTimeout(deadline);
      }
      let input: unknown;
      try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw new JobResultPublishError("invalid_request"); }
      // Recheck current grant/row after body receipt to close a revoke or worker-change race.
      const candidate = this.grants.validate(capability, session, input, this.getJob);
      const result = candidate.reconcileOnly
        ? await this.sink.reconcile(candidate)
        : await this.sink.commit(candidate);
      reply(response, result.outcome === "conflict" ? 409 : result.outcome === "created" ? 202 : 200, result.outcome);
    } catch (error) {
      if (error instanceof JobResultPublishError) {
        const status = error.code === "payload_too_large" ? 413 : error.code === "invalid_request" || error.code === "content_requires_redaction" ? 400 : error.code === "renewal_not_due" ? 425 : 403;
        reply(response, status, error.code);
      } else {
        reply(response, 503, "publish_unavailable");
      }
    }
  }
}
