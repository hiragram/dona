import type { SlackLogLevel } from "./config.js";
import { LogLevel as SocketLogLevel, type Logger as SocketLogger } from "@slack/socket-mode";

const priorities: Record<SlackLogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface SlackLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function sanitizeLogValue(value: unknown, key = "", depth = 0): unknown {
  if (
    [
      "token",
      "app_token",
      "bot_token",
      "signing_secret",
      "authorization",
      "url",
      "websocket_url",
      "payload",
      "body",
      "text",
    ].includes(key)
  ) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return value
      .replace(/xapp-[^\s"']+/g, "[REDACTED_APP_TOKEN]")
      .replace(/xoxb-[^\s"']+/g, "[REDACTED_BOT_TOKEN]")
      .replace(/wss:\/\/[^\s"']+/g, "[REDACTED_WEBSOCKET_URL]");
  }
  if (value instanceof Error) return sanitizeLogValue(`${value.name}: ${value.message}`, key, depth);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 4) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.map((child) => sanitizeLogValue(child, key, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
      childKey,
      sanitizeLogValue(child, childKey.toLowerCase(), depth + 1),
    ]),
  );
}

export function createSlackLogger(
  level: SlackLogLevel,
  options: { component?: string; stderrOnly?: boolean } = {},
): SlackLogger {
  const log = (entryLevel: SlackLogLevel, message: string, fields: Record<string, unknown> = {}): void => {
    if (priorities[entryLevel] < priorities[level]) return;
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: entryLevel,
      component: options.component ?? "slack_adapter",
      message: sanitizeLogValue(message),
      ...(sanitizeLogValue(fields) as Record<string, unknown>),
    });
    (options.stderrOnly || entryLevel === "error" ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (message, fields) => log("debug", message, fields),
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
  };
}

function redactSdkDetail(value: unknown): string {
  const raw = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  if (
    raw.includes("Received a message on the WebSocket") ||
    raw.includes("Unable to parse an incoming WebSocket message") ||
    raw.includes("Calling ack()") ||
    raw.includes("Sending a WebSocket message")
  ) {
    return "[Socket Mode payload omitted]";
  }
  return raw
    .replace(/xapp-[^\s"']+/g, "[REDACTED_APP_TOKEN]")
    .replace(/xoxb-[^\s"']+/g, "[REDACTED_BOT_TOKEN]")
    .replace(/wss:\/\/[^\s"']+/g, "[REDACTED_WEBSOCKET_URL]");
}

export function createSocketSdkLogger(base: SlackLogger, level: SlackLogLevel): SocketLogger {
  let name = "socket_mode";
  let currentLevel = SocketLogLevel[level.toUpperCase() as keyof typeof SocketLogLevel];
  const emit = (entryLevel: SlackLogLevel, details: unknown[]): void => {
    base[entryLevel]("Slack Socket Mode SDK", {
      sdk_name: name,
      detail: details.map(redactSdkDetail).join(" "),
    });
  };
  return {
    debug: (...details) => emit("debug", details),
    info: (...details) => emit("info", details),
    warn: (...details) => emit("warn", details),
    error: (...details) => emit("error", details),
    getLevel: () => currentLevel,
    setLevel: (next) => void (currentLevel = next),
    setName: (next) => void (name = next),
  };
}
