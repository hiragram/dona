const credentialPatterns: readonly [RegExp, string][] = [
  [/\b(?:xapp|xoxb|xoxp|xoxa)-[^\s"']+/gi, "[REDACTED_TOKEN]"],
  [/\b(?:ghp|github_pat)_[A-Za-z0-9_]+\b/g, "[REDACTED_TOKEN]"],
  [/\b(authorization|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]"],
  [/https?:\/\/[^\s"']+/gi, "[REDACTED_URL]"],
  [/(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/|\/tmp\/)[^\n]*/g, "[REDACTED_LOCAL_PATH]"],
];

export function redactText(value: string, limit = 2_000): string {
  let redacted = value;
  for (const [pattern, replacement] of credentialPatterns) redacted = redacted.replace(pattern, replacement);
  return redacted.slice(0, limit);
}

export function redactValue(value: unknown, key = "", depth = 0): unknown {
  if (/token|secret|authorization|environment|body|raw_plan|private_url/i.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactText(value, 1_000);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 4) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.map((child) => redactValue(child, key, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
    childKey,
    redactValue(child, childKey, depth + 1),
  ]));
}
