import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { JobCreationError, type DispatcherDatabase, type WebCommandIdentity } from "../database.js";
import type { JobSupervisor } from "../job-supervisor.js";
import type { WebAuthRepository } from "./repository.js";
import { type WebCommandInput, type WebCommandResult } from "./command-wire.js";

const requestId = z.string().length(43).refine(value => /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, "base64url").byteLength === 32
  && Buffer.from(value, "base64url").toString("base64url") === value);
const workspace = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("scratch") }),
  z.strictObject({ kind: z.literal("github"), repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
    base_ref: z.string().min(1).max(255).optional() })]);
const submitBody = z.strictObject({ request_id: requestId, objective: z.string().trim().min(1).max(100000), workspace });
const cancelBody = z.strictObject({ request_id: requestId });
const canonical = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface WebCommandPaths { jobsWorkspaceRoot: string; jobResultsDir: string }

export class WebCommandBroker {
  private readonly controls = new Map<string, Promise<unknown>>();
  constructor(private readonly auth: WebAuthRepository, private readonly database: DispatcherDatabase,
    private readonly jobs: Pick<JobSupervisor, "cancelWeb" | "wake">, private readonly paths: WebCommandPaths) {}
  async execute(input: WebCommandInput): Promise<WebCommandResult> {
    try {
      const body = Buffer.from(input.browser_body, "base64url"), parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      const ingress = this.auth.verifySessionIngress(`web_command_${randomBytes(16).toString("hex")}`, input.context,
        input.method, input.target, body, { csrf_verified: true });
      if (ingress.status === "denied") return { status: "denied", reason: ingress.reason === "scope_denied" ? "scope_denied" : "identity_unavailable" };
      if (ingress.kind !== "session_verified") return { status: "denied", reason: "identity_unavailable" };
      const identity: WebCommandIdentity = { instance_id: ingress.principal.instance_id, tenant_id: ingress.principal.tenant_id,
        principal_id: ingress.principal.principal_id };
      const cancelTarget = /^\/api\/jobs\/([A-Za-z0-9_-]{1,128})\/cancel$/.exec(input.target);
      if ((input.operation === "submit" && input.target !== "/api/jobs") || (input.operation === "cancel" && !cancelTarget))
        return { status: "denied", reason: "invalid_request" };
      if (input.operation === "submit") {
        const command = submitBody.parse(parsed);
        const commandWorkspace = command.workspace.kind === "scratch" ? command.workspace
          : { kind: "github" as const, repository: command.workspace.repository,
            ...(command.workspace.base_ref === undefined ? {} : { base_ref: command.workspace.base_ref }) };
        const created = this.database.createWebJob({ ...identity, idempotency_key: input.idempotency_key,
          objective: command.objective, workspace: commandWorkspace }, this.paths.jobsWorkspaceRoot, this.paths.jobResultsDir);
        this.jobs.wake();
        return { status: "succeeded", outcome: created.outcome, receipt_id: created.receipt.receipt_id,
          job: { job_id: created.row.job_id, status: created.row.status } };
      }
      cancelBody.parse(parsed);
      const jobId = cancelTarget?.[1];
      if (!jobId) return { status: "denied", reason: "invalid_request" };
      const receiptId = `web_cancel_${input.idempotency_key}`, payloadHash = canonical({ job_id: jobId });
      return await this.serialized(receiptId, async () => {
      const receipt = this.database.getWebCommandReceipt(receiptId, identity);
      if (receipt) {
        if (receipt.operation !== "cancel" || receipt.canonical_sha256 !== payloadHash || receipt.job_id !== jobId)
          return { status: "denied", reason: "idempotency_conflict" };
        const row = this.database.assertWebJobOwner(jobId, identity);
        return { status: "succeeded", outcome: "already_cancelled", receipt_id: receiptId, job: { job_id: row.job_id, status: row.status } };
      }
      const candidate = this.database.getJob(jobId);
      if (!candidate) return { status: "denied", reason: "not_found" };
      if (candidate.source !== "web") return { status: "denied", reason: "scheduled_policy" };
      try { this.database.assertWebJobOwner(jobId, identity); }
      catch (error) {
        if (error instanceof Error && error.message === "web_job_owner_mismatch") return { status: "denied", reason: "owner_mismatch" };
        throw error;
      }
      if (["completed", "failed", "needs_review"].includes(candidate.status)) return { status: "denied", reason: "terminal" };
      let result;
      try { result = await this.jobs.cancelWeb(jobId, identity); }
      catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "web_job_owner_mismatch") return { status: "denied", reason: "owner_mismatch" };
        if (message.startsWith("web_job_terminal:")) return { status: "denied", reason: "terminal" };
        if (message === "web_cancel_acceptance_unknown") return { status: "denied", reason: "acceptance_unknown" };
        throw error;
      }
      const saved = this.database.recordWebCancelReceipt(receiptId, payloadHash, identity, jobId);
      return { status: "succeeded", outcome: result.duplicate ? "already_cancelled" : "cancelled", receipt_id: saved.receipt_id,
        job: { job_id: result.row.job_id, status: result.row.status } };
      });
    } catch (error) {
      if (error instanceof JobCreationError) return { status: "denied", reason: error.code === "job_group_limit_exceeded" ? "quota_exceeded" : "idempotency_conflict" };
      if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError)
        return { status: "denied", reason: "invalid_request" };
      return { status: "denied", reason: "internal_error" };
    }
  }
  private serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.controls.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.controls.set(key, current);
    void current.finally(() => { if (this.controls.get(key) === current) this.controls.delete(key); }).catch(() => undefined);
    return current;
  }
}
