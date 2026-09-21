import type { AgentExecutionContext } from "./agent-context.js";
import type { JobAuthorizationBindingRow } from "./job-authorization-binding.js";
import type { JobRow } from "./types.js";

export const agentReadSurfaces = [
  "list_event_jobs",
  "list_thread_jobs",
  "list_owner_jobs",
  "get_job_status",
] as const;

export const agentReadGrantOperations = [
  "read_own_human_waits",
  "read_exact_job_status",
  "read_bounded_result",
  "resolve_origin_ref",
] as const;

export type AgentReadSurface = (typeof agentReadSurfaces)[number];
export type AgentReadGrantOperation = (typeof agentReadGrantOperations)[number];
export type AgentReadDenyReason =
  | "binding_unavailable"
  | "owner_not_human"
  | "principal_mismatch"
  | "workspace_mismatch"
  | "policy_revision_mismatch"
  | "grant_unavailable"
  | "destination_unavailable"
  | "visibility_unavailable"
  | "audit_unavailable";

export interface AgentReadGrantInput {
  operation: AgentReadGrantOperation;
  surface: AgentReadSurface;
  tenant_id: string;
  workspace_id: string;
  principal_id: string;
  job_id: string;
  source_event_id: string;
  resource_kind: JobAuthorizationBindingRow["resource_kind"];
  repository_node_id: string | null;
  task_node_id: string | null;
  resource_revision: number | null;
  policy_revision: number;
}

export interface AgentReadGrantPort {
  authorize(input: Readonly<AgentReadGrantInput>): boolean;
}

export interface AgentReadVisibilityInput {
  operation: AgentReadGrantOperation;
  surface: AgentReadSurface;
  event_id: string;
  tenant_id: string;
  workspace_id: string;
  principal_id: string;
  job_id: string;
  disclosure_origin: unknown;
  disclosure_destination: unknown;
}

export interface AgentReadVisibilityPort {
  authorize(input: Readonly<AgentReadVisibilityInput>): boolean;
}

export interface RestrictedAgentReadAudit {
  record(input: Readonly<{
    event_id: string;
    job_id: string;
    operation: AgentReadGrantOperation;
    surface: AgentReadSurface;
    outcome: "allowed" | "denied";
    reason: "none" | AgentReadDenyReason;
    policy_revision: number;
  }>): void;
}

export interface AgentReadDecision {
  allowed: boolean;
  authority: { allowed: boolean; reason: "none" | AgentReadDenyReason };
  disclosure: { allowed: boolean; reason: "none" | AgentReadDenyReason };
}

export const denyAgentReadGrantPort: AgentReadGrantPort = { authorize: () => false };
export const denyAgentReadVisibilityPort: AgentReadVisibilityPort = { authorize: () => false };
const noAgentReadAudit: RestrictedAgentReadAudit = { record() {} };

function parseOrigin(value: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch { return undefined; }
}

export class AgentReadAuthorization {
  constructor(
    private readonly grant: AgentReadGrantPort = denyAgentReadGrantPort,
    private readonly visibility: AgentReadVisibilityPort = denyAgentReadVisibilityPort,
    private readonly audit: RestrictedAgentReadAudit = noAgentReadAudit,
    private readonly policyRevision = 1,
  ) {}

  authorize(input: Readonly<{
    context: AgentExecutionContext;
    operation: AgentReadGrantOperation;
    surface: AgentReadSurface;
    job: JobRow;
    binding: JobAuthorizationBindingRow | undefined;
    owner_binding_current: boolean;
    disclosure_destination: unknown;
  }>): AgentReadDecision {
    const { context, operation, surface, job, binding } = input;
    let authorityReason: "none" | AgentReadDenyReason = "none";
    if (!binding || !input.owner_binding_current || binding.job_id !== job.job_id || binding.source_event_id !== job.source_event_id) {
      authorityReason = "binding_unavailable";
    } else if (binding.owner_kind !== "human_verified" || binding.principal_kind !== "human" || binding.principal_id === null) {
      authorityReason = "owner_not_human";
    } else if (binding.tenant_id !== context.tenant_id || binding.principal_id !== context.principal_id) {
      authorityReason = "principal_mismatch";
    } else if (binding.workspace_id !== context.workspace_id || job.workspace_id !== context.workspace_id) {
      authorityReason = "workspace_mismatch";
    } else if (binding.policy_revision !== this.policyRevision || context.policy_revision !== this.policyRevision) {
      authorityReason = "policy_revision_mismatch";
    } else {
      try {
        if (!this.grant.authorize({
          operation,
          surface,
          tenant_id: context.tenant_id,
          workspace_id: context.workspace_id,
          principal_id: context.principal_id,
          job_id: job.job_id,
          source_event_id: job.source_event_id,
          resource_kind: binding.resource_kind,
          repository_node_id: binding.repository_node_id,
          task_node_id: binding.task_node_id,
          resource_revision: binding.resource_revision,
          policy_revision: this.policyRevision,
        })) authorityReason = "grant_unavailable";
      } catch { authorityReason = "grant_unavailable"; }
    }

    const authority = { allowed: authorityReason === "none", reason: authorityReason } as const;
    let disclosureReason: "none" | AgentReadDenyReason = authority.allowed ? "none" : authority.reason;
    if (authority.allowed && input.disclosure_destination === undefined) disclosureReason = "destination_unavailable";
    else if (authority.allowed && binding) {
      try {
        if (!this.visibility.authorize({
          operation,
          surface,
          event_id: context.event_id,
          tenant_id: context.tenant_id,
          workspace_id: context.workspace_id,
          principal_id: context.principal_id,
          job_id: job.job_id,
          disclosure_origin: parseOrigin(binding.disclosure_origin_json),
          disclosure_destination: input.disclosure_destination,
        })) disclosureReason = "visibility_unavailable";
      } catch { disclosureReason = "visibility_unavailable"; }
    }
    let disclosure: AgentReadDecision["disclosure"] = {
      allowed: authority.allowed && disclosureReason === "none", reason: disclosureReason,
    };
    let allowed = authority.allowed && disclosure.allowed;
    try {
      this.audit.record({
        event_id: context.event_id,
        job_id: job.job_id,
        operation,
        surface,
        outcome: allowed ? "allowed" : "denied",
        reason: allowed ? "none" : disclosure.reason,
        policy_revision: this.policyRevision,
      });
    } catch {
      disclosure = { allowed: false, reason: "audit_unavailable" };
      allowed = false;
    }
    return { allowed, authority, disclosure };
  }
}

const publicJobKeys = [
  "job_id", "source_event_id", "job_key", "status", "created_at", "updated_at", "completed_at",
  "dispatch_started_at", "prompt_accepted_at", "last_error_code", "steer_event_id", "steer_state",
  "completion_event_id", "notification_state", "notification_authorization_phase",
] as const;

export function projectAuthorizedJob(job: JobRow): Record<string, unknown> {
  const row = job as unknown as Record<string, unknown>;
  return Object.fromEntries(publicJobKeys.filter(key => key in row).map(key => [key, row[key]]));
}

const completionJobKeys = ["job_id", "source_event_id", "job_key", "status", "created_at", "updated_at", "completed_at"] as const;

export function projectCompletionJob(job: JobRow): Record<string, unknown> {
  return Object.fromEntries(completionJobKeys.map(key => [key, job[key]]));
}
