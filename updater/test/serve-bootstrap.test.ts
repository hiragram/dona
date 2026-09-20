import assert from "node:assert/strict";
import { test } from "node:test";

import { initializeServe } from "../src/serve-bootstrap.js";

test("serve initialization closes the acquired listener when diagnostic recovery fails", async () => {
  const calls: string[] = [];
  const failure = new Error("diagnostic recovery failed");
  await assert.rejects(initializeServe(
    {
      async start() { calls.push("api:start"); },
      async stop() { calls.push("api:stop"); },
    },
    {
      recoverInterruptedCaptures() {
        calls.push("diagnostics:recover");
        throw failure;
      },
    },
    { maintainDiagnostics() { calls.push("controller:maintain"); } },
    { start() { calls.push("service:start"); } },
  ), (error: unknown) => error === failure);
  assert.deepEqual(calls, ["api:start", "diagnostics:recover", "api:stop"]);
});
