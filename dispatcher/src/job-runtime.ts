import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import type { DispatcherConfig } from "./config.js";
import type { AgentStatus, HerdrCommandResult } from "./herdr.js";
import { jobProgressPath, workspaceFromJob } from "./job-prompt.js";
import type { JobRow } from "./types.js";

export interface PreparedJobRuntime {
  herdrWorkspaceId: string;
  herdrPaneId: string;
}

export interface JobAgentRuntime {
  disableProgress?(): void;
  prepare(row: JobRow, signal?: AbortSignal): Promise<PreparedJobRuntime>;
  get(agentName: string, signal?: AbortSignal, timeoutMs?: number): Promise<HerdrCommandResult>;
  prompt(agentName: string, text: string, signal?: AbortSignal, timeoutMs?: number): Promise<HerdrCommandResult>;
  wait(agentName: string, signal?: AbortSignal): Promise<HerdrCommandResult>;
  cancel(agentName: string, signal?: AbortSignal): Promise<HerdrCommandResult>;
}

function assertScratchWorkspacePath(row: JobRow, config: DispatcherConfig): void {
  const expected = path.join(config.jobsWorkspaceRoot, "scratch", row.job_id);
  if (row.workspace_path !== expected) {
    throw new Error("Scratch workspace path does not match the Dispatcher-generated job path");
  }
}

export function codexAgentArguments(row: JobRow, config: DispatcherConfig, progressEnabled = true): string[] {
  const args = ["--add-dir", config.jobResultsDir];
  if (progressEnabled) args.push("--add-dir", path.dirname(jobProgressPath(row)));
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
  settleBeforeClose = false,
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
    const terminate = (): void => {
      if (child.exitCode === null) child.kill("SIGTERM");
      const forceKill = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1_000);
      forceKill.unref();
    };
    const abort = (): void => {
      aborted = true;
      terminate();
      if (settleBeforeClose) finish({ ok: false, stdout, stderr, exitCode: null, timedOut, aborted });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
      if (settleBeforeClose) finish({ ok: false, stdout, stderr, exitCode: null, timedOut, aborted });
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

function resolveCommitPrefix(
  executable: string,
  args: string[],
  prefix: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; candidates: string[]; stderr: string; timedOut: boolean; aborted: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const candidates = new Set<string>();
    let remainder = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const inspect = (line: string): void => {
      if (candidates.size < 2 && /^[0-9a-f]{40,64}$/i.test(line) && line.toLowerCase().startsWith(prefix.toLowerCase())) {
        candidates.add(line);
      }
    };
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (remainder) inspect(remainder);
      resolve({ ok: ok && !timedOut && !aborted, candidates: [...candidates], stderr, timedOut, aborted });
    };
    const terminate = (): void => {
      if (child.exitCode === null) child.kill("SIGTERM");
      const forceKill = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1_000);
      forceKill.unref();
    };
    const abort = (): void => { aborted = true; terminate(); };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      const lines = `${remainder}${chunk.toString("utf8")}`.split("\n");
      remainder = lines.pop() ?? "";
      for (const line of lines) inspect(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 2_000) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => { stderr = error.message; finish(false); });
    child.once("close", (code) => finish(code === 0));
  });
}

function commandError(label: string, result: HerdrCommandResult): Error {
  const detail = (result.stderr || result.stdout || "command failed").trim().slice(0, 2_000);
  const error = new Error(`${label}: ${detail}`);
  (error as Error & { code?: string }).code = result.errorCode ?? (result.timedOut ? "command_timeout" : "command_failed");
  return error;
}

function safeCommandError(label: string, result: HerdrCommandResult): Error {
  const error = new Error(label);
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
  constructor(private readonly config: DispatcherConfig, private progressEnabled = true) {}
  disableProgress(): void { this.progressEnabled = false; }

  async prepare(row: JobRow, signal?: AbortSignal): Promise<PreparedJobRuntime> {
    const workspace = workspaceFromJob(row);
    if (workspace.kind === "scratch") assertScratchWorkspacePath(row, this.config);

    await fs.mkdir(this.config.jobsWorkspaceRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(this.config.jobsWorkspaceRoot, 0o700);
    await fs.mkdir(this.config.jobResultsDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.config.jobResultsDir, 0o700);
    if (this.progressEnabled) {
      await fs.mkdir(path.dirname(jobProgressPath(row)), { recursive: true, mode: 0o700 });
      await fs.chmod(path.dirname(jobProgressPath(row)), 0o700);
    }

    const existingAgent = await this.get(row.agent_name, signal);
    if (existingAgent.ok) {
      if (workspace.kind === "github") {
        await this.verifyExistingGitHubWorktree(row, workspace.repository, signal);
      }
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
          "--", ...codexAgentArguments(row, this.config, this.progressEnabled),
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
    return this.herdr(["agent", "get", agentName], timeoutMs ?? this.config.jobCommandTimeoutMs, signal, true);
  }

  prompt(agentName: string, text: string, signal?: AbortSignal, timeoutMs?: number): Promise<HerdrCommandResult> {
    const statusTimeoutMs = timeoutMs ?? this.config.jobCommandTimeoutMs;
    return this.herdr([
      "agent", "prompt", agentName, text,
      "--wait",
      "--until", "working",
      "--until", "idle",
      "--until", "done",
      "--until", "blocked",
      "--timeout", String(statusTimeoutMs),
    ], statusTimeoutMs + 5_000, signal);
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

  private herdr(
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
    settleBeforeClose = false,
  ): Promise<HerdrCommandResult> {
    return runProcess(
      this.config.herdrPath,
      ["--session", this.config.herdrSession, ...args],
      timeoutMs,
      signal,
      settleBeforeClose,
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
    if (await exists(path.join(row.workspace_path, ".git"))) {
      await this.verifyExistingWorktreeIdentity(row, repositoryPath, signal);
      return this.herdr([
        "workspace", "create", "--cwd", row.workspace_path, "--label", row.agent_name, "--no-focus",
      ], this.config.jobCommandTimeoutMs + 5_000, signal);
    }
    let baseBranch = requestedBaseRef;
    if (!baseBranch) {
      const viewed = await runProcess(
        this.config.ghPath,
        ["repo", "view", repository, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
        120_000,
        signal,
      );
      if (!viewed.ok || !viewed.stdout.trim()) throw commandError("GitHub default branch lookup failed", viewed);
      baseBranch = viewed.stdout.trim();
    }
    if (baseBranch === "HEAD" || baseBranch === "origin/HEAD" || baseBranch === "refs/remotes/origin/HEAD") {
      const viewed = await runProcess(
        this.config.ghPath,
        ["repo", "view", repository, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
        120_000,
        signal,
      );
      if (!viewed.ok || !viewed.stdout.trim()) throw commandError("GitHub default branch lookup failed", viewed);
      baseBranch = viewed.stdout.trim();
    }
    const explicitTag = baseBranch.startsWith("refs/tags/") ? baseBranch : undefined;
    const explicitBranch = baseBranch.startsWith("refs/heads/")
      ? baseBranch.slice("refs/heads/".length)
      : baseBranch.startsWith("refs/remotes/origin/")
        ? baseBranch.slice("refs/remotes/origin/".length)
        : baseBranch.startsWith("origin/")
          ? baseBranch.slice("origin/".length)
          : undefined;
    let sourceRef: string;
    let fetchedRef: string;
    if (explicitTag) {
      sourceRef = explicitTag;
      fetchedRef = `refs/dona/bases/${row.job_id}`;
    } else if (explicitBranch) {
      sourceRef = `refs/heads/${explicitBranch}`;
      fetchedRef = `refs/dona/bases/${row.job_id}`;
    } else {
      const checked = await runProcess(
        this.config.gitPath,
        ["check-ref-format", "--branch", baseBranch],
        120_000,
        signal,
      );
      if (!checked.ok) throw new Error("GitHub base ref name is invalid");
      const advertised = await runProcess(
        this.config.gitPath,
        ["-C", repositoryPath, "ls-remote", "--refs", "origin", `refs/heads/${baseBranch}`, `refs/tags/${baseBranch}`],
        120_000,
        signal,
      );
      if (!advertised.ok) throw safeCommandError(`Git remote base ref ${baseBranch} could not be inspected`, advertised);
      const advertisedRefs = advertised.stdout.trim().split("\n").map((line) => line.split("\t")[1]).filter(Boolean);
      const hasBranch = advertisedRefs.includes(`refs/heads/${baseBranch}`);
      const hasTag = advertisedRefs.includes(`refs/tags/${baseBranch}`);
      if (hasBranch && hasTag) throw new Error(`Git remote base ref ${baseBranch} is ambiguous`);
      if (hasBranch) {
        sourceRef = `refs/heads/${baseBranch}`;
        fetchedRef = `refs/dona/bases/${row.job_id}`;
      } else if (hasTag) {
        sourceRef = `refs/tags/${baseBranch}`;
        fetchedRef = `refs/dona/bases/${row.job_id}`;
      } else if (/^[0-9a-f]{4,64}$/i.test(baseBranch)) {
        sourceRef = await this.resolveRemoteCommit(repositoryPath, baseBranch, row, signal);
        fetchedRef = `refs/dona/bases/${row.job_id}`;
      } else {
        throw new Error(`Git remote base ref ${baseBranch} was not found`);
      }
    }
    const refspec = `+${sourceRef}:${fetchedRef}`;
    const fetched = await runProcess(
      this.config.gitPath,
      ["-C", repositoryPath, "fetch", "--prune", "origin", refspec],
      120_000,
      signal,
    );
    if (!fetched.ok) throw safeCommandError(`Git fetch failed for ref ${baseBranch}`, fetched);
    const resolved = await runProcess(
      this.config.gitPath,
      ["-C", repositoryPath, "rev-parse", "--verify", `${fetchedRef}^{commit}`],
      this.config.jobCommandTimeoutMs,
      signal,
    );
    const baseSha = resolved.stdout.trim();
    if (!resolved.ok || !/^[0-9a-f]{40,64}$/i.test(baseSha)) {
      throw commandError(`Git remote base ref ${baseBranch} was not found`, resolved);
    }
    const created = await this.herdr([
      "worktree", "create",
      "--cwd", repositoryPath,
      "--branch", `dona/${row.job_id}`,
      "--base", baseSha,
      "--path", row.workspace_path,
      "--label", row.agent_name,
      "--no-focus",
    ], 120_000, signal);
    if (!created.ok) throw commandError("Herdr worktree creation failed", created);
    await this.verifyWorktreeIdentity(row, repositoryPath, baseSha, signal);
    return created;
  }

  private async verifyExistingGitHubWorktree(
    row: JobRow,
    repository: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const [owner, repo] = repository.split("/") as [string, string];
    const repositoryPath = path.join(this.config.jobsWorkspaceRoot, "github", owner, repo, "repository");
    const origin = await runProcess(
      this.config.gitPath,
      ["-C", repositoryPath, "remote", "get-url", "origin"],
      this.config.jobCommandTimeoutMs,
      signal,
    );
    if (!origin.ok || normalizedRepository(origin.stdout) !== repository.toLowerCase()) {
      throw new Error(`Existing repository origin does not match ${repository}`);
    }
    await this.verifyExistingWorktreeIdentity(row, repositoryPath, signal);
  }

  private async verifyExistingWorktreeIdentity(
    row: JobRow,
    repositoryPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const baseRef = `refs/dona/bases/${row.job_id}`;
    let resolved = await runProcess(
      this.config.gitPath,
      ["-C", repositoryPath, "rev-parse", "--verify", `${baseRef}^{commit}`],
      this.config.jobCommandTimeoutMs,
      signal,
    );
    let expectedSha = resolved.stdout.trim();
    let migrateLegacyRef = false;
    if (!resolved.ok || !/^[0-9a-f]{40,64}$/i.test(expectedSha)) {
      const legacyRef = `refs/heads/dona/${row.job_id}`;
      resolved = await runProcess(
        this.config.gitPath,
        ["-C", repositoryPath, "rev-parse", "--verify", `${legacyRef}^{commit}`],
        this.config.jobCommandTimeoutMs,
        signal,
      );
      expectedSha = resolved.stdout.trim();
      migrateLegacyRef = true;
    }
    if (!resolved.ok || !/^[0-9a-f]{40,64}$/i.test(expectedSha)) {
      throw commandError(`Existing job branch dona/${row.job_id} could not be resolved`, resolved);
    }
    await this.verifyWorktreeIdentity(row, repositoryPath, expectedSha, signal);
    if (migrateLegacyRef) {
      const persisted = await runProcess(
        this.config.gitPath,
        ["-C", repositoryPath, "update-ref", baseRef, expectedSha],
        this.config.jobCommandTimeoutMs,
        signal,
      );
      if (!persisted.ok) throw commandError("Existing job base identity could not be migrated", persisted);
    }
  }

  private async resolveRemoteCommit(
    repositoryPath: string,
    baseRef: string,
    row: JobRow,
    signal?: AbortSignal,
  ): Promise<string> {
    const objectNamespace = `refs/dona/objects/${row.job_id}`;
    try {
      const fetchedObjects = await runProcess(
        this.config.gitPath,
        [
          "-C", repositoryPath, "fetch", "--prune", "origin",
          `+refs/heads/*:${objectNamespace}/heads/*`,
          `+refs/tags/*:${objectNamespace}/tags/*`,
        ],
        120_000,
        signal,
      );
      if (!fetchedObjects.ok) throw safeCommandError(`Git remote commit ${baseRef} could not be fetched`, fetchedObjects);
      const remoteCommits = await resolveCommitPrefix(
        this.config.gitPath,
        ["-C", repositoryPath, "rev-list", `--glob=${objectNamespace}/*`],
        baseRef,
        120_000,
        signal,
      );
      if (!remoteCommits.ok) throw new Error(`Git remote commit candidates could not be inspected: ${remoteCommits.stderr.trim() || "command failed"}`);
      const candidates = remoteCommits.candidates;
      if (candidates.length !== 1 || !/^[0-9a-f]{40,64}$/i.test(candidates[0] ?? "")) {
        throw new Error(`Git remote commit ${baseRef} was not uniquely resolved`);
      }
      return candidates[0]!;
    } finally {
      const listedRefs = await runProcess(
        this.config.gitPath,
        ["-C", repositoryPath, "for-each-ref", "--format=%(refname)", objectNamespace],
        this.config.jobCommandTimeoutMs,
      );
      if (!listedRefs.ok) throw commandError("Git temporary ref inspection failed", listedRefs);
      for (const temporaryRef of listedRefs.stdout.trim().split("\n").filter(Boolean)) {
        const deleted = await runProcess(
          this.config.gitPath,
          ["-C", repositoryPath, "update-ref", "-d", temporaryRef],
          this.config.jobCommandTimeoutMs,
        );
        if (!deleted.ok) throw commandError("Git temporary ref cleanup failed", deleted);
      }
    }
  }

  private async verifyWorktreeIdentity(
    row: JobRow,
    repositoryPath: string,
    expectedSha: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const head = await runProcess(
      this.config.gitPath,
      ["-C", row.workspace_path, "rev-parse", "--verify", "HEAD^{commit}"],
      this.config.jobCommandTimeoutMs,
      signal,
    );
    const actualSha = head.stdout.trim();
    if (!head.ok || actualSha !== expectedSha) {
      throw new Error(`Git worktree HEAD mismatch for dona/${row.job_id}: expected ${expectedSha}, got ${actualSha || "unresolved"}`);
    }
    const branch = await runProcess(
      this.config.gitPath,
      ["-C", row.workspace_path, "symbolic-ref", "--quiet", "HEAD"],
      this.config.jobCommandTimeoutMs,
      signal,
    );
    const expectedBranch = `refs/heads/dona/${row.job_id}`;
    if (!branch.ok || branch.stdout.trim() !== expectedBranch) {
      throw new Error(`Git worktree branch mismatch for dona/${row.job_id}`);
    }
    const commonDir = await runProcess(
      this.config.gitPath,
      ["-C", row.workspace_path, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      this.config.jobCommandTimeoutMs,
      signal,
    );
    const actualCommonDir = commonDir.ok ? await fs.realpath(commonDir.stdout.trim()).catch(() => "") : "";
    const expectedCommonDir = await fs.realpath(path.join(repositoryPath, ".git")).catch(() => "");
    if (!actualCommonDir || actualCommonDir !== expectedCommonDir) {
      throw new Error(`Git worktree repository mismatch for dona/${row.job_id}`);
    }
  }
}
