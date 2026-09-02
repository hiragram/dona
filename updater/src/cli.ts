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
  const defaultPolicy = path.join(os.homedir(), "Library", "Application Support", "Dona", "update-control", "policy.json");
  const policy = loadPolicy(process.env.DONA_UPDATE_POLICY_PATH ?? defaultPolicy);
  const logger = createLogger();
  const database = new UpdateDatabase(path.join(policy.control_root, "updater.sqlite3"));
  const releases = new ReleaseStore(policy);
  const controller = new UpdateController(
    database,
    policy,
    new RealGit(policy),
    new CanonicalBuild(policy),
    releases,
    new RealRuntime(policy),
    new RealDispatcher(policy),
    logger,
  );
  const command = process.argv[2] ?? "serve";
  try {
    if (command === "status") {
      const requestId = process.argv[3];
      if (process.argv.length > (requestId ? 4 : 3)) usage();
      console.log(JSON.stringify(await controller.status(requestId ? parseRequestId(requestId) : undefined), null, 2));
      return;
    }
    if (command === "doctor") {
      if (process.argv.length !== 3) usage();
      console.log(JSON.stringify(await controller.doctor(), null, 2));
      return;
    }
    if (command === "reconcile") {
      if (process.argv.length !== 4) usage();
      console.log(JSON.stringify(await controller.reconcile(parseRequestId(process.argv[3])), null, 2));
      return;
    }
    if (command === "rollback") {
      if (process.argv.length !== 6 || process.argv[4] !== "--confirm-plan-hash" || !/^[0-9a-f]{64}$/.test(process.argv[5] ?? "")) usage();
      console.log(JSON.stringify(await controller.operatorRollback(parseRequestId(process.argv[3]), process.argv[5]!), null, 2));
      return;
    }
    if (command !== "serve" || process.argv.length !== 3) usage();
    const service = new UpdateService(controller, logger);
    const api = new UpdaterApi(path.join(policy.control_root, "updater.sock"), controller, database, service, logger);
    service.start();
    await api.start();
    await new Promise<void>((resolve, reject) => {
      let stopping = false;
      const stop = async (signal: NodeJS.Signals): Promise<void> => {
        if (stopping) return;
        stopping = true;
        logger.info("Updater shutdown started", { signal });
        try {
          await api.stop();
          await service.stop();
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
