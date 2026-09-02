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

async function listen(socketPath: string, service: "dispatcher" | "slack_adapter", requests: unknown[]): Promise<http.Server> {
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
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
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const body = JSON.stringify({
      schema_version: 1,
      protocol: 1,
      service,
      quiescing: true,
      drained: true,
      in_flight: 0,
      unsafe_states: [],
    });
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
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
  const dispatcher = await listen(policy.dispatcher_socket, "dispatcher", requests);
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
      [policy.executables.launchctl, "kickstart", `gui/${uid}/${policy.launchd.dispatcher_label}`],
      [policy.executables.launchctl, "kickstart", `gui/${uid}/${policy.launchd.slack_label}`],
    ]);
    assert.equal(Object.values(recording.calls[0]!.options.env ?? {}).some((value) => /token|secret/i.test(value)), false);
  } finally {
    await Promise.all([new Promise<void>((resolve) => dispatcher.close(() => resolve())), new Promise<void>((resolve) => slack.close(() => resolve()))]);
    await removeTree(root);
  }
});
