import type { DispatcherConfig } from "./config.js";
import { DispatcherApi } from "./api.js";
import { DispatcherDatabase } from "./database.js";
import { HerdrProcessClient } from "./herdr.js";
import { HerdrJobAgentRuntime } from "./job-runtime.js";
import { JobSupervisor } from "./job-supervisor.js";
import { SlackAdapterJobNotificationVerifier } from "./job-notification-verifier.js";
import { createLogger } from "./logger.js";
import { SystemClock } from "./scheduler/clock.js";
import { SchedulerService } from "./scheduler/service.js";
import { ReminderPublisher, SlackAdapterReminderClient } from "./scheduler/reminder-publisher.js";
import { DispatcherWorker } from "./worker.js";
import { UpdaterClient } from "./updater-client.js";
import {
  SlackAdapterNotificationClient,
  UpdateNotificationDatabase,
  UpdateNotificationWorker,
} from "./update-notification.js";
import { JobProgressCoordinator, JobProgressStore } from "./job-progress.js";
import { WorkerInstructionBridge, WorkerMessagePublisher } from "./worker-messaging.js";

export async function runService(config: DispatcherConfig): Promise<void> {
  const apiLogger = createLogger("dispatcher_api");
  const workerLogger = createLogger("dispatcher_worker");
  const database = new DispatcherDatabase(config.databasePath, {
    jobsPerEventMax: config.jobsPerEventMax,
    jobObjectiveTotalMaxBytes: config.jobObjectiveTotalMaxBytes,
  });
  const updateNotificationDatabase = new UpdateNotificationDatabase(config.updateNotificationDatabasePath);
  let jobProgressStore: JobProgressStore | undefined;
  try {
    jobProgressStore = new JobProgressStore(config.jobProgressDatabasePath);
  } catch (error) {
    apiLogger.warn("Job progress disabled after initialization failure", {
      error_code: "job_progress_initialization_failed",
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
  const herdr = new HerdrProcessClient({
    executable: config.herdrPath,
    session: config.herdrSession,
    agentName: config.agentName,
    waitTimeoutMs: config.agentWaitTimeoutMs,
  });
  let jobSupervisor!: JobSupervisor;
  let jobProgress = jobProgressStore
    ? new JobProgressCoordinator(database, jobProgressStore, config, createLogger("dispatcher_job_progress"))
    : undefined;
  const worker = new DispatcherWorker(database, herdr, config, workerLogger,new SlackAdapterJobNotificationVerifier(config), () => jobSupervisor.wake());
  const workerMessagePublisher = new WorkerMessagePublisher(database.workerMessages,()=>worker.wake(),Math.min(config.queuePollMs,30_000),
    () => apiLogger.warn("Worker message publication deferred", { error_code: "worker_message_publication_deferred" }));
  const scheduler = new SchedulerService(
    database.scheduler,
    new SystemClock(),
    () => worker.wake(),
    createLogger("dispatcher_scheduler"),
    { pollMilliseconds: Math.min(config.queuePollMs, 60_000) },
  );
  const reminderPublisher = new ReminderPublisher(database.scheduler, new SlackAdapterReminderClient(config),
    new SystemClock(), createLogger("dispatcher_slack_reminders"), Math.min(config.queuePollMs, 60_000));
  jobSupervisor = new JobSupervisor(
    database,
    new HerdrJobAgentRuntime(config, jobProgress !== undefined),
    config,
    createLogger("dispatcher_jobs"),
    () => worker.wake(),
    jobProgress,
  );
  const workerInstructionBridge = new WorkerInstructionBridge(database.workerMessages,jobSupervisor,
    Math.min(config.queuePollMs,1_000),error=>apiLogger.warn("Worker instruction delivery deferred",{
      error_code:"worker_instruction_delivery_deferred",error_message:error instanceof Error?error.message:String(error),
    }));
  if (!jobProgressStore) await jobSupervisor.disableProgress();
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
        workerMessagePublisher.stop();
        workerInstructionBridge.beginShutdown();
        await reminderPublisher.stop();
        worker.quiesceAfterCurrent();
        await updateNotificationWorker.stop();
        await jobSupervisor.stop();
        await workerInstructionBridge.stop();
      },
    },
    updateNotificationWorker,
    jobProgress,
    undefined,
    () => scheduler.wake(),
    scheduler,
  );

  try {
    await api.start();
    // Clear stale/expired outbox fences before due materialization decides overlap for a newer occurrence.
    database.scheduler.recover(new SystemClock().now(), true);
    jobSupervisor.recoverStaleJobs();
    try { await jobProgress?.recover(); }
    catch (error) {
      if((error as Error&{progressRecoveryDeferred?:boolean}).progressRecoveryDeferred&&jobProgress){
        apiLogger.warn("Job progress recovery deferred without releasing delivery fences",{
          error_code:"job_progress_recovery_deferred",
          error_message:error instanceof Error?error.message:String(error),
        });
        void jobProgress.recoverInBackground();
      } else {
      apiLogger.warn("Job progress disabled after recovery failure", {
        error_code: "job_progress_recovery_failed",
        error_message: error instanceof Error ? error.message : String(error),
      });
      jobProgressStore?.close();
      jobProgressStore = undefined;
      jobProgress = undefined;
      await jobSupervisor.disableProgress();
      api.disableJobProgress();
      }
    }
    worker.start();
    workerMessagePublisher.start();
    scheduler.start();
    reminderPublisher.start();
    jobSupervisor.start();
    workerInstructionBridge.start();
    updateNotificationWorker.start();
  } catch (error) {
    if (updateNotificationWorker.isRunning()) await updateNotificationWorker.stop();
    workerInstructionBridge.beginShutdown();
    if (jobSupervisor.isRunning()) await jobSupervisor.stop();
    await workerInstructionBridge.stop();
    if (scheduler.isRunning()) await scheduler.stop();
    workerMessagePublisher.stop();
    if (reminderPublisher.isRunning()) await reminderPublisher.stop();
    if (worker.isRunning()) await worker.stop();
    await api.stop();
    database.close();
    updateNotificationDatabase.close();
    jobProgressStore?.close();
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
        workerMessagePublisher.stop();
        workerInstructionBridge.beginShutdown();
        await reminderPublisher.stop();
        await updateNotificationWorker.stop();
        await jobSupervisor.stop();
        await workerInstructionBridge.stop();
        await worker.stop();
        database.close();
        updateNotificationDatabase.close();
        jobProgressStore?.close();
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    process.once("SIGINT", () => void stop("SIGINT"));
    process.once("SIGTERM", () => void stop("SIGTERM"));
  });
}
