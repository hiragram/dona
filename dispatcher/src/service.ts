import type { DispatcherConfig } from "./config.js";
import { DispatcherApi } from "./api.js";
import { DispatcherDatabase } from "./database.js";
import { HerdrProcessClient } from "./herdr.js";
import { HerdrJobAgentRuntime } from "./job-runtime.js";
import { JobSupervisor } from "./job-supervisor.js";
import { createLogger } from "./logger.js";
import { DispatcherWorker } from "./worker.js";
import { UpdaterClient } from "./updater-client.js";

export async function runService(config: DispatcherConfig): Promise<void> {
  const apiLogger = createLogger("dispatcher_api");
  const workerLogger = createLogger("dispatcher_worker");
  const database = new DispatcherDatabase(config.databasePath);
  const herdr = new HerdrProcessClient({
    executable: config.herdrPath,
    session: config.herdrSession,
    agentName: config.agentName,
    waitTimeoutMs: config.agentWaitTimeoutMs,
  });
  const worker = new DispatcherWorker(database, herdr, config, workerLogger);
  const jobSupervisor = new JobSupervisor(
    database,
    new HerdrJobAgentRuntime(config),
    config,
    createLogger("dispatcher_jobs"),
    () => worker.wake(),
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
        worker.quiesceAfterCurrent();
        await jobSupervisor.stop();
      },
    },
  );

  try {
    await api.start();
    worker.start();
    jobSupervisor.start();
  } catch (error) {
    if (jobSupervisor.isRunning()) await jobSupervisor.stop();
    if (worker.isRunning()) await worker.stop();
    database.close();
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
        await jobSupervisor.stop();
        await worker.stop();
        database.close();
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    process.once("SIGINT", () => void stop("SIGINT"));
    process.once("SIGTERM", () => void stop("SIGTERM"));
  });
}
