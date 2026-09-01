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
  jobConcurrency: number;
  jobAgentStartTimeoutMs: number;
  jobCommandTimeoutMs: number;
  ghPath: string;
  gitPath: string;
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
  };
}
