import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, describe, test } from "node:test";

import { DispatcherDatabase } from "../src/database.js";
import { PrincipalBindingConflictError } from "../src/principal-binding.js";
import { principalProofKeyId, PrincipalProofError, verifySlackPrincipalProof, type VerifiedSlackPrincipalProof } from "../src/principal-proof.js";
import { stableStringify } from "../src/validation.js";
import { eventEnvelope, tempConfig, testInternalToken } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

function signed(envelope: ReturnType<typeof eventEnvelope>, overrides: Record<string, unknown> = {}, key = testInternalToken) {
  const raw = stableStringify({
    attempt: 1,
    event_id: envelope.external_event_id,
    expires_at: "2026-09-21T00:02:00Z",
    issued_at: "2026-09-21T00:00:00Z",
    key_id: principalProofKeyId(key),
    nonce: `nonce-${envelope.external_event_id}`,
    principal_id: envelope.subject.actor_id,
    principal_kind: "human",
    tenant_id: envelope.subject.workspace_id,
    version: 1,
    workspace_id: envelope.subject.workspace_id,
    ...overrides,
  });
  return { proof: Buffer.from(raw).toString("base64url"), signature: createHmac("sha256", key).update(raw).digest("base64url") };
}

function verified(envelope: ReturnType<typeof eventEnvelope>, overrides: Record<string, unknown> = {}): VerifiedSlackPrincipalProof {
  const value = signed(envelope, overrides);
  return verifySlackPrincipalProof(envelope, value.proof, value.signature, testInternalToken, new Date("2026-09-21T00:01:00Z"));
}

describe("Slack principal proof verifier", () => {
  test("署名済みidentityだけを受理し、actor/workspace/attempt/key rotation/expiryをfail-closedにする", () => {
    const envelope = eventEnvelope("Ev-proof-verify");
    assert.equal(verified(envelope).principal_id, "U_TEST");
    for (const [overrides, code] of [
      [{ principal_id: "U_OTHER" }, "principal_proof_identity_mismatch"],
      [{ workspace_id: "T_OTHER" }, "principal_proof_identity_mismatch"],
      [{ attempt: 2 }, "principal_proof_identity_mismatch"],
      [{ key_id: "sha256:0000000000000000" }, "principal_proof_invalid"],
    ] as const) {
      assert.throws(() => verified(envelope, overrides), (error: unknown) => error instanceof PrincipalProofError && error.code === code);
    }
    const stale = signed(envelope);
    assert.throws(() => verifySlackPrincipalProof(envelope, stale.proof, stale.signature, testInternalToken, new Date("2026-09-21T00:02:00Z")),
      (error: unknown) => error instanceof PrincipalProofError && error.code === "principal_proof_expired");
    const rotated = signed(envelope, {}, "old-key-that-is-no-longer-active-00000000");
    assert.throws(() => verifySlackPrincipalProof(envelope, rotated.proof, rotated.signature, testInternalToken, new Date("2026-09-21T00:01:00Z")),
      (error: unknown) => error instanceof PrincipalProofError && error.code === "principal_proof_invalid");
  });

  test("non-canonical raw JSONと重複keyをparse前相当で拒否する", () => {
    const envelope = eventEnvelope("Ev-proof-raw");
    const raw = '{"attempt":1,"attempt":2,"event_id":"Ev-proof-raw"}';
    const signature = createHmac("sha256", testInternalToken).update(raw).digest("base64url");
    assert.throws(() => verifySlackPrincipalProof(envelope, Buffer.from(raw).toString("base64url"), signature, testInternalToken,
      new Date("2026-09-21T00:01:00Z")), (error: unknown) => error instanceof PrincipalProofError && error.code === "principal_proof_invalid");
  });
});

describe("verified principal binding", () => {
  test("eventと同一transactionで保存し、restart後も同一proofだけをidempotentに受理する", async () => {
    const { root, config } = await tempConfig(); roots.push(root);
    const envelope = eventEnvelope("Ev-proof-durable"), proof = verified(envelope);
    let database = new DispatcherDatabase(config.databasePath);
    const first = database.enqueue(envelope, new Date("2026-09-21T00:01:00Z"), proof);
    assert.equal(database.getVerifiedPrincipalBinding(first.row.event_id)?.proof_sha256, proof.proof_sha256);
    assert.equal(database.enqueue(envelope, new Date("2026-09-21T00:01:30Z"), proof).duplicate, true);
    database.close();
    database = new DispatcherDatabase(config.databasePath);
    assert.equal(database.getVerifiedPrincipalBinding(first.row.event_id)?.principal_id, "U_TEST");
    const retry = { ...proof, attempt:2, nonce:"retry-proof-nonce-0002", proof_sha256:"0".repeat(64) };
    assert.equal(database.enqueue(envelope, new Date("2026-09-21T00:01:40Z"), retry).duplicate,true);
    assert.throws(() => database.enqueue(envelope, new Date("2026-09-21T00:01:50Z"), { ...retry, principal_id:"U_OTHER", proof_sha256:"1".repeat(64) }), PrincipalBindingConflictError);
    assert.equal(database.list().length, 1);
    database.close();
  });

  test("nonce競合ではevent insertもrollbackしlegacy actorをbackfillしない", async () => {
    const { root, config } = await tempConfig(); roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const first = eventEnvelope("Ev-proof-one"), firstProof = verified(first);
    database.enqueue(first, new Date("2026-09-21T00:01:00Z"), firstProof);
    const second = eventEnvelope("Ev-proof-two"), secondProof = verified(second);
    assert.throws(() => database.enqueue(second, new Date("2026-09-21T00:01:10Z"), { ...secondProof, nonce: firstProof.nonce }), PrincipalBindingConflictError);
    assert.equal(database.getByExternalId("slack", "Ev-proof-two"), undefined);
    const legacy = eventEnvelope("Ev-proof-legacy");
    const legacyRow = database.enqueue(legacy).row;
    assert.equal(database.getVerifiedPrincipalBinding(legacyRow.event_id), undefined);
    database.close();
  });
});
