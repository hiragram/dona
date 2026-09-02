import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
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
    await assert.rejects(run("assert-socket-unused", socketPath), /npm run dev/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
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
