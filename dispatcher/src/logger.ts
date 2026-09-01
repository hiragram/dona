export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

function write(level: LogLevel, component: string, message: string, fields: LogFields = {}, stderrOnly = false): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    component,
    message,
    ...fields,
  });
  (stderrOnly || level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
}

export function createLogger(component: string, options: { stderrOnly?: boolean } = {}): Logger {
  const stderrOnly = options.stderrOnly ?? false;
  return {
    debug: (message, fields) => write("debug", component, message, fields, stderrOnly),
    info: (message, fields) => write("info", component, message, fields, stderrOnly),
    warn: (message, fields) => write("warn", component, message, fields, stderrOnly),
    error: (message, fields) => write("error", component, message, fields, stderrOnly),
  };
}
