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
  assert.deepEqual(required, ['attempt', 'event_id', 'expires_at', 'issued_at', 'key_id', 'nonce',
    'principal_id', 'principal_kind', 'tenant_id', 'version', 'workspace_id']);
  assert.deepEqual(operations, ['cancel_exact_job', 'read_bounded_result', 'read_exact_job_status',
    'read_own_human_waits', 'resolve_origin_ref', 'steer_exact_job']);
  assert.deepEqual(fixture.principal_proof.kinds_allowed_owner_wide, ['human']);
});

const decide = entry => {
  const { request, binding, grant, principal, transport_context: transport, access_proof: access } = entry;
  if (!transport.authenticated) return ['deny', 'unverified_ingress'];
  if (!principal || !binding || !grant || principal.kind === 'unknown') return ['deny', 'legacy_unknown'];
  if (principal.kind !== 'human') return ['deny', 'principal_kind_denied'];
  if (transport.event_id !== request.event_id || transport.attempt !== request.attempt
    || binding.event_id !== request.event_id || binding.attempt !== request.attempt) return ['deny', 'event_attempt_mismatch'];
  if (binding.principal_kind !== principal.kind) return ['deny', 'principal_kind_denied'];
  if (principal.id !== binding.principal_id || principal.id !== grant.principal_id) return ['deny', 'principal_mismatch'];
  if (principal.tenant_id !== request.tenant_id || principal.workspace_id !== request.workspace_id) return ['deny', 'principal_scope_mismatch'];
  for (const key of ['tenant_id', 'workspace_id']) {
    if (request[key] !== binding[key] || request[key] !== grant[key]) return ['deny', 'binding_scope_mismatch'];
  }
  if (binding.status !== 'active' || binding.revoked_at) return ['deny', 'binding_revoked'];
  if (binding.current_revision !== request.binding_revision) return ['deny', 'binding_revoked'];
  if (access.status === 'unavailable') return ['deny', 'access_unavailable'];
  if (access.status !== 'current') return ['deny', 'membership_revoked'];
  const accessIssued = Date.parse(access.issued_at), accessExpires = Date.parse(access.expires_at), now = Date.parse(request.now);
  const accessLifetime = accessExpires - accessIssued;
  if (access.event_id !== request.event_id || access.principal_id !== principal.id
    || access.workspace_id !== request.workspace_id || access.destination_id !== request.destination_id
    || access.consumed || !access.signature_verified || typeof access.nonce !== 'string' || access.nonce.length === 0
    || ![accessIssued, accessExpires, now].every(Number.isFinite)
    || accessLifetime <= 0 || accessLifetime > fixture.access_proof.max_age_seconds * 1000
    || accessIssued > now || now >= accessExpires) {
    return ['deny', 'access_unavailable'];
  }
  if (!['exact_resource', 'epic_children_snapshot'].includes(grant.scope_kind)) return ['deny', 'resource_mismatch'];
  if (grant.scope_kind === 'epic_children_snapshot') {
    if (grant.resource_kind !== 'epic' || request.parent_resource_id !== grant.resource_id
      || request.parent_resource_revision !== grant.resource_revision
      || !grant.child_snapshot.includes(request.resource_id)) return ['deny', 'resource_mismatch'];
  } else {
    for (const key of ['resource_kind', 'resource_id', 'resource_revision']) if (request[key] !== grant[key]) return ['deny', 'resource_mismatch'];
  }
  if (!fixture.grant.operations.includes(request.operation) || !fixture.grant.operations.includes(grant.operation)
    || request.operation !== grant.operation) return ['deny', 'operation_denied'];
  if (request.policy_revision !== grant.policy_revision
    || entry.current_policy_revision !== request.policy_revision) return ['deny', 'policy_revision_mismatch'];
  if (grant.status !== 'active' || grant.revoked_at) return ['deny', 'grant_revoked'];
  const expectedGrantRevision = grant.scope_kind === 'epic_children_snapshot'
    ? request.parent_resource_revision : request.resource_revision;
  if (entry.current_resource_revision !== expectedGrantRevision) return ['deny', 'resource_mismatch'];
  const grantIssued = Date.parse(grant.issued_at), grantExpires = Date.parse(grant.expires_at);
  const grantLifetime = grantExpires - grantIssued;
  if (![grantIssued, grantExpires, now].every(Number.isFinite) || grantIssued > now
    || grantLifetime <= 0 || grantLifetime > fixture.grant.max_age_seconds * 1000) return ['deny', 'invalid_grant_lifetime'];
  if (now >= grantExpires) return ['deny', 'grant_expired'];
  if (fixture.approval.required_operations.includes(request.operation)) {
    const receipt = entry.approval_receipt;
    const requiredFields = ['version', 'receipt_id', 'issuer_kind', 'issuer_id', 'tenant_id', 'principal_id',
      'resource_kind', 'resource_id', 'resource_revision', 'operation', 'issued_at', 'expires_at',
      'policy_revision', 'nonce', 'consumed', 'signature_verified'];
    const complete = receipt && requiredFields.every(key => Object.hasOwn(receipt, key));
    const validIssuer = complete && receipt.version === 1 && receipt.signature_verified
      && typeof receipt.receipt_id === 'string' && receipt.receipt_id.length > 0
      && typeof receipt.issuer_id === 'string' && receipt.issuer_id.length > 0
      && typeof receipt.nonce === 'string' && receipt.nonce.length > 0
      && fixture.approval.issuer_kinds.includes(receipt.issuer_kind);
    const validIdentity = receipt && receipt.tenant_id === request.tenant_id
      && receipt.principal_id === principal.id && receipt.resource_kind === request.resource_kind
      && receipt.resource_id === request.resource_id && receipt.resource_revision === request.resource_revision
      && receipt.operation === request.operation && receipt.policy_revision === request.policy_revision;
    const receiptIssued = receipt ? Date.parse(receipt.issued_at) : NaN;
    const receiptExpires = receipt ? Date.parse(receipt.expires_at) : NaN;
    const lifetime = receiptExpires - receiptIssued;
    if (!complete || !validIssuer || !validIdentity || receipt.consumed
      || ![receiptIssued, receiptExpires, now].every(Number.isFinite) || receiptIssued > now
      || lifetime <= 0 || lifetime > fixture.approval.max_age_seconds * 1000
      || now >= receiptExpires) return ['deny', 'approval_unavailable'];
  }
  return ['allow', 'authorized'];
};

const projectDeny = entry => entry.decision === 'allow' ? null : ({
  code: ['access_unavailable', 'membership_revoked'].includes(entry.reason) ? 'access_unavailable' : 'not_available',
});

test('threat/failure fixtureは具体的な入力からallow/denyを導出する', () => {
  const byId = Object.fromEntries(fixture.cases.map(entry => [entry.id, entry]));
  assert.equal(Object.keys(byId).length, fixture.cases.length);
  for (const id of ['stale_event_substitution', 'forged_completion', 'unauthenticated_enqueue',
    'different_actor', 'bot_principal', 'service_principal', 'membership_revoked',
    'provider_unavailable', 'grant_before_expiry', 'grant_at_expiry', 'exact_task_mismatch',
    'operation_denied', 'policy_revision_mismatch', 'legacy_unknown', 'stale_transport_capability',
    'binding_tenant_mismatch', 'binding_workspace_mismatch', 'binding_kind_mismatch',
    'grant_too_long', 'grant_revoked', 'unknown_operation', 'access_destination_mismatch',
    'access_principal_mismatch', 'access_event_mismatch', 'access_expired', 'access_consumed',
    'steer_with_approval', 'steer_missing_approval', 'cancel_approval_at_expiry',
    'steer_approval_issuer_mismatch', 'steer_approval_resource_mismatch',
    'steer_approval_revision_mismatch', 'principal_tenant_mismatch', 'principal_workspace_mismatch',
    'binding_revoked', 'current_policy_revision_mismatch', 'access_negative_lifetime',
    'access_future_issued_at', 'access_invalid_time', 'steer_approval_missing_field',
    'steer_approval_unknown_version', 'steer_approval_unverified', 'allow_read_exact_job_status',
    'allow_read_bounded_result', 'allow_resolve_origin_ref', 'allow_cancel_exact_job',
    'epic_snapshot_child', 'epic_future_child', 'grant_invalid_time', 'grant_future_issued_at',
    'approval_invalid_time', 'approval_future_issued_at', 'approval_negative_lifetime',
    'access_nonce_missing', 'access_nonce_empty', 'access_signature_unverified', 'unknown_grant_scope',
    'principal_missing', 'exact_current_revision_mismatch', 'epic_current_revision_mismatch',
    'steer_replayed_nonce', 'cancel_replayed_nonce']) {
    assert.ok(byId[id], id);
  }
  for (const entry of fixture.cases) {
    assert.ok(entry.request?.now, entry.id);
    assert.deepEqual(decide(entry), [entry.decision, entry.reason], entry.id);
    assert.deepEqual(projectDeny(entry), entry.expected_external, entry.id);
    if (entry.expected_external) assert.deepEqual(Object.keys(entry.expected_external), ['code'], entry.id);
    if (entry.request.operation.startsWith('read_') || entry.request.operation === 'resolve_origin_ref') {
      assert.deepEqual(entry.state_after, entry.state_before, entry.id);
      assert.deepEqual(entry.expected_effects, ['restricted_authorization_audit'], entry.id);
    }
    if (entry.decision === 'deny' && ['steer_exact_job', 'cancel_exact_job'].includes(entry.request.operation)) {
      assert.deepEqual(entry.state_after, entry.state_before, entry.id);
      assert.deepEqual(entry.expected_effects, ['restricted_authorization_audit'], entry.id);
    }
    if (entry.decision === 'allow' && ['steer_exact_job', 'cancel_exact_job'].includes(entry.request.operation)) {
      assert.equal(entry.state_before.access_nonce_consumed, false, entry.id);
      assert.equal(entry.state_before.approval_nonce_consumed, false, entry.id);
      assert.equal(entry.state_after.access_nonce_consumed, true, entry.id);
      assert.equal(entry.state_after.approval_nonce_consumed, true, entry.id);
      assert.deepEqual(entry.expected_effects,
        ['authorized_operation', 'consume_access_nonce', 'consume_approval_nonce', 'restricted_authorization_audit'], entry.id);
    }
  }
  assert.deepEqual(new Set(fixture.cases.filter(entry => entry.decision === 'allow').map(entry => entry.request.operation)),
    new Set(fixture.grant.operations));
  assert.equal(byId.grant_at_expiry.reason, 'grant_expired');
  assert.equal(byId.provider_unavailable.reason, 'access_unavailable');
  assert.equal(byId.legacy_unknown.principal.kind, 'unknown');
});

test('principal proofは期限・未来発行・replay・署名をfail-closedにする', () => {
  const decideProof = entry => {
    const now = Date.parse(entry.now), issued = Date.parse(entry.issued_at), expires = Date.parse(entry.expires_at);
    if (!entry.signature_verified) return ['deny', 'unverified_ingress'];
    if (entry.consumed) return ['deny', 'proof_replayed'];
    if (![now, issued, expires].every(Number.isFinite) || issued > now || expires - issued <= 0
      || expires - issued > fixture.principal_proof.expires_after_seconds * 1000) return ['deny', 'invalid_proof_time'];
    if (now >= expires) return ['deny', 'proof_expired'];
    return ['allow', 'verified'];
  };
  for (const entry of fixture.principal_proof.cases) {
    assert.equal(typeof entry.nonce, 'string', entry.id);
    assert.ok(entry.nonce.length > 0, entry.id);
    assert.deepEqual(decideProof(entry), [entry.decision, entry.reason], entry.id);
  }
});

test('delegated grantはchild・operation・expiryを縮小する場合だけ許可する', () => {
  const isSubset = (child, parent) => child.every(value => parent.includes(value));
  for (const entry of fixture.delegation_cases) {
    const allowed = isSubset(entry.child.children, entry.parent.children)
      && isSubset(entry.child.operations, entry.parent.operations)
      && Date.parse(entry.child.expires_at) <= Date.parse(entry.parent.expires_at);
    assert.equal(allowed ? 'allow' : 'deny', entry.decision, entry.id);
  }
});

test('外部deny projection、approval、全downstream必須artifactを完全照合する', () => {
  assert.equal(fixture.deny_projection.includes_resource_identity, false);
  assert.deepEqual(fixture.deny_projection.codes, ['access_unavailable', 'not_available']);
  assert.deepEqual(fixture.approval, {
    max_age_seconds: 300,
    required_operations: ['cancel_exact_job', 'steer_exact_job'],
    issuer_kinds: ['supervisor'],
  });
  assert.deepEqual(fixture.access_proof, {
    expiry_exclusive: true, max_age_seconds: 120, one_time_for_write: true,
  });
  assert.deepEqual(fixture.downstream, {
    162: ['key_rotation', 'replay_fence', 'signed_ingress_proof'],
    163: ['attempt_capability', 'management_plane_separation'],
    164: ['legacy_unknown', 'principal_task_binding', 'resource_revision_binding'],
    165: ['current_access_proof', 'provider_fail_closed', 'visibility_check'],
    166: ['authorize_service', 'delegation_subset', 'operation_catalog', 'restricted_audit', 'safe_projection'],
    244: ['human_wait_model'],
    245: ['bounded_pagination', 'filter_after_auth', 'opaque_origin_ref', 'read_own_human_waits'],
    246: ['ambiguous_post_no_retry', 'explicit_owner_intent', 'origin_reauthorization', 'safe_slack_renderer'],
  });
});
