import assert from "node:assert/strict";
import test from "node:test";
import {
  AuditIntegrityError, signAuditCheckpoint, signAuditRecord, verifyAuditChain, verifyAuditRecord,
  type AuditAnchor, type AuditEvent, type AuditKey, type AuditRecord,
} from "../src/audit/codec.js";

const at = "2026-09-19T00:00:00.000Z";
const key: AuditKey = {
  version: 1, purpose: "audit", state: "active", activated_at: "2026-09-01T00:00:00.000Z",
  signing_expires_at: "2026-11-01T00:00:00.000Z", secret: Buffer.alloc(32, 0x42),
};
const lookup = (version: number) => version === 1 ? key : undefined;
const event: AuditEvent = {
  occurred_at: at, scope: { instance_id: "instance_1", tenant_id: "tenant_1" },
  actor: { kind: "principal", id: "principal_1" }, action: "web_authorize", resource_id: "job_1",
  outcome: "denied", reason: "unauthorized", session_ref: "session_1", receipt_id: null,
  attempt_id: null, policy_revision: 1, binding_revision: 1, role_revision: 1,
};
const genesis = () => signAuditCheckpoint({ codec_version: 1, chain_id: "chain_1", sequence: 0,
  through_mac: "0".repeat(64), through_occurred_at: null, signed_at: at, key_version: 1 }, lookup);
function record(sequence = 1, previous_mac = "0".repeat(64), input = event, version = 1): AuditRecord {
  return signAuditRecord({ codec_version: 1, chain_id: "chain_1", sequence,
    transaction_id: `tx_${sequence}`, previous_mac, key_version: version, event: input }, lookup);
}
function anchor(records: AuditRecord[]): AuditAnchor {
  return { chain_id: "chain_1", sequence: records.length, mac: records.at(-1)?.mac ?? "0".repeat(64),
    checkpoint_mac: genesis().mac, pending_transaction_id: null };
}

test("監査レコードはfield順序に依存せず、JSON保存を越えて検証できる", () => {
  const original = record();
  const reordered = Object.fromEntries(Object.entries(event).reverse()) as AuditEvent;
  assert.deepEqual(record(1, "0".repeat(64), reordered), original);
  assert.deepEqual(verifyAuditRecord(JSON.parse(JSON.stringify(original)), lookup), original);
  assert.equal(original.record_digest, "241bac0fa6441921e2e9138ab060aaf629e858caa2f7e63bf81dc566c198dceb");
});

test("共有chainはgenesisからDB外anchorまで連続している必要がある", () => {
  const first = record(); const second = record(2, first.mac);
  const tail = anchor([first, second]);
  assert.deepEqual(verifyAuditChain(genesis(), [first, second], tail, lookup), tail);
  assert.deepEqual(verifyAuditChain(genesis(), [], anchor([]), lookup), anchor([]));
  for (const rows of [[second], [first], [second, first], [first, first], []]) {
    assert.throws(() => verifyAuditChain(genesis(), rows, tail, lookup), AuditIntegrityError);
  }
  for (const changed of [
    { ...tail, pending_transaction_id: "tx_3" }, { ...tail, chain_id: "chain_other" },
    { ...tail, sequence: 1 }, { ...tail, mac: "f".repeat(64) }, { ...tail, checkpoint_mac: "a".repeat(64) },
  ]) assert.throws(() => verifyAuditChain(genesis(), [first, second], changed, lookup), AuditIntegrityError);
});

test("各署名fieldの改変、未知codec、未知field、曖昧な型を拒否する", () => {
  const original = record();
  for (const changed of [
    { ...original, sequence: 2 }, { ...original, transaction_id: "other" },
    { ...original, previous_mac: "a".repeat(64) }, { ...original, record_digest: "f".repeat(64) },
    { ...original, mac: "e".repeat(64) }, { ...original, key_version: 2 },
    { ...original, event: { ...event, outcome: "allowed" } },
    { ...original, codec_version: 2 }, { ...original, payload: "secret" },
    { ...original, sequence: "1" }, { ...original, sequence: 1.5 },
    { ...original, event: { ...event, actor: { kind: "unauthenticated", id: "claimed_user" } } },
    { ...original, event: { ...event, scope: { ...event.scope, email: "private@example.test" } } },
  ]) assert.throws(() => verifyAuditRecord(changed, lookup), AuditIntegrityError);
  for (const changed of [
    { ...event, reason: "arbitrary private text" }, { ...event, resource_id: "/private/path" },
    { ...event, occurred_at: "2026-09-19" }, { ...event, policy_revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...event, actor: { kind: "principal", id: "user\nsecret" } },
  ]) assert.throws(() => record(1, "0".repeat(64), changed as AuditEvent), AuditIntegrityError);
});

test("rotation済み鍵は検証専用で、欠落・revoked・異用途の鍵はfail closed", () => {
  const original = record();
  const retired = () => ({ ...key, state: "verification_only" as const });
  assert.deepEqual(verifyAuditRecord(original, retired), original);
  const { mac: ignoredMac, record_digest: ignoredDigest, ...body } = original;
  for (const invalid of [
    undefined, { ...key, state: "revoked" }, { ...key, purpose: "content" },
    { ...key, version: 2 }, { ...key, secret: Buffer.alloc(16) },
    { ...key, signing_expires_at: "2027-09-01T00:00:00.000Z" },
  ]) assert.throws(() => verifyAuditRecord(original, () => invalid as AuditKey | undefined), AuditIntegrityError);
  assert.throws(() => signAuditRecord(body, retired), AuditIntegrityError);
  for (const occurred_at of [key.signing_expires_at, "2026-08-31T23:59:59.999Z"]) {
    assert.throws(() => signAuditRecord({ ...body, event: { ...event, occurred_at } }, lookup), AuditIntegrityError);
  }
});

test("signed retention checkpointとanchorが一致するときだけprefixを省略できる", () => {
  const first = record(); const second = record(2, first.mac);
  const checkpoint = signAuditCheckpoint({ codec_version: 1, chain_id: "chain_1", sequence: 1,
    through_mac: first.mac, through_occurred_at: at, signed_at: at, key_version: 1 }, lookup);
  const tail = { ...anchor([first, second]), checkpoint_mac: checkpoint.mac };
  assert.deepEqual(verifyAuditChain(checkpoint, [second], tail, lookup), tail);
  assert.throws(() => verifyAuditChain(checkpoint, [second], anchor([first, second]), lookup), AuditIntegrityError);
  for (const changed of [{ ...checkpoint, sequence: 2 }, { ...checkpoint, through_mac: second.mac }]) {
    assert.throws(() => verifyAuditChain(changed, [second], tail, lookup), AuditIntegrityError);
  }
  assert.throws(() => verifyAuditChain(checkpoint, [first, second], tail, lookup), AuditIntegrityError);
});

test("時刻巻戻り、異なるchain、別用途MACを連続性の証拠にしない", () => {
  const first = record(); const older = record(2, first.mac, { ...event, occurred_at: "2026-09-18T00:00:00.000Z" });
  assert.throws(() => verifyAuditChain(genesis(), [first, older], anchor([first, older]), lookup), AuditIntegrityError);
  assert.throws(() => verifyAuditRecord({ ...first, mac: genesis().mac }, lookup), AuditIntegrityError);
  assert.throws(() => verifyAuditChain({ ...genesis(), chain_id: "other" }, [], anchor([]), lookup), AuditIntegrityError);
});

test("provider例外やvalidation errorに秘密を転載しない", () => {
  try { verifyAuditRecord(record(), () => { throw new Error("sensitive-key-material"); }); }
  catch (error) { assert.equal(String(error), "AuditIntegrityError: audit_integrity_unverified"); return; }
  assert.fail("must fail closed");
});

test("鍵rotationを跨ぐchainとretention後の時刻境界を検証する", () => {
  const first = record();
  const nextKey: AuditKey = { ...key, version: 2, secret: Buffer.alloc(32, 0x43) };
  const rotated = (version: number) => version === 1 ? { ...key, state: "verification_only" as const }
    : version === 2 ? nextKey : undefined;
  const second = signAuditRecord({ codec_version: 1, chain_id: "chain_1", sequence: 2,
    transaction_id: "tx_2", previous_mac: first.mac, key_version: 2, event }, rotated);
  assert.deepEqual(verifyAuditChain(genesis(), [first, second], anchor([first, second]), rotated), anchor([first, second]));
  const checkpoint = signAuditCheckpoint({ codec_version: 1, chain_id: "chain_1", sequence: 1,
    through_mac: first.mac, through_occurred_at: at, signed_at: at, key_version: 2 }, rotated);
  const older = signAuditRecord({ codec_version: 1, chain_id: "chain_1", sequence: 2,
    transaction_id: "tx_2", previous_mac: first.mac, key_version: 2,
    event: { ...event, occurred_at: "2026-09-18T00:00:00.000Z" } }, rotated);
  assert.throws(() => verifyAuditChain(checkpoint, [older], {
    ...anchor([first, older]), checkpoint_mac: checkpoint.mac,
  }, rotated), AuditIntegrityError);
});
