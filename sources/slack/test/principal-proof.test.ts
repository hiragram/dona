import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";

import { principalProofKeyId, signSlackPrincipalProof } from "../src/principal-proof.js";

const key = "fixture-only-principal-proof-key-that-is-long-enough";
const envelope = {
  schema_version: 1,
  source: "slack",
  external_event_id: "Ev-proof-1",
  type: "app_mention",
  occurred_at: "2026-09-21T00:00:00Z",
  subject: { workspace_id: "T_FIXTURE", actor_id: "U_OWNER" },
  payload: { text: "private input is not signed into the identity proof" },
  reply_target: { kind: "slack_thread", workspace_id: "T_FIXTURE", channel_id: "C_PRIVATE", thread_ts: "1.000001" },
  trace: { ingress_attempt: 2 },
};

describe("Slack principal proof signer", () => {
  test("canonical identityをcurrent key、attempt、exclusive 120秒へ束縛する", () => {
    const signed = signSlackPrincipalProof(envelope, 2, key, new Date("2026-09-21T00:00:00Z"), "nonce-fixture-0001");
    const raw = Buffer.from(signed.proof, "base64url").toString("utf8");
    assert.equal(raw, JSON.stringify({
      attempt: 2,
      event_id: "Ev-proof-1",
      expires_at: "2026-09-21T00:02:00Z",
      issued_at: "2026-09-21T00:00:00Z",
      key_id: principalProofKeyId(key),
      nonce: "nonce-fixture-0001",
      principal_id: "U_OWNER",
      principal_kind: "human",
      tenant_id: "T_FIXTURE",
      version: 1,
      workspace_id: "T_FIXTURE",
    }));
    assert.equal(signed.signature, createHmac("sha256", key).update(raw).digest("base64url"));
  });

  test("actor欠落、workspace差替え用入力、空keyを署名しない", () => {
    assert.throws(() => signSlackPrincipalProof({ ...envelope, subject: { workspace_id: "T_FIXTURE" } }, 1, key), /invalid_slack_principal_input/);
    assert.throws(() => signSlackPrincipalProof(envelope, 0, key), /invalid_slack_principal_input/);
    assert.throws(() => signSlackPrincipalProof(envelope, 1, ""), /invalid_slack_principal_input/);
  });
});
