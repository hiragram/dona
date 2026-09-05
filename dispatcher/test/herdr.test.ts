import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { HerdrProcessClient } from "../src/herdr.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("HerdrProcessClient", () => {
  test("finds the nested agent lifecycle instead of a top-level response status", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-herdr-test-"));
    roots.push(root);
    const executable = path.join(root, "fake-herdr");
    await fs.writeFile(
      executable,
      "#!/bin/sh\nprintf '%s\\n' '{\"status\":\"ok\",\"result\":{\"agent\":{\"agent_name\":\"dona-main\",\"workspace_id\":\"w1\",\"pane_id\":\"p1\",\"agent_session\":{\"kind\":\"id\",\"value\":\"s1\"},\"agent_status\":\"idle\",\"state_change_seq\":7}}}'\n",
      { mode: 0o700 },
    );
    const client = new HerdrProcessClient({
      executable,
      session: "dona",
      agentName: "dona-main",
      waitTimeoutMs: 100,
    });
    const result = await client.get();
    assert.equal(result.ok, true);
    assert.equal(result.agentStatus, "idle");
    assert.equal(result.agentIdentity, '["w1","p1","dona-main","s1"]');
    assert.equal(result.stateChangeSeq, 7);
  });

  test("waits for a state change when submitting a prompt", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-herdr-test-"));
    roots.push(root);
    const executable = path.join(root, "fake-herdr.mjs");
    const argumentsPath = path.join(root, "arguments.json");
    await fs.writeFile(
      executable,
      `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(process.env.HERDR_TEST_ARGUMENTS_PATH, JSON.stringify(process.argv.slice(2)));
console.log('{"status":"ok","result":{"agent":{"agent_status":"working"}}}');
`,
      { mode: 0o700 },
    );
    const previousArgumentsPath = process.env.HERDR_TEST_ARGUMENTS_PATH;
    process.env.HERDR_TEST_ARGUMENTS_PATH = argumentsPath;
    try {
      const client = new HerdrProcessClient({
        executable,
        session: "dona",
        agentName: "dona-main",
        waitTimeoutMs: 100,
        commandTimeoutMs: 321,
      });
      const result = await client.prompt("hello");
      const args = JSON.parse(await fs.readFile(argumentsPath, "utf8")) as string[];
      assert.equal(result.ok, true);
      assert.equal(result.agentStatus, "working");
      assert.deepEqual(args, [
        "--session",
        "dona",
        "agent",
        "prompt",
        "dona-main",
        "hello",
        "--wait",
        "--until",
        "working",
        "--until",
        "idle",
        "--until",
        "done",
        "--until",
        "blocked",
        "--timeout",
        "321",
      ]);
    } finally {
      if (previousArgumentsPath === undefined) delete process.env.HERDR_TEST_ARGUMENTS_PATH;
      else process.env.HERDR_TEST_ARGUMENTS_PATH = previousArgumentsPath;
    }
  });

  test("returns at the command deadline even when Herdr ignores SIGTERM", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-herdr-timeout-"));
    roots.push(root);
    const executable = path.join(root, "fake-herdr");
    await fs.writeFile(executable, "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n", { mode: 0o700 });
    const client = new HerdrProcessClient({
      executable,
      session: "test",
      agentName: "dona-main",
      waitTimeoutMs: 100,
      commandTimeoutMs: 20,
    });
    const started = Date.now();
    const result = await client.get();
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 500);
  });
});
