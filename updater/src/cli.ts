#!/usr/bin/env node
import os from "node:os";
import path from "node:path";

import { CanonicalBuild, RealDispatcher, RealGit, RealRuntime } from "./adapters.js";
import { UpdaterApi } from "./api.js";
import { UpdateController } from "./controller.js";
import { UpdateDatabase } from "./database.js";
import { createLogger } from "./logger.js";
import { loadPolicy } from "./policy.js";
import { redactText } from "./redaction.js";
import { ReleaseStore } from "./release-store.js";
import { UpdateService } from "./service.js";
import { parseRequestId } from "./validation.js";
import { DiagnosticLogStore } from "./diagnostic-log.js";
import { initializeServe } from "./serve-bootstrap.js";

function usage(): never {
  console.error(`Usage:
  dona-updater serve
  dona-updater status [request_id]
  dona-updater doctor
  dona-updater reconcile <request_id>
  dona-updater rollback <request_id> --confirm-plan-hash <64-hex-hash>

plan/apply/cancel are exposed through the typed Dispatcher MCP surface.
rollback requires an exact compatible request and explicit plan-hash confirmation.`);
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "serve";
  let requestId: string | undefined;
  let confirmedPlanHash: string | undefined;
  if (command === "status") {
    if (argv.length > 2) usage();
    requestId = argv[1] ? parseRequestId(argv[1]) : undefined;
  } else if (command === "doctor") {
    if (argv.length !== 1) usage();
  } else if (command === "reconcile") {
    if (argv.length !== 2) usage();
    requestId = parseRequestId(argv[1]!);
  } else if (command === "rollback") {
    if (argv.length !== 4 || argv[2] !== "--confirm-plan-hash" || !/^[0-9a-f]{64}$/.test(argv[3] ?? "")) usage();
    requestId = parseRequestId(argv[1]!);
    confirmedPlanHash = argv[3]!;
  } else if (command !== "serve" || argv.length !== 1) {
    usage();
  }

  const defaultPolicy = path.join(os.homedir(), "Library", "Application Support", "Dona", "update-control", "policy.json");
  const policy = loadPolicy(process.env.DONA_UPDATE_POLICY_PATH ?? defaultPolicy);
  const logger = createLogger();
  const database = new UpdateDatabase(path.join(policy.control_root, "updater.sqlite3"), {
    readonly: command === "status" || command === "doctor",
  });
  const diagnostics = new DiagnosticLogStore(policy.control_root, policy.diagnostic_log_limit_bytes, database, [
    policy.config_root,
    policy.release_root,
    path.dirname(policy.current_pointer),
  ]);
  const releases = new ReleaseStore(policy);
  const controller = new UpdateController(
    database,
    policy,
    new RealGit(policy),
    new CanonicalBuild(policy, undefined, diagnostics),
    releases,
    new RealRuntime(policy),
    new RealDispatcher(policy),
    logger,
    undefined,
    undefined,
    diagnostics,
  );
  try {
    if (command === "status") {
      console.log(JSON.stringify(await controller.status(requestId), null, 2));
      return;
    }
    if (command === "doctor") {
      console.log(JSON.stringify(await controller.doctor(), null, 2));
      return;
    }
    if (command === "reconcile") {
      console.log(JSON.stringify(await controller.reconcile(requestId!), null, 2));
      return;
    }
    if (command === "rollback") {
      console.log(JSON.stringify(await controller.operatorRollback(requestId!, confirmedPlanHash!), null, 2));
      return;
    }
    const service = new UpdateService(controller, logger);
    const api = new UpdaterApi(path.join(policy.control_root, "updater.sock"), controller, database, service, logger);
    await initializeServe(api, diagnostics, controller, service);
    await new Promise<void>((resolve, reject) => {
      let stopping = false;
      const stop = async (signal: NodeJS.Signals): Promise<void> => {
        if (stopping) return;
        stopping = true;
        logger.info("Updater shutdown started", { signal });
        try {
          await service.stop();
          await api.stop();
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      process.once("SIGINT", () => void stop("SIGINT"));
      process.once("SIGTERM", () => void stop("SIGTERM"));
    });
  } finally {
    database.close();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    component: "updater",
    message: "Updater failed",
    error_code: "updater_failed",
    error_message: redactText(error instanceof Error ? error.message : String(error)),
  }));
  process.exitCode = 1;
});
