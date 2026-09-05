import { z } from 'zod';
import { localDate, localTime, utcInstant } from './calendar.js';
import { ScheduleError } from './errors.js';
import { canonicalJson, parseStrictJson } from './json.js';
import { timezoneName } from './timezone.js';

const common = {
  version: z.literal(1), start_date: z.string().transform(localDate),
  local_time: z.string().transform(localTime), timezone: z.string(), tzdb_version: z.string(),
};
const recurrenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ version: z.literal(1), kind: z.literal('once'), at: z.string().transform(utcInstant) }),
  z.strictObject({ ...common, kind: z.literal('daily'), interval: z.number().int().min(1).max(366) }),
  z.strictObject({ ...common, kind: z.literal('weekly'), interval: z.number().int().min(1).max(52),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).refine(a => a.every((v, i) => i === 0 || a[i - 1]! < v)) }),
  z.strictObject({ ...common, kind: z.literal('monthly'), interval: z.number().int().min(1).max(48), day: z.number().int().min(1).max(31) }),
]);
export type Recurrence = Readonly<z.infer<typeof recurrenceSchema>>;

export function parseRecurrence(input: unknown): Recurrence {
  if (input !== null && typeof input === 'object' && (input as { version?: unknown }).version !== 1) throw new ScheduleError('unknown_version');
  const parsed = recurrenceSchema.safeParse(input);
  if (!parsed.success) throw new ScheduleError('invalid_recurrence');
  if (parsed.data.kind !== 'once') timezoneName(parsed.data.timezone, parsed.data.tzdb_version);
  return parsed.data;
}
export function decodeRecurrence(text: string): Recurrence { return parseRecurrence(parseStrictJson(text)); }
export function encodeRecurrence(recurrence: Recurrence): string { return canonicalJson(parseRecurrence(recurrence)); }
