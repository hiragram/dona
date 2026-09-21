import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type net from "node:net";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { WebAuthRepository, type WebStoreResult } from "./repository.js";
import { authWriteResultSchema, writeTransactionId } from "./write-shapes.js";
import * as sessionAuth from "./service-auth.js";
import * as readAuth from "./read-auth.js";
import * as writeAuth from "./write-auth.js";
import { serviceScopeSchema, WebServiceError, type ServiceScope, type WebServiceCredentialLookup } from "./service-auth.js";
import type { AuthWriteResult } from "./write-auth.js";
import { maximumWebCommandBodyBytes, parseWebCommandInput, signWebCommandResponse, verifyWebCommandProof } from "./command-wire.js";
import type { WebCommandBroker } from "./command-broker.js";

const kinds = ["session", "read", "write", "command"] as const;
type Kind = typeof kinds[number];
type Mode = Kind | "all";
const protocols = Object.freeze({
  session: Object.freeze({ path: sessionAuth.webSessionServicePath, host: sessionAuth.webSessionServiceHost,
    maximum: sessionAuth.maximumServiceBodyBytes, type: "application/vnd.dona.web-session-response" }),
  read: Object.freeze({ path: readAuth.webAuthReadPath, host: readAuth.webAuthReadHost,
    maximum: readAuth.maximumServiceBodyBytes, type: "application/vnd.dona.web-auth-read-response" }),
  write: Object.freeze({ path: writeAuth.webAuthWritePath, host: writeAuth.webAuthWriteHost,
    maximum: writeAuth.maximumServiceBodyBytes, type: "application/vnd.dona.web-auth-write-response" }),
  command: Object.freeze({ path: "/v1/web/command", host: "dona-web-command",
    maximum: maximumWebCommandBodyBytes, type: "application/json" }),
});

function privateParent(socketPath: string): void {
  const uid = process.getuid?.(), parent = path.dirname(socketPath);
  if (uid === undefined || !path.isAbsolute(socketPath) || path.normalize(socketPath) !== socketPath || Buffer.byteLength(socketPath) > 100
    || socketPath.includes("\0") || fs.realpathSync(parent) !== parent) throw new WebServiceError();
  const directory = fs.lstatSync(parent);
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o777) !== 0o700) throw new WebServiceError();
}
function requestHeaders(request: http.IncomingMessage, mode: Mode): { proof: string; length: number; kind: Kind } {
  const headers = new Map<string, string>();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]!.toLowerCase(), value = request.rawHeaders[i + 1]!;
    if (!["host", "content-type", "content-length", "connection", "x-dona-service-proof"].includes(name) || headers.has(name)) throw new WebServiceError();
    headers.set(name, value);
  }
  const kind = kinds.find(kind => protocols[kind].path === request.url && (mode === "all" || mode === kind));
  if (!kind) throw new WebServiceError();
  const protocol = protocols[kind];
  const length = headers.get("content-length"), proof = headers.get("x-dona-service-proof");
  if (request.method !== "POST" || request.url !== protocol.path || request.httpVersion !== "1.1"
    || headers.get("host") !== protocol.host || headers.get("content-type") !== "application/json"
    || headers.get("connection") !== "close" || !length || !/^[1-9][0-9]{0,5}$/.test(length)
    || Number(length) > protocol.maximum || !proof || proof.length > 2048) throw new WebServiceError();
  return { proof, length: Number(length), kind };
}
async function body(request: http.IncomingMessage, expected: number, maximum: number): Promise<string> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new WebServiceError(); size += chunk.length;
    if (size > expected || size > maximum) throw new WebServiceError(); chunks.push(chunk);
  }
  if (size !== expected || !request.complete || request.rawTrailers.length) throw new WebServiceError();
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

/** Fixed server-owned protocols only. Callers cannot install routes, handlers,
 * forwarding targets or arbitrary repository operations. The named wrappers keep
 * narrow exposure; the gateway combines them at one owner-only UDS. */
export class WebInternalService {
  private server: http.Server | undefined;
  private endpoint: { dev: number; ino: number } | undefined;
  private readonly sockets = new Set<net.Socket>();
  private readonly scope: ServiceScope;
  constructor(private readonly socketPath: string, scope: ServiceScope, private readonly repository: WebAuthRepository,
    private readonly credentials: WebServiceCredentialLookup, private readonly now: () => string, private readonly deadlineMs: number, private readonly mode: Mode,
    private readonly commands?: WebCommandBroker) {
    this.scope = serviceScopeSchema.parse(scope);
    if (mode !== "all" && !kinds.includes(mode)) throw new WebServiceError();
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
  private assertRequestReady(started: number, request: http.IncomingMessage, response: http.ServerResponse): void {
    if (performance.now() - started >= this.deadlineMs || request.socket.destroyed || response.destroyed) throw new WebServiceError();
    this.assertEndpoint();
  }
  private async process(kind: Kind, raw: string, proof: string, started: number, request: http.IncomingMessage, response: http.ServerResponse): Promise<string> {
    switch (kind) {
      case "session": {
        sessionAuth.verifyServiceRequest(proof, raw, this.scope, this.credentials, this.now());
        const input = sessionAuth.parseSessionServiceInput(raw);
        this.assertRequestReady(started, request, response);
        const result = this.repository.verifySessionIngress("web_service_" + randomBytes(16).toString("hex"),
          input.context, input.method, input.target, Buffer.alloc(0), { user_navigation: input.user_navigation === true });
        let reply: sessionAuth.SessionServiceResult;
        if (result.status === "denied") reply = { status: "denied", reason: sessionAuth.sessionServiceDenialSchema.parse(result.reason) };
        else if (result.kind === "session_verified") reply = { status: "succeeded", principal: result.principal };
        else throw new WebServiceError();
        this.assertRequestReady(started, request, response);
        return sessionAuth.signServiceResponse(proof, raw, reply, this.scope, this.credentials, this.now());
      }
      case "read": {
        readAuth.verifyServiceRequest(proof, raw, this.scope, this.credentials, this.now());
        const input = readAuth.parseAuthReadInput(raw);
        this.assertRequestReady(started, request, response);
        let reply: readAuth.AuthReadResult;
        if (input.operation === "login_context") reply = { operation: input.operation, ...this.repository.loginContext() };
        else if (input.operation === "session_lookup") reply = { operation: input.operation, snapshot: this.repository.lookupSession(input.cookie_indexes) };
        else if (input.operation === "principal_lookup") reply = { operation: input.operation, snapshot: this.repository.lookupPrincipal(input.subject_indexes) };
        else throw new WebServiceError();
        this.assertRequestReady(started, request, response);
        return readAuth.signServiceResponse(proof, raw, reply, this.scope, this.credentials, this.now());
      }
      case "write": {
        writeAuth.verifyServiceRequest(proof, raw, this.scope, this.credentials, this.now());
        const input = writeAuth.parseAuthWriteInput(raw);
        this.assertRequestReady(started, request, response);
        const transactionId = writeTransactionId(proof);
        let result: WebStoreResult;
        switch (input.operation) {
          case "restart": result = this.repository.restart(transactionId, input.expected_generation); break;
          case "create_login": result = this.repository.createLogin(transactionId, input.login, input.payload, input.browser_session_cookies); break;
          case "consume_login": result = this.repository.consumeLoginByCookie(transactionId, input.cookie_indexes); break;
          case "create_session": result = this.repository.createSession(transactionId, input.receipt_id, input.subject_indexes, input.session, input.payload); break;
          case "revoke_session": result = this.repository.revokeSession(transactionId, input.session_ref, input.cookie); break;
          case "revoke_inactive": result = this.repository.revokeInactiveSession(transactionId, input.session_ref, input.cookie); break;
          case "record_denial": result = this.repository.recordAuthDenial(transactionId, input.cookie_indexes, input.reason); break;
          case "expire": result = this.repository.expire(transactionId); break;
          default: throw new WebServiceError();
        }
        const reply: AuthWriteResult = authWriteResultSchema.parse({ operation: input.operation, result });
        this.assertRequestReady(started, request, response);
        return writeAuth.signServiceResponse(proof, raw, reply, this.scope, this.credentials, this.now());
      }
      case "command": {
        if (!this.commands) throw new WebServiceError();
        verifyWebCommandProof(proof, raw, this.scope, this.credentials, this.now());
        const input = parseWebCommandInput(raw, proof, this.credentials); this.assertRequestReady(started, request, response);
        const result = await this.commands.execute(input); this.assertRequestReady(started, request, response);
        return signWebCommandResponse(proof, raw, result, this.scope, this.credentials, this.now());
      }
      default: throw new WebServiceError();
    }
  }
  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const started = performance.now();
    try {
      this.assertEndpoint();
      const headers = requestHeaders(request, this.mode), protocol = protocols[headers.kind];
      const raw = await body(request, headers.length, protocol.maximum);
      this.assertRequestReady(started, request, response);
      const proof = await this.process(headers.kind, raw, headers.proof, started, request, response);
      this.assertRequestReady(started, request, response);
      response.writeHead(200, { "content-type": protocol.type, "content-length": String(Buffer.byteLength(proof)), connection: "close" });
      response.end(proof);
    } catch { response.destroy(); }
  }
}
