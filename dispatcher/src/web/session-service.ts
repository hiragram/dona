import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type net from "node:net";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { WebAuthRepository } from "./repository.js";
import { serviceScopeSchema, verifyServiceRequest, signServiceResponse, parseSessionServiceInput, WebServiceError,
  webSessionServiceHost, webSessionServicePath, maximumServiceBodyBytes, type ServiceScope, type WebServiceCredentialLookup,
  type SessionServiceResult } from "./service-auth.js";

function privateParent(socketPath: string): void {
  const uid = process.getuid?.(), parent = path.dirname(socketPath);
  if (uid === undefined || !path.isAbsolute(socketPath) || path.normalize(socketPath) !== socketPath || Buffer.byteLength(socketPath) > 100
    || socketPath.includes("\0") || fs.realpathSync(parent) !== parent) throw new WebServiceError();
  const directory = fs.lstatSync(parent);
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o777) !== 0o700) throw new WebServiceError();
}
function requestHeaders(request: http.IncomingMessage): { proof: string; length: number } {
  const headers = new Map<string, string>();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]!.toLowerCase(), value = request.rawHeaders[i + 1]!;
    if (!["host", "content-type", "content-length", "connection", "x-dona-service-proof"].includes(name) || headers.has(name)) throw new WebServiceError();
    headers.set(name, value);
  }
  const length = headers.get("content-length"), proof = headers.get("x-dona-service-proof");
  if (request.method !== "POST" || request.url !== webSessionServicePath || request.httpVersion !== "1.1"
    || headers.get("host") !== webSessionServiceHost || headers.get("content-type") !== "application/json"
    || headers.get("connection") !== "close" || !length || !/^[1-9][0-9]{0,4}$/.test(length)
    || Number(length) > maximumServiceBodyBytes || !proof || proof.length > 2048) throw new WebServiceError();
  return { proof, length: Number(length) };
}
async function body(request: http.IncomingMessage, expected: number): Promise<string> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new WebServiceError(); size += chunk.length;
    if (size > expected || size > maximumServiceBodyBytes) throw new WebServiceError(); chunks.push(chunk);
  }
  if (size !== expected || !request.complete || request.rawTrailers.length) throw new WebServiceError();
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

/** Dedicated credential-authenticated UDS endpoint, not a generic Dispatcher
 * proxy. No production listener is started by importing this module. Runtime
 * must establish protected providers/readiness before constructing the service. */
export class WebSessionService {
  private server: http.Server | undefined;
  private endpoint: { dev: number; ino: number } | undefined;
  private readonly sockets = new Set<net.Socket>();
  private readonly scope: ServiceScope;
  constructor(private readonly socketPath: string, scope: ServiceScope, private readonly repository: WebAuthRepository,
    private readonly credentials: WebServiceCredentialLookup, private readonly now: () => string, private readonly deadlineMs = 5000) {
    this.scope = serviceScopeSchema.parse(scope);
    if (!(repository instanceof WebAuthRepository) || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 5000) throw new WebServiceError();
    const storedScope = repository.configuredScope();
    if (storedScope.instance_id !== this.scope.instance_id || storedScope.tenant_id !== this.scope.tenant_id) throw new WebServiceError();
  }
  async start(): Promise<void> {
    if (this.server) throw new WebServiceError();
    try {
      privateParent(this.socketPath);
      try { fs.lstatSync(this.socketPath); throw new WebServiceError(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const server = http.createServer({ maxHeaderSize: 4096, requestTimeout: this.deadlineMs,
        headersTimeout: Math.min(this.deadlineMs, 1000), connectionsCheckingInterval: 100 }, (request, response) => { void this.handle(request, response); });
      this.server = server; server.maxConnections = 32; server.maxHeadersCount = 16; server.maxRequestsPerSocket = 1;
      server.on("connection", socket => {
        this.sockets.add(socket); const timer = setTimeout(() => socket.destroy(), this.deadlineMs);
        socket.once("close", () => { clearTimeout(timer); this.sockets.delete(socket); });
      });
      server.on("clientError", (_error, socket) => socket.destroy());
      server.on("checkContinue", (_request, response) => response.destroy());
      server.on("checkExpectation", (_request, response) => response.destroy());
      server.on("connect", (_request, socket) => socket.destroy());
      server.on("upgrade", (_request, socket) => socket.destroy());
      await new Promise<void>((resolve, reject) => {
        const failed = () => reject(new WebServiceError()); server.once("error", failed);
        server.listen(this.socketPath, () => { server.removeListener("error", failed); resolve(); });
      });
      privateParent(this.socketPath);
      const socket = fs.lstatSync(this.socketPath);
      if (!socket.isSocket() || socket.uid !== process.getuid?.() || socket.nlink !== 1) throw new WebServiceError();
      fs.chmodSync(this.socketPath, 0o600);
      const after = fs.lstatSync(this.socketPath);
      if (after.dev !== socket.dev || after.ino !== socket.ino || (after.mode & 0o777) !== 0o600) throw new WebServiceError();
      this.endpoint = { dev: after.dev, ino: after.ino };
      server.on("error", () => { void this.close(); });
    } catch { await this.close(); throw new WebServiceError(); }
  }
  async close(): Promise<void> {
    const server = this.server; this.server = undefined; this.endpoint = undefined; if (!server) return;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  private assertEndpoint(): void {
    privateParent(this.socketPath); const current = fs.lstatSync(this.socketPath);
    if (!this.endpoint || !current.isSocket() || current.uid !== process.getuid?.() || current.nlink !== 1
      || (current.mode & 0o777) !== 0o600 || current.dev !== this.endpoint.dev || current.ino !== this.endpoint.ino) throw new WebServiceError();
  }
  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const started = performance.now();
    try {
      this.assertEndpoint();
      const headers = requestHeaders(request), raw = await body(request, headers.length);
      if (performance.now() - started >= this.deadlineMs || request.socket.destroyed || response.destroyed) throw new WebServiceError();
      verifyServiceRequest(headers.proof, raw, this.scope, this.credentials, this.now());
      const input = parseSessionServiceInput(raw);
      if (performance.now() - started >= this.deadlineMs || request.socket.destroyed || response.destroyed) throw new WebServiceError();
      this.assertEndpoint();
      const result = this.repository.verifySessionIngress("web_service_" + randomBytes(16).toString("hex"),
        input.context, input.method, input.target, Buffer.alloc(0));
      let reply: SessionServiceResult;
      if (result.status === "denied") reply = { status: "denied" };
      else if (result.kind === "session_verified") reply = { status: "succeeded", principal: result.principal };
      else throw new WebServiceError();
      if (performance.now() - started >= this.deadlineMs || response.destroyed) throw new WebServiceError();
      const proof = signServiceResponse(headers.proof, raw, reply, this.scope, this.credentials, this.now());
      this.assertEndpoint();
      response.writeHead(200, { "content-type": "application/vnd.dona.web-session-response", "content-length": String(Buffer.byteLength(proof)), connection: "close" });
      response.end(proof);
    } catch { response.destroy(); }
  }
}
