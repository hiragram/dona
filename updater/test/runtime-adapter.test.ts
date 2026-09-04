import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";

import { RealRuntime } from "../src/adapters.js";
import { ProcessRunner, type RunOptions } from "../src/process.js";
import type { CommandResult } from "../src/types.js";
import { removeTree, targetSha, tempPolicy } from "./helpers.js";

const ok: CommandResult = { exit_code: 0, stdout: "", stderr: "", timed_out: false, output_truncated: false };

class RecordingRunner {
  readonly calls: Array<{ executable: string; args: readonly string[]; options: RunOptions }> = [];
  async run(executable: string, args: readonly string[], options: RunOptions): Promise<CommandResult> {
    this.calls.push({ executable, args, options });
    return ok;
  }
}

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
  const requests: unknown[] = [];
  const dispatcher = await listen(policy.dispatcher_socket, "dispatcher", requests, 1);
  const slack = await listen(policy.slack_socket, "slack_adapter", requests);
  const recording = new RecordingRunner();
  const runtime = new RealRuntime(policy, recording as unknown as ProcessRunner);
  try {
    assert.equal((await runtime.quiesceSlack("upd_01m1es03xy5cf8d9pm5cwx4srv", targetSha)).drained, true);
    assert.equal((await runtime.quiesceDispatcher("upd_01m1es03xy5cf8d9pm5cwx4srv", targetSha)).drained, true);
    assert.equal((await runtime.dispatcherHealth()).build_sha, targetSha);
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
      [policy.executables.launchctl, "kill", "SIGTERM", `gui/${uid}/${policy.launchd.dispatcher_label}`],
      [policy.executables.launchctl, "kickstart", "-k", `gui/${uid}/${policy.launchd.dispatcher_label}`],
      [policy.executables.launchctl, "kickstart", "-k", `gui/${uid}/${policy.launchd.slack_label}`],
    ]);
    assert.equal(Object.values(recording.calls[0]!.options.env ?? {}).some((value) => /token|secret/i.test(value)), false);
  } finally {
    await Promise.all([new Promise<void>((resolve) => dispatcher.close(() => resolve())), new Promise<void>((resolve) => slack.close(() => resolve()))]);
    await removeTree(root);
  }
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
  const dispatcherMcpEnvironment = `mcp_servers.dona_dispatcher.env = { "DOTENV_CONFIG_PATH" = ${JSON.stringify(path.join(canonicalConfigRoot, "dispatcher.env"))}, "DONA_RELEASE_MANIFEST_PATH" = ${JSON.stringify(path.join(policy.current_pointer, "release-manifest.json"))}, "DONA_UPDATER_SOCKET_PATH" = ${JSON.stringify(path.join(policy.control_root, "updater.sock"))}, "DONA_UPDATE_INTERNAL_TOKEN_PATH" = ${JSON.stringify(policy.dispatcher_internal_token_file)}, "DONA_HERDR_PATH" = ${JSON.stringify(policy.executables.herdr)}, "DONA_GH_PATH" = ${JSON.stringify(policy.executables.gh)}, "DONA_GIT_PATH" = ${JSON.stringify(policy.executables.git)} }`;
  const slackMcpEnvironment = `mcp_servers.dona_slack.env = { "DOTENV_CONFIG_PATH" = ${JSON.stringify(path.join(canonicalConfigRoot, "slack.env"))} }`;
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
