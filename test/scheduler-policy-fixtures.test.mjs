import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../docs/adr/fixtures/scheduler-v1/', import.meta.url);
const load = (name) => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const policy = load('policy.json');
const { recurrences } = load('recurrences.json');
const cases = load('cases.json');
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const localAt = (utc, timezone) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(utc)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
};

// fixtureの検算のみ。productionのrecurrence列挙器・policy実装ではない。
test('versioned JSONのcanonical bytesとfixture IDを検査する', () => {
  for (const name of ['policy.json', 'recurrences.json', 'cases.json']) {
    const raw = readFileSync(new URL(name, root), 'utf8');
    const value = JSON.parse(raw);
    assert.equal(value.version, 1);
    assert.equal(raw, JSON.stringify(canonical(value)) + '\n');
  }
  const ids = Object.values(cases).filter(Array.isArray).flat().map(c => c.id);
  assert.equal(ids.length, new Set(ids).size);
  for (const id of ['ny_gap', 'ny_overlap_first', 'ny_overlap_after_first', 'month_31',
    'leap_2028', 'leap_empty_horizon', 'long_sleep', 'grace_equal', 'grace_exceeded',
    'expiry_equal', 'overlap', 'long_sleep_expired']) assert.ok(ids.includes(id), id);
});

test('recurrence例はv1の正確なfield集合・範囲を持つ', () => {
  for (const r of Object.values(recurrences)) {
    assert.equal(r.version, 1);
    if (r.kind === 'once') {
      assert.deepEqual(Object.keys(r).sort(), ['at', 'kind', 'version']);
      assert.equal(new Date(r.at).toISOString(), r.at.replace('Z', '.000Z'));
      continue;
    }
    const common = ['version', 'kind', 'start_date', 'interval', 'local_time', 'timezone', 'tzdb_version'];
    const extra = r.kind === 'monthly' ? ['day'] : r.kind === 'weekly' ? ['weekdays'] : [];
    assert.deepEqual(Object.keys(r).sort(), [...common, ...extra].sort());
    const max = { daily: 366, weekly: 52, monthly: 48 }[r.kind];
    assert.ok(Number.isInteger(r.interval) && r.interval >= 1 && r.interval <= max);
    assert.equal(r.tzdb_version, '2025b');
    assert.equal(new Date(`${r.start_date}T00:00:00Z`).toISOString().slice(0, 10), r.start_date);
    assert.match(r.local_time, /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/);
    if (r.kind === 'monthly') assert.ok(Number.isInteger(r.day) && r.day >= 1 && r.day <= 31);
    if (r.kind === 'weekly') {
      assert.ok(r.weekdays.length >= 1);
      assert.deepEqual(r.weekdays, [...new Set(r.weekdays)].sort());
      assert.ok(r.weekdays.every(d => Number.isInteger(d) && d >= 1 && d <= 7));
    }
  }
});

for (const c of cases.calendar) test(`calendar fixture: ${c.id}`, () => {
  const r = recurrences[c.recurrence];
  assert.ok(r);
  const span = Date.parse(c.before_or_equal) - Date.parse(c.after);
  assert.ok(span > 0 && span <= policy.limits.preview_days * 86400000);
  assert.ok(c.expected.length <= policy.limits.preview_count);
  let previous = c.after;
  for (const e of c.expected) {
    assert.ok(e.utc > previous && e.utc <= c.before_or_equal);
    previous = e.utc;
    if (r.kind === 'once') { assert.equal(e.utc, r.at); continue; }
    assert.equal(localAt(e.utc, r.timezone), e.local);
    assert.equal(e.local.slice(11), r.local_time);
    assert.ok(e.local.slice(0, 10) >= r.start_date);
    const date = new Date(`${e.local.slice(0, 10)}T00:00:00Z`);
    const anchor = new Date(`${r.start_date}T00:00:00Z`);
    if (r.kind === 'daily') assert.equal((date - anchor) / 86400000 % r.interval, 0);
    if (r.kind === 'monthly') {
      assert.equal(date.getUTCDate(), r.day);
      assert.equal(((date.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + date.getUTCMonth() - anchor.getUTCMonth()) % r.interval, 0);
    }
    if (r.kind === 'weekly') {
      assert.ok(r.weekdays.includes(date.getUTCDay() || 7));
      const monday = d => d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000;
      assert.equal((monday(date) - monday(anchor)) / 604800000 % r.interval, 0);
    }
  }
  for (const e of c.excluded) {
    if (e.reason === 'invalid_day') {
      const [y, m, d] = e.local.slice(0, 10).split('-').map(Number);
      assert.ok(d > new Date(Date.UTC(y, m, 0)).getUTCDate());
    } else if (e.reason === 'overlap_second') {
      assert.equal(localAt(e.utc, r.timezone), e.local);
      const first = new Date(Date.parse(e.utc) - 3600000).toISOString().replace('.000Z', 'Z');
      assert.equal(localAt(first, r.timezone), e.local);
      assert.ok(!c.expected.some(x => x.utc === e.utc));
    } else {
      assert.equal(e.reason, 'gap');
      // NY transitionの前後双方のoffset候補を検算する（汎用calculatorではない）。
      for (const offset of ['-05:00', '-04:00']) {
        assert.notEqual(localAt(new Date(e.local + offset).toISOString(), r.timezone), e.local);
      }
    }
  }
});

for (const c of cases.misfire) test(`misfire fixture: ${c.id}`, () => {
  const valid = c.due.filter(t => Date.parse(t) <= Date.parse(c.now)
    && Date.parse(c.now) - Date.parse(t) <= policy.execution.misfire_grace_seconds * 1000).sort();
  const expired = Date.parse(c.now) >= Date.parse(c.expires_at);
  const expected = expired || c.unsettled_run ? [] : valid.slice(-policy.limits.catch_up_count);
  assert.deepEqual(c.expected_run, expected);
  assert.equal(c.expected_reason, expired ? 'paused_authorization_expired'
    : valid.length === 0 ? 'skipped_misfire' : c.unsettled_run ? 'skipped_overlap' : 'latest_one');
});

test('quota、authorization、tzdbの境界値を検算する', () => {
  for (const c of cases.quota) assert.equal(c.accepted,
    c.owner_before + 1 <= policy.limits.owner_nonterminal_schedules
    && c.tenant_before + 1 <= policy.limits.tenant_nonterminal_schedules);
  for (const c of cases.authorization) assert.equal(c.accepted,
    c.age_seconds > 0 && c.age_seconds <= policy.authorization.max_age_seconds);
  for (const c of cases.tzdb) assert.equal(c.expected,
    c.available_versions.includes(c.record_version) ? c.record_version : 'paused_tzdb_unavailable');
});
