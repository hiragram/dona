import { ScheduleError } from './errors.js';

export const DAY_MS = 86_400_000;
// 同梱データが将来の遷移を展開する最終年までを公開する。
export const MIN_YEAR = 1;
export const MAX_YEAR = 2499;
export type UtcInstant = string & { readonly __utcInstant: unique symbol };
export type LocalDate = string & { readonly __localDate: unique symbol };
export type LocalTime = string & { readonly __localTime: unique symbol };

export function formatUtc(ms: number): UtcInstant {
  if (!Number.isSafeInteger(ms) || ms % 1000 !== 0) throw new ScheduleError('invalid_instant');
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < MIN_YEAR || date.getUTCFullYear() > MAX_YEAR) {
    throw new ScheduleError('out_of_range');
  }
  return date.toISOString().replace('.000Z', 'Z') as UtcInstant;
}

export function utcInstant(value: unknown): UtcInstant {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)) throw new ScheduleError('invalid_instant');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new ScheduleError('invalid_instant');
  if (formatUtc(ms) !== value) throw new ScheduleError('invalid_instant');
  return value as UtcInstant;
}

export function localDate(value: unknown): LocalDate {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) throw new ScheduleError('invalid_local_date');
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new ScheduleError('invalid_local_date');
  if (formatUtc(ms).slice(0, 10) !== value) throw new ScheduleError('invalid_local_date');
  return value as LocalDate;
}

export function localTime(value: unknown): LocalTime {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)) throw new ScheduleError('invalid_local_time');
  return value as LocalTime;
}

export function dayNumber(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}
