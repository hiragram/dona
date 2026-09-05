import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { DispatcherClientError } from "../src/client.js";
import type { Logger } from "../src/logger.js";
import { createDispatcherMcpServer, type DispatcherJobClient } from "../src/mcp/server.js";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

describe("Dona Dispatcher MCP server", () => {
  test("advertises job tools and maps GitHub delegation to the UDS client", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    let planError: Error | undefined;
    const api: DispatcherJobClient = {
      async createJob(input) {
        calls.push({ method: "createJob", args: [input] });
        return { schema_version: 1, job: { job_id: "job_01m1es03xy5cf8d9pm5cwx4srv" } };
      },
      async getJob(jobId) {
        calls.push({ method: "getJob", args: [jobId] });
        return { schema_version: 1, job: { job_id: jobId, status: "running" } };
      },
      async listEventJobs(...args) {
        calls.push({ method: "listEventJobs", args });
        return { schema_version: 1, jobs: [] };
      },
      async listThreadJobs(...args) {
        calls.push({ method: "listThreadJobs", args });
        return { schema_version: 1, jobs: [] };
      },
      async steerJob(jobId, input) {
        calls.push({ method: "steerJob", args: [jobId, input] });
        return { schema_version: 1, job: { job_id: jobId, status: "running" } };
      },
      async cancelJob(jobId, input) {
        calls.push({ method: "cancelJob", args: [jobId, input] });
        return { schema_version: 1, job: { job_id: jobId, status: "cancelled" } };
      },
      async planSelfUpdate(input) {
        calls.push({ method: "planSelfUpdate", args: [input] });
        if (planError) throw planError;
        return { schema_version: 1, plan: {} };
      },
      async applySelfUpdate(input) {
        calls.push({ method: "applySelfUpdate", args: [input] });
        return { schema_version: 1, accepted: true };
      },
      async getSelfUpdateStatus(requestId) {
        calls.push({ method: "getSelfUpdateStatus", args: [requestId] });
        return { schema_version: 1, updates: [] };
      },
      async cancelSelfUpdate(input) {
        calls.push({ method: "cancelSelfUpdate", args: [input] });
        return { schema_version: 1, state: "cancelled" };
      },
    };
    const server = createDispatcherMcpServer(api, logger);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map(({ name }) => name), [
        "delegate_job",
        "list_event_jobs",
        "list_thread_jobs",
        "get_job_status",
        "steer_job",
        "cancel_job",
        "plan_self_update",
        "apply_self_update",
        "get_self_update_status",
        "cancel_self_update",
      ]);
      assert.equal(listed.tools.find(({ name }) => name === "get_job_status")?.annotations?.readOnlyHint, true);
      assert.equal(listed.tools.find(({ name }) => name === "cancel_job")?.annotations?.destructiveHint, true);
      assert.equal(listed.tools.find(({ name }) => name === "plan_self_update")?.annotations?.readOnlyHint, true);
      assert.equal(listed.tools.find(({ name }) => name === "apply_self_update")?.annotations?.destructiveHint, true);

      const result = await client.callTool({
        name: "delegate_job",
        arguments: {
          source_event_id: "evt_01M1ES03XY5CF8D9PM5CWX4SRV",
          job_key: "repo.audit",
          objective: "調査してPRを作る",
          workspace_kind: "github",
          repository: "owner/repo",
          base_ref: "main",
        },
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(calls, [{
        method: "createJob",
        args: [{
          source_event_id: "evt_01M1ES03XY5CF8D9PM5CWX4SRV",
          job_key: "repo.audit",
          objective: "調査してPRを作る",
          workspace: { kind: "github", repository: "owner/repo", base_ref: "main" },
        }],
      }]);

      const status = await client.callTool({
        name: "get_job_status",
        arguments: { job_id: "job_01m1es03xy5cf8d9pm5cwx4srv" },
      });
      assert.equal(status.isError, undefined);
      assert.equal((status.structuredContent as { job: { status: string } }).job.status, "running");
      assert.deepEqual(calls[1], {
        method: "getJob",
        args: ["job_01m1es03xy5cf8d9pm5cwx4srv"],
      });

      const body = {
        schema_version: 1,
        error: { code: "request_failed", message: "target_does_not_pass_fixed_ci_trust_gate" },
      };
      planError = new DispatcherClientError(409, JSON.stringify(body), body);
      const rejected = await client.callTool({
        name: "plan_self_update",
        arguments: { source_event_id: "evt_01M1ES03XY5CF8D9PM5CWX4SRV" },
      });
      assert.equal(rejected.isError, true);
      assert.deepEqual(rejected.structuredContent, body);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("preserves stable create error codes in structured content", async () => {
    let createCalls = 0;
    let errorCode = "job_idempotency_conflict";
    const notUsed = async (): Promise<Record<string, unknown>> => {
      throw new Error("not used");
    };
    const api: DispatcherJobClient = {
      async createJob() {
        createCalls += 1;
        throw new DispatcherClientError(409, "conflict", {
          schema_version: 1,
          error: { code: errorCode, message: `${errorCode} message` },
        });
      },
      getJob: notUsed,
      listEventJobs: notUsed,
      listThreadJobs: notUsed,
      steerJob: notUsed,
      cancelJob: notUsed,
      planSelfUpdate: notUsed,
      applySelfUpdate: notUsed,
      getSelfUpdateStatus: notUsed,
      cancelSelfUpdate: notUsed,
    };
    const server = createDispatcherMcpServer(api, logger);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      for (const code of ["job_idempotency_conflict", "job_group_closed", "job_group_limit_exceeded"]) {
        errorCode = code;
        const failed = await client.callTool({
          name: "delegate_job",
          arguments: {
            source_event_id: "evt_01M1ES03XY5CF8D9PM5CWX4SRV",
            job_key: "repo.audit",
            objective: "調査する",
            workspace_kind: "scratch",
          },
        });
        assert.equal(failed.isError, true);
        assert.deepEqual(failed.structuredContent, {
          schema_version: 1,
          error: { code, message: `${code} message` },
        });
      }
      assert.equal(createCalls, 3);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("accepts the HTTP objective code-point boundary for delegation and reconciliation", async () => {
    const objective = "😀".repeat(100_000);
    let createCalls = 0;
    let listCalls = 0;
    const notUsed = async (): Promise<Record<string, unknown>> => {
      throw new Error("not used");
    };
    const api: DispatcherJobClient = {
      async createJob(input) {
        createCalls += 1;
        assert.equal((input as { objective: string }).objective, objective);
        return { schema_version: 1, job: { job_id: "job_01m1es03xy5cf8d9pm5cwx4srv" } };
      },
      getJob: notUsed,
      async listEventJobs(_sourceEventId, _jobKey, canonicalPayloadSha256) {
        listCalls += 1;
        assert.match(canonicalPayloadSha256 ?? "", /^[0-9a-f]{64}$/);
        return { schema_version: 1, reconciliation: "matched", jobs: [] };
      },
      listThreadJobs: notUsed,
      steerJob: notUsed,
      cancelJob: notUsed,
      planSelfUpdate: notUsed,
      applySelfUpdate: notUsed,
      getSelfUpdateStatus: notUsed,
      cancelSelfUpdate: notUsed,
    };
    const server = createDispatcherMcpServer(api, logger);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const delegated = await client.callTool({
        name: "delegate_job",
        arguments: {
          source_event_id: "evt_01M1ES03XY5CF8D9PM5CWX4SRV",
          job_key: "unicode.boundary",
          objective,
          workspace_kind: "scratch",
        },
      });
      assert.equal(delegated.isError, undefined);

      const reconciled = await client.callTool({
        name: "list_event_jobs",
        arguments: {
          source_event_id: "evt_01M1ES03XY5CF8D9PM5CWX4SRV",
          job_key: "unicode.boundary",
          objective,
          workspace_kind: "scratch",
        },
      });
      assert.equal(reconciled.isError, undefined);
      assert.equal(createCalls, 1);
      assert.equal(listCalls, 1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("reconciles an acceptance-unknown timeout without retrying the write", async () => {
    let createCalls = 0;
    let listCalls = 0;
    const notUsed = async (): Promise<Record<string, unknown>> => {
      throw new Error("not used");
    };
    const api: DispatcherJobClient = {
      async createJob() {
        createCalls += 1;
        throw new DispatcherClientError(undefined, "Dispatcher request timed out after 10000ms");
      },
      getJob: notUsed,
      async listEventJobs(sourceEventId, jobKey, canonicalPayloadSha256) {
        listCalls += 1;
        assert.match(canonicalPayloadSha256 ?? "", /^[0-9a-f]{64}$/);
        return {
          schema_version: 1,
          source_event_id: sourceEventId,
          reconciliation: "matched",
          jobs: [{ job_id: "job_01m1es03xy5cf8d9pm5cwx4srv", job_key: jobKey, status: "queued" }],
        };
      },
      listThreadJobs: notUsed,
      steerJob: notUsed,
      cancelJob: notUsed,
      planSelfUpdate: notUsed,
      applySelfUpdate: notUsed,
      getSelfUpdateStatus: notUsed,
      cancelSelfUpdate: notUsed,
    };
    const server = createDispatcherMcpServer(api, logger);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const failed = await client.callTool({
        name: "delegate_job",
        arguments: {
          source_event_id: "evt_01M1ES03XY5CF8D9PM5CWX4SRV",
          job_key: " repo.audit ",
          objective: "調査する",
          workspace_kind: "scratch",
        },
      });
      assert.equal(failed.isError, true);
      assert.deepEqual(failed.structuredContent, {
        error: { code: "dispatcher_tool_error", message: "Dispatcher request timed out after 10000ms" },
      });
      assert.equal(createCalls, 1);

      const reconciled = await client.callTool({
        name: "list_event_jobs",
        arguments: {
          source_event_id: "evt_01M1ES03XY5CF8D9PM5CWX4SRV",
          job_key: " repo.audit ",
          objective: "調査する",
          workspace_kind: "scratch",
        },
      });
      assert.equal(reconciled.isError, undefined);
      assert.equal(createCalls, 1);
      assert.equal(listCalls, 1);
      assert.equal((reconciled.structuredContent as { reconciliation: string }).reconciliation, "matched");
      assert.equal(
        ((reconciled.structuredContent as { jobs: Array<{ job_id: string }> }).jobs[0]?.job_id),
        "job_01m1es03xy5cf8d9pm5cwx4srv",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
