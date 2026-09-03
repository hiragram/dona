import fs from "node:fs";
import path from "node:path";

import type { Compatibility } from "./types.js";
import { fullSha, ValidationError } from "./validation.js";

export interface UpdatePolicy {
  schema_version: 1;
  policy_version: string;
  repository: "hiragram/dona";
  canonical_remote: string;
  default_branch: "main";
  control_root: string;
  config_root: string;
  release_root: string;
  current_pointer: string;
  previous_pointer: string;
  dispatcher_socket: string;
  slack_socket: string;
  dispatcher_internal_token_file: string;
  main_agent: {
    session: "dona";
    name: "dona-main";
    minimum_herdr_version: string;
  };
  launchd: {
    dispatcher_label: string;
    slack_label: string;
  };
  executables: {
    git: string;
    npm: string;
    node: string;
    launchctl: string;
    gh: string;
    herdr: string;
  };
  timeouts: {
    command_ms: number;
    health_ms: number;
    drain_ms: number;
    agent_drain_ms: number;
    agent_exit_ms: number;
    agent_start_ms: number;
    reconcile_ms: number;
    lease_ms: number;
  };
  output_limit_bytes: number;
  disk_floor_bytes: number;
  retain_successful: number;
  required_checks: string[];
  require_verified_signature: boolean;
  compatibility: Compatibility;
}

function absolute(value: unknown, name: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new ValidationError(`${name} must be a normalized absolute path`);
  }
  return value;
}

function integer(value: unknown, name: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new ValidationError(`${name} is invalid`);
  return value as number;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const extras = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in value));
  if (extras.length || missing.length) throw new ValidationError(`${name} fields do not match schema`);
}

function compatibility(input: unknown): Compatibility {
  const value = record(input, "compatibility");
  exact(value, ["protocol", "config", "app_schema_read_min", "app_schema_read_max", "app_schema_write", "rollback_safe"], "compatibility");
  const result: Compatibility = {
    protocol: integer(value.protocol, "compatibility.protocol"),
    config: integer(value.config, "compatibility.config"),
    app_schema_read_min: integer(value.app_schema_read_min, "compatibility.app_schema_read_min"),
    app_schema_read_max: integer(value.app_schema_read_max, "compatibility.app_schema_read_max"),
    app_schema_write: integer(value.app_schema_write, "compatibility.app_schema_write"),
    rollback_safe: value.rollback_safe === true,
  };
  if (result.app_schema_read_min > result.app_schema_read_max) throw new ValidationError("app schema range is invalid");
  if (result.app_schema_write < result.app_schema_read_min || result.app_schema_write > result.app_schema_read_max) {
    throw new ValidationError("app schema write version is outside the read range");
  }
  return result;
}

export function parsePolicy(input: unknown): UpdatePolicy {
  const value = record(input, "policy");
  exact(value, [
    "schema_version", "policy_version", "repository", "canonical_remote", "default_branch",
    "control_root", "config_root", "release_root", "current_pointer", "previous_pointer", "dispatcher_socket",
    "slack_socket", "dispatcher_internal_token_file", "main_agent", "launchd", "executables", "timeouts",
    "output_limit_bytes", "disk_floor_bytes", "retain_successful", "required_checks", "require_verified_signature", "compatibility",
  ], "policy");
  if (value.schema_version !== 1 || value.repository !== "hiragram/dona" || value.default_branch !== "main") {
    throw new ValidationError("policy repository/default branch/schema are not supported");
  }
  if (value.canonical_remote !== "https://github.com/hiragram/dona.git") throw new ValidationError("canonical_remote is not allowed");
  if (typeof value.policy_version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value.policy_version)) {
    throw new ValidationError("policy_version is invalid");
  }
  const mainAgent = record(value.main_agent, "main_agent");
  exact(mainAgent, ["session", "name", "minimum_herdr_version"], "main_agent");
  if (mainAgent.session !== "dona" || mainAgent.name !== "dona-main" ||
    typeof mainAgent.minimum_herdr_version !== "string" || !/^\d+\.\d+\.\d+$/.test(mainAgent.minimum_herdr_version)) {
    throw new ValidationError("main_agent configuration is not allowed");
  }
  const launchd = record(value.launchd, "launchd");
  exact(launchd, ["dispatcher_label", "slack_label"], "launchd");
  if (launchd.dispatcher_label !== "dev.dona.dispatcher" || launchd.slack_label !== "dev.dona.slack-adapter") {
    throw new ValidationError("launchd labels are not allowed");
  }
  const executables = record(value.executables, "executables");
  exact(executables, ["git", "npm", "node", "launchctl", "gh", "herdr"], "executables");
  const timeouts = record(value.timeouts, "timeouts");
  exact(timeouts, ["command_ms", "health_ms", "drain_ms", "agent_drain_ms", "agent_exit_ms", "agent_start_ms", "reconcile_ms", "lease_ms"], "timeouts");
  const controlRoot = absolute(value.control_root, "control_root");
  const configRoot = absolute(value.config_root, "config_root");
  const releaseRoot = absolute(value.release_root, "release_root");
  const currentPointer = absolute(value.current_pointer, "current_pointer");
  const previousPointer = absolute(value.previous_pointer, "previous_pointer");
  if (path.dirname(currentPointer) !== path.dirname(previousPointer) || path.dirname(currentPointer) !== path.dirname(releaseRoot)) {
    throw new ValidationError("release_root and pointers must share one parent filesystem boundary");
  }
  if (releaseRoot === controlRoot || releaseRoot.startsWith(`${controlRoot}${path.sep}`) || controlRoot.startsWith(`${releaseRoot}${path.sep}`)) {
    throw new ValidationError("stable control_root must be outside the mutable release_root");
  }
  const baseRoot = path.dirname(controlRoot);
  if (path.dirname(configRoot) !== baseRoot || path.dirname(path.dirname(releaseRoot)) !== baseRoot) {
    throw new ValidationError("config, control, and runtime roots must share one fixed base directory");
  }
  const executablePaths = {
    git: absolute(executables.git, "executables.git"),
    npm: absolute(executables.npm, "executables.npm"),
    node: absolute(executables.node, "executables.node"),
    launchctl: absolute(executables.launchctl, "executables.launchctl"),
    gh: absolute(executables.gh, "executables.gh"),
    herdr: absolute(executables.herdr, "executables.herdr"),
  };
  const fixedChecks = ["Verify dispatcher", "Verify sources/slack", "Verify updater"];
  const requiredChecks = value.required_checks;
  if (!Array.isArray(requiredChecks) || requiredChecks.length !== fixedChecks.length ||
    !fixedChecks.every((check) => requiredChecks.includes(check))) {
    throw new ValidationError("required_checks must contain all fixed Dona CI check names");
  }
  if (typeof value.require_verified_signature !== "boolean") throw new ValidationError("require_verified_signature must be boolean");
  return {
    schema_version: 1,
    policy_version: value.policy_version,
    repository: "hiragram/dona",
    canonical_remote: value.canonical_remote,
    default_branch: "main",
    control_root: controlRoot,
    config_root: configRoot,
    release_root: releaseRoot,
    current_pointer: currentPointer,
    previous_pointer: previousPointer,
    dispatcher_socket: absolute(value.dispatcher_socket, "dispatcher_socket"),
    slack_socket: absolute(value.slack_socket, "slack_socket"),
    dispatcher_internal_token_file: absolute(value.dispatcher_internal_token_file, "dispatcher_internal_token_file"),
    main_agent: {
      session: "dona",
      name: "dona-main",
      minimum_herdr_version: mainAgent.minimum_herdr_version,
    },
    launchd: {
      dispatcher_label: typeof launchd.dispatcher_label === "string" ? launchd.dispatcher_label : "",
      slack_label: typeof launchd.slack_label === "string" ? launchd.slack_label : "",
    },
    executables: executablePaths,
    timeouts: {
      command_ms: integer(timeouts.command_ms, "timeouts.command_ms"),
      health_ms: integer(timeouts.health_ms, "timeouts.health_ms"),
      drain_ms: integer(timeouts.drain_ms, "timeouts.drain_ms"),
      agent_drain_ms: integer(timeouts.agent_drain_ms, "timeouts.agent_drain_ms"),
      agent_exit_ms: integer(timeouts.agent_exit_ms, "timeouts.agent_exit_ms"),
      agent_start_ms: integer(timeouts.agent_start_ms, "timeouts.agent_start_ms"),
      reconcile_ms: integer(timeouts.reconcile_ms, "timeouts.reconcile_ms"),
      lease_ms: integer(timeouts.lease_ms, "timeouts.lease_ms"),
    },
    output_limit_bytes: integer(value.output_limit_bytes, "output_limit_bytes", 1_024),
    disk_floor_bytes: integer(value.disk_floor_bytes, "disk_floor_bytes", 0),
    retain_successful: integer(value.retain_successful, "retain_successful"),
    required_checks: [...requiredChecks] as string[],
    require_verified_signature: value.require_verified_signature,
    compatibility: compatibility(value.compatibility),
  };
}

export function loadPolicy(policyPath: string): UpdatePolicy {
  const stats = fs.lstatSync(policyPath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new ValidationError("policy must be a regular non-symlink file");
  if ((stats.mode & 0o077) !== 0) throw new ValidationError("policy must not be accessible by group or world");
  return parsePolicy(JSON.parse(fs.readFileSync(policyPath, "utf8")));
}

export function assertExactSha(value: string): void {
  fullSha(value);
}
