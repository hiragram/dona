import { createHash } from "node:crypto";
import type { JobRow } from "./types.js";

export type WorkerActivity = "working" | "waiting" | "inactive" | "stopped" | "unknown";
export interface WorkerObservation {
  state: WorkerActivity;
  reason: string;
  observed_at: string;
  // Private runtime evidence. Never project process identities or paths to MCP.
  process_ids: number[];
  process_groups: number[];
}
export interface HandoffRecord {
  job_id: string;
  source_event_id: string;
  instruction: string;
  expected_job_json: string;
  observation_json: string;
  state: "claimed" | "accepted";
  successor_job_id: string | null;
  created_at: string;
}
export function jobSnapshot(row: JobRow): string {
  return JSON.stringify(row);
}
export function workspaceJobId(row: JobRow): string {
  const value = JSON.parse(row.workspace_json)._dona_handoff?.workspace_job_id;
  if (value === undefined) return row.job_id;
  if (typeof value !== "string" || !/^job_[0-9a-hjkmnp-tv-z]{26}$/.test(value)) throw new Error("handoff_workspace_identity_invalid");
  return value;
}
export function handoffKey(jobId: string): string {
  return `resume.${createHash("sha256").update(jobId).digest("hex").slice(0, 40)}`;
}
export function publicObservation(observation: WorkerObservation) {
  return { state: observation.state, reason: observation.reason, observed_at: observation.observed_at };
}
/** A complete numeric process-tree sample, without argv/environment disclosure. */
export function processTree(sample: string, root: number): number[] {
  const rows = sample.trim().split("\n").map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) throw new Error("process_inventory_invalid");
    return { pid: Number(match[1]), parent: Number(match[2]) };
  });
  if (!rows.some(row => row.pid === root)) throw new Error("process_root_missing");
  const ids = new Set([root]);
  for (let added = true; added;) {
    added = false;
    for (const row of rows) if (ids.has(row.parent) && !ids.has(row.pid)) { ids.add(row.pid); added = true; }
  }
  if (ids.size > 512) throw new Error("process_inventory_too_large");
  return [...ids].sort((a, b) => a - b);
}

export function processGroups(sample: string, root: number): {process_ids:number[];process_groups:number[]} {
  const rows = sample.trim().split("\n").map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) throw new Error("process_inventory_invalid");
    const values = match.slice(1).map(Number);
    if (!values.every(Number.isSafeInteger)) throw new Error("process_inventory_invalid");
    return {pid:values[0]!,parent:values[1]!,group:values[2]!};
  });
  const ids = processTree(rows.map(row => `${row.pid} ${row.parent}`).join("\n"), root);
  const groups = [...new Set(rows.filter(row => ids.includes(row.pid)).map(row => row.group))];
  if (groups.some(group => group <= 1)) throw new Error("process_group_invalid");
  // A process group shared with an unrelated process cannot be a retirement boundary.
  if (rows.some(row => groups.includes(row.group) && !ids.includes(row.pid))) throw new Error("process_group_shared");
  return {process_ids:ids,process_groups:groups.sort((a,b)=>a-b)};
}
