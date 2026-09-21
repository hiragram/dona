import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { normalizeManualEnvelope } from "../src/manual-envelope.js";

describe("manual ingress envelope", () => {
  test("省略したingress attemptをenvelopeとproof入力の両方で1へ固定する", () => {
    const normalized = normalizeManualEnvelope({
      source: "slack",
      subject: { workspace_id: "T_FIXTURE", actor_id: "U_OWNER" },
      trace: { socket_envelope_id: "manual-fixture" },
    });
    assert.equal(normalized.attempt, 1);
    assert.equal(normalized.workspaceId, "T_FIXTURE");
    assert.deepEqual(normalized.envelope.trace, {
      socket_envelope_id: "manual-fixture",
      ingress_attempt: 1,
    });
  });

  test("明示attemptを維持し、workspaceなしや不正入力を拒否する", () => {
    const normalized = normalizeManualEnvelope({
      subject: { workspace_id: "T_FIXTURE" },
      trace: { ingress_attempt: 3 },
    });
    assert.equal(normalized.attempt, 3);
    assert.equal((normalized.envelope.trace as Record<string, unknown>).ingress_attempt, 3);
    assert.throws(() => normalizeManualEnvelope({ trace: {} }), /workspace is required/);
    assert.throws(() => normalizeManualEnvelope([]), /must be an object/);
  });
});
