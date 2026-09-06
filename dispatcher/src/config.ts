import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DispatcherConfig {
  socketPath: string;
  databasePath: string;
  resultsDir: string;
  herdrSession: string;
  agentName: string;
  herdrPath: string;
  requestMaxBytes: number;
  agentWaitTimeoutMs: number;
  agentMissingGraceMs: number;
  queuePollMs: number;
  maxAttempts: number;
  jobsWorkspaceRoot: string;
  jobResultsDir: string;
  jobsPerEventMax: number;
  jobObjectiveTotalMaxBytes: number;
  jobConcurrency: number;
  jobConcurrencyPerEvent: number;
  jobAgentStartTimeoutMs: number;
  jobCommandTimeoutMs: number;
  ghPath: string;
  gitPath: string;
  updaterSocketPath: string;
  updateInternalTokenPath: string;
  updateNotificationDatabasePath: string;
  jobProgressDatabasePath: string;
  slackAdapterSocketPath: string;
  buildSha: string;
}

export const jobResourceDefaults = {
  jobsPerEventMax: 8,
  jobObjectiveTotalMaxBytes: 400_000,
  jobConcurrencyPerEvent: 2,
} as const;

export const jobResourceHardLimits = {
  jobsPerEventMax: 32,
  jobConcurrencyPerEvent: 32,
} as const;

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  const parsed = positiveInteger(value, fallback, name);
  if (parsed > maximum) throw new Error(`${name} must be at most ${maximum}`);
  return parsed;
}

function nonEmpty(value: string | undefined, fallback: string, name: string): string {
  const result = value?.trim() || fallback;
  if (!result) throw new Error(`${name} must not be empty`);
  return result;
}

function buildSha(env: NodeJS.ProcessEnv): string {
  const explicit = env.DONA_BUILD_SHA?.trim();
  if (explicit) return explicit;
  const manifestPath = env.DONA_RELEASE_MANIFEST_PATH;
  if (!manifestPath) return "development";
  const parsed = JSON.parse(fs.readFileSync(expandHome(manifestPath), "utf8")) as { sha?: unknown };
  if (typeof parsed.sha !== "string" || !/^[0-9a-f]{40}$/.test(parsed.sha)) throw new Error("DONA release manifest SHA is invalid");
  return parsed.sha;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DispatcherConfig {
  const base = path.join(os.homedir(), "Library", "Application Support", "Dona");
  return {
    socketPath: expandHome(env.DONA_SOCKET_PATH ?? path.join(base, "run", "dispatcher.sock")),
    databasePath: expandHome(env.DONA_DATABASE_PATH ?? path.join(base, "dona.sqlite3")),
    resultsDir: expandHome(env.DONA_RESULTS_DIR ?? path.join(base, "results")),
    herdrSession: nonEmpty(env.HERDR_SESSION, "dona", "HERDR_SESSION"),
    agentName: nonEmpty(env.DONA_AGENT_NAME, "dona-main", "DONA_AGENT_NAME"),
    herdrPath: nonEmpty(env.DONA_HERDR_PATH, "herdr", "DONA_HERDR_PATH"),
    requestMaxBytes: positiveInteger(env.DONA_REQUEST_MAX_BYTES, 1_048_576, "DONA_REQUEST_MAX_BYTES"),
    agentWaitTimeoutMs: positiveInteger(
      env.DONA_AGENT_WAIT_TIMEOUT_MS,
      120_000,
      "DONA_AGENT_WAIT_TIMEOUT_MS",
    ),
    agentMissingGraceMs: positiveInteger(
      env.DONA_AGENT_MISSING_GRACE_MS,
      5_000,
      "DONA_AGENT_MISSING_GRACE_MS",
    ),
    queuePollMs: positiveInteger(env.DONA_QUEUE_POLL_MS, 1_000, "DONA_QUEUE_POLL_MS"),
    maxAttempts: positiveInteger(env.DONA_MAX_ATTEMPTS, 5, "DONA_MAX_ATTEMPTS"),
    jobsWorkspaceRoot: expandHome(
      env.DONA_JOBS_WORKSPACE_ROOT ?? path.join(os.homedir(), ".dona", "workspaces"),
    ),
    jobResultsDir: expandHome(env.DONA_JOB_RESULTS_DIR ?? path.join(base, "job-results")),
    jobsPerEventMax: boundedPositiveInteger(
      env.DONA_JOBS_PER_EVENT_MAX,
      jobResourceDefaults.jobsPerEventMax,
      "DONA_JOBS_PER_EVENT_MAX",
      jobResourceHardLimits.jobsPerEventMax,
    ),
    jobObjectiveTotalMaxBytes: positiveInteger(
      env.DONA_JOB_OBJECTIVE_TOTAL_MAX_BYTES,
      jobResourceDefaults.jobObjectiveTotalMaxBytes,
      "DONA_JOB_OBJECTIVE_TOTAL_MAX_BYTES",
    ),
    jobConcurrency: positiveInteger(env.DONA_JOB_CONCURRENCY, 4, "DONA_JOB_CONCURRENCY"),
    jobConcurrencyPerEvent: boundedPositiveInteger(
      env.DONA_JOB_CONCURRENCY_PER_EVENT,
      jobResourceDefaults.jobConcurrencyPerEvent,
      "DONA_JOB_CONCURRENCY_PER_EVENT",
      jobResourceHardLimits.jobConcurrencyPerEvent,
    ),
    jobAgentStartTimeoutMs: positiveInteger(
      env.DONA_JOB_AGENT_START_TIMEOUT_MS,
      30_000,
      "DONA_JOB_AGENT_START_TIMEOUT_MS",
    ),
    jobCommandTimeoutMs: positiveInteger(
      env.DONA_JOB_COMMAND_TIMEOUT_MS,
      10_000,
      "DONA_JOB_COMMAND_TIMEOUT_MS",
    ),
    ghPath: nonEmpty(env.DONA_GH_PATH, "gh", "DONA_GH_PATH"),
    gitPath: nonEmpty(env.DONA_GIT_PATH, "git", "DONA_GIT_PATH"),
    updaterSocketPath: expandHome(
      env.DONA_UPDATER_SOCKET_PATH ?? path.join(base, "update-control", "updater.sock"),
    ),
    updateInternalTokenPath: expandHome(
      env.DONA_UPDATE_INTERNAL_TOKEN_PATH ?? path.join(base, "update-control", "dispatcher.token"),
    ),
    updateNotificationDatabasePath: expandHome(
      env.DONA_UPDATE_NOTIFICATION_DATABASE_PATH ?? path.join(base, "update-notifications.sqlite3"),
    ),
    jobProgressDatabasePath: expandHome(
      env.DONA_JOB_PROGRESS_DATABASE_PATH ?? path.join(base, "job-progress.sqlite3"),
    ),
    slackAdapterSocketPath: expandHome(
      env.SLACK_HEALTH_SOCKET_PATH ?? path.join(base, "run", "slack-adapter.sock"),
    ),
    buildSha: buildSha(env),
  };
}
