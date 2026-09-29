import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CanonicalBuild, canonicalDiagnosticStep } from "../src/adapters.js";
import { ProcessRunner } from "../src/process.js";
import type { CommandResult } from "../src/types.js";
import { tempPolicy } from "./helpers.js";

const execute = promisify(execFile);
const preflight = fileURLToPath(new URL("../../scripts/self-update-install-preflight.mjs", import.meta.url));
const installer = fileURLToPath(new URL("../../scripts/install-self-update.sh", import.meta.url));
const developerInstaller = fileURLToPath(new URL("../../scripts/install-launchd.sh", import.meta.url));
const controlLedger = fileURLToPath(new URL("../../scripts/control-attempt-ledger.mjs", import.meta.url));
const controlBackup = fileURLToPath(new URL("../../scripts/backup-control-db.py", import.meta.url));
const controlReceipt = fileURLToPath(new URL("../../scripts/write-control-receipt.mjs", import.meta.url));
const controlRehearsal = fileURLToPath(new URL("../../scripts/rehearse-control-restore.mjs", import.meta.url));
const installCi = fileURLToPath(new URL("../../scripts/verify-install-ci.mjs", import.meta.url));
const installContract = fileURLToPath(new URL("../../scripts/bootstrap-install-contract.mjs", import.meta.url));

test("bootstrap resume checks the install-time files independently of the current checkout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-install-contract-"));
  const control = path.join(root, "control");
  const agents = path.join(root, "agents");
  const releases = path.join(root, "releases");
  const sha = "a".repeat(40);
  try {
    await fs.mkdir(control, { mode: 0o700 });
    await fs.mkdir(agents, { mode: 0o700 });
    await fs.mkdir(path.join(control, "updater"), { mode: 0o700 });
    await fs.writeFile(path.join(control, "updater", "cli.js"), "updater", { mode: 0o400 });
    await fs.mkdir(releases, { mode: 0o700 });
    await fs.mkdir(path.join(releases, sha), { mode: 0o700 });
    await fs.writeFile(path.join(releases, sha, "cli.js"), "release", { mode: 0o400 });
    await fs.chmod(path.join(releases, sha), 0o500);
    for (const name of ["policy.json", "dev.dona.updater.plist", "dev.dona.dispatcher.plist", "dev.dona.slack-adapter.plist"]) {
      await fs.writeFile(path.join(name === "policy.json" ? control : agents, name), name, { mode: 0o600 });
    }
    await execute(process.execPath, [installContract, "record", control, agents, releases, sha]);
    await execute(process.execPath, [installContract, "verify", control, agents, releases, sha]);
    await assert.rejects(execute(process.execPath, [installContract, "verify", control, agents, releases, "b".repeat(40)]));
    await fs.chmod(path.join(releases, sha), 0o700);
    await fs.chmod(path.join(releases, sha, "cli.js"), 0o600);
    await fs.writeFile(path.join(releases, sha, "cli.js"), "changed");
    await fs.chmod(path.join(releases, sha, "cli.js"), 0o400);
    await fs.chmod(path.join(releases, sha), 0o500);
    await assert.rejects(execute(process.execPath, [installContract, "verify", control, agents, releases, sha]));
    await fs.chmod(path.join(releases, sha), 0o700);
    await fs.chmod(path.join(releases, sha, "cli.js"), 0o600);
    await fs.writeFile(path.join(releases, sha, "cli.js"), "release");
    await fs.chmod(path.join(releases, sha, "cli.js"), 0o400);
    await fs.chmod(path.join(releases, sha), 0o500);
    await fs.chmod(path.join(control, "updater", "cli.js"), 0o600);
    await fs.writeFile(path.join(control, "updater", "cli.js"), "changed");
    await fs.chmod(path.join(control, "updater", "cli.js"), 0o400);
    await assert.rejects(execute(process.execPath, [installContract, "verify", control, agents, releases, sha]));
    await fs.writeFile(path.join(agents, "dev.dona.slack-adapter.plist"), "changed");
    await assert.rejects(execute(process.execPath, [installContract, "verify", control, agents, releases, sha]));
    await assert.rejects(execute(process.execPath, [installContract, "record", control, agents, releases, sha]));
    const source = await fs.readFile(installer, "utf8");
    assert.match(source, /bootstrap-install-contract\.mjs" bootstrap-verify/);
    assert.match(source, /bootstrap-install-contract\.mjs" record/);
    assert.doesNotMatch(source, /cmp -s "\$INSTALL_TMP\/rendered\/dev\.dona\.(?:dispatcher|slack-adapter)\.plist"/);
  } finally {
    await fs.chmod(path.join(releases, sha), 0o700).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an interrupted install contract is recovered only from the same verified build", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-install-contract-recovery-"));
  const control = path.join(root, "control");
  const agents = path.join(root, "agents");
  const releases = path.join(root, "releases");
  const rendered = path.join(root, "rendered");
  const staged = path.join(root, "staged");
  const sha = "a".repeat(40);
  const installedRelease = path.join(releases, sha);
  try {
    for (const directory of [control, agents, releases, rendered, staged, installedRelease,
      path.join(control, "updater"), path.join(staged, "updater"), path.join(installedRelease, "updater")]) {
      await fs.mkdir(directory, { mode: 0o700 });
    }
    for (const name of ["policy.json", "dev.dona.updater.plist", "dev.dona.dispatcher.plist", "dev.dona.slack-adapter.plist"]) {
      const destination = name === "policy.json" ? control : agents;
      await fs.writeFile(path.join(rendered, name), name, { mode: 0o600 });
      await fs.writeFile(path.join(destination, name), name, { mode: 0o600 });
    }
    for (const directory of [path.join(control, "updater"), path.join(staged, "updater"),
      path.join(installedRelease, "updater")]) {
      await fs.writeFile(path.join(directory, "cli.js"), "same build", { mode: 0o400 });
    }
    await fs.chmod(path.join(installedRelease, "updater"), 0o500);
    await fs.chmod(installedRelease, 0o500);
    const temp = path.join(control, ".bootstrap-install-contract.json.tmp");
    await fs.writeFile(temp, "partial", { mode: 0o600 });
    const recover = () => execute(process.execPath,
      [installContract, "recover", control, agents, releases, sha, rendered, staged]);
    await fs.writeFile(path.join(agents, "dev.dona.dispatcher.plist"), "tampered");
    await assert.rejects(recover(), /trusted render/);
    assert.equal(await fs.readFile(temp, "utf8"), "partial");
    await fs.writeFile(path.join(agents, "dev.dona.dispatcher.plist"), "dev.dona.dispatcher.plist");
    await recover();
    await execute(process.execPath, [installContract, "verify", control, agents, releases, sha]);
    await assert.rejects(recover(), /already exists/);
    await assert.rejects(fs.stat(temp), { code: "ENOENT" });
  } finally {
    await fs.chmod(installedRelease, 0o700).catch(() => undefined);
    await fs.chmod(path.join(installedRelease, "updater"), 0o700).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bootstrap binds current pointer and installed Node to the verified release", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-bootstrap-targets-"));
  const control = path.join(root, "control");
  const agents = path.join(root, "agents");
  const runtime = path.join(root, "runtime");
  const releases = path.join(runtime, "releases");
  const sha = "a".repeat(40);
  const release = path.join(releases, sha);
  try {
    for (const directory of [control, agents, runtime, releases, release, path.join(control, "updater")]) {
      await fs.mkdir(directory, { mode: 0o700 });
    }
    await fs.writeFile(path.join(control, "updater", "cli.js"), "updater", { mode: 0o400 });
    await fs.writeFile(path.join(control, "policy.json"), "policy", { mode: 0o600 });
    const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>ProgramArguments</key><array><string>${process.execPath}</string></array></dict></plist>`;
    for (const name of ["dev.dona.updater.plist", "dev.dona.dispatcher.plist", "dev.dona.slack-adapter.plist"]) {
      await fs.writeFile(path.join(agents, name), plist, { mode: 0o600 });
    }
    const manifest = path.join(release, "release-manifest.json");
    await fs.writeFile(manifest, JSON.stringify({ sha, node_version: process.versions.node, built_at: "2026-09-29T00:00:00Z" }), { mode: 0o400 });
    await fs.symlink(`releases/${sha}`, path.join(runtime, "current"));
    await fs.chmod(release, 0o500);
    const record = () => execute(process.execPath, [installContract, "record", control, agents, releases, sha]);
    const verify = () => execute(process.execPath, [installContract, "bootstrap-verify", control, agents, releases, sha]);
    await record();
    await verify();
    await fs.unlink(path.join(runtime, "current"));
    await fs.symlink(`elsewhere/${sha}`, path.join(runtime, "current"));
    await assert.rejects(verify(), /current pointer/);
    await fs.unlink(path.join(runtime, "current"));
    await fs.symlink(`releases/${sha}`, path.join(runtime, "current"));
    await fs.unlink(path.join(control, "bootstrap-install-contract.json"));
    await fs.chmod(release, 0o700);
    await fs.chmod(manifest, 0o600);
    await fs.writeFile(manifest, JSON.stringify({ sha, node_version: "0.0.0", built_at: "2026-09-29T00:00:00Z" }));
    await fs.chmod(manifest, 0o400);
    await fs.chmod(release, 0o500);
    await record();
    await assert.rejects(verify(), /Node differs/);
  } finally {
    await fs.chmod(release, 0o700).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});
type WaitForLaunchdServiceAbsent = (
  domain: string,
  label: string,
  timeoutMs: number,
  options?: {
    observe?: (target: string, timeoutMs: number) => Promise<boolean>;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
    intervalMs?: number;
    settledObservations?: number;
  },
) => Promise<void>;
type WaitForLaunchdUpdaterSha = (
  domain: string, sha: string, timeoutMs: number,
  options?: { observe?: (target: string, timeoutMs: number) => Promise<string | null>;
    sleep?: (milliseconds: number) => Promise<void>; now?: () => number },
) => Promise<void>;
type WaitForUpdaterIdentity = (
  socketPath: string, sha: string, domain: string, timeoutMs: number,
  options?: { allowLegacyHealth?: boolean; healthRead?: () => Promise<unknown>; registrationRead?: () => Promise<string>;
    processStartRead?: (pid: number) => Promise<string>; lockRead?: () => Promise<unknown> },
) => Promise<void>;
type WaitForDispatcherSha = (socketPath: string, sha: string, domain: string, timeoutMs: number,
  options?: { allowLegacyHealth?: boolean; healthRead?: () => Promise<unknown>;
    registrationRead?: () => Promise<string>; processStartRead?: (pid: number) => Promise<string> }) => Promise<void>;
type LaunchctlOnce = (operation: string, domain: string, target: string, timeoutMs: number,
  options?: { run?: (args: string[]) => Promise<unknown> }) => Promise<void>;
type WaitForSlackSha = (socketPath: string, sha: string, domain: string, timeoutMs: number,
  options?: { registrationRead?: () => Promise<string>; processStartRead?: (pid: number) => Promise<string>;
    healthRead?: () => Promise<unknown>; sleep?: (milliseconds: number) => Promise<void>; now?: () => number }) => Promise<void>;
type ReadUpdaterRegistrationSha = (domain: string, timeoutMs: number,
  options?: { run?: (target: string, timeoutMs: number) => Promise<{ stdout: string }> }) => Promise<string | null>;
const preflightModule = await import(pathToFileURL(preflight).href) as {
  waitForLaunchdServiceAbsent: WaitForLaunchdServiceAbsent;
  waitForLaunchdUpdaterSha: WaitForLaunchdUpdaterSha;
  waitForUpdaterIdentity: WaitForUpdaterIdentity;
  waitForDispatcherSha: WaitForDispatcherSha;
  launchctlOnce: LaunchctlOnce;
  waitForSlackSha: WaitForSlackSha;
  readUpdaterRegistrationSha: ReadUpdaterRegistrationSha;
};
const { waitForLaunchdServiceAbsent, waitForLaunchdUpdaterSha, waitForUpdaterIdentity,
  waitForDispatcherSha, launchctlOnce, waitForSlackSha, readUpdaterRegistrationSha } = preflightModule;

test("developer installer atomically creates and shares the access receipt key",async()=>{
  const source=await fs.readFile(developerInstaller,"utf8");
  assert.match(source,/openssl rand -hex 32/);
  assert.match(source,/mv "\$DISPATCHER_TOKEN_PATH\.tmp" "\$DISPATCHER_TOKEN_PATH"/);
  assert.equal(source.match(/<key>DONA_UPDATE_INTERNAL_TOKEN_PATH<\/key>/g)?.length,2);
});

async function run(mode: string, ...values: string[]): Promise<void> {
  await execute(process.execPath, [preflight, mode, ...values]);
}

test("installer trust binds every required check to one exact main push workflow", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-install-ci-"));
  const checksPath = path.join(root, "checks.json");
  const workflowPath = path.join(root, "workflow.json");
  const sha = "a".repeat(40);
  const names = ["Verify dispatcher", "Verify sources/slack", "Verify updater", "Verify self-hosted macOS"];
  const check_runs = names.map((name, index) => ({ name, head_sha: sha, status: "completed", conclusion: "success",
    app: { slug: "github-actions" }, details_url: `https://github.com/hiragram/dona/actions/runs/42/job/${index + 1}` }));
  try {
    await fs.writeFile(checksPath, JSON.stringify({ total_count: 4, check_runs }));
    assert.equal((await execute(process.execPath, [installCi, "checks", checksPath, sha])).stdout.trim(), "42");
    const workflow = { id: 42, event: "push", head_branch: "main", head_sha: sha,
      status: "completed", conclusion: "success", name: "CI" };
    await fs.writeFile(workflowPath, JSON.stringify(workflow));
    await execute(process.execPath, [installCi, "workflow", workflowPath, sha, "42"]);
    await fs.writeFile(workflowPath, JSON.stringify({ ...workflow, event: "pull_request" }));
    await assert.rejects(execute(process.execPath, [installCi, "workflow", workflowPath, sha, "42"]));
    await fs.writeFile(checksPath, JSON.stringify({ total_count: 5, check_runs }));
    await assert.rejects(execute(process.execPath, [installCi, "checks", checksPath, sha]));
    await fs.writeFile(checksPath, JSON.stringify({ total_count: 4, check_runs: check_runs.map((run, index) =>
      index === 3 ? { ...run, details_url: "https://github.com/hiragram/dona/actions/runs/43/job/4" } : run) }));
    await assert.rejects(execute(process.execPath, [installCi, "checks", checksPath, sha]));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("installer accepts only canonical HTTPS and SSH forms for hiragram/dona", async () => {
  for (const remote of [
    "https://github.com/hiragram/dona.git",
    "https://github.com/hiragram/dona",
    "git@github.com:hiragram/dona.git",
    "git@github.com:hiragram/dona",
    "ssh://git@github.com/hiragram/dona.git",
    "ssh://git@github.com/hiragram/dona",
  ]) {
    await run("validate-remote", remote);
  }

  for (const remote of [
    "https://github.com.evil.invalid/hiragram/dona.git",
    "https://github.com/hiragram/dona.git?ref=main",
    "https://attacker@github.com/hiragram/dona.git",
    "git@github.com:hiragram/dona.git/other",
    "git@gitlab.com:hiragram/dona.git",
    "ssh://root@github.com/hiragram/dona.git",
  ]) {
    await assert.rejects(run("validate-remote", remote));
  }
});

test("installer prints option-prefixed usage text without treating it as a zsh print option", {
  skip: process.platform !== "darwin",
}, async () => {
  await assert.rejects(execute("/bin/zsh", [installer]), (error: unknown) => {
    const result = error as { code?: number; stderr?: string };
    assert.equal(result.code, 2);
    assert.match(result.stderr ?? "", /--checkはtemplateのみ検証/);
    assert.doesNotMatch(result.stderr ?? "", /bad option/);
    return true;
  });
});

test("bootstrap preflight distinguishes a listening dispatcher socket from an unused path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-install-preflight-"));
  const socketPath = path.join(root, "dispatcher.sock");
  const server = net.createServer((socket) => socket.end());
  try {
    await run("assert-socket-unused", socketPath);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await assert.rejects(run("assert-socket-unused", socketPath), /processが応答中/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("control-plane upgrade preflight requires exact updater health and only terminal requests", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-control-upgrade-preflight-"));
  const socketPath = path.join(root, "updater.sock");
  let state = "needs_review";
  let nonterminalCount = 0;
  let updateSchema: number | undefined = 3;
  const sha = "2".repeat(40);
  const server = http.createServer((request, response) => {
    const body = request.url === "/health/version"
      ? { schema_version: 1, status: "ready", service: "updater", build_sha: sha, update_schema: updateSchema }
      : { schema_version: 1, updates: [{ state }], nonterminal_count: nonterminalCount };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await run("assert-control-upgrade-safe", socketPath);
    await run("wait-updater-sha", socketPath, sha, "500", "3");
    updateSchema = 1;
    await assert.rejects(run("wait-updater-sha", socketPath, sha, "50", "3"), /was not observed/);
    updateSchema = 3;
    state = "approved";
    nonterminalCount = 1;
    await assert.rejects(run("assert-control-upgrade-safe", socketPath), /active self-update/);
    await assert.rejects(run("wait-updater-sha", socketPath, "3".repeat(40), "50"), /was not observed/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("control-plane upgradeはDispatcherのquiesceとdrain完了を要求する", async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-dispatcher-drain-")),socketPath=path.join(root,"dispatcher.sock");
  let polls=0;
  const server=http.createServer((request,response)=>{
    const body=request.url==="/v1/admin/quiesce"?{schema_version:1,protocol:1,service:"dispatcher",quiescing:true,drained:false,in_flight:1,unsafe_states:["event.dispatching"]}:{schema_version:1,protocol:1,service:"dispatcher",quiescing:true,drained:++polls>1,in_flight:polls>1?0:1,unsafe_states:polls>1?[]:["event.dispatching"]};
    response.writeHead(request.url==="/v1/admin/quiesce"?202:200,{"content-type":"application/json"});response.end(JSON.stringify(body));
  });
  try { await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(socketPath,resolve);}); await run("quiesce-dispatcher",socketPath,"2".repeat(40)); assert.ok(polls>1); }
  finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); await fs.rm(root,{recursive:true,force:true}); }
});

test("launchdの登録解除はstale registrationが消えてから安定観測する", async () => {
  const observations = [true, false, true, false, false, false];
  let elapsed = 0;
  const targets: string[] = [];
  await waitForLaunchdServiceAbsent("gui/501", "dev.dona.dispatcher", 1_000, {
    observe: async (target: string) => {
      targets.push(target);
      return observations.shift() ?? false;
    },
    sleep: async (milliseconds: number) => { elapsed += milliseconds; },
    now: () => elapsed,
    intervalMs: 10,
    settledObservations: 3,
  });
  assert.deepEqual(targets, Array(6).fill("gui/501/dev.dona.dispatcher"));
});

test("Slack Adapterの登録解除と起動healthを固定labelとSHAで照合する", async () => {
  let elapsed = 0;
  const targets: string[] = [];
  await waitForLaunchdServiceAbsent("gui/501", "dev.dona.slack-adapter", 1_000, {
    observe: async (target: string) => { targets.push(target); return false; },
    sleep: async (milliseconds: number) => { elapsed += milliseconds; }, now: () => elapsed,
  });
  assert.deepEqual(targets, Array(3).fill("gui/501/dev.dona.slack-adapter"));
  const sha = "a".repeat(40);
  const socket = path.join(os.tmpdir(), "dona-slack-health.sock");
  const options = { registrationRead: async () => "pid = 123",
    processStartRead: async () => "Tue Sep 29 13:00:00 2026",
    healthRead: async () => ({ schema_version: 1, status: "ready", service: "slack_adapter", build_sha: sha,
      pid: 123, process_start: "Tue Sep 29 13:00:00 2026" }),
    sleep: async (milliseconds: number) => { elapsed += milliseconds; }, now: () => elapsed };
  await waitForSlackSha(socket, sha, "gui/501", 1_000, options);
  await assert.rejects(waitForSlackSha(socket, "b".repeat(40), "gui/501", 250, options), /not observed/);
  await assert.rejects(waitForSlackSha(socket, sha, "gui/501", 250,
    { ...options, healthRead: async () => ({ ...(await options.healthRead()), pid: 124 }) }), /not observed/);
});

test("復旧前のUpdater登録照会は期限付きでSHAだけを返す", async () => {
  const sha = "a".repeat(40);
  const targets: string[] = [];
  assert.equal(await readUpdaterRegistrationSha("gui/501", 30000, {
    run: async (target, timeout) => {
      targets.push(`${target}:${timeout}`);
      return { stdout: `environment = { DONA_UPDATER_BUILD_SHA => ${sha} }` };
    },
  }), sha);
  assert.deepEqual(targets, ["gui/501/dev.dona.updater:30000"]);
  await assert.rejects(readUpdaterRegistrationSha("gui/501", 30000, {
    run: async () => { throw Object.assign(new Error("timeout"), { killed: true }); },
  }), /failed or timed out/);
  await assert.rejects(readUpdaterRegistrationSha("gui/501", 30000, {
    run: async () => ({ stdout: "unverified" }),
  }), /unavailable or ambiguous/);
});

test("launchdの登録解除timeoutは対象labelを保持し、plist切替前に失敗する", async () => {
  let elapsed = 0;
  await assert.rejects(
    waitForLaunchdServiceAbsent("gui/501", "dev.dona.dispatcher", 25, {
      observe: async () => true,
      sleep: async (milliseconds: number) => { elapsed += milliseconds; },
      now: () => elapsed,
      intervalMs: 10,
      settledObservations: 3,
    }),
    /dev\.dona\.dispatcher remained registered after bootout timeout/,
  );
});

test("launchdの登録観測自体が応答しない場合もdeadlineで失敗する", async () => {
  await assert.rejects(
    waitForLaunchdServiceAbsent("gui/501", "dev.dona.dispatcher", 20, {
      observe: async () => new Promise<boolean>(() => undefined),
      intervalMs: 1,
      settledObservations: 3,
    }),
    /launchd registration observation timed out/,
  );
});

test("Updaterのbootstrap応答喪失はexact SHAを安定観測し、別SHAとtimeoutは再送せず拒否する", async () => {
  const sha = "a".repeat(40);
  const other = "b".repeat(40);
  let count = 0;
  await waitForLaunchdUpdaterSha("gui/501", sha, 1_000, {
    observe: async () => (++count === 1 ? null : `DONA_UPDATER_BUILD_SHA => ${sha}`),
    sleep: async () => undefined,
  });
  assert.equal(count, 4);
  await assert.rejects(waitForLaunchdUpdaterSha("gui/501", sha, 1_000, {
    observe: async () => `DONA_UPDATER_BUILD_SHA => ${other}`,
  }), /different updater SHA/);
  await assert.rejects(waitForLaunchdUpdaterSha("gui/501", sha, 10, {
    observe: async () => new Promise(() => undefined),
  }), /timed out/);
});

test("Updater healthのPIDとstart identityをsocket lock・launchd・process観測へ束縛する", async () => {
  const sha = "a".repeat(40);
  const processStart = "Tue Sep 29 03:00:00 2026";
  const health = { status: "ready", service: "updater", build_sha: sha, pid: 123, process_start: processStart };
  const options = { healthRead: async () => health,
    registrationRead: async () => `DONA_UPDATER_BUILD_SHA => ${sha}\npid = 123\n`,
    processStartRead: async () => processStart,
    lockRead: async () => ({ pid: 123, process_start: processStart }) };
  await waitForUpdaterIdentity("/tmp/updater.sock", sha, "gui/501", 500, options);
  await assert.rejects(waitForUpdaterIdentity("/tmp/updater.sock", sha, "gui/501", 500,
    { ...options, registrationRead: async () => `DONA_UPDATER_BUILD_SHA => ${sha}\npid = 124\n` }), /disagree/);
  await assert.rejects(waitForUpdaterIdentity("/tmp/updater.sock", sha, "gui/501", 500,
    { ...options, processStartRead: async () => "older process" }), /disagree/);
  await assert.rejects(waitForUpdaterIdentity("/tmp/updater.sock", sha, "gui/501", 500,
    { ...options, healthRead: async () => ({ ...health, pid: null }) }), /invalid/);
});

test("旧Updater復旧では旧health形式をstartup lockとlaunchdのPIDへ束縛する", async () => {
  const sha = "a".repeat(40);
  const processStart = "Tue Sep 29 03:00:00 2026";
  const health = { status: "ready", service: "updater", build_sha: sha };
  const options = {
    allowLegacyHealth: true,
    healthRead: async () => health,
    registrationRead: async () => `DONA_UPDATER_BUILD_SHA => ${sha}\npid = 123\n`,
    processStartRead: async () => processStart,
    lockRead: async () => ({ pid: 123, process_start: processStart }),
  };
  await waitForUpdaterIdentity("/tmp/updater.sock", sha, "gui/501", 500, options);
  await assert.rejects(waitForUpdaterIdentity("/tmp/updater.sock", sha, "gui/501", 500,
    { ...options, allowLegacyHealth: false }), /invalid/);
  await assert.rejects(waitForUpdaterIdentity("/tmp/updater.sock", sha, "gui/501", 500,
    { ...options, registrationRead: async () => `DONA_UPDATER_BUILD_SHA => ${sha}\npid = 124\n` }), /disagree/);
  await assert.rejects(waitForUpdaterIdentity("/tmp/updater.sock", sha, "gui/501", 500,
    { ...options, processStartRead: async () => "older process" }), /disagree/);
  await assert.rejects(waitForUpdaterIdentity("/tmp/updater.sock", sha, "gui/501", 500,
    { ...options, healthRead: async () => ({ ...health, pid: 123 }) }), /invalid/);
});

test("Dispatcherの同一SHA healthは固定launchd labelの登録PIDも必要とする", async () => {
  const sha = "a".repeat(40);
  const processStart = "Tue Sep 29 03:00:00 2026";
  const health = { status: "ready", service: "dispatcher", build_sha: sha, pid: 123,
    process_start: processStart };
  const options = { healthRead: async () => health,
    registrationRead: async () => "pid = 123", processStartRead: async () => processStart };
  await waitForDispatcherSha("/tmp/dispatcher.sock", sha, "gui/501", 500, options);
  await assert.rejects(waitForDispatcherSha("/tmp/dispatcher.sock", sha, "gui/501", 10,
    { ...options, registrationRead: async () => "" }), /not observed under its fixed launchd label/);
  await assert.rejects(waitForDispatcherSha("/tmp/dispatcher.sock", sha, "gui/501", 10,
    { ...options, registrationRead: async () => "pid = 124" }), /not observed under its fixed launchd label/);
  await assert.rejects(waitForDispatcherSha("/tmp/dispatcher.sock", sha, "gui/501", 10,
    { ...options, processStartRead: async () => "older process" }), /not observed under its fixed launchd label/);
  const oldHealth = { status: "ready", service: "dispatcher", build_sha: sha };
  await assert.rejects(waitForDispatcherSha("/tmp/dispatcher.sock", sha, "gui/501", 10,
    { ...options, healthRead: async () => oldHealth }), /not observed under its fixed launchd label/);
  await waitForDispatcherSha("/tmp/dispatcher.sock", sha, "gui/501", 500,
    { ...options, allowLegacyHealth: true, healthRead: async () => oldHealth });
});

test("launchctl timeoutを単一writeで止め、targetを固定する", async () => {
  const calls: string[][] = [];
  await assert.rejects(launchctlOnce("bootout", "gui/501", "dev.dona.updater", 100,
    { run: async args => { calls.push(args); throw new Error("timed out"); } }), /timed out/);
  assert.deepEqual(calls, [["bootout", "gui/501/dev.dona.updater"]]);
  await assert.rejects(launchctlOnce("bootout", "gui/501", "dev.dona.unknown", 100,
    { run: async args => { calls.push(args); } }), /target is invalid/);
  assert.equal(calls.length, 1);
});

test("macOS preserves hardened descendants when renaming a reopened staged updater", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-control-rename-"));
  const staged = path.join(root, "updater.next");
  const destination = path.join(root, "updater");
  const child = path.join(staged, "dist");
  const entrypoint = path.join(child, "cli.js");
  try {
    await fs.mkdir(child, { recursive: true });
    await fs.writeFile(entrypoint, "export {};\n");
    await fs.chmod(entrypoint, 0o400);
    await fs.chmod(child, 0o500);
    await fs.chmod(staged, 0o500);
    assert.equal((await fs.stat(staged)).mode & 0o777, 0o500);
    await fs.chmod(staged, 0o700);
    await execute("/bin/mv", [staged, destination]);
    assert.equal((await fs.stat(destination)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(destination, "dist"))).mode & 0o777, 0o500);
    assert.equal((await fs.stat(path.join(destination, "dist", "cli.js"))).mode & 0o777, 0o400);
  } finally {
    const cleanupRoot = await fs.stat(destination).then(() => destination, () => staged);
    await fs.chmod(cleanupRoot, 0o700).catch(() => undefined);
    await fs.chmod(path.join(cleanupRoot, "dist"), 0o700).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("installer exposes the guarded control-plane upgrade mode", async () => {
  const source = await fs.readFile(installer, "utf8");
  const initialBootstrap = source.slice(source.indexOf('if [[ "$MODE" == "--bootstrap" ]]; then', source.indexOf('trap cleanup_temp EXIT')), source.indexOf('if [[ "$(uname -s)"'));
  assert.ok(initialBootstrap.startsWith('if [[ "$MODE" == "--bootstrap" ]]; then'));
  assert.ok(source.indexOf('exec /bin/zsh "$BOOTSTRAP_SCRIPT" --bootstrap') <
    source.indexOf('render-self-update-templates.mjs'));
  assert.match(source, /if \[\[ "\$MODE" != "--bootstrap" \]\]; then[\s\S]*render-self-update-templates\.mjs/);
  assert.match(source, /BOOTSTRAP_UPDATER_SHA=\$\(\/usr\/libexec\/PlistBuddy/);
  assert.doesNotMatch(initialBootstrap, /bootout "\$DOMAIN" dev\.dona\.(?:dispatcher|slack-adapter)/);
  assert.match(initialBootstrap, /dispatcher_registered=0[\s\S]*wait-dispatcher-sha[\s\S]*if \[\[ "\$dispatcher_registered" == "0" \]\] &&[\s\S]*bootstrap_dispatcher_reconciled/);
  assert.match(initialBootstrap, /slack_registered=0[\s\S]*wait-slack-sha[\s\S]*if \[\[ "\$slack_registered" == "0" \]\] && ! bootstrap_slack_reconciled/);
  assert.match(source, /--upgrade-control/);
  assert.match(source, /assert-control-upgrade-safe/);
  assert.match(source, /wait-updater-sha/);
  assert.match(source, /control-plane-receipt\.json/);
  assert.match(source, /control-plane-receipt\.previous\.json/);
  assert.match(source, /control-plane-receipt\.was-absent/);
  assert.doesNotMatch(source, /\.control-plane-receipt\.json\.tmp/);
  assert.match(source, /control-plane-receipt\.json\.\$\$\.\$RANDOM\.tmp/);
  assert.match(await fs.readFile(controlReceipt, "utf8"), /dispatcher_v2_to_v3_online_backup_v1/);
  assert.match(source, /updater\.previous\.sqlite3/);
  assert.match(source, /dev\.dona\.dispatcher\.previous\.plist/);
  assert.match(source, /dev\.dona\.dispatcher\.next\.plist/);
  assert.match(source, /launchctl_once bootout "\$DOMAIN" dev\.dona\.dispatcher 30000/);
  assert.match(source,/DISPATCHER_RESTORE_REQUIRED=1[\s\S]*wait_dispatcher_unregistered[\s\S]*\/bin\/mv "\$BACKUP_ROOT\/dev\.dona\.dispatcher\.next\.plist"/);
  assert.match(source,/if \[\[ "\$DISPATCHER_RESTORE_REQUIRED" == "1"[\s\S]*wait_dispatcher_unregistered[\s\S]*bootstrap_dispatcher_reconciled "旧Updaterの復旧後の旧Dispatcher再登録"/);
  assert.match(source,/launchctl_once bootout "\$DOMAIN" dev\.dona\.dispatcher 30000 \|\| dispatcher_bootout_exit=\$\?[\s\S]*wait_dispatcher_unregistered/);
  const restoreBranch = source.slice(source.indexOf('if [[ "$DISPATCHER_RESTORE_REQUIRED" == "1"'));
  const restoreBootout = restoreBranch.indexOf('launchctl_once bootout "$DOMAIN" dev.dona.dispatcher 30000 || dispatcher_bootout_exit=$?');
  const restoreWait = restoreBranch.indexOf("wait_dispatcher_unregistered", restoreBootout);
  assert.ok(restoreBootout >= 0 && restoreBootout < restoreWait);
  assert.doesNotMatch(restoreBranch.slice(0, restoreBootout), /launchctl print "\$DOMAIN\/dev\.dona\.dispatcher"/);
  assert.match(source, /bootstrap_dispatcher_reconciled "新しいDispatcher plistの登録"/);
  assert.match(source, /wait-launchd-unregistered/);
  const updaterRestore = source.slice(source.indexOf("restore_control_plane()"), source.indexOf("if [[ \"$MODE\" != \"--check\""));
  assert.match(updaterRestore, /launchctl_once bootout "\$DOMAIN" dev\.dona\.updater 30000[\s\S]*wait-launchd-unregistered[\s\S]*assert-socket-unused/);
  assert.match(source, /updater\.database-was-absent/);
  assert.match(source, /backup-control-db\.py/);
  assert.match(source, /PRESTOP_NONTERMINAL_COUNT/);
  assert.match(source, /stable updaterを停止しません/);
  assert.match(source, /updater\.next" -type f -exec chmod 400/);
  assert.match(source, /SELECT COUNT\(\*\) FROM update_requests WHERE state NOT IN/);
  assert.match(source, /旧stable updaterをlaunchdへ再登録できません/);
  assert.match(source, /旧stable updaterの復旧healthを確認できません/);
  assert.match(source, /bootstrap_updater_reconciled/);
  assert.match(source, /bootstrap_updater_reconciled "旧stable updaterの復旧" "\$OLD_UPDATER_SHA" legacy-health/);
  const slackBootstrap = source.slice(source.indexOf("bootstrap_slack_reconciled()"), source.indexOf("restore_control_plane()"));
  assert.match(slackBootstrap, /assert-socket-unused "\$SLACK_SOCKET"[\s\S]*launchctl_once bootstrap/);
  assert.match(source, /wait-launchd-updater-sha/);
  assert.match(source, /exact SHAの起動identityを確認しました/);
  assert.match(source, /再送せず照合が必要です/);
  assert.doesNotMatch(source, /for attempt in 1 2/);
  assert.match(source, /control-attempt-ledger\.mjs" create/);
  assert.match(source, /record_control_phase updater_stop_intent bootout_updater/);
  assert.match(source, /record_control_phase updater_start_intent bootstrap_updater/);
  assert.doesNotMatch(source, /launchctl bootstrap[^\n]*\|\| true/);
  const restoreRequired = source.indexOf("DISPATCHER_RESTORE_REQUIRED=1");
  const quiesce = source.indexOf('quiesce-dispatcher "$DISPATCHER_SOCKET"');
  const bootout = source.indexOf('launchctl_once bootout "$DOMAIN" dev.dona.dispatcher 30000', quiesce);
  const waitUnregistered = source.indexOf("wait_dispatcher_unregistered", bootout);
  const plistSwap = source.indexOf('/bin/mv "$BACKUP_ROOT/dev.dona.dispatcher.next.plist"', waitUnregistered);
  assert.ok(restoreRequired >= 0 && restoreRequired < quiesce);
  assert.ok(quiesce < bootout && bootout < waitUnregistered && waitUnregistered < plistSwap);
  assert.doesNotMatch(source, /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/u);
  const hardenedUpgradeTree = source.indexOf('find "$BACKUP_ROOT/updater.next" -type d -exec chmod 500 {} +');
  const writableUpgradeRoot = source.indexOf('chmod 700 "$BACKUP_ROOT/updater.next"');
  const upgradeRename = source.indexOf('/bin/mv "$BACKUP_ROOT/updater.next" "$CONTROL_ROOT/updater"');
  assert.ok(hardenedUpgradeTree >= 0 && hardenedUpgradeTree < writableUpgradeRoot);
  assert.ok(writableUpgradeRoot < upgradeRename);
  const writableInstallRoot = source.indexOf('chmod 700 "$CONTROL_ROOT/updater.next"');
  const installRename = source.indexOf('/bin/mv "$CONTROL_ROOT/updater.next" "$CONTROL_ROOT/updater"');
  assert.ok(writableInstallRoot >= 0 && writableInstallRoot < installRename);
  if (process.platform === "darwin") await execute("/bin/zsh", ["-n", installer]);
});

test("control receipt backup accepts only an owner-private regular file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-private-receipt-"));
  const receipt = path.join(root, "receipt.json");
  try {
    await fs.writeFile(receipt, "{}", { mode: 0o600 });
    await run("assert-private-file", receipt);
    await fs.chmod(receipt, 0o644);
    await assert.rejects(run("assert-private-file", receipt), /identity/);
    await fs.rm(receipt);
    await fs.symlink(path.join(root, "absent"), receipt);
    await assert.rejects(run("assert-private-file", receipt), /identity/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("control target preflight rejects symlink and hardlink substitution before a service write", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-control-target-"));
  const control = path.join(root, "control");
  const releases = path.join(root, "releases");
  const agents = path.join(root, "LaunchAgents");
  const backup = path.join(control, "control-backups", `${"a".repeat(40)}.ABC123`);
  const policy = path.join(control, "policy.json");
  const db = path.join(control, "updater.sqlite3");
  try {
    await Promise.all([fs.mkdir(path.join(control, "updater"), { recursive: true, mode: 0o700 }),
      fs.mkdir(releases, { mode: 0o700 }), fs.mkdir(agents, { mode: 0o700 }),
      fs.mkdir(backup, { recursive: true, mode: 0o700 })]);
    for (const dir of [control, path.join(control, "control-backups"), backup]) await fs.chmod(dir, 0o700);
    for (const file of [policy, db, path.join(agents, "dev.dona.updater.plist"),
      path.join(agents, "dev.dona.dispatcher.plist")]) await fs.writeFile(file, "x", { mode: 0o600 });
    const verify = () => run("assert-control-target-paths", control, releases, agents, backup);
    await verify();
    await fs.rm(policy);
    await fs.symlink(path.join(root, "absent"), policy);
    await assert.rejects(verify());
    await fs.rm(policy);
    await fs.writeFile(policy, "x", { mode: 0o600 });
    await fs.link(db, path.join(root, "db-hardlink"));
    await assert.rejects(verify());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("control DB backup opens and checks an independent SQLite copy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona control backup "));
  const source = path.join(root, "source.sqlite3");
  const target = path.join(root, "backup.sqlite3");
  try {
    await execute("python3", ["-c", "import sqlite3,sys,os; c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE update_requests(id TEXT PRIMARY KEY)'); c.execute(\"INSERT INTO update_requests VALUES ('one')\"); c.commit(); c.close(); os.chmod(sys.argv[1],0o600)", source]);
    await execute("python3", [controlBackup, source, target]);
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
    const { stdout } = await execute("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('SELECT COUNT(*) FROM update_requests').fetchone()[0])", target]);
    assert.equal(stdout.trim(), "1");
    await execute("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('VACUUM'); c.close()", source]);
    await execute("python3", [controlBackup, "--verify-pair", source, target]);
    await execute("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"INSERT INTO update_requests VALUES ('two')\"); c.commit(); c.close()", source]);
    await assert.rejects(execute("python3", [controlBackup, "--verify-pair", source, target]));
    await assert.rejects(execute("python3", [controlBackup, source, target]));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("old control restore rehearsal opens only a backup copy and fails closed on old binary rejection", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona control restore "));
  const oldDir = path.join(root, "old");
  const newDir = path.join(root, "new");
  const modulePath = path.join(oldDir, "dist", "database.js");
  const newModulePath = path.join(newDir, "dist", "database.js");
  const backup = path.join(root, "updater.previous.sqlite3");
  const receipt = path.join(root, "restore-rehearsal.json");
  const oldNodePlist = path.join(root, "old-updater.plist");
  const newNodePlist = path.join(root, "new-updater.plist");
  try {
    const nodeLog = path.join(root, "node-invocations.log");
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const nodePlist = (executable: string) => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>ProgramArguments</key><array><string>${executable}</string></array></dict></plist>`;
    for (const label of ["old", "new"]) {
      const wrapper = path.join(root, `${label}-node`);
      await fs.writeFile(wrapper, `#!/bin/sh\nprintf '${label}\\n' >> ${shellQuote(nodeLog)}\nexec ${shellQuote(process.execPath)} "$@"\n`, { mode: 0o700 });
      await fs.writeFile(label === "old" ? oldNodePlist : newNodePlist, nodePlist(wrapper), { mode: 0o600 });
    }
    await fs.mkdir(path.dirname(modulePath), { recursive: true });
    await fs.mkdir(path.dirname(newModulePath), { recursive: true });
    await fs.writeFile(path.join(oldDir, "package.json"), '{"type":"module"}');
    await fs.writeFile(path.join(newDir, "package.json"), '{"type":"module"}');
    await fs.writeFile(modulePath, 'import fs from "node:fs"; export class UpdateDatabase { constructor(file) { if (fs.readFileSync(file).readUInt32BE(60) !== 7) throw new Error("unreadable"); } close() {} }', { mode: 0o600 });
    await fs.writeFile(newModulePath, 'import fs from "node:fs"; export class UpdateDatabase { constructor(file) { const bytes=fs.readFileSync(file); bytes.writeUInt32BE(8,60); fs.writeFileSync(file,bytes); } close() {} }', { mode: 0o600 });
    await execute("python3", ["-c", "import sqlite3,sys,os; c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE update_requests(id TEXT PRIMARY KEY)'); c.execute(\"INSERT INTO update_requests VALUES ('one')\"); c.execute('PRAGMA user_version=7'); c.commit(); c.close(); os.chmod(sys.argv[1],0o600)", backup]);
    const original = await fs.readFile(backup);
    await execute(process.execPath, [controlRehearsal, modulePath, newModulePath, backup, receipt, oldNodePlist, newNodePlist]);
    assert.equal(await fs.readFile(nodeLog, "utf8"), "new\nold\n");
    assert.deepEqual(await fs.readFile(backup), original);
    const rehearsal = JSON.parse(await fs.readFile(receipt, "utf8"));
    assert.equal(rehearsal.old_binary_restored_backup_readable, true);
    assert.equal(rehearsal.old_schema, 7);
    assert.equal(rehearsal.new_schema, 8);
    assert.equal(rehearsal.rollback, "restore_backup_required");
    await assert.rejects(execute(process.execPath, [controlRehearsal, modulePath, newModulePath, backup, receipt, oldNodePlist, newNodePlist]));
    await fs.rm(receipt);
    await fs.writeFile(modulePath, 'export class UpdateDatabase { constructor() { throw new Error("old binary rejects backup"); } close() {} }');
    await assert.rejects(execute(process.execPath, [controlRehearsal, modulePath, newModulePath, backup, receipt, oldNodePlist, newNodePlist]));
    await assert.rejects(fs.stat(receipt), { code: "ENOENT" });
    assert.deepEqual(await fs.readFile(backup), original);
    await fs.writeFile(newModulePath, `import { execFileSync } from "node:child_process";
      export class UpdateDatabase { constructor(file) {
        execFileSync("/usr/bin/python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('DELETE FROM update_requests'); c.execute('PRAGMA user_version=8'); c.commit(); c.close()", file]);
      } close() {} }`);
    await assert.rejects(execute(process.execPath, [controlRehearsal, modulePath, newModulePath, backup, receipt, oldNodePlist, newNodePlist]));
    await assert.rejects(fs.stat(receipt), { code: "ENOENT" });
    assert.deepEqual(await fs.readFile(backup), original);
    await fs.writeFile(modulePath, 'export class UpdateDatabase { constructor() {} close() {} }');
    await fs.writeFile(newModulePath, 'export class UpdateDatabase { constructor() { throw new Error("migration failed"); } close() {} }');
    await assert.rejects(execute(process.execPath, [controlRehearsal, modulePath, newModulePath, backup, receipt, oldNodePlist, newNodePlist]));
    await assert.rejects(fs.stat(receipt), { code: "ENOENT" });
    assert.deepEqual(await fs.readFile(backup), original);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("control attempt ledger preserves exact identities and rejects duplicate or out-of-order writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-control-ledger-"));
  const oldPolicy = path.join(root, "old-policy.json");
  const newPolicy = path.join(root, "new-policy.json");
  const oldPlist = path.join(root, "old.plist");
  const newPlist = path.join(root, "new.plist");
  const oldDispatcherPlist = path.join(root, "old-dispatcher.plist");
  const newDispatcherPlist = path.join(root, "new-dispatcher.plist");
  const oldReceipt = path.join(root, "old-receipt.json");
  const backup = path.join(root, "backup.sqlite3");
  const rehearsal = path.join(root, "restore-rehearsal.json");
  const attempt = path.join(root, `${"2".repeat(40)}.ABC123`);
  const controlUpdater = path.join(root, "active-updater");
  const newUpdater = path.join(root, "release-updater");
  try {
    await fs.mkdir(attempt, { mode: 0o700 });
    await fs.mkdir(path.join(controlUpdater, "dist"), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(controlUpdater, "dist", "database.js"), "verified", { mode: 0o400 });
    await fs.chmod(path.join(controlUpdater, "dist"), 0o500);
    await fs.chmod(controlUpdater, 0o700);
    await fs.mkdir(path.join(newUpdater, "dist"), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(newUpdater, "dist", "database.js"), "verified", { mode: 0o400 });
    await fs.chmod(path.join(newUpdater, "dist"), 0o500);
    await fs.chmod(newUpdater, 0o500);
    await fs.mkdir(path.join(attempt, "updater.previous", "dist"), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(attempt, "updater.previous", "dist", "database.js"), "verified", { mode: 0o400 });
    await fs.chmod(path.join(attempt, "updater.previous", "dist"), 0o500);
    await Promise.all([fs.writeFile(oldPolicy, "old"), fs.writeFile(newPolicy, "new"),
      fs.writeFile(oldPlist, "old plist"), fs.writeFile(newPlist, "new plist"),
      fs.writeFile(oldDispatcherPlist, "old dispatcher"), fs.writeFile(newDispatcherPlist, "new dispatcher"),
      fs.writeFile(oldReceipt, "old receipt"),
      fs.writeFile(backup, "backup")]);
    await Promise.all([oldPolicy, oldPlist, oldDispatcherPlist, newDispatcherPlist, oldReceipt].map(file => fs.chmod(file, 0o600)));
    await fs.writeFile(rehearsal, "rehearsal");
    const create = () => execute(process.execPath, [controlLedger, "create", attempt,
      "1".repeat(40), "2".repeat(40), oldPolicy, newPolicy, oldPlist, newPlist, "f".repeat(64),
      controlUpdater, newUpdater, oldDispatcherPlist, newDispatcherPlist, oldReceipt]);
    const spacedCheckout = path.join(root, "checkout with spaces");
    await fs.mkdir(spacedCheckout);
    const spacedLedger = path.join(spacedCheckout, "control-attempt-ledger.mjs");
    await fs.copyFile(controlLedger, spacedLedger);
    await fs.copyFile(fileURLToPath(new URL("../../scripts/control-updater-tree.mjs", import.meta.url)),
      path.join(spacedCheckout, "control-updater-tree.mjs"));
    const spacedAttempt = path.join(root, `${"2".repeat(40)}.SPACE`);
    await fs.mkdir(spacedAttempt, { mode: 0o700 });
    await execute(process.execPath, [spacedLedger, "create", spacedAttempt,
      "1".repeat(40), "2".repeat(40), oldPolicy, newPolicy, oldPlist, newPlist, "f".repeat(64),
      controlUpdater, newUpdater, oldDispatcherPlist, newDispatcherPlist, oldReceipt]);
    assert.equal(JSON.parse(await fs.readFile(path.join(spacedAttempt, "attempt.json"), "utf8")).phase, "prepared");
    const advance = (phase: string, operation = "none", database?: string) =>
      execute(process.execPath, [controlLedger, "advance", attempt, phase, operation, ...(database ? [database] : [])]);
    await create();
    await assert.rejects(create(), /already exists/);
    await assert.rejects(advance("verified"), /out of order/);
    await advance("updater_stop_intent", "bootout_updater");
    await advance("updater_stopped");
    await execute(process.execPath, [controlLedger, "advance", attempt, "backup_verified", "none", backup, rehearsal]);
    const snapshot = JSON.parse(await fs.readFile(path.join(attempt, "attempt.json"), "utf8"));
    assert.equal(snapshot.sequence, 4);
    assert.equal(snapshot.old_build_sha, "1".repeat(40));
    assert.equal(snapshot.new_build_sha, "2".repeat(40));
    assert.equal(snapshot.release_tree_sha256, "f".repeat(64));
    assert.match(snapshot.db_backup_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(snapshot.launchd_operations, [{ sequence: 2, operation: "bootout_updater" }]);
    for (const [phase, operation] of [["dispatcher_stop_intent", "bootout_dispatcher"],
      ["dispatcher_stopped", "none"], ["dispatcher_start_intent", "bootstrap_dispatcher"],
      ["dispatcher_started", "none"], ["control_swapped", "none"],
      ["updater_start_intent", "bootstrap_updater"], ["updater_started", "none"]] as const) await advance(phase, operation);
    const verify = () => execute(process.execPath, [controlLedger, "verify", attempt, newPolicy, newPlist, newDispatcherPlist, backup, rehearsal]);
    await verify();
    await fs.writeFile(newPolicy, "tampered");
    await assert.rejects(verify(), /do not match/);
    await fs.writeFile(newPolicy, "new");
    await fs.writeFile(newDispatcherPlist, "tampered");
    await assert.rejects(verify(), /do not match/);
    await fs.writeFile(newDispatcherPlist, "new dispatcher");
    await advance("verified");
    const receiptPath = path.join(root, "control-receipt.tmp");
    const currentModule = path.join(controlUpdater, "dist", "database.js");
    await fs.chmod(path.join(controlUpdater, "dist"), 0o700);
    await fs.chmod(currentModule, 0o600);
    await fs.writeFile(currentModule, "tampered");
    await fs.chmod(currentModule, 0o400);
    await fs.chmod(path.join(controlUpdater, "dist"), 0o500);
    await assert.rejects(execute(process.execPath, [controlReceipt, attempt, receiptPath, "2".repeat(40), controlUpdater]), /verified release/);
    await fs.chmod(path.join(controlUpdater, "dist"), 0o700);
    await fs.chmod(currentModule, 0o600);
    await fs.writeFile(currentModule, "verified");
    await fs.chmod(currentModule, 0o400);
    await fs.chmod(path.join(controlUpdater, "dist"), 0o500);
    await execute(process.execPath, [controlReceipt, attempt, receiptPath, "2".repeat(40), controlUpdater]);
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    assert.equal(receipt.attempt_id, path.basename(attempt));
    assert.match(receipt.attempt_sha256, /^[0-9a-f]{64}$/);
    assert.match(receipt.restore_rehearsal_sha256, /^[0-9a-f]{64}$/);
    assert.match(receipt.control_updater_tree_sha256, /^[0-9a-f]{64}$/);
    assert.equal(receipt.control_updater_tree_sha256, snapshot.new_updater_tree_sha256);
    assert.match(receipt.old_updater_tree_sha256, /^[0-9a-f]{64}$/);
    assert.match(receipt.dispatcher_plist_sha256, /^[0-9a-f]{64}$/);
    await assert.rejects(execute(process.execPath, [controlReceipt, attempt, receiptPath, "2".repeat(40), controlUpdater]));
    await advance("restore_required");
    const restoredDb = path.join(root, "restored.sqlite3");
    await fs.copyFile(backup, restoredDb);
    await fs.copyFile(backup, path.join(attempt, "updater.previous.sqlite3"));
    await fs.copyFile(rehearsal, path.join(attempt, "restore-rehearsal.json"));
    await fs.copyFile(oldReceipt, path.join(attempt, "control-plane-receipt.previous.json"));
    await Promise.all([restoredDb, path.join(attempt, "updater.previous.sqlite3"),
      path.join(attempt, "restore-rehearsal.json"), path.join(attempt, "control-plane-receipt.previous.json")]
      .map(file => fs.chmod(file, 0o600)));
    const verifyRestore = () => execute(process.execPath, [controlLedger, "verify-restore-control", attempt,
      oldPolicy, oldPlist, controlUpdater, restoredDb, oldReceipt, "copied"]);
    await verifyRestore();
    await execute(process.execPath, [controlLedger, "verify-restore-dispatcher", attempt, oldDispatcherPlist]);
    await fs.writeFile(restoredDb, "damaged");
    await assert.rejects(verifyRestore(), /database differs/);
    await fs.copyFile(backup, restoredDb);
    await fs.chmod(restoredDb, 0o600);
    await fs.writeFile(oldReceipt, "damaged");
    await assert.rejects(verifyRestore(), /receipt differs/);
    await fs.writeFile(oldReceipt, "old receipt");
    await fs.writeFile(oldDispatcherPlist, "damaged");
    await assert.rejects(execute(process.execPath,
      [controlLedger, "verify-restore-dispatcher", attempt, oldDispatcherPlist]), /differs/);
    await fs.writeFile(oldDispatcherPlist, "old dispatcher");
    await advance("restored");
    await assert.rejects(advance("verified"), /terminal/);
    await fs.writeFile(path.join(attempt, "attempt.json.tmp"), "partial");
    await assert.rejects(advance("needs_review"), /ambiguous/);
  } finally {
    await fs.chmod(newUpdater, 0o700).catch(() => undefined);
    await fs.chmod(path.join(newUpdater, "dist"), 0o700).catch(() => undefined);
    await fs.chmod(path.join(controlUpdater, "dist"), 0o700).catch(() => undefined);
    await fs.chmod(path.join(attempt, "updater.previous", "dist"), 0o700).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("control attempt disk-full write keeps the prior state and blocks a blind retry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-control-full-"));
  const attempt = path.join(root, "attempt");
  const file = path.join(root, "identity");
  const tree = path.join(root, "updater");
  const releaseTree = path.join(root, "release-updater");
  try {
    await fs.mkdir(attempt, { mode: 0o700 });
    await fs.mkdir(tree, { mode: 0o700 });
    await fs.mkdir(releaseTree, { mode: 0o500 });
    await fs.writeFile(file, "identity", { mode: 0o600 });
    const ledger = await import(pathToFileURL(controlLedger).href) as {
      createAttempt: (...args: string[]) => void;
      advanceAttempt: (...args: unknown[]) => void;
    };
    ledger.createAttempt(attempt, "1".repeat(40), "2".repeat(40), file, file, file, file,
      "f".repeat(64), tree, releaseTree, file, file, "-");
    assert.throws(() => ledger.advanceAttempt(attempt, "updater_stop_intent", "none", undefined, undefined,
      { writeFileSync: () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } }), /disk full/);
    assert.equal(JSON.parse(await fs.readFile(path.join(attempt, "attempt.json"), "utf8")).phase, "prepared");
    await assert.rejects(execute(process.execPath,
      [controlLedger, "advance", attempt, "updater_stop_intent"]), /ambiguous/);
  } finally {
    await fs.chmod(releaseTree, 0o700).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an existing immutable release is reusable only with the exact control-plane contract", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-existing-release-"));
  const sha = "2".repeat(40);
  const existingRelease = path.join(root, sha);
  const stagedRelease = path.join(root, "staging");
  const manifestPath = path.join(existingRelease, "release-manifest.json");
  const manifest = {
    schema_version: 1,
    sha,
    repository: "hiragram/dona",
    policy_version: "2026-09-03.2",
    built_at: "2026-09-29T00:00:00Z",
    compatibility: {
      protocol: 1,
      config: 1,
      app_schema_read_min: 2,
      app_schema_read_max: 3,
      app_schema_write: 3,
      rollback_safe: true,
    },
  };
  const hardenExisting = async () => {
    await Promise.all([fs.chmod(existingRelease, 0o500), fs.chmod(path.join(existingRelease, "updater"), 0o500),
      fs.chmod(path.join(existingRelease, "updater", "dist"), 0o500),
      fs.chmod(path.join(existingRelease, "updater", "dist", "cli.js"), 0o400), fs.chmod(manifestPath, 0o400)]);
  };
  try {
    await Promise.all([
      fs.mkdir(path.join(existingRelease, "updater", "dist"), { recursive: true }),
      fs.mkdir(path.join(stagedRelease, "updater", "dist"), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(existingRelease, "updater", "dist", "cli.js"), "export {};\n"),
      fs.writeFile(path.join(stagedRelease, "updater", "dist", "cli.js"), "export {};\n"),
    ]);
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await fs.writeFile(path.join(stagedRelease, "release-manifest.json"), JSON.stringify({ ...manifest, built_at: "different" }));
    await Promise.all([fs.chmod(stagedRelease, 0o700), fs.chmod(path.join(stagedRelease, "updater"), 0o700),
      fs.chmod(path.join(stagedRelease, "updater", "dist"), 0o700),
      fs.chmod(path.join(stagedRelease, "updater", "dist", "cli.js"), 0o600),
      fs.chmod(path.join(stagedRelease, "release-manifest.json"), 0o600)]);
    await hardenExisting();
    await run("validate-existing-release", existingRelease, stagedRelease, sha);
    await fs.writeFile(path.join(stagedRelease, "release-manifest.json"), JSON.stringify({ ...manifest, compatibility: { ...manifest.compatibility, rollback_safe: false } }));
    await assert.rejects(run("validate-existing-release", existingRelease, stagedRelease, sha), /identity does not match/);
    await fs.writeFile(path.join(stagedRelease, "release-manifest.json"), JSON.stringify({ ...manifest, built_at: "different" }));
    await fs.chmod(path.join(existingRelease, "updater", "dist", "cli.js"), 0o600);
    await fs.writeFile(path.join(existingRelease, "updater", "dist", "cli.js"), "tampered\n");
    await hardenExisting();
    await assert.rejects(
      run("validate-existing-release", existingRelease, stagedRelease, sha),
      /tree does not match/,
    );
    await fs.chmod(path.join(existingRelease, "updater", "dist", "cli.js"), 0o600);
    await fs.writeFile(path.join(existingRelease, "updater", "dist", "cli.js"), "export {};\n");
    await fs.chmod(manifestPath, 0o600);
    await fs.writeFile(manifestPath, JSON.stringify({
      ...manifest,
      compatibility: { ...manifest.compatibility, app_schema_write: 2 },
    }));
    await hardenExisting();
    await assert.rejects(run("validate-existing-release", existingRelease, stagedRelease, sha), /does not match/);
    await assert.rejects(
      run("validate-existing-release", existingRelease, stagedRelease, "3".repeat(40)),
      /arguments are invalid/,
    );
    await fs.chmod(manifestPath, 0o600);
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, policy_version: "2026-09-03.1" }));
    await hardenExisting();
    await assert.rejects(run("validate-existing-release", existingRelease, stagedRelease, sha), /does not match/);
    await fs.chmod(manifestPath, 0o600);
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await hardenExisting();
    await fs.chmod(path.join(existingRelease, "updater", "dist", "cli.js"), 0o600);
    await assert.rejects(run("validate-existing-release", existingRelease, stagedRelease, sha), /mode/);
  } finally {
    await fs.chmod(existingRelease, 0o700).catch(() => undefined);
    await fs.chmod(path.join(existingRelease, "updater"), 0o700).catch(() => undefined);
    await fs.chmod(path.join(existingRelease, "updater", "dist"), 0o700).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("staging requires complete builds and matching lockfiles before immutable publication", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-staged-release-"));
  const sha = "c".repeat(40);
  const release = path.join(root, sha);
  const components = ["dispatcher", "sources/slack", "updater"];
  try {
    for (const component of components) {
      const dir = path.join(release, component);
      await fs.mkdir(path.join(dir, "dist"), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(dir, "package-lock.json"), `${component}\n`, { mode: 0o600 });
      await fs.writeFile(path.join(dir, "dist", component === "sources/slack" ? "index.js" : "cli.js"), "export {};\n", { mode: 0o600 });
      await fs.chmod(dir, 0o700);
    }
    await fs.chmod(release, 0o700);
    await fs.chmod(path.join(release, "sources"), 0o700);
    const lockHashes = Object.fromEntries(components.map(component => [component,
      createHash("sha256").update(`${component}\n`).digest("hex")]));
    const manifest = { schema_version: 1, sha, repository: "hiragram/dona", policy_version: "2026-09-03.2",
      lock_hashes: lockHashes, node_version: process.versions.node, npm_version: "11.0.0",
      built_at: new Date().toISOString(), compatibility: { protocol: 1, config: 1,
        app_schema_read_min: 2, app_schema_read_max: 3, app_schema_write: 3, rollback_safe: true } };
    await fs.writeFile(path.join(release, "release-manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    const { stdout } = await execute(process.execPath, [preflight, "validate-staged-release", release, sha]);
    const digest = stdout.trim();
    assert.match(digest, /^[0-9a-f]{64}$/);
    await fs.writeFile(path.join(release, "updater", "package-lock.json"), "different\n");
    await assert.rejects(run("validate-staged-release", release, sha), /lockfile identity/);
    await fs.writeFile(path.join(release, "updater", "package-lock.json"), "updater\n");
    await fs.rm(path.join(release, "updater", "dist", "cli.js"));
    await assert.rejects(run("validate-staged-release", release, sha), /ENOENT/);
    await fs.writeFile(path.join(release, "updater", "dist", "cli.js"), "export {};\n", { mode: 0o600 });
    for (const component of components) {
      await fs.chmod(path.join(release, component, "dist", component === "sources/slack" ? "index.js" : "cli.js"), 0o400);
      await fs.chmod(path.join(release, component, "package-lock.json"), 0o400);
      await fs.chmod(path.join(release, component, "dist"), 0o500);
      await fs.chmod(path.join(release, component), 0o500);
    }
    await fs.chmod(path.join(release, "sources"), 0o500);
    await fs.chmod(path.join(release, "release-manifest.json"), 0o400);
    await fs.chmod(release, 0o500);
    await run("validate-published-release", release, sha, digest);
    await fs.chmod(path.join(release, "updater", "dist", "cli.js"), 0o600);
    await assert.rejects(run("validate-published-release", release, sha, digest), /mode/);
  } finally {
    await fs.chmod(release, 0o700).catch(() => undefined);
    for (const component of components) {
      await fs.chmod(path.join(release, component), 0o700).catch(() => undefined);
      await fs.chmod(path.join(release, component, "dist"), 0o700).catch(() => undefined);
    }
    await fs.chmod(path.join(release, "sources"), 0o700).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("isolated npm uses separate empty config files with npm 11", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-install-npm-config-"));
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli);
  try {
    const userConfig = path.join(root, "npm-userconfig");
    const globalConfig = path.join(root, "npm-globalconfig");
    await Promise.all([fs.writeFile(userConfig, ""), fs.writeFile(globalConfig, "")]);
    const result = await execute(process.execPath, [npmCli, "--version"], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        CI: "1",
        NO_COLOR: "1",
        npm_config_cache: path.join(root, "npm-cache"),
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_userconfig: userConfig,
        npm_config_globalconfig: globalConfig,
        npm_config_update_notifier: "false",
      },
    });
    assert.match(result.stdout, /^\d+\.\d+\.\d+/);

    const installerSource = await fs.readFile(installer, "utf8");
    assert.doesNotMatch(installerSource, /npm_config_(?:user|global)config=\/dev\/null/);
    assert.match(installerSource, /npm_config_userconfig="\$INSTALL_TMP\/npm-userconfig"/);
    assert.match(installerSource, /npm_config_globalconfig="\$INSTALL_TMP\/npm-globalconfig"/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("stable updater uses separate controller-owned npm config files", async () => {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli);
  const { root, policy } = await tempPolicy();
  policy.executables.npm = npmCli;
  try {
    const result = await new CanonicalBuild(policy).toolchain();
    assert.match(result.npm_version, /^\d+\.\d+\.\d+/);
    const configDirectory = path.join(policy.control_root, "npm-config");
    const userConfig = path.join(configDirectory, "userconfig");
    const globalConfig = path.join(configDirectory, "globalconfig");
    assert.notEqual(userConfig, globalConfig);
    for (const configPath of [userConfig, globalConfig]) {
      const stats = await fs.lstat(configPath);
      assert.equal(stats.isFile(), true);
      assert.equal(stats.size, 0);
      assert.equal(stats.mode & 0o077, 0);
    }
    await fs.unlink(userConfig);
    await fs.symlink("/dev/null", userConfig);
    await assert.rejects(new CanonicalBuild(policy).toolchain(), /npm_config_file_is_not_private_and_empty/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("canonical diagnostic steps normalize the sources/slack component to an allowed identifier", () => {
  assert.equal(canonicalDiagnosticStep("sources/slack", ["ci"]), "sources.slack:npm-ci");
  assert.match(canonicalDiagnosticStep("sources/slack", ["run", "typecheck"]), /^[a-z0-9._:-]+$/);
});

test("pre-activation command errors preserve timeout diagnostics before bounded output", async () => {
  const { root, policy } = await tempPolicy();
  const result: CommandResult = {
    exit_code: null,
    stdout: `assertion failed\ntoken=secret-value\n${"x".repeat(2_000)}`,
    stderr: "control checkpoint stream",
    timed_out: true,
    output_truncated: true,
    output_checkpoint: "file=file-start test/api.test.ts; last_finish=case-finish test/api.test.ts:012345abcdef#1; timeout=test/api.test.ts:fedcba543210#1",
    exit_signal: "SIGKILL",
    cleanup_status: "term=group-sent,kill=group-sent,closed=yes",
  };
  const runner = { run: async () => result } as unknown as ProcessRunner;
  try {
    await assert.rejects(new CanonicalBuild(policy, runner).toolchain(), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /checkpoint=file=file-start test\/api\.test\.ts; last_finish=case-finish test\/api\.test\.ts:012345abcdef#1; timeout=test\/api\.test\.ts:fedcba543210#1/);
      assert.match(message, /runner=exit:null,signal:SIGKILL,cleanup:term=group-sent,kill=group-sent,closed=yes/);
      assert.match(message, /stderr=control checkpoint stream; stdout=assertion failed/);
      assert.equal(message.includes("secret-value"), false);
      assert.ok(message.length <= 1_000);
      return true;
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("failed install cleanup removes only the generated staging directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-install-cleanup-"));
  const releaseRoot = path.join(root, "releases");
  const stagingDir = path.join(releaseRoot, ".staging", "install.ABC123");
  const sibling = path.join(releaseRoot, ".staging", "keep-me");
  try {
    await Promise.all([
      fs.mkdir(stagingDir, { recursive: true }),
      fs.mkdir(sibling, { recursive: true }),
    ]);
    await Promise.all([fs.chmod(releaseRoot, 0o700), fs.chmod(path.join(releaseRoot, ".staging"), 0o700),
      fs.chmod(stagingDir, 0o700)]);
    await run("cleanup-staging", releaseRoot, stagingDir);
    await assert.rejects(fs.stat(stagingDir), { code: "ENOENT" });
    assert.equal((await fs.stat(sibling)).isDirectory(), true);
    await assert.rejects(run("cleanup-staging", releaseRoot, sibling));
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, stagingDir);
    await assert.rejects(run("cleanup-staging", releaseRoot, stagingDir));
    assert.equal((await fs.stat(outside)).isDirectory(), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("generation target validation rejects a mismatched installed updater before upgrade", async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dona-generation-target-")));
  const root = path.join(home, ".dona", "g", "a".repeat(12));
  const rendered = path.join(home, "rendered");
  const launchAgents = path.join(home, "LaunchAgents");
  const sha = "b".repeat(40);
  const plist = (label: string, program: string, environment: Record<string, string>) =>
    `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string>` +
    `<key>ProgramArguments</key><array><string>/usr/bin/node</string><string>${program}</string><string>serve</string></array>` +
    `<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${key}</key><string>${value}</string>`).join("")}</dict></dict></plist>`;
  try {
    for (const suffix of ["control/updater", "runtime/releases", `runtime/releases/${sha}`, "config", "logs", "run"]) {
      await fs.mkdir(path.join(root, suffix), { recursive: true });
    }
    await fs.mkdir(launchAgents);
    await fs.symlink(path.join(root, "runtime/releases", sha), path.join(root, "runtime/current"));
    await fs.writeFile(path.join(root, "control/updater.sqlite3"), "fixture");
    await fs.writeFile(path.join(root, "control/policy.json"), JSON.stringify({
      control_root: path.join(root, "control"), config_root: path.join(root, "config"),
      release_root: path.join(root, "runtime/releases"), current_pointer: path.join(root, "runtime/current"),
      dispatcher_socket: path.join(root, "run/d.sock"), slack_socket: path.join(root, "run/s.sock"),
      dispatcher_internal_token_file: path.join(root, "control/dispatcher.token"),
    }));
    await fs.writeFile(path.join(launchAgents, "dev.dona.updater.plist"), plist("dev.dona.updater", path.join(root, "control/updater/dist/cli.js"), {
      DONA_UPDATE_POLICY_PATH: path.join(root, "control/policy.json"), DONA_UPDATER_BUILD_SHA: sha,
    }));
    await fs.writeFile(path.join(launchAgents, "dev.dona.dispatcher.plist"), plist("dev.dona.dispatcher", path.join(root, "runtime/current/dispatcher/dist/cli.js"), {
      DONA_UPDATER_SOCKET_PATH: path.join(root, "control/updater.sock"),
      DONA_UPDATE_INTERNAL_TOKEN_PATH: path.join(root, "control/dispatcher.token"),
      DONA_SOCKET_PATH: path.join(root, "run/d.sock"), SLACK_HEALTH_SOCKET_PATH: path.join(root, "run/s.sock"),
      DONA_DATABASE_PATH: path.join(root, "dona.sqlite3"),
      DONA_RELEASE_MANIFEST_PATH: path.join(root, "runtime/current/release-manifest.json"),
      DONA_RESULTS_DIR: path.join(root, "results"),
      DONA_JOB_RESULTS_DIR: path.join(root, "job-results"),
      DONA_JOB_PROGRESS_DATABASE_PATH: path.join(root, "job-progress.sqlite3"),
      DONA_UPDATE_NOTIFICATION_DATABASE_PATH: path.join(root, "update-notifications.sqlite3"),
      DOTENV_CONFIG_PATH: path.join(root, "config/dispatcher.env"),
      GENERATION_ONLY: "preserved",
    }));
    await fs.writeFile(path.join(launchAgents, "dev.dona.slack-adapter.plist"), plist("dev.dona.slack-adapter", path.join(root, "runtime/current/sources/slack/dist/index.js"), {
      DONA_SOCKET_PATH: path.join(root, "run/d.sock"),
      SLACK_HEALTH_SOCKET_PATH: path.join(root, "run/s.sock"),
      DOTENV_CONFIG_PATH: path.join(root, "config/slack.env"),
      DONA_UPDATE_INTERNAL_TOKEN_PATH: path.join(root, "control/dispatcher.token"),
      DONA_RELEASE_MANIFEST_PATH: path.join(root, "runtime/current/release-manifest.json"),
    }).replace("<string>serve</string>", ""));
    const testBin = path.join(home, "bin");
    await fs.mkdir(testBin);
    for (const name of ["herdr", "codex"]) {
      await fs.writeFile(path.join(testBin, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    }
    await execute(process.execPath, [fileURLToPath(new URL("../../scripts/render-self-update-templates.mjs", import.meta.url)), rendered, sha, root, "generation"], {
      env: { ...process.env, PATH: `${testBin}:${process.env.PATH}` },
    });
    const helper = fileURLToPath(new URL("../../scripts/validate-generation-install-target.py", import.meta.url));
    const renderedDispatcher = path.join(rendered, "dev.dona.dispatcher.plist");
    const beforeStage = await fs.readFile(renderedDispatcher);
    await execute("/usr/bin/python3", [helper, root, rendered, launchAgents, "--stage-recovery"], { env: { ...process.env, HOME: home } });
    assert.deepEqual(await fs.readFile(renderedDispatcher), beforeStage);
    await execute("/usr/bin/python3", [helper, root, rendered, launchAgents, "--upgrade-control"], { env: { ...process.env, HOME: home } });
    const updated = await fs.readFile(path.join(rendered, "dev.dona.dispatcher.plist"), "utf8");
    assert.match(updated, /GENERATION_ONLY/);
    const receipt = path.join(root, "control/control-plane-receipt.json");
    await fs.mkdir(receipt);
    await assert.rejects(execute("/usr/bin/python3", [helper, root, rendered, launchAgents, "--stage-recovery"], { env: { ...process.env, HOME: home } }));
    await fs.rmdir(receipt);
    const dispatcherPlist = path.join(launchAgents, "dev.dona.dispatcher.plist");
    const originalDispatcher = await fs.readFile(dispatcherPlist, "utf8");
    await fs.writeFile(dispatcherPlist, originalDispatcher.replace(path.join(root, "job-results"), path.join(home, "other/job-results")));
    await assert.rejects(execute("/usr/bin/python3", [helper, root, rendered, launchAgents, "--stage-recovery"], { env: { ...process.env, HOME: home } }));
    await fs.writeFile(dispatcherPlist, originalDispatcher);
    const slackPlist = path.join(launchAgents, "dev.dona.slack-adapter.plist");
    const originalSlack = await fs.readFile(slackPlist, "utf8");
    await fs.writeFile(slackPlist, originalSlack.replace(path.join(root, "control/dispatcher.token"), path.join(home, "other/dispatcher.token")));
    await assert.rejects(execute("/usr/bin/python3", [helper, root, rendered, launchAgents, "--stage-recovery"], { env: { ...process.env, HOME: home } }));
    await fs.writeFile(slackPlist, originalSlack);
    await fs.writeFile(path.join(launchAgents, "dev.dona.updater.plist"), plist("dev.dona.updater", path.join(home, "other/updater/dist/cli.js"), {
      DONA_UPDATE_POLICY_PATH: path.join(root, "control/policy.json"), DONA_UPDATER_BUILD_SHA: sha,
    }));
    await assert.rejects(execute("/usr/bin/python3", [helper, root, rendered, launchAgents, "--stage-recovery"], { env: { ...process.env, HOME: home } }));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
