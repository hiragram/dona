import type { JobDisplay, JobWorkspace } from "./types.js";

export const jobDisplayLabelMaxCodePoints = 48;
export const jobDisplayMetadataKey = "__dona_job_display";

const ansiEscape = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu;
const unsafeFormatting = /[\p{Cc}\p{Cf}]/gu;
const urlLike = /(?:[A-Za-z][A-Za-z0-9+.-]*:|www\.)/u;
const privatePathLike = /[\\/]/u;
const secretLike = /(?:bearer|token|password|passwd|secret|api[ _-]?key|private[ _-]?key|access[ _-]?key|authorization|credential)/iu;
const credentialLike = /(?:gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|gl(?:pat|ptt|ft|rt|cbt|imt|soat|agent)-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|(?:[rs]k_(?:live|test)|whsec)_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9][A-Za-z0-9_-]{11,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/u;

function normalizedText(value: string): string {
  return value
    .normalize("NFC")
    .replace(ansiEscape, "")
    .replace(unsafeFormatting, "")
    .replace(/\s+/gu, " ")
    .trim()
    .normalize("NFC");
}

function containsPrivateDisplayData(value: string): boolean {
  return urlLike.test(value) || privatePathLike.test(value) || secretLike.test(value) || credentialLike.test(value);
}

export function normalizeJobDisplayName(value: string): string | undefined {
  const normalized = normalizedText(value);
  if (!normalized || containsPrivateDisplayData(normalized)) return undefined;
  return normalized;
}

export function createJobDisplayLabel(display: JobDisplay | undefined, workspace: JobWorkspace): string | undefined {
  if (!display) return undefined;
  const shortName = normalizeJobDisplayName(display.short_name);
  if (!shortName) return undefined;
  let prefix = "";
  if (display.issue) {
    if (workspace.kind !== "github" || display.issue.repository.toLowerCase() !== workspace.repository.toLowerCase()) {
      return undefined;
    }
    prefix = `#${display.issue.number} `;
  }
  const available = jobDisplayLabelMaxCodePoints - Array.from(prefix).length;
  if (available <= 0) return undefined;
  return `${prefix}${Array.from(shortName).slice(0, available).join("")}`.trimEnd();
}

export function jobDisplayLabelFromWorkspace(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const metadata = (input as Record<string, unknown>)[jobDisplayMetadataKey];
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return undefined;
  const label = (metadata as Record<string, unknown>).label;
  if (typeof label !== "string" || Array.from(label).length > jobDisplayLabelMaxCodePoints) return undefined;
  const normalized = normalizedText(label);
  if (normalized !== label || !normalized || containsPrivateDisplayData(normalized)) return undefined;
  return label;
}

export function jobWorkspaceLabel(workspaceJson: string, agentName: string): string {
  try {
    return jobDisplayLabelFromWorkspace(JSON.parse(workspaceJson)) ?? agentName;
  } catch {
    return agentName;
  }
}
