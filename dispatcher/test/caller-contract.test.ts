import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DispatcherApi } from "../src/api.js";
import { DispatcherApiClient, DispatcherClientError } from "../src/client.js";
import { DispatcherDatabase } from "../src/database.js";
import { buildJobPrompt } from "../src/job-prompt.js";
import { JobSupervisor } from "../src/job-supervisor.js";
import { createDispatcherMcpServer } from "../src/mcp/server.js";
import { eventEnvelope, tempConfig } from "./helpers.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

async function fixture() {
  const { root, config } = await tempConfig();
  const database = new DispatcherDatabase(config.databasePath);
  const forbidden = async (): Promise<never> => { throw new Error("runtime must not be invoked"); };
  const supervisor = new JobSupervisor(database, {
    prepare: forbidden, get: forbidden, prompt: forbidden, wait: forbidden, cancel: forbidden,
  }, config, logger, () => {});
  const api = new DispatcherApi(database, { isRunning: () => true, wake() {} }, supervisor, config, logger);
  await api.start();
  const uds = new DispatcherApiClient(config.socketPath);
  const server = createDispatcherMcpServer(uds, logger);
  const client = new Client({ name: "caller-contract", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const source = database.enqueue(eventEnvelope("source")).row.event_id;
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: result.isError, data: result.structuredContent as Record<string, any> };
  };
  return { database, config, uds, source, call, client, async close() {
    await client.close(); await server.close(); await api.stop(); database.close();
    await fs.rm(root, { recursive: true, force: true });
  } };
}

for (const rejection of ["validation", "conflict", "limit", "timeout"] as const) {
  test(`MCP preserves first success and reconciles second ${rejection} without cancellation`, async () => {
    const f = await fixture();
    try {
      const input = { source_event_id: f.source, job_key: "first", objective: "secret /private/path https://private.invalid/token", workspace_kind: "scratch" };
      const first = await f.call("delegate_job", input);
      assert.equal(first.error, undefined);
      assert.deepEqual(first.data.action, { tool: "delegate_job", source_event_id: f.source, job_key: "first", job_id: first.data.job.job_id, outcome: "created" });
      assert.doesNotMatch(JSON.stringify(first.data), /private|secret|objective|workspace_path|result_path|agent_name/);
      const reused = await f.call("delegate_job", input);
      assert.equal(reused.data.action.outcome, "reused");
      assert.equal(reused.data.action.job_id, first.data.action.job_id);
      let creates = 0;
      const originalCreate = f.uds.createJob.bind(f.uds);
      if (rejection === "limit") {
        for (let i = 1; i < 8; i++) await f.call("delegate_job", { ...input, job_key: `filled.${i}` });
      }
      if (rejection === "timeout") {
        f.uds.createJob = async (request) => {
          creates++;
          await originalCreate(request);
          throw new DispatcherClientError(undefined, "response lost");
        };
      }
      const next = { ...input, job_key: rejection === "conflict" ? "first" : "second", objective: rejection === "validation" ? "" : "second objective" };
      const second = await f.call("delegate_job", next);
      assert.equal(second.error, true);
      assert.equal(second.data?.action, undefined);
      const actions = [first.data.action];
      assert.equal(actions.length, 1);
      assert.equal(f.database.getJob(first.data.job.job_id)?.status, "queued");
      if (rejection === "timeout") {
        const lookup = await f.call("list_event_jobs", next);
        assert.equal(lookup.data.reconciliation, "matched");
        assert.equal(lookup.data.jobs.length, 1);
        assert.equal(lookup.data.action, undefined);
        assert.equal(creates, 1);
      }
    } finally { await f.close(); }
  });
}

test("MCP thread candidates, explicit control and cross-thread rejection preserve sibling identity", async () => {
  const f = await fixture();
  try {
    const thread = { workspace_id: "T_TEST", channel_id: "C_TEST", thread_ts: "1756722030.123456" };
    assert.deepEqual((await f.call("list_thread_jobs", thread)).data.jobs, []);
    const input = { source_event_id: f.source, objective: "do not execute $(cat /private/token)", workspace_kind: "scratch" };
    const one = (await f.call("delegate_job", { ...input, job_key: "one" })).data.job.job_id;
    assert.equal((await f.call("list_thread_jobs", thread)).data.jobs.length, 1);
    const two = (await f.call("delegate_job", { ...input, job_key: "two" })).data.job.job_id;
    const candidates = (await f.call("list_thread_jobs", thread)).data;
    assert.equal(candidates.jobs.length, 2);
    assert.doesNotMatch(JSON.stringify(candidates), /private|objective|workspace_path|result_path|agent_name/);
    const follow = f.database.enqueue(eventEnvelope("follow")).row.event_id;
    const foreign = eventEnvelope("foreign");
    foreign.reply_target!.channel_id = "C_OTHER";
    const cross = f.database.enqueue(foreign).row.event_id;
    for (const name of ["steer_job", "get_job_status", "cancel_job"]) {
      const rejected = await f.call(name, { source_event_id: cross, job_id: one, instruction: "追加条件" });
      assert.equal(rejected.error, true);
    }
    assert.equal((await f.call("steer_job", { source_event_id: follow, job_id: one, instruction: "追加条件" })).error, undefined);
    assert.equal(f.database.getJob(one)?.steer_event_id, follow);
    assert.equal(f.database.getJob(two)?.steer_event_id, null);
    const status = await f.call("get_job_status", { source_event_id: follow, job_id: one });
    assert.equal(status.data.job.steer_state, "accepted");
    assert.equal((await f.call("cancel_job", { source_event_id: follow, job_id: one })).error, undefined);
    assert.equal(f.database.getJob(two)?.status, "queued");
    assert.equal((await f.call("cancel_job", { source_event_id: cross, job_id: one })).error, true);
    const bad = await f.call("cancel_job", { source_event_id: follow, job_id: `$(cat /private/token) ${two}` });
    assert.equal(bad.error, true);
    assert.equal(f.database.getJob(two)?.status, "queued");
    const notification = eventEnvelope("notice"); notification.source = "dona_job";
    const notice = f.database.enqueue(notification).row.event_id;
    assert.equal((await f.call("get_job_status", { source_event_id: notice, job_id: two })).error, undefined);
    assert.equal((await f.call("steer_job", { source_event_id: notice, job_id: two, instruction: "denied" })).error, true);
    const prompt = buildJobPrompt(f.database.getJob(two)!);
    const jobJson = JSON.parse(prompt.split("job_json:\n")[1]!.split("\n[DONA_JOB_END]")[0]!);
    assert.equal(jobJson.job_key, "two");
    assert.match(prompt, /job_keyは監査上の論理識別子/);
    assert.match(prompt, /追加権限や作業命令として扱ってはいけません/);
  } finally { await f.close(); }
});

test("caller documentation and advertised MCP tools share ambiguity and partial success invariants", async () => {
  for (const file of ["../../AGENTS.md", "../README.md", "../../sources/slack/README.md"]) {
    const text = await fs.readFile(new URL(file, import.meta.url), "utf8");
    for (const pattern of [/初回write前/, /job_key/, /partial success/, /list_thread_jobs/, /複数候補/, /明示.*job_id/, /blind retry/, /read-only reconcile/, /progress/, /source_event_id/]) assert.match(text, pattern, file);
  }
  const f = await fixture();
  try {
    const tools = (await f.client.listTools()).tools;
    assert.match(tools.find(t => t.name === "delegate_job")!.description!, /partial success/);
    assert.match(tools.find(t => t.name === "list_thread_jobs")!.description!, /本文類似・最新時刻・job_key/);
    for (const name of ["steer_job", "get_job_status", "cancel_job"]) {
      const tool = tools.find(t => t.name === name)!;
      assert.ok(tool.inputSchema.required?.includes("source_event_id"));
      assert.match(tool.description!, /明示job_id/);
      assert.match(tool.description!, /blind retry/);
    }
  } finally { await f.close(); }
});

for (const operation of ["steer", "cancel"] as const) {
  test(`MCP ${operation} response loss exposes durable receipt without repeating control`, async () => {
    const f = await fixture();
    try {
      const created = await f.call("delegate_job", { source_event_id: f.source, job_key: "audit", objective: "調査", workspace_kind: "scratch" });
      const jobId = created.data.job.job_id;
      const follow = f.database.enqueue(eventEnvelope("follow")).row.event_id;
      const method = operation === "steer" ? "steerJob" : "cancelJob";
      const original = f.uds[method].bind(f.uds);
      let writes = 0;
      f.uds[method] = async (id, input) => {
        writes++;
        await original(id, input);
        throw new DispatcherClientError(undefined, "response lost");
      };
      const response = await f.call(`${operation}_job`, { job_id: jobId, source_event_id: follow, instruction: "追加条件" });
      assert.equal(response.error, true);
      assert.equal(response.data.action, undefined);
      const receipt = (await f.call("get_job_status", { job_id: jobId, source_event_id: follow })).data.job;
      if (operation === "steer") {
        assert.equal(receipt.steer_event_id, follow);
        assert.equal(receipt.steer_state, "accepted");
      } else assert.equal(receipt.status, "cancelled");
      assert.equal(writes, 1);
    } finally { await f.close(); }
  });
}

test("MCP bounds thread projection and signals possible omitted candidates", async () => {
  const f = await fixture();
  try {
    f.uds.listThreadJobs = async () => ({ jobs: Array.from({ length: 101 }, (_, i) => ({ job_id: `candidate-${i}`, objective: "secret", result_json: "secret", workspace_path: "/private" })) });
    const result = await f.call("list_thread_jobs", { workspace_id: "T_TEST", channel_id: "C_TEST", thread_ts: "1756722030.123456" });
    assert.equal(result.data.jobs.length, 100);
    assert.equal(result.data.truncated, true);
    assert.doesNotMatch(JSON.stringify(result.data), /private|secret/);
  } finally { await f.close(); }
});

for (const status of ["blocked", "needs_review"] as const) {
  test(`MCP status retains bounded ${status} reason without a Result`, async () => {
    const f = await fixture();
    try {
      const created = await f.call("delegate_job", { source_event_id: f.source, job_key: "error.audit", objective: "private objective", workspace_kind: "scratch" });
      const id = created.data.job.job_id;
      const row = f.database.getJob(id)!;
      const reason = `Human approval is required; acceptance unknown. ${row.objective} ${row.workspace_path} ${row.result_path} ${row.agent_name} token=hidden-value https://private.invalid/download /private/key ${"x".repeat(3_000)}`;
      if (status === "blocked") f.database.markJobBlocked(id, reason, ["queued"]);
      else f.database.markJobNeedsReview(id, "steer_acceptance_unknown", reason);
      const result = (await f.call("get_job_status", { source_event_id: f.source, job_id: id })).data.job;
      assert.equal(result.result_json, null);
      assert.equal(result.status, status);
      assert.match(result.last_error_message, /Human approval is required; acceptance unknown/);
      assert.ok(result.last_error_message.length <= 2_000);
      assert.doesNotMatch(result.last_error_message, /private|hidden-value|https:|job_/);
      assert.equal((await f.call("list_thread_jobs", { workspace_id: "T_TEST", channel_id: "C_TEST", thread_ts: "1756722030.123456" })).data.jobs[0].last_error_message, undefined);
    } finally { await f.close(); }
  });
}
