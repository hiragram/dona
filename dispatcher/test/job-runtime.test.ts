import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { promisify } from "node:util";

import { DispatcherDatabase } from "../src/database.js";
import { buildJobPrompt } from "../src/job-prompt.js";
import { codexAgentArguments, HerdrJobAgentRuntime } from "../src/job-runtime.js";
import { eventEnvelope, tempConfig } from "./helpers.js";

const roots: string[] = [];
const exec = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Codex background agent arguments", () => {
  test("promptだけに専用status timeoutを渡し汎用command timeoutを維持する", async () => {
    const { root, config: baseConfig } = await tempConfig(); roots.push(root);
    const capturePath = path.join(root, "prompt-argv.json");
    const fakeHerdrPath = path.join(root, "fake-prompt-herdr.mjs");
    await fs.writeFile(fakeHerdrPath, `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ result: { agent_status: "working" } }));
`, { mode: 0o700 });
    const config = {
      ...baseConfig,
      herdrPath: fakeHerdrPath,
      jobCommandTimeoutMs: 77,
      jobPromptTimeoutMs: 30_000,
    };
    const result = await new HerdrJobAgentRuntime(config).prompt("agent-1", "依頼", undefined, config.jobPromptTimeoutMs);
    assert.equal(result.ok, true);
    const args = JSON.parse(await fs.readFile(capturePath, "utf8")) as string[];
    assert.deepEqual(args.slice(-2), ["--timeout", "30000"]);
    assert.equal(args.includes("77"), false);
  });

  test("omits the progress directory and prompt contract when progress is disabled", async () => {
    const { root, config } = await tempConfig(); roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-runtime-no-progress")).row;
    const job = database.createJob({ source_event_id:source.event_id, objective:"調査する", workspace:{ kind:"scratch" } }, config.jobsWorkspaceRoot, config.jobResultsDir).row;
    const args = codexAgentArguments(job, config, false);
    assert.equal(args.includes(path.dirname(job.workspace_path)), false);
    const prompt = buildJobPrompt(job, false);
    assert.equal(prompt.includes("progress_path"), false);
    assert.equal(prompt.includes("工程が変わるたび"), false);
    database.close();
  });

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
      "--add-dir",
      path.join(path.dirname(job.workspace_path), ".dona-progress", path.basename(job.workspace_path)),
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
    assert.deepEqual(args, ["--add-dir", config.jobResultsDir, "--add-dir", path.join(path.dirname(job.workspace_path), ".dona-progress", path.basename(job.workspace_path)), "-c", expectedOverride]);
    assert.equal(args[5]!.match(/trust_level/g)?.length, 1);
    assert.equal(args[5]!.includes(`${JSON.stringify(config.jobsWorkspaceRoot)} =`), false);
    assert.equal(args[5]!.includes(`${JSON.stringify(config.jobResultsDir)} =`), false);
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
      "--add-dir",
      path.join(path.dirname(job.workspace_path), ".dona-progress", path.basename(job.workspace_path)),
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
      "--add-dir", path.join(path.dirname(job.workspace_path), ".dona-progress", path.basename(job.workspace_path)),
      "-c", `projects = { ${JSON.stringify(job.workspace_path)} = { trust_level = "trusted" } }`,
    ]);
    assert.equal((await fs.stat(job.workspace_path)).mode & 0o777, 0o700);
    database.close();
  });

  test("passes the rollback-compatible display name through the Herdr workspace and agent-start boundary", async () => {
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
    assert.equal(job.agent_name, job.job_id);
    assert.match(job.agent_name, /enhc$/);
    database.close();
  });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

async function githubFixture(options: { mismatchedWorktreeHead?: boolean } = {}): Promise<{
  root: string;
  config: Awaited<ReturnType<typeof tempConfig>>["config"];
  database: DispatcherDatabase;
  featureSha: string;
  raceSha: string;
  logPath: string;
  seedPath: string;
}> {
  const { root, config } = await tempConfig(); roots.push(root);
  const bare = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const repositoryPath = path.join(config.jobsWorkspaceRoot, "github", "owner", "repo", "repository");
  await exec("git", ["init", "--bare", bare]);
  await exec("git", ["init", "-b", "main", seed]);
  await git(seed, "config", "user.email", "test@example.com");
  await git(seed, "config", "user.name", "Test");
  await fs.writeFile(path.join(seed, "state.txt"), "A\n");
  await git(seed, "add", "state.txt");
  await git(seed, "commit", "-m", "A");
  await git(seed, "branch", "feature/test");
  await git(seed, "remote", "add", "origin", bare);
  await git(seed, "push", "origin", "main", "feature/test");
  await fs.mkdir(path.dirname(repositoryPath), { recursive: true });
  await exec("git", ["clone", bare, repositoryPath]);
  await git(repositoryPath, "remote", "set-url", "origin", "https://github.com/owner/repo.git");
  await git(repositoryPath, "branch", "feature/test", "origin/feature/test");

  await git(seed, "checkout", "feature/test");
  await fs.writeFile(path.join(seed, "state.txt"), "B\n");
  await git(seed, "commit", "-am", "B");
  const featureSha = await git(seed, "rev-parse", "HEAD");
  await git(seed, "push", "origin", "feature/test");
  await fs.writeFile(path.join(seed, "state.txt"), "C\n");
  await git(seed, "commit", "-am", "C");
  const raceSha = await git(seed, "rev-parse", "HEAD");
  await git(seed, "push", "origin", "HEAD:refs/heads/race-source");

  const logPath = path.join(root, "herdr-calls.jsonl");
  const fakeHerdr = path.join(root, "fake-herdr.mjs");
  await fs.writeFile(fakeHerdr, `#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[2] === "agent" && args[3] === "get") process.exit(1);
if (args[2] === "worktree" && args[3] === "create") {
  const value = (name) => args[args.indexOf(name) + 1];
  spawnSync("git", ["--git-dir", ${JSON.stringify(bare)}, "update-ref", "refs/heads/feature/test", ${JSON.stringify(raceSha)}]);
  const base = ${JSON.stringify(options.mismatchedWorktreeHead ?? false)} ? value("--base") + "~1" : value("--base");
  const result = spawnSync("git", ["-C", value("--cwd"), "worktree", "add", "-b", value("--branch"), value("--path"), base], { encoding: "utf8" });
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status ?? 2); }
  process.stdout.write(JSON.stringify({ result: { workspace_id: "w1", pane_id: "w1:p1" } }));
  process.exit(0);
}
if (args[2] === "workspace" && args[3] === "create") {
  process.stdout.write(JSON.stringify({ result: { workspace_id: "w1", pane_id: "w1:p1" } }));
  process.exit(0);
}
if (args[2] === "agent" && args[3] === "start") {
  process.stdout.write(JSON.stringify({ result: { agent: { agent_status: "idle" } } }));
  process.exit(0);
}
process.exit(2);
`, { mode: 0o700 });
  const fakeGh = path.join(root, "fake-gh.mjs");
  await fs.writeFile(fakeGh, "#!/usr/bin/env node\nprocess.stdout.write('main\\n');\n", { mode: 0o700 });
  const fakeGit = path.join(root, "fake-git.mjs");
  await fs.writeFile(fakeGit, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.includes("remote") && args.includes("get-url")) {
  process.stdout.write("https://github.com/owner/repo.git\\n");
  process.exit(0);
}
const fetchIndex = args.indexOf("fetch");
const remoteIndex = args.findIndex((arg, index) => index > 1 && arg === "origin");
if (remoteIndex >= 0) args[remoteIndex] = ${JSON.stringify(bare)};
const result = spawnSync("git", args, { stdio: "inherit" });
process.exit(result.status ?? 2);
`, { mode: 0o700 });
  config.herdrPath = fakeHerdr;
  config.ghPath = fakeGh;
  config.gitPath = fakeGit;
  config.jobCommandTimeoutMs = 5_000;
  config.jobAgentStartTimeoutMs = 5_000;
  const database = new DispatcherDatabase(config.databasePath);
  return { root, config, database, featureSha, raceSha, logPath, seedPath: seed };
}

describe("GitHub workspace provisioning", () => {
  test("stale local refを使わずfetch済みremote SHAを固定し、HEAD検証後にagentを起動する", async () => {
    const fixture = await githubFixture();
    const source = fixture.database.enqueue(eventEnvelope("Ev-github-remote-base")).row;
    const job = fixture.database.createJob({
      source_event_id: source.event_id,
      objective: "確認する",
      workspace: { kind: "github", repository: "owner/repo", base_ref: "feature/test" },
    }, fixture.config.jobsWorkspaceRoot, fixture.config.jobResultsDir).row;

    await new HerdrJobAgentRuntime(fixture.config).prepare(job);

    assert.equal(await git(job.workspace_path, "rev-parse", "HEAD"), fixture.featureSha);
    const calls = (await fs.readFile(fixture.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const createIndex = calls.findIndex((args) => args[2] === "worktree" && args[3] === "create");
    const startIndex = calls.findIndex((args) => args[2] === "agent" && args[3] === "start");
    assert.ok(createIndex >= 0 && startIndex > createIndex, JSON.stringify(calls));
    const create = calls[createIndex]!;
    assert.equal(create[create.indexOf("--base") + 1], fixture.featureSha);
    assert.equal(await git(fixture.root, "--git-dir", path.join(fixture.root, "origin.git"), "rev-parse", "refs/heads/feature/test"), fixture.raceSha);
    assert.ok(calls.slice(0, startIndex).some((args) => args[2] === "worktree" && args[3] === "create"));
    fixture.database.close();
  });

  test("missing remote refではworktreeとagentを作成しない", async () => {
    const fixture = await githubFixture();
    const source = fixture.database.enqueue(eventEnvelope("Ev-github-missing-base")).row;
    const job = fixture.database.createJob({
      source_event_id: source.event_id,
      objective: "確認する",
      workspace: { kind: "github", repository: "owner/repo", base_ref: "missing" },
    }, fixture.config.jobsWorkspaceRoot, fixture.config.jobResultsDir).row;
    await assert.rejects(new HerdrJobAgentRuntime(fixture.config).prepare(job), /Git remote base ref missing was not found/);
    const calls = (await fs.readFile(fixture.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.some((args) => args[2] === "worktree" || (args[2] === "agent" && args[3] === "start")), false);
    fixture.database.close();
  });

  test("default branchも最新remote SHAから開始する", async () => {
    const fixture = await githubFixture();
    await git(fixture.seedPath, "checkout", "main");
    await fs.writeFile(path.join(fixture.seedPath, "default.txt"), "remote\n");
    await git(fixture.seedPath, "add", "default.txt");
    await git(fixture.seedPath, "commit", "-m", "advance main");
    const remoteMainSha = await git(fixture.seedPath, "rev-parse", "HEAD");
    await git(fixture.seedPath, "push", "origin", "main");
    await git(fixture.seedPath, "tag", "main", fixture.featureSha);
    await git(fixture.seedPath, "push", "origin", "refs/tags/main");
    const source = fixture.database.enqueue(eventEnvelope("Ev-github-default-base")).row;
    const job = fixture.database.createJob({
      source_event_id: source.event_id,
      objective: "確認する",
      workspace: { kind: "github", repository: "owner/repo" },
    }, fixture.config.jobsWorkspaceRoot, fixture.config.jobResultsDir).row;
    await new HerdrJobAgentRuntime(fixture.config).prepare(job);
    assert.equal(await git(job.workspace_path, "rev-parse", "HEAD"), remoteMainSha);
    fixture.database.close();
  });

  test("origin branch、remote tag、raw commit SHAの既存base_ref形式を維持する", async () => {
    const fixture = await githubFixture();
    const repositoryPath = path.join(fixture.config.jobsWorkspaceRoot, "github", "owner", "repo", "repository");
    await git(fixture.seedPath, "checkout", "main");
    const nonTipSha = await git(fixture.seedPath, "rev-parse", "HEAD");
    await fs.writeFile(path.join(fixture.seedPath, "main-next.txt"), "next\n");
    await git(fixture.seedPath, "add", "main-next.txt");
    await git(fixture.seedPath, "commit", "-m", "advance main for compatibility refs");
    await git(fixture.seedPath, "push", "origin", "main");
    await git(fixture.seedPath, "tag", "release-test", fixture.featureSha);
    await git(fixture.seedPath, "push", "origin", "refs/tags/release-test");
    await git(fixture.seedPath, "tag", "-a", "annotated-test", "-m", "annotated", fixture.featureSha);
    await git(fixture.seedPath, "push", "origin", "refs/tags/annotated-test");
    const annotatedTagSha = await git(fixture.seedPath, "rev-parse", "refs/tags/annotated-test");
    await git(fixture.seedPath, "push", "origin", `feature/test:refs/heads/stable`);
    await git(repositoryPath, "fetch", path.join(fixture.root, "origin.git"), `stable:refs/remotes/origin/stable`);
    await git(repositoryPath, "config", "branch.main.remote", "origin");
    await git(repositoryPath, "config", "branch.main.merge", "refs/heads/stable");
    await git(repositoryPath, "config", "push.default", "upstream");
    const shortCommit = nonTipSha.slice(0, 12);
    await git(repositoryPath, "fetch", path.join(fixture.root, "origin.git"), `feature/test:refs/heads/local-collision-source`);
    await git(repositoryPath, "branch", shortCommit, fixture.featureSha);
    const hexBranch = "a".repeat(40);
    await git(fixture.seedPath, "push", "origin", `main:refs/heads/${hexBranch}`);
    const cases = [
      { event: "Ev-github-origin-prefix", baseRef: "origin/main", expected: await git(fixture.seedPath, "rev-parse", "main") },
      { event: "Ev-github-origin-default", baseRef: "origin", expected: await git(fixture.seedPath, "rev-parse", "main") },
      { event: "Ev-github-heads-prefix", baseRef: "heads/main", expected: await git(fixture.seedPath, "rev-parse", "main") },
      { event: "Ev-github-remotes-origin-prefix", baseRef: "remotes/origin/main", expected: await git(fixture.seedPath, "rev-parse", "main") },
      { event: "Ev-github-head", baseRef: "HEAD", expected: await git(fixture.seedPath, "rev-parse", "main") },
      { event: "Ev-github-at-head", baseRef: "@", expected: await git(fixture.seedPath, "rev-parse", "main") },
      { event: "Ev-github-upstream-head", baseRef: "@{upstream}", expected: fixture.raceSha },
      { event: "Ev-github-main-upstream", baseRef: "main@{upstream}", expected: fixture.raceSha },
      { event: "Ev-github-push-head", baseRef: "@{push}", expected: fixture.raceSha },
      { event: "Ev-github-main-push", baseRef: "main@{push}", expected: fixture.raceSha },
      { event: "Ev-github-origin-head", baseRef: "origin/HEAD", expected: await git(fixture.seedPath, "rev-parse", "main") },
      { event: "Ev-github-remotes-origin-head", baseRef: "remotes/origin/HEAD", expected: await git(fixture.seedPath, "rev-parse", "main") },
      { event: "Ev-github-tag", baseRef: "release-test", expected: fixture.featureSha },
      { event: "Ev-github-tags-prefix", baseRef: "tags/release-test", expected: fixture.featureSha },
      { event: "Ev-github-commit", baseRef: fixture.featureSha, expected: fixture.featureSha },
      { event: "Ev-github-short-commit", baseRef: shortCommit, expected: nonTipSha },
      { event: "Ev-github-annotated-tag-object", baseRef: annotatedTagSha, expected: fixture.featureSha },
      { event: "Ev-github-hex-branch", baseRef: hexBranch, expected: await git(fixture.seedPath, "rev-parse", "main") },
    ];
    for (const item of cases) {
      const source = fixture.database.enqueue(eventEnvelope(item.event)).row;
      const job = fixture.database.createJob({
        source_event_id: source.event_id,
        objective: "確認する",
        workspace: { kind: "github", repository: "owner/repo", base_ref: item.baseRef },
      }, fixture.config.jobsWorkspaceRoot, fixture.config.jobResultsDir).row;
      await new HerdrJobAgentRuntime(fixture.config).prepare(job);
      assert.equal(await git(job.workspace_path, "rev-parse", "HEAD"), item.expected, item.event);
    }
    assert.equal(await git(repositoryPath, "for-each-ref", "--format=%(refname)", "refs/dona/objects"), "");
    fixture.database.close();
  });

  test("fetch failureではref解決・worktree作成・agent起動へ進まない", async () => {
    const fixture = await githubFixture();
    const failingGit = path.join(fixture.root, "fetch-failure-git.mjs");
    await fs.writeFile(failingGit, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.includes("remote") && args.includes("get-url")) { process.stdout.write("https://github.com/owner/repo.git\\n"); process.exit(0); }
if (args.includes("fetch")) { process.stderr.write("injected fetch failure\\n"); process.exit(1); }
const remoteIndex = args.findIndex((arg, index) => index > 1 && arg === "origin");
if (remoteIndex >= 0) args[remoteIndex] = ${JSON.stringify(path.join(fixture.root, "origin.git"))};
const result = spawnSync("git", args, { stdio: "inherit" });
process.exit(result.status ?? 2);
`, { mode: 0o700 });
    fixture.config.gitPath = failingGit;
    const source = fixture.database.enqueue(eventEnvelope("Ev-github-fetch-failure")).row;
    const job = fixture.database.createJob({
      source_event_id: source.event_id,
      objective: "確認する",
      workspace: { kind: "github", repository: "owner/repo", base_ref: "feature/test" },
    }, fixture.config.jobsWorkspaceRoot, fixture.config.jobResultsDir).row;
    await assert.rejects(new HerdrJobAgentRuntime(fixture.config).prepare(job), /Git fetch failed/);
    const calls = (await fs.readFile(fixture.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.some((args) => args[2] === "worktree" || (args[2] === "agent" && args[3] === "start")), false);
    fixture.database.close();
  });

  test("raw commit解決失敗でも一時remote refを残さない", async () => {
    const fixture = await githubFixture();
    const source = fixture.database.enqueue(eventEnvelope("Ev-github-missing-commit")).row;
    const job = fixture.database.createJob({
      source_event_id: source.event_id,
      objective: "確認する",
      workspace: { kind: "github", repository: "owner/repo", base_ref: "deadbeef" },
    }, fixture.config.jobsWorkspaceRoot, fixture.config.jobResultsDir).row;
    await assert.rejects(new HerdrJobAgentRuntime(fixture.config).prepare(job), /was not uniquely resolved/);
    const repositoryPath = path.join(fixture.config.jobsWorkspaceRoot, "github", "owner", "repo", "repository");
    assert.equal(await git(repositoryPath, "for-each-ref", "--format=%(refname)", "refs/dona/objects"), "");
    const calls = (await fs.readFile(fixture.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.some((args) => args[2] === "worktree" || (args[2] === "agent" && args[3] === "start")), false);
    fixture.database.close();
  });

  test("既存worktreeのHEAD mismatchでは既存agentを再利用しない", async () => {
    const fixture = await githubFixture();
    const source = fixture.database.enqueue(eventEnvelope("Ev-github-head-mismatch")).row;
    const job = fixture.database.createJob({
      source_event_id: source.event_id,
      objective: "確認する",
      workspace: { kind: "github", repository: "owner/repo", base_ref: "feature/test" },
    }, fixture.config.jobsWorkspaceRoot, fixture.config.jobResultsDir).row;
    const runtime = new HerdrJobAgentRuntime(fixture.config);
    await runtime.prepare(job);
    await git(job.workspace_path, "checkout", "--detach", "HEAD~1");
    await fs.writeFile(fixture.config.herdrPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[2] === "agent" && args[3] === "get") {
  process.stdout.write(JSON.stringify({ result: { workspace_id: "w1", pane_id: "w1:p1" } }));
  process.exit(0);
}
process.exit(2);
`, { mode: 0o700 });
    await assert.rejects(runtime.prepare(job), /Git worktree HEAD mismatch/);
    fixture.database.close();
  });

  test("remote更新後の再試行は作成済みjob branchとworktreeを再利用する", async () => {
    const fixture = await githubFixture();
    const source = fixture.database.enqueue(eventEnvelope("Ev-github-existing-worktree-retry")).row;
    const job = fixture.database.createJob({
      source_event_id: source.event_id,
      objective: "確認する",
      workspace: { kind: "github", repository: "owner/repo", base_ref: "feature/test" },
    }, fixture.config.jobsWorkspaceRoot, fixture.config.jobResultsDir).row;
    const runtime = new HerdrJobAgentRuntime(fixture.config);
    await runtime.prepare(job);
    const repositoryPath = path.join(fixture.config.jobsWorkspaceRoot, "github", "owner", "repo", "repository");
    await git(repositoryPath, "update-ref", "-d", `refs/dona/bases/${job.job_id}`);
    await runtime.prepare(job);
    assert.equal(await git(job.workspace_path, "rev-parse", "HEAD"), fixture.featureSha);
    assert.equal(await git(repositoryPath, "rev-parse", `refs/dona/bases/${job.job_id}`), fixture.featureSha);
    const calls = (await fs.readFile(fixture.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.filter((args) => args[2] === "worktree" && args[3] === "create").length, 1);
    assert.equal(calls.filter((args) => args[2] === "workspace" && args[3] === "create").length, 1);
    fixture.database.close();
  });

  test("worktree作成後のHEAD mismatchではagentを起動しない", async () => {
    const fixture = await githubFixture({ mismatchedWorktreeHead: true });
    const source = fixture.database.enqueue(eventEnvelope("Ev-github-created-head-mismatch")).row;
    const job = fixture.database.createJob({
      source_event_id: source.event_id,
      objective: "確認する",
      workspace: { kind: "github", repository: "owner/repo", base_ref: "feature/test" },
    }, fixture.config.jobsWorkspaceRoot, fixture.config.jobResultsDir).row;
    await assert.rejects(new HerdrJobAgentRuntime(fixture.config).prepare(job), /Git worktree HEAD mismatch/);
    await assert.rejects(new HerdrJobAgentRuntime(fixture.config).prepare(job), /Git worktree HEAD mismatch/);
    const calls = (await fs.readFile(fixture.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.some((args) => args[2] === "agent" && args[3] === "start"), false);
    fixture.database.close();
  });
});
