import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import { TextDecoder } from "node:util";

import type { JobRow } from "./types.js";
import { JobResultPublishCapabilities, JobResultPublishError, jobResultEnvelopeMaxBytes, jobResultPublishTtlMs, validJobResultPublishSession, type AuthorizedJobResultPublish } from "./job-result-publish.js";

export interface JobResultPublishSink {
  /** Compare candidate.fence and call candidate.assertCurrentGrant() inside the synchronous Result transaction. */
  commit(candidate: AuthorizedJobResultPublish): Promise<{ outcome: "created" | "reused" | "conflict" }>;
  /** Must compare the durable digest and may never mutate a terminal Result. */
  reconcile(candidate: AuthorizedJobResultPublish): Promise<{ outcome: "reused" | "conflict" }>;
}

function reply(response: ServerResponse, status: number, code: string): void {
  const encoded = Buffer.from(JSON.stringify({ schema_version: 1, code }));
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": encoded.length });
  response.end(encoded);
}

function reject(request: IncomingMessage, response: ServerResponse, status: number, code: string): void {
  // Drain an already-sent body so the peer can receive the fixed error. A peer
  // that withholds the rest gets a short, bounded window before forced close.
  request.resume();
  response.setHeader("connection", "close");
  response.shouldKeepAlive = true;
  const socket = request.socket ?? response.socket;
  response.once("finish", () => {
    if (socket) {
      const deadline = setTimeout(() => socket.destroy(), 200);
      deadline.unref();
    }
  });
  reply(response, status, code);
}

class WireRequestBoundary {
  private state: "header" | "fixed" | "size" | "data" | "data_crlf" | "trailer" = "header";
  private pending = Buffer.alloc(0);
  private remaining = 0;
  private crlfIndex = 0;
  private completed = false;

  /** Consume framing without retaining the decoded body or completed chunks. */
  feed(chunk: Buffer): boolean {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.state === "fixed" || this.state === "data") {
        const consumed = Math.min(this.remaining, chunk.length - offset);
        this.remaining -= consumed;
        offset += consumed;
        if (this.remaining === 0) {
          if (this.state === "fixed") this.finish();
          else this.state = "data_crlf";
        }
        continue;
      }
      if (this.state === "data_crlf") {
        if (chunk[offset++] !== (this.crlfIndex++ === 0 ? 13 : 10)) throw new Error("invalid_chunk_framing");
        if (this.crlfIndex === 2) { this.crlfIndex = 0; this.state = "size"; }
        continue;
      }
      const marker = this.state === "header" ? "\r\n\r\n" : "\r\n";
      const limit = (this.state === "size" ? 256 : 16_384) - this.pending.length;
      if (limit <= 0) throw new Error("oversize_wire_header");
      const window = Buffer.concat([this.pending, chunk.subarray(offset, Math.min(chunk.length, offset + limit))]);
      const end = window.indexOf(marker);
      if (end < 0) {
        if (offset + limit < chunk.length) throw new Error("oversize_wire_header");
        this.pending = window;
        offset = chunk.length;
        break;
      }
      offset += end + marker.length - this.pending.length;
      const line = window.subarray(0, end).toString("latin1");
      this.pending = Buffer.alloc(0);
      if (this.state === "header") {
        if (!/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \S+ HTTP\/1\.[01]\r\n/.test(line)) throw new Error("invalid_wire_header");
        if (/\r\ntransfer-encoding:\s*chunked\s*(?:\r\n|$)/i.test(line)) this.state = "size";
        else {
          const match = line.match(/\r\ncontent-length:\s*(\d+)/i);
          this.remaining = Number(match?.[1] ?? "0");
          if (!Number.isSafeInteger(this.remaining)) throw new Error("invalid_wire_length");
          if (this.remaining === 0) this.finish();
          else this.state = "fixed";
        }
      } else if (this.state === "size") {
        const sizeText = line.split(";", 1)[0]!.trim();
        if (!/^[0-9a-f]+$/i.test(sizeText)) throw new Error("invalid_chunk_size");
        this.remaining = Number.parseInt(sizeText, 16);
        if (!Number.isSafeInteger(this.remaining)) throw new Error("invalid_chunk_size");
        this.state = this.remaining === 0 ? "trailer" : "data";
      } else if (line === "") this.finish();
    }
    return this.completed && this.state === "header" && this.pending.length > 0;
  }

  private finish(): void {
    this.completed = true;
    this.state = "header";
    this.pending = Buffer.alloc(0);
  }
}

function recoverableReject(request: IncomingMessage, response: ServerResponse, status: number, code: string, timeoutMs: number): void {
  if (request.complete) { reply(response, status, code); return; }
  // The authenticated worker may correct its payload on the same FD after
  // the current body is fully drained. A stalled body still closes the socket.
  const deadline = setTimeout(() => request.socket.destroy(), timeoutMs);
  deadline.unref();
  request.once("end", () => { clearTimeout(deadline); if (!response.destroyed) reply(response, status, code); });
  request.once("close", () => clearTimeout(deadline));
  request.resume();
}

// JSON.parse discards the original number spelling. Reject decimal and exponent
// lexemes before parsing so precision loss cannot alias two publish digests.
function assertExactJsonNumbers(source: string): void {
  const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char !== "-" && (char < "0" || char > "9")) continue;
    number.lastIndex = index;
    const match = number.exec(source);
    if (!match) continue;
    if (!/^-?(?:0|[1-9]\d*)$/.test(match[0]) || !Number.isSafeInteger(Number(match[0]))) {
      throw new JobResultPublishError("invalid_request");
    }
    index += match[0].length - 1;
  }
}

/** Dedicated HTTP parser for trusted, already-connected worker sockets. */
export class JobResultPublishServer {
  private readonly server: http.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly headerDeadlines = new Map<net.Socket, NodeJS.Timeout>();
  private readonly publishingSockets = new Set<net.Socket>();
  private readonly activeRequests = new Set<net.Socket>();
  private readonly activeMessages = new Map<net.Socket, IncomingMessage>();
  private readonly publishing = new Set<Promise<void>>();
  private stopping = false;
  constructor(
    private readonly grants: JobResultPublishCapabilities,
    private readonly getJob: (jobId: string) => JobRow | undefined,
    private readonly sink: JobResultPublishSink,
    private readonly maxConnections: number,
    private readonly bodyTimeoutMs = 15_000,
  ) {
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) throw new Error("invalid_max_connections");
    this.server = http.createServer((request, response) => void this.handle(request, response));
    // A worker may renew and then publish over its sole pre-connected FD.
    // The per-socket active fence below rejects overlapping/pipelined requests.
    this.server.keepAliveTimeout = jobResultPublishTtlMs + 60_000;
  }

  /** The caller must supply a pre-connected socket over an authenticated channel. */
  accept(socket: net.Socket): void {
    if (this.stopping || new Set([...this.sockets, ...this.publishingSockets]).size >= this.maxConnections) { socket.destroy(); return; }
    this.sockets.add(socket);
    socket.on("error", () => socket.destroy());
    const boundary = new WireRequestBoundary();
    const armHeaderDeadline = () => {
      if (socket.destroyed || this.headerDeadlines.has(socket)) return;
      const deadline = setTimeout(() => socket.destroy(), this.bodyTimeoutMs);
      deadline.unref();
      this.headerDeadlines.set(socket, deadline);
    };
    const inspectRaw = (chunk: Buffer) => {
      if (socket.destroyed) return;
      try { if (boundary.feed(chunk)) armHeaderDeadline(); }
      catch { socket.destroy(); }
    };
    // Keep the FD outside the HTTP parser until its first byte. The worker may
    // run for hours before publishing; a partial first header gets a deadline.
    socket.once("data", chunk => {
      const initial = Buffer.from(chunk);
      let firstReplay = true;
      armHeaderDeadline();
      socket.pause();
      socket.unshift(chunk);
      this.server.emit("connection", socket);
      socket.on("data", chunk => {
        if (firstReplay && chunk.equals(initial)) {
          firstReplay = false;
          return;
        }
        firstReplay = false;
        // Observe the HTTP parser's state after it has handled this data event.
        queueMicrotask(() => inspectRaw(Buffer.from(chunk)));
      });
      socket.resume();
      queueMicrotask(() => inspectRaw(initial));
    });
    socket.once("close", () => {
      this.sockets.delete(socket);
      const pending = this.headerDeadlines.get(socket);
      if (pending) clearTimeout(pending);
      this.headerDeadlines.delete(socket);
    });
  }

  async stop(): Promise<void> {
    if (this.stopping && this.sockets.size === 0 && this.publishing.size === 0) return;
    this.stopping = true;
    for (const socket of this.sockets) if (!this.publishingSockets.has(socket)) socket.destroy();
    await Promise.allSettled([...this.publishing]);
    for (const socket of this.sockets) socket.destroy();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.activeRequests.has(request.socket)) { request.socket.destroy(); return; }
    this.activeRequests.add(request.socket);
    this.activeMessages.set(request.socket, request);
    const clearActive = () => {
      this.activeRequests.delete(request.socket);
      if (this.activeMessages.get(request.socket) === request) this.activeMessages.delete(request.socket);
    };
    response.once("finish", clearActive);
    response.once("close", clearActive);
    const headerDeadline = this.headerDeadlines.get(request.socket);
    if (headerDeadline) clearTimeout(headerDeadline);
    this.headerDeadlines.delete(request.socket);
    if (request.method !== "POST" || !["/v1/job-result-publish", "/v1/job-result-publish/renew"].includes(request.url ?? "")) {
      reject(request, response, 404, "not_found"); return;
    }
    const capability = request.headers["x-dona-job-result-capability"];
    const encodedSession = request.headers["x-dona-worker-session"];
    if (typeof capability !== "string" || typeof encodedSession !== "string") {
      reject(request, response, 403, "capability_invalid"); return;
    }
    let authenticated = false;
    try {
      // JSON before base64url preserves every persisted 512-character session,
      // including Unicode, control characters and lone surrogates.
      if (!/^[A-Za-z0-9_-]{1,12000}$/.test(encodedSession)) throw new JobResultPublishError("capability_invalid");
      let session: unknown;
      try { session = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encodedSession, "base64url"))); }
      catch { throw new JobResultPublishError("capability_invalid"); }
      if (typeof session !== "string" || !validJobResultPublishSession(session) ||
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
      authenticated = true;
      const body = Buffer.allocUnsafe(jobResultEnvelopeMaxBytes);
      let bytes = 0;
      let tooLarge = false;
      const deadline = setTimeout(() => request.destroy(), this.bodyTimeoutMs);
      deadline.unref();
      try {
        for await (const chunk of request) {
          if (bytes + chunk.length > jobResultEnvelopeMaxBytes) { tooLarge = true; continue; }
          chunk.copy(body, bytes);
          bytes += chunk.length;
        }
      } finally {
        clearTimeout(deadline);
      }
      if (tooLarge) throw new JobResultPublishError("payload_too_large");
      let input: unknown;
      try {
        const source = new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(0, bytes));
        assertExactJsonNumbers(source);
        input = JSON.parse(source);
      }
      catch { throw new JobResultPublishError("invalid_request"); }
      // Recheck current grant/row after body receipt to close a revoke or worker-change race.
      const candidate = this.grants.validate(capability, session, input, this.getJob);
      if (this.stopping) throw new JobResultPublishError("job_not_publishable");
      const publish = (async () => {
        const result = candidate.reconcileOnly
          ? await this.sink.reconcile(candidate)
          : await this.sink.commit(candidate);
        if (response.destroyed || response.writableFinished) return;
        const finished = new Promise<void>(resolve => {
          response.once("finish", () => resolve());
          response.once("close", () => resolve());
        });
        reply(response, result.outcome === "conflict" ? 409 : result.outcome === "created" ? 202 : 200, result.outcome);
        await finished;
      })();
      this.publishing.add(publish);
      this.publishingSockets.add(request.socket);
      try { await publish; }
      finally {
        this.publishing.delete(publish);
        this.publishingSockets.delete(request.socket);
      }
    } catch (error) {
      if (error instanceof JobResultPublishError) {
        const status = error.code === "payload_too_large" ? 413 : error.code === "invalid_request" || error.code === "content_requires_redaction" ? 400 : error.code === "renewal_not_due" ? 425 : 403;
        if (error.code === "renewal_not_due") reply(response, status, error.code);
        else if (authenticated && ["invalid_request", "content_requires_redaction", "payload_too_large"].includes(error.code)) {
          recoverableReject(request, response, status, error.code, this.bodyTimeoutMs);
        }
        else reject(request, response, status, error.code);
      } else {
        reject(request, response, 503, "publish_unavailable");
      }
    }
  }
}
