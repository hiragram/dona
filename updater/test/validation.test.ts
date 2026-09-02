import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parsePolicy } from "../src/policy.js";
import { redactText } from "../src/redaction.js";
import { parseApplyRequest, parsePlanRequest } from "../src/validation.js";
import { tempPolicy } from "./helpers.js";

describe("fixed self-update surface", () => {
  test("does not accept repository, ref, path, command, npm flags, launchctl args, or environment", () => {
    const base = {
      source_event_id: "evt_01M1ES03XY5CF8D9PM5CWX4SRV",
      reply_target: { kind: "slack_thread", workspace_id: "T_TEST", channel_id: "C_TEST", thread_ts: "1756722030.123456" },
    };
    for (const field of ["repository", "ref", "path", "command", "npm_flags", "launchctl_args", "environment"]) {
      assert.throws(() => parsePlanRequest({ ...base, [field]: "untrusted" }), /unsupported fields/);
    }
    assert.throws(() => parseApplyRequest({
      source_event_id: base.source_event_id,
      reply_target: base.reply_target,
      plan_id: "plan_01m1es03xy5cf8d9pm5cwx4srw",
      plan_hash: "a".repeat(64),
      approval_id: "approval-1",
      command: "rm",
    }), /unsupported fields/);
  });

  test("rejects a policy that changes the canonical repository or nests stable control under releases", async () => {
    const { root, policy } = await tempPolicy();
    try {
      assert.throws(() => parsePolicy({ ...policy, canonical_remote: "https://example.invalid/other.git" }), /canonical_remote/);
      assert.throws(() => parsePolicy({ ...policy, control_root: `${policy.release_root}/control` }), /outside/);
    } finally {
      const fs = await import("node:fs/promises");
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("redacts credentials and URLs before errors can reach logs or completion payloads", () => {
    const redacted = redactText("token=secret-value https://private.example.invalid/path xoxb-not-a-real-token\n/Users/example/private/release");
    assert.equal(redacted.includes("secret-value"), false);
    assert.equal(redacted.includes("private.example.invalid"), false);
    assert.equal(redacted.includes("xoxb-not-a-real-token"), false);
    assert.equal(redacted.includes("/Users/example"), false);
  });
});
