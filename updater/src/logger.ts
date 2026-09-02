import type { Logger } from "./ports.js";
import { redactValue } from "./redaction.js";

export function createLogger(component = "updater"): Logger {
  const write = (level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}): void => {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      component,
      message: redactValue(message),
      ...(redactValue(fields) as Record<string, unknown>),
    });
    (level === "error" ? console.error : level === "warn" ? console.warn : console.info)(line);
  };
  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}
