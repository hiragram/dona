import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { z } from "zod";

import type { JobResultEnvelope, JobRow } from "./types.js";

/** The downstream durable writer must use this same encoded-envelope limit. */
export const jobResultEnvelopeMaxBytes = 1_048_576;
export const jobResultPublishTtlMs = 30 * 60_000;

/** Composite identity carries a persisted agent session ID of at most 512 code points. */
export function validJobResultPublishSession(session: string): boolean {
  if (!session || Buffer.byteLength(JSON.stringify(session), "utf8") > 8_192) return false;
  let parts: unknown;
  try { parts = JSON.parse(session); } catch { /* Legacy opaque identity. */ }
  if (Array.isArray(parts) && parts.length === 4 && parts.every(part => typeof part === "string")) {
    const agentSession = parts[3] as string;
    return agentSession.length > 0 && [...agentSession].length <= 512;
  }
  return [...session].length <= 512;
}

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
const sensitive = /(?:xox[baprs]-|xapp-|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{8,}|-----BEGIN (?:(?:ENCRYPTED |OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----|PGP PRIVATE KEY BLOCK-----)|\b(?:token|password|secret|api[_ -]?key|access[_ -]?key|private[_ -]?key|credential|authorization)\s*[:=]|\bBearer\s+[A-Za-z0-9._~-]{8,}|file:\/\/\S+|\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s@]+@|https?:\/\/(?:(?:files|hooks)\.slack\.com|localhost|127\.0\.0\.1))/i;
const privateJwkParameter = new Set(["d", "p", "q", "dp", "dq", "qi", "oth", "k"]);
function hasPrivateJwkFields(value: Record<string, unknown>): boolean {
  return typeof value.kty === "string" && ["RSA", "EC", "OKP", "oct"].includes(value.kty) &&
    Object.keys(value).some(key => privateJwkParameter.has(key));
}
function hasPrivateJwkText(value: string): boolean {
  const scopes: { keyType: boolean; privateParameter: boolean }[] = [];
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "{") { scopes.push({ keyType: false, privateParameter: false }); continue; }
    if (char === "}") {
      const scope = scopes.pop();
      if (scope?.keyType && scope.privateParameter) return true;
      continue;
    }
    if (char !== '"') continue;
    const start = index;
    index++;
    for (; index < value.length; index++) {
      if (value[index] === "\\") { index++; continue; }
      if (value[index] === '"') break;
    }
    if (index >= value.length || scopes.length === 0) continue;
    let key: unknown;
    try { key = JSON.parse(value.slice(start, index + 1)); } catch { continue; }
    let next = index + 1;
    while (/\s/.test(value[next] ?? "")) next++;
    if (value[next] !== ":") continue;
    const scope = scopes.at(-1)!;
    if (key === "kty") {
      next++;
      while (/\s/.test(value[next] ?? "")) next++;
      if (value[next] === '"') {
        const valueStart = next++;
        for (; next < value.length; next++) {
          if (value[next] === "\\") { next++; continue; }
          if (value[next] === '"') break;
        }
        try { scope.keyType = ["RSA", "EC", "OKP", "oct"].includes(JSON.parse(value.slice(valueStart, next + 1))); }
        catch { /* Malformed snippets remain handled by the structural validator. */ }
      }
    } else if (typeof key === "string" && privateJwkParameter.has(key)) scope.privateParameter = true;
  }
  return scopes.some(scope => scope.keyType && scope.privateParameter);
}
const localPath = /(?:(?<![A-Za-z0-9/])\/(?!\/)[^\s"'<>`]+|(?<![A-Za-z0-9])~\/|[A-Za-z]:(?:\\|\/(?!\/)))/i;
const windowsUncPath = /(?<![A-Za-z0-9:\\])\\\\[^\\\s]+\\/;
const slashAuthority = /(?<![A-Za-z0-9:/])\/\/([^/?#\s"'<>`]+)(?:[/?#][^\s"'<>`]*)?/g;
function hasPrivateSlashAuthority(value: string): boolean {
  for (const match of value.matchAll(slashAuthority)) {
    const host = match[1]!;
    let url: URL;
    try { url = new URL(`https:${match[0]}`); } catch { return true; }
    if (!host.includes(".") || url.username || url.password || hasSignedQueryKey(match[0]) || hasPrivateHttpHost(url.href)) return true;
  }
  return false;
}
const slackMention = /<!(?:channel|here|everyone)(?:\|[^>]*)?>|<!subteam\^[^>]+>|<@[A-Z0-9]+(?:\|[^>]*)?>/i;
const networkUrlCandidate = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;
const signedQueryKeys = new Set(["token", "sig", "signature", "x-amz-signature", "x-goog-signature", "api_key", "api-key", "access_key", "access-key", "auth"]);
function hasPrivateHttpHost(candidate: string): boolean {
  let hostname: string;
  try { hostname = new URL(candidate).hostname.toLowerCase().replace(/\.+$/, ""); }
  catch { return true; }
  if (hostname === "localhost" || hostname.endsWith(".localhost") ||
    hostname === "files.slack.com" || hostname === "hooks.slack.com") return true;
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) === 0 && (!host.includes(".") || /\.(?:internal|local|lan|home\.arpa)$/.test(host))) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(host) === 6) {
    const first = Number.parseInt(host.split(":")[0] || "0", 16);
    if (host === "::" || host === "::1" || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return true;
    const mapped = host.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return hasPrivateHttpHost(`http://${mapped[1]}/`);
    // Also cover compressed hexadecimal IPv4-mapped addresses.
    const hexMapped = host.match(/(?:^|:)ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/i);
    if (hexMapped) {
      const bits = (Number.parseInt(hexMapped[1]!, 16) << 16) | Number.parseInt(hexMapped[2]!, 16);
      return hasPrivateHttpHost(`http://${[(bits >>> 24) & 255, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255].join(".")}/`);
    }
  }
  return false;
}
function hasSignedQueryKey(candidate: string): boolean {
  const queryStart = candidate.indexOf("?");
  if (queryStart < 0) return false;
  for (const parameter of candidate.slice(queryStart + 1).split("&")) {
    const equal = parameter.indexOf("=");
    if (equal < 0) continue;
    try {
      const key = decodeURIComponent(parameter.slice(0, equal).replaceAll("+", " ")).toLowerCase();
      if (signedQueryKeys.has(key) || forbiddenKey(key)) return true;
    } catch { return true; }
  }
  return false;
}
const capabilityRun = /[A-Za-z0-9_-]{43,}/g;
const capabilityWindowLength = 43;
const capabilityHashBase = 31;
// A rolling fingerprint narrows candidates; SHA-256 still decides exact matches.
const fingerprintPower = (() => {
  let power = 1;
  for (let index = 1; index < capabilityWindowLength; index++) power = Math.imul(power, capabilityHashBase);
  return power;
})();
function fingerprint(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) hash = (Math.imul(hash, capabilityHashBase) + value.charCodeAt(index)) | 0;
  return hash;
}
function containsForbiddenCapability(value: string, digests: ReadonlySet<string>, fingerprints: ReadonlySet<number>): boolean {
  for (const match of value.matchAll(capabilityRun)) {
    const run = match[0];
    let hash = fingerprint(run.slice(0, capabilityWindowLength));
    for (let index = 0; index <= run.length - capabilityWindowLength; index++) {
      if (fingerprints.has(hash) && digests.has(createHash("sha256").update(run.slice(index, index + capabilityWindowLength)).digest("hex"))) return true;
      if (index + capabilityWindowLength < run.length) {
        hash = (Math.imul(hash - Math.imul(run.charCodeAt(index), fingerprintPower), capabilityHashBase) + run.charCodeAt(index + capabilityWindowLength)) | 0;
      }
    }
  }
  return false;
}
const assignmentCandidate = /(?:\b[A-Za-z_][A-Za-z0-9_.-]*|["'][^"'\r\n]+["'])\s*[:=]/g;
function isPublicCountField(key: string, value: unknown): boolean {
  return /_count$/i.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2")) &&
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function forbiddenKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
  return /(?:^|_)(?:token|secret|password|passwd|passphrase|pwd|credential|authorization|auth|capability|cookie|session)(?:_|$)/.test(normalized) ||
    /(?:token|secret|password|passwd|passphrase|pwd|credential|authorization|auth|apikey|accesskey|accountkey|privatekey|capability|cookie|sessionid)$/.test(normalized.replaceAll("_", "")) ||
    /(?:^|_)(?:api|access|account|private)_key(?:_|$)/.test(normalized) ||
    /^(?:api_key|access_key|private_key|agent_session|pane_id|workspace_path|result_path|agent_name)$/.test(normalized) ||
    normalized.startsWith("herdr_");
}
const hasInvalidUnicode = (value: string): boolean => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);

interface MatchNode { next: Map<string, number>; fail: number; terminal: boolean }
class ForbiddenValueMatcher {
  private readonly exact = new Set<string>();
  private readonly nodes: MatchNode[] = [{ next: new Map(), fail: 0, terminal: false }];
  constructor(values: readonly string[]) {
    for (const value of new Set(values)) {
      if (value.length < 8) { this.exact.add(value); continue; }
      let state = 0;
      for (const char of value) {
        let next = this.nodes[state]!.next.get(char);
        if (next === undefined) {
          next = this.nodes.length;
          this.nodes[state]!.next.set(char, next);
          this.nodes.push({ next: new Map(), fail: 0, terminal: false });
        }
        state = next;
      }
      this.nodes[state]!.terminal = true;
    }
    const queue = [...this.nodes[0]!.next.values()];
    for (let index = 0; index < queue.length; index++) {
      const state = queue[index]!;
      for (const [char, child] of this.nodes[state]!.next) {
        let fallback = this.nodes[state]!.fail;
        while (fallback && !this.nodes[fallback]!.next.has(char)) fallback = this.nodes[fallback]!.fail;
        this.nodes[child]!.fail = this.nodes[fallback]!.next.get(char) ?? 0;
        this.nodes[child]!.terminal ||= this.nodes[this.nodes[child]!.fail]!.terminal;
        queue.push(child);
      }
    }
  }
  contains(value: string): boolean {
    if (this.exact.has(value)) return true;
    let state = 0;
    for (const char of value) {
      while (state && !this.nodes[state]!.next.has(char)) state = this.nodes[state]!.fail;
      state = this.nodes[state]!.next.get(char) ?? 0;
      if (this.nodes[state]!.terminal) return true;
    }
    return false;
  }
}

function assertSafeJson(value: unknown, depth = 0, forbiddenDigests?: ReadonlySet<string>, forbiddenValues?: ForbiddenValueMatcher, forbiddenFingerprints?: ReadonlySet<number>): void {
  if (depth > 64) throw new JobResultPublishError("invalid_request");
  if (typeof value === "string") {
    for (const match of value.matchAll(networkUrlCandidate)) {
      if (hasSignedQueryKey(match[0]) || hasPrivateHttpHost(match[0])) throw new JobResultPublishError("content_requires_redaction");
    }
    for (const match of value.matchAll(assignmentCandidate)) {
      const rawKey = match[0].replace(/\s*[:=]$/, "");
      let key = rawKey;
      if (rawKey.startsWith('"')) {
        try { key = JSON.parse(rawKey); } catch { throw new JobResultPublishError("content_requires_redaction"); }
      } else if (rawKey.startsWith("'")) key = rawKey.slice(1, -1);
      if (forbiddenKey(key)) throw new JobResultPublishError("content_requires_redaction");
    }
    if (forbiddenDigests && forbiddenFingerprints && containsForbiddenCapability(value, forbiddenDigests, forbiddenFingerprints)) throw new JobResultPublishError("content_requires_redaction");
    if (forbiddenValues?.contains(value)) {
      throw new JobResultPublishError("content_requires_redaction");
    }
    if (sensitive.test(value) || localPath.test(value) || windowsUncPath.test(value) || hasPrivateSlashAuthority(value) || slackMention.test(value) || hasPrivateJwkText(value)) throw new JobResultPublishError("content_requires_redaction");
    if (hasInvalidUnicode(value)) throw new JobResultPublishError("invalid_request");
  } else if (Array.isArray(value)) {
    for (const item of value) assertSafeJson(item, depth + 1, forbiddenDigests, forbiddenValues, forbiddenFingerprints);
  } else if (value !== null && typeof value === "object") {
    if (hasPrivateJwkFields(value as Record<string, unknown>)) throw new JobResultPublishError("content_requires_redaction");
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenKey(key) && !isPublicCountField(key, item)) throw new JobResultPublishError("content_requires_redaction");
      assertSafeJson(key, depth + 1, forbiddenDigests, forbiddenValues, forbiddenFingerprints);
      assertSafeJson(item, depth + 1, forbiddenDigests, forbiddenValues, forbiddenFingerprints);
    }
  } else if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new JobResultPublishError("invalid_request");
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
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareCodePoints(left: string, right: string): number {
  const a = left[Symbol.iterator]();
  const b = right[Symbol.iterator]();
  while (true) {
    const currentA = a.next();
    const currentB = b.next();
    if (currentA.done || currentB.done) return currentA.done ? currentB.done ? 0 : -1 : 1;
    const difference = currentA.value.codePointAt(0)! - currentB.value.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
}

const jsonValue: z.ZodType<unknown> = z.json();
const requestSchema = z.object({
  schema_version: z.literal(1),
  status: z.enum(["completed", "failed"]),
  summary: z.string().min(1).refine(value => value.trim().length > 0),
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
  fence: { jobId: string; publishableStatuses: readonly ["dispatching", "running"]; grantGeneration: number;
    attemptCount: number; paneId: string | null; session: string };
  /** Call inside the synchronous durable transaction immediately before Result creation. */
  assertCurrentGrant: () => void;
}

export function validateJobResultPublish(input: unknown, job: Pick<JobRow, "job_id" | "status">, completedAt: string, forbiddenDigests?: ReadonlySet<string>, forbiddenValues?: readonly string[], forbiddenFingerprints?: ReadonlySet<number>): ValidatedJobResultPublish {
  assertJsonDepth(input);
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success || !Number.isFinite(Date.parse(completedAt)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(completedAt)) {
    throw new JobResultPublishError("invalid_request");
  }
  assertSafeJson(parsed.data, 0, forbiddenDigests, forbiddenValues ? new ForbiddenValueMatcher(forbiddenValues) : undefined, forbiddenFingerprints);
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
  generation: number;
  session: string;
  attemptCount: number;
  paneId: string | null;
  agentName: string | null;
  herdrWorkspaceId: string | null;
  privateValues: readonly string[];
  expiresAt: number;
  renewableAt: number;
  revoked: boolean;
  fingerprint: number;
}

function grantPrivateValues(job: JobRow, session: string): string[] {
  let sessionParts: unknown;
  try { sessionParts = JSON.parse(session); } catch { /* A legacy opaque session is still valid. */ }
  return [session, job.herdr_pane_id, job.herdr_workspace_id, job.agent_name,
    job.objective, job.workspace_path, job.result_path,
    ...(Array.isArray(sessionParts) && sessionParts.length === 4 ? sessionParts : [])]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

/** Process-local grants fail closed on restart. Only the private worker transport receives the raw token. */
export class JobResultPublishCapabilities {
  private readonly grants = new Map<string, Grant>();
  private readonly generations = new Map<string, number>();
  private readonly renewalKey = randomBytes(32);
  constructor(
    private readonly currentSession: (jobId: string) => string | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  issue(job: JobRow, session: string): { capability: string; expiresAt: string } {
    if (job.status !== "dispatching" || !validJobResultPublishSession(session) || this.currentSession(job.job_id) !== session) {
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
    this.grants.set(key, { jobId: job.job_id, generation: predecessor.generation, session, attemptCount: job.attempt_count,
      paneId: job.herdr_pane_id, agentName: job.agent_name, herdrWorkspaceId: job.herdr_workspace_id,
      privateValues: grantPrivateValues(job, session),
      expiresAt, renewableAt: this.now() + jobResultPublishTtlMs / 2, revoked: false, fingerprint: fingerprint(next) });
    return { capability: next, expiresAt: new Date(expiresAt).toISOString() };
  }

  private mint(job: JobRow, session: string): { capability: string; expiresAt: string } {
    for (const [key, grant] of this.grants) if (grant.expiresAt <= this.now()) this.grants.delete(key);
    for (const grant of this.grants.values()) if (grant.jobId === job.job_id) grant.revoked = true;
    const generation = (this.generations.get(job.job_id) ?? 0) + 1;
    this.generations.set(job.job_id, generation);
    const capability = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + jobResultPublishTtlMs;
    this.grants.set(createHash("sha256").update(capability).digest("hex"), {
      jobId: job.job_id, generation, session, attemptCount: job.attempt_count, paneId: job.herdr_pane_id,
      agentName: job.agent_name, herdrWorkspaceId: job.herdr_workspace_id,
      privateValues: grantPrivateValues(job, session),
      expiresAt, renewableAt: this.now() + jobResultPublishTtlMs / 2, revoked: false, fingerprint: fingerprint(capability),
    });
    return { capability, expiresAt: new Date(expiresAt).toISOString() };
  }

  revokeJob(jobId: string): void {
    this.generations.set(jobId, (this.generations.get(jobId) ?? 0) + 1);
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
    const terminalReconcile = (job.status === "completed" || job.status === "failed") && typeof job.result_json === "string";
    if (grant.session !== session) throw new JobResultPublishError("worker_session_stale");
    if (terminalReconcile) return job;
    if (this.currentSession(job.job_id) !== session ||
      grant.attemptCount !== job.attempt_count || grant.paneId !== job.herdr_pane_id) {
      throw new JobResultPublishError("worker_session_stale");
    }
    if (job.status !== "running" && job.status !== "dispatching") {
      throw new JobResultPublishError("job_not_publishable");
    }
    return job;
  }

  validate(capability: string, session: string, input: unknown, getJob: (jobId: string) => JobRow | undefined): AuthorizedJobResultPublish {
    const job = this.authorize(capability, session, getJob);
    const grant = this.grants.get(createHash("sha256").update(capability).digest("hex"))!;
    const forbiddenDigests = new Set([...this.grants.entries()]
      .filter(([, candidate]) => candidate.expiresAt > this.now())
      .map(([digest]) => digest));
    const forbiddenFingerprints = new Set([...this.grants.values()]
      .filter(candidate => candidate.expiresAt > this.now())
      .map(candidate => candidate.fingerprint));
    const grantIdentities = [...this.grants.values()]
      .filter(candidate => candidate.expiresAt > this.now())
      .flatMap(candidate => candidate.privateValues);
    const forbiddenValues = [grant.paneId, job.herdr_pane_id, job.herdr_workspace_id, job.workspace_path,
      job.result_path, job.agent_name, job.objective, grant.session, ...grantIdentities]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    return { ...validateJobResultPublish(input, job, new Date(this.now()).toISOString(), forbiddenDigests, forbiddenValues, forbiddenFingerprints),
      fence: { jobId: job.job_id, publishableStatuses: ["dispatching", "running"], grantGeneration: grant.generation,
        attemptCount: grant.attemptCount, paneId: grant.paneId, session: grant.session },
      assertCurrentGrant: () => {
        if (grant.revoked || this.generations.get(grant.jobId) !== grant.generation) throw new JobResultPublishError("capability_revoked");
        if (this.now() >= grant.expiresAt) throw new JobResultPublishError("capability_expired");
      } };
  }
}
