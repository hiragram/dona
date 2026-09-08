import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { DispatcherClientError } from "../client.js";
import type { Logger } from "../logger.js";

export interface DispatcherJobClient {
  createJob(input: unknown): Promise<Record<string, unknown>>;
  getJob(jobId: string): Promise<Record<string, unknown>>;
  authorizeJobNotification?(eventId:string,receipt?:string):Promise<Record<string,unknown>>;
  recordScheduleJobAccess?(eventId:string,receipt:string):Promise<Record<string,unknown>>;
  listThreadJobs(workspaceId: string, channelId: string, threadTs: string): Promise<Record<string, unknown>>;
  listOwnerJobs?(sourceEventId: string): Promise<Record<string, unknown>>;
  steerJob(jobId: string, input: unknown): Promise<Record<string, unknown>>;
  cancelJob(jobId: string, input: unknown): Promise<Record<string, unknown>>;
  planSelfUpdate(input: unknown): Promise<Record<string, unknown>>;
  applySelfUpdate(input: unknown): Promise<Record<string, unknown>>;
  getSelfUpdateStatus(requestId?: string): Promise<Record<string, unknown>>;
  cancelSelfUpdate(input: unknown): Promise<Record<string, unknown>>;
  previewSchedule(input: unknown): Promise<Record<string, unknown>>;
  createSchedule(input: unknown): Promise<Record<string, unknown>>;
  getSchedule(scheduleId: string, sourceEventId: string): Promise<Record<string, unknown>>;
  listSchedules(sourceEventId: string, limit: number, cursor?: string): Promise<Record<string, unknown>>;
  updateSchedule(scheduleId: string, input: unknown): Promise<Record<string, unknown>>;
  transitionSchedule(scheduleId: string, action: "pause"|"resume"|"cancel", input: unknown): Promise<Record<string, unknown>>;
  getScheduleHistory(scheduleId: string, sourceEventId: string, limit: number, cursor?: string): Promise<Record<string, unknown>>;
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
const scheduleId = z.string().regex(/^sch_[a-f0-9]{32}$/);
const scheduleIdempotencyKey = z.string().min(1).max(128).regex(/^[A-Za-z0-9_:-]+$/);
const scheduleListCursor = z.string().regex(/^(?:0|[1-9]\d{0,14}|[1-8]\d{15}|900[0-6]\d{12}|90070\d{11}|90071[0-8]\d{10}|900719[0-8]\d{9}|9007199[01]\d{8}|90071992[0-4]\d{7}|900719925[0-3]\d{6}|9007199254[0-6]\d{5}|90071992547[0-3]\d{4}|9007199254740[0-8]\d{2}|90071992547409[0-8]\d|900719925474099[01])$/);
const recurrence = z.record(z.string(), z.unknown());
const scheduleContent = (max: number) => z.string().min(1).refine(value => [...value].length <= max);
const scheduleAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reminder"), body: scheduleContent(2000) }).strict(),
  z.object({ kind: z.literal("work"), objective: scheduleContent(4000), notify: z.enum(["origin_thread", "none"]) }).strict(),
]);
const scheduleDefinition = z.object({ recurrence, action: scheduleAction }).strict();

function success(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
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

  server.registerTool("list_owner_jobs", {
    title: "List owner jobs",
    description: "現在eventと同じ永続ownerに属するjobを取得します。",
    inputSchema: { source_event_id: eventId },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ source_event_id }) => {
    try { if(!client.listOwnerJobs) throw new Error("Owner query is unavailable"); return success(await client.listOwnerJobs(source_event_id)); }
    catch(error){ return failure(error,logger,"list_owner_jobs"); }
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

  server.registerTool("authorize_job_notification", {
    title:"Authorize scheduled job notification",
    description:"scheduled dona_jobのSlack write直前に、永続schedule state・revision・expiry・900秒期限を再検証します。authorized以外やtool失敗では投稿してはいけません。",
    inputSchema:{event_id:eventId,access_receipt:z.string().min(32).max(2_000).optional()},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async({event_id,access_receipt})=>{
    try { if(!client.authorizeJobNotification) throw new Error("Notification authorization is unavailable"); return success(await client.authorizeJobNotification(event_id,access_receipt)); }
    catch(error){return failure(error,logger,"authorize_job_notification");}
  });

  server.registerTool("record_schedule_job_access", {
    title:"Record scheduled job access receipt",
    description:"check_user_channel_access成功直後に、その完全一致receiptを一度だけ永続化します。成功後は直ちにdelegate_jobを呼びます。",
    inputSchema:{event_id:eventId,receipt:z.string().min(32).max(2_000)},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
  },async({event_id,receipt})=>{
    try { if(!client.recordScheduleJobAccess) throw new Error("Schedule access recording is unavailable"); return success(await client.recordScheduleJobAccess(event_id,receipt)); }
    catch(error){return failure(error,logger,"record_schedule_job_access");}
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

  server.registerTool("preview_schedule", { title: "Preview schedule", description: "作成前に固定宛先・権限期限・有限occurrenceを確認します。", inputSchema: { source_event_id: eventId, definition: scheduleDefinition, after: z.string(), before_or_equal: z.string(), limit: z.number().int().min(1).max(100) }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async input => { try { return success(await client.previewSchedule(input)); } catch (e) { return failure(e, logger, "preview_schedule"); } });
  server.registerTool("create_schedule", { title: "Create schedule", description: "現在のSlack event contextへserver-side bindingしてscheduleを作成します。timeout時は同じidempotency_keyをblind retryせずget/listで照合します。", inputSchema: { source_event_id: eventId, idempotency_key: scheduleIdempotencyKey, definition: scheduleDefinition }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async input => { try { return success(await client.createSchedule(input)); } catch (e) { return failure(e, logger, "create_schedule"); } });
  server.registerTool("get_schedule", { title: "Get schedule", description: "所有するscheduleの安全な投影を取得します。", inputSchema: { source_event_id: eventId, schedule_id: scheduleId }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({source_event_id, schedule_id}) => { try { return success(await client.getSchedule(schedule_id, source_event_id)); } catch (e) { return failure(e, logger, "get_schedule"); } });
  server.registerTool("list_schedules", { title: "List schedules", description: "所有するscheduleをbounded paginationで列挙します。", inputSchema: { source_event_id: eventId, limit: z.number().int().min(1).max(100).default(50), cursor: scheduleListCursor.optional() }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({source_event_id, limit, cursor}) => { try { return success(await client.listSchedules(source_event_id, limit, cursor)); } catch (e) { return failure(e, logger, "list_schedules"); } });
  server.registerTool("update_schedule", { title: "Update schedule", description: "optimistic revisionと新しいevent authorizationでscheduleを更新します。", inputSchema: { source_event_id: eventId, schedule_id: scheduleId, expected_revision: z.number().int().positive(), definition: scheduleDefinition }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async ({schedule_id, ...input}) => { try { return success(await client.updateSchedule(schedule_id, input)); } catch (e) { return failure(e, logger, "update_schedule"); } });
  for (const operation of ["pause", "resume", "cancel"] as const) server.registerTool(`${operation}_schedule`, { title: `${operation} schedule`, description: `optimistic revisionでscheduleを${operation}します。`, inputSchema: { source_event_id: eventId, schedule_id: scheduleId, expected_revision: z.number().int().positive() }, annotations: { readOnlyHint: false, destructiveHint: operation === "pause" || operation === "cancel", idempotentHint: true, openWorldHint: false } }, async ({source_event_id, schedule_id, expected_revision}) => { try { return success(await client.transitionSchedule(schedule_id, operation, {source_event_id, expected_revision})); } catch (e) { return failure(e, logger, `${operation}_schedule`); } });
  server.registerTool("get_schedule_history", { title: "Get schedule history", description: "run statusをbounded paginationで取得します。", inputSchema: { source_event_id: eventId, schedule_id: scheduleId, limit: z.number().int().min(1).max(100).default(50), cursor: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\|run_[0-9a-f-]{36}$/).optional() }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({source_event_id, schedule_id, limit, cursor}) => { try { return success(await client.getScheduleHistory(schedule_id, source_event_id, limit, cursor)); } catch (e) { return failure(e, logger, "get_schedule_history"); } });

  return server;
}
