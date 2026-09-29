import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { DispatcherConfig } from "./config.js";
import { jobProgressPath, workspaceFromJob } from "./job-prompt.js";
import type { JobRow } from "./types.js";

type ScanState = "present" | "missing" | "unsafe" | "budget_exceeded" | "contract_mismatch";
interface ArtifactObservation {
  kind: "worktree" | "progress" | "result";
  cleanup_state: ScanState;
  allocated_bytes: number | null;
}

async function scanArtifact(root: string, trustedRoot: string,
  budget: { entries: number; deadline: number }): Promise<Omit<ArtifactObservation, "kind">> {
  const relative = path.relative(trustedRoot, root);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return { cleanup_state: "contract_mismatch", allocated_bytes: null };
  let ancestor = trustedRoot;
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
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
      try {
        for await (const entry of await fs.opendir(current)) {
          const state = await visit(path.join(current, entry.name));
          if (state !== "present") return state;
        }
      } catch { return "unsafe"; }
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
  const workspace = workspaceFromJob(row);
  const expectedWorkspace = workspace.kind === "scratch"
    ? path.join(config.jobsWorkspaceRoot, "scratch", row.job_id)
    : path.join(config.jobsWorkspaceRoot, "github", ...workspace.repository.split("/"), "worktrees", row.job_id);
  const expectedResult = path.join(config.jobResultsDir, row.job_id, "result.json");
  const expectedProgress = path.join(path.dirname(expectedWorkspace), ".dona-progress", row.job_id, "progress.json");
  const candidates = [
    { kind: "worktree", actual: row.workspace_path, expected: expectedWorkspace, root: expectedWorkspace,
      trustedRoot: config.jobsWorkspaceRoot },
    { kind: "progress", actual: jobProgressPath(row), expected: expectedProgress, root: path.dirname(expectedProgress),
      trustedRoot: config.jobsWorkspaceRoot },
    { kind: "result", actual: row.result_path, expected: expectedResult, root: path.dirname(expectedResult),
      trustedRoot: config.jobResultsDir },
  ] as const;
  const artifacts: ArtifactObservation[] = [];
  for (const candidate of candidates) {
    const observation = candidate.actual === candidate.expected
      ? await scanArtifact(candidate.root, candidate.trustedRoot, budget)
      : { cleanup_state: "contract_mismatch" as const, allocated_bytes: null };
    artifacts.push({ kind: candidate.kind, ...observation });
  }
  const protection_reasons = row.status === "needs_review" ? ["needs_review"]
    : ["completed", "failed", "cancelled"].includes(row.status)
      ? ["notification_unverified", "retention_expiry_unverified"] : ["nonterminal"];
  return { job_id: row.job_id, status: row.status, created_at: row.created_at,
    terminal_at: row.completed_at, protection_reasons, artifacts };
}
