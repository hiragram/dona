import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { Logger } from "../logger.js";

export interface DispatcherJobClient {
  createJob(input: unknown): Promise<Record<string, unknown>>;
  getJob(jobId: string): Promise<Record<string, unknown>>;
  listThreadJobs(workspaceId: string, channelId: string, threadTs: string): Promise<Record<string, unknown>>;
  steerJob(jobId: string, input: unknown): Promise<Record<string, unknown>>;
  cancelJob(jobId: string, input: unknown): Promise<Record<string, unknown>>;
  planSelfUpdate(input: unknown): Promise<Record<string, unknown>>;
  applySelfUpdate(input: unknown): Promise<Record<string, unknown>>;
  getSelfUpdateStatus(requestId?: string): Promise<Record<string, unknown>>;
  cancelSelfUpdate(input: unknown): Promise<Record<string, unknown>>;
}

const eventId = z.string().regex(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/i).describe("現在処理中のDona event_id");
const jobId = z.string().regex(/^job_[0-9a-hjkmnp-tv-z]{26}$/).describe("delegate_jobが返したjob_id");
const slackId = z.string().min(1).max(64);
const threadTs = z.string().regex(/^\d+\.\d+$/);
const repository = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/);
const updateRequestId = z.string().regex(/^upd_[0-9a-hjkmnp-tv-z]{26}$/);
const updatePlanId = z.string().regex(/^plan_[0-9a-hjkmnp-tv-z]{26}$/);
const planHash = z.string().regex(/^[0-9a-f]{64}$/);
const approvalId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);

function success(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function failure(error: unknown, logger: Logger, tool: string) {
  const message = error instanceof Error ? error.message : String(error);
  logger.error("Dispatcher MCP tool failed", { tool, error_code: "dispatcher_tool_error", error_message: message });
  const data = { error: { code: "dispatcher_tool_error", message } };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

export function createDispatcherMcpServer(client: DispatcherJobClient, logger: Logger): McpServer {
  const server = new McpServer(
    { name: "dona-dispatcher", version: "0.1.0" },
    {
      instructions:
        "Donaのバックグラウンドジョブ制御ツール。長い調査や開発作業をdelegate_jobへ委任し、Slackイベントの処理自体は速やかに完了してください。" +
        "同じSlack threadの後続入力はlist_thread_jobsとget_job_statusで対象を確認してからsteer_jobへ渡します。" +
        "self-updateはplan_self_updateでexact SHAのplanを確認し、人間がそのplanを明示承認した場合だけapply_self_updateを呼びます。" +
        "apply/cancelのtimeoutはacceptance unknownとして扱い、同じwriteをblind retryしないでください。" +
        "DispatcherはHerdr/Codexへの投入と永続化を担当します。生のHerdrコマンドを別経路で実行しないでください。",
    },
  );

  server.registerTool("delegate_job", {
    title: "Delegate background job",
    description: "長時間になりそうな調査・開発を、別のCodexワーカーへ委任します。1 eventにつき1 jobです。",
    inputSchema: {
      source_event_id: eventId,
      objective: z.string().min(1).max(100_000),
      workspace_kind: z.enum(["scratch", "github"]),
      repository: repository.optional().describe("workspace_kind=githubのとき必須のowner/repo"),
      base_ref: z.string().min(1).max(255).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ source_event_id, objective, workspace_kind, repository: repo, base_ref }) => {
    try {
      if (workspace_kind === "github" && !repo) throw new Error("repository is required for a GitHub job");
      if (workspace_kind === "scratch" && (repo || base_ref)) throw new Error("repository/base_ref are only valid for a GitHub job");
      const workspace = workspace_kind === "scratch"
        ? { kind: "scratch" as const }
        : { kind: "github" as const, repository: repo!, ...(base_ref ? { base_ref } : {}) };
      return success(await client.createJob({ source_event_id, objective, workspace }));
    } catch (error) {
      return failure(error, logger, "delegate_job");
    }
  });

  server.registerTool("list_thread_jobs", {
    title: "List Slack thread jobs",
    description: "同じSlack threadから委任されたジョブを新しい順に取得します。",
    inputSchema: { workspace_id: slackId, channel_id: slackId, thread_ts: threadTs },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspace_id, channel_id, thread_ts }) => {
    try {
      return success(await client.listThreadJobs(workspace_id, channel_id, thread_ts));
    } catch (error) {
      return failure(error, logger, "list_thread_jobs");
    }
  });

  server.registerTool("get_job_status", {
    title: "Get background job status",
    description: "ジョブの状態、workspace path、結果、エラーを取得します。",
    inputSchema: { job_id: jobId },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ job_id }) => {
    try {
      return success(await client.getJob(job_id));
    } catch (error) {
      return failure(error, logger, "get_job_status");
    }
  });

  server.registerTool("steer_job", {
    title: "Steer background job",
    description: "同じSlack threadの後続メッセージを、稼働中ワーカーのCodex turnへsteerします。",
    inputSchema: { job_id: jobId, source_event_id: eventId, instruction: z.string().min(1).max(100_000) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ job_id, source_event_id, instruction }) => {
    try {
      return success(await client.steerJob(job_id, { source_event_id, instruction }));
    } catch (error) {
      return failure(error, logger, "steer_job");
    }
  });

  server.registerTool("cancel_job", {
    title: "Cancel background job",
    description: "同じSlack threadのジョブへCtrl+Cを送り、cancelledとして記録します。",
    inputSchema: { job_id: jobId, source_event_id: eventId, reason: z.string().min(1).max(2_000).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ job_id, source_event_id, reason }) => {
    try {
      return success(await client.cancelJob(job_id, { source_event_id, ...(reason ? { reason } : {}) }));
    } catch (error) {
      return failure(error, logger, "cancel_job");
    }
  });

  server.registerTool("plan_self_update", {
    title: "Plan Dona self-update",
    description: "固定repository/mainからexact target SHA、互換性、plan hashを読み取り専用で計画します。raw ref/URL/path/commandは受け付けません。",
    inputSchema: { source_event_id: eventId },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ source_event_id }) => {
    try {
      return success(await client.planSelfUpdate({ source_event_id }));
    } catch (error) {
      return failure(error, logger, "plan_self_update");
    }
  });

  server.registerTool("apply_self_update", {
    title: "Apply approved Dona self-update",
    description: "明示承認されたexact planだけをstable updaterへ投入します。service停止・pointer切替・rollbackを含み得ます。",
    inputSchema: {
      source_event_id: eventId,
      plan_id: updatePlanId,
      plan_hash: planHash,
      approval_id: approvalId.describe("exact planに対する人間の承認receipt ID"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      return success(await client.applySelfUpdate(input));
    } catch (error) {
      return failure(error, logger, "apply_self_update");
    }
  });

  server.registerTool("get_self_update_status", {
    title: "Get Dona self-update status",
    description: "update state、lease/fence、SHA、health、rollback可否、outboxを取得します。",
    inputSchema: { request_id: updateRequestId.optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ request_id }) => {
    try {
      return success(await client.getSelfUpdateStatus(request_id));
    } catch (error) {
      return failure(error, logger, "get_self_update_status");
    }
  });

  server.registerTool("cancel_self_update", {
    title: "Cancel Dona self-update",
    description: "activation前のupdateをcancelします。外部mutation開始後はneeds_reviewへfail closedします。",
    inputSchema: { source_event_id: eventId, request_id: updateRequestId, reason: z.string().min(1).max(2_000).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ source_event_id, request_id, reason }) => {
    try {
      return success(await client.cancelSelfUpdate({ source_event_id, request_id, ...(reason ? { reason } : {}) }));
    } catch (error) {
      return failure(error, logger, "cancel_self_update");
    }
  });

  return server;
}
