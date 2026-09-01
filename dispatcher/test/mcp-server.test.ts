import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { Logger } from "../src/logger.js";
import { createDispatcherMcpServer, type DispatcherJobClient } from "../src/mcp/server.js";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

describe("Dona Dispatcher MCP server", () => {
  test("advertises job tools and maps GitHub delegation to the UDS client", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const api: DispatcherJobClient = {
      async createJob(input) {
        calls.push({ method: "createJob", args: [input] });
        return { schema_version: 1, job: { job_id: "job_01m1es03xy5cf8d9pm5cwx4srv" } };
      },
      async getJob(jobId) {
        calls.push({ method: "getJob", args: [jobId] });
        return { schema_version: 1, job: { job_id: jobId, status: "running" } };
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
    };
    const server = createDispatcherMcpServer(api, logger);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map(({ name }) => name), [
        "delegate_job",
        "list_thread_jobs",
        "get_job_status",
        "steer_job",
        "cancel_job",
      ]);
      assert.equal(listed.tools.find(({ name }) => name === "get_job_status")?.annotations?.readOnlyHint, true);
      assert.equal(listed.tools.find(({ name }) => name === "cancel_job")?.annotations?.destructiveHint, true);

      const result = await client.callTool({
        name: "delegate_job",
        arguments: {
          source_event_id: "evt_01M1ES03XY5CF8D9PM5CWX4SRV",
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
          objective: "調査してPRを作る",
          workspace: { kind: "github", repository: "owner/repo", base_ref: "main" },
        }],
      }]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
