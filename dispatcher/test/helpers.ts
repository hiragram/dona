import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { DispatcherConfig } from "../src/config.js";
import type { EventEnvelope } from "../src/types.js";

export async function tempConfig(): Promise<{ root: string; config: DispatcherConfig }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-dispatcher-test-"));
  return {
    root,
    config: {
      socketPath: path.join(root, "run", "dispatcher.sock"),
      databasePath: path.join(root, "dona.sqlite3"),
      resultsDir: path.join(root, "results"),
      herdrSession: "dona",
      agentName: "dona-main",
      herdrPath: "herdr",
      requestMaxBytes: 1_048_576,
      agentWaitTimeoutMs: 100,
      agentMissingGraceMs: 50,
      queuePollMs: 10,
      maxAttempts: 5,
      jobsWorkspaceRoot: path.join(root, "workspaces"),
      jobResultsDir: path.join(root, "job-results"),
      jobsPerEventMax: 8,
      jobObjectiveTotalMaxBytes: 400_000,
      jobConcurrency: 4,
      jobConcurrencyPerEvent: 2,
      jobAgentStartTimeoutMs: 100,
      jobCommandTimeoutMs: 100,
      ghPath: "gh",
      gitPath: "git",
      updaterSocketPath: path.join(root, "update-control", "updater.sock"),
      updateInternalTokenPath: path.join(root, "update-control", "dispatcher.token"),
    updateNotificationDatabasePath: path.join(root, "update-notifications.sqlite3"),
    jobProgressDatabasePath: path.join(root, "job-progress.sqlite3"),
      slackAdapterSocketPath: path.join(root, "run", "slack-adapter.sock"),
      buildSha: "development",
    },
  };
}

export function eventEnvelope(externalEventId: string): EventEnvelope {
  return {
    schema_version: 1,
    source: "slack",
    external_event_id: externalEventId,
    type: "app_mention",
    occurred_at: "2026-09-01T10:20:30.000Z",
    subject: {
      workspace_id: "T_TEST",
      channel_id: "C_TEST",
      thread_ts: "1756722030.123456",
      actor_id: "U_TEST",
    },
    payload: { text: "test", event_ts: "1756722030.123456" },
    reply_target: {
      kind: "slack_thread",
      workspace_id: "T_TEST",
      channel_id: "C_TEST",
      thread_ts: "1756722030.123456",
    },
  };
}

export async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
