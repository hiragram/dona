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

  constructor(
    private readonly socketPath: string,
    private readonly controller: UpdateController,
    private readonly database: UpdateDatabase,
    private readonly service: Pick<UpdateService, "isRunning" | "wake">,
    private readonly logger: Logger,
    private readonly buildSha = process.env.DONA_UPDATER_BUILD_SHA ?? "development",
  ) {}

  async start(): Promise<void> {
    await fs.mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.socketPath), 0o700);
    try {
      await fs.lstat(this.socketPath);
      if (await socketAlive(this.socketPath)) throw new Error(`Another updater is listening on ${this.socketPath}`);
      await fs.unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.server = http.createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server!.once("error", onError);
      this.server!.listen(this.socketPath, () => {
        this.server!.off("error", onError);
        resolve();
      });
    });
    await fs.chmod(this.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => this.server!.close((error) => error ? reject(error) : resolve()));
      this.server = undefined;
    }
    try {
      await fs.unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health/version") {
        send(response, this.service.isRunning() ? 200 : 503, {
          schema_version: 1,
          status: this.service.isRunning() ? "ready" : "not_ready",
          service: "updater",
          build_sha: this.buildSha,
          protocol: 1,
          update_schema: 1,
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
