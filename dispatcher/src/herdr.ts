import { spawn } from "node:child_process";

export type AgentStatus = "idle" | "done" | "working" | "blocked" | "unknown";

export interface HerdrCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  errorCode?: string;
  agentStatus?: AgentStatus;
  agentIdentity?: string;
  stateChangeSeq?: number;
}

export interface HerdrClient {
  get(signal?: AbortSignal): Promise<HerdrCommandResult>;
  prompt(text: string, signal?: AbortSignal): Promise<HerdrCommandResult>;
  wait(signal?: AbortSignal): Promise<HerdrCommandResult>;
}

function findString(input: unknown, keys: readonly string[]): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key];
  }
  for (const value of Object.values(record)) {
    const nested = findString(value, keys);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function findAgentStatus(input: unknown): AgentStatus | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["agent_status", "status", "state"] as const) {
    const value = record[key];
    if (["idle", "done", "working", "blocked", "unknown"].includes(String(value))) {
      return value as AgentStatus;
    }
  }
  for (const value of Object.values(record)) {
    const nested = findAgentStatus(value);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function decorateResult(result: Omit<HerdrCommandResult, "errorCode" | "agentStatus">): HerdrCommandResult {
  const parsed = parseJson(result.ok ? result.stdout : result.stderr || result.stdout);
  const errorCode = findString(parsed, ["error_code", "code"]);
  const agentStatus = findAgentStatus(parsed);
  const agentName = findString(parsed, ["agent_name", "name"]);
  const paneId = findString(parsed, ["pane_id"]);
  const workspaceId = findString(parsed, ["workspace_id"]);
  const sequence = findValue(parsed, ["state_change_seq"]);
  return {
    ...result,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(agentStatus === undefined ? {} : { agentStatus }),
    ...(agentName || paneId || workspaceId ? { agentIdentity: JSON.stringify([workspaceId ?? null, paneId ?? null, agentName ?? null]) } : {}),
    ...(Number.isSafeInteger(sequence) && Number(sequence) >= 0 ? { stateChangeSeq: Number(sequence) } : {}),
  };
}

function findValue(input: unknown, keys: readonly string[]): unknown {
  if (input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of keys) if (record[key] !== undefined) return record[key];
  for (const value of Object.values(record)) { const found = findValue(value, keys); if (found !== undefined) return found; }
  return undefined;
}

export interface HerdrProcessOptions {
  executable: string;
  session: string;
  agentName: string;
  waitTimeoutMs: number;
  commandTimeoutMs?: number;
}

export class HerdrProcessClient implements HerdrClient {
  private readonly commandTimeoutMs: number;

  constructor(private readonly options: HerdrProcessOptions) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? 10_000;
  }

  get(signal?: AbortSignal): Promise<HerdrCommandResult> {
    return this.run(["--session", this.options.session, "agent", "get", this.options.agentName], this.commandTimeoutMs, signal);
  }

  prompt(text: string, signal?: AbortSignal): Promise<HerdrCommandResult> {
    return this.run(
      [
        "--session",
        this.options.session,
        "agent",
        "prompt",
        this.options.agentName,
        text,
        "--wait",
        "--until",
        "working",
        "--until",
        "idle",
        "--until",
        "done",
        "--until",
        "blocked",
        "--timeout",
        String(this.commandTimeoutMs),
      ],
      this.commandTimeoutMs + 5_000,
      signal,
    );
  }

  wait(signal?: AbortSignal): Promise<HerdrCommandResult> {
    return this.run(
      [
        "--session",
        this.options.session,
        "agent",
        "wait",
        this.options.agentName,
        "--until",
        "idle",
        "--until",
        "done",
        "--until",
        "blocked",
        "--timeout",
        String(this.options.waitTimeoutMs),
      ],
      this.options.waitTimeoutMs + 5_000,
      signal,
    );
  }

  private run(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<HerdrCommandResult> {
    return new Promise((resolve) => {
      const child = spawn(this.options.executable, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let aborted = false;
      let settled = false;
      const finish = (base: Omit<HerdrCommandResult, "errorCode" | "agentStatus">): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(decorateResult(base));
      };
      const kill = (): void => {
        if (!child.killed) child.kill("SIGTERM");
      };
      const abort = (): void => {
        aborted = true;
        kill();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < 1_048_576) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 1_048_576) stderr += chunk.toString("utf8");
      });
      child.once("error", (error) => {
        stderr = error.message;
        finish({ ok: false, stdout, stderr, exitCode: null, timedOut, aborted });
      });
      child.once("close", (code) => {
        finish({ ok: code === 0 && !timedOut && !aborted, stdout, stderr, exitCode: code, timedOut, aborted });
      });
    });
  }
}
