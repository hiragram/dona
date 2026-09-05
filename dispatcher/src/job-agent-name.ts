const jobIdPattern = /^job_([0-9a-hjkmnp-tv-z]{26})$/;
const slugLength = 4;

const slugRules = [
  { slug: "enhc", pattern: /\b(?:improve|improvement|enhance|optimize)\b|改善|向上|最適化/iu },
  { slug: "mend", pattern: /\b(?:fix|bugfix|repair)\b|修正|不具合|バグ/iu },
  { slug: "feat", pattern: /\b(?:implement|implementation|add|create|build|develop)\b|実装|追加|作成|開発|導入/iu },
  { slug: "test", pattern: /\b(?:test|tests|testing|coverage|verify|verification)\b|テスト|検証/iu },
  { slug: "read", pattern: /\b(?:document|documentation|docs|readme)\b|文書|ドキュメント/iu },
  { slug: "rvwx", pattern: /\b(?:review|audit)\b|レビュー|監査/iu },
  { slug: "rsch", pattern: /\b(?:research|investigate|analysis|analyze|inspect)\b|調査|解析|分析/iu },
  { slug: "sync", pattern: /\b(?:update|upgrade)\b|更新|アップデート/iu },
  { slug: "send", pattern: /\b(?:deploy|deployment)\b|デプロイ/iu },
  { slug: "tags", pattern: /\b(?:release|publish)\b|リリース|公開/iu },
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
 * Herdr 0.8.2 agent names must match [a-z][a-z0-9_-]{0,31}. Replacing the
 * candidate ULID's final four random characters keeps its timestamp and 60
 * random bits while making the 30-character job ID itself scannable.
 *
 * Keeping the returned agent name in the existing job-ID format is also a
 * rollback contract: releases that address Herdr with job_id can still control
 * jobs created by this release.
 */
export function jobAgentName(candidateJobId: string, objective: string): string {
  const match = jobIdPattern.exec(candidateJobId);
  if (!match) throw new Error(`Invalid job ID for Herdr agent name: ${candidateJobId}`);
  const ulidPart = match[1]!;
  return `job_${ulidPart.slice(0, -slugLength)}${jobAgentSlug(objective)}`;
}
