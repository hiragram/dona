import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadRuntimeConfig, type SlackLogLevel } from "./config.js";

export interface SlackAdapterConfig {
  workspaces: string[];
  dispatcherSocketPath: string;
  healthSocketPath: string;
  updateInternalTokenPath: string;
  dispatcherConnectTimeoutMs: number;
  dispatcherTimeoutMs: number;
  shutdownGraceMs: number;
  socketModeEnabled: true;
  logLevel: SlackLogLevel;
  buildSha: string;
  appSchemaWrite: 2 | 3;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function socketModeEnabled(value: string | undefined): true {
  if (value === undefined || value.trim() === "" || value.trim().toLowerCase() === "true") return true;
  throw new Error("SLACK_SOCKET_MODE_ENABLED must be true; HTTP event reception is not supported");
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

function appSchemaWrite(env: NodeJS.ProcessEnv): 2 | 3 {
  const manifestPath = env.DONA_RELEASE_MANIFEST_PATH;
  if (!manifestPath) return 3;
  const parsed = JSON.parse(fs.readFileSync(expandHome(manifestPath), "utf8")) as {
    compatibility?: { app_schema_write?: unknown };
  };
  const write = parsed.compatibility?.app_schema_write;
  if (write !== 2 && write !== 3) throw new Error("DONA release manifest app_schema_write is invalid");
  return write;
}

export function loadAdapterConfig(env: NodeJS.ProcessEnv = process.env): SlackAdapterConfig {
  const base = path.join(os.homedir(), "Library", "Application Support", "Dona");
  const existing = loadRuntimeConfig(env);
  return {
    workspaces: existing.workspaces,
    dispatcherSocketPath: expandHome(
      env.DONA_SOCKET_PATH ?? path.join(base, "run", "dispatcher.sock"),
    ),
    healthSocketPath: expandHome(
      env.SLACK_HEALTH_SOCKET_PATH ?? path.join(base, "run", "slack-adapter.sock"),
    ),
    updateInternalTokenPath: expandHome(
      env.DONA_UPDATE_INTERNAL_TOKEN_PATH ?? path.join(base, "update-control", "dispatcher.token"),
    ),
    dispatcherConnectTimeoutMs: positiveInteger(
      env.DONA_CONNECT_TIMEOUT_MS,
      500,
      "DONA_CONNECT_TIMEOUT_MS",
    ),
    dispatcherTimeoutMs: positiveInteger(env.DONA_REQUEST_TIMEOUT_MS, 2_000, "DONA_REQUEST_TIMEOUT_MS"),
    shutdownGraceMs: positiveInteger(env.SLACK_SHUTDOWN_GRACE_MS, 3_000, "SLACK_SHUTDOWN_GRACE_MS"),
    socketModeEnabled: socketModeEnabled(env.SLACK_SOCKET_MODE_ENABLED),
    logLevel: existing.logLevel,
    buildSha: buildSha(env),
    appSchemaWrite: appSchemaWrite(env),
  };
}
