import assert from "node:assert/strict";
import { test } from "node:test";
import { signApprovalExecutionMarker, verifyApprovalExecutionMarker, encodeApprovalExecutionMarker, approvalExecutionBlockId,
  ApprovalExecutionMarkerError, type ApprovalExecutionMarker, type ApprovalExecutionMarkerKey } from "../../src/approval/execution-marker.js";
import type { ClockMark } from "../../src/approval/clock.js";
const marker: ApprovalExecutionMarker = { codec_version: 1, scope: { instance_id: "instance", workspace_id: "tenant" }, request_id: "request",
  consume_id: "consume", attempt_id: "attempt", operation: "slack.post_thread_reply.v1", semantic_hash: "a".repeat(64), execution_fence: 2,
  created_at: "2026-09-19T00:00:00.000Z", clock_transaction_id: "transaction", key_version: 1 };
export const key: ApprovalExecutionMarkerKey = { purpose: "approval_execution_marker", version: 1, state: "active", activated_at: "2026-09-01T00:00:00.000Z",
  signing_expires_at: "2026-11-01T00:00:00.000Z", secret: Buffer.alloc(32, 94) };
const mark: ClockMark = { codec_version: 1, transaction_id: "transaction", previous_transaction_id: null, boot_id: "boot", continuous_ms: 1, effective_utc: marker.created_at };
test("execution markerは独立HMAC vectorへ一致しattempt・fence・snapshot・scopeを結合する", () => {
  const signed = signApprovalExecutionMarker(marker, key, mark);
  assert.equal(signed.mac, "390c6b830caccaf698a29b2ae4eda2ed639e6d59a5c5060cdd449e9b12a685c2"); verifyApprovalExecutionMarker(signed, key);
  for (const change of [{ scope: { ...marker.scope, instance_id: "other" } }, { scope: { ...marker.scope, workspace_id: "other" } },
    { request_id: "other" }, { consume_id: "other" }, { attempt_id: "other" }, { semantic_hash: "b".repeat(64) }, { execution_fence: 3 },
    { created_at: "2026-09-19T00:00:01.000Z" }, { clock_transaction_id: "other" }, { key_version: 2 }])
    assert.throws(() => verifyApprovalExecutionMarker({ ...signed, marker: { ...marker, ...change } }, key), ApprovalExecutionMarkerError);
  assert.equal(approvalExecutionBlockId(signed), `dona.ex1.attempt.${signed.mac}`);
  const largest = signApprovalExecutionMarker({ ...marker, attempt_id: "a".repeat(128) }, key, mark);
  assert.equal(approvalExecutionBlockId(largest).length, 202);
  assert.equal(encodeApprovalExecutionMarker(signed).wire, JSON.stringify(signed));
});
test("execution markerは用途別保持鍵で検証しrotation後の再署名・失効・期間外を拒否する", () => {
  const signed = signApprovalExecutionMarker(marker, key, mark), old = { ...key, state: "verification_only" as const };
  verifyApprovalExecutionMarker(signed, old); assert.throws(() => signApprovalExecutionMarker(marker, old, mark), ApprovalExecutionMarkerError);
  for (const invalid of [{ ...key, state: "revoked" as const }, { ...key, purpose: "approval_notification_marker" as never }, { ...key, version: 2 },
    { ...key, secret: Buffer.alloc(31) }, { ...key, signing_expires_at: marker.created_at }, { ...key, signing_expires_at: "2027-01-01T00:00:00.000Z" }])
    assert.throws(() => verifyApprovalExecutionMarker(signed, invalid), ApprovalExecutionMarkerError);
  for (const change of [{ transaction_id: "other" }, { effective_utc: "2026-09-19T00:00:01.000Z" }])
    assert.throws(() => signApprovalExecutionMarker(marker, key, { ...mark, ...change }), ApprovalExecutionMarkerError);
});
test("execution markerは未知operation・field・getter・Proxyと非canonical MACを拒否する", () => {
  const signed = signApprovalExecutionMarker(marker, key, mark); let calls = 0;
  for (const invalid of [{ ...signed, unknown: true }, { ...signed, marker: { ...marker, operation: "arbitrary" } },
    { ...signed, mac: signed.mac.toUpperCase() }, new Proxy(signed, { get() { calls++; throw Error(); } }),
    { ...signed, get marker() { calls++; return marker; } }])
    assert.throws(() => encodeApprovalExecutionMarker(invalid as never), ApprovalExecutionMarkerError);
  assert.equal(calls, 0);
});
