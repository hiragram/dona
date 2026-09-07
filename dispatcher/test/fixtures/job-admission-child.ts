import { DispatcherDatabase, JobCreationError } from "../../src/database.js";
import type { CreateJobRequest } from "../../src/types.js";

type Input = {
  databasePath: string;
  limits: { jobsPerEventMax: number; jobObjectiveTotalMaxBytes: number };
  workspaceRoot: string;
  resultDir: string;
  request: CreateJobRequest;
};

// Each process opens its own connection before the parent releases the barrier.
process.once("message", (input: Input) => {
  const database = new DispatcherDatabase(input.databasePath, input.limits);
  process.once("message", () => {
    try {
      const result = database.createJob(input.request, input.workspaceRoot, input.resultDir);
      process.send!({ outcome: result.outcome, jobId: result.row.job_id });
    } catch (error) {
      if (!(error instanceof JobCreationError)) throw error;
      process.send!({ code: error.code, details: error.limitDetails });
    } finally {
      database.close();
      process.disconnect();
    }
  });
  process.send!({ ready: true });
});
