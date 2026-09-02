import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const preflight = fileURLToPath(new URL("../../scripts/self-update-install-preflight.mjs", import.meta.url));
const installer = fileURLToPath(new URL("../../scripts/install-self-update.sh", import.meta.url));

async function run(mode: string, value: string): Promise<void> {
  await execute(process.execPath, [preflight, mode, value]);
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

test("installer prints option-prefixed usage text without treating it as a zsh print option", async () => {
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
