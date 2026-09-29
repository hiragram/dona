#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { controlUpdaterTreeDigest } from "./control-updater-tree.mjs";
import { releaseTreeDigest } from "./self-update-install-preflight.mjs";

const names = ["dev.dona.updater.plist", "dev.dona.dispatcher.plist", "dev.dona.slack-adapter.plist"];
const contractName = "bootstrap-install-contract.json";

async function privateDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new Error("install directory path is invalid");
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
      (stat.mode & 0o022) !== 0) throw new Error("install directory identity is invalid");
}

async function privateFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
      stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw new Error("install file identity is invalid");
  return await fs.readFile(file);
}

async function installedDigests(controlRoot, agentsRoot, releaseRoot, sha) {
  await privateDirectory(controlRoot);
  await privateDirectory(agentsRoot);
  const files = { "policy.json": path.join(controlRoot, "policy.json") };
  for (const name of names) files[name] = path.join(agentsRoot, name);
  const digests = {};
  for (const [name, file] of Object.entries(files)) {
    digests[name] = createHash("sha256").update(await privateFile(file)).digest("hex");
  }
  digests.control_updater_tree = controlUpdaterTreeDigest(path.join(controlRoot, "updater"));
  digests.release_tree = await releaseTreeDigest(path.join(releaseRoot, sha), true);
  return digests;
}

async function expectedInstallDigests(controlRoot, agentsRoot, releaseRoot, sha, renderedRoot, stagedRoot) {
  const installed = await installedDigests(controlRoot, agentsRoot, releaseRoot, sha);
  const renderedFiles = { "policy.json": path.join(renderedRoot, "policy.json") };
  for (const name of names) renderedFiles[name] = path.join(renderedRoot, name);
  for (const [name, file] of Object.entries(renderedFiles)) {
    const expected = createHash("sha256").update(await privateFile(file)).digest("hex");
    if (installed[name] !== expected) throw new Error("installed file differs from the trusted render");
  }
  const expectedRelease = await releaseTreeDigest(stagedRoot);
  if (installed.release_tree !== expectedRelease ||
      installed.control_updater_tree !== controlUpdaterTreeDigest(path.join(releaseRoot, sha, "updater"), 0o500)) {
    throw new Error("installed tree differs from the trusted build");
  }
  return installed;
}

export async function recoverInstallContract(controlRoot, agentsRoot, releaseRoot, sha, renderedRoot, stagedRoot) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("install SHA is invalid");
  const target = path.join(controlRoot, contractName);
  const temp = path.join(controlRoot, `.${contractName}.tmp`);
  try { await fs.lstat(target); throw new Error("install contract already exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await expectedInstallDigests(controlRoot, agentsRoot, releaseRoot, sha, renderedRoot, stagedRoot);
  try {
    await privateFile(temp);
    await fs.unlink(temp);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await recordInstallContract(controlRoot, agentsRoot, releaseRoot, sha);
}

export async function recordInstallContract(controlRoot, agentsRoot, releaseRoot, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("install SHA is invalid");
  const digests = await installedDigests(controlRoot, agentsRoot, releaseRoot, sha);
  const target = path.join(controlRoot, contractName);
  const temp = path.join(controlRoot, `.${contractName}.tmp`);
  // A second install must never silently replace the contract for a running generation.
  try { await fs.lstat(target); throw new Error("install contract already exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ schema_version: 1, sha, digests })}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  await fs.rename(temp, target);
  const directory = await fs.open(controlRoot, "r");
  try { await directory.sync(); } finally { await directory.close(); }
  await verifyInstallContract(controlRoot, agentsRoot, releaseRoot, sha);
}

export async function verifyInstallContract(controlRoot, agentsRoot, releaseRoot, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("install SHA is invalid");
  await privateDirectory(controlRoot);
  const contract = JSON.parse((await privateFile(path.join(controlRoot, contractName))).toString("utf8"));
  const digests = await installedDigests(controlRoot, agentsRoot, releaseRoot, sha);
  if (contract.schema_version !== 1 || contract.sha !== sha ||
      JSON.stringify(contract.digests) !== JSON.stringify(digests)) {
    throw new Error("installed files differ from the install-time contract");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , mode, controlRoot, agentsRoot, releaseRoot, sha, renderedRoot, stagedRoot] = process.argv;
  try {
    if (mode === "recover" && process.argv.length === 9) {
      await recoverInstallContract(controlRoot, agentsRoot, releaseRoot, sha, renderedRoot, stagedRoot);
    } else if (process.argv.length !== 7) throw new Error("install contract arguments are invalid");
    else if (mode === "record") await recordInstallContract(controlRoot, agentsRoot, releaseRoot, sha);
    else if (mode === "verify") await verifyInstallContract(controlRoot, agentsRoot, releaseRoot, sha);
    else throw new Error("install contract mode is invalid");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
