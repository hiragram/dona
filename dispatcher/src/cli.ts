#!/usr/bin/env node
import "dotenv/config";

import { loadConfig } from "./config.js";
import { DispatcherDatabase } from "./database.js";
import { eventStatuses, jobStatuses, type EventStatus, type JobStatus } from "./types.js";
import { runService } from "./service.js";

function usage(): never {
  console.error(`Usage:
  dona-dispatcher serve
  dona-dispatcher queue status
  dona-dispatcher queue deliveries <event_id>
  dona-dispatcher event list [--status STATUS]
  dona-dispatcher event show <event_id>
  dona-dispatcher event retry <event_id> [--force]
  dona-dispatcher event complete <event_id>
  dona-dispatcher event dead-letter <event_id>
  dona-dispatcher job list [--status STATUS]
  dona-dispatcher job show <job_id>`);
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
  if (!["event", "job", "queue"].includes(args[0]!)) usage();
  const command = args[1];
  const database = new DispatcherDatabase(config.databasePath, config.queuePolicy);
  try {
    if (args[0] === "queue") {
      if (command === "status") { console.log(JSON.stringify(database.queueHealth(),null,2)); return; }
      if (command === "deliveries") { console.log(JSON.stringify(database.queueDispatchMetadata(eventIdAt(args,2)),null,2)); return; }
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
        console.log(JSON.stringify(row, null, 2));
        return;
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
