import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { DispatcherDatabase } from "./database.js";
import type { EventRow } from "./types.js";

export type AgentPurpose = "human_command" | "job_completion" | "schedule_work" | "update_completion";

export interface AgentExecutionContext {
  event_id: string;
  attempt: number;
  purpose: AgentPurpose;
  tenant_id: string;
  workspace_id: string;
  principal_kind: "human";
  principal_id: string;
  expires_at: string;
  policy_revision: 1;
}

export class AgentPrincipalUnavailableError extends Error {
  readonly code = "agent_context_reauthorization_required";
  constructor() {
    super("Verified principal binding is unavailable; replay the exact Slack event through authenticated ingress before retrying");
    this.name = "AgentPrincipalUnavailableError";
  }
}

interface ActiveContext extends AgentExecutionContext { token_sha256: string; }

export const agentPurposeOperations: Record<AgentPurpose, readonly string[]> = {
  human_command: [
    "delegate_job", "list_event_jobs", "list_thread_jobs", "list_owner_jobs", "get_job_status",
    "steer_job", "cancel_job", "plan_self_update", "apply_self_update", "get_self_update_status",
    "cancel_self_update", "preview_schedule", "create_schedule", "get_schedule", "list_schedules",
    "update_schedule", "pause_schedule", "resume_schedule", "cancel_schedule", "get_schedule_history",
    "list_human_waits", "present_human_waits", "resolve_human_wait_origin",
  ],
  job_completion: ["list_event_jobs", "get_job_status", "authorize_job_notification"],
  schedule_work: ["record_schedule_job_access", "delegate_scheduled_work"],
  update_completion: ["get_self_update_status"],
};

export const agentBodyEventOperations = new Set([
  "delegate_job", "steer_job", "cancel_job", "plan_self_update", "apply_self_update",
  "cancel_self_update", "preview_schedule", "create_schedule", "update_schedule",
  "pause_schedule", "resume_schedule", "cancel_schedule",
]);

function purpose(row: EventRow): AgentPurpose {
  if (row.source === "slack") return "human_command";
  if (row.source === "dona_job") return "job_completion";
  if (row.source === "dona_schedule") return "schedule_work";
  if (row.source === "dona_update") return "update_completion";
  throw new Error("Unsupported agent context source");
}

function verifiedPrincipal(database: DispatcherDatabase, row: EventRow) {
  const binding = database.getAgentPrincipalBinding(row.event_id);
  return binding?.revoked_at === null ? binding : undefined;
}

export class AgentContextManager {
  private active: ActiveContext | undefined;

  constructor(
    private readonly database: DispatcherDatabase,
    private readonly credentialPath: string,
    private readonly lifetimeMs = 15 * 60 * 1_000,
  ) {}

  async initialize(): Promise<void> {
    this.active = undefined;
    await fs.rm(this.credentialPath, { force: true });
  }

  async issue(row: EventRow): Promise<AgentExecutionContext> {
    const principal = verifiedPrincipal(this.database, row);
    if (!principal) throw new AgentPrincipalUnavailableError();
    const token = randomBytes(32).toString("base64url");
    const context: AgentExecutionContext = {
      event_id: row.event_id,
      attempt: row.attempt_count,
      purpose: purpose(row),
      tenant_id: principal.tenant_id,
      workspace_id: principal.workspace_id,
      principal_kind: "human",
      principal_id: principal.principal_id,
      expires_at: new Date(Date.now() + this.lifetimeMs).toISOString(),
      policy_revision: 1,
    };
    this.active = { ...context, token_sha256: createHash("sha256").update(token).digest("hex") };
    await fs.mkdir(path.dirname(this.credentialPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.credentialPath}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ token, event_id: context.event_id })}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.credentialPath);
    return context;
  }

  async ensure(row: EventRow): Promise<AgentExecutionContext> {
    const principal = verifiedPrincipal(this.database, row);
    if (!principal) throw new AgentPrincipalUnavailableError();
    const active = this.active;
    if (active?.event_id === row.event_id && active.attempt === row.attempt_count &&
      active.tenant_id === principal.tenant_id && active.workspace_id === principal.workspace_id &&
      active.principal_kind === principal.principal_kind && active.principal_id === principal.principal_id &&
      Date.now() < Date.parse(active.expires_at)) {
      const { token_sha256: _secret, ...context } = active;
      return context;
    }
    return this.issue(row);
  }

  async revoke(eventId?: string): Promise<void> {
    if (!eventId || this.active?.event_id === eventId) this.active = undefined;
    await fs.rm(this.credentialPath, { force: true });
  }

  authorize(token: string | undefined, claimedEventId: string | undefined, operation: string, now = new Date()): AgentExecutionContext | undefined {
    const active = this.active;
    if (!active || !token || !claimedEventId || active.event_id !== claimedEventId) return undefined;
    if (now.getTime() >= Date.parse(active.expires_at) || !agentPurposeOperations[active.purpose].includes(operation)) return undefined;
    const actual = createHash("sha256").update(token).digest();
    const expected = Buffer.from(active.token_sha256, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
    const current = this.database.get(active.event_id);
    if (!current || current.attempt_count !== active.attempt || !["dispatching", "waiting_agent", "blocked"].includes(current.status)) return undefined;
    const principal = verifiedPrincipal(this.database, current);
    if (!principal || principal.revoked_at !== null ||
      principal.tenant_id !== active.tenant_id || principal.workspace_id !== active.workspace_id ||
      principal.principal_id !== active.principal_id) return undefined;
    const { token_sha256: _secret, ...context } = active;
    return context;
  }

  allowsRouteEvent(context: AgentExecutionContext, operation: string, targetEventId: string): boolean {
    if (targetEventId === context.event_id) return true;
    if (context.purpose !== "job_completion" || operation !== "list_event_jobs") return false;
    const event = this.database.get(context.event_id);
    if (!event || event.source !== "dona_job") return false;
    try {
      const subject = JSON.parse(event.subject_json) as Record<string, unknown>;
      const trace = event.trace_json ? JSON.parse(event.trace_json) as Record<string, unknown> : undefined;
      const sourceEventId = subject.source_event_id ?? trace?.source_event_id;
      return sourceEventId === targetEventId;
    } catch {
      return false;
    }
  }
}

export function agentOperation(method: string | undefined, url: URL): string | undefined {
  const route = url.pathname;
  if (method === "POST" && route === "/v1/jobs") return "delegate_job";
  if (method === "GET" && /^\/v1\/events\/[^/]+\/jobs$/.test(route)) return "list_event_jobs";
  if (method === "GET" && route === "/v1/jobs") return url.searchParams.has("source_event_id") ? "list_owner_jobs" : "list_thread_jobs";
  if (method === "GET" && /^\/v1\/jobs\/[^/]+(?:\/live-session-receipts\/[^/]+)?$/.test(route)) return "get_job_status";
  if (method === "GET" && route === "/v1/human-waits") return "list_human_waits";
  if (method === "GET" && route === "/v1/human-waits/presentation") return "present_human_waits";
  if (method === "GET" && /^\/v1\/human-waits\/origins\/[^/]+$/.test(route)) return "resolve_human_wait_origin";
  if (method === "POST" && /^\/v1\/jobs\/[^/]+\/(steer|cancel)$/.test(route)) return route.endsWith("/steer") ? "steer_job" : "cancel_job";
  if (method === "POST" && /^\/v1\/scheduled-jobs\/[^/]+\/delegate$/.test(route)) return "delegate_scheduled_work";
  if (method === "POST" && /^\/v1\/scheduled-jobs\/[^/]+\/access$/.test(route)) return "record_schedule_job_access";
  if (method === "POST" && /^\/v1\/job-notifications\/[^/]+\/authorize$/.test(route)) return "authorize_job_notification";
  if (route === "/v1/self-update/plan") return "plan_self_update";
  if (route === "/v1/self-update/apply") return "apply_self_update";
  if (route === "/v1/self-update/status") return "get_self_update_status";
  if (route === "/v1/self-update/cancel") return "cancel_self_update";
  if (method === "POST" && route === "/v1/schedules/preview") return "preview_schedule";
  if (method === "POST" && route === "/v1/schedules") return "create_schedule";
  if (method === "GET" && route === "/v1/schedules") return "list_schedules";
  const schedule = /^\/v1\/schedules\/[^/]+(?:\/(pause|resume|cancel|runs))?$/.exec(route);
  if (schedule) {
    if (method === "GET" && schedule[1] === "runs") return "get_schedule_history";
    if (method === "GET" && !schedule[1]) return "get_schedule";
    if (method === "PATCH" && !schedule[1]) return "update_schedule";
    if (method === "POST" && schedule[1]) return `${schedule[1]}_schedule`;
  }
  return undefined;
}
