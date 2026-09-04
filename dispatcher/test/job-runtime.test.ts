import assert from "node:assert/strict";
import fs from "node:fs/promises";
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

  test("does not add project trust overrides to scratch jobs", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-scratch-runtime-args")).row;
    const job = database.createJob(
      { source_event_id: source.event_id, objective: "調査する", workspace: { kind: "scratch" } },
      config.jobsWorkspaceRoot,
      config.jobResultsDir,
    ).row;
    assert.deepEqual(codexAgentArguments(job, config), ["--add-dir", config.jobResultsDir]);
    database.close();
  });

  test("passes the persisted display name through the Herdr workspace and agent-start boundary", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const logPath = `${root}/herdr-argv.jsonl`;
    const executable = `${root}/fake-herdr.mjs`;
    await fs.writeFile(executable, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[2] === "agent" && args[3] === "get") {
  console.error(JSON.stringify({ status: "error", error: { code: "agent_not_found" } }));
  process.exit(1);
}
if (args[2] === "workspace" && args[3] === "create") {
  console.log(JSON.stringify({ status: "ok", result: { workspace: { workspace_id: "w1" }, root_pane: { pane_id: "w1:p1" } } }));
  process.exit(0);
}
if (args[2] === "agent" && args[3] === "start") {
  console.log(JSON.stringify({ status: "ok", result: { agent: { agent_status: "idle" } } }));
  process.exit(0);
}
process.exit(2);
`);
    await fs.chmod(executable, 0o700);
    config.herdrPath = executable;
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-herdr-display-boundary")).row;
    const job = database.createJob(
      { source_event_id: source.event_id, objective: "一覧を改善する", workspace: { kind: "scratch" } },
      config.jobsWorkspaceRoot,
      config.jobResultsDir,
    ).row;

    const prepared = await new HerdrJobAgentRuntime(config).prepare(job);
    const calls = (await fs.readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const workspace = calls.find((args) => args[2] === "workspace" && args[3] === "create");
    const start = calls.find((args) => args[2] === "agent" && args[3] === "start");

    assert.deepEqual(prepared, { herdrWorkspaceId: "w1", herdrPaneId: "w1:p1" });
    assert.ok(workspace, JSON.stringify(calls));
    assert.ok(start, JSON.stringify(calls));
    assert.equal(workspace[workspace.indexOf("--label") + 1], job.agent_name);
    assert.equal(start[4], job.agent_name);
    assert.notEqual(job.agent_name, job.job_id);
    database.close();
  });
});
