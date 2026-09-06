import { ScheduleError } from "./errors.js";
import { canonicalJson, parseStrictJson } from "./json.js";

// ADR 0001のv1値。変更は別versionを必要とする。
const POLICY_V1 = {
  "admin": {
    "allowed": [
      "redacted_metadata",
      "pause",
      "cancel",
      "purge",
      "receipt_reconcile"
    ],
    "owner_approval_required": [
      "resume",
      "new_revision",
      "new_execution"
    ]
  },
  "authorization": {
    "expiry_exclusive": true,
    "failure": "pause",
    "max_age_seconds": 2592000,
    "revalidate": [
      "run_start",
      "external_write"
    ]
  },
  "calendar": {
    "gap": "skip",
    "invalid_day": "skip",
    "overlap": "first",
    "tzdb_update": "pause_preview_reauthorize"
  },
  "contract": "scheduler-policy",
  "execution": {
    "awake_detection_slo_seconds": 60,
    "misfire": "latest_one",
    "misfire_grace_seconds": 900,
    "overlap": "skip",
    "work_timeout_seconds": 3600
  },
  "external_write": {
    "allowed": [
      "slack.reminder.post",
      "slack.work_result.post"
    ],
    "ambiguous": "needs_review",
    "max_attempts": 3,
    "reminder_body": "immutable",
    "retry_delays_seconds": [
      1,
      5
    ],
    "slack_schedule_message": false,
    "target": "fixed",
    "work_body": "redacted_result",
    "work_mode": "read_only",
    "work_result_retry_seconds": 900
  },
  "limits": {
    "catch_up_count": 1,
    "minimum_period": "one_civil_day",
    "owner_nonterminal_schedules": 20,
    "preview_count": 100,
    "preview_days": 366,
    "tenant_nonterminal_schedules": 100
  },
  "notification": {
    "body_max_code_points": 2000,
    "cross_tenant_allowed": false,
    "objective_max_code_points": 4000,
    "reminder_default": "origin_thread",
    "work_default": "owner_dm",
    "work_none_allowed": true
  },
  "retention": {
    "active_high_watermark": true,
    "audit_days": 90,
    "backup_content": false,
    "inactive_content_days": 7,
    "purge_interval_seconds": 86400,
    "terminal_metadata_days": 30,
    "unresolved_fence": "until_resolved"
  },
  "version": 1
} as const;

export type SchedulePolicy = typeof POLICY_V1;
export function parsePolicy(input: unknown): SchedulePolicy {
  if (input === null || typeof input !== "object") throw new ScheduleError("invalid_policy");
  if ((input as { version?: unknown }).version !== 1) throw new ScheduleError("unknown_version");
  if (!matchesPolicy(input, POLICY_V1)) throw new ScheduleError("invalid_policy");
  return JSON.parse(canonicalJson(POLICY_V1)) as SchedulePolicy;
}
export function defaultPolicy(): SchedulePolicy { return parsePolicy(POLICY_V1); }
export function decodePolicy(text: string): SchedulePolicy { return parsePolicy(parseStrictJson(text)); }
export function encodePolicy(policy: SchedulePolicy): string { return canonicalJson(parsePolicy(policy)); }

function matchesPolicy(input: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return input === expected;
  if (input === null || typeof input !== 'object' || Array.isArray(input) !== Array.isArray(expected)) return false;
  const keys = Object.keys(expected);
  if (Reflect.ownKeys(input).length !== Reflect.ownKeys(expected).length) return false;
  return keys.every(key => Object.hasOwn(input, key) && matchesPolicy((input as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key]));
}
