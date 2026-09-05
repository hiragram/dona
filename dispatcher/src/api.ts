import fs from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";

import type { DispatcherConfig } from "./config.js";
import { JobCreationError, type DispatcherDatabase } from "./database.js";
import type { Logger } from "./logger.js";
import type { JobControlResult } from "./job-supervisor.js";
import { envelopeFromRow } from "./prompt.js";
import { readPrivateToken } from "./private-token.js";
import { UpdaterClientError } from "./updater-client.js";
import {
  jobKeyPattern,
  parseCancelJobRequest,
  parseCreateJobRequest,
  parseEventEnvelope,
  parseInternalUpdateEventEnvelope,
  parseSteerJobRequest,
  RequestValidationError,
  stableStringify,
} from "./validation.js";

class BodyTooLargeError extends Error {}
class PersistenceUnavailableError extends Error {}
class ApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

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
  isHealthy?(): boolean;
  wake(): void;
}

export interface ApiJobController {
  isRunning(): boolean;
  wake(): void;
  steer(jobId: string, sourceEventId: string, instruction: string): Promise<JobControlResult>;
  cancel(jobId: string, sourceEventId: string, reason?: string): Promise<JobControlResult>;
}

export interface ApiUpdateClient {
  plan(input: unknown): Promise<Record<string, unknown>>;
  apply(input: unknown): Promise<Record<string, unknown>>;
  status(requestId?: string): Promise<Record<string, unknown>>;
  cancel(input: unknown): Promise<Record<string, unknown>>;
}

export interface ApiQuiesceController {
  quiesce(): Promise<void>;
}

export class DispatcherApi {
  private server: http.Server | undefined;
  private shuttingDown = false;
  private quiesceOperationId: string | undefined;
  private quiescePromise: Promise<void> | undefined;
  private quiesceComplete = false;
  private quiesceError: string | undefined;

  constructor(
    private readonly database: DispatcherDatabase,
    private readonly worker: ApiWorkerState,
    private readonly jobs: ApiJobController,
    private readonly config: DispatcherConfig,
    private readonly logger: Logger,
    private readonly updates?: ApiUpdateClient,
    private readonly quiesceController?: ApiQuiesceController,
    private readonly updateNotifications?: ApiWorkerState,
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
        let ready = !this.shuttingDown && this.worker.isRunning() && this.jobs.isRunning() &&
          (this.updateNotifications?.isRunning() ?? true) && (this.updateNotifications?.isHealthy?.() ?? true);
        try {
          this.database.assertReadableWritable();
        } catch {
          ready = false;
        }
        sendJson(response, ready ? 200 : 503, { schema_version: 1, status: ready ? "ready" : "not_ready" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/health/version") {
        let ready = !this.shuttingDown && this.worker.isRunning() && this.jobs.isRunning() &&
          (this.updateNotifications?.isRunning() ?? true) && (this.updateNotifications?.isHealthy?.() ?? true);
        try {
          this.database.assertReadableWritable();
        } catch {
          ready = false;
        }
        const appSchema = this.database.schemaCompatibility();
        sendJson(response, ready ? 200 : 503, {
          schema_version: 1,
          status: ready ? "ready" : "not_ready",
          service: "dispatcher",
          build_sha: this.config.buildSha,
          protocol: 1,
          app_schema: appSchema.actual,
          app_schema_read_min: appSchema.read_min,
          app_schema_read_max: appSchema.read_max,
          app_schema_write: appSchema.write,
          config: 1,
          ...(this.updateNotifications ? { update_notification_protocol: 1 } : {}),
        });
        return;
      }
      if (request.method === "GET" && /^\/v1\/events\/[^/]+\/terminal$/.test(url.pathname)) {
        const eventId = decodeURIComponent(url.pathname.split("/")[3]!);
        if (!/^evt_[0-9A-HJKMNP-TV-Z]{26}$/i.test(eventId)) throw new ApiRequestError(400, "invalid_request", "event_id is invalid");
        sendJson(response, 200, { schema_version: 1, event_id: eventId, terminal: this.database.isEventCompleted(eventId) });
        return;
      }
      if (request.method === "GET" && /^\/v1\/events\/[^/]+\/jobs$/.test(url.pathname)) {
        const sourceEventId = decodeURIComponent(url.pathname.split("/")[3]!);
        if (!/^evt_[0-9A-HJKMNP-TV-Z]{26}$/i.test(sourceEventId)) {
          throw new ApiRequestError(400, "invalid_request", "source_event_id is invalid");
        }
        const requestedJobKey = url.searchParams.get("job_key");
        const jobKey = requestedJobKey?.trim();
        if (jobKey !== undefined && !jobKeyPattern.test(jobKey)) {
          throw new ApiRequestError(400, "invalid_request", "job_key is invalid");
        }
        const canonicalPayloadSha256 = url.searchParams.get("canonical_payload_sha256") ?? undefined;
        if (canonicalPayloadSha256 !== undefined && !/^[0-9a-f]{64}$/.test(canonicalPayloadSha256)) {
          throw new ApiRequestError(400, "invalid_request", "canonical_payload_sha256 is invalid");
        }
        if (canonicalPayloadSha256 !== undefined && jobKey === undefined) {
          throw new ApiRequestError(400, "invalid_request", "job_key is required for payload reconciliation");
        }
        sendJson(response, 200, {
          schema_version: 1,
          source_event_id: sourceEventId,
          jobs: this.database.listEventJobs(sourceEventId, jobKey),
          ...(canonicalPayloadSha256 !== undefined && jobKey !== undefined
            ? { reconciliation: this.database.reconcileEventJob(sourceEventId, jobKey, canonicalPayloadSha256) }
            : {}),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/update-safety") {
        sendJson(response, 200, { schema_version: 1, ...this.database.updateSafetyStatus() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/drain-status") {
        const safety = this.database.updateSafetyStatus();
        const unsafeStates = [...safety.unsafe_states, ...(this.quiesceError ? ["dispatcher.quiesce_failed"] : [])];
        sendJson(response, 200, {
          schema_version: 1,
          protocol: 1,
          service: "dispatcher",
          quiescing: this.shuttingDown,
          drained: this.shuttingDown && this.quiesceComplete && unsafeStates.length === 0 &&
            !this.worker.isRunning() && !this.jobs.isRunning(),
          in_flight: unsafeStates.length,
          unsafe_states: unsafeStates,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/quiesce") {
        const input = await this.readJson(request) as Record<string, unknown>;
        if (Object.keys(input).some((key) => !["schema_version", "protocol", "operation_id", "target_sha"].includes(key)) ||
          input.schema_version !== 1 || input.protocol !== 1 || typeof input.operation_id !== "string" || !/^upd_[0-9a-hjkmnp-tv-z]{26}$/.test(input.operation_id) ||
          typeof input.target_sha !== "string" || !/^[0-9a-f]{40}$/.test(input.target_sha)) {
          throw new ApiRequestError(400, "invalid_request", "Quiesce request is invalid");
        }
        if (this.quiesceOperationId && this.quiesceOperationId !== input.operation_id) {
          throw new ApiRequestError(409, "already_quiescing", "Dispatcher is quiescing for a different update");
        }
        this.quiesceOperationId = input.operation_id;
        this.beginShutdown();
        if (!this.quiescePromise) {
          this.quiescePromise = Promise.resolve(this.quiesceController?.quiesce())
            .then(() => {
              this.quiesceComplete = true;
            })
            .catch((error: unknown) => {
              this.quiesceError = error instanceof Error ? error.message : String(error);
              this.logger.error("Dispatcher quiesce failed", {
                error_code: "quiesce_failed",
                error_message: this.quiesceError,
              });
            });
        }
        const safety = this.database.updateSafetyStatus();
        const unsafeStates = [...safety.unsafe_states, ...(this.quiesceError ? ["dispatcher.quiesce_failed"] : [])];
        const drained = this.quiesceComplete && unsafeStates.length === 0 &&
          !this.worker.isRunning() && !this.jobs.isRunning();
        sendJson(response, drained ? 200 : 202, {
          schema_version: 1,
          protocol: 1,
          service: "dispatcher",
          quiescing: true,
          drained,
          in_flight: unsafeStates.length,
          unsafe_states: unsafeStates,
        });
        return;
      }
      if (url.pathname.startsWith("/v1/internal/update-events")) {
        await this.handleInternalUpdate(request, response, url);
        return;
      }
      if (url.pathname.startsWith("/v1/self-update/")) {
        await this.handleSelfUpdate(request, response, url);
        return;
      }
      if (url.pathname === "/v1/jobs" || url.pathname.startsWith("/v1/jobs/")) {
        await this.handleJobs(request, response, url);
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
      const input = await this.readJson(request);
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
      } else if (error instanceof ApiRequestError) {
        sendJson(response, error.status, errorBody(error.code, error.message));
      } else if (error instanceof UpdaterClientError) {
        this.logger.warn("Updater request rejected", {
          error_code: error.code,
          error_message: error.message,
          status_code: error.statusCode,
        });
        sendJson(response, error.statusCode, errorBody(error.code, error.message));
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

  private async handleSelfUpdate(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (!this.updates) throw new ApiRequestError(503, "updater_unavailable", "Updater client is not configured");
    if (this.shuttingDown && request.method !== "GET") {
      throw new ApiRequestError(503, "shutting_down", "Dispatcher is not accepting self-update writes while quiescing");
    }
    if (request.method === "POST" && url.pathname === "/v1/self-update/plan") {
      const input = await this.readJson(request) as Record<string, unknown>;
      if (Object.keys(input).some((key) => key !== "source_event_id") ||
        typeof input.source_event_id !== "string" || !/^evt_[0-9A-HJKMNP-TV-Z]{26}$/i.test(input.source_event_id)) {
        throw new ApiRequestError(400, "invalid_request", "source_event_id is invalid");
      }
      const event = this.database.get(input.source_event_id);
      if (!event || event.source !== "slack" || !event.reply_target_json) {
        throw new ApiRequestError(400, "invalid_update_context", "Source event does not have a persisted Slack reply target");
      }
      sendJson(response, 200, await this.updates.plan({
        source_event_id: event.event_id,
        reply_target: JSON.parse(event.reply_target_json) as Record<string, unknown>,
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/self-update/apply") {
      const input = await this.readJson(request) as Record<string, unknown>;
      const keys = ["source_event_id", "plan_id", "plan_hash", "approval_id"];
      if (Object.keys(input).some((key) => !keys.includes(key)) || keys.some((key) => typeof input[key] !== "string")) {
        throw new ApiRequestError(400, "invalid_request", "Apply request fields are invalid");
      }
      const event = this.updateEventContext(input.source_event_id as string);
      sendJson(response, 202, await this.updates.apply({
        ...input,
        reply_target: JSON.parse(event.reply_target_json!) as Record<string, unknown>,
      }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/self-update/status") {
      const requestId = url.searchParams.get("request_id") ?? undefined;
      if (requestId && !/^upd_[0-9a-hjkmnp-tv-z]{26}$/.test(requestId)) throw new ApiRequestError(400, "invalid_request", "request_id is invalid");
      sendJson(response, 200, await this.updates.status(requestId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/self-update/cancel") {
      const input = await this.readJson(request) as Record<string, unknown>;
      const keys = ["source_event_id", "request_id", "reason"];
      if (Object.keys(input).some((key) => !keys.includes(key)) || typeof input.source_event_id !== "string" || typeof input.request_id !== "string") {
        throw new ApiRequestError(400, "invalid_request", "Cancel request fields are invalid");
      }
      const event = this.updateEventContext(input.source_event_id as string);
      sendJson(response, 200, await this.updates.cancel({
        ...input,
        reply_target: JSON.parse(event.reply_target_json!) as Record<string, unknown>,
      }));
      return;
    }
    throw new ApiRequestError(404, "not_found", "Route not found");
  }

  private updateEventContext(eventId: string) {
    if (!/^evt_[0-9A-HJKMNP-TV-Z]{26}$/i.test(eventId)) {
      throw new ApiRequestError(400, "invalid_request", "source_event_id is invalid");
    }
    const event = this.database.get(eventId);
    if (!event || event.source !== "slack" || !event.reply_target_json) {
      throw new ApiRequestError(400, "invalid_update_context", "Source event does not have a persisted Slack reply target");
    }
    return event;
  }

  private async handleInternalUpdate(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (!(await this.authorizedUpdateRequest(request))) throw new ApiRequestError(403, "forbidden", "Internal updater authentication failed");
    if (request.method === "POST" && url.pathname === "/v1/internal/update-events") {
      const envelope = parseInternalUpdateEventEnvelope(await this.readJson(request));
      const result = this.database.enqueue(envelope);
      if (result.payloadMismatch) throw new ApiRequestError(409, "completion_payload_mismatch", "Stable external ID already exists with different payload");
      this.updateNotifications?.wake();
      sendJson(response, result.duplicate ? 200 : 202, {
        schema_version: 1,
        event_id: result.row.event_id,
        duplicate: result.duplicate,
        payload_mismatch: result.payloadMismatch,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/internal/update-events/lookup") {
      const externalEventId = url.searchParams.get("external_event_id");
      const expectedPayloadSha256 = url.searchParams.get("payload_sha256");
      if (!externalEventId || !/^update:upd_[0-9a-hjkmnp-tv-z]{26}:terminal:\d+$/.test(externalEventId)) {
        throw new ApiRequestError(400, "invalid_request", "external_event_id is invalid");
      }
      if (!expectedPayloadSha256 || !/^[0-9a-f]{64}$/.test(expectedPayloadSha256)) {
        throw new ApiRequestError(400, "invalid_request", "payload_sha256 is invalid");
      }
      const row = this.database.getByExternalId("dona_update", externalEventId);
      if (!row) throw new ApiRequestError(404, "not_found", "Completion event was not found");
      const persistedPayloadSha256 = createHash("sha256")
        .update(stableStringify(envelopeFromRow(row)))
        .digest("hex");
      if (persistedPayloadSha256 !== expectedPayloadSha256) {
        throw new ApiRequestError(409, "completion_payload_mismatch", "Completion event payload does not match the outbox");
      }
      sendJson(response, 200, { schema_version: 1, exists: true, event_id: row.event_id, status: row.status });
      return;
    }
    throw new ApiRequestError(404, "not_found", "Route not found");
  }

  private async authorizedUpdateRequest(request: IncomingMessage): Promise<boolean> {
    const supplied = request.headers["x-dona-update-token"];
    if (typeof supplied !== "string") return false;
    const expected = await readPrivateToken(this.config.updateInternalTokenPath);
    if (!expected || supplied.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  }

  private async handleJobs(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (this.shuttingDown && request.method !== "GET") {
      throw new ApiRequestError(503, "shutting_down", "Dispatcher is shutting down");
    }
    if (request.method === "POST" && url.pathname === "/v1/jobs") {
      const input = parseCreateJobRequest(await this.readJson(request));
      let result;
      try {
        result = this.database.createJob(input, this.config.jobsWorkspaceRoot, this.config.jobResultsDir);
      } catch (error) {
        if (error instanceof JobCreationError) {
          if (error.limitDetails) {
            this.logger.warn("Job creation rejected by resource limit", {
              error_code: error.code,
              resource: error.limitDetails.resource,
              current_value: error.limitDetails.current,
              attempted_value: error.limitDetails.attempted,
              limit_value: error.limitDetails.maximum,
            });
          }
          throw new ApiRequestError(409, error.code, error.message);
        }
        throw new ApiRequestError(400, "invalid_job", error instanceof Error ? error.message : String(error));
      }
      this.jobs.wake();
      sendJson(response, result.duplicate ? 200 : 202, {
        schema_version: 1,
        outcome: result.outcome,
        duplicate: result.duplicate,
        job: result.row,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/jobs") {
      const workspaceId = url.searchParams.get("workspace_id");
      const channelId = url.searchParams.get("channel_id");
      const threadTs = url.searchParams.get("thread_ts");
      if (!workspaceId || !channelId || !threadTs) {
        throw new ApiRequestError(400, "invalid_request", "workspace_id, channel_id, and thread_ts are required");
      }
      sendJson(response, 200, {
        schema_version: 1,
        jobs: this.database.listThreadJobs(workspaceId, channelId, threadTs),
      });
      return;
    }
    const match = /^\/v1\/jobs\/([^/]+)(?:\/(steer|cancel))?$/.exec(url.pathname);
    if (!match) throw new ApiRequestError(404, "not_found", "Route not found");
    const jobId = match[1]!;
    const action = match[2];
    if (request.method === "GET" && !action) {
      const job = this.database.getJob(jobId);
      if (!job) throw new ApiRequestError(404, "job_not_found", `Job ${jobId} was not found`);
      sendJson(response, 200, { schema_version: 1, job });
      return;
    }
    if (request.method === "POST" && action === "steer") {
      const input = parseSteerJobRequest(await this.readJson(request));
      try {
        const result = await this.jobs.steer(jobId, input.source_event_id, input.instruction);
        sendJson(response, 200, { schema_version: 1, duplicate: result.duplicate, job: result.row });
      } catch (error) {
        throw new ApiRequestError(409, "job_steer_failed", error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (request.method === "POST" && action === "cancel") {
      const input = parseCancelJobRequest(await this.readJson(request));
      try {
        const result = await this.jobs.cancel(jobId, input.source_event_id, input.reason);
        sendJson(response, 200, { schema_version: 1, duplicate: result.duplicate, job: result.row });
      } catch (error) {
        throw new ApiRequestError(409, "job_cancel_failed", error instanceof Error ? error.message : String(error));
      }
      return;
    }
    throw new ApiRequestError(404, "not_found", "Route not found");
  }

  private async readJson(request: IncomingMessage): Promise<unknown> {
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new ApiRequestError(415, "unsupported_media_type", "Content-Type must be application/json");
    }
    const declaredLength = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > this.config.requestMaxBytes) {
      request.resume();
      throw new BodyTooLargeError();
    }
    const body = await readBody(request, this.config.requestMaxBytes);
    try {
      return JSON.parse(body.toString("utf8"));
    } catch {
      throw new RequestValidationError("Request body must be valid JSON");
    }
  }
}
