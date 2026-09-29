import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";

import type { DispatcherConfig } from "./config.js";
import { jobProgressPath, workspaceFromJob } from "./job-prompt.js";
import type { JobRow } from "./types.js";

type ScanState = "present" | "missing" | "unsafe" | "budget_exceeded" | "contract_mismatch";
interface ArtifactObservation {
  kind: "worktree" | "progress" | "result";
  cleanup_state: ScanState;
  allocated_bytes: number | null;
}

export function readJobArtifactInventoryPage(databasePath: string, afterJobId: string, limit: number): JobRow[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 21 ||
    (afterJobId !== "" && !/^job_[0-9a-hjkmnp-tv-z]{26}$/.test(afterJobId)))
    throw new Error("artifact_inventory_cursor_or_limit_invalid");
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return database.prepare(`SELECT job_id,workspace_json,workspace_path,result_path,status,created_at,completed_at
      FROM jobs WHERE job_id>? ORDER BY job_id LIMIT ?`).all(afterJobId, limit) as JobRow[];
  } finally { database.close(); }
}

async function scanArtifact(root: string, trustedRoot: string,
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
  const seen = new Set<string>();
  let bytes = 0;
  const sameDirectory = async (directory: string, expected: { dev: number; ino: number; birthtimeMs: number }): Promise<boolean> => {
    try {
      const current = await fs.lstat(directory);
      return current.isDirectory() && !current.isSymbolicLink() && current.dev === expected.dev &&
        current.ino === expected.ino && current.birthtimeMs === expected.birthtimeMs &&
        current.uid === process.getuid?.();
    } catch { return false; }
  };
  const visit = async (current: string): Promise<ScanState> => {
    if (++budget.entries > 10_000 || performance.now() > budget.deadline) return "budget_exceeded";
    let stats: Awaited<ReturnType<typeof fs.lstat>>;
    try { stats = await fs.lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return current === root ? "missing" : "unsafe";
      return "unsafe";
    }
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile()) ||
      stats.uid !== process.getuid?.()) return "unsafe";
    const identity = `${stats.dev}:${stats.ino}`;
    if (!seen.has(identity)) { seen.add(identity); bytes += stats.blocks * 512; }
    if (stats.isDirectory()) {
      let handle: fs.FileHandle;
      try { handle = await fs.open(current, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW); }
      catch { return "unsafe"; }
      try {
        const opened = await handle.stat();
        if (opened.dev !== stats.dev || opened.ino !== stats.ino ||
          opened.birthtimeMs !== stats.birthtimeMs || !await sameDirectory(current, opened)) return "unsafe";
        for await (const entry of await fs.opendir(current)) {
          if (!await sameDirectory(current, opened)) return "unsafe";
          const state = await visit(path.join(current, entry.name));
          if (!await sameDirectory(current, opened)) return "unsafe";
          if (state !== "present") return state;
        }
        if (!await sameDirectory(current, opened)) return "unsafe";
      } catch { return "unsafe"; }
      finally { await handle.close(); }
    }
    return "present";
  };
  const cleanup_state = await visit(root);
  return { cleanup_state, allocated_bytes: cleanup_state === "present" ? bytes : null };
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
      trustedRoot: config.jobsWorkspaceRoot },
    { kind: "progress", actual: jobProgressPath(row), expected: expectedProgress, root: path.dirname(expectedProgress),
      trustedRoot: config.jobsWorkspaceRoot },
    { kind: "result", actual: row.result_path, expected: expectedResult,
      root: expectedResult === legacyResult ? legacyResult : path.dirname(expectedResult),
      trustedRoot: config.jobResultsDir },
  ] as const;
  const artifacts: ArtifactObservation[] = [];
  for (const candidate of candidates) {
    const observation = candidate.actual === candidate.expected
      ? await scanArtifact(candidate.root, candidate.trustedRoot, budget)
      : { cleanup_state: "contract_mismatch" as const, allocated_bytes: null };
    artifacts.push({ kind: candidate.kind, ...observation });
  }
  return { ...base, artifacts };
}

export function inventorySizeIsComplete(jobs: ReadonlyArray<{ artifacts: ReadonlyArray<ArtifactObservation> }>): boolean {
  return jobs.every((job) => job.artifacts.every((artifact) =>
    artifact.cleanup_state === "present" && artifact.allocated_bytes !== null));
}
