import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { DispatcherDatabase } from "../src/database.js";
import { codexAgentArguments, HerdrJobAgentRuntime } from "../src/job-runtime.js";
import { eventEnvelope, tempConfig } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Codex background agent arguments", () => {
  test("trusts only the Dispatcher-selected GitHub repository and worktree for the invocation", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-runtime-args")).row;
    const job = database.createJob(
      {
        source_event_id: source.event_id,
        objective: "コードを解析する",
        workspace: { kind: "github", repository: "reirei-lab/boatrace" },
      },
      config.jobsWorkspaceRoot,
      config.jobResultsDir,
    ).row;
    const repositoryPath = `${config.jobsWorkspaceRoot}/github/reirei-lab/boatrace/repository`;
    assert.deepEqual(codexAgentArguments(job, config), [
      "--add-dir",
      config.jobResultsDir,
      "-c",
      `projects = { ${JSON.stringify(repositoryPath)} = { trust_level = "trusted" }, ${JSON.stringify(job.workspace_path)} = { trust_level = "trusted" } }`,
    ]);
    database.close();
  });

  test("trusts only the exact Dispatcher-selected scratch workspace", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-scratch-runtime-args")).row;
    const job = database.createJob(
      { source_event_id: source.event_id, objective: "調査する", workspace: { kind: "scratch" } },
      config.jobsWorkspaceRoot,
      config.jobResultsDir,
    ).row;
    const expectedOverride = `projects = { ${JSON.stringify(job.workspace_path)} = { trust_level = "trusted" } }`;
    const args = codexAgentArguments(job, config);
    assert.deepEqual(args, ["--add-dir", config.jobResultsDir, "-c", expectedOverride]);
    assert.equal(args[3]!.match(/trust_level/g)?.length, 1);
    assert.equal(args[3]!.includes(`${JSON.stringify(config.jobsWorkspaceRoot)} =`), false);
    assert.equal(args[3]!.includes(`${JSON.stringify(config.jobResultsDir)} =`), false);
    database.close();
  });

  test("rejects a scratch workspace path that is not the generated path for the job", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-invalid-scratch-runtime-args")).row;
    const job = database.createJob(
      { source_event_id: source.event_id, objective: "調査する", workspace: { kind: "scratch" } },
      config.jobsWorkspaceRoot,
      config.jobResultsDir,
    ).row;

    assert.throws(
      () => codexAgentArguments({ ...job, workspace_path: path.join(config.jobsWorkspaceRoot, "scratch") }, config),
      /does not match the Dispatcher-generated job path/,
    );
    const outsidePath = path.join(root, "unexpected-scratch-workspace");
    await assert.rejects(
      new HerdrJobAgentRuntime({ ...config, herdrPath: path.join(root, "must-not-run") })
        .prepare({ ...job, workspace_path: outsidePath }),
      /does not match the Dispatcher-generated job path/,
    );
    await assert.rejects(fs.access(outsidePath), { code: "ENOENT" });
    database.close();
  });

  test("escapes spaces, quotes, and backslashes in a scratch workspace TOML inline table", async () => {
    const { root, config: baseConfig } = await tempConfig();
    roots.push(root);
    const config = {
      ...baseConfig,
      jobsWorkspaceRoot: path.join(root, 'workspaces with "quotes" and \\slashes'),
    };
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-escaped-scratch-runtime-args")).row;
    const job = database.createJob(
      { source_event_id: source.event_id, objective: "調査する", workspace: { kind: "scratch" } },
      config.jobsWorkspaceRoot,
      config.jobResultsDir,
    ).row;

    assert.deepEqual(codexAgentArguments(job, config), [
      "--add-dir",
      config.jobResultsDir,
      "-c",
      `projects = { ${JSON.stringify(job.workspace_path)} = { trust_level = "trusted" } }`,
    ]);
    database.close();
  });

  test("passes the exact scratch trust override through Herdr agent start argv", async () => {
    const { root, config: baseConfig } = await tempConfig();
    roots.push(root);
    const capturePath = path.join(root, "herdr-start-argv.json");
    const fakeHerdrPath = path.join(root, "fake-herdr.mjs");
    await fs.writeFile(fakeHerdrPath, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (args.includes("get")) {
  process.stderr.write(JSON.stringify({ error: { code: "agent_not_found", message: "missing" } }));
  process.exit(1);
}
if (args.includes("workspace") && args.includes("create")) {
  process.stdout.write(JSON.stringify({ result: { workspace_id: "w1", pane_id: "w1:p1" } }));
  process.exit(0);
}
if (args.includes("agent") && args.includes("start")) {
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(args));
  process.stdout.write(JSON.stringify({ result: { agent: { agent_status: "idle" } } }));
  process.exit(0);
}
process.stderr.write(JSON.stringify({ error: { code: "unexpected", message: args.join(" ") } }));
process.exit(1);
`, { mode: 0o700 });
    const config = { ...baseConfig, herdrPath: fakeHerdrPath };
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-scratch-herdr-argv")).row;
    const job = database.createJob(
      { source_event_id: source.event_id, objective: "調査する", workspace: { kind: "scratch" } },
      config.jobsWorkspaceRoot,
      config.jobResultsDir,
    ).row;

    const prepared = await new HerdrJobAgentRuntime(config).prepare(job);
    assert.deepEqual(prepared, { herdrWorkspaceId: "w1", herdrPaneId: "w1:p1" });
    const captured = JSON.parse(await fs.readFile(capturePath, "utf8")) as string[];
    assert.deepEqual(captured, [
      "--session", config.herdrSession,
      "agent", "start", job.agent_name,
      "--kind", "codex",
      "--pane", "w1:p1",
      "--timeout", String(config.jobAgentStartTimeoutMs),
      "--",
      "--add-dir", config.jobResultsDir,
      "-c", `projects = { ${JSON.stringify(job.workspace_path)} = { trust_level = "trusted" } }`,
    ]);
    assert.equal((await fs.stat(job.workspace_path)).mode & 0o777, 0o700);
    database.close();
  });
});
