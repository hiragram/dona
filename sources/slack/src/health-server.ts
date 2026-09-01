import fs from "node:fs/promises";
import http, { type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";

import type { DispatcherClient } from "./dispatcher-client.js";
import type { SlackLogger } from "./logger.js";

function send(response: ServerResponse, statusCode: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": encoded.length,
  });
  response.end(encoded);
}

async function socketIsAlive(socketPath: string): Promise<boolean> {
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
    socket.setTimeout(500, () => finish(false));
  });
}

export interface AdapterHealthState {
  isSocketReady(): boolean;
  isStopping(): boolean;
  connectionStates(): Record<string, string>;
}

export class SlackHealthServer {
  private server: http.Server | undefined;

  constructor(
    private readonly socketPath: string,
    private readonly adapter: AdapterHealthState,
    private readonly dispatcher: Pick<DispatcherClient, "healthReady">,
    private readonly logger: SlackLogger,
  ) {}

  async start(): Promise<void> {
    await fs.mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.socketPath), 0o700);
    try {
      await fs.lstat(this.socketPath);
      if (await socketIsAlive(this.socketPath)) {
        throw new Error(`Another Slack Adapter health server is listening on ${this.socketPath}`);
      }
      await fs.unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    this.server = http.createServer((request, response) => {
      void this.handle(request.method ?? "", request.url ?? "/", response);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server!.once("error", onError);
      this.server!.listen(this.socketPath, () => {
        this.server!.off("error", onError);
        resolve();
      });
    });
    await fs.chmod(this.socketPath, 0o600);
    this.logger.info("Slack Adapter health server started", { health_socket_path: this.socketPath });
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((error) => (error ? reject(error) : resolve()));
      });
      this.server = undefined;
    }
    try {
      await fs.unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async handle(method: string, requestUrl: string, response: ServerResponse): Promise<void> {
    const pathname = new URL(requestUrl, "http://localhost").pathname;
    if (method === "GET" && pathname === "/health/live") {
      send(response, 200, { schema_version: 1, status: "live" });
      return;
    }
    if (method === "GET" && pathname === "/health/ready") {
      const dispatcherReady = await this.dispatcher.healthReady();
      const ready = !this.adapter.isStopping() && this.adapter.isSocketReady() && dispatcherReady;
      send(response, ready ? 200 : 503, {
        schema_version: 1,
        status: ready ? "ready" : "not_ready",
        socket_mode: this.adapter.connectionStates(),
        dispatcher_ready: dispatcherReady,
      });
      return;
    }
    send(response, 404, { schema_version: 1, error: { code: "not_found", message: "Route not found" } });
  }
}
