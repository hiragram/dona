import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";

import type { UpdateController } from "./controller.js";
import type { UpdateDatabase } from "./database.js";
import type { Logger } from "./ports.js";
import { redactText } from "./redaction.js";
import type { UpdateService } from "./service.js";
import { parseApplyRequest, parseCancelRequest, parsePlanRequest, parseRequestId, ValidationError } from "./validation.js";

function send(response: ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8"): void {
  const encoded = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  response.writeHead(status, { "content-type": contentType, "content-length": encoded.length });
  response.end(encoded);
}

async function socketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const finish = (alive: boolean): void => {
      socket.destroy();
      resolve(alive);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

export interface UpdaterSocketReservation {
  socketPath: string;
  server: http.Server;
  startupLock: UpdaterStartupLock;
}

interface UpdaterStartupLock {
  path: string;
  token: string;
  processStart: string;
}

export interface ProcessIdentity {
  status: "alive" | "dead" | "unknown";
  identity?: string;
}

export interface UpdaterSocketOptions {
  inspectProcess?: (pid: number) => ProcessIdentity;
  afterReadStartupLock?: () => void | Promise<void>;
}

function inspectProcess(pid: number): ProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: "dead" };
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { status: "dead" };
    if (code !== "EPERM") return { status: "unknown" };
  }
  try {
    const value = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value ? { status: "alive", identity: value } : { status: "unknown" };
  } catch {
    return { status: "unknown" };
  }
}

async function acquireStartupLock(
  controlRoot: string,
  processInspector: (pid: number) => ProcessIdentity,
  afterReadStartupLock?: () => void | Promise<void>,
): Promise<UpdaterStartupLock> {
  const lockPath = path.join(controlRoot, "updater.start.lock");
  const token = randomUUID();
  const self = processInspector(process.pid);
  if (self.status !== "alive" || !self.identity) throw new Error("updater_startup_identity_unavailable");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const temporary = `${lockPath}.${token}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, process_start: self.identity, token })}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.link(temporary, lockPath);
      await fs.unlink(temporary);
      return { path: lockPath, token, processStart: self.identity };
    } catch (error) {
      try { await fs.unlink(temporary); } catch { /* best effort */ }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let owner: { pid?: unknown; process_start?: unknown; token?: unknown };
    let ownerStats: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      const handle = await fs.open(lockPath, "r");
      try {
        owner = JSON.parse(await handle.readFile("utf8")) as { pid?: unknown; process_start?: unknown; token?: unknown };
        ownerStats = await handle.stat();
      } finally {
        await handle.close();
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("updater_startup_lock_invalid");
    }
    if (typeof owner.pid !== "number" || typeof owner.process_start !== "string" || typeof owner.token !== "string") {
      throw new Error("updater_startup_lock_invalid");
    }
    const observed = processInspector(owner.pid);
    if (observed.status === "unknown") throw new Error("updater_startup_identity_unavailable");
    if (observed.status === "alive" && observed.identity === owner.process_start) {
      throw new Error("updater_startup_lock_active");
    }
    await afterReadStartupLock?.();
    const current = await fs.lstat(lockPath);
    if (current.dev !== ownerStats.dev || current.ino !== ownerStats.ino) continue;
    for (const entry of await fs.readdir(controlRoot)) {
      if (!entry.startsWith(`${path.basename(lockPath)}.`) || !/\.(?:tmp|stale)$/.test(entry)) continue;
      const candidate = path.join(controlRoot, entry);
      try {
        const stats = await fs.lstat(candidate);
        if (stats.dev === current.dev && stats.ino === current.ino && stats.isFile() &&
          stats.uid === process.getuid?.() && (stats.mode & 0o077) === 0) await fs.unlink(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const stalePath = `${lockPath}.${token}.stale`;
    try {
      await fs.link(lockPath, stalePath);
      const [claimed, claimedCurrent] = await Promise.all([fs.lstat(stalePath), fs.lstat(lockPath)]);
      if (claimed.dev !== ownerStats.dev || claimed.ino !== ownerStats.ino ||
        claimed.dev !== claimedCurrent.dev || claimed.ino !== claimedCurrent.ino ||
        claimed.nlink !== 2 || claimedCurrent.nlink !== 2) {
        await fs.unlink(stalePath);
        continue;
      }
      await fs.unlink(lockPath);
      await fs.unlink(stalePath);
    } catch (error) {
      try { await fs.unlink(stalePath); } catch { /* best effort */ }
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("updater_startup_lock_contended");
}

async function releaseStartupLock(lock: UpdaterStartupLock): Promise<void> {
  try {
    const owner = JSON.parse(await fs.readFile(lock.path, "utf8")) as { token?: unknown };
    if (owner.token !== lock.token) throw new Error("updater_startup_lock_owner_mismatch");
    await fs.unlink(lock.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function reserveUpdaterSocket(socketPath: string, options: UpdaterSocketOptions = {}): Promise<UpdaterSocketReservation> {
  await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(socketPath), 0o700);
  const startupLock = await acquireStartupLock(
    path.dirname(socketPath),
    options.inspectProcess ?? inspectProcess,
    options.afterReadStartupLock,
  );
  const server = http.createServer((_request, response) => {
    send(response, 503, { schema_version: 1, status: "starting", service: "updater" });
  });
  let ownsSocket = false;
  try {
    try {
      await fs.lstat(socketPath);
      if (await socketAlive(socketPath)) throw new Error(`Another updater is listening on ${socketPath}`);
      await fs.unlink(socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(socketPath, () => {
        server.off("error", onError);
        ownsSocket = true;
        resolve();
      });
    });
    await fs.chmod(socketPath, 0o600);
    return { socketPath, server, startupLock };
  } catch (error) {
    try { await new Promise<void>((resolve) => server.close(() => resolve())); } catch { /* best effort */ }
    if (ownsSocket) {
      try { await fs.unlink(socketPath); } catch { /* best effort */ }
    }
    try { await releaseStartupLock(startupLock); } catch { /* preserve the original error */ }
    throw error;
  }
}

export async function releaseUpdaterSocket(reservation: UpdaterSocketReservation): Promise<void> {
  try { await new Promise<void>((resolve) => reservation.server.close(() => resolve())); } catch { /* best effort */ }
  try { await fs.unlink(reservation.socketPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await releaseStartupLock(reservation.startupLock);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0] !== "application/json") throw new ValidationError("Content-Type must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new ValidationError("Request exceeds 64 KiB");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("Request body must be JSON");
  }
}

export class UpdaterApi {
  private server: http.Server | undefined;
  private writerToken: string | undefined;
  private writerLeaseHeld = false;
  private ownsSocket = false;
  private activeReservation: UpdaterSocketReservation | undefined;

  constructor(
    private readonly socketPath: string,
    private readonly controller: UpdateController,
    private readonly database: UpdateDatabase,
    private readonly service: Pick<UpdateService, "isRunning" | "wake">,
    private readonly logger: Logger,
    private readonly buildSha = process.env.DONA_UPDATER_BUILD_SHA ?? "development",
    private readonly reservation?: UpdaterSocketReservation,
  ) {}

  async start(): Promise<void> {
    try {
      const reservation = this.reservation ?? await reserveUpdaterSocket(this.socketPath);
      this.activeReservation = reservation;
      this.server = reservation.server;
      this.ownsSocket = true;
      this.writerToken = reservation.startupLock.token;
      this.database.acquireWriterLease(this.writerToken);
      this.writerLeaseHeld = true;
      this.server.removeAllListeners("request");
      this.server.on("request", (request, response) => void this.handle(request, response));
    } catch (error) {
      if (this.activeReservation) {
        try { await releaseUpdaterSocket(this.activeReservation); } catch { /* preserve the original error */ }
      }
      this.activeReservation = undefined;
      this.server = undefined;
      this.ownsSocket = false;
      this.releaseWriterLease();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.activeReservation && this.ownsSocket) {
      await releaseUpdaterSocket(this.activeReservation);
      this.activeReservation = undefined;
      this.server = undefined;
      this.ownsSocket = false;
    }
    this.releaseWriterLease();
  }

  private releaseWriterLease(): void {
    if (!this.writerLeaseHeld || !this.writerToken) return;
    try {
      this.database.releaseWriterLease(this.writerToken);
      this.writerLeaseHeld = false;
      this.writerToken = undefined;
    } catch (error) {
      this.logger.warn("Updater writer lease release failed", {
        error_code: "updater_writer_lease_release_failed",
        error_message: redactText(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health/version") {
        let ready = this.service.isRunning();
        try {
          this.database.assertReadableWritable();
        } catch {
          ready = false;
        }
        send(response, ready ? 200 : 503, {
          schema_version: 1,
          status: ready ? "ready" : "not_ready",
          service: "updater",
          build_sha: this.buildSha,
          protocol: 1,
          update_schema: 3,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/metrics") {
        const metrics = this.database.metrics();
        const lines = [
          ...Object.entries(metrics.states).map(([state, count]) => `dona_update_state_total{state="${state}"} ${count}`),
          `dona_update_outbox_pending ${metrics.outbox_pending}`,
          "",
        ];
        send(response, 200, lines.join("\n"), "text/plain; version=0.0.4; charset=utf-8");
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/plan") {
        const result = await this.controller.plan(parsePlanRequest(await readJson(request)));
        send(response, result.duplicate ? 200 : 201, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/apply") {
        const result = this.controller.apply(parseApplyRequest(await readJson(request)));
        this.service.wake();
        send(response, result.duplicate ? 200 : 202, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/cancel") {
        const input = parseCancelRequest(await readJson(request));
        const result = this.controller.cancel(input.request_id, input.source_event_id, input.reply_target, input.reason);
        this.service.wake();
        send(response, 200, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/reconcile") {
        const input = await readJson(request) as Record<string, unknown>;
        const requestId = parseRequestId(input.request_id);
        if (Object.keys(input).some((key) => key !== "request_id")) throw new ValidationError("Unsupported reconcile field");
        send(response, 200, await this.controller.reconcile(requestId));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/rollback") {
        const input = await readJson(request) as Record<string, unknown>;
        if (Object.keys(input).some((key) => !["request_id", "plan_hash"].includes(key)) ||
          typeof input.plan_hash !== "string" || !/^[0-9a-f]{64}$/.test(input.plan_hash)) {
          throw new ValidationError("Rollback requires exact request_id and plan_hash");
        }
        send(response, 200, await this.controller.operatorRollback(parseRequestId(input.request_id), input.plan_hash));
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/status") {
        const raw = url.searchParams.get("request_id");
        send(response, 200, await this.controller.status(raw ? parseRequestId(raw) : undefined));
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/doctor") {
        send(response, 200, await this.controller.doctor());
        return;
      }
      send(response, 404, { schema_version: 1, error: { code: "not_found", message: "Route not found" } });
    } catch (error) {
      const validation = error instanceof ValidationError;
      this.logger.error("Updater API request failed", {
        error_code: validation ? "invalid_request" : "request_failed",
        error_message: redactText(error instanceof Error ? error.message : String(error)),
      });
      if (!response.headersSent) send(response, validation ? 400 : 409, {
        schema_version: 1,
        error: { code: validation ? "invalid_request" : "request_failed", message: redactText(error instanceof Error ? error.message : String(error)) },
      });
    }
  }
}
