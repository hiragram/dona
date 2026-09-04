import { createHash } from "node:crypto";

import type {
  ActivationReceipt,
  ApplyRequest,
  CancelRequest,
  Compatibility,
  PlanRequest,
  ReleaseManifest,
  ReplyTarget,
} from "./types.js";

const eventIdPattern = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/i;
const requestIdPattern = /^upd_[0-9a-hjkmnp-tv-z]{26}$/;
const planIdPattern = /^plan_[0-9a-hjkmnp-tv-z]{26}$/;
const shaPattern = /^[0-9a-f]{40}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const approvalPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const slackIdPattern = /^[A-Z0-9][A-Z0-9_-]{0,63}$/i;
const threadPattern = /^\d+\.\d+$/;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new ValidationError(`${name} contains unsupported fields: ${extras.join(", ")}`);
}

function string(value: unknown, pattern: RegExp, name: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new ValidationError(`${name} is invalid`);
  return value;
}

export function fullSha(value: unknown, name = "sha"): string {
  return string(value, shaPattern, name);
}

export function parseReplyTarget(input: unknown): ReplyTarget {
  const value = object(input, "reply_target");
  exactKeys(value, ["kind", "workspace_id", "channel_id", "thread_ts"], "reply_target");
  if (value.kind !== "slack_thread") throw new ValidationError("reply_target.kind must be slack_thread");
  return {
    kind: "slack_thread",
    workspace_id: string(value.workspace_id, slackIdPattern, "reply_target.workspace_id"),
    channel_id: string(value.channel_id, slackIdPattern, "reply_target.channel_id"),
    thread_ts: string(value.thread_ts, threadPattern, "reply_target.thread_ts"),
  };
}

export function parsePlanRequest(input: unknown): PlanRequest {
  const value = object(input, "request");
  exactKeys(value, ["source_event_id", "reply_target"], "request");
  return {
    source_event_id: string(value.source_event_id, eventIdPattern, "source_event_id"),
    reply_target: parseReplyTarget(value.reply_target),
  };
}

export function parseApplyRequest(input: unknown): ApplyRequest {
  const value = object(input, "request");
  exactKeys(value, ["source_event_id", "reply_target", "plan_id", "plan_hash", "approval_id"], "request");
  return {
    source_event_id: string(value.source_event_id, eventIdPattern, "source_event_id"),
    reply_target: parseReplyTarget(value.reply_target),
    plan_id: string(value.plan_id, planIdPattern, "plan_id"),
    plan_hash: string(value.plan_hash, hashPattern, "plan_hash"),
    approval_id: string(value.approval_id, approvalPattern, "approval_id"),
  };
}

export function parseCancelRequest(input: unknown): CancelRequest {
  const value = object(input, "request");
  exactKeys(value, ["source_event_id", "reply_target", "request_id", "reason"], "request");
  const reason = value.reason;
  if (reason !== undefined && (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 2_000)) {
    throw new ValidationError("reason is invalid");
  }
  return {
    source_event_id: string(value.source_event_id, eventIdPattern, "source_event_id"),
    reply_target: parseReplyTarget(value.reply_target),
    request_id: string(value.request_id, requestIdPattern, "request_id"),
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

export function parseRequestId(value: unknown): string {
  return string(value, requestIdPattern, "request_id");
}

export function parseActivationReceipt(input: unknown): ActivationReceipt {
  const value = object(input, "activation receipt");
  exactKeys(value, [
    "schema_version", "request_id", "fence", "generation", "from_sha", "to_sha", "pointer_switched_at",
  ], "activation receipt");
  if (value.schema_version !== 1 || !Number.isSafeInteger(value.fence) || (value.fence as number) < 1 ||
    !Number.isSafeInteger(value.generation) || (value.generation as number) < 1) {
    throw new ValidationError("activation receipt schema, fence, or generation is invalid");
  }
  const switchedAt = string(
    value.pointer_switched_at,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
    "activation receipt pointer_switched_at",
  );
  if (Number.isNaN(Date.parse(switchedAt))) throw new ValidationError("activation receipt timestamp is invalid");
  return {
    schema_version: 1,
    request_id: string(value.request_id, requestIdPattern, "activation receipt request_id"),
    fence: value.fence as number,
    generation: value.generation as number,
    from_sha: fullSha(value.from_sha, "activation receipt from_sha"),
    to_sha: fullSha(value.to_sha, "activation receipt to_sha"),
    pointer_switched_at: switchedAt,
  };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseCompatibilityMetadata(input: unknown): Compatibility {
  const value = object(input, "release compatibility");
  exactKeys(value, [
    "schema_version", "protocol", "config", "app_schema_read_min", "app_schema_read_max", "app_schema_write", "rollback_safe",
  ], "release compatibility");
  if (value.schema_version !== 1) throw new ValidationError("release compatibility schema_version is invalid");
  for (const field of ["protocol", "config", "app_schema_read_min", "app_schema_read_max", "app_schema_write"] as const) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 1) throw new ValidationError(`release compatibility ${field} is invalid`);
  }
  const result: Compatibility = {
    protocol: value.protocol as number,
    config: value.config as number,
    app_schema_read_min: value.app_schema_read_min as number,
    app_schema_read_max: value.app_schema_read_max as number,
    app_schema_write: value.app_schema_write as number,
    rollback_safe: value.rollback_safe === true,
  };
  if (result.app_schema_read_min > result.app_schema_read_max || result.app_schema_write < result.app_schema_read_min || result.app_schema_write > result.app_schema_read_max) {
    throw new ValidationError("release compatibility app schema range is invalid");
  }
  return result;
}

export function parseReleaseManifest(input: unknown): ReleaseManifest {
  const value = object(input, "release manifest");
  exactKeys(value, [
    "schema_version", "sha", "repository", "policy_version", "lock_hashes", "node_version", "npm_version", "built_at", "compatibility",
  ], "release manifest");
  if (value.schema_version !== 1 || value.repository !== "hiragram/dona") {
    throw new ValidationError("release manifest schema or repository is invalid");
  }
  const policyVersion = string(value.policy_version, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, "release manifest policy_version");
  const locks = object(value.lock_hashes, "release manifest lock_hashes");
  exactKeys(locks, ["dispatcher", "sources/slack", "updater"], "release manifest lock_hashes");
  const builtAt = string(value.built_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, "release manifest built_at");
  if (Number.isNaN(Date.parse(builtAt))) throw new ValidationError("release manifest built_at is invalid");
  const version = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
  const manifestCompatibility = object(value.compatibility, "release manifest compatibility");
  exactKeys(manifestCompatibility, [
    "protocol", "config", "app_schema_read_min", "app_schema_read_max", "app_schema_write", "rollback_safe",
  ], "release manifest compatibility");
  return {
    schema_version: 1,
    sha: fullSha(value.sha, "release manifest sha"),
    repository: "hiragram/dona",
    policy_version: policyVersion,
    lock_hashes: {
      dispatcher: string(locks.dispatcher, hashPattern, "dispatcher lock hash"),
      "sources/slack": string(locks["sources/slack"], hashPattern, "sources/slack lock hash"),
      updater: string(locks.updater, hashPattern, "updater lock hash"),
    },
    node_version: string(value.node_version, version, "release manifest node_version"),
    npm_version: string(value.npm_version, version, "release manifest npm_version"),
    built_at: builtAt,
    compatibility: parseCompatibilityMetadata({ schema_version: 1, ...manifestCompatibility }),
  };
}
