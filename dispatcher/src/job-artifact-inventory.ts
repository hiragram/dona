import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";

import type { DispatcherConfig } from "./config.js";
import { jobProgressPath, workspaceFromJob } from "./job-prompt.js";
import type { JobRow } from "./types.js";

type ScanState = "missing" | "unsafe" | "budget_exceeded" | "contract_mismatch" | "unmeasured_directory" | "unmeasured_file";
interface ArtifactObservation {
  kind: "worktree" | "progress" | "result";
  cleanup_state: ScanState;
  allocated_bytes: number | null;
}

export type InventoryRow = JobRow & { artifact_cursor: number };

export function readJobArtifactInventoryPage(databasePath: string, afterCursor: string, limit: number): InventoryRow[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 21 ||
    (afterCursor !== "" && (!/^(0|[1-9][0-9]*)$/.test(afterCursor) ||
      !Number.isSafeInteger(Number(afterCursor)))))
    throw new Error("artifact_inventory_cursor_or_limit_invalid");
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return database.prepare(`SELECT rowid AS artifact_cursor,job_id,workspace_json,workspace_path,result_path,status,created_at,completed_at
      FROM jobs WHERE rowid>? ORDER BY rowid LIMIT ?`).all(afterCursor === "" ? 0 : Number(afterCursor), limit) as InventoryRow[];
  } finally { database.close(); }
}

async function scanArtifact(root: string, trustedRoot: string, expectedType: "file" | "directory",
  budget: { entries: number; deadline: number }): Promise<Omit<ArtifactObservation, "kind">> {
  const relative = path.relative(trustedRoot, root);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return { cleanup_state: "contract_mismatch", allocated_bytes: null };
  let ancestor = trustedRoot;
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean).slice(0, -1)]) {
    if (segment) ancestor = path.join(ancestor, segment);
    let stats: Awaited<ReturnType<typeof fs.lstat>>;
    try { stats = await fs.lstat(ancestor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { cleanup_state: "missing", allocated_bytes: null };
      return { cleanup_state: "unsafe", allocated_bytes: null };
    }
    if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== process.getuid?.())
      return { cleanup_state: "unsafe", allocated_bytes: null };
  }
  if (++budget.entries > 10_000 || performance.now() > budget.deadline)
    return { cleanup_state: "budget_exceeded", allocated_bytes: null };
  let stats: Awaited<ReturnType<typeof fs.lstat>>;
  try { stats = await fs.lstat(root); }
  catch (error) {
    return { cleanup_state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe", allocated_bytes: null };
  }
  if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile()) || stats.uid !== process.getuid?.())
    return { cleanup_state: "unsafe", allocated_bytes: null };
  if (expectedType === "directory" ? !stats.isDirectory() : !stats.isFile())
    return { cleanup_state: "contract_mismatch", allocated_bytes: null };
  // Node's public fs API cannot inspect children relative to a held directory handle.
  // Do not open a file through ancestors that a running worker may replace.
  if (stats.isDirectory()) return { cleanup_state: "unmeasured_directory", allocated_bytes: null };
  return { cleanup_state: "unmeasured_file", allocated_bytes: null };
}

export async function inventoryJobArtifacts(row: JobRow, config: DispatcherConfig,
  budget = { entries: 0, deadline: performance.now() + 3_000 }): Promise<{
    job_id: string; status: JobRow["status"]; created_at: string; terminal_at: string | null;
    protection_reasons: string[]; artifacts: ArtifactObservation[];
  }> {
  const protection_reasons = row.status === "needs_review" ? ["needs_review"]
    : ["completed", "failed", "cancelled"].includes(row.status)
      ? ["notification_unverified", "retention_expiry_unverified"] : ["nonterminal"];
  const base = { job_id: row.job_id, status: row.status, created_at: row.created_at,
    terminal_at: row.completed_at, protection_reasons };
  const unsafeContract = () => ({ ...base, artifacts: (["worktree", "progress", "result"] as const).map((kind) =>
    ({ kind, cleanup_state: "contract_mismatch" as const, allocated_bytes: null })) });
  if (!/^job_[0-9a-hjkmnp-tv-z]{26}$/.test(row.job_id)) return unsafeContract();
  let workspace: ReturnType<typeof workspaceFromJob>;
  try { workspace = workspaceFromJob(row); }
  catch { return unsafeContract(); }
  const expectedWorkspace = workspace.kind === "scratch"
    ? path.join(config.jobsWorkspaceRoot, "scratch", row.job_id)
    : path.join(config.jobsWorkspaceRoot, "github", ...workspace.repository.split("/"), "worktrees", row.job_id);
  const isolatedResult = path.join(config.jobResultsDir, row.job_id, "result.json");
  const legacyResult = path.join(config.jobResultsDir, `${row.job_id}.json`);
  const expectedResult = row.result_path === legacyResult ? legacyResult : isolatedResult;
  const expectedProgress = path.join(path.dirname(expectedWorkspace), ".dona-progress", row.job_id, "progress.json");
  const candidates = [
    { kind: "worktree", actual: row.workspace_path, expected: expectedWorkspace, root: expectedWorkspace,
      trustedRoot: config.jobsWorkspaceRoot, expectedType: "directory" },
    { kind: "progress", actual: jobProgressPath(row), expected: expectedProgress, root: path.dirname(expectedProgress),
      trustedRoot: config.jobsWorkspaceRoot, expectedType: "directory" },
    { kind: "result", actual: row.result_path, expected: expectedResult,
      root: expectedResult === legacyResult ? legacyResult : path.dirname(expectedResult),
      trustedRoot: config.jobResultsDir, expectedType: expectedResult === legacyResult ? "file" : "directory" },
  ] as const;
  const artifacts: ArtifactObservation[] = [];
  for (const candidate of candidates) {
    const observation = candidate.actual === candidate.expected
      ? await scanArtifact(candidate.root, candidate.trustedRoot, candidate.expectedType, budget)
      : { cleanup_state: "contract_mismatch" as const, allocated_bytes: null };
    artifacts.push({ kind: candidate.kind, ...observation });
  }
  return { ...base, artifacts };
}

export function inventorySizeIsComplete(jobs: ReadonlyArray<{ artifacts: ReadonlyArray<ArtifactObservation> }>): boolean {
  return jobs.every((job) => job.artifacts.every((artifact) => artifact.allocated_bytes !== null));
}
