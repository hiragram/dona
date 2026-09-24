#!/usr/bin/env node
import "dotenv/config";

import { loadConfig } from "./config.js";
import { DispatcherDatabase } from "./database.js";
import { eventStatuses, jobStatuses, type EventStatus, type JobStatus } from "./types.js";
import { runService } from "./service.js";
import { SlackAdapterJobNotificationVerifier } from "./job-notification-verifier.js";
import { HerdrJobAgentRuntime } from "./job-runtime.js";
import { JobSupervisor } from "./job-supervisor.js";
import { createLogger } from "./logger.js";
import { liveSessionReceiptRetentionSeconds } from "./live-session.js";

function projectLiveJob(row: Record<string, unknown>): Record<string, unknown> {
  const safeKeys = [
    "job_id", "source_event_id", "job_key", "status", "created_at", "updated_at", "completed_at",
    "dispatch_started_at", "prompt_accepted_at", "last_error_code", "steer_event_id", "steer_state",
    "completion_event_id",
  ];
  return Object.fromEntries(safeKeys.filter((key) => key in row).map((key) => [key, row[key]]));
}

function usage(): never {
  console.error(`Usage:
  dona-dispatcher serve
  dona-dispatcher event list [--status STATUS]
  dona-dispatcher event show <event_id>
  dona-dispatcher event retry <event_id> [--force]
  dona-dispatcher event complete <event_id>
  dona-dispatcher event reconcile-notification <event_id> <workspace_id> <channel_id> <message_ts> [thread_ts] [--resume]
  dona-dispatcher event reconcile-notification <event_id> not_sent [--resume]
  dona-dispatcher event dead-letter <event_id>
  dona-dispatcher job list [--status STATUS]
  dona-dispatcher job show <job_id> [--live-session | --live-session-receipt <receipt_id>]
  dona-dispatcher job live-session-retention [--apply --force]
  dona-dispatcher job reconcile-run <run_id> <failed|cancelled>
  dona-dispatcher job resolve-invalid-result <job_id> <receipt_id> <expected_updated_at> --worker-stopped-reviewed --side-effects-reviewed
  dona-dispatcher job resolve-failed-attention <source_event_id> <job_id> <attention_event_id> <expected_updated_at> --notification-reviewed --side-effects-reviewed
  dona-dispatcher job resolve-review-attention <source_event_id> <job_id> <attention_event_id> <receipt_id> <expected_updated_at> --worker-stopped-reviewed --side-effects-reviewed
  dona-dispatcher job attention-recovery <source_event_id>
  dona-dispatcher job reconcile-attention-delivery <source_event_id> <attention_event_id> <expected_event_updated_at> <message_ts> <body_sha256> --notification-reviewed [--resume <claim_token>]
  dona-dispatcher scheduler health
  dona-dispatcher scheduler outbox [--status STATUS] [--limit N]
  dona-dispatcher scheduler retention [--apply --force]`);
  process.exit(2);
}

function eventIdAt(args: string[], index: number): string {
  const value = args[index];
  if (!value) usage();
  return value;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "serve") {
    await runService(config);
    return;
  }
  if (!["event", "job", "scheduler"].includes(args[0]!)) usage();
  const command = args[1];
  const database = new DispatcherDatabase(config.databasePath, {
    jobsPerEventMax: config.jobsPerEventMax,
    jobObjectiveTotalMaxBytes: config.jobObjectiveTotalMaxBytes,
  });
  try {
    if (args[0] === "scheduler") {
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      if (command === "health") { console.log(JSON.stringify(database.scheduler.operationalSnapshot(now), null, 2)); return; }
      if (command === "outbox") {
        const statusAt=args.indexOf("--status"),limitAt=args.indexOf("--limit");
        if ((statusAt >= 0 && !args[statusAt+1]) || (limitAt >= 0 && !args[limitAt+1])) usage();
        console.log(JSON.stringify(database.scheduler.listOutbox(statusAt<0?undefined:args[statusAt+1] as never,
          limitAt<0?50:Number(args[limitAt+1])),null,2)); return;
      }
      if (command === "retention") {
        const plan=database.scheduler.retentionPlan(now);
        if (!args.includes("--apply")) { console.log(JSON.stringify({dry_run:true,...plan},null,2)); return; }
        if (!args.includes("--force")) throw new Error("retention apply requires --force; run without --apply for dry-run");
        database.scheduler.purge(now); console.log(JSON.stringify({dry_run:false,...plan},null,2)); return;
      }
      usage();
    }
    if (args[0] === "job") {
      if (command === "list") {
        const statusIndex = args.indexOf("--status");
        const status = statusIndex === -1 ? undefined : args[statusIndex + 1];
        if (status !== undefined && !jobStatuses.includes(status as JobStatus)) usage();
        console.log(JSON.stringify(database.listJobs(status as JobStatus | undefined), null, 2));
        return;
      }
      if (command === "show") {
        const jobId = eventIdAt(args, 2);
        const row = database.getJob(jobId);
        if (!row) throw new Error(`Job ${jobId} was not found`);
        const receiptAt=args.indexOf("--live-session-receipt");
        if(args.includes("--live-session")&&receiptAt>=0)usage();
        if(receiptAt>=0){const receiptId=args[receiptAt+1];if(!receiptId)usage();const receipt=database.getLiveSessionReceipt(jobId,receiptId);
          if(!receipt)throw new Error("Live session receipt was not found");console.log(JSON.stringify({schema_version:1,job:projectLiveJob(row as unknown as Record<string,unknown>),live_session:receipt.live_session,
            reconciliation:receipt.reconciliation,receipt:{receipt_id:receipt.receipt_id,observed_at:receipt.observed_at,boot_id:receipt.boot_id,
              durable_status_before:receipt.durable_status_before,durable_status_after:receipt.durable_status_after,
              result_present_before:receipt.result_present_before,result_present_after:receipt.result_present_after}},null,2));return;}
        if(args.includes("--live-session")){const supervisor=new JobSupervisor(database,new HerdrJobAgentRuntime(config,false),config,createLogger("dispatcher_cli"),()=>{});
          const receipt=await supervisor.observeLiveSession(jobId);const refreshed=database.getJob(jobId);if(!refreshed)throw new Error(`Job ${jobId} disappeared during live observation`);console.log(JSON.stringify({schema_version:1,job:projectLiveJob(refreshed as unknown as Record<string,unknown>),live_session:receipt.live_session,
            reconciliation:receipt.reconciliation,receipt:{receipt_id:receipt.receipt_id,observed_at:receipt.observed_at,boot_id:receipt.boot_id,
              durable_status_before:receipt.durable_status_before,durable_status_after:receipt.durable_status_after,
              result_present_before:receipt.result_present_before,result_present_after:receipt.result_present_after}},null,2));return;}
        console.log(JSON.stringify(row, null, 2));
        return;
      }
      if(command==="live-session-retention"){
        const cutoff=new Date(Date.now()-liveSessionReceiptRetentionSeconds*1000).toISOString();
        const plan=database.liveSessionRetentionPlan(cutoff);
        if(!args.includes("--apply")){console.log(JSON.stringify({dry_run:true,cutoff,...plan},null,2));return;}
        if(!args.includes("--force"))throw new Error("live session retention apply requires --force; run without --apply for dry-run");
        console.log(JSON.stringify({dry_run:false,cutoff,...database.purgeLiveSessionReceipts(cutoff)},null,2));return;
      }
      if(command==="reconcile-run") {
        const runId=eventIdAt(args,2),outcome=args[3];if(outcome!=="failed"&&outcome!=="cancelled")usage();
        console.log(JSON.stringify(database.reconcileScheduledRun(runId,outcome),null,2));return;
      }
      if(command==="resolve-invalid-result") {
        if(args.length!==7 || args[5]!=="--worker-stopped-reviewed" || args[6]!=="--side-effects-reviewed") usage();
        const jobId=eventIdAt(args,2),receiptId=eventIdAt(args,3),expectedUpdatedAt=eventIdAt(args,4);
        const row=database.resolveInvalidJobResult(jobId,receiptId,expectedUpdatedAt);
        console.log(JSON.stringify({job_id:row.job_id,status:row.status,updated_at:row.updated_at,last_error_code:row.last_error_code},null,2));return;
      }
      if(command==="resolve-failed-attention") {
        if(args.length!==8 || args[6]!=="--notification-reviewed" || args[7]!=="--side-effects-reviewed") usage();
        const sourceEventId=eventIdAt(args,2),jobId=eventIdAt(args,3),attentionEventId=eventIdAt(args,4),expectedUpdatedAt=eventIdAt(args,5);
        const row=database.resolveFailedJobAttention(sourceEventId,jobId,attentionEventId,expectedUpdatedAt);
        console.log(JSON.stringify({job_id:row.job_id,status:row.status,updated_at:row.updated_at,
          group:database.getJobGroup(sourceEventId)},null,2));return;
      }
      if(command==="resolve-review-attention") {
        if(args.length!==9 || args[7]!=="--worker-stopped-reviewed" || args[8]!=="--side-effects-reviewed") usage();
        const sourceEventId=eventIdAt(args,2),jobId=eventIdAt(args,3),attentionEventId=eventIdAt(args,4);
        const row=database.resolveNeedsReviewAttention(sourceEventId,jobId,attentionEventId,eventIdAt(args,5),eventIdAt(args,6));
        console.log(JSON.stringify({job_id:row.job_id,status:row.status,updated_at:row.updated_at,
          group:database.getJobGroup(sourceEventId)},null,2));return;
      }
      if(command==="attention-recovery") {
        if(args.length!==3)usage();
        const sourceEventId=eventIdAt(args,2);
        console.log(JSON.stringify({group:database.getJobGroup(sourceEventId),
          legacy_claim:database.getLegacyAttentionClaim(sourceEventId)},null,2));return;
      }
      if(command==="reconcile-attention-delivery") {
        if((args.length!==8 && args.length!==10) || args[7]!=="--notification-reviewed" ||
          (args.length===10 && args[8]!=="--resume")) usage();
        const sourceEventId=eventIdAt(args,2),attentionEventId=eventIdAt(args,3),expectedUpdatedAt=eventIdAt(args,4);
        const messageTs=eventIdAt(args,5),bodySha256=eventIdAt(args,6);
        const claim=args.length===10
          ? database.resumeAttentionDeliveryReconciliation(sourceEventId,attentionEventId,expectedUpdatedAt,messageTs,bodySha256,eventIdAt(args,9))
          : database.claimAttentionDeliveryReconciliation(sourceEventId,attentionEventId,expectedUpdatedAt,messageTs,bodySha256);
        console.log(JSON.stringify({attention_event_id:attentionEventId,claim_token:claim.claimToken,status:"claimed"}));
        const evidence=await new SlackAdapterJobNotificationVerifier(config).settle(claim.request);
        database.recordVerifiedAttentionDelivery(sourceEventId,attentionEventId,expectedUpdatedAt,claim.claimToken,evidence);
        console.log(JSON.stringify({source_event_id:sourceEventId,attention_event_id:attentionEventId,verified:true},null,2));return;
      }
      usage();
    }
    if (command === "list") {
      const statusIndex = args.indexOf("--status");
      const status = statusIndex === -1 ? undefined : args[statusIndex + 1];
      if (status !== undefined && !eventStatuses.includes(status as EventStatus)) usage();
      console.log(JSON.stringify(database.list(status as EventStatus | undefined), null, 2));
      return;
    }
    if (command === "show") {
      const eventId = eventIdAt(args, 2);
      const row = database.get(eventId);
      if (!row) throw new Error(`Event ${eventId} was not found`);
      console.log(JSON.stringify(row, null, 2));
      return;
    }
    if (command === "retry") {
      const eventId = eventIdAt(args, 2);
      const row = database.get(eventId);
      if (!row) throw new Error(`Event ${eventId} was not found`);
      console.error(`Current status: ${row.status}. Retrying can duplicate side effects if prompt acceptance was ambiguous.`);
      console.log(JSON.stringify(database.manualRetry(eventId, args.includes("--force")), null, 2));
      return;
    }
    if (command === "complete") {
      console.log(JSON.stringify(database.manualComplete(eventIdAt(args, 2)), null, 2));
      return;
    }
    if(command==="reconcile-notification") {
      if(args[3]==="not_sent") {
        const eventId=eventIdAt(args,2),claim=database.claimNotificationReconciliation(eventId,args.includes("--resume")),settlement=database.notificationSessionSettlementRequest(eventId);
        if(settlement)await new SlackAdapterJobNotificationVerifier(config).settleSession(settlement);
        console.log(JSON.stringify(database.reconcileScheduledNotificationNotSent(eventId,new Date(),claim),null,2));return;
      }
      const eventId=eventIdAt(args,2),workspaceId=eventIdAt(args,3),channelId=eventIdAt(args,4),messageTs=eventIdAt(args,5),threadTs=args[6]==="--resume"?undefined:args[6];
      const claim=database.claimNotificationReconciliation(eventId,args.includes("--resume"));
      const verification=database.notificationReconciliationVerificationRequest(eventId,{workspace_id:workspaceId,channel_id:channelId,message_ts:messageTs,...(threadTs?{thread_ts:threadTs}:{})});
      if(!verification) throw new Error("scheduled_notification_verification_unavailable");
      const verifier=new SlackAdapterJobNotificationVerifier(config); await verifier.verify(verification); if(verification.desired_session_status)await verifier.settle(verification);
      console.log(JSON.stringify(database.reconcileScheduledNotification(eventId,{workspace_id:workspaceId,channel_id:channelId,message_ts:messageTs,...(threadTs?{thread_ts:threadTs}:{})},new Date(),claim),null,2));
      return;
    }
    if (command === "dead-letter") {
      console.log(JSON.stringify(database.manualDeadLetter(eventIdAt(args, 2)), null, 2));
      return;
    }
    usage();
  } finally {
    database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
