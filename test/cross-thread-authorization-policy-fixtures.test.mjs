import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const fixtureUrl = new URL('../docs/adr/fixtures/cross-thread-authorization-v1/decisions.json', import.meta.url);
const raw = readFileSync(fixtureUrl, 'utf8');
const fixture = JSON.parse(raw);
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

test('cross-thread authorization fixtureはcanonicalなversion 1である', () => {
  assert.equal(fixture.contract, 'cross-thread-authorization');
  assert.equal(fixture.version, 1);
  assert.equal(raw, `${JSON.stringify(canonical(fixture))}\n`);
  assert.equal(fixture.principal_proof.expires_after_seconds, 120);
  assert.equal(fixture.grant.max_age_seconds, 900);
  assert.equal(fixture.grant.expiry_exclusive, true);
});

test('principal proofとoperation catalogは重複のない固定集合である', () => {
  const required = fixture.principal_proof.required_fields;
  const operations = fixture.grant.operations;
  assert.deepEqual(required, [...required].sort());
  assert.deepEqual(operations, [...operations].sort());
  assert.equal(new Set(required).size, required.length);
  assert.equal(new Set(operations).size, operations.length);
  for (const field of ['event_id', 'attempt', 'tenant_id', 'workspace_id', 'principal_kind', 'principal_id', 'nonce']) {
    assert.ok(required.includes(field), field);
  }
  assert.ok(operations.includes('read_own_human_waits'));
  assert.deepEqual(fixture.principal_proof.kinds_allowed_owner_wide, ['human']);
});

test('threat/failure fixtureはallow条件とdeny分類を固定する', () => {
  const byId = Object.fromEntries(fixture.cases.map(entry => [entry.id, entry]));
  assert.equal(Object.keys(byId).length, fixture.cases.length);
  for (const id of ['stale_event_substitution', 'forged_completion', 'unauthenticated_enqueue',
    'different_actor', 'bot_principal', 'service_principal', 'membership_revoked',
    'provider_unavailable', 'grant_before_expiry', 'grant_at_expiry', 'legacy_unknown']) {
    assert.ok(byId[id], id);
  }
  assert.deepEqual(fixture.cases.filter(entry => entry.decision === 'allow').map(entry => entry.id), ['grant_before_expiry']);
  for (const entry of fixture.cases.filter(entry => entry.decision === 'deny')) {
    assert.notEqual(entry.reason, 'authorized');
  }
  assert.equal(byId.grant_at_expiry.reason, 'grant_expired');
  assert.equal(byId.provider_unavailable.reason, 'access_unavailable');
  assert.equal(byId.legacy_unknown.principal, 'unknown');
});

test('外部deny projectionと全downstream consumerを列挙する', () => {
  assert.equal(fixture.deny_projection.includes_resource_identity, false);
  assert.deepEqual(fixture.deny_projection.codes, ['access_unavailable', 'not_available']);
  assert.deepEqual(Object.keys(fixture.downstream).map(Number), [162, 163, 164, 165, 166, 244, 245, 246]);
  for (const artifacts of Object.values(fixture.downstream)) {
    assert.ok(artifacts.length > 0);
    assert.equal(new Set(artifacts).size, artifacts.length);
  }
});
