import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { removeTree, tempPolicy } from "./helpers.js";

const entrypoint = fileURLToPath(new URL("../src/release-permissions.ts", import.meta.url));
function finalize(root: string) {
  return spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), entrypoint, root], {
    timeout: 5000, maxBuffer: 1024, encoding: "utf8", shell: false,
  });
}

test("初期installが使う共通CLIでもclockだけ実行可能なimmutable treeを作る", async t => {
  const { root } = await tempPolicy();
  t.after(() => removeTree(root));
  const release = path.join(root, "release");
  const helper = path.join(release, "dispatcher", "dist", "native", "security-clock");
  await fs.mkdir(path.dirname(helper), { recursive: true, mode: 0o700 });
  await fs.writeFile(helper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await fs.writeFile(path.join(release, "normal"), "fixture", { mode: 0o700 });
  const result = finalize(release);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await fs.stat(helper)).mode & 0o777, 0o500);
  assert.equal((await fs.stat(path.join(release, "normal"))).mode & 0o777, 0o400);
  assert.equal((await fs.stat(release)).mode & 0o777, 0o500);
  assert.equal(spawnSync(helper, [], { timeout: 2000, maxBuffer: 1024, env: {}, shell: false }).status, 0);
  assert.equal(finalize(release).status, 0);
});

test("共通CLIはhelperの祖先symlinkと非実行fileを変更前に拒否する", async t => {
  for (const fault of ["ancestor_symlink", "non_executable"] as const) {
    const { root } = await tempPolicy();
    t.after(() => removeTree(root));
    const release = path.join(root, "release");
    await fs.mkdir(release, { mode: 0o700 });
    const normal = path.join(release, "normal");
    await fs.writeFile(normal, "fixture", { mode: 0o600 });
    if (fault === "ancestor_symlink") {
      const outside = path.join(root, "outside");
      await fs.mkdir(outside, { mode: 0o700 });
      await fs.symlink(outside, path.join(release, "dispatcher"));
    } else {
      const helper = path.join(release, "dispatcher", "dist", "native", "security-clock");
      await fs.mkdir(path.dirname(helper), { recursive: true, mode: 0o700 });
      await fs.writeFile(helper, "fixture", { mode: 0o600 });
    }
    const result = finalize(release);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "release_permissions_failed\n");
    assert.equal((await fs.stat(normal)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(release)).mode & 0o777, 0o700);
  }
});
