import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";

import type { DispatcherConfig } from "./config.js";
import type { DispatcherDatabase } from "./database.js";
import type { Logger } from "./logger.js";
import { parseEventEnvelope, RequestValidationError } from "./validation.js";

class BodyTooLargeError extends Error {}
class PersistenceUnavailableError extends Error {}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": encoded.length,
  });
  response.end(encoded);
}

function errorBody(code: string, message: string): unknown {
  return { schema_version: 1, error: { code, message } };
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  let exceeded = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      exceeded = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (exceeded) throw new BodyTooLargeError();
  return Buffer.concat(chunks);
}

async function socketIsAlive(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

export interface ApiWorkerState {
  isRunning(): boolean;
  wake(): void;
}

export class DispatcherApi {
  private server: http.Server | undefined;
  private shuttingDown = false;

  constructor(
    private readonly database: DispatcherDatabase,
    private readonly worker: ApiWorkerState,
    private readonly config: DispatcherConfig,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    await fs.mkdir(path.dirname(this.config.socketPath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.config.socketPath), 0o700);
    await fs.mkdir(this.config.resultsDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.config.resultsDir, 0o700);
    try {
      await fs.lstat(this.config.socketPath);
      if (await socketIsAlive(this.config.socketPath)) {
        throw new Error(`Another dispatcher is already listening on ${this.config.socketPath}`);
      }
      await fs.unlink(this.config.socketPath);
      this.logger.warn("Removed stale dispatcher socket", { socket_path: this.config.socketPath });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    this.server = http.createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server!.once("error", onError);
      this.server!.listen(this.config.socketPath, () => {
        this.server!.off("error", onError);
        resolve();
      });
    });
    await fs.chmod(this.config.socketPath, 0o600);
    this.logger.info("Dispatcher API started", { socket_path: this.config.socketPath });
  }

  beginShutdown(): void {
    this.shuttingDown = true;
  }

  async stop(): Promise<void> {
    this.beginShutdown();
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((error) => (error ? reject(error) : resolve()));
      });
      this.server = undefined;
    }
    try {
      await fs.unlink(this.config.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.logger.info("Dispatcher API stopped");
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health/live") {
        sendJson(response, 200, { schema_version: 1, status: "live" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/health/ready") {
        let ready = !this.shuttingDown && this.worker.isRunning();
        try {
          this.database.assertReadableWritable();
        } catch {
          ready = false;
        }
        sendJson(response, ready ? 200 : 503, { schema_version: 1, status: ready ? "ready" : "not_ready" });
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/v1/events") {
        sendJson(response, 404, errorBody("not_found", "Route not found"));
        return;
      }
      if (this.shuttingDown) {
        sendJson(response, 503, errorBody("shutting_down", "Dispatcher is shutting down"));
        return;
      }
      const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") {
        sendJson(response, 415, errorBody("unsupported_media_type", "Content-Type must be application/json"));
        return;
      }
      const declaredLength = Number(request.headers["content-length"] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > this.config.requestMaxBytes) {
        request.resume();
        sendJson(response, 413, errorBody("request_too_large", "Request body exceeds the configured limit"));
        return;
      }
      const body = await readBody(request, this.config.requestMaxBytes);
      let input: unknown;
      try {
        input = JSON.parse(body.toString("utf8"));
      } catch {
        throw new RequestValidationError("Request body must be valid JSON");
      }
      const envelope = parseEventEnvelope(input);
      let result;
      try {
        result = this.database.enqueue(envelope);
      } catch (error) {
        throw new PersistenceUnavailableError(
          error instanceof Error ? error.message : "Event could not be persisted",
        );
      }
      const row = result.row;
      if (result.payloadMismatch) {
        this.logger.warn("Duplicate event payload differs from the persisted event", {
          event_id: row.event_id,
          source: row.source,
          external_event_id: row.external_event_id,
          sequence: row.sequence,
        });
      }
      this.logger.info(result.duplicate ? "Duplicate event accepted" : "Event persisted", {
        event_id: row.event_id,
        source: row.source,
        external_event_id: row.external_event_id,
        sequence: row.sequence,
        status_to: row.status,
      });
      this.worker.wake();
      sendJson(response, result.duplicate ? 200 : 202, {
        schema_version: 1,
        event_id: row.event_id,
        sequence: row.sequence,
        status: row.status,
        duplicate: result.duplicate,
      });
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendJson(response, 413, errorBody("request_too_large", "Request body exceeds the configured limit"));
      } else if (error instanceof RequestValidationError) {
        sendJson(response, 400, errorBody("invalid_request", error.message));
      } else if (error instanceof PersistenceUnavailableError) {
        this.logger.error("Event could not be persisted", {
          error_code: "persistence_unavailable",
          error_message: error.message,
        });
        sendJson(response, 503, errorBody("persistence_unavailable", "Event could not be persisted"));
      } else {
        this.logger.error("Dispatcher API request failed", {
          error_code: "internal_error",
          error_message: error instanceof Error ? error.message : String(error),
        });
        if (!response.headersSent) sendJson(response, 500, errorBody("internal_error", "Dispatcher internal error"));
        else response.end();
      }
    }
  }
}
