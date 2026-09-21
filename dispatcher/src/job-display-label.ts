import type { JobDisplay, JobWorkspace } from "./types.js";

export const jobDisplayLabelMaxCodePoints = 48;
export const jobDisplayMetadataKey = "__dona_job_display";

const ansiEscape = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu;
const unsafeFormatting = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const urlLike = /(?:\b(?:https?|file):\/\/|\bwww\.)/iu;
const privatePathLike = /(?:^|[^A-Za-z0-9._~-])(?:~[\\/]|[A-Za-z]:\\|\/(?:Users|home|root|private|etc|var|tmp|opt|usr|Library|System|Applications|Volumes|dev|bin|sbin)(?:\/|\b))/u;
const secretLike = /\b(?:bearer|token|password|passwd|secret|api[ _-]?key|authorization)\b\s*(?:[:=]|\S{12,})?/iu;

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
  return urlLike.test(value) || privatePathLike.test(value) || secretLike.test(value);
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
