import { z } from 'zod';
import { DAY_MS, dayNumber, utcInstant } from './calendar.js';
import type { Clock } from './clock.js';
import { ScheduleError } from './errors.js';
import { parsePolicy } from './policy.js';
import { parseRecurrence } from './recurrence.js';
import { localIdentity, timezoneName } from './timezone.js';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const thread = z.string().regex(/^\d{1,20}\.\d{6}$/);
const target = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('thread'), workspace_id: id, channel_id: id, thread_ts: thread }),
  z.strictObject({ kind: z.literal('channel'), workspace_id: id, channel_id: id }),
  z.strictObject({ kind: z.literal('owner_dm'), workspace_id: id, channel_id: id, owner_id: id }),
]);
const content = (max: number) => z.string().min(1).refine(s => [...s].length <= max && !/[\uD800-\uDFFF]/u.test(s));
const actionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('reminder'), action: z.literal('slack.reminder.post'), target, body: content(2000) }),
  z.strictObject({ kind: z.literal('work'), action: z.literal('work.read_only'), objective: content(4000),
    notification: z.union([z.strictObject({ kind: z.literal('none') }), z.strictObject({ kind: z.literal('slack'), action: z.literal('slack.work_result.post'), target })]) }),
]);
export type ScheduleAction = Readonly<z.infer<typeof actionSchema>>;
const definitionSchema = z.strictObject({
  schedule_id: id, revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tenant_id: id, owner_id: id, action: actionSchema,
  recurrence: z.unknown().transform(parseRecurrence), policy: z.unknown().transform(parsePolicy),
});
export type ScheduleDefinition = Readonly<z.infer<typeof definitionSchema>>;

export function parseDefinition(input: unknown): ScheduleDefinition {
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success) throw new ScheduleError('invalid_definition');
  const definition = parsed.data;
  const action = definition.action;
  const destination = action.kind === 'reminder' ? action.target : action.notification.kind === 'slack' ? action.notification.target : null;
  if (destination && (destination.workspace_id !== definition.tenant_id || (destination.kind === 'owner_dm' && destination.owner_id !== definition.owner_id))) throw new ScheduleError('invalid_definition');
  return definition;
}

// 永続recordのdecodeと作成時刻の検証を分離する。権限照会やquota transactionは後続Issue。
export function validateCreation(input: unknown, clock: Clock): ScheduleDefinition {
  const definition = parseDefinition(input);
  const now = utcInstant(clock.now());
  const recurrence = definition.recurrence;
  if (recurrence.kind === 'once') {
    const delta = Date.parse(recurrence.at) - Date.parse(now);
    if (delta <= 0 || delta > 366 * DAY_MS) throw new ScheduleError('invalid_creation_time');
  } else {
    const today = localIdentity(now, timezoneName(recurrence.timezone, recurrence.tzdb_version)).slice(0, 10);
    const delta = dayNumber(recurrence.start_date) - dayNumber(today);
    if (delta < 0 || delta > 366) throw new ScheduleError('invalid_creation_time');
  }
  return definition;
}
