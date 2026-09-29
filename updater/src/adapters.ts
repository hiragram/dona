import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse as parseDotenv } from "dotenv";
import Database from "better-sqlite3";

import type { UpdatePolicy } from "./policy.js";
import type { BuildPort, DispatcherPort, GitPort, RuntimePort } from "./ports.js";
import { ProcessRunner, minimalEnvironment } from "./process.js";
import { DiagnosticLogStore } from "./diagnostic-log.js";
import { redactText } from "./redaction.js";
import type {
  CommandResult,
  DiagnosticLogIdentity,
  Compatibility,
  DrainSnapshot,
  HealthSnapshot,
  MainAgentObservation,
  MainAgentStartResult,
  MainAgentStopResult,
  MainAgentStatus,
  OutboxRow,
  SchemaRollout,
  RuntimeInventory,
} from "./types.js";
import { fullSha, parseCompatibilityMetadata, sha256 } from "./validation.js";

const mainAgentStartupPrompt =
  "起動確認です。外部操作、ファイル変更、プロセス操作は行わず、READYとだけ返してください。";

async function readOwnerFile(filePath: string, maxBytes: number, privateMode: boolean): Promise<Buffer> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.uid !== process.getuid?.() ||
      (stats.mode & (privateMode ? 0o077 : 0o022)) !== 0 || stats.size > maxBytes) {
      throw new Error("owner_file_identity_unverified");
    }
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new Error("owner_file_size_unverified");
    return bytes;
  } catch {
    throw new Error("owner_file_unverified");
  } finally { await handle?.close(); }
}

export class CommandFailureError extends Error {
  constructor(message: string, readonly result: CommandResult) { super(message); }
}

function commandError(name: string, result: CommandResult): Error {
  const suffix = result.timed_out ? "timed out" : `exited ${result.exit_code}`;
  const checkpoint = result.output_checkpoint ? `; checkpoint=${result.output_checkpoint}` : "";
  const runner = `; runner=exit:${result.exit_code},signal:${result.exit_signal ?? "none"},cleanup:${result.cleanup_status ?? "unknown"}`;
  const stderr = redactText(result.stderr.slice(0, 250), 250);
  const stdout = redactText(result.stdout.slice(0, 250), 250);
  const spawn = result.spawn_error ? `; spawn=${redactText(result.spawn_error, 100)}` : "";
  const diagnostic = result.diagnostic_log
    ? `; diagnostic=${result.diagnostic_log.log_id}:${result.diagnostic_log.capture_state}:${result.diagnostic_log.byte_size}`
    : "";
  return new CommandFailureError(redactText(`${name} ${suffix}${spawn}${checkpoint}${runner}${diagnostic}; stderr=${stderr}; stdout=${stdout}`, 1_000), result);
}

function requireSuccess(name: string, result: CommandResult): string {
  if (result.timed_out || result.exit_code !== 0) throw commandError(name, result);
  return result.stdout.trim();
}

export class RealGit implements GitPort {
  private readonly cachePath: string;

  constructor(private readonly policy: UpdatePolicy, private readonly runner = new ProcessRunner()) {
    this.cachePath = path.join(policy.control_root, "repository.git");
  }

  async refresh(currentSha: string): Promise<{
    current_sha: string;
    target_sha: string;
    target_reachable: boolean;
    ci_trusted: boolean;
    target_compatibility: Compatibility;
    target_rollout: SchemaRollout;
  }> {
    fullSha(currentSha, "current_sha");
    await fs.mkdir(this.policy.control_root, { recursive: true, mode: 0o700 });
    try {
      const stats = await fs.lstat(this.cachePath);
      if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o022) !== 0) throw new Error("git_cache_invalid");
      const remote = requireSuccess("git remote get-url", await this.git(["--git-dir", this.cachePath, "remote", "get-url", "origin"]));
      if (remote !== this.policy.canonical_remote) throw new Error("wrong_canonical_remote");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      requireSuccess("git init", await this.git(["init", "--bare", this.cachePath]));
      requireSuccess("git remote add", await this.git(["--git-dir", this.cachePath, "remote", "add", "origin", this.policy.canonical_remote]));
    }
    requireSuccess("git fetch", await this.git([
      "--git-dir", this.cachePath, "fetch", "--no-tags", "--prune", "origin",
      `+refs/heads/${this.policy.default_branch}:refs/remotes/origin/${this.policy.default_branch}`,
    ]));
    const targetSha = requireSuccess("git rev-parse", await this.git([
      "--git-dir", this.cachePath, "rev-parse", `refs/remotes/origin/${this.policy.default_branch}^{commit}`,
    ]));
    fullSha(targetSha, "target_sha");
    const ancestry = await this.git(["--git-dir", this.cachePath, "merge-base", "--is-ancestor", currentSha, targetSha]);
    if (ancestry.timed_out || ![0, 1].includes(ancestry.exit_code ?? -1)) throw commandError("git merge-base", ancestry);
    return {
      current_sha: currentSha,
      target_sha: targetSha,
      target_reachable: ancestry.exit_code === 0,
      ci_trusted: await this.verifyTrust(targetSha),
      target_compatibility: await this.readCompatibility(targetSha),
      target_rollout: await this.readSchemaRollout(targetSha),
    };
  }

  async stage(targetSha: string, destination: string): Promise<void> {
    fullSha(targetSha, "target_sha");
    if (!(await this.verifyTrust(targetSha))) throw new Error("approved_target_no_longer_passes_trust_gate");
    requireSuccess("git clone", await this.git([
      "clone", "--no-checkout", "--filter=blob:none", "--branch", this.policy.default_branch,
      this.policy.canonical_remote, destination,
    ]));
    const reachable = await this.git(["-C", destination, "merge-base", "--is-ancestor", targetSha, `origin/${this.policy.default_branch}`]);
    if (reachable.exit_code !== 0 || reachable.timed_out) throw new Error("approved_target_no_longer_reachable_from_fixed_branch");
    requireSuccess("git checkout", await this.git(["-C", destination, "checkout", "--detach", targetSha]));
    await this.verifyStaged(destination, targetSha);
  }

  async verifyStaged(destination: string, targetSha: string): Promise<void> {
    const remote = requireSuccess("git staged remote", await this.git(["-C", destination, "remote", "get-url", "origin"]));
    if (remote !== this.policy.canonical_remote) throw new Error("staged_repository_remote_mismatch");
    const sha = requireSuccess("git staged SHA", await this.git(["-C", destination, "rev-parse", "HEAD^{commit}"]));
    if (sha !== targetSha) throw new Error("staged_repository_sha_mismatch");
    const dirty = requireSuccess("git status", await this.git(["-C", destination, "status", "--porcelain=v1", "--untracked-files=all"]));
    if (dirty !== "") throw new Error("staged_repository_is_dirty");
  }

  private git(args: readonly string[]): Promise<CommandResult> {
    return this.runner.run(this.policy.executables.git, args, {
      timeoutMs: this.policy.timeouts.command_ms,
      outputLimitBytes: this.policy.output_limit_bytes,
      env: minimalEnvironment({
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      }),
    });
  }

  private async verifyTrust(targetSha: string): Promise<boolean> {
    if (this.policy.required_checks.length > 0) {
      const result = await this.runner.run(this.policy.executables.gh, [
        "api", "--method", "GET", `repos/${this.policy.repository}/commits/${targetSha}/check-runs`, "-f", "per_page=100",
      ], {
        timeoutMs: this.policy.timeouts.command_ms,
        outputLimitBytes: this.policy.output_limit_bytes,
        env: minimalEnvironment({ HOME: os.homedir(), GH_PROMPT_DISABLED: "1" }),
      });
      if (result.exit_code !== 0 || result.timed_out || result.output_truncated) return false;
      let checks: unknown;
      try {
        checks = JSON.parse(result.stdout);
      } catch {
        return false;
      }
      const runId = trustedMainPushRunId(checks, targetSha, this.policy.required_checks);
      if (runId === null) return false;
      const workflow = await this.runner.run(this.policy.executables.gh, [
        "api", "--method", "GET", `repos/${this.policy.repository}/actions/runs/${runId}`,
      ], {
        timeoutMs: this.policy.timeouts.command_ms,
        outputLimitBytes: this.policy.output_limit_bytes,
        env: minimalEnvironment({ HOME: os.homedir(), GH_PROMPT_DISABLED: "1" }),
      });
      if (workflow.exit_code !== 0 || workflow.timed_out || workflow.output_truncated) return false;
      try {
        const run = JSON.parse(workflow.stdout) as Record<string, unknown>;
        if (run.id !== runId || run.event !== "push" || run.head_branch !== this.policy.default_branch ||
          run.head_sha !== targetSha || run.status !== "completed" || run.conclusion !== "success" ||
          run.name !== "CI") return false;
      } catch {
        return false;
      }
    }
    if (this.policy.require_verified_signature) {
      const result = await this.runner.run(this.policy.executables.gh, [
        "api", "--method", "GET", `repos/${this.policy.repository}/commits/${targetSha}`,
      ], {
        timeoutMs: this.policy.timeouts.command_ms,
        outputLimitBytes: this.policy.output_limit_bytes,
        env: minimalEnvironment({ HOME: os.homedir(), GH_PROMPT_DISABLED: "1" }),
      });
      if (result.exit_code !== 0 || result.timed_out || result.output_truncated) return false;
      try {
        const parsed = JSON.parse(result.stdout) as { commit?: { verification?: { verified?: unknown } } };
        if (parsed.commit?.verification?.verified !== true) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private async readCompatibility(targetSha: string): Promise<Compatibility> {
    const body = requireSuccess("git show release compatibility", await this.git([
      "--git-dir", this.cachePath, "show", `${targetSha}:config/release-compatibility.json`,
    ]));
    return parseCompatibilityMetadata(JSON.parse(body));
  }

  private async readSchemaRollout(targetSha: string): Promise<SchemaRollout> {
    const raw = requireSuccess("git show schema rollout", await this.git([
      "--git-dir", this.cachePath, "show", `${targetSha}:config/schema-rollout.json`,
    ]));
    const value = JSON.parse(raw) as Partial<SchemaRollout>;
    const commonValid = value.schema_version === 1 && typeof value.phase === "string" &&
      Number.isInteger(value.database_schema) && typeof value.multi_job_enabled === "boolean";
    const bootstrapValid = Array.isArray(value.capabilities) &&
      value.capabilities.every((entry) => typeof entry === "string");
    const migration = value.migration;
    const activationValid = value.phase === "activation" &&
      typeof value.previous_release_sha === "string" && /^[0-9a-f]{40}$/.test(value.previous_release_sha) &&
      typeof value.previous_release_contract === "string" &&
      typeof value.required_control_plane_capability === "string" && migration !== undefined &&
      Number.isInteger(migration.from_schema) && Number.isInteger(migration.to_schema) &&
      typeof migration.requires_quiesce === "boolean" && typeof migration.requires_drain === "boolean" &&
      typeof migration.backup === "string" && typeof migration.restore_open_test === "boolean";
    if (!commonValid || (!bootstrapValid && !activationValid)) {
      throw new Error("target_schema_rollout_is_invalid");
    }
    return value as SchemaRollout;
  }
}

export function trustedMainPushRunId(checks: unknown, targetSha: string, names: readonly string[]): number | null {
  if (!checks || typeof checks !== "object") return null;
  const response = checks as { total_count?: unknown; check_runs?: unknown };
  if (!Array.isArray(response.check_runs) || response.total_count !== response.check_runs.length ||
    response.check_runs.length > 100) return null;
  const runs = response.check_runs as Array<Record<string, unknown>>;
  const matched = names.map(name => runs.filter(run => run.name === name));
  if (matched.some(group => group.length !== 1)) return null;
  let runId: number | null = null;
  for (const group of matched) {
    const run = group[0];
    if (!run) return null;
    const url = typeof run.details_url === "string" ? run.details_url.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/([1-9]\d*)\/job\/([1-9]\d*)$/) : null;
    const id = url ? Number(url[1]) : null;
    if (!id || !Number.isSafeInteger(id) || run.head_sha !== targetSha ||
      run.status !== "completed" || run.conclusion !== "success" ||
      (run.app as { slug?: unknown } | null)?.slug !== "github-actions") return null;
    if (runId !== null && runId !== id) return null;
    runId = id;
  }
  return runId;
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = actual.split(".").map(Number);
  const minimumParts = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const left = actualParts[index] ?? 0;
    const right = minimumParts[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

async function isolatedNpmEnvironment(
  policy: UpdatePolicy,
  extra: Readonly<Record<string, string>> = {},
): Promise<Record<string, string>> {
  const directory = path.join(policy.control_root, "npm-config");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const uid = process.getuid?.();
  const directoryStats = await fs.lstat(directory);
  if (uid === undefined || !directoryStats.isDirectory() || directoryStats.isSymbolicLink() ||
    directoryStats.uid !== uid || (directoryStats.mode & 0o077) !== 0) {
    throw new Error("npm_config_directory_is_not_private");
  }
  const configPaths = {
    npm_config_userconfig: path.join(directory, "userconfig"),
    npm_config_globalconfig: path.join(directory, "globalconfig"),
  };
  for (const configPath of Object.values(configPaths)) {
    try {
      await fs.writeFile(configPath, "", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stats = await fs.lstat(configPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== uid || stats.size !== 0 ||
      (stats.mode & 0o077) !== 0) {
      throw new Error("npm_config_file_is_not_private_and_empty");
    }
  }
  return minimalEnvironment({ ...extra, ...configPaths });
}

export class CanonicalBuild implements BuildPort {
  constructor(
    private readonly policy: UpdatePolicy,
    private readonly runner = new ProcessRunner(),
    private readonly diagnostics?: DiagnosticLogStore,
  ) {}

  async toolchain(): Promise<{ node_version: string; npm_version: string }> {
    const npmVersion = requireSuccess("npm --version", await this.runner.run(this.policy.executables.npm, ["--version"], {
      timeoutMs: this.policy.timeouts.command_ms,
      outputLimitBytes: this.policy.output_limit_bytes,
      env: await isolatedNpmEnvironment(this.policy),
    }));
    return { node_version: process.versions.node, npm_version: npmVersion };
  }

  async buildRelease(checkoutPath: string, diagnostic?: Omit<DiagnosticLogIdentity, "step">): Promise<{
    lock_hashes: Record<string, string>;
    node_version: string;
    npm_version: string;
    compatibility: Compatibility;
  }> {
    const components = ["dispatcher", "sources/slack", "updater"] as const;
    const lockHashes: Record<string, string> = {};
    const npmEnvironment = await isolatedNpmEnvironment(this.policy, {
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      npm_config_cache: path.join(this.policy.control_root, "npm-cache"),
    });
    await fs.mkdir(npmEnvironment.npm_config_cache!, { recursive: true, mode: 0o700 });
    await fs.chmod(npmEnvironment.npm_config_cache!, 0o700);
    for (const component of components) {
      const directory = path.join(checkoutPath, component);
      const packageJson = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8")) as {
        engines?: { node?: string };
      };
      const engine = packageJson.engines?.node;
      const minimum = engine?.match(/^>=(\d+\.\d+\.\d+)$/)?.[1];
      if (!minimum || !versionAtLeast(process.versions.node, minimum)) throw new Error(`node_engine_mismatch:${component}`);
      const lockPath = path.join(directory, "package-lock.json");
      const before = sha256(await fs.readFile(lockPath));
      lockHashes[component] = before;
      for (const args of [["ci"], ["run", "typecheck"], ["run", "build"]] as const) {
        const result = await this.runner.run(this.policy.executables.npm, args, {
          cwd: directory,
          timeoutMs: this.policy.timeouts.command_ms,
          outputLimitBytes: this.policy.output_limit_bytes,
          env: npmEnvironment,
          ...(diagnostic && this.diagnostics ? { diagnostic: {
            store: this.diagnostics,
            identity: { ...diagnostic, step: canonicalDiagnosticStep(component, args) },
          } } : {}),
        });
        requireSuccess(`npm ${args.join(" ")} (${component})`, result);
      }
      const after = sha256(await fs.readFile(lockPath));
      if (before !== after) throw new Error(`lockfile_changed_during_build:${component}`);
    }
    const { npm_version: npmVersion } = await this.toolchain();
    const compatibility = parseCompatibilityMetadata(JSON.parse(
      await fs.readFile(path.join(checkoutPath, "config", "release-compatibility.json"), "utf8"),
    ));
    return { lock_hashes: lockHashes, node_version: process.versions.node, npm_version: npmVersion, compatibility };
  }
}

export function canonicalDiagnosticStep(
  component: "dispatcher" | "sources/slack" | "updater",
  args: readonly string[],
): string {
  return `${component.replaceAll("/", ".")}:npm-${args.join("-")}`;
}

interface HttpResponse {
  statusCode: number;
  body: string;
}

function udsRequest(socketPath: string, method: "GET" | "POST", route: string, body: unknown, timeoutMs: number, headers: Record<string, string> = {}): Promise<HttpResponse> {
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    let responseSize = 0;
    const chunks: Buffer[] = [];
    const request = http.request({
      socketPath,
      method,
      path: route,
      headers: {
        ...headers,
        ...(encoded ? { "content-type": "application/json", "content-length": String(encoded.length) } : {}),
      },
    }, (response) => {
      response.on("data", (chunk: Buffer) => {
        responseSize += chunk.length;
        if (responseSize <= 1_048_576) chunks.push(chunk);
      });
      response.on("end", () => {
        if (responseSize > 1_048_576) reject(new Error("UDS response exceeded 1 MiB"));
        else resolve({ statusCode: response.statusCode ?? 500, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    request.once("error", reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Error("UDS request acceptance unknown after timeout")));
    request.end(encoded);
  });
}

function parsedObject(response: HttpResponse): Record<string, unknown> {
  if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`UDS request rejected with ${response.statusCode}`);
  const parsed = JSON.parse(response.body) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("UDS response was not an object");
  return parsed as Record<string, unknown>;
}

function drainSnapshot(response: HttpResponse, service: DrainSnapshot["service"]): DrainSnapshot {
  const value = parsedObject(response);
  if (value.schema_version !== 1 || value.protocol !== 1 || value.service !== service ||
    typeof value.quiescing !== "boolean" || typeof value.drained !== "boolean" ||
    !Number.isSafeInteger(value.in_flight) || (value.in_flight as number) < 0 ||
    !Array.isArray(value.unsafe_states) || value.unsafe_states.some((state) => typeof state !== "string")) {
    throw new Error("UDS drain response failed protocol validation");
  }
  return {
    service,
    quiescing: value.quiescing,
    drained: value.drained,
    in_flight: value.in_flight as number,
    unsafe_states: value.unsafe_states as string[],
  };
}

const mainAgentStatuses = new Set<MainAgentStatus>(["idle", "done", "working", "blocked", "unknown"]);

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function findString(input: unknown, keys: readonly string[]): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  for (const key of keys) if (typeof value[key] === "string") return value[key] as string;
  for (const child of Object.values(value)) {
    const found = findString(child, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findAgentInfo(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  if (typeof value.pane_id === "string" && mainAgentStatuses.has(value.agent_status as MainAgentStatus)) return value;
  for (const child of Object.values(value)) {
    const found = findAgentInfo(child);
    if (found) return found;
  }
  return undefined;
}

function findPaneInfo(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  if (typeof value.pane_id === "string" &&
    (typeof value.foreground_cwd === "string" || typeof value.cwd === "string")) return value;
  for (const child of Object.values(value)) {
    const found = findPaneInfo(child);
    if (found) return found;
  }
  return undefined;
}

function herdrErrorCode(result: CommandResult): string | undefined {
  return findString(parseJson(result.stderr || result.stdout), ["error_code", "code"]);
}

function missingMainAgent(errorCode: string | undefined): MainAgentObservation {
  return {
    exists: false,
    name: null,
    kind: null,
    pane_id: null,
    status: null,
    interactive_ready: false,
    working_directory: null,
    session_id: null,
    matches_release: false,
    error_code: errorCode ?? null,
  };
}

function mainAgentObservation(result: CommandResult, expectedReleasePath?: string): MainAgentObservation {
  const errorCode = herdrErrorCode(result);
  if (result.timed_out || result.output_truncated || result.exit_code !== 0) {
    if (["agent_not_found", "agent_not_running"].includes(errorCode ?? "")) return missingMainAgent(errorCode);
    return missingMainAgent(errorCode ?? (result.timed_out ? "herdr_timeout" : "herdr_command_failed"));
  }
  const info = findAgentInfo(parseJson(result.stdout));
  if (!info) return missingMainAgent("invalid_herdr_agent_response");
  const session = info.agent_session && typeof info.agent_session === "object"
    ? info.agent_session as Record<string, unknown>
    : undefined;
  const workingDirectory = typeof info.foreground_cwd === "string"
    ? info.foreground_cwd
    : typeof info.cwd === "string" ? info.cwd : null;
  return {
    exists: true,
    name: typeof info.name === "string" ? info.name : null,
    kind: typeof info.agent === "string" ? info.agent : null,
    pane_id: typeof info.pane_id === "string" ? info.pane_id : null,
    status: mainAgentStatuses.has(info.agent_status as MainAgentStatus) ? info.agent_status as MainAgentStatus : null,
    interactive_ready: info.interactive_ready === true,
    working_directory: workingDirectory,
    session_id: session?.kind === "id" && typeof session.value === "string" ? session.value : null,
    matches_release: expectedReleasePath !== undefined && workingDirectory !== null &&
      path.normalize(workingDirectory) === path.normalize(expectedReleasePath),
    error_code: null,
  };
}

function paneWorkingDirectory(result: CommandResult): string | undefined {
  if (result.timed_out || result.output_truncated || result.exit_code !== 0) return undefined;
  const info = findPaneInfo(parseJson(result.stdout));
  if (!info) return undefined;
  return typeof info.foreground_cwd === "string"
    ? info.foreground_cwd
    : typeof info.cwd === "string" ? info.cwd : undefined;
}

function sameMainAgent(left: MainAgentObservation, right: MainAgentObservation): boolean {
  return left.exists && right.exists && left.pane_id === right.pane_id && left.name === right.name && left.kind === right.kind &&
    left.session_id !== null && left.session_id === right.session_id;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function tomlInlineTable(values: Readonly<Record<string, string>>): string {
  return `{ ${Object.entries(values).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(", ")} }`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export class RealRuntime implements RuntimePort {
  constructor(private readonly policy: UpdatePolicy, private readonly runner = new ProcessRunner(),
    private readonly launchAgentsRoot = path.join(os.homedir(), "Library", "LaunchAgents")) {}

  async runtimeInventory(excludedControlEventIds: readonly string[] = [], afterStop = false): Promise<RuntimeInventory> {
    try { return await this.readRuntimeInventory(excludedControlEventIds, afterStop); }
    catch { throw new Error("runtime_inventory_unavailable"); }
  }

  private async readRuntimeInventory(excludedControlEventIds: readonly string[], afterStop: boolean): Promise<RuntimeInventory> {
    if (excludedControlEventIds.length > 2 || new Set(excludedControlEventIds).size !== excludedControlEventIds.length ||
      excludedControlEventIds.some((id) => !/^evt_[0-9A-HJKMNP-TV-Z]{26}$/i.test(id))) {
      throw new Error("inventory_control_event_identity_invalid");
    }
    // Read every Dispatcher-owned class in one SQLite snapshot. Never return
    // identifiers or payloads: they are used only as inputs to the digest.
    const database = new Database(this.dispatcherDatabasePath(), { readonly: true, fileMustExist: true });
    let state: Pick<RuntimeInventory, "dispatcher_schema" | "workers" | "pending">;
    try {
      database.pragma("query_only = ON");
      state = database.transaction(() => {
        const schema = database.pragma("user_version", { simple: true }) as number;
        if (!Number.isSafeInteger(schema) || schema < 2 || schema > 3) throw new Error("inventory_schema_unverified");
        const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
        for (const name of ["events", "jobs", ...(schema >= 3 ? ["schedules", "schedule_runs", "connector_outbox", "job_groups"] : [])]) {
          if (!tables.has(name)) throw new Error("inventory_table_unavailable");
        }
        const hash = createHash("sha256");
        const exceptions = createHash("sha256");
        const classes: Record<string, number> = {};
        const counts = { events: 0, jobs: 0, schedules: 0, notifications: 0 };
        const scan = (query: string, kind: keyof typeof counts, classify?: (row: Record<string, unknown>) => void,
          params: readonly string[] = []) => {
          for (const row of database.prepare(query).iterate(...params) as Iterable<Record<string, unknown>>) {
            counts[kind] += 1;
            const encoded = JSON.stringify(row);
            hash.update(`${encoded.length}:`).update(encoded);
            classify?.(row);
          }
        };
        const excluded = excludedControlEventIds.length ?
          ` AND event_id NOT IN (${excludedControlEventIds.map(() => "?").join(",")})` : "";
        scan(`SELECT event_id,status,schema_version,source,updated_at FROM events
          WHERE status NOT IN ('completed','failed','cancelled')${excluded} ORDER BY event_id`,
        "events", undefined, excludedControlEventIds);
        scan("SELECT job_id,status,source,steer_state,attempt_count,herdr_workspace_id,completion_event_id,last_error_code,updated_at FROM jobs WHERE status NOT IN ('completed','failed','cancelled') OR (completion_event_id IS NULL AND herdr_workspace_id IS NOT NULL) ORDER BY job_id", "jobs", (row) => {
          // The released DB has no owner epoch, protocol or Result publication
          // capability columns. Label those facts unknown rather than inferring
          // them from an agent name or the presence of a workspace ID.
          const jobClass = `${row.status}:${row.herdr_workspace_id ? "worker" : "unstarted"}:protocol_unknown:epoch_unknown:result_capability_unknown`;
          classes[jobClass] = (classes[jobClass] ?? 0) + 1;
          if (row.last_error_code || row.steer_state) exceptions.update(`${row.job_id}:${row.last_error_code ?? ""}:${row.steer_state ?? ""}\n`);
        });
        if (schema >= 3) {
          scan(`SELECT s.schedule_id,s.state,s.revision,s.next_due,s.updated_at,
              r.recurrence_hash,r.policy_json,r.policy_version,r.timezone,r.tzdb_version,
              r.authorization_revision,r.expires_at,r.action,r.content_scope,r.content_hash,r.target_json
            FROM schedules s JOIN schedule_revisions r ON r.schedule_id=s.schedule_id AND r.revision=s.revision
            WHERE s.state NOT IN ('cancelled','completed','expired') ORDER BY s.schedule_id`, "schedules");
          scan("SELECT run_id,status,revision,event_id,job_id,reason FROM schedule_runs WHERE status NOT IN ('completed','failed','cancelled','skipped') ORDER BY run_id", "schedules");
          scan("SELECT outbox_id,status,kind,run_id,content_hash,receipt_id,updated_at FROM connector_outbox WHERE status NOT IN ('sent','failed','cancelled') ORDER BY outbox_id", "notifications");
          scan("SELECT source_event_id,notification_mode,attention_event_id,all_terminal_event_id,updated_at FROM job_groups WHERE attention_event_id IS NOT NULL OR all_terminal_event_id IS NULL ORDER BY source_event_id", "notifications");
        }
        return { dispatcher_schema: schema, workers: { classes, exception_digest: exceptions.digest("hex") },
          pending: { updates: 0, update_notifications: 0, ...counts, digest: hash.digest("hex") } };
      })();
    } finally { database.close(); }
    const app = await this.appSchemaState();
    if (!app.integrity_ok || app.foreign_key_violations !== 0 || app.user_version !== state.dispatcher_schema) {
      throw new Error("inventory_app_schema_unverified");
    }
    const buildSha = process.env.DONA_UPDATER_BUILD_SHA?.trim();
    if (!buildSha || !/^[0-9a-f]{40}$/.test(buildSha)) throw new Error("inventory_control_plane_unverified");
    const receiptPath = path.join(this.policy.control_root, "control-plane-receipt.json");
    const controlReceipt = JSON.parse((await readOwnerFile(receiptPath, 4096, true)).toString("utf8")) as Record<string, unknown>;
    if (controlReceipt.schema_version !== 1 || controlReceipt.build_sha !== buildSha ||
      controlReceipt.schema_migration_capability !== "dispatcher_v2_to_v3_online_backup_v1") {
      throw new Error("inventory_control_plane_unverified");
    }
    const [dispatcherRegistered, slackRegistered] = await Promise.all([this.dispatcherRegistered(), this.slackRegistered()]);
    if (afterStop ? (dispatcherRegistered || slackRegistered) : (!dispatcherRegistered || !slackRegistered)) {
      throw new Error("inventory_launchd_identity_unverified");
    }
    const identity = createHash("sha256");
    for (const label of [this.policy.launchd.dispatcher_label, this.policy.launchd.slack_label]) {
      const plist = path.join(this.launchAgentsRoot, `${label}.plist`);
      const bytes = await readOwnerFile(plist, 256 * 1024, false);
      identity.update(`${label}:${bytes.length}:`).update(bytes);
    }
    return {
      schema_version: 1, control_plane_build_sha: buildSha,
      dispatcher_schema: state.dispatcher_schema, app_schema: app.user_version,
      dispatcher_protocol: 1, policy_version: this.policy.policy_version,
      // Both services must be observably stopped after quiesce. Preserve the
      // planned registration identity in the comparison projection; plist bytes
      // and every durable workload class are still read again.
      launchd: { dispatcher_registered: afterStop || dispatcherRegistered, slack_registered: afterStop || slackRegistered,
        identity_digest: identity.digest("hex") },
      workers: state.workers, pending: state.pending,
    };
  }

  async workerSafety(): Promise<{ safe: boolean; active_worker_count: number; error_code?: string }> {
    try {
      const database = new Database(this.dispatcherDatabasePath(), { readonly: true, fileMustExist: true });
      try {
        const legacyTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_job_agents_to_stop'").get();
        const stoppedLegacyClause = legacyTable ? `AND NOT (status='needs_review'
          AND EXISTS (SELECT 1 FROM legacy_job_agents_to_stop l
            WHERE l.job_id=jobs.job_id AND l.stopped_at IS NOT NULL))` : "";
        const terminalStoppedLegacyClause = legacyTable ? `AND NOT EXISTS
          (SELECT 1 FROM legacy_job_agents_to_stop l WHERE l.job_id=jobs.job_id AND l.stopped_at IS NOT NULL)` : "";
        const terminalProofTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_terminal_worker_stop_proofs'").get();
        const terminalStopProofClause = terminalProofTable ? `AND NOT EXISTS
          (SELECT 1 FROM job_terminal_worker_stop_proofs p WHERE p.job_id=jobs.job_id)` : "";
        const operatorAssertionTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_operator_assertion_recoveries'").get();
        const operatorAssertionClause = operatorAssertionTable ? `AND NOT EXISTS
          (SELECT 1 FROM job_operator_assertion_recoveries a WHERE a.job_id=jobs.job_id
            AND a.final_status=jobs.status AND a.final_updated_at=jobs.updated_at)` : "";
        let active = (database.prepare(`SELECT COUNT(*) AS count FROM jobs
          WHERE (status IN ('preparing','dispatching','running','blocked','needs_review','cancelling')
            AND NOT (status='needs_review' AND COALESCE(last_error_code,'')='result_path_exists'
              AND attempt_count=0 AND herdr_workspace_id IS NULL AND dispatch_started_at IS NULL AND prompt_accepted_at IS NULL)
            AND NOT (status='needs_review' AND COALESCE(last_error_code,'') IN
              ('invalid_result_agent_stopped','agent_not_found','agent_not_running','workspace_cleanup_agent_stopped'))
            ${stoppedLegacyClause})
            OR (status='retryable_failed' AND (last_error_code='stale_preparing' OR
              (herdr_workspace_id IS NOT NULL AND COALESCE(last_error_code,'') NOT IN ('agent_not_found','agent_not_running'))))
            OR steer_state='dispatching'
            OR (status IN ('completed','failed','cancelled') AND steer_state='accepted')
            OR (status IN ('completed','failed','cancelled') AND herdr_workspace_id IS NOT NULL
              AND COALESCE(last_error_code,'') NOT IN
                ('agent_not_found','agent_not_running','invalid_result_agent_stopped',
                 'workspace_cleanup_agent_stopped','cancel_worker_stopped')
              ${terminalStopProofClause}
              ${operatorAssertionClause}
              ${terminalStoppedLegacyClause})
            OR (status IN ('completed','failed','cancelled') AND last_error_code IN
              ('schedule_reconcile_worker_unverified','terminal_steer_worker_unverified','cancel_worker_unverified'))`)
          .get() as { count: number }).count;
        if (legacyTable) active += (database.prepare(`SELECT COUNT(*) AS count FROM legacy_job_agents_to_stop l
          JOIN jobs j ON j.job_id=l.job_id WHERE l.stopped_at IS NULL
            ${operatorAssertionTable ? `AND NOT EXISTS (SELECT 1 FROM job_operator_assertion_recoveries a
              WHERE a.job_id=j.job_id AND a.final_status=j.status AND a.final_updated_at=j.updated_at)` : ""}
            AND COALESCE(j.steer_state,'') NOT IN ('dispatching','accepted')
            AND COALESCE(j.last_error_code,'') <> 'schedule_reconcile_worker_unverified'
            AND COALESCE(j.last_error_code,'') NOT IN ('terminal_steer_worker_unverified','cancel_worker_unverified')
            AND j.status NOT IN ('preparing','dispatching','running','blocked','needs_review','cancelling')
            AND NOT (j.status='retryable_failed' AND (j.last_error_code='stale_preparing' OR
              (j.herdr_workspace_id IS NOT NULL AND COALESCE(j.last_error_code,'') NOT IN ('agent_not_found','agent_not_running'))))`)
          .get() as { count: number }).count;
        return { safe: active === 0, active_worker_count: active };
      } finally { database.close(); }
    } catch {
      return { safe: false, active_worker_count: 0, error_code: "worker_state_unverified" };
    }
  }

  async quiesceSlack(requestId: string, targetSha: string): Promise<DrainSnapshot> {
    let snapshot = drainSnapshot(await udsRequest(this.policy.slack_socket, "POST", "/v1/admin/quiesce", {
      schema_version: 1, protocol: 1, operation_id: requestId, target_sha: targetSha,
    }, this.policy.timeouts.drain_ms), "slack_adapter");
    const deadline = Date.now() + this.policy.timeouts.agent_drain_ms;
    while (!snapshot.drained && Date.now() < deadline) {
      await delay(100);
      snapshot = drainSnapshot(await udsRequest(
        this.policy.slack_socket, "GET", "/v1/admin/drain-status", undefined, this.policy.timeouts.health_ms,
      ), "slack_adapter");
    }
    return snapshot;
  }

  async slackDrainStatus(): Promise<DrainSnapshot> {
    return drainSnapshot(await udsRequest(this.policy.slack_socket, "GET", "/v1/admin/drain-status",
      undefined, this.policy.timeouts.health_ms), "slack_adapter");
  }

  async dispatcherDrainStatus(): Promise<DrainSnapshot> {
    return drainSnapshot(await udsRequest(this.policy.dispatcher_socket, "GET", "/v1/admin/drain-status",
      undefined, this.policy.timeouts.health_ms), "dispatcher");
  }

  async quiesceDispatcher(requestId: string, targetSha: string): Promise<DrainSnapshot> {
    let snapshot = drainSnapshot(await udsRequest(this.policy.dispatcher_socket, "POST", "/v1/admin/quiesce", {
      schema_version: 1, protocol: 1, operation_id: requestId, target_sha: targetSha,
    }, this.policy.timeouts.health_ms), "dispatcher");
    const deadline = Date.now() + this.policy.timeouts.agent_drain_ms;
    while (!snapshot.drained && Date.now() < deadline) {
      await delay(100);
      snapshot = drainSnapshot(await udsRequest(
        this.policy.dispatcher_socket, "GET", "/v1/admin/drain-status", undefined, this.policy.timeouts.health_ms,
      ), "dispatcher");
    }
    if (snapshot.drained) {
      // A pre-handoff Dispatcher can report a drained supervisor while Herdr
      // workers still run. Independently inspect durable job state before any
      // service stop, schema migration or pointer switch. No worker is stopped.
      const worker = await this.workerSafety();
      if (!worker.safe) snapshot = { ...snapshot, drained: false, in_flight: Math.max(snapshot.in_flight, 1),
        unsafe_states: [...snapshot.unsafe_states, worker.error_code
          ? "jobs.handoff_observation_unknown" : `jobs.handoff_unavailable:${worker.active_worker_count}`] };
    }
    return snapshot;
  }

  async schemaMigrationCapability(capability: string): Promise<{ ready: boolean; build_sha: string | null }> {
    const buildSha = process.env.DONA_UPDATER_BUILD_SHA?.trim() ?? null;
    if (!buildSha || !/^[0-9a-f]{40}$/.test(buildSha)) return { ready: false, build_sha: null };
    try {
      const receiptPath = path.join(this.policy.control_root, "control-plane-receipt.json");
      const stats = await fs.lstat(receiptPath);
      const uid = process.getuid?.();
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || uid === undefined || stats.uid !== uid || (stats.mode & 0o077) !== 0) {
        return { ready: false, build_sha: buildSha };
      }
      const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as Record<string, unknown>;
      this.dispatcherDatabasePath();
      const attemptId = receipt.attempt_id;
      if (typeof attemptId !== "string" || !/^[0-9a-f]{40}\.[A-Za-z0-9]+$/.test(attemptId) ||
          typeof receipt.attempt_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(receipt.attempt_sha256)) {
        return { ready: false, build_sha: buildSha };
      }
      const attemptDirectory = path.join(this.policy.control_root, "control-backups", attemptId);
      const attemptDirectoryStats = await fs.lstat(attemptDirectory);
      const attemptPath = path.join(attemptDirectory, "attempt.json");
      const attemptStats = await fs.lstat(attemptPath);
      if (!attemptDirectoryStats.isDirectory() || attemptDirectoryStats.isSymbolicLink() ||
          attemptDirectoryStats.uid !== uid || (attemptDirectoryStats.mode & 0o077) !== 0 ||
          !attemptStats.isFile() || attemptStats.isSymbolicLink() || attemptStats.uid !== uid ||
          attemptStats.nlink !== 1 || (attemptStats.mode & 0o077) !== 0) {
        return { ready: false, build_sha: buildSha };
      }
      const attemptBytes = await fs.readFile(attemptPath);
      const attempt = JSON.parse(attemptBytes.toString("utf8")) as Record<string, unknown>;
      const rehearsalPath = path.join(attemptDirectory, "restore-rehearsal.json");
      const rehearsalStats = await fs.lstat(rehearsalPath);
      if (!rehearsalStats.isFile() || rehearsalStats.isSymbolicLink() || rehearsalStats.uid !== uid ||
          rehearsalStats.nlink !== 1 || (rehearsalStats.mode & 0o077) !== 0) {
        return { ready: false, build_sha: buildSha };
      }
      const rehearsalBytes = await fs.readFile(rehearsalPath);
      const rehearsal = JSON.parse(rehearsalBytes.toString("utf8")) as Record<string, unknown>;
      const matchingAttempt = createHash("sha256").update(attemptBytes).digest("hex") === receipt.attempt_sha256 &&
        attempt.schema_version === 1 && attempt.phase === "verified" && attempt.new_build_sha === buildSha &&
        attempt.old_build_sha === receipt.old_build_sha && attempt.new_policy_sha256 === receipt.policy_sha256 &&
        attempt.new_plist_sha256 === receipt.plist_sha256 && attempt.db_backup_sha256 === receipt.db_backup_sha256 &&
        attempt.release_tree_sha256 === receipt.release_tree_sha256 &&
        typeof attempt.release_tree_sha256 === "string" && /^[0-9a-f]{64}$/.test(attempt.release_tree_sha256) &&
        attempt.restore_rehearsal_sha256 === receipt.restore_rehearsal_sha256 &&
        typeof attempt.restore_rehearsal_sha256 === "string" && /^[0-9a-f]{64}$/.test(attempt.restore_rehearsal_sha256) &&
        createHash("sha256").update(rehearsalBytes).digest("hex") === attempt.restore_rehearsal_sha256 &&
        rehearsal.schema_version === 1 && rehearsal.backup_sha256 === attempt.db_backup_sha256 &&
        rehearsal.old_binary_restored_backup_readable === true &&
        typeof rehearsal.old_schema === "number" && Number.isSafeInteger(rehearsal.old_schema) && rehearsal.old_schema >= 0 &&
        typeof rehearsal.new_schema === "number" && Number.isSafeInteger(rehearsal.new_schema) &&
        rehearsal.new_schema >= rehearsal.old_schema &&
        rehearsal.rollback === (rehearsal.new_schema > rehearsal.old_schema ? "restore_backup_required" : "same_schema");
      const artifactDigest = async (file: string): Promise<string> => {
        const handle = await fs.open(file, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
            throw new Error("control_artifact_identity_unverified");
          }
          return createHash("sha256").update(await handle.readFile()).digest("hex");
        } finally { await handle.close(); }
      };
      const currentArtifactsMatch =
        await artifactDigest(path.join(this.policy.control_root, "policy.json")) === attempt.new_policy_sha256 &&
        await artifactDigest(path.join(os.homedir(), "Library/LaunchAgents/dev.dona.updater.plist")) === attempt.new_plist_sha256 &&
        await artifactDigest(path.join(attemptDirectory, "updater.previous.sqlite3")) === attempt.db_backup_sha256;
      const releaseRoot = path.join(this.policy.release_root, buildSha);
      const releaseHash = createHash("sha256");
      const visitRelease = async (directory: string, relativeDirectory = ""): Promise<void> => {
        const directoryStats = await fs.lstat(directory);
        if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink() || directoryStats.uid !== uid ||
            (directoryStats.mode & 0o777) !== 0o500) throw new Error("release_identity_unverified");
        const entries = await fs.readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          if (!relativeDirectory && entry.name === ".git") continue;
          const relative = path.join(relativeDirectory, entry.name);
          const full = path.join(directory, entry.name);
          const stat = await fs.lstat(full);
          if (stat.uid !== uid) throw new Error("release_owner_unverified");
          if (stat.isDirectory() && !stat.isSymbolicLink()) {
            releaseHash.update(`d\0${relative}\0`);
            await visitRelease(full, relative);
          } else if (stat.isFile() && !stat.isSymbolicLink()) {
            if (stat.nlink !== 1 || (stat.mode & 0o777) !== 0o400) throw new Error("release_file_identity_unverified");
            releaseHash.update(`f\0${relative}\0`);
            if (relative === "release-manifest.json") {
              const manifest = JSON.parse(await fs.readFile(full, "utf8")) as Record<string, unknown>;
              if (typeof manifest.built_at !== "string") throw new Error("release_manifest_identity_unverified");
              releaseHash.update(JSON.stringify({ ...manifest, built_at: null }));
            } else releaseHash.update(await fs.readFile(full));
            releaseHash.update("\0");
          } else if (stat.isSymbolicLink()) {
            const resolved = await fs.realpath(full);
            const inside = path.relative(releaseRoot, resolved);
            if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
              throw new Error("release_link_escaped");
            }
            releaseHash.update(`l\0${relative}\0${await fs.readlink(full)}\0`);
          } else throw new Error("release_entry_unverified");
        }
      };
      await visitRelease(releaseRoot);
      const releaseMatches = releaseHash.digest("hex") === receipt.release_tree_sha256;
      return {
        ready: receipt.schema_version === 1 && receipt.build_sha === buildSha &&
          receipt.schema_migration_capability === capability && matchingAttempt && currentArtifactsMatch && releaseMatches,
        build_sha: buildSha,
      };
    } catch {
      return { ready: false, build_sha: buildSha };
    }
  }

  stopSlack(): Promise<CommandResult> {
    return this.launchctl(["bootout", this.domainTarget(this.policy.launchd.slack_label)]);
  }

  slackRegistered(): Promise<boolean> {
    return this.serviceRegistered(this.policy.launchd.slack_label);
  }

  stopDispatcher(): Promise<CommandResult> {
    return this.launchctl(["bootout", this.domainTarget(this.policy.launchd.dispatcher_label)]);
  }

  async dispatcherRegistered(): Promise<boolean> {
    return this.serviceRegistered(this.policy.launchd.dispatcher_label);
  }

  private async serviceRegistered(label: string): Promise<boolean> {
    const errorCode = label === this.policy.launchd.dispatcher_label
      ? "dispatcher_registration_unverified" : "slack_registration_unverified";
    const result = await this.launchctl(["print", this.domainTarget(label)]);
    if (result.timed_out || result.output_truncated || result.exit_code === null) {
      throw new Error(errorCode);
    }
    if (result.exit_code === 0) return true;
    if (/Could not find (?:specified )?service/i.test(result.stderr)) return false;
    throw new Error(errorCode);
  }

  migrateAppSchema(_requestId: string, targetSha: string, previous: Compatibility, target: Compatibility): Promise<CommandResult> {
    const databasePath = this.dispatcherDatabasePath();
    // The schema transition outlives an individual update request. A later
    // activation attempt must be able to validate and reuse the durable v2
    // backup/receipt left by an earlier attempt that rolled the release back.
    const backupRoot = path.join(this.policy.control_root, "schema-backups", "dispatcher-v2-to-v3");
    return this.runner.run(this.policy.executables.node, [
      path.join(this.policy.release_root, targetSha, "dispatcher", "dist", "schema-rollout-cli.js"),
      databasePath,
      path.join(backupRoot, "dispatcher-v2.sqlite3"),
      path.join(backupRoot, "migration-receipt.json"),
      JSON.stringify(previous),
      JSON.stringify(target),
    ], {
      timeoutMs: this.policy.timeouts.command_ms,
      outputLimitBytes: this.policy.output_limit_bytes,
      env: minimalEnvironment(),
    });
  }

  async appSchemaState(): Promise<{ user_version: number; integrity_ok: boolean; foreign_key_violations: number }> {
    const result = await this.runner.run(this.policy.executables.node, [
      fileURLToPath(new URL("./app-schema-inspect-cli.js", import.meta.url)),
      this.dispatcherDatabasePath(),
    ], {
      timeoutMs: this.policy.timeouts.command_ms,
      outputLimitBytes: this.policy.output_limit_bytes,
      env: minimalEnvironment(),
    });
    if (result.output_truncated) throw new Error("app_schema_inspect_output_truncated");
    const value = JSON.parse(requireSuccess("app schema inspection", result)) as Record<string, unknown>;
    if (value.schema_version !== 1 || !Number.isSafeInteger(value.user_version) ||
      typeof value.integrity_ok !== "boolean" || !Number.isSafeInteger(value.foreign_key_violations) ||
      (value.foreign_key_violations as number) < 0) {
      throw new Error("app_schema_inspect_result_invalid");
    }
    return {
      user_version: value.user_version as number,
      integrity_ok: value.integrity_ok,
      foreign_key_violations: value.foreign_key_violations as number,
    };
  }

  private dispatcherDatabasePath(): string {
    const environmentPath = path.join(this.policy.config_root, "dispatcher.env");
    const stats = fsSync.lstatSync(environmentPath);
    const uid = process.getuid?.();
    if (!stats.isFile() || stats.isSymbolicLink() || uid === undefined || stats.uid !== uid || (stats.mode & 0o077) !== 0) {
      throw new Error("dispatcher_environment_identity_invalid");
    }
    const configured = parseDotenv(fsSync.readFileSync(environmentPath)).DONA_DATABASE_PATH;
    if (configured !== undefined && (!configured || /[\0\r\n]/.test(configured))) {
      throw new Error("dispatcher_database_path_invalid");
    }
    const base = path.resolve(this.policy.config_root, "..");
    if (configured !== undefined && configured !== "~" && !configured.startsWith("~/") && !path.isAbsolute(configured)) {
      throw new Error("dispatcher_database_path_must_be_absolute");
    }
    const resolved = configured === undefined ? path.join(base, "dona.sqlite3")
      : configured === "~" ? os.homedir()
        : configured.startsWith("~/") ? path.join(os.homedir(), configured.slice(2)) : path.resolve(configured);
    if (!path.isAbsolute(resolved) || path.normalize(resolved) !== resolved) throw new Error("dispatcher_database_path_invalid");
    const database = fsSync.lstatSync(resolved);
    if (!database.isFile() || database.isSymbolicLink() || database.uid !== uid || (database.mode & 0o077) !== 0) {
      throw new Error("dispatcher_database_identity_invalid");
    }
    return resolved;
  }

  async startDispatcher(): Promise<CommandResult> {
    if (await this.dispatcherRegistered()) {
      return this.launchctl(["kickstart", "-k", this.domainTarget(this.policy.launchd.dispatcher_label)]);
    }
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("launchctl_requires_unix_uid");
    return this.launchctl(["bootstrap", `gui/${uid}`,
      path.join(os.homedir(), "Library/LaunchAgents/dev.dona.dispatcher.plist")]);
  }

  async startSlack(): Promise<CommandResult> {
    if (await this.slackRegistered()) {
      return this.launchctl(["kickstart", "-k", this.domainTarget(this.policy.launchd.slack_label)]);
    }
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("launchctl_requires_unix_uid");
    return this.launchctl(["bootstrap", `gui/${uid}`,
      path.join(os.homedir(), "Library/LaunchAgents/dev.dona.slack-adapter.plist")]);
  }

  async waitForMainAgentIdle(): Promise<MainAgentObservation> {
    if (!(await this.herdrVersionSupported())) return missingMainAgent("unsupported_herdr_version");
    const result = await this.herdr([
      "--session", this.policy.main_agent.session,
      "agent", "wait", this.policy.main_agent.name,
      "--until", "idle", "--until", "done", "--until", "blocked",
      "--timeout", String(this.policy.timeouts.agent_drain_ms),
    ], this.policy.timeouts.agent_drain_ms + 5_000);
    return mainAgentObservation(result);
  }

  async stopMainAgent(expected: MainAgentObservation): Promise<MainAgentStopResult> {
    if (!expected.exists || !expected.pane_id || !expected.session_id || !["idle", "done"].includes(expected.status ?? "") ||
      expected.name !== this.policy.main_agent.name || expected.kind !== "codex") {
      return { outcome: "rejected", pane_id: expected.pane_id, error_code: "main_agent_not_idle" };
    }
    const current = await this.readMainAgent();
    if (!sameMainAgent(expected, current) || !["idle", "done"].includes(current.status ?? "")) {
      return { outcome: "rejected", pane_id: expected.pane_id, error_code: "main_agent_identity_changed" };
    }
    const stopped = await this.herdr([
      "--session", this.policy.main_agent.session,
      "agent", "send-keys", expected.pane_id, "ctrl+c",
    ], this.policy.timeouts.health_ms);
    if (stopped.timed_out || stopped.output_truncated || stopped.exit_code !== 0) {
      return { outcome: "accepted_unknown", pane_id: expected.pane_id, error_code: herdrErrorCode(stopped) ?? "main_agent_stop_unknown" };
    }
    const deadline = Date.now() + this.policy.timeouts.agent_exit_ms;
    do {
      const observed = await this.readAgent(expected.pane_id);
      if (!observed.exists && ["agent_not_found", "agent_not_running"].includes(observed.error_code ?? "")) {
        return { outcome: "stopped", pane_id: expected.pane_id, error_code: null };
      }
      if (!observed.exists) {
        return { outcome: "accepted_unknown", pane_id: expected.pane_id, error_code: observed.error_code ?? "main_agent_exit_observation_failed" };
      }
      if (!sameMainAgent(expected, observed)) {
        return { outcome: "accepted_unknown", pane_id: expected.pane_id, error_code: "main_agent_identity_changed_after_stop" };
      }
      await delay(100);
    } while (Date.now() < deadline);
    return { outcome: "accepted_unknown", pane_id: expected.pane_id, error_code: "main_agent_exit_not_observed" };
  }

  async startMainAgent(paneId: string, releasePath: string, previousSessionId?: string): Promise<MainAgentStartResult> {
    if (!/^[a-z0-9][a-z0-9:_-]{0,63}$/.test(paneId)) {
      return { outcome: "rejected", observation: missingMainAgent("invalid_main_agent_pane"), error_code: "invalid_main_agent_pane" };
    }
    let canonicalRelease: string;
    let canonicalConfigRoot: string;
    try {
      const [root, release, configRoot, configRootStats] = await Promise.all([
        fs.realpath(this.policy.release_root), fs.realpath(releasePath), fs.realpath(this.policy.config_root),
        fs.lstat(this.policy.config_root),
      ]);
      const uid = process.getuid?.();
      if (path.dirname(release) !== root || !/^[0-9a-f]{40}$/.test(path.basename(release))) throw new Error("release_path_outside_fixed_root");
      if (uid === undefined || !configRootStats.isDirectory() || configRootStats.isSymbolicLink() ||
        configRootStats.uid !== uid || (configRootStats.mode & 0o077) !== 0) throw new Error("config_root_is_not_private");
      const codexConfigStats = await fs.lstat(path.join(release, ".codex", "config.toml"));
      if (!codexConfigStats.isFile() || codexConfigStats.isSymbolicLink() || codexConfigStats.uid !== uid ||
        (codexConfigStats.mode & 0o022) !== 0) throw new Error("codex_config_is_not_trusted");
      for (const name of ["dispatcher.env", "slack.env"]) {
        const stats = await fs.lstat(path.join(configRoot, name));
        if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== uid || (stats.mode & 0o077) !== 0) {
          throw new Error("config_file_is_not_private");
        }
      }
      canonicalRelease = release;
      canonicalConfigRoot = configRoot;
    } catch {
      return { outcome: "rejected", observation: missingMainAgent("invalid_main_agent_release"), error_code: "invalid_main_agent_release" };
    }
    const paneOccupant = await this.readAgent(paneId);
    if (paneOccupant.exists) {
      return { outcome: "rejected", observation: paneOccupant, error_code: "agent_pane_busy" };
    }
    if (!["agent_not_found", "agent_not_running"].includes(paneOccupant.error_code ?? "")) {
      return { outcome: "accepted_unknown", observation: paneOccupant, error_code: "main_agent_pane_state_unknown" };
    }
    const cwdChange = await this.herdr([
      "--session", this.policy.main_agent.session,
      "pane", "run", paneId, `cd -- ${shellSingleQuote(canonicalRelease)}`,
    ], this.policy.timeouts.health_ms);
    const cwdDeadline = Date.now() + this.policy.timeouts.agent_exit_ms;
    let observedPaneCwd: string | undefined;
    do {
      const pane = await this.herdr([
        "--session", this.policy.main_agent.session,
        "pane", "get", paneId,
      ], this.policy.timeouts.health_ms);
      observedPaneCwd = paneWorkingDirectory(pane);
      if (observedPaneCwd !== undefined && path.normalize(observedPaneCwd) === path.normalize(canonicalRelease)) break;
      await delay(100);
    } while (Date.now() < cwdDeadline);
    if (observedPaneCwd === undefined || path.normalize(observedPaneCwd) !== path.normalize(canonicalRelease)) {
      const errorCode = herdrErrorCode(cwdChange) ?? "main_agent_pane_cwd_change_unknown";
      return {
        outcome: cwdChange.exit_code !== 0 && !cwdChange.timed_out && !cwdChange.output_truncated ? "rejected" : "accepted_unknown",
        observation: missingMainAgent(errorCode),
        error_code: errorCode,
      };
    }
    const projectTrust = `projects = { ${JSON.stringify(canonicalRelease)} = { trust_level = "trusted" } }`;
    const dispatcherMcpEnvironment = `mcp_servers.dona_dispatcher.env = ${tomlInlineTable({
      DOTENV_CONFIG_PATH: path.join(canonicalConfigRoot, "dispatcher.env"),
      DONA_RELEASE_MANIFEST_PATH: path.join(this.policy.current_pointer, "release-manifest.json"),
      DONA_UPDATER_SOCKET_PATH: path.join(this.policy.control_root, "updater.sock"),
      DONA_UPDATE_INTERNAL_TOKEN_PATH: this.policy.dispatcher_internal_token_file,
      DONA_HERDR_PATH: this.policy.executables.herdr,
      DONA_CODEX_PATH: this.policy.executables.codex,
      DONA_GH_PATH: this.policy.executables.gh,
      DONA_GIT_PATH: this.policy.executables.git,
    })}`;
    const slackMcpEnvironment = `mcp_servers.dona_slack.env = ${tomlInlineTable({
      DOTENV_CONFIG_PATH: path.join(canonicalConfigRoot, "slack.env"),
      DONA_UPDATE_INTERNAL_TOKEN_PATH: this.policy.dispatcher_internal_token_file,
    })}`;
    const deadline = Date.now() + this.policy.timeouts.agent_exit_ms;
    let result: CommandResult;
    do {
      result = await this.herdr([
        "--session", this.policy.main_agent.session,
        "agent", "start", this.policy.main_agent.name,
        "--kind", "codex", "--pane", paneId,
        "--timeout", String(this.policy.timeouts.agent_start_ms),
        "--", "-C", canonicalRelease, "-c", projectTrust,
        "-c", dispatcherMcpEnvironment, "-c", slackMcpEnvironment,
        "--model", "gpt-6-sol", "-c", 'model_reasoning_effort="medium"',
        "-c", "check_for_update_on_startup=false", mainAgentStartupPrompt,
      ], this.policy.timeouts.agent_start_ms + 5_000);
      if (result.exit_code === 0 && !result.timed_out && !result.output_truncated) break;
      if (herdrErrorCode(result) !== "agent_pane_busy" || Date.now() >= deadline) break;
      await delay(100);
    } while (true);
    let observation = mainAgentObservation(result, canonicalRelease);
    const observationDeadline = Date.now() + this.policy.timeouts.agent_start_ms;
    while (true) {
      if (observation.exists && observation.name === this.policy.main_agent.name && observation.kind === "codex" &&
        observation.pane_id === paneId && observation.session_id !== null &&
        observation.session_id !== previousSessionId && observation.interactive_ready &&
        observation.matches_release && ["idle", "done"].includes(observation.status ?? "")) {
        return { outcome: "started", observation, error_code: null };
      }
      const remaining = observationDeadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(250, remaining));
      observation = await this.mainAgentStatus(canonicalRelease);
    }
    const errorCode = herdrErrorCode(result) ?? observation.error_code ?? "main_agent_start_observation_timeout";
    const definitelyRejected = !result.timed_out && !result.output_truncated && !observation.exists &&
      ["agent_pane_busy", "agent_not_found", "invalid_request"].includes(errorCode);
    return { outcome: definitelyRejected ? "rejected" : "accepted_unknown", observation, error_code: errorCode };
  }

  async mainAgentStatus(releasePath: string): Promise<MainAgentObservation> {
    if (!(await this.herdrVersionSupported())) return missingMainAgent("unsupported_herdr_version");
    return this.readMainAgent(releasePath);
  }

  async dispatcherHealth(): Promise<HealthSnapshot> {
    return this.health(this.policy.dispatcher_socket, "dispatcher");
  }

  async slackHealth(): Promise<HealthSnapshot> {
    return this.health(this.policy.slack_socket, "slack_adapter");
  }

  private launchctl(args: readonly string[]): Promise<CommandResult> {
    return this.runner.run(this.policy.executables.launchctl, args, {
      timeoutMs: this.policy.timeouts.command_ms,
      outputLimitBytes: this.policy.output_limit_bytes,
      env: minimalEnvironment(),
    });
  }

  private herdr(args: readonly string[], timeoutMs: number): Promise<CommandResult> {
    return this.runner.run(this.policy.executables.herdr, args, {
      timeoutMs,
      outputLimitBytes: this.policy.output_limit_bytes,
      env: minimalEnvironment({ HOME: os.homedir() }),
    });
  }

  private async herdrVersionSupported(): Promise<boolean> {
    const version = await this.herdr(["--version"], this.policy.timeouts.health_ms);
    const actualVersion = /^herdr\s+(\d+\.\d+\.\d+)\s*$/m.exec(version.stdout)?.[1];
    return !version.timed_out && version.exit_code === 0 && actualVersion !== undefined &&
      versionAtLeast(actualVersion, this.policy.main_agent.minimum_herdr_version);
  }

  private async readMainAgent(expectedReleasePath?: string): Promise<MainAgentObservation> {
    return this.readAgent(this.policy.main_agent.name, expectedReleasePath);
  }

  private async readAgent(target: string, expectedReleasePath?: string): Promise<MainAgentObservation> {
    const result = await this.herdr([
      "--session", this.policy.main_agent.session,
      "agent", "get", target,
    ], this.policy.timeouts.health_ms);
    return mainAgentObservation(result, expectedReleasePath);
  }

  private domainTarget(label: string): string {
    if (!/^dev\.dona\.[a-z0-9.-]+$/.test(label)) throw new Error("launchd_label_not_allowed");
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("launchctl_requires_unix_uid");
    return `gui/${uid}/${label}`;
  }

  private async health(socketPath: string, service: HealthSnapshot["service"]): Promise<HealthSnapshot> {
    try {
      const response = parsedObject(await udsRequest(socketPath, "GET", "/health/version", undefined, this.policy.timeouts.health_ms));
      return {
        service,
        observed: true,
        live: response.status === "live" || response.status === "ready",
        ready: response.status === "ready",
        build_sha: typeof response.build_sha === "string" ? response.build_sha : null,
        protocol: typeof response.protocol === "number" ? response.protocol : null,
        app_schema: typeof response.app_schema === "number" ? response.app_schema : null,
        ...(typeof response.app_schema_read_min === "number"
          ? { app_schema_read_min: response.app_schema_read_min }
          : {}),
        ...(typeof response.app_schema_read_max === "number"
          ? { app_schema_read_max: response.app_schema_read_max }
          : {}),
        ...(typeof response.app_schema_write === "number"
          ? { app_schema_write: response.app_schema_write }
          : {}),
        config: typeof response.config === "number" ? response.config : null,
        ...(typeof response.update_notification_protocol === "number"
          ? { update_notification_protocol: response.update_notification_protocol }
          : {}),
        ...(service === "slack_adapter" ? { workspaces_ready: response.workspaces_ready === true } : {}),
      };
    } catch {
      return { service, observed: false, live: false, ready: false, build_sha: null, protocol: null, app_schema: null, config: null };
    }
  }
}

export class RealDispatcher implements DispatcherPort {
  constructor(private readonly policy: UpdatePolicy) {}

  async verifyApproval(input: Record<string, unknown>): Promise<string> {
    const token = (await readOwnerFile(this.policy.dispatcher_internal_token_file, 4096, true)).toString("utf8").trim();
    if (token.length < 32) throw new Error("approval_proof_token_unavailable");
    const response = parsedObject(await udsRequest(this.policy.dispatcher_socket, "POST",
      "/v1/internal/self-update/approval-proof", input, this.policy.timeouts.health_ms,
      { "x-dona-update-token": token }));
    if (response.schema_version !== 1 || typeof response.approval_id !== "string" ||
      !/^[0-9a-f]{64}$/.test(response.approval_id)) throw new Error("approval_proof_unverified");
    return response.approval_id;
  }

  async eventTerminal(eventId: string): Promise<boolean> {
    const response = parsedObject(await udsRequest(
      this.policy.dispatcher_socket, "GET", `/v1/events/${encodeURIComponent(eventId)}/terminal`, undefined,
      this.policy.timeouts.health_ms,
    ));
    return response.terminal === true;
  }

  async safetyStatus(): Promise<{ safe: boolean; unsafe_states: string[] }> {
    const response = parsedObject(await udsRequest(
      this.policy.dispatcher_socket, "GET", "/v1/admin/update-safety", undefined, this.policy.timeouts.health_ms,
    ));
    return {
      safe: response.safe === true,
      unsafe_states: Array.isArray(response.unsafe_states) ? response.unsafe_states.filter((value): value is string => typeof value === "string") : [],
    };
  }

  async deliverCompletion(outbox: OutboxRow): Promise<import("./types.js").CompletionDeliveryResult> {
    let token: string;
    try {
      token = (await fs.readFile(this.policy.dispatcher_internal_token_file, "utf8")).trim();
      if (token.length < 32) return { outcome: "definitive_rejection", error_code: "invalid_internal_token" };
    } catch {
      return { outcome: "definitive_rejection", error_code: "missing_internal_token" };
    }
    try {
      const response = await udsRequest(
        this.policy.dispatcher_socket,
        "POST",
        "/v1/internal/update-events",
        JSON.parse(outbox.payload_json),
        this.policy.timeouts.health_ms,
        { "x-dona-update-token": token },
      );
      if (response.statusCode === 200 || response.statusCode === 202) {
        const parsed = parsedObject(response);
        return typeof parsed.event_id === "string"
          ? { outcome: "accepted", event_id: parsed.event_id }
          : { outcome: "acceptance_unknown", error_code: "missing_dispatcher_event_id" };
      }
      return response.statusCode >= 400 && response.statusCode < 500
        ? { outcome: "definitive_rejection", error_code: `dispatcher_http_${response.statusCode}` }
        : { outcome: "unavailable", error_code: `dispatcher_http_${response.statusCode}` };
    } catch (error) {
      return {
        outcome: "acceptance_unknown",
        error_code: error instanceof Error && error.message.includes("timeout")
          ? "completion_post_timeout"
          : "completion_post_connection_lost",
      };
    }
  }

  async completionLookup(outbox: OutboxRow): Promise<import("./types.js").CompletionLookupResult> {
    let token: string;
    try {
      token = (await fs.readFile(this.policy.dispatcher_internal_token_file, "utf8")).trim();
      if (token.length < 32) return { outcome: "unavailable", error_code: "invalid_internal_token" };
    } catch {
      return { outcome: "unavailable", error_code: "missing_internal_token" };
    }
    try {
      const query = new URLSearchParams({
        external_event_id: outbox.external_event_id,
        payload_sha256: sha256(outbox.payload_json),
      });
      const response = await udsRequest(
        this.policy.dispatcher_socket, "GET", `/v1/internal/update-events/lookup?${query}`, undefined,
        this.policy.timeouts.health_ms, { "x-dona-update-token": token },
      );
      if (response.statusCode === 404) return { outcome: "absent" };
      if (response.statusCode === 409) return { outcome: "conflict", error_code: "completion_payload_mismatch" };
      if (response.statusCode !== 200) return { outcome: "unavailable", error_code: `dispatcher_lookup_http_${response.statusCode}` };
      const parsed = parsedObject(response);
      return parsed.exists === true && typeof parsed.event_id === "string" && typeof parsed.status === "string"
        ? { outcome: "exists", event_id: parsed.event_id, status: parsed.status }
        : { outcome: "unavailable", error_code: "invalid_dispatcher_lookup_response" };
    } catch {
      return { outcome: "unavailable", error_code: "dispatcher_lookup_unavailable" };
    }
  }
}
