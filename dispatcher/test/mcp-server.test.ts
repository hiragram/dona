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
      async delegateScheduledWork(eventId) {
        calls.push({ method: "delegateScheduledWork", args: [eventId] });
        return { schema_version: 1, outcome: "created", job: { job_id: "job_01m1es03xy5cf8d9pm5cwx4srv" } };
      },
      async getJob(jobId, sourceEventId, options) {
        calls.push({ method: "getJob", args: options===undefined?[jobId, sourceEventId]:[jobId,sourceEventId,options] });
        return { schema_version: 1, job: { job_id: jobId, status: "running", notification_state:"needs_review", notification_authorization_phase:"preflight" },
          ...(options?.includeLiveSession?{live_session:{query_status:"observed",identity_match:true},reconciliation:{state:"consistent_running"},receipt:{receipt_id:"lsr_0123456789abcdef0123456789abcdef"}}:{}),
          ...(options?.liveSessionReceiptId?{live_session:{query_status:"observed",identity_match:true},reconciliation:{state:"consistent_running"},receipt:{receipt_id:options.liveSessionReceiptId}}:{}) };
      },
      async listEventJobs(...args) {
        calls.push({ method: "listEventJobs", args });
        return { schema_version: 1, jobs: [] };
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
      assert.equal(listed.tools.find(tool=>tool.name==="authorize_job_notification")?.annotations?.idempotentHint,false);
      assert.deepEqual(listed.tools.map(({ name }) => name), [
        "delegate_job",
        "delegate_scheduled_work",
        "list_event_jobs",
        "list_thread_jobs",
        "list_owner_jobs",
        "get_job_status",
        "authorize_job_notification",
        "record_schedule_job_access",
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
          job_key: "repo.audit",
          objective: "調査してPRを作る",
          workspace_kind: "github",
          repository: "owner/repo",
          base_ref: "main",
          display_name: "短い作業名",
          issue_repository: "owner/repo",
          issue_number: 87,
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
          display: { short_name: "短い作業名", issue: { repository: "owner/repo", number: 87 } },
        }],
      }]);

      const scheduled = await client.callTool({
        name: "delegate_scheduled_work",
        arguments: { event_id: "evt_01M1ES03XY5CF8D9PM5CWX4SRV" },
      });
      assert.equal(scheduled.isError, undefined);
      assert.deepEqual((scheduled.structuredContent as Record<string,unknown>).action, {
        tool: "delegate_scheduled_work", source_event_id: "evt_01M1ES03XY5CF8D9PM5CWX4SRV",
        job_id: "job_01m1es03xy5cf8d9pm5cwx4srv", outcome: "created",
      });
      assert.deepEqual(calls[1], { method: "delegateScheduledWork", args: ["evt_01M1ES03XY5CF8D9PM5CWX4SRV"] });

      const status = await client.callTool({
        name: "get_job_status",
        arguments: { job_id: "job_01m1es03xy5cf8d9pm5cwx4srv", source_event_id: "evt_01M1ES03XY5CF8D9PM5CWX4SRV" },
      });
      assert.equal(status.isError, undefined);
      assert.equal((status.structuredContent as {job:Record<string,unknown>}).job.notification_authorization_phase,"preflight");
      assert.equal((status.structuredContent as { job: { status: string } }).job.status, "running");
      assert.deepEqual(calls[2], {
        method: "getJob",
        args: ["job_01m1es03xy5cf8d9pm5cwx4srv", "evt_01M1ES03XY5CF8D9PM5CWX4SRV"],
      });
      const liveStatus=await client.callTool({name:"get_job_status",arguments:{job_id:"job_01m1es03xy5cf8d9pm5cwx4srv",source_event_id:"evt_01M1ES03XY5CF8D9PM5CWX4SRV",include_live_session:true}});
      assert.equal((liveStatus.structuredContent as {live_session:{identity_match:boolean}}).live_session.identity_match,true);
      assert.deepEqual(calls[3],{method:"getJob",args:["job_01m1es03xy5cf8d9pm5cwx4srv","evt_01M1ES03XY5CF8D9PM5CWX4SRV",{includeLiveSession:true}]});
      const receiptStatus=await client.callTool({name:"get_job_status",arguments:{job_id:"job_01m1es03xy5cf8d9pm5cwx4srv",source_event_id:"evt_01M1ES03XY5CF8D9PM5CWX4SRV",live_session_receipt_id:"lsr_0123456789abcdef0123456789abcdef"}});
      assert.equal((receiptStatus.structuredContent as {receipt:{receipt_id:string}}).receipt.receipt_id,"lsr_0123456789abcdef0123456789abcdef");
      const beforeConflict=calls.length;const conflict=await client.callTool({name:"get_job_status",arguments:{job_id:"job_01m1es03xy5cf8d9pm5cwx4srv",source_event_id:"evt_01M1ES03XY5CF8D9PM5CWX4SRV",include_live_session:true,live_session_receipt_id:"lsr_0123456789abcdef0123456789abcdef"}});
      assert.equal(conflict.isError,true);assert.equal(calls.length,beforeConflict);
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
      previewSchedule:notUsed, createSchedule:notUsed, getSchedule:notUsed, listSchedules:notUsed, updateSchedule:notUsed, transitionSchedule:notUsed, getScheduleHistory:notUsed,
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
      previewSchedule:notUsed, createSchedule:notUsed, getSchedule:notUsed, listSchedules:notUsed, updateSchedule:notUsed, transitionSchedule:notUsed, getScheduleHistory:notUsed,
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
      previewSchedule:notUsed, createSchedule:notUsed, getSchedule:notUsed, listSchedules:notUsed, updateSchedule:notUsed, transitionSchedule:notUsed, getScheduleHistory:notUsed,
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
