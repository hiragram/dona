#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { controlUpdaterTreeDigest } from "./control-updater-tree.mjs";
import { releaseTreeDigest } from "./self-update-install-preflight.mjs";

const names = ["dev.dona.updater.plist", "dev.dona.dispatcher.plist", "dev.dona.slack-adapter.plist"];
const verifierNames = ["bootstrap-install-contract.mjs", "control-updater-tree.mjs", "self-update-install-preflight.mjs"];
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
  const expectedUpdater = controlUpdaterTreeDigest(path.join(releaseRoot, sha, "updater"), 0o500);
  if (digests.control_updater_tree !== expectedUpdater) {
    throw new Error("installed Updater differs from the immutable release");
  }
  for (const name of names) {
    const nodePath = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :ProgramArguments:0", path.join(agentsRoot, name)],
      { encoding: "utf8", timeout: 5000 }).trim();
    if (!path.isAbsolute(nodePath)) throw new Error("installed Node path is invalid");
    digests[`node:${name}`] = createHash("sha256").update(await fs.readFile(nodePath)).digest("hex");
  }
  digests.release_tree = await releaseTreeDigest(path.join(releaseRoot, sha), true);
  for (const name of verifierNames) {
    digests[`verifier:${name}`] = createHash("sha256").update(
      await privateFile(path.join(releaseRoot, sha, "scripts", name))).digest("hex");
  }
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

export async function verifyBootstrapTargets(controlRoot, agentsRoot, releaseRoot, sha) {
  await verifyInstallContract(controlRoot, agentsRoot, releaseRoot, sha);
  const runtimeRoot = path.dirname(releaseRoot);
  await privateDirectory(runtimeRoot);
  const current = path.join(runtimeRoot, "current");
  const pointer = await fs.lstat(current);
  if (!pointer.isSymbolicLink() || pointer.uid !== process.getuid() ||
      await fs.readlink(current) !== `releases/${sha}` ||
      await fs.realpath(current) !== await fs.realpath(path.join(releaseRoot, sha))) {
    throw new Error("current pointer differs from the verified release");
  }
  const manifest = JSON.parse((await privateFile(path.join(releaseRoot, sha, "release-manifest.json"))).toString("utf8"));
  if (manifest.sha !== sha || typeof manifest.node_version !== "string") {
    throw new Error("release toolchain identity is invalid");
  }
  for (const name of names) {
    const plist = path.join(agentsRoot, name);
    const nodePath = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :ProgramArguments:0", plist],
      { encoding: "utf8", timeout: 5000 }).trim();
    if (!path.isAbsolute(nodePath) || !nodePath.startsWith("/")) throw new Error("installed Node path is invalid");
    const version = execFileSync(nodePath, ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
    if (version !== `v${manifest.node_version}`) throw new Error("installed Node differs from the build toolchain");
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
    else if (mode === "bootstrap-verify") await verifyBootstrapTargets(controlRoot, agentsRoot, releaseRoot, sha);
    else throw new Error("install contract mode is invalid");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
