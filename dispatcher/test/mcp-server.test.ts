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
      async listThreadJobs(...args) {
        calls.push({ method: "listThreadJobs", args });
        return { schema_version: 1, jobs: [] };
      },
      async listOwnerJobs(sourceEventId) {
        calls.push({ method: "listOwnerJobs", args: [sourceEventId] });
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
      async previewSchedule(input) { calls.push({ method: "previewSchedule", args: [input] }); return { schema_version: 1 }; },
      async createSchedule(input) { calls.push({ method: "createSchedule", args: [input] }); return { schema_version: 1 }; },
      async getSchedule(...args) { calls.push({ method: "getSchedule", args }); return { schema_version: 1 }; },
      async listSchedules(...args) { calls.push({ method: "listSchedules", args }); return { schema_version: 1 }; },
      async updateSchedule(...args) { calls.push({ method: "updateSchedule", args }); return { schema_version: 1 }; },
      async transitionSchedule(...args) { calls.push({ method: "transitionSchedule", args }); return { schema_version: 1 }; },
      async getScheduleHistory(...args) { calls.push({ method: "getScheduleHistory", args }); return { schema_version: 1 }; },
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
        "list_owner_jobs",
        "get_job_status",
        "steer_job",
        "cancel_job",
        "plan_self_update",
        "apply_self_update",
        "get_self_update_status",
        "cancel_self_update",
        "preview_schedule",
        "create_schedule",
        "get_schedule",
        "list_schedules",
        "update_schedule",
        "pause_schedule",
        "resume_schedule",
        "cancel_schedule",
        "get_schedule_history",
      ]);
      assert.equal(listed.tools.find(({ name }) => name === "get_job_status")?.annotations?.readOnlyHint, true);
      assert.equal(listed.tools.find(({ name }) => name === "cancel_job")?.annotations?.destructiveHint, true);
      assert.equal(listed.tools.find(({ name }) => name === "plan_self_update")?.annotations?.readOnlyHint, true);
      assert.equal(listed.tools.find(({ name }) => name === "apply_self_update")?.annotations?.destructiveHint, true);
      assert.equal(listed.tools.find(({ name }) => name === "update_schedule")?.annotations?.destructiveHint, true);
      assert.equal(listed.tools.find(({ name }) => name === "pause_schedule")?.annotations?.destructiveHint, true);

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

      const preview = await client.callTool({ name: "preview_schedule", arguments: {
        source_event_id: "evt_01M1ES03XY5CF8D9PM5CWX4SRV",
        definition: { recurrence: { version: 1, kind: "once", at: "2026-09-08T00:00:00Z" }, action: { kind: "reminder", body: "確認" } },
        after: "2026-09-06T00:00:00Z", before_or_equal: "2026-09-09T00:00:00Z", limit: 10,
      } });
      assert.equal(preview.isError, undefined);
      assert.equal(calls.at(-1)?.method, "previewSchedule");
      const scheduleListed = await client.callTool({ name: "list_schedules", arguments: {
        source_event_id: "evt_01M1ES03XY5CF8D9PM5CWX4SRV", limit: 10, cursor: "12",
      } });
      assert.equal(scheduleListed.isError, undefined);
      assert.deepEqual(calls.at(-1), { method: "listSchedules", args: ["evt_01M1ES03XY5CF8D9PM5CWX4SRV", 10, "12"] });
      for (const cursor of ["01", "9007199254740992"]) {
        const beforeInvalidCursor: number = calls.length;
        const invalidCursor = await client.callTool({ name: "list_schedules", arguments: {
          source_event_id: "evt_01M1ES03XY5CF8D9PM5CWX4SRV", limit: 10, cursor,
        } });
        assert.equal(invalidCursor.isError, true);
        assert.equal(calls.length, beforeInvalidCursor);
      }
      const maxCursor = await client.callTool({ name: "list_schedules", arguments: {
        source_event_id: "evt_01M1ES03XY5CF8D9PM5CWX4SRV", limit: 10, cursor: "9007199254740991",
      } });
      assert.equal(maxCursor.isError, undefined);
      assert.deepEqual(calls.at(-1), { method: "listSchedules", args: ["evt_01M1ES03XY5CF8D9PM5CWX4SRV", 10, "9007199254740991"] });
      const beforeInvalid = calls.length;
      const invalidKey = await client.callTool({ name: "create_schedule", arguments: {
        source_event_id: "evt_01M1ES03XY5CF8D9PM5CWX4SRV", idempotency_key: "request.1",
        definition: { recurrence: { version: 1, kind: "once", at: "2026-09-08T00:00:00Z" }, action: { kind: "reminder", body: "確認" } },
      } });
      assert.equal(invalidKey.isError, true);
      assert.equal(calls.length, beforeInvalid);

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
});
