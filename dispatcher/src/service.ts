import type { DispatcherConfig } from "./config.js";
import { DispatcherApi } from "./api.js";
import { DispatcherDatabase } from "./database.js";
import { HerdrProcessClient } from "./herdr.js";
import { HerdrJobAgentRuntime } from "./job-runtime.js";
import { JobSupervisor } from "./job-supervisor.js";
import { createLogger } from "./logger.js";
import { SystemClock } from "./scheduler/clock.js";
import { SchedulerService } from "./scheduler/service.js";
import { DispatcherWorker } from "./worker.js";
import { UpdaterClient } from "./updater-client.js";
import {
  SlackAdapterNotificationClient,
  UpdateNotificationDatabase,
  UpdateNotificationWorker,
} from "./update-notification.js";

export async function runService(config: DispatcherConfig): Promise<void> {
  const apiLogger = createLogger("dispatcher_api");
  const workerLogger = createLogger("dispatcher_worker");
  const database = new DispatcherDatabase(config.databasePath);
  const updateNotificationDatabase = new UpdateNotificationDatabase(config.updateNotificationDatabasePath);
  const herdr = new HerdrProcessClient({
    executable: config.herdrPath,
    session: config.herdrSession,
    agentName: config.agentName,
    waitTimeoutMs: config.agentWaitTimeoutMs,
  });
  const worker = new DispatcherWorker(database, herdr, config, workerLogger);
  const scheduler = new SchedulerService(
    database.scheduler,
    new SystemClock(),
    () => worker.wake(),
    createLogger("dispatcher_scheduler"),
    { pollMilliseconds: Math.min(config.queuePollMs, 60_000) },
  );
  const jobSupervisor = new JobSupervisor(
    database,
    new HerdrJobAgentRuntime(config),
    config,
    createLogger("dispatcher_jobs"),
    () => worker.wake(),
  );
  const updateNotificationWorker = new UpdateNotificationWorker(
    database,
    updateNotificationDatabase,
    new SlackAdapterNotificationClient(config),
    config,
    createLogger("dispatcher_update_notifications"),
  );
  const api = new DispatcherApi(
    database,
    worker,
    jobSupervisor,
    config,
    apiLogger,
    new UpdaterClient(config.updaterSocketPath, config.jobCommandTimeoutMs),
    {
      async quiesce() {
        await scheduler.stop();
        worker.quiesceAfterCurrent();
        await updateNotificationWorker.stop();
        await jobSupervisor.stop();
      },
    },
    updateNotificationWorker,
    undefined,
    () => scheduler.wake(),
  );

  try {
    await api.start();
    worker.start();
    scheduler.start();
    jobSupervisor.start();
    updateNotificationWorker.start();
  } catch (error) {
    if (updateNotificationWorker.isRunning()) await updateNotificationWorker.stop();
    if (jobSupervisor.isRunning()) await jobSupervisor.stop();
    if (scheduler.isRunning()) await scheduler.stop();
    if (worker.isRunning()) await worker.stop();
    database.close();
    updateNotificationDatabase.close();
    throw error;
  }

  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const stop = async (signal: NodeJS.Signals): Promise<void> => {
      if (stopping) return;
      stopping = true;
      apiLogger.info("Graceful shutdown started", { signal });
      try {
        api.beginShutdown();
        await api.stop();
        await scheduler.stop();
        await updateNotificationWorker.stop();
        await jobSupervisor.stop();
        await worker.stop();
        database.close();
        updateNotificationDatabase.close();
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    process.once("SIGINT", () => void stop("SIGINT"));
    process.once("SIGTERM", () => void stop("SIGTERM"));
  });
}
