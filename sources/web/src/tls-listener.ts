import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { TLSSocket } from "node:tls";
import { constants } from "node:crypto";
import { WebAuthController, type BrowserAuthConnections, type BrowserAuthRequest } from "./auth-controller.js";
import { WebLoginController, type BrowserLoginConnections, type BrowserLoginKeys } from "./login-controller.js";
import { WebPublicPages } from "./public-pages.js";
import { privateHeaders, type RawHeaders } from "./browser.js";
import { matchWebRoute } from "./routes.js";
import { parseWebPolicy, type WebPolicy } from "./policy.js";
import { readWebTlsMaterial, WebTlsError, type WebTlsMaterialProvider } from "./tls-material.js";

export interface WebTlsComposition {
  connections: BrowserAuthConnections & BrowserLoginConnections;
  keys: BrowserLoginKeys;
  protectedNow(): string;
  /** Generation already committed and read back by the runtime restart gate.
   * Supplying a number is not that gate and does not attest runtime readiness. */
  generation: number;
  tls: WebTlsMaterialProvider;
}
const maximumConnections = 32, maximumControllers = 32;
const handshakeMs = 5000, secureLifetimeMs = 10000;
type Reply = { status: number; headers: Record<string, string | string[]>; body: string };
const errorReply = (status: number): Reply => ({ status, headers: { ...privateHeaders, "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify({ error: status === 404 ? "not_found" : status === 503 ? "web_unavailable" : "request_invalid" }) });

/** Explicit, one-shot loopback listener. Importing this module never listens.
 * This connects concrete controllers, not an arbitrary handler or job proxy.
 * Runtime/protected-provider provisioning and readiness remain separate gates. */
export class WebLoopbackTlsListener {
  private readonly policy: WebPolicy;
  private readonly server: Server;
  private readonly publicPages: WebPublicPages;
  private readonly login: WebLoginController;
  private readonly auth: WebAuthController;
  private readonly validAt: (now: string) => void;
  private state: "new" | "starting" | "listening" | "closed" = "new";
  private readonly raw = new Set<Duplex>();
  private readonly secure = new Set<TLSSocket>();
  private readonly used = new WeakSet<Socket>();
  private activeControllers = 0;
  private closing: Promise<void> | undefined;
  private rejectStart: (() => void) | undefined;

  constructor(policy: WebPolicy, private readonly composition: WebTlsComposition) {
    let material: ReturnType<typeof readWebTlsMaterial> | undefined;
    try {
      this.policy = parseWebPolicy(policy);
      if (this.policy.mode !== "loopback" || this.policy.listener.kind !== "direct_tls") throw Error();
      material = readWebTlsMaterial(this.policy, composition.tls, composition.protectedNow());
      this.validAt = material.validAt;
      this.publicPages = new WebPublicPages(this.policy);
      this.login = new WebLoginController(this.policy, composition.connections, composition.keys, () => composition.protectedNow(), composition.generation);
      this.auth = new WebAuthController(this.policy, composition.connections, composition.keys, () => composition.protectedNow(), composition.generation);
      this.server = createServer({ cert: material.certificate, key: material.privateKey, minVersion: "TLSv1.2",
        secureOptions: constants.SSL_OP_NO_TICKET | constants.SSL_OP_NO_RENEGOTIATION, sessionTimeout: 1, handshakeTimeout: handshakeMs,
        maxHeaderSize: 16384, requestTimeout: 0, headersTimeout: 0, keepAliveTimeout: 0,
        allowHalfOpen: false }, (request, response) => this.receive(request, response));
    } catch { throw new WebTlsError(); }
    finally { material?.dispose(); }
    // No silent header truncation. The byte bound is enforced by the parser;
    // raw header count is rejected before invoking a controller.
    this.server.maxHeadersCount = 0;
    this.server.timeout = 0;
    this.server.on("connection", socket => {
      if (this.state === "closed" || this.raw.size >= maximumConnections) { socket.destroy(); return; }
      this.raw.add(socket);
      const timer = setTimeout(() => socket.destroy(), handshakeMs + secureLifetimeMs); timer.unref();
      socket.on("error", () => socket.destroy());
      socket.once("close", () => { clearTimeout(timer); this.raw.delete(socket); });
    });
    this.server.on("secureConnection", socket => {
      if (this.state === "closed" || this.secure.size >= maximumConnections) { socket.destroy(); return; }
      this.secure.add(socket);
      const timer = setTimeout(() => socket.destroy(), secureLifetimeMs); timer.unref();
      socket.on("error", () => socket.destroy());
      socket.once("close", () => { clearTimeout(timer); this.secure.delete(socket); });
    });
    this.server.on("tlsClientError", (_error, socket) => socket.destroy());
    this.server.on("clientError", (_error, socket) => this.rejectSocket(socket));
    this.server.on("upgrade", (_request, socket) => this.rejectSocket(socket));
    this.server.on("connect", (_request, socket) => this.rejectSocket(socket));
    const rejectExpectation = (request: IncomingMessage, response: ServerResponse) => {
      request.on("error", () => request.socket.destroy());
      if (this.used.has(request.socket)) { request.socket.destroy(); return; }
      this.used.add(request.socket); this.respond(response, errorReply(400));
    };
    this.server.on("checkContinue", rejectExpectation);
    this.server.on("checkExpectation", rejectExpectation);
    this.server.on("error", () => { if (this.state !== "starting") void this.close(); });
  }
  private timeValid(): boolean {
    try { this.validAt(this.composition.protectedNow()); return true; }
    catch { void this.close(); return false; }
  }
  private rejectSocket(socket: Duplex): void {
    if (!(socket instanceof TLSSocket) || !socket.encrypted || !socket.writable || this.used.has(socket)) { socket.destroy(); return; }
    this.used.add(socket);
    const reply = errorReply(400), headers = { ...reply.headers, connection: "close", "content-length": String(Buffer.byteLength(reply.body)) };
    socket.end("HTTP/1.1 400 Bad Request\r\n" + Object.entries(headers).map(([key, value]) => key + ": " + value).join("\r\n") + "\r\n\r\n" + reply.body);
  }
  private respond(response: ServerResponse, reply: Reply): void {
    response.once("error", () => response.destroy());
    if (response.destroyed || !response.socket || response.socket.destroyed || response.headersSent) return;
    try {
      if (Buffer.byteLength(reply.body) > 131072) throw Error();
      response.shouldKeepAlive = false;
      response.writeHead(reply.status, { ...reply.headers, "cache-control": "no-store", "referrer-policy": "no-referrer",
        connection: "close", "content-length": String(Buffer.byteLength(reply.body)) });
      response.end(reply.body);
    } catch { response.destroy(); }
  }
  private receive(request: IncomingMessage, response: ServerResponse): void {
    const socket = request.socket;
    response.on("error", () => socket.destroy()); request.on("error", () => socket.destroy());
    if (this.state !== "listening" || !(socket instanceof TLSSocket) || !socket.encrypted || !this.secure.has(socket)
      || this.used.has(socket) || !this.timeValid()) { socket.destroy(); return; }
    this.used.add(socket);
    const fail = () => { request.resume(); this.respond(response, errorReply(400)); };
    const headers: RawHeaders = Array.from({ length: request.rawHeaders.length / 2 }, (_, i) => [request.rawHeaders[i * 2]!, request.rawHeaders[i * 2 + 1]!] as const);
    const named = (name: string) => headers.filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);
    const lengths = named("content-length");
    if (request.httpVersion !== "1.1" || headers.length > 128 || named("transfer-encoding").length || named("expect").length
      || named("upgrade").length || lengths.length > 1 || (lengths.length === 1 && !/^(?:0|[1-9][0-9]?)$/.test(lengths[0]!))) { fail(); return; }
    const size = lengths.length ? Number(lengths[0]) : 0;
    if (size > 64 || (request.method === "POST" && lengths.length !== 1)) { fail(); return; }
    let controller: "public" | "login" | "auth";
    const method = request.method ?? "", target = request.url ?? "";
    try {
      if (method === "GET" && target === "/assets/login.js") controller = "public";
      else {
        const route = matchWebRoute(method, target);
        if (["login", "login_complete"].includes(route.id)) controller = "public";
        else if (["prelogin_csrf", "login_start", "login_callback"].includes(route.id)) controller = "login";
        else if (["dashboard", "session", "local_csrf", "logout", "logout_status"].includes(route.id)) controller = "auth";
        else throw Error();
      }
    } catch { request.resume(); this.respond(response, errorReply(404)); return; }
    let bytes = 0, invalid = false;
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => {
      bytes += part.length;
      if (invalid) return;
      if (bytes > size || bytes > 64) { invalid = true; parts.length = 0; socket.destroy(); return; }
      parts.push(part);
    });
    request.once("end", () => {
      if (invalid || bytes !== size || request.aborted || socket.destroyed || this.state !== "listening" || !this.timeValid()) return;
      if (this.activeControllers >= maximumControllers) { this.respond(response, errorReply(503)); return; }
      const input: BrowserAuthRequest = { method, target, headers, body: Buffer.concat(parts, bytes), transportVerified: true };
      this.activeControllers++;
      // A lost socket does not cancel an accepted mutation. Retain this slot
      // until the actual controller settles, without replaying the operation.
      void (async () => {
        try {
          const reply = controller === "public" ? this.publicPages.handle(input) : await (controller === "login" ? this.login : this.auth).handle(input);
          if (this.state === "listening" && this.timeValid()) this.respond(response, reply);
        } catch { this.respond(response, errorReply(503)); }
        finally { this.activeControllers--; }
      })();
    });
  }
  async start(): Promise<void> {
    if (this.state !== "new") throw new WebTlsError();
    this.state = "starting";
    try {
      if (!this.timeValid() || this.policy.listener.kind !== "direct_tls") throw Error();
      await new Promise<void>((resolve, reject) => {
        const failed = () => { cleanup(); reject(new WebTlsError()); };
        const listening = () => { cleanup(); resolve(); };
        const cleanup = () => { this.server.off("error", failed); this.server.off("listening", listening); this.rejectStart = undefined; };
        this.rejectStart = failed;
        this.server.once("error", failed); this.server.once("listening", listening);
        try {
          if (this.policy.listener.kind !== "direct_tls") throw Error();
          this.server.listen({ host: this.policy.listener.host, port: this.policy.listener.port, exclusive: true, backlog: maximumConnections });
        } catch { failed(); }
      });
      if (!this.timeValid() || (this.state as string) === "closed") throw Error();
      this.state = "listening";
    } catch { await this.close(); throw new WebTlsError(); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.state = "closed"; this.rejectStart?.();
    for (const socket of this.raw) socket.destroy();
    for (const socket of this.secure) socket.destroy();
    this.closing = new Promise<void>(resolve => { this.server.close(() => resolve()); });
    return this.closing;
  }
}
