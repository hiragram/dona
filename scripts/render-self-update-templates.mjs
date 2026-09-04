#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repository = path.dirname(scriptDir);
const destination = process.argv[2];
const sha = process.argv[3];
if (!destination || !path.isAbsolute(destination) || !/^[0-9a-f]{40}$/.test(sha ?? "")) {
  throw new Error("Usage: render-self-update-templates.mjs <absolute-destination> <full-sha>");
}

const command = (name, fallback) => {
  try {
    return fs.realpathSync(execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim());
  } catch {
    if (fallback && fs.existsSync(fallback)) return fs.realpathSync(fallback);
    throw new Error(`Required executable not found: ${name}`);
  }
};
const base = path.join(os.homedir(), "Library", "Application Support", "Dona");
const values = {
  NODE: fs.realpathSync(process.execPath),
  NPM: command("npm"),
  GH: command("gh"),
  GIT: command("git", "/usr/bin/git"),
  HERDR: command("herdr"),
  CONTROL_ROOT: path.join(base, "update-control"),
  RUNTIME_ROOT: path.join(base, "runtime"),
  CONFIG_ROOT: path.join(base, "config"),
  LOG_ROOT: path.join(base, "logs"),
  INSTALL_SHA: sha,
};
const compatibilityFile = JSON.parse(fs.readFileSync(
  path.join(repository, "config", "release-compatibility.json"),
  "utf8",
));
if (compatibilityFile.schema_version !== 1) throw new Error("Unsupported release compatibility schema");
const { schema_version: _compatibilitySchema, ...compatibility } = compatibilityFile;

const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
for (const name of ["dev.dona.updater", "dev.dona.dispatcher", "dev.dona.slack-adapter"]) {
  let body = fs.readFileSync(path.join(repository, "launchd", `${name}.plist.in`), "utf8");
  for (const [key, value] of Object.entries(values)) body = body.replaceAll(`__${key}__`, xml(value));
  if (/__[A-Z_]+__/.test(body)) throw new Error(`Unresolved template token in ${name}`);
  fs.writeFileSync(path.join(destination, `${name}.plist`), body, { mode: 0o600 });
}

const policy = {
  schema_version: 1,
  policy_version: "2026-09-03.2",
  repository: "hiragram/dona",
  canonical_remote: "https://github.com/hiragram/dona.git",
  default_branch: "main",
  control_root: values.CONTROL_ROOT,
  config_root: values.CONFIG_ROOT,
  release_root: path.join(values.RUNTIME_ROOT, "releases"),
  current_pointer: path.join(values.RUNTIME_ROOT, "current"),
  previous_pointer: path.join(values.RUNTIME_ROOT, "previous"),
  dispatcher_socket: path.join(base, "run", "dispatcher.sock"),
  slack_socket: path.join(base, "run", "slack-adapter.sock"),
  dispatcher_internal_token_file: path.join(values.CONTROL_ROOT, "dispatcher.token"),
  main_agent: { session: "dona", name: "dona-main", minimum_herdr_version: "0.8.2" },
  launchd: { dispatcher_label: "dev.dona.dispatcher", slack_label: "dev.dona.slack-adapter" },
  executables: {
    git: values.GIT, npm: values.NPM, node: values.NODE, launchctl: "/bin/launchctl", gh: values.GH, herdr: values.HERDR,
  },
  timeouts: {
    command_ms: 900000, health_ms: 30000, drain_ms: 30000, agent_drain_ms: 900000,
    agent_exit_ms: 30000, agent_start_ms: 60000, reconcile_ms: 300000, lease_ms: 60000,
  },
  output_limit_bytes: 1048576,
  disk_floor_bytes: 2147483648,
  retain_successful: 2,
  required_checks: ["Verify dispatcher", "Verify sources/slack", "Verify updater"],
  require_verified_signature: false,
  compatibility,
};
fs.writeFileSync(path.join(destination, "policy.json"), `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
