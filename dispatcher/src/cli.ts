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
  dona-dispatcher human-wait repair --snapshot REVISION [--cursor CURSOR] [--limit N] [--apply --force]
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
  if (!["event", "job", "scheduler", "human-wait"].includes(args[0]!)) usage();
  const command = args[1];
  const database = new DispatcherDatabase(config.databasePath, {
    jobsPerEventMax: config.jobsPerEventMax,
    jobObjectiveTotalMaxBytes: config.jobObjectiveTotalMaxBytes,
  });
  try {
    if(args[0]==="human-wait") {
      if(command!=="repair")usage();
      let snapshotRevision:string|undefined,cursor:string|null=null,limit=100,apply=false,force=false;
      const seen=new Set<string>();
      for(let index=2;index<args.length;index++){
        const option=args[index]!;
        if(seen.has(option))usage();
        seen.add(option);
        if(option==="--apply"){apply=true;continue;}
        if(option==="--force"){force=true;continue;}
        const value=args[++index];if(!value)usage();
        if(option==="--snapshot")snapshotRevision=value;
        else if(option==="--cursor")cursor=value;
        else if(option==="--limit")limit=Number(value);
        else usage();
      }
      if(!snapshotRevision)usage();
      const dryRun=!apply;
      if(!dryRun&&!force)throw new Error("human wait repair apply requires --force; run without --apply for dry-run");
      if(dryRun&&force)usage();
      const result=database.humanWaits.repair({dryRun,limit,cursor,snapshotRevision});
      console.log(JSON.stringify({schema_version:1,...result},null,2));return;
    }
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
        let settledAt:Date;
        if(settlement) {
          const evidence=await new SlackAdapterJobNotificationVerifier(config).settleSession(settlement) as {event_id:string;workspace_id:string;channel_id:string;thread_ts:string|null;session_status:"active"|"suspended"|null};
          settledAt=new Date();
          if(settlement.desired_session_status==="suspended"&&!database.recordVerifiedNotificationSessionSettlement(eventId,evidence,settledAt))
            throw new Error("job_notification_session_settlement_not_recorded");
        } else settledAt=new Date();
        console.log(JSON.stringify(database.reconcileScheduledNotificationNotSent(eventId,settledAt,claim),null,2));return;
      }
      const eventId=eventIdAt(args,2),workspaceId=eventIdAt(args,3),channelId=eventIdAt(args,4),messageTs=eventIdAt(args,5),threadTs=args[6]==="--resume"?undefined:args[6];
      const claim=database.claimNotificationReconciliation(eventId,args.includes("--resume"));
      const verification=database.notificationReconciliationVerificationRequest(eventId,{workspace_id:workspaceId,channel_id:channelId,message_ts:messageTs,...(threadTs?{thread_ts:threadTs}:{})});
      if(!verification) throw new Error("scheduled_notification_verification_unavailable");
      const verifier=new SlackAdapterJobNotificationVerifier(config); await verifier.verify(verification); let settledAt:Date;
      if(verification.desired_session_status) {
        const evidence=await verifier.settle(verification);
        settledAt=new Date();
        if(verification.desired_session_status==="suspended"&&!database.recordVerifiedNotificationSessionSettlement(eventId,evidence,settledAt))
          throw new Error("job_notification_session_settlement_not_recorded");
      } else settledAt=new Date();
      console.log(JSON.stringify(database.reconcileScheduledNotification(eventId,{workspace_id:workspaceId,channel_id:channelId,message_ts:messageTs,...(threadTs?{thread_ts:threadTs}:{})},settledAt,claim),null,2));
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
