import moment from 'moment-timezone';
import { formatUtc, localDate, localTime } from './calendar.js';
import type { UtcInstant } from './calendar.js';
import { ScheduleError } from './errors.js';

export const TZDB_VERSION = '2025b' as const;
export type TimezoneName = string & { readonly __timezone: unique symbol };
interface Zone { readonly untils: readonly number[]; readonly offsets: readonly number[] }
// グローバルなtz.load/default設定の後続変更から計算を隔離する。
const zones = new Map<string, Zone>();
if (moment.tz.dataVersion !== TZDB_VERSION) throw new ScheduleError('tzdb_unavailable');
for (const name of moment.tz.names()) {
  const zone = moment.tz.zone(name)!;
  zones.set(name, { untils: Object.freeze([...zone.untils]), offsets: Object.freeze(zone.offsets.map(n => Math.round(n * 60_000))) });
}

export function timezoneName(value: unknown, version: unknown): TimezoneName {
  if (version !== TZDB_VERSION) throw new ScheduleError('tzdb_unavailable');
  if (typeof value !== 'string' || !zones.has(value)) throw new ScheduleError('invalid_timezone');
  return value as TimezoneName;
}

function offsetAt(zone: Zone, utc: number): number {
  let low = 0;
  let high = zone.untils.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (utc < zone.untils[mid]!) high = mid;
    else low = mid + 1;
  }
  return zone.offsets[low]!;
}

export function localIdentity(utc: UtcInstant, timezone: TimezoneName): string {
  const zone = zones.get(timezone);
  if (!zone) throw new ScheduleError('invalid_timezone');
  return formatUtc(Date.parse(utc) - offsetAt(zone, Date.parse(utc))).slice(0, -1);
}

export function resolveLocal(date: string, time: string, timezone: string, version: string): UtcInstant | null {
  const wall = Date.parse(`${localDate(date)}T${localTime(time)}Z`);
  const zone = zones.get(timezoneName(timezone, version))!;
  let earliest = Infinity;
  for (const offset of new Set(zone.offsets)) {
    const candidate = wall + offset;
    if (offsetAt(zone, candidate) === offset) earliest = Math.min(earliest, candidate);
  }
  return earliest === Infinity ? null : formatUtc(earliest);
}

// one-shot local入力のpreview用。gapは補正せず明示的に拒否する。
export function resolveOneShot(date: string, time: string, timezone: string, version: string): UtcInstant {
  const resolved = resolveLocal(date, time, timezone, version);
  if (resolved === null) throw new ScheduleError('local_time_gap');
  return resolved;
}
