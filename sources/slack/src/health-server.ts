import fs from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";

import type { DispatcherClient } from "./dispatcher-client.js";
import type { SlackLogger } from "./logger.js";
import {
  parseUpdateNotificationRequest,
  UpdateNotificationPermanentError,
  type UpdateNotificationPort,
} from "./update-notification.js";
import { parseJobProgressRequest, type SlackJobProgressReporter } from "./job-progress.js";
import { SlackApiError } from "./slack-api.js";

function send(response: ServerResponse, statusCode: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": encoded.length,
  });
  response.end(encoded);
}

async function readPrivateToken(tokenPath: string): Promise<string | undefined> {
  try {
    const stats = await fs.lstat(tokenPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0) {
      return undefined;
    }
    const token = (await fs.readFile(tokenPath, "utf8")).trim();
    return token.length >= 32 ? token : undefined;
  } catch {
    return undefined;
  }
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
  quiesce(): Promise<void>;
  drainStatus(): { quiescing: boolean; drained: boolean; in_flight: number; unsafe_states: string[] };
  trackExternal?<T>(operation: Promise<T>): Promise<T>;
}

export class SlackHealthServer {
  private server: http.Server | undefined;
  private quiesceOperationId: string | undefined;
  private readonly progressOperations = new Set<Promise<unknown>>();

  constructor(
    private readonly socketPath: string,
    private readonly adapter: AdapterHealthState,
    private readonly dispatcher: Pick<DispatcherClient, "healthReady">,
    private readonly logger: SlackLogger,
    private readonly buildSha = process.env.DONA_BUILD_SHA ?? "development",
    private readonly updateNotifications?: UpdateNotificationPort,
    private readonly updateInternalTokenPath?: string,
    private readonly jobProgress?: SlackJobProgressReporter,
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

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "";
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (method === "POST" && pathname === "/v1/internal/update-notifications") {
      if (!this.updateNotifications || !this.updateInternalTokenPath) {
        send(response, 503, {
          schema_version: 1,
          error: { code: "reporter_unavailable", message: "Update reporter is not configured" },
        });
        return;
      }
      if (!(await this.authorized(request))) {
        send(response, 403, { schema_version: 1, error: { code: "forbidden", message: "Internal authentication failed" } });
        return;
      }
      if (this.adapter.isStopping()) {
        send(response, 503, { schema_version: 1, error: { code: "shutting_down", message: "Slack Adapter is stopping" } });
        return;
      }
      try {
        const input = parseUpdateNotificationRequest(await this.readJson(request));
        const result = await this.updateNotifications.deliver(input);
        send(response, 200, { schema_version: 1, ...result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const invalid = message.startsWith("notification ");
        const permanent = error instanceof UpdateNotificationPermanentError;
        const errorCode = invalid
          ? "invalid_update_notification"
          : permanent
            ? error.code
            : "update_notification_failed";
        this.logger.error("Slack update notification failed", {
          error_code: errorCode,
          error_message: message,
        });
        send(response, invalid ? 400 : permanent ? 409 : 503, {
          schema_version: 1,
          ...(error instanceof UpdateNotificationPermanentError && error.receipt
            ? { receipt: error.receipt }
            : {}),
          error: {
            code: errorCode,
            message: invalid || permanent ? message : "Slack update notification could not be completed",
          },
        });
      }
      return;
    }
    if (method === "POST" && pathname === "/v1/internal/job-progress") {
      if (!this.jobProgress || !this.updateInternalTokenPath) {
        send(response, 503, { schema_version: 1, error: { code: "reporter_unavailable" } });
        return;
      }
      let finishAdmission!:()=>void;
      const admission=new Promise<void>((resolve)=>{finishAdmission=resolve;});
      this.progressOperations.add(admission);
      try {
      if (!(await this.authorized(request))) {
        send(response, 403, { schema_version: 1, error: { code: "forbidden" } });
        return;
      }
      if (this.adapter.isStopping()) {
        send(response, 429, { schema_version: 1, error: { code: "shutting_down" } });
        return;
      }
      try {
        const input = parseJobProgressRequest(await this.readJson(request));
        if (this.adapter.isStopping()) {
          send(response, 429, { schema_version: 1, error: { code: "shutting_down" } });
          return;
        }
        const operation = this.jobProgress.deliver(input);
        this.progressOperations.add(operation);
        void operation.finally(()=>this.progressOperations.delete(operation)).catch(()=>undefined);
        const result = await (this.adapter.trackExternal?.(operation) ?? operation);
        send(response, 200, { schema_version: 1, ...result });
      } catch (error) {
        this.logger.error("Slack job progress failed", {
          error_code: "job_progress_failed",
          error_message: error instanceof Error ? error.message : String(error),
        });
        const permanentSlackCodes=new Set(["invalid_auth","account_inactive","token_revoked","not_authed","missing_scope","not_allowed_token_type","invalid_arguments","invalid_arg_name","invalid_array_arg","invalid_charset","invalid_form_data","invalid_post_type","channel_not_found","not_in_channel","thread_not_found","method_not_supported_for_channel_type"]);
        const ambiguousSlackCodes=new Set(["slack_transport_error","slack_http_error","slack_api_error","invalid_slack_response"]);
        const permanentSlackRejection = error instanceof SlackApiError && permanentSlackCodes.has(error.errorCode);
        const retryableSlackRejection = error instanceof SlackApiError && !permanentSlackRejection && !ambiguousSlackCodes.has(error.errorCode);
        const permanentProgressRejection = (error as Error & { progressPermanent?:boolean }).progressPermanent === true;
        const definitelyUnsent = retryableSlackRejection || (error as Error & { definitelyUnsent?:boolean }).definitelyUnsent === true;
        send(response, permanentSlackRejection || permanentProgressRejection ? 409 : definitelyUnsent ? 429 : 503, { schema_version: 1,
          ...(error instanceof SlackApiError && error.retryAfterSeconds !== undefined ? { retry_after_seconds:error.retryAfterSeconds } : {}),
          error: { code: error instanceof SlackApiError ? error.errorCode : definitelyUnsent ? "progress_not_sent" : "job_progress_failed" } });
      }
      } finally {
        finishAdmission();
        this.progressOperations.delete(admission);
      }
      return;
    }
    if (method === "POST" && pathname === "/v1/internal/job-progress/drain") {
      if (!this.jobProgress || !this.updateInternalTokenPath) { send(response,503,{schema_version:1,error:{code:"reporter_unavailable"}}); return; }
      if (!(await this.authorized(request))) { send(response,403,{schema_version:1,error:{code:"forbidden"}}); return; }
      await Promise.allSettled([...this.progressOperations]);
      send(response,200,{schema_version:1,drained:true}); return;
    }
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
    if (method === "GET" && pathname === "/health/version") {
      const dispatcherReady = await this.dispatcher.healthReady();
      const workspacesReady = !this.adapter.isStopping() && this.adapter.isSocketReady();
      const ready = workspacesReady && dispatcherReady;
      const updateNotificationProtocolReady = this.updateNotifications !== undefined &&
        await this.internalTokenReady();
      send(response, ready ? 200 : 503, {
        schema_version: 1,
        status: ready ? "ready" : "not_ready",
        service: "slack_adapter",
        build_sha: this.buildSha,
        protocol: 1,
        app_schema: 3,
        app_schema_read_min: 2,
        app_schema_read_max: 3,
        app_schema_write: 3,
        config: 1,
        ...(updateNotificationProtocolReady ? { update_notification_protocol: 1 } : {}),
        workspaces_ready: workspacesReady,
        socket_mode: this.adapter.connectionStates(),
        dispatcher_ready: dispatcherReady,
      });
      return;
    }
    if (method === "GET" && pathname === "/v1/admin/drain-status") {
      send(response, 200, { schema_version: 1, protocol: 1, service: "slack_adapter", ...this.adapter.drainStatus() });
      return;
    }
    if (method === "POST" && pathname === "/v1/admin/quiesce") {
      let input: Record<string, unknown>;
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > 16_384) throw new Error("body too large");
          chunks.push(buffer);
        }
        input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        send(response, 400, { schema_version: 1, error: { code: "invalid_request", message: "Quiesce request must be JSON" } });
        return;
      }
      if (!input || typeof input !== "object" || Object.keys(input).some((key) => !["schema_version", "protocol", "operation_id", "target_sha"].includes(key)) ||
        input.schema_version !== 1 || input.protocol !== 1 || typeof input.operation_id !== "string" || !/^upd_[0-9a-hjkmnp-tv-z]{26}$/.test(input.operation_id) ||
        typeof input.target_sha !== "string" || !/^[0-9a-f]{40}$/.test(input.target_sha)) {
        send(response, 400, { schema_version: 1, error: { code: "invalid_request", message: "Quiesce request is invalid" } });
        return;
      }
      if (this.quiesceOperationId && this.quiesceOperationId !== input.operation_id) {
        send(response, 409, { schema_version: 1, error: { code: "already_quiescing", message: "Adapter is quiescing for another update" } });
        return;
      }
      this.quiesceOperationId = input.operation_id;
      await this.adapter.quiesce();
      const status = this.adapter.drainStatus();
      send(response, status.drained ? 200 : 409, { schema_version: 1, protocol: 1, service: "slack_adapter", ...status });
      return;
    }
    send(response, 404, { schema_version: 1, error: { code: "not_found", message: "Route not found" } });
  }

  private async authorized(request: IncomingMessage): Promise<boolean> {
    const supplied = request.headers["x-dona-update-token"];
    if (typeof supplied !== "string" || !this.updateInternalTokenPath) return false;
    const expected = await readPrivateToken(this.updateInternalTokenPath);
    return expected !== undefined && supplied.length === expected.length &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  }

  private async internalTokenReady(): Promise<boolean> {
    if (!this.updateInternalTokenPath) return false;
    return (await readPrivateToken(this.updateInternalTokenPath)) !== undefined;
  }

  private async readJson(request: IncomingMessage): Promise<unknown> {
    if (request.headers["content-type"]?.split(";", 1)[0] !== "application/json") {
      throw new Error("notification content type must be application/json");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 64 * 1024) throw new Error("notification body exceeds 64 KiB");
      chunks.push(buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("notification body must be JSON");
    }
  }
}
