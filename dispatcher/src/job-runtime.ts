import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import type { DispatcherConfig } from "./config.js";
import type { AgentStatus, HerdrCommandResult } from "./herdr.js";
import { workspaceFromJob } from "./job-prompt.js";
import type { JobRow } from "./types.js";

export interface PreparedJobRuntime {
  herdrWorkspaceId: string;
  herdrPaneId: string;
}

export interface JobAgentRuntime {
  prepare(row: JobRow, signal?: AbortSignal): Promise<PreparedJobRuntime>;
  get(agentName: string, signal?: AbortSignal, timeoutMs?: number): Promise<HerdrCommandResult>;
  prompt(agentName: string, text: string, signal?: AbortSignal): Promise<HerdrCommandResult>;
  wait(agentName: string, signal?: AbortSignal): Promise<HerdrCommandResult>;
  cancel(agentName: string, signal?: AbortSignal): Promise<HerdrCommandResult>;
}

function assertScratchWorkspacePath(row: JobRow, config: DispatcherConfig): void {
  const expected = path.join(config.jobsWorkspaceRoot, "scratch", row.job_id);
  if (row.workspace_path !== expected) {
    throw new Error("Scratch workspace path does not match the Dispatcher-generated job path");
  }
}

export function codexAgentArguments(row: JobRow, config: DispatcherConfig): string[] {
  const args = ["--add-dir", config.jobResultsDir];
  const workspace = workspaceFromJob(row);
  let trustedPaths: string[];
  if (workspace.kind === "scratch") {
    assertScratchWorkspacePath(row, config);
    trustedPaths = [row.workspace_path];
  } else {
    const [owner, repo] = workspace.repository.split("/") as [string, string];
    const repositoryPath = path.join(config.jobsWorkspaceRoot, "github", owner, repo, "repository");
    trustedPaths = [repositoryPath, row.workspace_path];
  }
  const projects = trustedPaths
    .map((trustedPath) => `${JSON.stringify(trustedPath)} = { trust_level = "trusted" }`)
    .join(", ");
  args.push("-c", `projects = { ${projects} }`);
  return args;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function findValue(input: unknown, keys: readonly string[]): unknown {
  if (input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of keys) if (record[key] !== undefined) return record[key];
  for (const value of Object.values(record)) {
    const found = findValue(value, keys);
    if (found !== undefined) return found;
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

function findAgentSessionId(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const session = record.agent_session;
  if (session !== null && typeof session === "object") {
    const sessionRecord = session as Record<string, unknown>;
    if (sessionRecord.kind === "id" && typeof sessionRecord.value === "string") return sessionRecord.value;
  }
  for (const value of Object.values(record)) {
    const nested = findAgentSessionId(value);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function resultFromProcess(base: Omit<HerdrCommandResult, "errorCode" | "agentStatus">): HerdrCommandResult {
  const parsed = parseJson(base.ok ? base.stdout : base.stderr || base.stdout);
  const error = findValue(parsed, ["error_code", "code"]);
  const agentStatus = findAgentStatus(parsed);
  const workspaceId = findValue(parsed, ["workspace_id"]);
  const paneId = findValue(parsed, ["pane_id"]);
  const agentName = findValue(parsed, ["agent_name", "name"]);
  const agentSessionId = findAgentSessionId(parsed);
  const sequence = findValue(parsed, ["state_change_seq"]);
  return {
    ...base,
    ...(typeof error === "string" ? { errorCode: error } : {}),
    ...(agentStatus ? { agentStatus } : {}),
    ...(agentSessionId === undefined ? {} : {
      agentIdentity: JSON.stringify([workspaceId ?? null, paneId ?? null, agentName ?? null, agentSessionId]),
    }),
    ...(Number.isSafeInteger(sequence) && Number(sequence) >= 0 ? { stateChangeSeq: Number(sequence) } : {}),
  };
}

function runProcess(
  executable: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HerdrCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
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
      resolve(resultFromProcess(base));
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

function commandError(label: string, result: HerdrCommandResult): Error {
  const detail = (result.stderr || result.stdout || "command failed").trim().slice(0, 2_000);
  const error = new Error(`${label}: ${detail}`);
  (error as Error & { code?: string }).code = result.errorCode ?? (result.timedOut ? "command_timeout" : "command_failed");
  return error;
}

function normalizedRepository(value: string): string | undefined {
  const stripped = value.trim().replace(/\.git$/, "");
  const match = /(?:github\.com[/:])([^/]+\/[^/]+)$/.exec(stripped);
  return match?.[1]?.toLowerCase();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export class HerdrJobAgentRuntime implements JobAgentRuntime {
  constructor(private readonly config: DispatcherConfig) {}

  async prepare(row: JobRow, signal?: AbortSignal): Promise<PreparedJobRuntime> {
    const workspace = workspaceFromJob(row);
    if (workspace.kind === "scratch") assertScratchWorkspacePath(row, this.config);

    await fs.mkdir(this.config.jobsWorkspaceRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(this.config.jobsWorkspaceRoot, 0o700);
    await fs.mkdir(this.config.jobResultsDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.config.jobResultsDir, 0o700);

    const existingAgent = await this.get(row.agent_name, signal);
    if (existingAgent.ok) {
      const parsed = parseJson(existingAgent.stdout);
      const workspaceId = findValue(parsed, ["workspace_id"]);
      const paneId = findValue(parsed, ["pane_id"]);
      if (workspaceId !== undefined && paneId !== undefined) {
        return { herdrWorkspaceId: String(workspaceId), herdrPaneId: String(paneId) };
      }
    }

    const created = workspace.kind === "scratch"
      ? await this.createScratchWorkspace(row, signal)
      : await this.createGitHubWorktree(row, workspace.repository, workspace.base_ref, signal);
    const parsed = parseJson(created.stdout);
    const workspaceId = findValue(parsed, ["workspace_id"]);
    const paneId = findValue(parsed, ["pane_id"]);
    if (!created.ok || workspaceId === undefined || paneId === undefined) {
      throw commandError("Herdr workspace creation failed", created);
    }

    let started: HerdrCommandResult | undefined;
    const deadline = Date.now() + 5_000;
    do {
      started = await runProcess(
        this.config.herdrPath,
        [
          "--session", this.config.herdrSession,
          "agent", "start", row.agent_name,
          "--kind", "codex",
          "--pane", String(paneId),
          "--timeout", String(this.config.jobAgentStartTimeoutMs),
          "--", ...codexAgentArguments(row, this.config),
        ],
        this.config.jobAgentStartTimeoutMs + 5_000,
        signal,
      );
      if (started.ok || started.errorCode !== "agent_pane_busy" || Date.now() >= deadline || signal?.aborted) break;
      await delay(200, signal);
    } while (true);
    if (!started?.ok) throw commandError("Herdr agent start failed", started!);
    return { herdrWorkspaceId: String(workspaceId), herdrPaneId: String(paneId) };
  }

  get(agentName: string, signal?: AbortSignal, timeoutMs?: number): Promise<HerdrCommandResult> {
    return this.herdr(["agent", "get", agentName], timeoutMs ?? this.config.jobCommandTimeoutMs, signal);
  }

  prompt(agentName: string, text: string, signal?: AbortSignal): Promise<HerdrCommandResult> {
    return this.herdr([
      "agent", "prompt", agentName, text,
      "--wait",
      "--until", "working",
      "--until", "idle",
      "--until", "done",
      "--until", "blocked",
      "--timeout", String(this.config.jobCommandTimeoutMs),
    ], this.config.jobCommandTimeoutMs + 5_000, signal);
  }

  wait(agentName: string, signal?: AbortSignal): Promise<HerdrCommandResult> {
    return this.herdr([
      "agent", "wait", agentName,
      "--until", "idle",
      "--until", "done",
      "--until", "blocked",
      "--timeout", String(this.config.agentWaitTimeoutMs),
    ], this.config.agentWaitTimeoutMs + 5_000, signal);
  }

  cancel(agentName: string, signal?: AbortSignal): Promise<HerdrCommandResult> {
    return this.herdr(["agent", "send-keys", agentName, "ctrl+c"], this.config.jobCommandTimeoutMs, signal);
  }

  private herdr(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<HerdrCommandResult> {
    return runProcess(
      this.config.herdrPath,
      ["--session", this.config.herdrSession, ...args],
      timeoutMs,
      signal,
    );
  }

  private async createScratchWorkspace(row: JobRow, signal?: AbortSignal): Promise<HerdrCommandResult> {
    assertScratchWorkspacePath(row, this.config);
    await fs.mkdir(row.workspace_path, { recursive: true, mode: 0o700 });
    await fs.chmod(row.workspace_path, 0o700);
    return this.herdr([
      "workspace", "create",
      "--cwd", row.workspace_path,
      "--label", row.agent_name,
      "--no-focus",
    ], this.config.jobCommandTimeoutMs + 5_000, signal);
  }

  private async createGitHubWorktree(
    row: JobRow,
    repository: string,
    requestedBaseRef: string | undefined,
    signal?: AbortSignal,
  ): Promise<HerdrCommandResult> {
    const [owner, repo] = repository.split("/") as [string, string];
    const repositoryPath = path.join(this.config.jobsWorkspaceRoot, "github", owner, repo, "repository");
    await fs.mkdir(path.dirname(repositoryPath), { recursive: true, mode: 0o700 });
    if (!(await exists(path.join(repositoryPath, ".git")))) {
      if (await exists(repositoryPath)) {
        const entries = await fs.readdir(repositoryPath);
        if (entries.length > 0) throw new Error(`Repository path is not an empty Git repository: ${repositoryPath}`);
      }
      const cloned = await runProcess(
        this.config.ghPath,
        ["repo", "clone", repository, repositoryPath],
        120_000,
        signal,
      );
      if (!cloned.ok) throw commandError("GitHub repository clone failed", cloned);
    }
    const origin = await runProcess(
      this.config.gitPath,
      ["-C", repositoryPath, "remote", "get-url", "origin"],
      this.config.jobCommandTimeoutMs,
      signal,
    );
    if (!origin.ok) throw commandError("Git origin inspection failed", origin);
    if (normalizedRepository(origin.stdout) !== repository.toLowerCase()) {
      throw new Error(`Existing repository origin does not match ${repository}`);
    }
    const fetched = await runProcess(
      this.config.gitPath,
      ["-C", repositoryPath, "fetch", "--prune", "origin"],
      120_000,
      signal,
    );
    if (!fetched.ok) throw commandError("Git fetch failed", fetched);

    let baseRef = requestedBaseRef;
    if (!baseRef) {
      const viewed = await runProcess(
        this.config.ghPath,
        ["repo", "view", repository, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
        this.config.jobCommandTimeoutMs,
        signal,
      );
      if (!viewed.ok || !viewed.stdout.trim()) throw commandError("GitHub default branch lookup failed", viewed);
      baseRef = `origin/${viewed.stdout.trim()}`;
    } else {
      const local = await runProcess(
        this.config.gitPath,
        ["-C", repositoryPath, "rev-parse", "--verify", `${baseRef}^{commit}`],
        this.config.jobCommandTimeoutMs,
        signal,
      );
      if (!local.ok) {
        const remoteBase = `origin/${baseRef}`;
        const remote = await runProcess(
          this.config.gitPath,
          ["-C", repositoryPath, "rev-parse", "--verify", `${remoteBase}^{commit}`],
          this.config.jobCommandTimeoutMs,
          signal,
        );
        if (!remote.ok) throw commandError(`Git base ref ${baseRef} was not found`, remote);
        baseRef = remoteBase;
      }
    }
    if (await exists(path.join(row.workspace_path, ".git"))) {
      return this.herdr([
        "workspace", "create", "--cwd", row.workspace_path, "--label", row.agent_name, "--no-focus",
      ], this.config.jobCommandTimeoutMs + 5_000, signal);
    }
    return this.herdr([
      "worktree", "create",
      "--cwd", repositoryPath,
      "--branch", `dona/${row.job_id}`,
      "--base", baseRef,
      "--path", row.workspace_path,
      "--label", row.agent_name,
      "--no-focus",
    ], 120_000, signal);
  }
}
