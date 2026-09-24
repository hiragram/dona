import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { JobResultEnvelope, JobRow } from "./types.js";

/** The downstream durable writer must use this same encoded-envelope limit. */
export const jobResultEnvelopeMaxBytes = 1_048_576;
export const jobResultPublishTtlMs = 30 * 60_000;

export type JobResultPublishErrorCode =
  | "invalid_request" | "payload_too_large" | "content_requires_redaction"
  | "capability_invalid" | "capability_expired" | "capability_revoked"
  | "worker_session_stale" | "job_not_publishable" | "renewal_not_due";

export class JobResultPublishError extends Error {
  constructor(readonly code: JobResultPublishErrorCode) {
    super(code);
    this.name = "JobResultPublishError";
  }
}

// These checks reject credential-shaped content, private URLs, and local paths before
// it can enter a durable Result. Errors never contain any part of the supplied value.
const sensitive = /(?:xox[baprs]-|xapp-|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{8,}|-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----|\b(?:token|password|secret|api[_ -]?key|access[_ -]?key|private[_ -]?key|credential|authorization)\s*[:=]|\bBearer\s+[A-Za-z0-9._~-]{8,}|file:\/\/\S+|https?:\/\/(?:[^\s/@]+:[^\s/@]+@|(?:files|hooks)\.slack\.com|localhost|127\.0\.0\.1)|https?:\/\/[^\s]+[?&](?:token|sig|signature|x-amz-signature|x-goog-signature|api[_-]?key|access[_-]?key|auth)=|(?:^|[\s"'(`=:])(?:\/(?!\/)[^\s"'<>`]+|~\/|[A-Za-z]:\\))/i;
const capabilityCandidate = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
function forbiddenKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
  return /(?:^|_)(?:token|secret|password|credential|authorization|capability)(?:_|$)/.test(normalized) ||
    /^(?:api_key|access_key|private_key|agent_session|pane_id|workspace_path|result_path|agent_name)$/.test(normalized) ||
    normalized.startsWith("herdr_");
}
const hasInvalidUnicode = (value: string): boolean => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);

function assertSafeJson(value: unknown, depth = 0, forbiddenDigests?: ReadonlySet<string>, forbiddenValues?: readonly string[]): void {
  if (depth > 64) throw new JobResultPublishError("invalid_request");
  if (typeof value === "string") {
    if (forbiddenDigests) {
      for (const match of value.matchAll(capabilityCandidate)) {
        if (forbiddenDigests.has(createHash("sha256").update(match[0]).digest("hex"))) {
          throw new JobResultPublishError("content_requires_redaction");
        }
      }
    }
    if (forbiddenValues?.some(privateValue => privateValue.length >= 4 && value.includes(privateValue))) {
      throw new JobResultPublishError("content_requires_redaction");
    }
    if (sensitive.test(value)) throw new JobResultPublishError("content_requires_redaction");
    if (hasInvalidUnicode(value)) throw new JobResultPublishError("invalid_request");
  } else if (Array.isArray(value)) {
    for (const item of value) assertSafeJson(item, depth + 1, forbiddenDigests, forbiddenValues);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenKey(key)) throw new JobResultPublishError("content_requires_redaction");
      assertSafeJson(key, depth + 1, forbiddenDigests, forbiddenValues);
      assertSafeJson(item, depth + 1, forbiddenDigests, forbiddenValues);
    }
  } else if (typeof value !== "boolean" && typeof value !== "number" && value !== null) {
    throw new JobResultPublishError("invalid_request");
  }
}

function assertJsonDepth(value: unknown, depth = 0): void {
  if (depth > 64) throw new JobResultPublishError("invalid_request");
  if (Array.isArray(value)) for (const child of value) assertJsonDepth(child, depth + 1);
  else if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) assertJsonDepth(child, depth + 1);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const jsonValue: z.ZodType<unknown> = z.json();
const requestSchema = z.object({
  schema_version: z.literal(1),
  status: z.enum(["completed", "failed"]),
  summary: z.string().min(1),
  output: z.object({ format: z.enum(["markdown", "text"]), text: z.string() }).strict().optional(),
  artifacts: z.array(z.record(z.string(), jsonValue)).optional(),
  actions: z.array(jsonValue).optional(),
}).strict();

export type JobResultPublishRequest = z.infer<typeof requestSchema>;
export interface ValidatedJobResultPublish {
  request: JobResultPublishRequest;
  envelope: JobResultEnvelope;
  canonicalDigest: string;
  encodedBytes: number;
  reconcileOnly: boolean;
}

export interface AuthorizedJobResultPublish extends ValidatedJobResultPublish {
  /** The durable commit must compare this fence in its Result transaction. */
  fence: { jobId: string; attemptCount: number; paneId: string | null; session: string };
}

export function validateJobResultPublish(input: unknown, job: Pick<JobRow, "job_id" | "status">, completedAt: string, forbiddenDigests?: ReadonlySet<string>, forbiddenValues?: readonly string[]): ValidatedJobResultPublish {
  assertJsonDepth(input);
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success || !Number.isFinite(Date.parse(completedAt)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(completedAt)) {
    throw new JobResultPublishError("invalid_request");
  }
  assertSafeJson(parsed.data, 0, forbiddenDigests, forbiddenValues);
  const envelope: JobResultEnvelope = {
    schema_version: 1,
    job_id: job.job_id,
    status: parsed.data.status,
    summary: parsed.data.summary,
    ...(parsed.data.output === undefined ? {} : { output: parsed.data.output }),
    ...(parsed.data.artifacts === undefined ? {} : { artifacts: parsed.data.artifacts }),
    ...(parsed.data.actions === undefined ? {} : { actions: parsed.data.actions }),
    completed_at: completedAt,
  };
  const encodedBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  if (encodedBytes > jobResultEnvelopeMaxBytes) throw new JobResultPublishError("payload_too_large");
  // completed_at is Dispatcher-owned and deliberately excluded from request identity.
  const canonicalDigest = createHash("sha256").update(`job-result-publish:v1\n${job.job_id}\n${canonicalJson(parsed.data)}`).digest("hex");
  return { request: parsed.data, envelope, canonicalDigest, encodedBytes,
    reconcileOnly: job.status === "completed" || job.status === "failed" };
}

interface Grant {
  jobId: string;
  session: string;
  attemptCount: number;
  paneId: string | null;
  expiresAt: number;
  renewableAt: number;
  revoked: boolean;
}

/** Process-local grants fail closed on restart. Only the worker prompt gets the raw token. */
export class JobResultPublishCapabilities {
  private readonly grants = new Map<string, Grant>();
  private readonly renewalKey = randomBytes(32);
  constructor(
    private readonly currentSession: (jobId: string) => string | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  issue(job: JobRow, session: string): { capability: string; expiresAt: string } {
    if (job.status !== "dispatching" || !session || session.length > 512 || this.currentSession(job.job_id) !== session) {
      throw new JobResultPublishError("job_not_publishable");
    }
    return this.mint(job, session);
  }

  renew(capability: string, session: string, getJob: (jobId: string) => JobRow | undefined): { capability: string; expiresAt: string } {
    const job = this.authorize(capability, session, getJob);
    if (job.status !== "running") throw new JobResultPublishError("job_not_publishable");
    for (const [key, grant] of this.grants) if (grant.expiresAt <= this.now()) this.grants.delete(key);
    // The previous token remains valid until its own expiry. A lost response can
    // safely repeat the same renewal and recover the same successor token.
    const next = createHmac("sha256", this.renewalKey).update(`renew:v1\n${capability}`).digest("base64url");
    const key = createHash("sha256").update(next).digest("hex");
    const existing = this.grants.get(key);
    if (existing) return { capability: next, expiresAt: new Date(existing.expiresAt).toISOString() };
    const predecessor = this.grants.get(createHash("sha256").update(capability).digest("hex"));
    if (!predecessor || this.now() < predecessor.renewableAt) throw new JobResultPublishError("renewal_not_due");
    const expiresAt = this.now() + jobResultPublishTtlMs;
    this.grants.set(key, { jobId: job.job_id, session, attemptCount: job.attempt_count,
      paneId: job.herdr_pane_id, expiresAt, renewableAt: this.now() + jobResultPublishTtlMs / 2, revoked: false });
    return { capability: next, expiresAt: new Date(expiresAt).toISOString() };
  }

  private mint(job: JobRow, session: string): { capability: string; expiresAt: string } {
    for (const [key, grant] of this.grants) if (grant.expiresAt <= this.now()) this.grants.delete(key);
    for (const grant of this.grants.values()) if (grant.jobId === job.job_id) grant.revoked = true;
    const capability = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + jobResultPublishTtlMs;
    this.grants.set(createHash("sha256").update(capability).digest("hex"), {
      jobId: job.job_id, session, attemptCount: job.attempt_count, paneId: job.herdr_pane_id,
      expiresAt, renewableAt: this.now() + jobResultPublishTtlMs / 2, revoked: false,
    });
    return { capability, expiresAt: new Date(expiresAt).toISOString() };
  }

  revokeJob(jobId: string): void {
    for (const grant of this.grants.values()) if (grant.jobId === jobId) grant.revoked = true;
  }

  authorize(capability: string, session: string, getJob: (jobId: string) => JobRow | undefined): JobRow {
    if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new JobResultPublishError("capability_invalid");
    const digest = createHash("sha256").update(capability).digest("hex");
    let grant: Grant | undefined;
    for (const [key, candidate] of this.grants) {
      if (timingSafeEqual(Buffer.from(key, "hex"), Buffer.from(digest, "hex"))) grant = candidate;
    }
    if (!grant) throw new JobResultPublishError("capability_invalid");
    if (grant.revoked) throw new JobResultPublishError("capability_revoked");
    if (this.now() >= grant.expiresAt) throw new JobResultPublishError("capability_expired");
    const job = getJob(grant.jobId);
    if (!job || job.job_id !== grant.jobId) throw new JobResultPublishError("capability_invalid");
    if (grant.session !== session || this.currentSession(job.job_id) !== session ||
      grant.attemptCount !== job.attempt_count || grant.paneId !== job.herdr_pane_id) {
      throw new JobResultPublishError("worker_session_stale");
    }
    const terminalReconcile = (job.status === "completed" || job.status === "failed") && typeof job.result_json === "string";
    if (job.status !== "running" && job.status !== "dispatching" && !terminalReconcile) {
      throw new JobResultPublishError("job_not_publishable");
    }
    return job;
  }

  validate(capability: string, session: string, input: unknown, getJob: (jobId: string) => JobRow | undefined): AuthorizedJobResultPublish {
    const job = this.authorize(capability, session, getJob);
    const forbiddenDigests = new Set([...this.grants.entries()]
      .filter(([, grant]) => grant.jobId === job.job_id && grant.expiresAt > this.now())
      .map(([digest]) => digest));
    const forbiddenValues = [job.herdr_pane_id, job.herdr_workspace_id, job.workspace_path,
      job.result_path, session].filter((value): value is string => typeof value === "string" && value.length >= 4);
    return { ...validateJobResultPublish(input, job, new Date(this.now()).toISOString(), forbiddenDigests, forbiddenValues),
      fence: { jobId: job.job_id, attemptCount: job.attempt_count, paneId: job.herdr_pane_id, session } };
  }
}
