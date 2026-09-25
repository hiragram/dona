import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";

import { RealRuntime } from "../src/adapters.js";
import { ProcessRunner, type RunOptions } from "../src/process.js";
import type { CommandResult } from "../src/types.js";
import { removeTree, targetSha, tempPolicy } from "./helpers.js";

const ok: CommandResult = { exit_code: 0, stdout: "", stderr: "", timed_out: false, output_truncated: false };

class RecordingRunner {
  readonly calls: Array<{ executable: string; args: readonly string[]; options: RunOptions }> = [];
  result: CommandResult = ok;
  async run(executable: string, args: readonly string[], options: RunOptions): Promise<CommandResult> {
    this.calls.push({ executable, args, options });
    return this.result;
  }
}

test("Dispatcher registration read distinguishes bootout from an ambiguous launchctl failure", async () => {
  const { root, policy } = await tempPolicy();
  try {
    const recording = new RecordingRunner();
    const runtime = new RealRuntime(policy, recording as unknown as ProcessRunner);
    assert.equal(await runtime.dispatcherRegistered(), true);
    recording.result = { ...ok, exit_code: 113, stderr: "Could not find service" };
    assert.equal(await runtime.dispatcherRegistered(), false);
    await runtime.startDispatcher();
    recording.result = { ...ok, exit_code: 1, stderr: "permission denied" };
    await assert.rejects(runtime.dispatcherRegistered(), /dispatcher_registration_unverified/);
    const uid = process.getuid!();
    assert.deepEqual(recording.calls.map(call => call.args), [
      ["print", `gui/${uid}/${policy.launchd.dispatcher_label}`],
      ["print", `gui/${uid}/${policy.launchd.dispatcher_label}`],
      ["print", `gui/${uid}/${policy.launchd.dispatcher_label}`],
      ["bootstrap", `gui/${uid}`, path.join(os.homedir(), "Library/LaunchAgents/dev.dona.dispatcher.plist")],
      ["print", `gui/${uid}/${policy.launchd.dispatcher_label}`],
    ]);
  } finally { await removeTree(root); }
});

function agentResponse(cwd: string, sessionId: string | null, interactiveReady = true): string {
  return JSON.stringify({
    result: {
      type: "agent_info",
      agent: {
        terminal_id: "term-1",
        agent_status: "idle",
        workspace_id: "w1",
        tab_id: "w1:t1",
        pane_id: "w1:p1",
        focused: false,
        revision: 1,
        agent: "codex",
        name: "dona-main",
        cwd,
        foreground_cwd: cwd,
        interactive_ready: interactiveReady,
        launch_pending: false,
        ...(sessionId ? { agent_session: { source: "codex", agent: "codex", kind: "id", value: sessionId } } : {}),
      },
    },
  });
}

function paneResponse(cwd: string): string {
  return JSON.stringify({
    result: {
      type: "pane_info",
      pane: {
        terminal_id: "term-1",
        agent_status: "unknown",
        workspace_id: "w1",
        tab_id: "w1:t1",
        pane_id: "w1:p1",
        cwd,
        foreground_cwd: cwd,
      },
    },
  });
}

class AgentRunner extends RecordingRunner {
  running = true;
  cwd: string;
  sessionId: string | null = "session-old";
  omitSessionOnStart = false;
  interactiveReady = true;
  becomeReadyOnNextGet = false;
  ignoreCwdChange = false;

  constructor(cwd: string) {
    super();
    this.cwd = cwd;
  }

  override async run(executable: string, args: readonly string[], options: RunOptions): Promise<CommandResult> {
    this.calls.push({ executable, args, options });
    if (args[0] === "--version") return { ...ok, stdout: "herdr 0.8.2\n" };
    if (args.includes("wait")) return { ...ok, stdout: agentResponse(this.cwd, this.sessionId, this.interactiveReady) };
    if (args.includes("send-keys")) {
      this.running = false;
      return { ...ok, stdout: JSON.stringify({ result: { type: "ok" } }) };
    }
    if (args.includes("pane") && args.includes("run")) {
      const command = String(args.at(-1));
      const match = /^cd -- '(.*)'$/.exec(command);
      if (!match) return { ...ok, exit_code: 1, stderr: JSON.stringify({ error: { code: "invalid_request" } }) };
      if (!this.ignoreCwdChange) this.cwd = match[1]!.replaceAll(`'\\''`, "'");
      return { ...ok, stdout: JSON.stringify({ result: { type: "ok" } }) };
    }
    if (args.includes("pane") && args.includes("get")) {
      return { ...ok, stdout: paneResponse(this.cwd) };
    }
    if (args.includes("get")) {
      if (this.becomeReadyOnNextGet) {
        this.becomeReadyOnNextGet = false;
        this.interactiveReady = true;
      }
      return this.running
        ? { ...ok, stdout: agentResponse(this.cwd, this.sessionId, this.interactiveReady) }
        : { ...ok, exit_code: 1, stderr: JSON.stringify({ error: { code: "agent_not_found", message: "missing" } }) };
    }
    if (args.includes("start")) {
      this.sessionId = this.omitSessionOnStart ? null : "session-new";
      this.running = true;
      return { ...ok, stdout: agentResponse(this.cwd, this.sessionId, this.interactiveReady) };
    }
    return ok;
  }
}

async function listen(
  socketPath: string,
  service: "dispatcher" | "slack_adapter",
  requests: unknown[],
  pendingDrainResponses = 0,
): Promise<http.Server> {
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  let remainingPending = pendingDrainResponses;
  const server = http.createServer(async (request, response) => {
    if (request.url === "/health/version") {
      const body = JSON.stringify({
        schema_version: 1,
        status: "ready",
        service,
        build_sha: targetSha,
        protocol: 1,
        app_schema: 2,
        app_schema_read_min: 2,
        app_schema_read_max: 3,
        app_schema_write: 2,
        config: 1,
        ...(service === "slack_adapter" ? { workspaces_ready: true } : {}),
      });
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    }
    const drained = remainingPending === 0;
    remainingPending = Math.max(0, remainingPending - 1);
    const body = JSON.stringify({
      schema_version: 1,
      protocol: 1,
      service,
      quiescing: true,
      drained,
      in_flight: drained ? 0 : 1,
      unsafe_states: drained ? [] : ["events.waiting_agent:1"],
    });
    response.writeHead(drained ? 200 : 202, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

test("RealRuntime uses typed UDS handshakes and fixed launchctl argv without live process access", async () => {
  const { root, policy } = await tempPolicy();
  await fs.mkdir(policy.config_root, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(policy.config_root, "dispatcher.env"), "", { mode: 0o600 });
  const dispatcherDatabasePath = path.join(root, "Dona", "dona.sqlite3");
  const dispatcherDatabase = new Database(dispatcherDatabasePath);
  dispatcherDatabase.exec("CREATE TABLE jobs (status TEXT NOT NULL, steer_state TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, herdr_workspace_id TEXT, last_error_code TEXT, dispatch_started_at TEXT, prompt_accepted_at TEXT)");
  dispatcherDatabase.exec("CREATE TABLE legacy_job_agents_to_stop (job_id TEXT, stopped_at TEXT)");
  dispatcherDatabase.exec("ALTER TABLE jobs ADD COLUMN job_id TEXT");
  dispatcherDatabase.prepare("INSERT INTO jobs (status,job_id) VALUES ('completed','old-terminal')").run();
  dispatcherDatabase.prepare("INSERT INTO legacy_job_agents_to_stop VALUES ('old-terminal','2026-09-25T00:00:00Z')").run();
  dispatcherDatabase.close();
  await fs.chmod(dispatcherDatabasePath, 0o600);
  const requests: unknown[] = [];
  const dispatcher = await listen(policy.dispatcher_socket, "dispatcher", requests, 1);
  const slack = await listen(policy.slack_socket, "slack_adapter", requests);
  const recording = new RecordingRunner();
  const runtime = new RealRuntime(policy, recording as unknown as ProcessRunner);
  try {
    assert.equal((await runtime.quiesceSlack("upd_01m1es03xy5cf8d9pm5cwx4srv", targetSha)).drained, true);
    assert.equal((await runtime.quiesceDispatcher("upd_01m1es03xy5cf8d9pm5cwx4srv", targetSha)).drained, true);
    const dispatcherHealth = await runtime.dispatcherHealth();
    assert.equal(dispatcherHealth.build_sha, targetSha);
    assert.equal(dispatcherHealth.app_schema_read_max, 3);
    assert.equal((await runtime.slackHealth()).workspaces_ready, true);
    await runtime.stopSlack();
    await runtime.stopDispatcher();
    await runtime.startDispatcher();
    await runtime.startSlack();
    assert.deepEqual(requests, [
      { schema_version: 1, protocol: 1, operation_id: "upd_01m1es03xy5cf8d9pm5cwx4srv", target_sha: targetSha },
      { schema_version: 1, protocol: 1, operation_id: "upd_01m1es03xy5cf8d9pm5cwx4srv", target_sha: targetSha },
    ]);
    const uid = process.getuid!();
    assert.deepEqual(recording.calls.map(({ executable, args }) => [executable, ...args]), [
      [policy.executables.launchctl, "kill", "SIGTERM", `gui/${uid}/${policy.launchd.slack_label}`],
      [policy.executables.launchctl, "bootout", `gui/${uid}/${policy.launchd.dispatcher_label}`],
      [policy.executables.launchctl, "print", `gui/${uid}/${policy.launchd.dispatcher_label}`],
      [policy.executables.launchctl, "kickstart", "-k", `gui/${uid}/${policy.launchd.dispatcher_label}`],
      [policy.executables.launchctl, "kickstart", "-k", `gui/${uid}/${policy.launchd.slack_label}`],
    ]);
    assert.equal(Object.values(recording.calls[0]!.options.env ?? {}).some((value) => /token|secret/i.test(value)), false);
  } finally {
    await Promise.all([new Promise<void>((resolve) => dispatcher.close(() => resolve())), new Promise<void>((resolve) => slack.close(() => resolve()))]);
    await removeTree(root);
  }
});

test("RealRuntime refuses a legacy drained response while a durable worker remains active", async () => {
  const { root, policy } = await tempPolicy();
  await fs.mkdir(policy.config_root, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(policy.config_root, "dispatcher.env"), "", { mode: 0o600 });
  const databasePath = path.join(root, "Dona", "dona.sqlite3");
  const database = new Database(databasePath);
  database.exec("CREATE TABLE jobs (status TEXT NOT NULL, steer_state TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, herdr_workspace_id TEXT, last_error_code TEXT, dispatch_started_at TEXT, prompt_accepted_at TEXT)");
  database.prepare("INSERT INTO jobs (status,herdr_workspace_id) VALUES ('running','private-agent')").run();
  database.prepare("INSERT INTO jobs (status,last_error_code) VALUES ('retryable_failed','stale_preparing')").run();
  database.close();
  await fs.chmod(databasePath, 0o600);
  const requests: unknown[] = [];
  const dispatcher = await listen(policy.dispatcher_socket, "dispatcher", requests);
  const runtime = new RealRuntime(policy, new RecordingRunner() as unknown as ProcessRunner);
  try {
    const snapshot = await runtime.quiesceDispatcher("upd_01m1es03xy5cf8d9pm5cwx4srv", targetSha);
    assert.equal(snapshot.drained, false);
    assert.deepEqual(snapshot.unsafe_states, ["jobs.handoff_unavailable:2"]);
    assert.equal(JSON.stringify(snapshot).includes("private-agent"), false);
  } finally {
    await new Promise<void>((resolve) => dispatcher.close(() => resolve()));
    await removeTree(root);
  }
});

test("RealRuntime counts terminal legacy agents until durable stop", async () => {
  const { root, policy } = await tempPolicy();
  await fs.mkdir(policy.config_root, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(policy.config_root, "dispatcher.env"), "", { mode: 0o600 });
  const databasePath = path.join(root, "Dona", "dona.sqlite3");
  const database = new Database(databasePath);
  database.exec("CREATE TABLE jobs (job_id TEXT, status TEXT NOT NULL, steer_state TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, herdr_workspace_id TEXT, last_error_code TEXT, dispatch_started_at TEXT, prompt_accepted_at TEXT)");
  database.exec("CREATE TABLE legacy_job_agents_to_stop (job_id TEXT, stopped_at TEXT)");
  database.prepare("INSERT INTO jobs (job_id,status) VALUES ('legacy-terminal','failed')").run();
  database.prepare("INSERT INTO legacy_job_agents_to_stop VALUES ('legacy-terminal',NULL)").run();
  database.close();
  await fs.chmod(databasePath, 0o600);
  const runtime = new RealRuntime(policy, new RecordingRunner() as unknown as ProcessRunner);
  try {
    assert.equal((await runtime.workerSafety()).active_worker_count, 1);
    const stopped = new Database(databasePath);
    stopped.prepare("UPDATE legacy_job_agents_to_stop SET stopped_at='2026-09-25T00:00:00Z'").run();
    stopped.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 0);
  } finally { await removeTree(root); }
});

test("RealRuntime counts a reconciled terminal schedule worker without stop proof", async () => {
  const { root, policy } = await tempPolicy();
  await fs.mkdir(policy.config_root, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(policy.config_root, "dispatcher.env"), "", { mode: 0o600 });
  const databasePath = path.join(root, "Dona", "dona.sqlite3");
  const database = new Database(databasePath);
  database.exec("CREATE TABLE jobs (status TEXT NOT NULL, steer_state TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, herdr_workspace_id TEXT, last_error_code TEXT, dispatch_started_at TEXT, prompt_accepted_at TEXT)");
  for (const code of ["schedule_reconcile_worker_unverified", "terminal_steer_worker_unverified",
    "cancel_worker_unverified"]) {
    database.prepare("INSERT INTO jobs (status,last_error_code) VALUES ('failed',?)").run(code);
  }
  database.close();
  await fs.chmod(databasePath, 0o600);
  const runtime = new RealRuntime(policy, new RecordingRunner() as unknown as ProcessRunner);
  try {
    assert.equal((await runtime.workerSafety()).active_worker_count, 3);
  } finally { await removeTree(root); }
});

test("RealRuntime distinguishes unresolved steer from definite retryable agent absence", async () => {
  const { root, policy } = await tempPolicy();
  await fs.mkdir(policy.config_root, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(policy.config_root, "dispatcher.env"), "", { mode: 0o600 });
  const databasePath = path.join(root, "Dona", "dona.sqlite3");
  const database = new Database(databasePath);
  database.exec("CREATE TABLE jobs (status TEXT NOT NULL, steer_state TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, herdr_workspace_id TEXT, last_error_code TEXT, dispatch_started_at TEXT, prompt_accepted_at TEXT)");
  database.prepare("INSERT INTO jobs (status,steer_state) VALUES ('completed','dispatching')").run();
  database.close();
  await fs.chmod(databasePath, 0o600);
  const runtime = new RealRuntime(policy, new RecordingRunner() as unknown as ProcessRunner);
  try {
    assert.equal((await runtime.workerSafety()).active_worker_count, 1);
    const settled = new Database(databasePath);
    settled.prepare("UPDATE jobs SET steer_state='accepted'").run();
    settled.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 1);
    const retryable = new Database(databasePath);
    retryable.prepare("UPDATE jobs SET status='retryable_failed',herdr_workspace_id='recorded',last_error_code='agent_not_found'").run();
    retryable.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 0);
    const uncertain = new Database(databasePath);
    uncertain.prepare("UPDATE jobs SET last_error_code='stale_preparing'").run();
    uncertain.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 1);
    const terminalCancel = new Database(databasePath);
    terminalCancel.prepare("UPDATE jobs SET status='completed',steer_state=NULL,last_error_code=NULL,herdr_workspace_id='recorded'").run();
    terminalCancel.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 1);
    const stopped = new Database(databasePath);
    stopped.prepare("UPDATE jobs SET last_error_code='agent_not_found'").run();
    stopped.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 0);
  } finally { await removeTree(root); }
});

test("RealRuntime excludes only a proven pre-prepare result collision", async () => {
  const { root, policy } = await tempPolicy();
  await fs.mkdir(policy.config_root, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(policy.config_root, "dispatcher.env"), "", { mode: 0o600 });
  const databasePath = path.join(root, "Dona", "dona.sqlite3");
  const database = new Database(databasePath);
  database.exec("CREATE TABLE jobs (job_id TEXT, status TEXT NOT NULL, steer_state TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, herdr_workspace_id TEXT, last_error_code TEXT, dispatch_started_at TEXT, prompt_accepted_at TEXT)");
  database.exec("CREATE TABLE legacy_job_agents_to_stop (job_id TEXT, stopped_at TEXT)");
  database.prepare("INSERT INTO jobs (job_id,status,last_error_code) VALUES ('collision-job','needs_review','result_path_exists')").run();
  database.close();
  await fs.chmod(databasePath, 0o600);
  const runtime = new RealRuntime(policy, new RecordingRunner() as unknown as ProcessRunner);
  try {
    assert.equal((await runtime.workerSafety()).safe, true);
    const retried = new Database(databasePath);
    retried.prepare("UPDATE jobs SET attempt_count=1").run();
    retried.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 1);
    const firstAttempt = new Database(databasePath);
    firstAttempt.prepare("UPDATE jobs SET attempt_count=0").run();
    firstAttempt.close();
    const guarded = new Database(databasePath);
    guarded.prepare("UPDATE jobs SET herdr_workspace_id='possible-worker'").run();
    guarded.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 1);
    const stopped = new Database(databasePath);
    stopped.prepare("UPDATE jobs SET last_error_code='invalid_result_agent_stopped'").run();
    stopped.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 0);
    for (const code of ["agent_not_found", "agent_not_running", "steer_acceptance_unknown"]) {
      const state = new Database(databasePath);
      state.prepare("UPDATE jobs SET last_error_code=?").run(code);
      state.close();
      assert.equal((await runtime.workerSafety()).active_worker_count,
        code === "steer_acceptance_unknown" ? 1 : 0);
    }
    const legacy = new Database(databasePath);
    legacy.prepare("UPDATE jobs SET last_error_code='legacy_agent_sandbox_unknown'").run();
    legacy.prepare("INSERT INTO legacy_job_agents_to_stop VALUES ('collision-job',?)")
      .run(new Date().toISOString());
    legacy.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 0);
    const invalid = new Database(databasePath);
    invalid.prepare("UPDATE jobs SET last_error_code='invalid_result'").run();
    invalid.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 0);
  } finally {
    await removeTree(root);
  }
});

test("RealRuntime migrates only the owner-private Dispatcher database selected by dispatcher.env", async () => {
  const { root, policy } = await tempPolicy();
  const configuredDatabase = path.join(root, "custom", "dispatcher.sqlite3");
  await fs.mkdir(path.dirname(configuredDatabase), { recursive: true });
  await fs.mkdir(policy.config_root, { recursive: true, mode: 0o700 });
  const database = new Database(configuredDatabase);
  database.pragma("user_version = 2");
  database.close();
  await fs.chmod(configuredDatabase, 0o600);
  await fs.writeFile(path.join(policy.config_root, "dispatcher.env"), `DONA_DATABASE_PATH=${configuredDatabase} # custom path\n`, { mode: 0o600 });
  const recording = new RecordingRunner();
  const runtime = new RealRuntime(policy, recording as unknown as ProcessRunner);
  await runtime.migrateAppSchema("upd_01m1es03xy5cf8d9pm5cwx4srv", targetSha,
    { protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 3, app_schema_write: 2, rollback_safe: true },
    { protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 3, app_schema_write: 3, rollback_safe: true });
  assert.equal(recording.calls[0]?.args[1], configuredDatabase);
  assert.equal(recording.calls[0]?.args[2], path.join(
    policy.control_root, "schema-backups", "dispatcher-v2-to-v3", "dispatcher-v2.sqlite3",
  ));
  assert.equal(recording.calls[0]?.args[3], path.join(
    policy.control_root, "schema-backups", "dispatcher-v2-to-v3", "migration-receipt.json",
  ));
  recording.result = {
    ...ok,
    stdout: '{"schema_version":1,"user_version":2,"integrity_ok":true,"foreign_key_violations":0}\n',
  };
  assert.deepEqual(await runtime.appSchemaState(), {
    user_version: 2,
    integrity_ok: true,
    foreign_key_violations: 0,
  });
  assert.equal(path.basename(recording.calls[1]!.args[0]!), "app-schema-inspect-cli.js");
  assert.equal(recording.calls[1]!.args[1], configuredDatabase);
  await fs.chmod(configuredDatabase, 0o644);
  assert.throws(() => runtime.migrateAppSchema("upd_01m1es03xy5cf8d9pm5cwx4srv", targetSha,
    { protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 3, app_schema_write: 2, rollback_safe: true },
    { protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 3, app_schema_write: 3, rollback_safe: true }), /database_identity_invalid/);
  await fs.chmod(configuredDatabase, 0o600);
  await fs.writeFile(path.join(policy.config_root, "dispatcher.env"), "DONA_DATABASE_PATH=relative/dispatcher.sqlite3\n", { mode: 0o600 });
  assert.throws(() => runtime.migrateAppSchema("upd_01m1es03xy5cf8d9pm5cwx4srv", targetSha,
    { protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 3, app_schema_write: 2, rollback_safe: true },
    { protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 3, app_schema_write: 3, rollback_safe: true }), /path_must_be_absolute/);
  await removeTree(root);
});

test("RealRuntime restarts the exact idle dona-main pane from the immutable target release", async () => {
  const { root, policy } = await tempPolicy();
  const currentRelease = path.join(policy.release_root, "1".repeat(40));
  const targetRelease = path.join(policy.release_root, targetSha);
  await fs.mkdir(path.join(targetRelease, ".codex"), { recursive: true });
  await fs.mkdir(policy.config_root, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(targetRelease, ".codex", "config.toml"), "[mcp_servers.test]\ncommand = \"true\"\n");
  await fs.writeFile(path.join(policy.config_root, "dispatcher.env"), "", { mode: 0o600 });
  await fs.writeFile(path.join(policy.config_root, "slack.env"), "SLACK_WORKSPACES=test\n", { mode: 0o600 });
  const canonicalTargetRelease = await fs.realpath(targetRelease);
  const canonicalConfigRoot = await fs.realpath(policy.config_root);
  const dispatcherMcpEnvironment = `mcp_servers.dona_dispatcher.env = { "DOTENV_CONFIG_PATH" = ${JSON.stringify(path.join(canonicalConfigRoot, "dispatcher.env"))}, "DONA_RELEASE_MANIFEST_PATH" = ${JSON.stringify(path.join(policy.current_pointer, "release-manifest.json"))}, "DONA_UPDATER_SOCKET_PATH" = ${JSON.stringify(path.join(policy.control_root, "updater.sock"))}, "DONA_UPDATE_INTERNAL_TOKEN_PATH" = ${JSON.stringify(policy.dispatcher_internal_token_file)}, "DONA_HERDR_PATH" = ${JSON.stringify(policy.executables.herdr)}, "DONA_CODEX_PATH" = ${JSON.stringify(policy.executables.codex)}, "DONA_GH_PATH" = ${JSON.stringify(policy.executables.gh)}, "DONA_GIT_PATH" = ${JSON.stringify(policy.executables.git)} }`;
  const slackMcpEnvironment = `mcp_servers.dona_slack.env = { "DOTENV_CONFIG_PATH" = ${JSON.stringify(path.join(canonicalConfigRoot, "slack.env"))}, "DONA_UPDATE_INTERNAL_TOKEN_PATH" = ${JSON.stringify(policy.dispatcher_internal_token_file)} }`;
  const runner = new AgentRunner(currentRelease);
  const runtime = new RealRuntime(policy, runner as unknown as ProcessRunner);
  try {
    runner.interactiveReady = false;
    const idle = await runtime.waitForMainAgentIdle();
    assert.equal(idle.status, "idle");
    assert.equal(idle.session_id, "session-old");
    assert.equal(idle.interactive_ready, false);
    runner.sessionId = "session-replaced";
    assert.equal((await runtime.stopMainAgent(idle)).outcome, "rejected");
    runner.sessionId = "session-old";
    assert.deepEqual(await runtime.stopMainAgent(idle), { outcome: "stopped", pane_id: "w1:p1", error_code: null });
    runner.interactiveReady = true;
    const started = await runtime.startMainAgent("w1:p1", targetRelease);
    assert.equal(started.outcome, "started");
    assert.equal(started.observation.matches_release, true);
    assert.equal(started.observation.session_id, "session-new");
    assert.deepEqual(runner.calls.map(({ executable, args }) => [executable, ...args]), [
      [policy.executables.herdr, "--version"],
      [policy.executables.herdr, "--session", "dona", "agent", "wait", "dona-main", "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", "100"],
      [policy.executables.herdr, "--session", "dona", "agent", "get", "dona-main"],
      [policy.executables.herdr, "--session", "dona", "agent", "get", "dona-main"],
      [policy.executables.herdr, "--session", "dona", "agent", "send-keys", "w1:p1", "ctrl+c"],
      [policy.executables.herdr, "--session", "dona", "agent", "get", "w1:p1"],
      [policy.executables.herdr, "--session", "dona", "agent", "get", "w1:p1"],
      [policy.executables.herdr, "--session", "dona", "pane", "run", "w1:p1", `cd -- '${canonicalTargetRelease}'`],
      [policy.executables.herdr, "--session", "dona", "pane", "get", "w1:p1"],
      [
        policy.executables.herdr, "--session", "dona", "agent", "start", "dona-main", "--kind", "codex",
        "--pane", "w1:p1", "--timeout", "100", "--", "-C", canonicalTargetRelease, "-c",
        `projects = { ${JSON.stringify(canonicalTargetRelease)} = { trust_level = "trusted" } }`,
        "-c", dispatcherMcpEnvironment, "-c", slackMcpEnvironment,
        "-c", "check_for_update_on_startup=false",
        "起動確認です。外部操作、ファイル変更、プロセス操作は行わず、READYとだけ返してください。",
      ],
    ]);
    runner.running = false;
    runner.cwd = currentRelease;
    runner.sessionId = "session-old";
    runner.interactiveReady = false;
    runner.becomeReadyOnNextGet = true;
    const delayedReady = await runtime.startMainAgent("w1:p1", targetRelease, "session-old");
    assert.equal(delayedReady.outcome, "started");
    assert.equal(delayedReady.observation.interactive_ready, true);
    runner.running = false;
    runner.cwd = currentRelease;
    runner.omitSessionOnStart = true;
    assert.equal((await runtime.startMainAgent("w1:p1", targetRelease)).outcome, "accepted_unknown");
    const busyCallCount = runner.calls.length;
    const busy = await runtime.startMainAgent("w1:p1", targetRelease);
    assert.equal(busy.outcome, "rejected");
    assert.equal(busy.error_code, "agent_pane_busy");
    assert.equal(runner.calls.length, busyCallCount + 1);
    assert.deepEqual(runner.calls.at(-1)!.args, ["--session", "dona", "agent", "get", "w1:p1"]);
    runner.running = false;
    runner.cwd = currentRelease;
    runner.ignoreCwdChange = true;
    const unchangedCwdCallCount = runner.calls.length;
    const unchangedCwd = await runtime.startMainAgent("w1:p1", targetRelease);
    assert.equal(unchangedCwd.outcome, "accepted_unknown");
    assert.equal(unchangedCwd.error_code, "main_agent_pane_cwd_change_unknown");
    assert.equal(runner.calls.slice(unchangedCwdCallCount).some(({ args }) => args.includes("start")), false);
    runner.ignoreCwdChange = false;
    const callCount = runner.calls.length;
    await fs.chmod(path.join(policy.config_root, "slack.env"), 0o644);
    assert.equal((await runtime.startMainAgent("w1:p1", targetRelease)).outcome, "rejected");
    assert.equal(runner.calls.length, callCount);
    assert.equal(Object.values(runner.calls.at(-1)!.options.env ?? {}).some((value) => /token|secret/i.test(value)), false);
  } finally {
    await removeTree(root);
  }
});
