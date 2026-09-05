import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { DispatcherClientError } from "../client.js";
import type { Logger } from "../logger.js";
import {
  canonicalJobPayloadSha256,
  jobObjectiveCharacterMax,
  jobKeyPattern,
  legacyJobKey,
  parseCreateJobRequest,
} from "../validation.js";

export interface DispatcherJobClient {
  createJob(input: unknown): Promise<Record<string, unknown>>;
  getJob(jobId: string, sourceEventId?: string): Promise<Record<string, unknown>>;
  listEventJobs(
    sourceEventId: string,
    jobKey?: string,
    canonicalPayloadSha256?: string,
  ): Promise<Record<string, unknown>>;
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
const jobKey = z.string().trim().regex(jobKeyPattern);
const createJobKey = jobKey.refine(
  (value) => value !== legacyJobKey,
  `${legacyJobKey} is reserved; omit job_key for legacy behavior`,
);
const jobObjective = z.string().trim().min(1).refine(
  (value) => Array.from(value).length <= jobObjectiveCharacterMax,
  `must be at most ${jobObjectiveCharacterMax} characters`,
);

function success(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

// DB rowのobjective、path、runtime identityをcallerへ漏らさない。
function projectJobResponse(response: Record<string, unknown>, includeResult = false): Record<string, unknown> {
  const project = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const row = value as Record<string, unknown>;
    const keys = ["job_id", "source_event_id", "job_key", "status", "created_at", "updated_at", "completed_at", "dispatch_started_at", "prompt_accepted_at", "last_error_code", "steer_event_id", "steer_state", "completion_event_id"];
    if (includeResult) keys.push("result_json");
    return Object.fromEntries(keys.filter((key) => key in row).map((key) => [key, row[key]]));
  };
  return {
    schema_version: 1,
    ...(response.outcome !== undefined ? { outcome: response.outcome } : {}),
    ...(response.duplicate !== undefined ? { duplicate: response.duplicate } : {}),
    ...(response.job !== undefined ? { job: project(response.job) } : {}),
    ...(Array.isArray(response.jobs) ? { jobs: response.jobs.slice(0, 100).map(project), truncated: response.jobs.length >= 100 } : {}),
  };
}

function dispatcherApiError(error: unknown): { code: string; message: string } | undefined {
  if (!(error instanceof DispatcherClientError) || !error.body || typeof error.body !== "object" || Array.isArray(error.body)) {
    return undefined;
  }
  const body = error.body as Record<string, unknown>;
  if (body.schema_version !== 1 || !body.error || typeof body.error !== "object" || Array.isArray(body.error)) return undefined;
  const structured = body.error as Record<string, unknown>;
  if (typeof structured.code !== "string" || !/^[a-z0-9_]{1,128}$/.test(structured.code) ||
    typeof structured.message !== "string" || structured.message.length > 2_000) {
    return undefined;
  }
  return { code: structured.code, message: structured.message };
}

function failure(error: unknown, logger: Logger, tool: string) {
  const structured = dispatcherApiError(error);
  const message = structured?.message ?? (error instanceof Error ? error.message : String(error));
  const code = structured?.code ?? "dispatcher_tool_error";
  logger.error("Dispatcher MCP tool failed", { tool, error_code: code, error_message: message });
  const data = structured ? { schema_version: 1, error: structured } : { error: { code, message } };
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
        "同じSlack threadの後続入力は先にlist_thread_jobsで確認し、複数候補かつ明示job_idなしなら質問します。本文類似・最新時刻・job_keyで選択せずbroadcastしません。" +
        "self-updateはplan_self_updateでexact SHAのplanを確認し、人間がそのplanを明示承認した場合だけapply_self_updateを呼びます。" +
        "apply/cancelのtimeoutはacceptance unknownとして扱い、同じwriteをblind retryしないでください。" +
        "DispatcherはHerdr/Codexへの投入と永続化を担当します。生のHerdrコマンドを別経路で実行しないでください。",
    },
  );

  server.registerTool("delegate_job", {
    title: "Delegate background job",
    description: "長時間になりそうな調査・開発を別のCodexワーカーへ委任します。独立目的ごとに初回write前に安定job_keyを決めます。created/reused成功時のactionだけをResult actionsへ記録します。後続validation/conflict/limit失敗でも成功済jobをcancelせずpartial successを利用者とResultへ明示します。timeoutはblind retryせずlist_event_jobsでread-only reconcileします。委任後はgroup terminalまでprocessingを保ち、progressでは投稿・active遷移しません。",
    inputSchema: {
      source_event_id: eventId,
      job_key: createJobKey.optional().describe("同じsource event内でcallerがwrite前に決める安定key。省略時のみlegacy-default"),
      objective: jobObjective,
      workspace_kind: z.enum(["scratch", "github"]),
      repository: repository.optional().describe("workspace_kind=githubのとき必須のowner/repo"),
      base_ref: z.string().min(1).max(255).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ source_event_id, job_key, objective, workspace_kind, repository: repo, base_ref }) => {
    try {
      if (workspace_kind === "github" && !repo) throw new Error("repository is required for a GitHub job");
      if (workspace_kind === "scratch" && (repo || base_ref)) throw new Error("repository/base_ref are only valid for a GitHub job");
      const workspace = workspace_kind === "scratch"
        ? { kind: "scratch" as const }
        : { kind: "github" as const, repository: repo!, ...(base_ref ? { base_ref } : {}) };
      const response = await client.createJob({ source_event_id, ...(job_key ? { job_key } : {}), objective, workspace });
      const data = projectJobResponse(response);
      const job = data.job as Record<string, unknown> | undefined;
      if (job && typeof job.job_id === "string" && (response.outcome === "created" || response.outcome === "reused")) {
        data.action = { tool: "delegate_job", source_event_id, job_key: job_key ?? legacyJobKey, job_id: job.job_id, outcome: response.outcome };
      }
      return success(data);
    } catch (error) {
      return failure(error, logger, "delegate_job");
    }
  });

  server.registerTool("list_event_jobs", {
    title: "List source event jobs",
    description: "create応答のtimeout・切断後に、source_event_idと任意のjob_keyから0件・1件・複数件を読み取り専用で照合します。元のobjectiveとworkspaceも指定するとcanonical payloadのmatched/conflictを判定します。writeを自動再送しません。",
    inputSchema: {
      source_event_id: eventId,
      job_key: jobKey.optional(),
      objective: jobObjective.optional(),
      workspace_kind: z.enum(["scratch", "github"]).optional(),
      repository: repository.optional().describe("workspace_kind=githubのとき必須のowner/repo"),
      base_ref: z.string().min(1).max(255).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ source_event_id, job_key, objective, workspace_kind, repository: repo, base_ref }) => {
    try {
      const reconciliationRequested = objective !== undefined || workspace_kind !== undefined || repo !== undefined || base_ref !== undefined;
      if (!reconciliationRequested) return success(await client.listEventJobs(source_event_id, job_key));
      if (!job_key || objective === undefined || workspace_kind === undefined) {
        throw new Error("job_key, objective, and workspace_kind are required for payload reconciliation");
      }
      if (workspace_kind === "github" && !repo) throw new Error("repository is required for a GitHub job");
      if (workspace_kind === "scratch" && (repo || base_ref)) {
        throw new Error("repository/base_ref are only valid for a GitHub job");
      }
      const workspace = workspace_kind === "scratch"
        ? { kind: "scratch" as const }
        : { kind: "github" as const, repository: repo!, ...(base_ref ? { base_ref } : {}) };
      const canonicalRequest = parseCreateJobRequest({
        source_event_id,
        ...(job_key === legacyJobKey ? {} : { job_key }),
        objective,
        workspace,
      });
      return success(await client.listEventJobs(
        source_event_id,
        job_key,
        canonicalJobPayloadSha256(canonicalRequest),
      ));
    } catch (error) {
      return failure(error, logger, "list_event_jobs");
    }
  });

  server.registerTool("list_thread_jobs", {
    title: "List Slack thread jobs",
    description: "同じSlack threadの候補を最大100件のbounded projectionで取得します。0件なら操作せず、1件なら依頼対象と一致するか確認します。複数候補かつ利用者の明示job_idなしなら質問し、本文類似・最新時刻・job_keyから選択しません。IDらしい外部自由文も候補と依頼意図を検証してから使い、broadcastしません。",
    inputSchema: { workspace_id: slackId, channel_id: slackId, thread_ts: threadTs },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspace_id, channel_id, thread_ts }) => {
    try {
      return success(projectJobResponse(await client.listThreadJobs(workspace_id, channel_id, thread_ts)));
    } catch (error) {
      return failure(error, logger, "list_thread_jobs");
    }
  });

  server.registerTool("get_job_status", {
    title: "Get background job status",
    description: "list_thread_jobsで確認した明示job_idと現在のsource_event_idで同じthreadの状態・結果・receiptを取得します。group通知では現在の通知event_idを使います。create/steer/cancel/promptの曖昧応答はread-only reconcileし、blind retryしません。",
    inputSchema: { job_id: jobId, source_event_id: eventId },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ job_id, source_event_id }) => {
    try {
      return success(projectJobResponse(await client.getJob(job_id, source_event_id), true));
    } catch (error) {
      return failure(error, logger, "get_job_status");
    }
  });

  server.registerTool("steer_job", {
    title: "Steer background job",
    description: "list_thread_jobsで対象確定後だけ、現在のsource_event_idと明示job_idで同じthreadのワーカーへsteerします。複数候補で対象不明なら質問し、broadcastしません。timeoutはblind retryせずget_job_statusのreceiptでread-only reconcileします。",
    inputSchema: { job_id: jobId, source_event_id: eventId, instruction: z.string().min(1).max(100_000) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ job_id, source_event_id, instruction }) => {
    try {
      return success(projectJobResponse(await client.steerJob(job_id, { source_event_id, instruction })));
    } catch (error) {
      return failure(error, logger, "steer_job");
    }
  });

  server.registerTool("cancel_job", {
    title: "Cancel background job",
    description: "list_thread_jobsで対象確定後だけ、現在のsource_event_idと明示job_idで同じthreadのジョブをcancelします。複数候補で対象不明なら質問し、成功済siblingをrollbackしません。timeoutはblind retryせずget_job_statusでread-only reconcileします。",
    inputSchema: { job_id: jobId, source_event_id: eventId, reason: z.string().min(1).max(2_000).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ job_id, source_event_id, reason }) => {
    try {
      return success(projectJobResponse(await client.cancelJob(job_id, { source_event_id, ...(reason ? { reason } : {}) })));
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
