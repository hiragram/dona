import { DAY_MS, MAX_YEAR, dayNumber, utcInstant } from './calendar.js';
import type { UtcInstant } from './calendar.js';
import { parseDefinition } from './domain.js';
import type { ScheduleDefinition } from './domain.js';
import { ScheduleError } from './errors.js';
import type { Recurrence } from './recurrence.js';
import { resolveLocal } from './timezone.js';

export type OccurrenceKey = string & { readonly __occurrenceKey: unique symbol };
export interface Occurrence {
  readonly key: OccurrenceKey;
  readonly occurrence_at: UtcInstant;
  readonly local: string;
  readonly timezone: string;
  readonly tzdb_version: string | null;
  readonly revision: number;
}
export interface PreviewRequest { readonly after: string; readonly before_or_equal: string; readonly limit: number }
export interface OccurrencePreview {
  readonly occurrences: readonly Occurrence[];
  readonly truncated: boolean;
  readonly cursor: UtcInstant | null;
}

function matches(date: string, recurrence: Exclude<Recurrence, { kind: 'once' }>): boolean {
  if (date < recurrence.start_date) return false;
  const day = dayNumber(date);
  const anchor = dayNumber(recurrence.start_date);
  if (recurrence.kind === 'daily') return (day - anchor) % recurrence.interval === 0;
  if (recurrence.kind === 'weekly') {
    const weekday = ((day + 3) % 7 + 7) % 7 + 1;
    const anchorWeekday = ((anchor + 3) % 7 + 7) % 7 + 1;
    const weeks = Math.floor((day - (anchor - anchorWeekday + 1)) / 7);
    return weeks % recurrence.interval === 0 && recurrence.weekdays.includes(weekday);
  }
  const months = (Number(date.slice(0, 4)) - Number(recurrence.start_date.slice(0, 4))) * 12 + Number(date.slice(5, 7)) - Number(recurrence.start_date.slice(5, 7));
  return months % recurrence.interval === 0 && Number(date.slice(8, 10)) === recurrence.day;
}

export function previewOccurrences(input: ScheduleDefinition, request: PreviewRequest): OccurrencePreview {
  const definition = parseDefinition(input);
  const after = Date.parse(utcInstant(request.after));
  const before = Date.parse(utcInstant(request.before_or_equal));
  const horizon = before - after;
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > definition.policy.limits.preview_count || horizon < DAY_MS || horizon > definition.policy.limits.preview_days * DAY_MS) throw new ScheduleError('invalid_preview_limit');
  return calculateOccurrences(definition, after, before, request.limit);
}

function calculateOccurrences(definition: ScheduleDefinition, after: number, before: number, limit: number): OccurrencePreview {
  const recurrence = definition.recurrence;
  const occurrences: Occurrence[] = [];
  function append(utc: UtcInstant, local: string): void {
    const ms = Date.parse(utc);
    if (ms <= after || ms > before) return;
    occurrences.push({
      key: JSON.stringify([definition.schedule_id, utc]) as OccurrenceKey,
      occurrence_at: utc, local, revision: definition.revision,
      timezone: recurrence.kind === 'once' ? 'UTC' : recurrence.timezone,
      tzdb_version: recurrence.kind === 'once' ? null : recurrence.tzdb_version,
    });
  }
  if (recurrence.kind === 'once') append(recurrence.at, recurrence.at.slice(0, -1));
  else {
    // UTCではなくcivil dateを走査する。tzdbの最大offset（24h未満）を跨ぐ候補も含める。
    const first = Math.max(dayNumber(recurrence.start_date), Math.floor(after / DAY_MS) - 1);
    const last = Math.min(dayNumber('2499-12-31'), Math.floor(before / DAY_MS) + 1);
    for (let day = first; day <= last; day++) {
      const date = new Date(day * DAY_MS).toISOString().slice(0, 10);
      if (!matches(date, recurrence)) continue;
      try {
        const utc = resolveLocal(date, recurrence.local_time, recurrence.timezone, recurrence.tzdb_version);
        if (utc !== null) append(utc, `${date}T${recurrence.local_time}`);
      } catch (error) {
        // padding候補のUTCが公開範囲外なら、検証済み検索窓にも含まれない。
        if (!(error instanceof ScheduleError) || error.code !== 'out_of_range') throw error;
      }
    }
    // 日付変更線の履歴も含め、UTCで整列・重複除去する。
    occurrences.sort((a, b) => a.occurrence_at < b.occurrence_at ? -1 : a.occurrence_at > b.occurrence_at ? 1 : 0);
  }
  const unique = occurrences.filter((v, i) => i === 0 || occurrences[i - 1]!.occurrence_at !== v.occurrence_at);
  const truncated = unique.length > limit;
  const page = unique.slice(0, limit);
  return { occurrences: page, truncated, cursor: truncated ? page.at(-1)!.occurrence_at : null };
}

// 「次回」は指定した有限horizon内だけ。nullは未来全体の不存在を意味しない。
export function nextOccurrence(definition: ScheduleDefinition, after: string, beforeOrEqual?: string): Occurrence | null {
  const start = utcInstant(after);
  if (beforeOrEqual !== undefined) {
    return previewOccurrences(definition, { after: start, before_or_equal: beforeOrEqual, limit: 1 }).occurrences[0] ?? null;
  }
  const parsed = parseDefinition(definition);
  const afterMs = Date.parse(start);
  const end = Math.min(afterMs + parsed.policy.limits.preview_days * DAY_MS, Date.parse(`${MAX_YEAR}-12-31T23:59:59Z`));
  // 既定窓だけは公開範囲末尾の1日未満も検索する。明示previewの最小horizonは維持。
  return calculateOccurrences(parsed, afterMs, end, 1).occurrences[0] ?? null;
}
