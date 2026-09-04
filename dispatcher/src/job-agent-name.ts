const jobIdPattern = /^job_([0-9a-hjkmnp-tv-z]{26})$/;

const slugRules = [
  { slug: "impr", pattern: /\b(?:improve|improvement|enhance|optimize)\b|改善|向上|最適化/iu },
  { slug: "fix", pattern: /\b(?:fix|bugfix|repair)\b|修正|不具合|バグ/iu },
  { slug: "impl", pattern: /\b(?:implement|implementation|add|create|build|develop)\b|実装|追加|作成|開発|導入/iu },
  { slug: "test", pattern: /\b(?:test|tests|testing|coverage|verify|verification)\b|テスト|検証/iu },
  { slug: "docs", pattern: /\b(?:document|documentation|docs|readme)\b|文書|ドキュメント/iu },
  { slug: "rvw", pattern: /\b(?:review|audit)\b|レビュー|監査/iu },
  { slug: "rsch", pattern: /\b(?:research|investigate|analysis|analyze|inspect)\b|調査|解析|分析/iu },
  { slug: "updt", pattern: /\b(?:update|upgrade)\b|更新|アップデート/iu },
  { slug: "dply", pattern: /\b(?:deploy|deployment)\b|デプロイ/iu },
  { slug: "rels", pattern: /\b(?:release|publish)\b|リリース|公開/iu },
] as const;

/**
 * Return only a coarse, fixed-vocabulary task class. Objective text is
 * untrusted and may contain secrets, paths, or control characters, so no part
 * of it is copied into the Herdr-visible name.
 */
export function jobAgentSlug(objective: string): string {
  return slugRules.find(({ pattern }) => pattern.test(objective))?.slug ?? "task";
}

/**
 * Herdr 0.8.2 agent names must match [a-z][a-z0-9_-]{0,31}. Keeping the full
 * ULID preserves the job ID's uniqueness while the four-character slug makes
 * the agent list scannable within that 32-character limit.
 */
export function jobAgentName(jobId: string, objective: string): string {
  const match = jobIdPattern.exec(jobId);
  if (!match) throw new Error(`Invalid job ID for Herdr agent name: ${jobId}`);
  return `j${match[1]}-${jobAgentSlug(objective)}`;
}
