import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { CanonicalBuild } from "../src/adapters.js";
import { tempPolicy } from "./helpers.js";

const execute = promisify(execFile);
const preflight = fileURLToPath(new URL("../../scripts/self-update-install-preflight.mjs", import.meta.url));
const installer = fileURLToPath(new URL("../../scripts/install-self-update.sh", import.meta.url));

async function run(mode: string, ...values: string[]): Promise<void> {
  await execute(process.execPath, [preflight, mode, ...values]);
}

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

test("macOS keeps a hardened staged updater renamable by reopening only its root", {
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
    await assert.rejects(execute("/bin/mv", [staged, destination]), /Permission denied/);

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
  assert.match(source, /--upgrade-control/);
  assert.match(source, /assert-control-upgrade-safe/);
  assert.match(source, /wait-updater-sha/);
  assert.match(source, /updater\.previous\.sqlite3/);
  assert.match(source, /updater\.database-was-absent/);
  assert.match(source, /PRAGMA integrity_check/);
  assert.match(source, /PRESTOP_NONTERMINAL_COUNT/);
  assert.match(source, /stable updaterを停止しません/);
  assert.match(source, /updater\.next" -type f -exec chmod 400/);
  assert.match(source, /SELECT COUNT\(\*\) FROM update_requests WHERE state NOT IN/);
  assert.match(source, /旧stable updaterをlaunchdへ再登録できません/);
  assert.match(source, /旧stable updaterの復旧healthを確認できません/);
  assert.match(source, /bootstrap_updater_reconciled/);
  assert.match(source, /DONA_UPDATER_BUILD_SHA => \$\{expected_sha\}/);
  assert.match(source, /exact SHAの登録済み状態を確認しました/);
  assert.match(source, /expected SHAの未登録状態を確認しました/);
  assert.doesNotMatch(source, /launchctl bootstrap[^\n]*\|\| true/);
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
    compatibility: {
      protocol: 1,
      config: 1,
      app_schema_read_min: 2,
      app_schema_read_max: 3,
      app_schema_write: 3,
      rollback_safe: true,
    },
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
    await run("validate-existing-release", existingRelease, stagedRelease, sha);
    await fs.writeFile(path.join(existingRelease, "updater", "dist", "cli.js"), "tampered\n");
    await assert.rejects(
      run("validate-existing-release", existingRelease, stagedRelease, sha),
      /tree does not match/,
    );
    await fs.writeFile(path.join(existingRelease, "updater", "dist", "cli.js"), "export {};\n");
    await fs.writeFile(manifestPath, JSON.stringify({
      ...manifest,
      compatibility: { ...manifest.compatibility, app_schema_write: 2 },
    }));
    await assert.rejects(run("validate-existing-release", existingRelease, stagedRelease, sha), /does not match/);
    await assert.rejects(
      run("validate-existing-release", existingRelease, stagedRelease, "3".repeat(40)),
      /arguments are invalid/,
    );
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, policy_version: "2026-09-03.1" }));
    await assert.rejects(run("validate-existing-release", existingRelease, stagedRelease, sha), /does not match/);
  } finally {
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
    await run("cleanup-staging", releaseRoot, stagingDir);
    await assert.rejects(fs.stat(stagingDir), { code: "ENOENT" });
    assert.equal((await fs.stat(sibling)).isDirectory(), true);
    await assert.rejects(run("cleanup-staging", releaseRoot, sibling));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
