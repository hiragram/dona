import fs from "node:fs/promises";

import type { ResultEnvelope } from "./types.js";
import { parseResultEnvelope } from "./validation.js";

export const RESULT_MAX_BYTES = 1_048_576;

export class ResultNotFoundError extends Error {
  constructor(resultPath: string) {
    super(`Result file was not found: ${resultPath}`);
    this.name = "ResultNotFoundError";
  }
}

export async function readResultEnvelope(resultPath: string, eventId: string): Promise<ResultEnvelope> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(resultPath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ResultNotFoundError(resultPath);
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("Result path is not a regular file");
    if (stats.size > RESULT_MAX_BYTES) throw new Error("Result file exceeds 1 MiB");
    const content = await handle.readFile({ encoding: "utf8" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("Result file is not valid JSON");
    }
    return parseResultEnvelope(parsed, eventId);
  } finally {
    await handle.close();
  }
}
