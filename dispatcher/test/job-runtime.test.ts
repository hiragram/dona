import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterEach, describe, test } from "node:test";

import { DispatcherDatabase } from "../src/database.js";
import { codexAgentArguments } from "../src/job-runtime.js";
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
});
