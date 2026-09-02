import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import type { UpdatePolicy } from "./policy.js";
import type { BuildPort, DispatcherPort, GitPort, RuntimePort } from "./ports.js";
import { ProcessRunner, minimalEnvironment } from "./process.js";
import { redactText } from "./redaction.js";
import type { CommandResult, Compatibility, DrainSnapshot, HealthSnapshot, OutboxRow } from "./types.js";
import { fullSha, parseCompatibilityMetadata, sha256 } from "./validation.js";

function commandError(name: string, result: CommandResult): Error {
  const suffix = result.timed_out ? "timed out" : `exited ${result.exit_code}`;
  return new Error(redactText(`${name} ${suffix}: ${result.stderr || result.stdout}`, 1_000));
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
      let checkRuns: Array<{ name?: unknown; status?: unknown; conclusion?: unknown; app?: { slug?: unknown } }>;
      try {
        const parsed = JSON.parse(result.stdout) as { check_runs?: unknown };
        checkRuns = Array.isArray(parsed.check_runs) ? parsed.check_runs : [];
      } catch {
        return false;
      }
      const trusted = this.policy.required_checks.every((name) => checkRuns.some((run) =>
        run.name === name && run.status === "completed" && run.conclusion === "success" && run.app?.slug === "github-actions",
      ));
      if (!trusted) return false;
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

export class CanonicalBuild implements BuildPort {
  constructor(private readonly policy: UpdatePolicy, private readonly runner = new ProcessRunner()) {}

  async toolchain(): Promise<{ node_version: string; npm_version: string }> {
    const npmVersion = requireSuccess("npm --version", await this.runner.run(this.policy.executables.npm, ["--version"], {
      timeoutMs: this.policy.timeouts.command_ms,
      outputLimitBytes: this.policy.output_limit_bytes,
      env: minimalEnvironment({ npm_config_userconfig: "/dev/null", npm_config_globalconfig: "/dev/null" }),
    }));
    return { node_version: process.versions.node, npm_version: npmVersion };
  }

  async buildRelease(checkoutPath: string): Promise<{
    lock_hashes: Record<string, string>;
    node_version: string;
    npm_version: string;
    compatibility: Compatibility;
  }> {
    const components = ["dispatcher", "sources/slack", "updater"] as const;
    const lockHashes: Record<string, string> = {};
    const npmEnvironment = minimalEnvironment({
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      npm_config_userconfig: "/dev/null",
      npm_config_globalconfig: "/dev/null",
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
      for (const args of [["ci"], ["test"], ["run", "typecheck"], ["run", "build"]] as const) {
        const result = await this.runner.run(this.policy.executables.npm, args, {
          cwd: directory,
          timeoutMs: this.policy.timeouts.command_ms,
          outputLimitBytes: this.policy.output_limit_bytes,
          env: npmEnvironment,
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

export class RealRuntime implements RuntimePort {
  constructor(private readonly policy: UpdatePolicy, private readonly runner = new ProcessRunner()) {}

  async quiesceSlack(requestId: string, targetSha: string): Promise<DrainSnapshot> {
    const response = await udsRequest(this.policy.slack_socket, "POST", "/v1/admin/quiesce", {
      schema_version: 1, protocol: 1, operation_id: requestId, target_sha: targetSha,
    }, this.policy.timeouts.drain_ms);
    return drainSnapshot(response, "slack_adapter");
  }

  async quiesceDispatcher(requestId: string, targetSha: string): Promise<DrainSnapshot> {
    const response = await udsRequest(this.policy.dispatcher_socket, "POST", "/v1/admin/quiesce", {
      schema_version: 1, protocol: 1, operation_id: requestId, target_sha: targetSha,
    }, this.policy.timeouts.drain_ms);
    return drainSnapshot(response, "dispatcher");
  }

  stopSlack(): Promise<CommandResult> {
    return this.launchctl(["kill", "SIGTERM", this.domainTarget(this.policy.launchd.slack_label)]);
  }

  stopDispatcher(): Promise<CommandResult> {
    return this.launchctl(["kill", "SIGTERM", this.domainTarget(this.policy.launchd.dispatcher_label)]);
  }

  startDispatcher(): Promise<CommandResult> {
    return this.launchctl(["kickstart", this.domainTarget(this.policy.launchd.dispatcher_label)]);
  }

  startSlack(): Promise<CommandResult> {
    return this.launchctl(["kickstart", this.domainTarget(this.policy.launchd.slack_label)]);
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
        live: response.status === "live" || response.status === "ready",
        ready: response.status === "ready",
        build_sha: typeof response.build_sha === "string" ? response.build_sha : null,
        protocol: typeof response.protocol === "number" ? response.protocol : null,
        app_schema: typeof response.app_schema === "number" ? response.app_schema : null,
        config: typeof response.config === "number" ? response.config : null,
        ...(service === "slack_adapter" ? { workspaces_ready: response.workspaces_ready === true } : {}),
      };
    } catch {
      return { service, live: false, ready: false, build_sha: null, protocol: null, app_schema: null, config: null };
    }
  }
}

export class RealDispatcher implements DispatcherPort {
  constructor(private readonly policy: UpdatePolicy) {}

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

  async deliverCompletion(outbox: OutboxRow): Promise<"delivered" | "accepted_unknown" | "rejected"> {
    let token: string;
    try {
      token = (await fs.readFile(this.policy.dispatcher_internal_token_file, "utf8")).trim();
      if (token.length < 32) return "rejected";
    } catch {
      return "rejected";
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
      return response.statusCode === 200 || response.statusCode === 202 ? "delivered" : "rejected";
    } catch {
      return "accepted_unknown";
    }
  }

  async completionExists(externalEventId: string): Promise<boolean> {
    let token: string;
    try {
      token = (await fs.readFile(this.policy.dispatcher_internal_token_file, "utf8")).trim();
      if (token.length < 32) return false;
    } catch {
      return false;
    }
    try {
      const query = new URLSearchParams({ external_event_id: externalEventId });
      const response = await udsRequest(
        this.policy.dispatcher_socket, "GET", `/v1/internal/update-events/lookup?${query}`, undefined,
        this.policy.timeouts.health_ms, { "x-dona-update-token": token },
      );
      if (response.statusCode === 404) return false;
      return parsedObject(response).exists === true;
    } catch {
      return false;
    }
  }
}
