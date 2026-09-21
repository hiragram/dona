import fs from "node:fs/promises";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";

import type { DispatcherConfig } from "./config.js";
import { agentBodyEventOperations, agentOperation, type AgentContextManager, type AgentExecutionContext } from "./agent-context.js";
import { AgentReadAuthorization, projectAuthorizedJob, projectCompletionJob, type AgentReadSurface } from "./agent-read-authorization.js";
import { HumanWaitQueryError, HumanWaitQueryService } from "./human-wait-query.js";
import { hasExplicitOwnHumanWaitIntent, HumanWaitPresentationError, renderHumanWaits } from "./human-wait-presentation.js";
import { dispatcherSchemaCompatibility, JobCreationError, ScheduledJobCreationError, type DispatcherDatabase } from "./database.js";
import type { Logger } from "./logger.js";
import type { JobControlResult } from "./job-supervisor.js";
import type { JobRow } from "./types.js";
import type { LiveSessionReceiptProjection } from "./live-session.js";
import { envelopeFromRow } from "./prompt.js";
import { readPrivateToken } from "./private-token.js";
import { UpdaterClientError } from "./updater-client.js";
import { ScheduleApiError, ScheduleApiService } from "./scheduler/api.js";
import { ScheduleError } from "./scheduler/errors.js";
import { PrincipalBindingConflictError } from "./principal-binding.js";
import { PrincipalProofError, verifySlackPrincipalProof } from "./principal-proof.js";
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
const agentReadCandidateScanMax = 1_000;
export async function confirmScheduleAccess(socketPath:string,internalToken:string,input:Record<string,unknown>,timeoutMs:number):Promise<Record<string,unknown>> {
  const encoded=Buffer.from(JSON.stringify({schema_version:1,...input}));
  return new Promise((resolve,reject)=>{const request=http.request({socketPath,path:"/v1/internal/schedule-access-confirmations",method:"POST",headers:{"content-type":"application/json","content-length":String(encoded.length),"x-dona-update-token":internalToken}},response=>{
    const chunks:Buffer[]=[];response.on("data",(chunk:Buffer)=>chunks.push(chunk));response.on("end",()=>{try {const body=JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string,unknown>;if(response.statusCode!==200||body.authorized!==true)throw new Error("schedule_access_not_confirmed");resolve(body);}catch(error){reject(error);}});
  });request.setTimeout(timeoutMs,()=>request.destroy(new Error("schedule_access_confirmation_timeout")));request.once("error",reject);request.end(encoded);});
}
export function scheduleAccessConfirmationTimeout(issuedAt:string,now=Date.now()):number {
  const remaining=Date.parse(issuedAt)+120_000-now-1_000;
  if(!Number.isFinite(remaining)||remaining<=0) throw new Error("schedule_access_receipt_expired");
  return Math.min(140_000,remaining);
}
class PersistenceUnavailableError extends Error {}
class ApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?:Record<string,unknown>) {
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

function errorBody(code: string, message: string, details?:Record<string,unknown>): unknown {
  return { schema_version: 1, error: { code, message, ...(details?{details}:{}) } };
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

function agentRouteEventId(url: URL): string | undefined {
  const match = /^\/v1\/(?:events|scheduled-jobs|job-notifications)\/([^/]+)\/(?:jobs|delegate|access|authorize)$/.exec(url.pathname);
  if (match) return decodeURIComponent(match[1]!);
  return url.searchParams.get("source_event_id") ?? undefined;
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
  observeLiveSession?(jobId:string,sourceEventId?:string):Promise<LiveSessionReceiptProjection>;
  getLiveSessionReceipt?(jobId:string,receiptId:string):LiveSessionReceiptProjection|undefined;
}

function projectLiveJobResponse(job:Record<string,unknown>,receipt:LiveSessionReceiptProjection):Record<string,unknown>{
  const safeKeys=["job_id","source_event_id","job_key","status","created_at","updated_at","completed_at","dispatch_started_at","prompt_accepted_at","last_error_code","steer_event_id","steer_state","completion_event_id","notification_state","notification_authorization_phase"];
  const safeJob=Object.fromEntries(safeKeys.filter(key=>key in job).map(key=>[key,job[key]]));
  return {schema_version:1,job:safeJob,live_session:receipt.live_session,reconciliation:receipt.reconciliation,
    receipt:{receipt_id:receipt.receipt_id,observed_at:receipt.observed_at,boot_id:receipt.boot_id,
      durable_status_before:receipt.durable_status_before,durable_status_after:receipt.durable_status_after,
      result_present_before:receipt.result_present_before,result_present_after:receipt.result_present_after}};
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

export interface ApiHumanWaitAccessVerifier {
  authorize(input: { event_id: string; workspace_id: string; channel_id: string; user_id: string }): Promise<boolean>;
}

const agentUpdateStatusKeys = [
  "request_id", "state", "current_sha", "target_sha", "previous_sha", "policy_version",
  "rollback_compatible", "last_error_code", "created_at", "updated_at", "completed_at", "observed_active_sha",
] as const;

function projectAgentUpdateStatus(update: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(agentUpdateStatusKeys.filter(key => key in update).map(key => [key, update[key]]));
}
export interface ApiSchedulerState {
  operationalState(): { running: boolean; last_purge_at: string | null };
}

export interface ApiJobProgressResolver {
  resolveDelivery(progressId: string, deliveryToken: string): Record<string, string> | undefined;
  deliveryDeferred?(progressId: string, deliveryToken: string): boolean;
}

export class DispatcherApi {
  private server: http.Server | undefined;
  private agentServer: http.Server | undefined;
  private ownsAgentSocket = false;
  private ownsAgentCredential = false;
  private shuttingDown = false;
  private quiesceOperationId: string | undefined;
  private quiescePromise: Promise<void> | undefined;
  private quiesceComplete = false;
  private quiesceError: string | undefined;
  private readonly schedules: ScheduleApiService;
  private readonly verifiedAgentContexts = new WeakMap<IncomingMessage, AgentExecutionContext>();
  private readonly agentReads: AgentReadAuthorization;

  constructor(
    private readonly database: DispatcherDatabase,
    private readonly worker: ApiWorkerState,
    private readonly jobs: ApiJobController,
    private readonly config: DispatcherConfig,
    private readonly logger: Logger,
    private readonly updates?: ApiUpdateClient,
    private readonly quiesceController?: ApiQuiesceController,
    private readonly updateNotifications?: ApiWorkerState,
    private jobProgress?: ApiJobProgressResolver,
    scheduleNow: () => Date = () => new Date(),
    wakeScheduler: () => void = () => {},
    private readonly schedulerState?: ApiSchedulerState,
    private readonly agentContexts?: AgentContextManager,
    agentReads?: AgentReadAuthorization,
    private readonly humanWaitAccess?: ApiHumanWaitAccessVerifier,
  ) {
    this.schedules = new ScheduleApiService(database, scheduleNow, () => { wakeScheduler(); jobs.wake(); });
    this.agentReads = agentReads ?? new AgentReadAuthorization();
  }

  disableJobProgress(): void { this.jobProgress = undefined; }

  async start(): Promise<void> {
    await fs.mkdir(path.dirname(this.config.socketPath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.config.socketPath), 0o700);
    await fs.mkdir(path.dirname(this.config.agentSocketPath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.config.agentSocketPath), 0o700);
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
    if (this.agentContexts) {
      try {
        await fs.lstat(this.config.agentSocketPath);
        if (await socketIsAlive(this.config.agentSocketPath)) throw new Error(`Another agent API is already listening on ${this.config.agentSocketPath}`);
        await fs.unlink(this.config.agentSocketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.agentContexts.initialize();
      this.ownsAgentCredential = true;
      this.agentServer = http.createServer((request, response) => void this.handle(request, response, true));
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        this.agentServer!.once("error", onError);
        this.agentServer!.listen(this.config.agentSocketPath, () => {
          this.agentServer!.off("error", onError);
          this.ownsAgentSocket = true;
          resolve();
        });
      });
      await fs.chmod(this.config.agentSocketPath, 0o600);
    }
    this.logger.info("Dispatcher API started", { socket_path: this.config.socketPath });
  }

  beginShutdown(): void {
    this.shuttingDown = true;
  }

  private readiness(): { ready: boolean; scheduler: Record<string, unknown> } {
    let ready = !this.shuttingDown && this.worker.isRunning() && this.jobs.isRunning() &&
      (this.updateNotifications?.isRunning() ?? true) && (this.updateNotifications?.isHealthy?.() ?? true);
    let operations: ReturnType<DispatcherDatabase["scheduler"]["operationalSnapshot"]> | undefined;
    try {
      this.database.assertReadableWritable();
      operations = this.database.scheduler.operationalSnapshot(new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
    } catch { ready = false; }
    const scheduler = this.schedulerState?.operationalState();
    ready = ready && operations !== undefined && (scheduler?.running ?? true) && operations.authorization_expired === 0 &&
      operations.stale_claims === 0 && operations.retention_overdue === 0;
    return { ready, scheduler: operations === undefined ? { ...scheduler, error_code: "scheduler_storage_unavailable" } : { ...scheduler, ...operations } };
  }

  async stop(): Promise<void> {
    this.beginShutdown();
    const ownsSocket = this.server?.listening === true;
    const ownsAgentSocket = this.ownsAgentSocket;
    if (this.server?.listening) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    if (this.agentServer?.listening) {
      await new Promise<void>((resolve, reject) => {
        this.agentServer!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    this.agentServer = undefined;
    this.ownsAgentSocket = false;
    if (this.ownsAgentCredential) await this.agentContexts?.revoke();
    this.ownsAgentCredential = false;
    this.server = undefined;
    if (ownsSocket) {
      try {
        await fs.unlink(this.config.socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (ownsAgentSocket) {
      try { await fs.unlink(this.config.agentSocketPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.logger.info("Dispatcher API stopped");
  }

  private async handle(request: IncomingMessage, response: ServerResponse, agentPlane = false): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (agentPlane) {
        const operation = agentOperation(request.method, url);
        const token = typeof request.headers["x-dona-agent-token"] === "string" ? request.headers["x-dona-agent-token"] : undefined;
        const eventId = typeof request.headers["x-dona-source-event-id"] === "string" ? request.headers["x-dona-source-event-id"] : undefined;
        const context = operation ? this.agentContexts?.authorize(token, eventId, operation) : undefined;
        const routeEventId = agentRouteEventId(url);
        if (!context || (routeEventId !== undefined && !this.agentContexts?.allowsRouteEvent(context, operation!, routeEventId))) {
          throw new ApiRequestError(403, "agent_context_unavailable", "Agent operation is not available");
        }
        this.verifiedAgentContexts.set(request, context);
      }
      if (request.method === "GET" && url.pathname === "/health/live") {
        sendJson(response, 200, { schema_version: 1, status: "live" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/health/ready") {
        const health = this.readiness();
        sendJson(response, health.ready ? 200 : 503, { schema_version: 1, status: health.ready ? "ready" : "not_ready", scheduler: health.scheduler });
        return;
      }
      if (request.method === "GET" && url.pathname === "/metrics/scheduler") {
        sendJson(response, 200, { schema_version: 1,
          scheduler: this.database.scheduler.operationalSnapshot(new Date().toISOString().replace(/\.\d{3}Z$/, "Z")) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/health/version") {
        const health = this.readiness();
        const appSchema = this.database.schemaCompatibility();
        sendJson(response, health.ready ? 200 : 503, {
          schema_version: 1,
          status: health.ready ? "ready" : "not_ready",
          service: "dispatcher",
          build_sha: this.config.buildSha,
          protocol: 1,
          app_schema: appSchema.actual,
          app_schema_read_min: appSchema.read_min,
          app_schema_read_max: appSchema.read_max,
          app_schema_write: appSchema.write,
          config: 1,
          scheduler: health.scheduler,
          ...(this.updateNotifications ? { update_notification_protocol: 1 } : {}),
        });
        return;
      }
      if (request.method === "GET" && (url.pathname === "/v1/human-waits" || url.pathname==="/v1/human-waits/presentation" || /^\/v1\/human-waits\/origins\/[^/]+$/.test(url.pathname))) {
        const context=this.verifiedAgentContexts.get(request);
        if(!context||context.purpose!=="human_command")throw new ApiRequestError(403,"agent_context_unavailable","Agent operation is not available");
        const secret=await readPrivateToken(this.config.slackIngressTokenPath);
        if(!secret)throw new ApiRequestError(503,"human_wait_query_unavailable","Human wait query is unavailable");
        const service=new HumanWaitQueryService(this.database.humanWaits,this.agentReads,createHash("sha256").update(secret).digest());
        try {
          const destination=await this.authorizedHumanWaitDestination(context);
          if(url.pathname==="/v1/human-waits"||url.pathname==="/v1/human-waits/presentation") {
            const rawLimit=url.searchParams.get("limit")??"20";
            if(!/^(?:[1-9]|[1-4][0-9]|50)$/.test(rawLimit))throw new ApiRequestError(400,"invalid_request","limit is invalid");
            const event=this.database.get(context.event_id);
            const presentation=url.pathname==="/v1/human-waits/presentation";
            const continuation=presentation&&url.searchParams.has("cursor");
            if(!event||!hasExplicitOwnHumanWaitIntent(event,{continuation}))throw new HumanWaitPresentationError();
            if(url.pathname==="/v1/human-waits/presentation") {
              const page=service.list({context,destination,limit:Math.min(Number(rawLimit),10),cursorScope:"presentation",
                ...(continuation?{cursor:url.searchParams.get("cursor")!,allowCrossEventCursor:true}:{})});
              sendJson(response,200,{schema_version:1,...renderHumanWaits(page,new Date(event.occurred_at))});
            } else sendJson(response,200,service.list({context,destination,limit:Number(rawLimit),
              ...(url.searchParams.has("cursor")?{cursor:url.searchParams.get("cursor")!}:{})}));
          } else {
            let originRef:string;
            try { originRef=decodeURIComponent(url.pathname.split("/").at(-1)!); }
            catch { throw new HumanWaitQueryError("human_wait_origin_unavailable"); }
            sendJson(response,200,service.resolveOrigin({context,destination,originRef}));
          }
        } catch(error) {
          if(error instanceof HumanWaitPresentationError)throw new ApiRequestError(403,error.code,"Human wait presentation requires an explicit owner request");
          if(error instanceof HumanWaitQueryError) {
            if(error.code==="human_wait_cursor_invalid")throw new ApiRequestError(409,error.code,"Human wait cursor is no longer valid");
            if(error.code==="human_wait_origin_unavailable")throw new ApiRequestError(404,error.code,"Human wait origin is unavailable");
            throw new ApiRequestError(503,error.code,"Human wait query is unavailable");
          }
          throw error;
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/internal/job-progress") {
        if (!(await this.authorizedUpdateRequest(request))) throw new ApiRequestError(403, "forbidden", "Internal authentication failed");
        const progressId = url.searchParams.get("progress_id") ?? "";
        const deliveryToken = url.searchParams.get("delivery_token") ?? "";
        const delivery = this.jobProgress?.resolveDelivery(progressId, deliveryToken);
        if (!delivery && this.jobProgress?.deliveryDeferred?.(progressId, deliveryToken)) throw new ApiRequestError(425, "progress_deferred", "Progress delivery is waiting for the group seal");
        if (!delivery) throw new ApiRequestError(404, "progress_not_deliverable", "Progress is not pending delivery");
        sendJson(response, 200, { schema_version: 1, ...delivery });
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
        const context = this.verifiedAgentContexts.get(request);
        const storedJobs = this.database.listEventJobs(sourceEventId, jobKey);
        const jobs = context?.purpose === "job_completion"
          ? storedJobs.map(row => {
            const job = this.database.getJob(row.job_id);
            return job ? projectCompletionJob(job) : undefined;
          }).filter((row): row is Record<string, unknown> => row !== undefined)
          : context
            ? storedJobs.map(row => this.database.getJob(row.job_id)).filter((row): row is JobRow => row !== undefined)
              .filter(row => this.agentJobAllowed(request, "list_event_jobs", row)).map(projectAuthorizedJob)
            : storedJobs;
        const reconciliation = canonicalPayloadSha256 !== undefined && jobKey !== undefined
          ? context?.purpose === "human_command" && jobs.length === 0
            ? "not_found"
            : this.database.reconcileEventJob(sourceEventId, jobKey, canonicalPayloadSha256)
          : undefined;
        sendJson(response, 200, {
          schema_version: 1,
          source_event_id: sourceEventId,
          jobs,
          ...(reconciliation !== undefined ? { reconciliation } : {}),
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
      const notificationAuthorization=/^\/v1\/job-notifications\/([^/]+)\/authorize$/.exec(url.pathname);
      if(request.method==="POST"&&notificationAuthorization) {
        if(this.shuttingDown) throw new ApiRequestError(503,"shutting_down","Dispatcher is not accepting notification authorization while quiescing");
        const body=await this.readJson(request) as Record<string,unknown>;
        try {
          let decoded:Record<string,unknown>|undefined;
          if(body.receipt!==undefined) {
            const token=await readPrivateToken(this.config.updateInternalTokenPath),receipt=String(body.receipt),[payload,signature,...extra]=receipt.split(".");
            if(!token||!payload||!signature||extra.length) throw new Error("invalid_schedule_access_receipt");
            const expected=createHmac("sha256",token).update(payload).digest(),actual=Buffer.from(signature,"base64url");
            if(expected.length!==actual.length||!timingSafeEqual(expected,actual)) throw new Error("invalid_schedule_access_receipt");
            const claimed=JSON.parse(Buffer.from(payload,"base64url").toString("utf8")) as Record<string,unknown>;
            const eventId=decodeURIComponent(notificationAuthorization[1]!); if(claimed.event_id!==eventId) throw new Error("schedule_access_receipt_mismatch");
            const issuedAt=String(claimed.issued_at??""),nonce=String(claimed.nonce??"");
            if(!Number.isFinite(Date.parse(issuedAt))||!nonce) throw new Error("invalid_schedule_access_receipt");
            const confirmed=await confirmScheduleAccess(this.config.slackAdapterSocketPath,token,{event_id:eventId,workspace_id:String(claimed.workspace_id??""),channel_id:String(claimed.channel_id??""),user_id:String(claimed.user_id??"")},scheduleAccessConfirmationTimeout(issuedAt));
            decoded={...confirmed,issued_at:issuedAt,nonce};
          }
          sendJson(response,200,{schema_version:1,...this.database.authorizeJobNotification(decodeURIComponent(notificationAuthorization[1]!),new Date(),decoded?{workspace_id:String(decoded.workspace_id??""),channel_id:String(decoded.channel_id??""),user_id:String(decoded.user_id??""),issued_at:String(decoded.issued_at??""),nonce:String(decoded.nonce??""),channel_kind:String(decoded.channel_kind??""),channel_user_id:decoded.channel_user_id===null?null:String(decoded.channel_user_id??"")}:undefined)});
        }
        catch(error) { throw new ApiRequestError(409,"notification_not_authorized",error instanceof Error?error.message:String(error)); }
        return;
      }
      const scheduledAccess=/^\/v1\/scheduled-jobs\/([^/]+)\/access$/.exec(url.pathname);
      if(request.method==="POST"&&scheduledAccess) {
        if(this.shuttingDown) throw new ApiRequestError(503,"shutting_down","Dispatcher is not accepting scheduled access writes while quiescing");
        const body=await this.readJson(request) as Record<string,unknown>;
        try {
          const token=await readPrivateToken(this.config.updateInternalTokenPath),receipt=String(body.receipt??""),[payload,signature,...extra]=receipt.split(".");
          if(!token||!payload||!signature||extra.length) throw new Error("invalid_schedule_access_receipt");
          const expected=createHmac("sha256",token).update(payload).digest(),actual=Buffer.from(signature,"base64url");
          if(expected.length!==actual.length||!timingSafeEqual(expected,actual)) throw new Error("invalid_schedule_access_receipt");
          const decoded=JSON.parse(Buffer.from(payload,"base64url").toString("utf8")) as Record<string,unknown>;
          const eventId=decodeURIComponent(scheduledAccess[1]!); if(decoded.event_id!==eventId) throw new Error("schedule_access_receipt_mismatch");
          const issuedAt=String(decoded.issued_at??""),nonce=String(decoded.nonce??"");
          if(!Number.isFinite(Date.parse(issuedAt))||!nonce) throw new Error("invalid_schedule_access_receipt");
          const confirmed=await confirmScheduleAccess(this.config.slackAdapterSocketPath,token,{event_id:eventId,workspace_id:String(decoded.workspace_id??""),channel_id:String(decoded.channel_id??""),user_id:String(decoded.user_id??"")},scheduleAccessConfirmationTimeout(issuedAt));
          sendJson(response,200,{schema_version:1,...this.database.recordScheduleJobAccess(eventId,{workspace_id:String(confirmed.workspace_id??""),channel_id:String(confirmed.channel_id??""),user_id:String(confirmed.user_id??""),issued_at:issuedAt,nonce})});
        }
        catch(error) { throw new ApiRequestError(409,"schedule_access_not_authorized",error instanceof Error?error.message:String(error)); }
        return;
      }
      const scheduledDelegation=/^\/v1\/scheduled-jobs\/([^/]+)\/delegate$/.exec(url.pathname);
      if(request.method==="POST"&&scheduledDelegation) {
        const eventId=decodeURIComponent(scheduledDelegation[1]!);
        if(this.shuttingDown) {
          this.database.recordScheduledDelegationRejection(eventId,"scheduled_capability_unavailable");
          throw new ApiRequestError(503,"scheduled_capability_unavailable","Dispatcher is not accepting scheduled delegation while quiescing");
        }
        const body=await this.readJson(request);
        if(body===null||typeof body!=="object"||Array.isArray(body)||Object.keys(body as Record<string,unknown>).length!==0) {
          this.database.recordScheduledDelegationRejection(eventId,"scheduled_request_invalid");
          throw new ApiRequestError(400,"scheduled_request_invalid","Scheduled delegation accepts only its event identity");
        }
        try {
          const result=this.database.createScheduledJob(eventId,this.config.jobsWorkspaceRoot,this.config.jobResultsDir);
          this.jobs.wake();
          sendJson(response,result.duplicate?200:202,{schema_version:1,outcome:result.outcome,duplicate:result.duplicate,job:result.row});
        } catch(error) {
          if(error instanceof ScheduledJobCreationError) {
            this.database.recordScheduledDelegationRejection(eventId,error.code);
            throw new ApiRequestError(409,error.code,error.message);
          }
          throw error;
        }
        return;
      }
      if (url.pathname === "/v1/jobs" || url.pathname.startsWith("/v1/jobs/")) {
        await this.handleJobs(request, response, url);
        return;
      }
      if (url.pathname === "/v1/schedules/preview" || url.pathname === "/v1/schedules" || url.pathname.startsWith("/v1/schedules/")) {
        try {
          await this.handleSchedules(request, response, url);
        } catch (error) {
          if (error instanceof ScheduleApiError) throw error;
          if (error instanceof ScheduleError) throw new ScheduleApiError(400, error.code);
          if (error instanceof Error && error.name === "ZodError") throw new ScheduleApiError(400, "invalid_request", "Schedule request is invalid");
          const code = error instanceof Error ? error.message : "";
          if (["invalid_limit", "invalid_identity", "schedule_not_found", "unauthorized", "revision_conflict"].includes(code)) {
            throw new ScheduleApiError(code === "schedule_not_found" ? 404 : code === "unauthorized" ? 403 : code === "revision_conflict" ? 409 : 400, code);
          }
          throw error;
        }
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
      if (envelope.source !== "slack") {
        throw new ApiRequestError(403, "unverified_ingress", "External event source is not accepted");
      }
      let verifiedPrincipal;
      const acceptedAt = new Date();
      try {
        const key = await readPrivateToken(this.config.slackIngressTokenPath);
        if (!key) throw new PrincipalProofError("principal_proof_missing");
        verifiedPrincipal = verifySlackPrincipalProof(envelope, request.headers["x-dona-slack-principal-proof"],
          request.headers["x-dona-slack-principal-signature"], key, acceptedAt);
      } catch (error) {
        if (error instanceof PrincipalProofError) {
          throw new ApiRequestError(403, "unverified_ingress", "Slack ingress authentication failed");
        }
        throw error;
      }
      let result;
      try {
        result = this.database.enqueue(envelope, acceptedAt, verifiedPrincipal);
      } catch (error) {
        if (error instanceof PrincipalBindingConflictError) {
          throw new ApiRequestError(409, error.code, "Slack ingress evidence conflicts with the persisted event");
        }
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
        sendJson(response, error.status, errorBody(error.code, error.message,error.details));
      } else if (error instanceof ScheduleApiError) {
        sendJson(response, error.status, errorBody(error.code, error.message));
      } else if (error instanceof Error && error.name === "ZodError") {
        sendJson(response, 400, errorBody("invalid_request", "Schedule request is invalid"));
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
      const context=this.verifiedAgentContexts.get(request);
      if(!context){sendJson(response,200,await this.updates.status(requestId));return;}
      if(!requestId)throw this.notAvailable();
      let status:Record<string,unknown>;
      try { status=await this.updates.status(requestId); }
      catch { throw this.notAvailable(); }
      const update=status.update;
      if(!update||typeof update!=="object"||Array.isArray(update))throw this.notAvailable();
      const row=update as Record<string,unknown>;
      let allowed=context.purpose==="human_command"&&row.source_event_id===context.event_id;
      if(context.purpose==="update_completion"){
        const event=this.database.get(context.event_id);
        try {
          const subject=event?JSON.parse(event.subject_json) as Record<string,unknown>:undefined;
          const replyTarget=event?.reply_target_json?JSON.parse(event.reply_target_json):undefined;
          allowed=event?.source==="dona_update"&&subject?.request_id===requestId&&
            typeof row.reply_target_json==="string"&&stableStringify(JSON.parse(row.reply_target_json))===stableStringify(replyTarget);
        } catch { allowed=false; }
      }
      if(!allowed||row.request_id!==requestId)throw this.notAvailable();
      sendJson(response,200,{schema_version:1,update:projectAgentUpdateStatus(row)});
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

  private agentDisclosureDestination(context: AgentExecutionContext): unknown {
    const event = this.database.get(context.event_id);
    if (!event?.reply_target_json) return undefined;
    try { return JSON.parse(event.reply_target_json) as unknown; }
    catch { return undefined; }
  }

  private async authorizedHumanWaitDestination(context: AgentExecutionContext): Promise<Record<string, unknown>> {
    const destination=this.agentDisclosureDestination(context);
    if(!destination||typeof destination!=="object"||Array.isArray(destination))throw new HumanWaitQueryError("human_wait_query_unavailable");
    const value=destination as Record<string,unknown>;
    if(typeof value.workspace_id!=="string"||typeof value.channel_id!=="string"||value.workspace_id!==context.workspace_id||
      !this.humanWaitAccess)throw new HumanWaitQueryError("human_wait_query_unavailable");
    try {
      const allowed=await this.humanWaitAccess.authorize({event_id:context.event_id,workspace_id:value.workspace_id,
        channel_id:value.channel_id,user_id:context.principal_id});
      if(!allowed)throw new Error("current_access_unavailable");
      return value;
    } catch { throw new HumanWaitQueryError("human_wait_query_unavailable"); }
  }

  private agentJobAllowed(request: IncomingMessage, surface: AgentReadSurface, job: JobRow): boolean {
    const context = this.verifiedAgentContexts.get(request);
    if (!context || context.purpose !== "human_command") return false;
    const binding = this.database.jobAuthorization.readJob(job.job_id);
    const owner = binding?.principal_binding_event_id
      ? this.database.getVerifiedPrincipalBinding(binding.principal_binding_event_id)
      : undefined;
    const ownerBindingCurrent = binding !== undefined && owner !== undefined && owner.revoked_at === null &&
      owner.proof_sha256 === binding.ingress_proof_sha256 && owner.tenant_id === binding.tenant_id &&
      owner.workspace_id === binding.workspace_id && owner.principal_kind === binding.principal_kind &&
      owner.principal_id === binding.principal_id;
    return this.agentReads.authorize({
      context,
      operation: "read_exact_job_status",
      surface,
      job,
      binding,
      owner_binding_current: ownerBindingCurrent,
      disclosure_destination: this.agentDisclosureDestination(context),
    }).allowed;
  }

  private notAvailable(): ApiRequestError {
    return new ApiRequestError(404, "not_available", "Resource is not available");
  }

  private async handleJobs(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (this.shuttingDown && request.method !== "GET") {
      throw new ApiRequestError(503, "shutting_down", "Dispatcher is shutting down");
    }
    if (request.method === "POST" && url.pathname === "/v1/jobs") {
      const input = parseCreateJobRequest(await this.readJson(request), true);
      if (this.database.get(input.source_event_id)?.source === "dona_schedule") {
        const code="scheduled_dedicated_handoff_required";
        this.database.recordScheduledDelegationRejection(input.source_event_id,code);
        throw new ApiRequestError(409,code,"Scheduled work must use the dedicated delegation endpoint");
      }
      let result;
      try {
        result = this.database.createJob(input, this.config.jobsWorkspaceRoot, this.config.jobResultsDir);
      } catch (error) {
        if (error instanceof ScheduledJobCreationError) {
          this.database.recordScheduledDelegationRejection(input.source_event_id,error.code);
          throw new ApiRequestError(409,error.code,error.message);
        }
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
          throw new ApiRequestError(409, error.code, error.message, error.limitDetails);
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
      const sourceEventId=url.searchParams.get("source_event_id");
      if(sourceEventId){
        const context = this.verifiedAgentContexts.get(request);
        try {
          const rows = this.database.listOwnerJobs(sourceEventId, context ? agentReadCandidateScanMax + 1 : 100);
          const scanned = context ? rows.slice(0, agentReadCandidateScanMax) : rows;
          const jobs = context
            ? scanned.filter(row => this.agentJobAllowed(request, "list_owner_jobs", row)).map(projectAuthorizedJob)
            : scanned.map(({job_id,source_event_id,job_key,status,created_at,updated_at,completed_at,last_error_code})=>
              ({job_id,source_event_id,job_key,status,created_at,updated_at,completed_at,last_error_code}));
          sendJson(response,200,{schema_version:1,jobs:jobs.slice(0,100),
            ...(context ? { truncated: jobs.length > 100 || rows.length > agentReadCandidateScanMax } : {})});
        }
        catch {
          if (context) sendJson(response, 200, { schema_version: 1, jobs: [] });
          else throw new ApiRequestError(403,"owner_mismatch","Unknown event owner");
        }
        return;
      }
      const workspaceId = url.searchParams.get("workspace_id");
      const channelId = url.searchParams.get("channel_id");
      const threadTs = url.searchParams.get("thread_ts");
      if (!workspaceId || !channelId || !threadTs) {
        throw new ApiRequestError(400, "invalid_request", "workspace_id, channel_id, and thread_ts are required");
      }
      const agentContext = this.verifiedAgentContexts.get(request);
      if (agentContext) {
        const event = this.database.get(agentContext.event_id);
        const target = event?.reply_target_json ? JSON.parse(event.reply_target_json) as Record<string, unknown> : undefined;
        if (target?.workspace_id !== workspaceId || target.channel_id !== channelId || target.thread_ts !== threadTs) {
          throw new ApiRequestError(403, "agent_context_unavailable", "Agent operation is not available");
        }
      }
      const candidates = this.database.listThreadJobs(workspaceId, channelId, threadTs,
        agentContext ? agentReadCandidateScanMax + 1 : 101);
      const scanned = agentContext ? candidates.slice(0, agentReadCandidateScanMax) : candidates;
      const visible = agentContext
        ? scanned.filter(row => this.agentJobAllowed(request, "list_thread_jobs", row))
        : scanned;
      sendJson(response, 200, {
        schema_version: 1,
        jobs: agentContext ? visible.slice(0, 100).map(projectAuthorizedJob) : visible.slice(0,100),
        truncated: visible.length > 100 || (agentContext !== undefined && candidates.length > agentReadCandidateScanMax),
      });
      return;
    }
    const match = /^\/v1\/jobs\/([^/]+)(?:\/(steer|cancel)|\/live-session-receipts\/([^/]+))?$/.exec(url.pathname);
    if (!match) throw new ApiRequestError(404, "not_found", "Route not found");
    const jobId = match[1]!;
    const action = match[2];
    const liveReceiptId=match[3];
    if(request.method==="GET"&&liveReceiptId){
      const job=this.database.getJob(jobId);
      const context=this.verifiedAgentContexts.get(request);
      if(!job){
        if(context)throw this.notAvailable();
        throw new ApiRequestError(404,"job_not_found",`Job ${jobId} was not found`);
      }
      const sourceEventId=url.searchParams.get("source_event_id");
      if(sourceEventId===null||!/^evt_[0-9A-HJKMNP-TV-Z]{26}$/i.test(sourceEventId))throw new ApiRequestError(400,"invalid_request","valid source_event_id is required");
      try{this.database.assertJobSourceMatchesThread(jobId,sourceEventId);}catch{
        if(context)throw this.notAvailable();
        throw new ApiRequestError(403,"job_thread_mismatch","Job does not belong to the event thread");
      }
      if(context?.purpose==="job_completion"||context&&!this.agentJobAllowed(request,"get_job_status",job))throw this.notAvailable();
      const receipt=this.jobs.getLiveSessionReceipt?.(jobId,liveReceiptId);
      if(!receipt){
        if(context)throw this.notAvailable();
        throw new ApiRequestError(404,"live_session_receipt_not_found","Live session receipt was not found");
      }
      sendJson(response,200,projectLiveJobResponse({...job,...this.database.jobNotificationState(jobId)},receipt));return;
    }
    if (request.method === "GET" && !action) {
      const sourceEventId = url.searchParams.get("source_event_id");
      if (sourceEventId === null) throw new ApiRequestError(400,"invalid_request","source_event_id is required");
      if (!/^evt_[0-9A-HJKMNP-TV-Z]{26}$/i.test(sourceEventId)) {
        throw new ApiRequestError(400, "invalid_request", "source_event_id is invalid");
      }
      const includeLive=url.searchParams.get("include_live_session");
      if(includeLive!==null&&includeLive!=="true"&&includeLive!=="false")throw new ApiRequestError(400,"invalid_request","include_live_session must be true or false");
      const job = this.database.getJob(jobId);
      const context = this.verifiedAgentContexts.get(request);
      if (!job) {
        if (context) throw this.notAvailable();
        throw new ApiRequestError(404, "job_not_found", `Job ${jobId} was not found`);
      }
      try {
        this.database.assertJobSourceMatchesThread(jobId, sourceEventId);
      } catch {
        if (context) throw this.notAvailable();
        throw new ApiRequestError(403, "job_thread_mismatch", "Job does not belong to the event thread");
      }
      if (context?.purpose === "job_completion") {
        if(includeLive==="true")throw this.notAvailable();
        sendJson(response, 200, { schema_version: 1, job: projectCompletionJob(job) });
        return;
      }
      if (context && !this.agentJobAllowed(request, "get_job_status", job)) {
        throw this.notAvailable();
      }
      if(includeLive==="true"){
        if(!this.jobs.observeLiveSession)throw new ApiRequestError(503,"live_session_unavailable","Live session observation is unavailable");
        try{
          const receipt=await this.jobs.observeLiveSession(jobId,sourceEventId);
          const refreshed=this.database.getJob(jobId);
          if(!refreshed)throw new Error(`Job ${jobId} disappeared during live observation`);
          sendJson(response,200,projectLiveJobResponse({...refreshed,...this.database.jobNotificationState(jobId)},receipt));
        }
        catch{throw new ApiRequestError(503,"live_session_audit_unavailable","Live session observation could not be durably audited");}
      }else{
        const responseJob = {...job,...this.database.jobNotificationState(jobId)} as JobRow;
        sendJson(response, 200, { schema_version: 1, job: context ? projectAuthorizedJob(responseJob) : responseJob });
      }
      return;
    }
    if (request.method === "POST" && action === "steer") {
      const input = parseSteerJobRequest(await this.readJson(request));
      try {
        const result = await this.jobs.steer(jobId, input.source_event_id, input.instruction);
        sendJson(response, 200, { schema_version: 1, duplicate: result.duplicate, job: result.row });
      } catch (error) {
        if(error instanceof JobCreationError) throw new ApiRequestError(409,error.code,error.message,error.limitDetails);
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

  private async handleSchedules(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (this.shuttingDown && request.method !== "GET") throw new ScheduleApiError(503, "shutting_down");
    if (request.method === "POST" && url.pathname === "/v1/schedules/preview") { sendJson(response, 200, this.schedules.preview(await this.readJson(request))); return; }
    if (request.method === "POST" && url.pathname === "/v1/schedules") { const result = this.schedules.create(await this.readJson(request)); sendJson(response, result.duplicate ? 200 : 201, result); return; }
    const sourceEventId = url.searchParams.get("source_event_id") ?? "";
    if (request.method === "GET" && url.pathname === "/v1/schedules") {
      const limit = Number(url.searchParams.get("limit") ?? 50); sendJson(response, 200, this.schedules.list(sourceEventId, limit, url.searchParams.get("cursor") ?? undefined)); return;
    }
    const match = /^\/v1\/schedules\/([^/]+)(?:\/(pause|resume|cancel|runs))?$/.exec(url.pathname);
    if (!match) throw new ScheduleApiError(404, "not_found");
    let scheduleId: string;
    try { scheduleId = decodeURIComponent(match[1]!); }
    catch (error) { if (error instanceof URIError) throw new ScheduleApiError(400, "invalid_schedule_id"); throw error; }
    const action = match[2];
    if (request.method === "GET" && !action) { sendJson(response, 200, this.schedules.get(scheduleId, sourceEventId)); return; }
    if (request.method === "GET" && action === "runs") { const limit = Number(url.searchParams.get("limit") ?? 50); sendJson(response, 200, this.schedules.history(scheduleId, sourceEventId, limit, url.searchParams.get("cursor") ?? undefined)); return; }
    if (request.method === "PATCH" && !action) { sendJson(response, 200, this.schedules.update(scheduleId, await this.readJson(request))); return; }
    if (request.method === "POST" && (action === "pause" || action === "resume" || action === "cancel")) { sendJson(response, 200, this.schedules.transition(scheduleId, action, await this.readJson(request))); return; }
    throw new ScheduleApiError(404, "not_found");
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
    let input: unknown;
    try {
      input = JSON.parse(body.toString("utf8"));
    } catch {
      throw new RequestValidationError("Request body must be valid JSON");
    }
    const context = this.verifiedAgentContexts.get(request);
    const operation = agentOperation(request.method, new URL(request.url ?? "/", "http://localhost"));
    if (context && operation && agentBodyEventOperations.has(operation)) {
      const sourceEventId = input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>).source_event_id
        : undefined;
      if (sourceEventId !== context.event_id) {
        throw new ApiRequestError(403, "agent_context_unavailable", "Agent operation is not available");
      }
    }
    return input;
  }
}
