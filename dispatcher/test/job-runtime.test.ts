import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { promisify } from "node:util";

import { DispatcherDatabase } from "../src/database.js";
import { buildJobPrompt } from "../src/job-prompt.js";
import { codexAgentArguments, HerdrJobAgentRuntime, parseScheduledMcpInventory, PreparedWorkspaceCleanupError } from "../src/job-runtime.js";
import { scheduledPermissionArguments } from "../src/scheduled-sandbox.js";
import { eventEnvelope, tempConfig } from "./helpers.js";

const roots: string[] = [];
const exec = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Codex background agent arguments", () => {
  test("rejects missing or malformed scheduled MCP identities", () => {
    assert.deepEqual(parseScheduledMcpInventory([{name:"slack"},{name:"github_1"}]),["slack","github_1"]);
    for(const inventory of [[{}],[{name:undefined}],[{name:""}],[{name:"bad.name"}],null])
      assert.throws(()=>parseScheduledMcpInventory(inventory),/MCP (?:inventory|identity) was invalid/);
  });

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
    const args = codexAgentArguments(job, config, [], false);
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
      path.dirname(job.result_path),
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
    assert.deepEqual(args, ["--add-dir", path.dirname(job.result_path), "--add-dir", path.join(path.dirname(job.workspace_path), ".dona-progress", path.basename(job.workspace_path)), "-c", expectedOverride]);
    assert.equal(args[5]!.match(/trust_level/g)?.length, 1);
    assert.equal(args[5]!.includes(`${JSON.stringify(config.jobsWorkspaceRoot)} =`), false);
    assert.equal(args[5]!.includes(`${JSON.stringify(config.jobResultsDir)} =`), false);
    assert.doesNotMatch(buildJobPrompt({...job,source:"dona_schedule"}), /progress_path|工程が変わるたび/);
    const scheduledOverride=`projects = { ${JSON.stringify(job.workspace_path)} = { trust_level = "trusted" }, ${JSON.stringify(path.dirname(job.result_path))} = { trust_level = "trusted" } }`;
    assert.deepEqual(codexAgentArguments({...job,source:"dona_schedule"},config,[],true,["/usr/bin/codex"]),[
      "--strict-config","-C",path.dirname(job.result_path),...scheduledPermissionArguments(path.dirname(job.result_path),["/usr/bin/codex"],job.workspace_path),"--ask-for-approval","never","--disable","plugins","--disable","apps","--disable","remote_plugin","--disable","in_app_browser","-c",scheduledOverride,
    ]);
    assert.deepEqual(codexAgentArguments({...job,source:"dona_schedule"},config,["slack","github"],true,["/usr/bin/codex"]),[
      "--strict-config","-C",path.dirname(job.result_path),...scheduledPermissionArguments(path.dirname(job.result_path),["/usr/bin/codex"],job.workspace_path),"--ask-for-approval","never","--disable","plugins","--disable","apps","--disable","remote_plugin","--disable","in_app_browser",
      "-c","mcp_servers.slack.enabled=false","-c","mcp_servers.github.enabled=false","-c",scheduledOverride,
    ]);
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
      path.dirname(job.result_path),
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
if (args.includes("pane") && args.includes("run")) {
  process.stdout.write(JSON.stringify({ result: { ok: true } }));
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
      "--add-dir", path.dirname(job.result_path),
      "--add-dir", path.join(path.dirname(job.workspace_path), ".dona-progress", path.basename(job.workspace_path)),
      "-c", `projects = { ${JSON.stringify(job.workspace_path)} = { trust_level = "trusted" } }`,
    ]);
    assert.equal((await fs.stat(job.workspace_path)).mode & 0o777, 0o700);
    database.close();
  });

  test("表示ラベルをscratch workspaceだけへ単一argvで渡しagent identityを維持する", async () => {
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
      { source_event_id: source.event_id, objective: "一覧を改善する", workspace: { kind: "scratch" }, display: { short_name: '一覧 "改善" $(safe)' } },
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
    assert.equal(workspace[workspace.indexOf("--label") + 1], '一覧 "改善" $(safe)');
    assert.equal(workspace.filter((value) => value === '一覧 "改善" $(safe)').length, 1);
    assert.equal(start[4], job.agent_name);
    assert.equal(job.agent_name, job.job_id);
    assert.match(job.agent_name, /enhc$/);
    database.close();
  });

  test("terminal scheduled scratch workspaceをHerdr close後に削除する", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const capturePath=path.join(root,"cleanup-argv.json");
    const executable=path.join(root,"fake-herdr-cleanup.mjs");
    await fs.writeFile(executable,`#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(capturePath)},JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({status:"ok"}));
`,{mode:0o700});
    const database=new DispatcherDatabase(config.databasePath);
    const source=database.enqueue(eventEnvelope("Ev-scheduled-cleanup")).row;
    const job=database.createJob({source_event_id:source.event_id,objective:"調査",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
    await fs.mkdir(job.workspace_path,{recursive:true});
    await fs.writeFile(path.join(job.workspace_path,"artifact"),"temporary");
    const runtime=new HerdrJobAgentRuntime({...config,herdrPath:executable});
    const cleaned=await runtime.cleanup!({...job,source:"dona_schedule",herdr_workspace_id:"w7"});
    assert.equal(cleaned.ok,true,JSON.stringify(cleaned));
    assert.deepEqual(JSON.parse(await fs.readFile(capturePath,"utf8")),["--session",config.herdrSession,"workspace","close","w7"]);
    await assert.rejects(fs.access(job.workspace_path),{code:"ENOENT"});
    database.close();
  });

  test("agent start失敗後のworkspace close失敗はIDとscratch workspaceを保持する", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const executable=path.join(root,"fake-herdr-start-cleanup-failure.mjs");
    await fs.writeFile(executable,`#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[2]==="agent"&&args[3]==="get")process.exit(1);
if(args[2]==="workspace"&&args[3]==="create"){
  console.log(JSON.stringify({status:"ok",result:{workspace:{workspace_id:"w9"},root_pane:{pane_id:"w9:p1"}}}));
  process.exit(0);
}
if(args[2]==="agent"&&args[3]==="start")process.exit(1);
if(args[2]==="workspace"&&args[3]==="close")process.exit(1);
process.exit(2);
`,{mode:0o700});
    const database=new DispatcherDatabase(config.databasePath);
    const source=database.enqueue(eventEnvelope("Ev-start-cleanup-failure")).row;
    const job=database.createJob({source_event_id:source.event_id,objective:"調査",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
    await assert.rejects(
      new HerdrJobAgentRuntime({...config,herdrPath:executable}).prepare(job),
      (error:unknown)=>error instanceof PreparedWorkspaceCleanupError&&error.herdrWorkspaceId==="w9"&&error.herdrPaneId==="w9:p1",
    );
    assert.equal((await fs.stat(job.workspace_path)).isDirectory(),true);
    database.close();
  });

  test("legacy agent closeをagent identityへ固定する",async()=>{
    const {root,config}=await tempConfig(); roots.push(root);
    const capturePath=path.join(root,"agent-close-argv.json"),executable=path.join(root,"fake-herdr-agent-close.mjs");
    await fs.writeFile(executable,`#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(capturePath)},JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({status:"ok"}));
`,{mode:0o700});
    const result=await new HerdrJobAgentRuntime({...config,herdrPath:executable}).closeAgent("job_01m1legacyagent000000enhc");
    assert.equal(result.ok,true);
    assert.deepEqual(JSON.parse(await fs.readFile(capturePath,"utf8")),["--session",config.herdrSession,"agent","close","job_01m1legacyagent000000enhc"]);
  });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

let githubTemplateRoot: string | undefined;
let githubTemplateBare: string | undefined;
let githubTemplateSeed: string | undefined;
let githubTemplateRepository: string | undefined;

before(async () => {
  githubTemplateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dona-github-fixture-template-"));
  githubTemplateBare = path.join(githubTemplateRoot, "origin.git");
  const seed = path.join(githubTemplateRoot, "seed");
  const repository = path.join(githubTemplateRoot, "repository");
  await exec("git", ["init", "--bare", githubTemplateBare]);
  await exec("git", ["init", "-b", "main", seed]);
  await git(seed, "config", "user.email", "test@example.com");
  await git(seed, "config", "user.name", "Test");
  await fs.writeFile(path.join(seed, "state.txt"), "A\n");
  await git(seed, "add", "state.txt");
  await git(seed, "commit", "-m", "A");
  await git(seed, "branch", "feature/test");
  await git(seed, "remote", "add", "origin", githubTemplateBare);
  await git(seed, "push", "origin", "main", "feature/test");
  await git(githubTemplateRoot, "--git-dir", githubTemplateBare, "symbolic-ref", "HEAD", "refs/heads/main");
  await git(seed, "checkout", "feature/test");
  await fs.writeFile(path.join(seed, "state.txt"), "B\n");
  await git(seed, "commit", "-am", "B");
  await git(seed, "push", "origin", "feature/test");
  await fs.writeFile(path.join(seed, "state.txt"), "C\n");
  await git(seed, "commit", "-am", "C");
  await git(seed, "push", "origin", "HEAD:refs/heads/race-source");
  await exec("git", ["clone", "--shared", githubTemplateBare, repository]);
  await git(repository, "remote", "set-url", "origin", "https://github.com/owner/repo.git");
  await git(repository, "branch", "feature/test", "origin/feature/test");
  githubTemplateSeed = seed;
  githubTemplateRepository = repository;
});

after(async () => {
  if (githubTemplateRoot) await fs.rm(githubTemplateRoot, { recursive: true, force: true });
});

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
  assert.ok(githubTemplateBare && githubTemplateSeed && githubTemplateRepository, "GitHub fixture template must be initialized");
  const bare = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const repositoryPath = path.join(config.jobsWorkspaceRoot, "github", "owner", "repo", "repository");
  // Copy the immutable template state in-process. Each case still owns its
  // refs, configs, worktrees, database, and logs, but does not pay for three
  // Git process trees before the behavior under test starts.
  await fs.cp(githubTemplateBare, bare, { recursive: true });
  await fs.cp(githubTemplateSeed, seed, { recursive: true });
  await fs.mkdir(path.dirname(repositoryPath), { recursive: true });
  await fs.cp(githubTemplateRepository, repositoryPath, { recursive: true });
  const seedConfigPath = path.join(seed, ".git", "config");
  const seedConfig = await fs.readFile(seedConfigPath, "utf8");
  assert.match(seedConfig, new RegExp(githubTemplateBare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await fs.writeFile(seedConfigPath, seedConfig.replaceAll(githubTemplateBare, bare));
  const featureSha = await git(seed, "rev-parse", "refs/remotes/origin/feature/test");
  const raceSha = await git(seed, "rev-parse", "refs/remotes/origin/race-source");


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
  const fakeGit = path.join(root, "fake-git");
  await fs.writeFile(fakeGit, `#!/bin/bash
args=("$@")
for ((index = 0; index < \${#args[@]}; index++)); do
  if [[ "\${args[index]}" == "remote" && "\${args[index + 1]:-}" == "get-url" ]]; then
    printf '%s\\n' 'https://github.com/owner/repo.git'
    exit 0
  fi
  if ((index > 1)) && [[ "\${args[index]}" == "origin" ]]; then
    args[index]=${JSON.stringify(bare)}
  fi
done
exec /usr/bin/git "\${args[@]}"
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
      display: { short_name: "表示ラベル", issue: { repository: "owner/repo", number: 87 } },
    }, fixture.config.jobsWorkspaceRoot, fixture.config.jobResultsDir).row;
    const repositoryPath = path.join(fixture.config.jobsWorkspaceRoot, "github", "owner", "repo", "repository");
    await git(fixture.seedPath, "push", "origin", "main:refs/heads/foo");
    await git(repositoryPath, "update-ref", "refs/remotes/origin/foo/bar", await git(repositoryPath, "rev-parse", "refs/remotes/origin/main"));

    await new HerdrJobAgentRuntime(fixture.config).prepare(job);

    assert.equal(await git(job.workspace_path, "rev-parse", "HEAD"), fixture.featureSha);
    const calls = (await fs.readFile(fixture.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const createIndex = calls.findIndex((args) => args[2] === "worktree" && args[3] === "create");
    const startIndex = calls.findIndex((args) => args[2] === "agent" && args[3] === "start");
    assert.ok(createIndex >= 0 && startIndex > createIndex, JSON.stringify(calls));
    const create = calls[createIndex]!;
    assert.equal(create[create.indexOf("--base") + 1], fixture.featureSha);
    assert.equal(create[create.indexOf("--label") + 1], "#87 表示ラベル");
    assert.equal(calls[startIndex]![4], job.agent_name);
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

  test("bare originと同名remote tagの曖昧性を拒否する", async () => {
    const fixture = await githubFixture();
    await git(fixture.seedPath, "tag", "origin", fixture.featureSha);
    await git(fixture.seedPath, "push", "origin", "refs/tags/origin");
    const source = fixture.database.enqueue(eventEnvelope("Ev-github-ambiguous-origin")).row;
    const job = fixture.database.createJob({
      source_event_id: source.event_id,
      objective: "確認する",
      workspace: { kind: "github", repository: "owner/repo", base_ref: "origin" },
    }, fixture.config.jobsWorkspaceRoot, fixture.config.jobResultsDir).row;

    await assert.rejects(
      new HerdrJobAgentRuntime(fixture.config).prepare(job),
      /GitHub base ref origin is ambiguous with a remote tag/,
    );
    const calls = (await fs.readFile(fixture.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.some((args) => args[2] === "worktree" || (args[2] === "agent" && args[3] === "start")), false);
    fixture.database.close();
  });

  test("origin HEADと同名remote tagの曖昧性を拒否する", async () => {
    const fixture = await githubFixture();
    await git(fixture.seedPath, "tag", "origin/HEAD", fixture.featureSha);
    await git(fixture.seedPath, "push", "origin", "refs/tags/origin/HEAD");
    const source = fixture.database.enqueue(eventEnvelope("Ev-github-ambiguous-origin-head")).row;
    const job = fixture.database.createJob({
      source_event_id: source.event_id,
      objective: "確認する",
      workspace: { kind: "github", repository: "owner/repo", base_ref: "origin/HEAD" },
    }, fixture.config.jobsWorkspaceRoot, fixture.config.jobResultsDir).row;

    await assert.rejects(
      new HerdrJobAgentRuntime(fixture.config).prepare(job),
      /GitHub base ref origin\/HEAD is ambiguous with a remote tag/,
    );
    fixture.database.close();
  });

  test("origin slash refは同名tagを維持しbranchとの曖昧性を拒否する", async () => {
    const fixture = await githubFixture();
    await git(fixture.seedPath, "tag", "origin/release", fixture.featureSha);
    await git(fixture.seedPath, "push", "origin", "refs/tags/origin/release");
    const tagSource = fixture.database.enqueue(eventEnvelope("Ev-github-origin-tag")).row;
    const tagJob = fixture.database.createJob({
      source_event_id: tagSource.event_id,
      objective: "確認する",
      workspace: { kind: "github", repository: "owner/repo", base_ref: "origin/release" },
    }, fixture.config.jobsWorkspaceRoot, fixture.config.jobResultsDir).row;
    await new HerdrJobAgentRuntime(fixture.config).prepare(tagJob);
    assert.equal(await git(tagJob.workspace_path, "rev-parse", "HEAD"), fixture.featureSha);

    await git(fixture.seedPath, "push", "origin", "main:refs/heads/release");
    const ambiguousSource = fixture.database.enqueue(eventEnvelope("Ev-github-origin-ambiguous")).row;
    const ambiguousJob = fixture.database.createJob({
      source_event_id: ambiguousSource.event_id,
      objective: "確認する",
      workspace: { kind: "github", repository: "owner/repo", base_ref: "origin/release" },
    }, fixture.config.jobsWorkspaceRoot, fixture.config.jobResultsDir).row;
    await assert.rejects(
      new HerdrJobAgentRuntime(fixture.config).prepare(ambiguousJob),
      /Git remote base ref origin\/release is ambiguous/,
    );
    fixture.database.close();
  });

  test("local tracking refがなくてもbranch設定からupstreamをremote解決する", async () => {
    const fixture = await githubFixture();
    const repositoryPath = path.join(fixture.config.jobsWorkspaceRoot, "github", "owner", "repo", "repository");
    await git(fixture.seedPath, "push", "origin", "feature/test:refs/heads/stable");
    await git(repositoryPath, "config", "branch.main.remote", "origin");
    await git(repositoryPath, "config", "branch.main.merge", "refs/heads/stable");
    await git(repositoryPath, "config", "--add", "branch.main.merge", "refs/heads/main");
    await git(repositoryPath, "update-ref", "-d", "refs/remotes/origin/stable");
    const source = fixture.database.enqueue(eventEnvelope("Ev-github-missing-tracking-ref")).row;
    const job = fixture.database.createJob({
      source_event_id: source.event_id,
      objective: "確認する",
      workspace: { kind: "github", repository: "owner/repo", base_ref: "main@{upstream}" },
    }, fixture.config.jobsWorkspaceRoot, fixture.config.jobResultsDir).row;

    await new HerdrJobAgentRuntime(fixture.config).prepare(job);
    assert.equal(await git(job.workspace_path, "rev-parse", "HEAD"), fixture.raceSha);
    fixture.database.close();
  });

  test("local tracking refがなくてもpush設定からremote destinationを解決する", async () => {
    const fixture = await githubFixture();
    const repositoryPath = path.join(fixture.config.jobsWorkspaceRoot, "github", "owner", "repo", "repository");
    await git(fixture.seedPath, "push", "origin", "feature/test:refs/heads/stable");
    await git(repositoryPath, "config", "branch.main.remote", "origin");
    await git(repositoryPath, "config", "branch.main.merge", "refs/heads/stable");
    await git(repositoryPath, "config", "push.default", "upstream");
    await git(repositoryPath, "update-ref", "-d", "refs/remotes/origin/stable");
    const source = fixture.database.enqueue(eventEnvelope("Ev-github-missing-push-ref")).row;
    const job = fixture.database.createJob({
      source_event_id: source.event_id,
      objective: "確認する",
      workspace: { kind: "github", repository: "owner/repo", base_ref: "main@{push}" },
    }, fixture.config.jobsWorkspaceRoot, fixture.config.jobResultsDir).row;

    await new HerdrJobAgentRuntime(fixture.config).prepare(job);
    assert.equal(await git(job.workspace_path, "rev-parse", "HEAD"), fixture.raceSha);
    fixture.database.close();
  });

  test("push currentはtracking設定なしで同名remote branchを解決する", async () => {
    const fixture = await githubFixture();
    const repositoryPath = path.join(fixture.config.jobsWorkspaceRoot, "github", "owner", "repo", "repository");
    await git(repositoryPath, "config", "--unset-all", "branch.main.remote").catch(() => undefined);
    await git(repositoryPath, "config", "--unset-all", "branch.main.merge").catch(() => undefined);
    await git(repositoryPath, "config", "push.default", "current");
    await git(repositoryPath, "update-ref", "-d", "refs/remotes/origin/main");
    const source = fixture.database.enqueue(eventEnvelope("Ev-github-push-current")).row;
    const job = fixture.database.createJob({
      source_event_id: source.event_id,
      objective: "確認する",
      workspace: { kind: "github", repository: "owner/repo", base_ref: "main@{push}" },
    }, fixture.config.jobsWorkspaceRoot, fixture.config.jobResultsDir).row;

    await new HerdrJobAgentRuntime(fixture.config).prepare(job);
    assert.equal(await git(job.workspace_path, "rev-parse", "HEAD"), await git(fixture.seedPath, "rev-parse", "main"));
    fixture.database.close();
  });

  test("push trackingとmatchingを解決し異なるtracking remoteは拒否する", async () => {
    const fixture = await githubFixture();
    const repositoryPath = path.join(fixture.config.jobsWorkspaceRoot, "github", "owner", "repo", "repository");
    await git(fixture.seedPath, "push", "origin", "feature/test:refs/heads/stable");
    await git(repositoryPath, "config", "branch.main.remote", "origin");
    await git(repositoryPath, "config", "branch.main.merge", "refs/heads/stable");
    await git(repositoryPath, "config", "push.default", "tracking");
    const trackingSource = fixture.database.enqueue(eventEnvelope("Ev-github-push-tracking")).row;
    const trackingJob = fixture.database.createJob({
      source_event_id: trackingSource.event_id,
      objective: "確認する",
      workspace: { kind: "github", repository: "owner/repo", base_ref: "main@{push}" },
    }, fixture.config.jobsWorkspaceRoot, fixture.config.jobResultsDir).row;
    await new HerdrJobAgentRuntime(fixture.config).prepare(trackingJob);
    assert.equal(await git(trackingJob.workspace_path, "rev-parse", "HEAD"), fixture.raceSha);

    await git(repositoryPath, "config", "push.default", "matching");
    const matchingSource = fixture.database.enqueue(eventEnvelope("Ev-github-push-matching")).row;
    const matchingJob = fixture.database.createJob({
      source_event_id: matchingSource.event_id,
      objective: "確認する",
      workspace: { kind: "github", repository: "owner/repo", base_ref: "main@{push}" },
    }, fixture.config.jobsWorkspaceRoot, fixture.config.jobResultsDir).row;
    await new HerdrJobAgentRuntime(fixture.config).prepare(matchingJob);
    assert.equal(await git(matchingJob.workspace_path, "rev-parse", "HEAD"), await git(fixture.seedPath, "rev-parse", "main"));

    await git(repositoryPath, "config", "branch.main.remote", "upstream");
    await git(repositoryPath, "config", "branch.main.pushRemote", "origin");
    await git(repositoryPath, "config", "push.default", "upstream");
    const rejectedSource = fixture.database.enqueue(eventEnvelope("Ev-github-push-wrong-upstream")).row;
    const rejectedJob = fixture.database.createJob({
      source_event_id: rejectedSource.event_id,
      objective: "確認する",
      workspace: { kind: "github", repository: "owner/repo", base_ref: "main@{push}" },
    }, fixture.config.jobsWorkspaceRoot, fixture.config.jobResultsDir).row;
    await assert.rejects(
      new HerdrJobAgentRuntime(fixture.config).prepare(rejectedJob),
      /does not resolve to an origin branch/,
    );
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
    await git(fixture.seedPath, "push", "origin", `main:refs/heads/${fixture.featureSha}`);
    const cases = [
      { event: "Ev-github-origin-prefix", baseRef: "origin/main", expected: await git(fixture.seedPath, "rev-parse", "main") },
      { event: "Ev-github-origin-default", baseRef: "origin", expected: await git(fixture.seedPath, "rev-parse", "main") },
      { event: "Ev-github-heads-prefix", baseRef: "heads/main", expected: await git(fixture.seedPath, "rev-parse", "main") },
      { event: "Ev-github-remotes-origin-prefix", baseRef: "remotes/origin/main", expected: await git(fixture.seedPath, "rev-parse", "main") },
      { event: "Ev-github-head", baseRef: "HEAD", expected: await git(fixture.seedPath, "rev-parse", "main") },
      { event: "Ev-github-fetch-head", baseRef: "FETCH_HEAD", expected: await git(fixture.seedPath, "rev-parse", "main") },
      { event: "Ev-github-at-head", baseRef: "@", expected: await git(fixture.seedPath, "rev-parse", "main") },
      { event: "Ev-github-upstream-head", baseRef: "@{upstream}", expected: await git(fixture.seedPath, "rev-parse", "main") },
      { event: "Ev-github-main-upstream", baseRef: "main@{upstream}", expected: fixture.raceSha },
      { event: "Ev-github-main-uppercase-upstream", baseRef: "main@{UPSTREAM}", expected: fixture.raceSha },
      { event: "Ev-github-push-head", baseRef: "@{push}", expected: await git(fixture.seedPath, "rev-parse", "main") },
      { event: "Ev-github-main-push", baseRef: "main@{push}", expected: fixture.raceSha },
      { event: "Ev-github-main-uppercase-push", baseRef: "main@{PUSH}", expected: fixture.raceSha },
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
      display: { short_name: "再利用ラベル", issue: { repository: "owner/repo", number: 87 } },
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
    const restored = calls.find((args) => args[2] === "workspace" && args[3] === "create")!;
    assert.equal(restored[restored.indexOf("--label") + 1], "#87 再利用ラベル");
    fixture.database.close();
  });

  test("worktree作成前の再試行は永続化済みbase SHAを維持する", async () => {
    const fixture = await githubFixture();
    const source = fixture.database.enqueue(eventEnvelope("Ev-github-persisted-base-retry")).row;
    const job = fixture.database.createJob({
      source_event_id: source.event_id,
      objective: "確認する",
      workspace: { kind: "github", repository: "owner/repo", base_ref: "feature/test" },
    }, fixture.config.jobsWorkspaceRoot, fixture.config.jobResultsDir).row;
    const repositoryPath = path.join(fixture.config.jobsWorkspaceRoot, "github", "owner", "repo", "repository");
    await git(repositoryPath, "fetch", path.join(fixture.root, "origin.git"), `feature/test:refs/dona/bases/${job.job_id}`);
    await git(fixture.root, "--git-dir", path.join(fixture.root, "origin.git"), "update-ref", "refs/heads/feature/test", fixture.raceSha);

    await new HerdrJobAgentRuntime(fixture.config).prepare(job);

    assert.equal(await git(job.workspace_path, "rev-parse", "HEAD"), fixture.featureSha);
    assert.equal(await git(repositoryPath, "rev-parse", `refs/dona/bases/${job.job_id}`), fixture.featureSha);
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
