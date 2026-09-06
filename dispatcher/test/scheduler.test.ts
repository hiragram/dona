import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import moment from 'moment-timezone';
import {
  DAY_MS, FakeClock, SystemClock, ScheduleError, TZDB_VERSION,
  decodeRecurrence, encodeRecurrence, parseRecurrence, decodePolicy, encodePolicy,
  defaultPolicy, parsePolicy, parseDefinition, validateCreation, previewOccurrences,
  nextOccurrence, resolveOneShot, resolveLocal, utcInstant, localDate, localTime,
  timezoneName, localIdentity,
} from '../src/scheduler/index.js';
import type { ScheduleErrorCode } from '../src/scheduler/index.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../docs/adr/fixtures/scheduler-v1/${name}.json`, import.meta.url), 'utf8'));
const recurrences = fixture('recurrences').recurrences as Record<string, unknown>;
const cases = fixture('cases') as { calendar: { id: string; recurrence: string; after: string; before_or_equal: string; expected: { utc: string; local?: string }[] }[] };
function definition(recurrence: unknown = recurrences.tokyo_0900) {
  return parseDefinition({ schedule_id: 'schedule_1', revision: 1, tenant_id: 'T1', owner_id: 'U1',
    action: { kind: 'reminder', action: 'slack.reminder.post', body: '朝の確認', target: { kind: 'thread', workspace_id: 'T1', channel_id: 'C1', thread_ts: '1234567890.000001' } },
    recurrence, policy: defaultPolicy(),
  });
}
const throwsCode = (fn: () => unknown, code: ScheduleErrorCode) => assert.throws(fn, (e: unknown) => e instanceof ScheduleError && e.code === code);
const daily = (patch: Record<string, unknown> = {}) => ({ version: 1, kind: 'daily', start_date: '2026-01-01', local_time: '09:00:00', interval: 1, timezone: 'Asia/Tokyo', tzdb_version: '2025b', ...patch });
const window = { after: '2026-09-05T00:00:00Z', before_or_equal: '2026-09-10T00:00:00Z', limit: 100 };

for (const row of cases.calendar) {
  test(`bundled tzdb 2025bでADR実列挙: ${row.id}`, () => {
    const result = previewOccurrences(definition(recurrences[row.recurrence]), { ...row, limit: 100 });
    assert.deepEqual(result.occurrences.map(o => ({ utc: o.occurrence_at, ...(row.recurrence !== 'once' ? { local: o.local } : {}) })), row.expected);
    assert.equal(result.truncated, false);
    assert.equal(result.cursor, null);
    assert.equal(nextOccurrence(definition(recurrences[row.recurrence]), row.after, row.before_or_equal)?.occurrence_at ?? null, row.expected[0]?.utc ?? null);
  });
}

test('Tokyo one-shot local入力をUTCへ解決しUTC identityとして保存', () => {
  const at = resolveOneShot('2026-09-06', '09:00:00', 'Asia/Tokyo', TZDB_VERSION);
  assert.equal(at, '2026-09-06T00:00:00Z');
  const result = nextOccurrence(definition({ version: 1, kind: 'once', at }), window.after)!;
  assert.equal(result.local, '2026-09-06T00:00:00');
  assert.equal(result.timezone, 'UTC');
  throwsCode(() => resolveOneShot('2026-03-08', '02:30:00', 'America/New_York', TZDB_VERSION), 'local_time_gap');
  assert.equal(resolveOneShot('2026-11-01', '01:30:00', 'America/New_York', TZDB_VERSION), '2026-11-01T05:30:00Z');
});

test('recurrence/policyは全canonical fixtureを往復、key順を正規化', () => {
  for (const recurrence of Object.values(recurrences)) {
    assert.deepEqual(decodeRecurrence(encodeRecurrence(parseRecurrence(recurrence))), recurrence);
    assert.equal(encodeRecurrence(decodeRecurrence(JSON.stringify(recurrence))), encodeRecurrence(parseRecurrence(recurrence)));
  }
  const policy = readFileSync(new URL('../../docs/adr/fixtures/scheduler-v1/policy.json', import.meta.url), 'utf8');
  assert.equal(encodePolicy(decodePolicy(policy)), policy);
  assert.equal(encodePolicy(defaultPolicy()), policy);
});

for (const invalid of [
  '{"version":1,"version":1,"kind":"once","at":"2026-09-06T00:00:00Z"}',
  '{"version":1,"\\u0076ersion":1}', '{"version":1.0}', '{"version":1e0}', '{"version":9007199254740993}',
  '{"version":1,}', '[1,]', '{"a":{"x":1,"x":2}}', '{"version":01}', '{"version":1} true',
  '['.repeat(34) + '1' + ']'.repeat(34), ' '.repeat(65_537),
]) test(`strict JSON拒否 ${invalid.slice(0, 55)}`, () => throwsCode(() => decodeRecurrence(invalid), 'invalid_json'));

test('JSONのescape、空白と文字列を正しく扱う', () => {
  assert.deepEqual(decodeRecurrence(' \n { "at": "2026-09-06T00:00:00Z", "kind":"on\\u0063e", "version": 1 } \t'), recurrences.once);
});

test('unknown versionと未知field、policy変更を拒否', () => {
  throwsCode(() => parseRecurrence(daily({ version: 2 })), 'unknown_version');
  throwsCode(() => decodePolicy('{"version":2}'), 'unknown_version');
  throwsCode(() => parseRecurrence(daily({ end_date: '2026-12-31' })), 'invalid_recurrence');
  throwsCode(() => parsePolicy({ ...defaultPolicy(), extra: undefined }), 'invalid_policy');
  const policy = structuredClone(defaultPolicy()) as unknown as { calendar: { gap: string } };
  policy.calendar.gap = 'shift';
  throwsCode(() => parsePolicy(policy), 'invalid_policy');
  throwsCode(() => decodePolicy('{"version":1,"calendar":{"gap":"skip","gap":"skip"}}'), 'invalid_json');
});

test('invalid date/time/instantと範囲をtyped errorで拒否', () => {
  for (const date of ['2026-02-29', '2026-04-31', '2026-00-01', '26-01-01']) throwsCode(() => localDate(date), 'invalid_local_date');
  for (const time of ['24:00:00', '12:60:00', '23:59:60', '9:00:00']) throwsCode(() => localTime(time), 'invalid_local_time');
  for (const at of ['2026-02-30T00:00:00Z', '2026-09-01T24:00:00Z', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00+00:00']) throwsCode(() => utcInstant(at), 'invalid_instant');
  throwsCode(() => localDate('2500-01-01'), 'out_of_range');
  throwsCode(() => utcInstant('0000-01-01T00:00:00Z'), 'out_of_range');
  throwsCode(() => parseRecurrence(daily({ start_date: '2026-02-30' })), 'invalid_local_date');
});

test('bundled IANA名のみ、aliasを保持、未知tzdbを拒否', () => {
  assert.equal(TZDB_VERSION, '2025b');
  for (const name of ['Asia/Tokyo', 'US/Eastern', 'Etc/GMT+5', 'UTC']) assert.equal(timezoneName(name, TZDB_VERSION), name);
  for (const name of ['asia/tokyo', 'Asia/Unknown', '+09:00', ' Asia/Tokyo', 'toString', '__proto__']) throwsCode(() => parseRecurrence(daily({ timezone: name })), 'invalid_timezone');
  throwsCode(() => parseRecurrence(daily({ tzdb_version: '2026a' })), 'tzdb_unavailable');
});

test('interval、weekday、monthly dayを厳密検証', () => {
  for (const interval of [0, 367, 1.5, NaN, Infinity]) throwsCode(() => parseRecurrence(daily({ interval })), 'invalid_recurrence');
  for (const weekdays of [[], [1, 1], [3, 1], [0], [8]]) throwsCode(() => parseRecurrence(daily({ kind: 'weekly', weekdays })), 'invalid_recurrence');
  throwsCode(() => parseRecurrence(daily({ kind: 'weekly', interval: 53, weekdays: [1] })), 'invalid_recurrence');
  for (const day of [0, 32]) throwsCode(() => parseRecurrence(daily({ kind: 'monthly', day })), 'invalid_recurrence');
  throwsCode(() => parseRecurrence(daily({ kind: 'monthly', day: 1, interval: 49 })), 'invalid_recurrence');
});

test('weeklyはISO月曜anchor、start_dateより前を除外', () => {
  const d = definition(daily({ kind: 'weekly', start_date: '2026-09-09', interval: 2, weekdays: [1, 3, 7] }));
  const result = previewOccurrences(d, { after: '2026-09-01T00:00:00Z', before_or_equal: '2026-09-28T00:00:00Z', limit: 100 });
  assert.deepEqual(result.occurrences.map(o => o.local.slice(0, 10)), ['2026-09-09', '2026-09-13', '2026-09-21', '2026-09-23', '2026-09-27']);
});

test('monthly anchorと開始日、daily複数日interval', () => {
  const result = previewOccurrences(definition(daily({ kind: 'monthly', start_date: '2026-01-20', day: 15, interval: 2 })), { after: '2026-01-01T00:00:00Z', before_or_equal: '2026-06-01T00:00:00Z', limit: 100 });
  assert.deepEqual(result.occurrences.map(o => o.local.slice(0, 10)), ['2026-03-15', '2026-05-15']);
  assert.deepEqual(previewOccurrences(definition(daily({ start_date: '2026-09-05', interval: 2 })), window).occurrences.map(o => o.occurrence_at), ['2026-09-07T00:00:00Z', '2026-09-09T00:00:00Z']);
});

test('previewのcount/horizon、truncatedとexclusive cursor境界', () => {
  for (const limit of [0, 101, 1.1, Infinity, NaN]) throwsCode(() => previewOccurrences(definition(), { ...window, limit }), 'invalid_preview_limit');
  for (const end of ['2026-09-05T00:00:00Z', '2026-09-05T23:59:59Z', '2027-09-07T00:00:00Z']) throwsCode(() => previewOccurrences(definition(), { ...window, before_or_equal: end }), 'invalid_preview_limit');
  const first = previewOccurrences(definition(), { ...window, limit: 2 });
  assert.equal(first.truncated, true);
  assert.equal(first.cursor, '2026-09-07T00:00:00Z');
  const rest = previewOccurrences(definition(), { ...window, after: first.cursor! });
  assert.deepEqual([...first.occurrences, ...rest.occurrences], previewOccurrences(definition(), window).occurrences);
  assert.equal(rest.truncated, false);
  const max = previewOccurrences(definition(), { ...window, before_or_equal: '2027-09-06T00:00:00Z', limit: 100 });
  assert.equal(max.occurrences.length, 100);
  assert.equal(max.truncated, true);
  assert.equal(previewOccurrences(definition(), { ...window, limit: 5 }).truncated, false);
});

test('FakeClock advance/rewindと作成boundary、計算はclock非依存', () => {
  const clock = new FakeClock(window.after);
  const once = definition(recurrences.once);
  const result = previewOccurrences(once, window);
  validateCreation(once, clock);
  clock.advance(86_400);
  throwsCode(() => validateCreation(once, clock), 'invalid_creation_time');
  clock.advance(-86_400);
  assert.equal(clock.now(), window.after);
  assert.deepEqual(previewOccurrences(once, window), result);
  clock.advance(366 * 86_400);
  assert.deepEqual(previewOccurrences(once, window), result);
  clock.set(window.after);
  validateCreation(definition({ version: 1, kind: 'once', at: '2027-09-06T00:00:00Z' }), clock);
  throwsCode(() => validateCreation(definition({ version: 1, kind: 'once', at: '2027-09-06T00:00:01Z' }), clock), 'invalid_creation_time');
  validateCreation(definition(daily({ start_date: '2026-09-05' })), clock);
  throwsCode(() => validateCreation(definition(daily({ start_date: '2026-09-04' })), clock), 'invalid_creation_time');
  validateCreation(definition(daily({ start_date: '2027-09-06' })), clock);
  throwsCode(() => validateCreation(definition(daily({ start_date: '2027-09-07' })), clock), 'invalid_creation_time');
  throwsCode(() => clock.advance(0.5), 'out_of_range');
  assert.equal(utcInstant(new SystemClock().now()).length, 20);
});

test('reminder/work型と固定target、code point上限、cross tenant拒否', () => {
  const d = definition();
  assert.equal(parseDefinition({ ...d, action: { kind: 'work', action: 'work.read_only', objective: '調査', notification: { kind: 'none' } } }).action.kind, 'work');
  const dm = { kind: 'owner_dm', workspace_id: 'T1', channel_id: 'D1', owner_id: 'U1' };
  parseDefinition({ ...d, action: { kind: 'work', action: 'work.read_only', objective: '調査', notification: { kind: 'slack', action: 'slack.work_result.post', target: dm } } });
  const action = d.action;
  assert.equal(action.kind, 'reminder');
  if (action.kind !== 'reminder') return;
  parseDefinition({ ...d, action: { ...action, body: '😀'.repeat(2000) } });
  for (const patch of [{ body: '😀'.repeat(2001) }, { body: '\ud800' }, { target: { ...dm, owner_id: 'U2' } }, { target: { ...dm, workspace_id: 'T2' } }, { target: { kind: 'none' } }, { action: 'shell' }]) throwsCode(() => parseDefinition({ ...d, action: { ...action, ...patch } }), 'invalid_definition');
});

test('table/property: zones × recurrenceで決定的・単調・一意、revisionを跨ぐkey維持', () => {
  for (const timezone of ['Asia/Tokyo', 'America/New_York', 'Australia/Lord_Howe', 'Pacific/Apia', 'Europe/London', 'Asia/Kathmandu']) {
    for (const spec of [{ kind: 'daily' }, { kind: 'weekly', weekdays: [1, 5, 7] }, { kind: 'monthly', day: 31 }]) {
      for (const interval of [1, 2, 7]) {
        const d = definition(daily({ ...spec, timezone, interval, local_time: '01:30:00' }));
        const w = { after: '2026-01-01T00:00:00Z', before_or_equal: '2027-01-02T00:00:00Z', limit: 100 };
        const a = previewOccurrences(d, w);
        assert.deepEqual(a, previewOccurrences(d, w));
        assert.equal(new Set(a.occurrences.map(o => o.key)).size, a.occurrences.length);
        for (let i = 0; i < a.occurrences.length; i++) {
          const o = a.occurrences[i]!;
          assert.ok(o.occurrence_at > (a.occurrences[i - 1]?.occurrence_at ?? w.after));
          assert.ok(o.occurrence_at <= w.before_or_equal);
          assert.equal(localIdentity(o.occurrence_at, timezoneName(timezone, TZDB_VERSION)), o.local);
        }
        assert.deepEqual(a.occurrences.map(o => o.key), previewOccurrences({ ...d, revision: 2 }, w).occurrences.map(o => o.key));
      }
    }
  }
});

test('30分DST gap/overlap、24時間のcivil date欠落、2100非閏年', () => {
  assert.equal(resolveLocal('2026-10-04', '02:15:00', 'Australia/Lord_Howe', TZDB_VERSION), null);
  assert.equal(resolveLocal('2026-04-05', '01:45:00', 'Australia/Lord_Howe', TZDB_VERSION), '2026-04-04T14:45:00Z');
  const apia = previewOccurrences(definition(daily({ start_date: '2011-12-28', timezone: 'Pacific/Apia' })), { after: '2011-12-29T00:00:00Z', before_or_equal: '2012-01-02T00:00:00Z', limit: 100 });
  assert.ok(!apia.occurrences.some(o => o.local.startsWith('2011-12-30')));
  assert.equal(new Set(apia.occurrences.map(o => o.key)).size, apia.occurrences.length);
  const leap = previewOccurrences(definition(daily({ kind: 'monthly', start_date: '2096-02-01', interval: 12, day: 29 })), { after: '2100-01-01T00:00:00Z', before_or_equal: '2101-01-01T00:00:00Z', limit: 100 });
  assert.equal(leap.occurrences.length, 0);
});

test('host timezoneとMoment global変更でbundled計算が変化しない', () => {
  const d = definition(recurrences.ny_0130);
  const w = { after: '2026-10-31T05:30:00Z', before_or_equal: '2026-11-02T00:00:00Z', limit: 100 };
  const before = previewOccurrences(d, w);
  const oldTZ = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Honolulu';
    moment.tz.setDefault('Europe/London');
    moment.tz.add('America/New_York|UTC|0|0||');
    assert.deepEqual(previewOccurrences(d, w), before);
  } finally {
    if (oldTZ === undefined) delete process.env.TZ; else process.env.TZ = oldTZ;
    moment.tz.setDefault();
  }
});

test('同梱全zoneのoffsetが探索padding内、clock/ICUを呼ばず純粋計算', () => {
  for (const name of moment.tz.names()) {
    assert.ok(moment.tz.zone(name)!.offsets.every(offset => Math.abs(offset) < 24 * 60), name);
  }
  const originalNow = Date.now;
  const originalFormatter = Intl.DateTimeFormat;
  try {
    Date.now = () => { throw new Error('unexpected clock read'); };
    Intl.DateTimeFormat = function () { throw new Error('unexpected host ICU'); } as unknown as typeof Intl.DateTimeFormat;
    assert.equal(nextOccurrence(definition(), window.after)!.occurrence_at, '2026-09-06T00:00:00Z');
  } finally {
    Date.now = originalNow;
    Intl.DateTimeFormat = originalFormatter;
  }
});

test('Gregorian最小/最大年と遠いanchorも有限horizon内で扱う', () => {
  assert.equal(localDate('0001-01-01'), '0001-01-01');
  assert.equal(localDate('2499-12-31'), '2499-12-31');
  throwsCode(() => resolveOneShot('2499-12-31', '23:59:59', 'America/New_York', TZDB_VERSION), 'out_of_range');
  const d = definition(daily({ start_date: '0001-01-01', timezone: 'UTC' }));
  const result = previewOccurrences(d, { after: '2499-12-28T00:00:00Z', before_or_equal: '2499-12-30T00:00:00Z', limit: 100 });
  assert.equal(result.occurrences.length, 2);
  assert.equal(result.occurrences[0]!.local, '2499-12-28T09:00:00');
  const edge = previewOccurrences(definition(daily({ start_date: '2499-12-28', timezone: 'America/New_York', local_time: '23:59:59' })), { after: '2499-12-29T00:00:00Z', before_or_equal: '2499-12-31T23:59:59Z', limit: 100 });
  assert.equal(edge.occurrences.length, 3);
});


test('nextOccurrenceの既定horizonは公開上限まで、末尾の1日未満も検索', () => {
  const d = definition(daily({ start_date: '2499-07-01', timezone: 'UTC' }));
  assert.equal(nextOccurrence(d, '2499-07-01T09:00:00Z')!.occurrence_at, '2499-07-02T09:00:00Z');
  assert.equal(nextOccurrence(d, '2499-12-31T00:00:00Z')!.occurrence_at, '2499-12-31T09:00:00Z');
  assert.equal(nextOccurrence(d, '2499-12-31T09:00:00Z'), null);
  assert.equal(nextOccurrence(d, '2499-12-31T23:59:59Z'), null);
  throwsCode(() => nextOccurrence(d, '2500-01-01T00:00:00Z'), 'out_of_range');
  throwsCode(() => previewOccurrences(d, { after: '2499-12-31T00:00:00Z', before_or_equal: '2499-12-31T23:59:59Z', limit: 1 }), 'invalid_preview_limit');
});
