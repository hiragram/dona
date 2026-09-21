import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const fixtureUrl = new URL('../docs/adr/fixtures/cross-thread-authorization-v1/decisions.json', import.meta.url);
const raw = readFileSync(fixtureUrl, 'utf8');
const fixture = JSON.parse(raw);
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

test('cross-thread authorization fixtureはversion 1と署名golden vectorを固定する', () => {
  assert.equal(fixture.contract, 'cross-thread-authorization');
  assert.equal(fixture.version, 1);
  assert.equal(fixture.principal_proof.expires_after_seconds, 120);
  assert.equal(fixture.grant.max_age_seconds, 900);
  assert.equal(fixture.grant.expiry_exclusive, true);
  assert.deepEqual(fixture.principal_proof.encoding, {
    charset: 'UTF-8', key_order: 'ascii_recursive', trailing_lf: false,
    whitespace: false, time: 'utc_seconds_rfc3339',
  });
  const golden = fixture.principal_proof.golden;
  assert.equal(JSON.stringify(canonical(JSON.parse(golden.canonical))), golden.canonical);
  assert.equal(Buffer.from(golden.canonical).toString('utf8'), golden.canonical);
  assert.equal(createHmac('sha256', golden.sample_key).update(golden.canonical, 'utf8').digest('hex'),
    golden.hmac_sha256_hex);
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

const decide = entry => {
  const { request, binding, grant, principal } = entry;
  if (entry.transport !== 'authenticated') return ['deny', 'unverified_ingress'];
  if (!binding || !grant || principal.kind === 'unknown') return ['deny', 'legacy_unknown'];
  if (principal.kind !== 'human') return ['deny', 'principal_kind_denied'];
  if (binding.event_id !== request.event_id || binding.attempt !== request.attempt) return ['deny', 'event_attempt_mismatch'];
  if (principal.id !== binding.principal_id || principal.id !== grant.principal_id) return ['deny', 'principal_mismatch'];
  if (entry.access === 'unavailable') return ['deny', 'access_unavailable'];
  if (entry.access !== 'current') return ['deny', 'membership_revoked'];
  for (const key of ['tenant_id', 'workspace_id']) if (request[key] !== grant[key]) return ['deny', 'resource_mismatch'];
  for (const key of ['resource_kind', 'resource_id', 'resource_revision']) if (request[key] !== grant[key]) return ['deny', 'resource_mismatch'];
  if (request.operation !== grant.operation) return ['deny', 'operation_denied'];
  if (request.policy_revision !== grant.policy_revision) return ['deny', 'policy_revision_mismatch'];
  if (Date.parse(request.now) >= Date.parse(grant.expires_at)) return ['deny', 'grant_expired'];
  return ['allow', 'authorized'];
};

test('threat/failure fixtureは具体的な入力からallow/denyを導出する', () => {
  const byId = Object.fromEntries(fixture.cases.map(entry => [entry.id, entry]));
  assert.equal(Object.keys(byId).length, fixture.cases.length);
  for (const id of ['stale_event_substitution', 'forged_completion', 'unauthenticated_enqueue',
    'different_actor', 'bot_principal', 'service_principal', 'membership_revoked',
    'provider_unavailable', 'grant_before_expiry', 'grant_at_expiry', 'exact_task_mismatch',
    'operation_denied', 'policy_revision_mismatch', 'legacy_unknown']) {
    assert.ok(byId[id], id);
  }
  for (const entry of fixture.cases) {
    assert.ok(entry.request?.now, entry.id);
    assert.deepEqual(decide(entry), [entry.decision, entry.reason], entry.id);
  }
  assert.deepEqual(fixture.cases.filter(entry => entry.decision === 'allow').map(entry => entry.id), ['grant_before_expiry']);
  assert.equal(byId.grant_at_expiry.reason, 'grant_expired');
  assert.equal(byId.provider_unavailable.reason, 'access_unavailable');
  assert.equal(byId.legacy_unknown.principal.kind, 'unknown');
});

test('外部deny projection、approval、全downstream必須artifactを完全照合する', () => {
  assert.equal(fixture.deny_projection.includes_resource_identity, false);
  assert.deepEqual(fixture.deny_projection.codes, ['access_unavailable', 'not_available']);
  assert.deepEqual(fixture.approval, {
    max_age_seconds: 300,
    required_operations: ['cancel_exact_job', 'steer_exact_job'],
    issuer_kinds: ['supervisor'],
  });
  assert.deepEqual(fixture.downstream, {
    162: ['key_rotation', 'replay_fence', 'signed_ingress_proof'],
    163: ['attempt_capability', 'management_plane_separation'],
    164: ['legacy_unknown', 'principal_task_binding', 'resource_revision_binding'],
    165: ['current_access_proof', 'provider_fail_closed', 'visibility_check'],
    166: ['authorize_service', 'operation_catalog', 'restricted_audit', 'safe_projection'],
    244: ['human_wait_model'],
    245: ['bounded_pagination', 'filter_after_auth', 'opaque_origin_ref', 'read_own_human_waits'],
    246: ['ambiguous_post_no_retry', 'explicit_owner_intent', 'origin_reauthorization', 'safe_slack_renderer'],
  });
});
