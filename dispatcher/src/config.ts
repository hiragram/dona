import { queuePolicySchema, type QueuePolicy } from "./queue.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DispatcherConfig {
  githubPilot?: {
    connectionId: string; installationId: number; repositoryId: number; repositoryFullName: string;
    events: Readonly<Record<string, readonly string[]>>; webhookSecretPath: string;
    trustedProxy: { githubMetaIpAllowlist: true; perSourceRateAndConcurrencyLimit: true };
  };
  queuePolicy?: QueuePolicy;
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
  jobConcurrency: number;
  jobAgentStartTimeoutMs: number;
  jobCommandTimeoutMs: number;
  ghPath: string;
  gitPath: string;
  updaterSocketPath: string;
  updateInternalTokenPath: string;
  updateNotificationDatabasePath: string;
  slackAdapterSocketPath: string;
  buildSha: string;
}

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
  const githubPilot = env.DONA_GITHUB_PILOT_CONFIG === undefined ? undefined : (() => {
    const parsed = JSON.parse(env.DONA_GITHUB_PILOT_CONFIG) as Record<string, unknown>;
    if (typeof parsed.connectionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(parsed.connectionId) || !Number.isSafeInteger(parsed.installationId) ||
      !Number.isSafeInteger(parsed.repositoryId) || typeof parsed.repositoryFullName !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(parsed.repositoryFullName) || parsed.repositoryFullName.split("/").some(part => part === "." || part === "..") ||
      typeof parsed.webhookSecretPath !== "string" || !parsed.events || typeof parsed.events !== "object" || Array.isArray(parsed.events) ||
      !parsed.trustedProxy || typeof parsed.trustedProxy !== "object" ||
      (parsed.trustedProxy as Record<string, unknown>).githubMetaIpAllowlist !== true ||
      (parsed.trustedProxy as Record<string, unknown>).perSourceRateAndConcurrencyLimit !== true) {
      throw new Error("DONA_GITHUB_PILOT_CONFIG is invalid");
    }
    const events = Object.fromEntries(Object.entries(parsed.events).map(([event, actions]) => {
      if (!Array.isArray(actions) || actions.some(action => typeof action !== "string")) throw new Error("DONA_GITHUB_PILOT_CONFIG is invalid");
      return [event, actions as string[]];
    }));
    return { connectionId: parsed.connectionId, installationId: parsed.installationId as number,
      repositoryId: parsed.repositoryId as number, repositoryFullName: parsed.repositoryFullName,
      events, webhookSecretPath: expandHome(parsed.webhookSecretPath),
      trustedProxy: { githubMetaIpAllowlist: true as const, perSourceRateAndConcurrencyLimit: true as const } };
  })();
  return {
    ...(githubPilot === undefined ? {} : { githubPilot }),
    queuePolicy: queuePolicySchema.parse(JSON.parse(env.DONA_QUEUE_POLICY ?? "{}")),
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
    jobConcurrency: positiveInteger(env.DONA_JOB_CONCURRENCY, 4, "DONA_JOB_CONCURRENCY"),
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
    slackAdapterSocketPath: expandHome(
      env.SLACK_HEALTH_SOCKET_PATH ?? path.join(base, "run", "slack-adapter.sock"),
    ),
    buildSha: buildSha(env),
  };
}
