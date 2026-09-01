import fs from "node:fs/promises";

import type { JobResultEnvelope } from "./types.js";
import { parseJobResultEnvelope } from "./validation.js";

export class JobResultNotFoundError extends Error {
  constructor(resultPath: string) {
    super(`Job result file was not found: ${resultPath}`);
    this.name = "JobResultNotFoundError";
  }
}

export async function readJobResultEnvelope(resultPath: string, jobId: string): Promise<JobResultEnvelope> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(resultPath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new JobResultNotFoundError(resultPath);
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("Job result path is not a regular file");
    if (stats.size > 1_048_576) throw new Error("Job result file exceeds 1 MiB");
    const content = await handle.readFile({ encoding: "utf8" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("Job result file is not valid JSON");
    }
    return parseJobResultEnvelope(parsed, jobId);
  } finally {
    await handle.close();
  }
}
