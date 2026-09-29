#!/usr/bin/env node

import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { promisify } from "node:util";

const canonicalRemote = "https://github.com/hiragram/dona.git";
const execute = promisify(execFile);

export function normalizeCanonicalRemote(remote) {
  if (/^git@github\.com:hiragram\/dona(?:\.git)?$/.test(remote)) return canonicalRemote;

  let parsed;
  try {
    parsed = new URL(remote);
  } catch {
    return undefined;
  }

  const validProtocolAndIdentity =
    (parsed.protocol === "https:" && parsed.username === "") ||
    (parsed.protocol === "ssh:" && parsed.username === "git");
  if (
    !validProtocolAndIdentity ||
    parsed.password !== "" ||
    parsed.hostname !== "github.com" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !/^\/hiragram\/dona(?:\.git)?$/.test(parsed.pathname)
  ) {
    return undefined;
  }
  return canonicalRemote;
}

export async function assertPrivateFile(file) {
  if (!path.isAbsolute(file)) throw new Error("private file path is invalid");
  const stats = await fs.lstat(file);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== process.getuid() ||
      stats.nlink !== 1 || (stats.mode & 0o077) !== 0) {
    throw new Error("private file identity is invalid");
  }
}

export async function assertControlTargetPaths(controlRoot, releaseRoot, launchAgentsDir, backupRoot) {
  if (![controlRoot, releaseRoot, launchAgentsDir, backupRoot].every(path.isAbsolute) ||
      path.dirname(backupRoot) !== path.join(controlRoot, "control-backups")) {
    throw new Error("control target paths are invalid");
  }
  for (const directory of [controlRoot, releaseRoot, launchAgentsDir, path.dirname(backupRoot), backupRoot]) {
    const stats = await fs.lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== process.getuid() ||
        (stats.mode & 0o022) !== 0 ||
        (directory !== launchAgentsDir && (stats.mode & 0o077) !== 0)) {
      throw new Error("control target directory identity is invalid");
    }
  }
  const realControlRoot = await fs.realpath(controlRoot);
  const realBackup = await fs.realpath(backupRoot);
  if (!realBackup.startsWith(`${realControlRoot}${path.sep}`)) {
    throw new Error("control backup escaped its root");
  }
  const updater = await fs.lstat(path.join(controlRoot, "updater"));
  if (!updater.isDirectory() || updater.isSymbolicLink() || updater.uid !== process.getuid() ||
      (updater.mode & 0o077) !== 0) throw new Error("stable updater identity is invalid");
  for (const file of [path.join(controlRoot, "policy.json"), path.join(controlRoot, "updater.sqlite3"),
    path.join(launchAgentsDir, "dev.dona.updater.plist"), path.join(launchAgentsDir, "dev.dona.dispatcher.plist")]) {
    await assertPrivateFile(file);
  }
}

export function socketIsListening(socketPath, timeoutMs = 500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (listening) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

export async function cleanupInstallStaging(releaseRoot, stagingDir) {
  const stagingRoot = path.join(releaseRoot, ".staging");
  if (
    !path.isAbsolute(releaseRoot) ||
    path.dirname(stagingDir) !== stagingRoot ||
    !/^install\.[A-Za-z0-9]+$/.test(path.basename(stagingDir))
  ) {
    throw new Error("Refusing to clean an invalid staging directory");
  }
  for (const directory of [releaseRoot, stagingRoot, stagingDir]) {
    const stats = await fs.lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== process.getuid() ||
      (stats.mode & 0o077) !== 0) throw new Error("Refusing to clean an unsafe staging directory");
  }
  await fs.rm(stagingDir, { recursive: true, force: true });
}

function udsJson(socketPath, route, timeoutMs = 2_000, method="GET", body) {
  return new Promise((resolve, reject) => {
    const encoded=body===undefined?undefined:Buffer.from(JSON.stringify(body));
    const request = http.request({ socketPath, path: route, method, headers:encoded?{"content-type":"application/json","content-length":String(encoded.length)}:undefined }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (response.statusCode !== 200 && response.statusCode !== 202) throw new Error(`HTTP ${response.statusCode}`);
          resolve(body);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("request timed out")));
    request.once("error", reject);
    request.end(encoded);
  });
}

export async function quiesceDispatcherForControlUpgrade(socketPath,targetSha,timeoutMs=30_000) {
  if(!/^[0-9a-f]{40}$/.test(targetSha)||!Number.isSafeInteger(timeoutMs)||timeoutMs<=0)throw new Error("dispatcher quiesce arguments are invalid");
  const operationId="upd_01m1es03xy5cf8d9pm5cwx4srv";
  let snapshot=await udsJson(socketPath,"/v1/admin/quiesce",2_000,"POST",{schema_version:1,protocol:1,operation_id:operationId,target_sha:targetSha});
  const deadline=Date.now()+timeoutMs;
  while(snapshot?.drained!==true&&Date.now()<deadline) {
    await new Promise(resolve=>setTimeout(resolve,100));
    snapshot=await udsJson(socketPath,"/v1/admin/drain-status",2_000);
  }
  if(snapshot?.service!=="dispatcher"||snapshot?.quiescing!==true||snapshot?.drained!==true||snapshot?.in_flight!==0||!Array.isArray(snapshot?.unsafe_states)||snapshot.unsafe_states.length!==0)throw new Error("dispatcher did not reach a safe drain barrier");
}

export async function assertControlUpgradeSafe(socketPath) {
  const [health, status] = await Promise.all([
    udsJson(socketPath, "/health/version"),
    udsJson(socketPath, "/v1/status"),
  ]);
  if (health.status !== "ready" || health.service !== "updater" ||
    typeof health.build_sha !== "string" || !/^[0-9a-f]{40}$/.test(health.build_sha)) {
    throw new Error("stable updater health is not exact");
  }
  const terminal = new Set(["succeeded", "failed", "rolled_back", "needs_review", "cancelled"]);
  if (!Array.isArray(status.updates) || status.updates.some((update) =>
    !update || typeof update !== "object" || !terminal.has(update.state)) ||
    (status.nonterminal_count !== undefined && status.nonterminal_count !== 0)) {
    throw new Error("an active self-update prevents control-plane upgrade");
  }
  return health.build_sha;
}

export async function waitForUpdaterSha(socketPath, expectedSha, timeoutMs, expectedUpdateSchema) {
  if (!/^[0-9a-f]{40}$/.test(expectedSha) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
    (expectedUpdateSchema !== undefined && (!Number.isSafeInteger(expectedUpdateSchema) || expectedUpdateSchema < 1))) {
    throw new Error("wait-updater-sha arguments are invalid");
  }
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const health = await udsJson(socketPath, "/health/version", Math.min(2_000, timeoutMs));
      if (health.status === "ready" && health.service === "updater" && health.build_sha === expectedSha &&
        (expectedUpdateSchema === undefined || health.update_schema === expectedUpdateSchema)) return;
    } catch {
      // launchd activation and UDS publication are observed until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`updater ${expectedSha} was not observed ready`);
}

export async function waitForUpdaterIdentity(socketPath, expectedSha, domain, timeoutMs, options = {}) {
  if (!path.isAbsolute(socketPath) || !/^[0-9a-f]{40}$/.test(expectedSha) ||
      !/^gui\/[1-9][0-9]*$/.test(domain) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("wait-updater-identity arguments are invalid");
  }
  const healthRead = options.healthRead ?? (() => udsJson(socketPath, "/health/version"));
  const registrationRead = options.registrationRead ?? (async () =>
    (await execute("/bin/launchctl", ["print", `${domain}/dev.dona.updater`],
      { timeout: 2_000, killSignal: "SIGKILL" })).stdout);
  const processStartRead = options.processStartRead ?? (async (pid) =>
    (await execute("/bin/ps", ["-p", String(pid), "-o", "lstart="],
      { timeout: 2_000, killSignal: "SIGKILL" })).stdout.trim());
  const lockRead = options.lockRead ?? (async () => {
    const lockPath = path.join(path.dirname(socketPath), "updater.start.lock");
    await assertPrivateFile(lockPath);
    return JSON.parse(await fs.readFile(lockPath, "utf8"));
  });
  const deadline = Date.now() + timeoutMs;
  do {
    let health;
    try { health = await healthRead(); }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
    if (health?.status !== "ready" || health.service !== "updater" || health.build_sha !== expectedSha) {
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    const legacyHealth = options.allowLegacyHealth === true &&
      health.pid === undefined && health.process_start === undefined;
    if (!legacyHealth && (!Number.isSafeInteger(health.pid) || health.pid <= 0 ||
        typeof health.process_start !== "string" || !health.process_start)) {
      throw new Error("updater health process identity is invalid");
    }
    let lock, registration, observedStart;
    try {
      [lock, registration] = await Promise.all([lockRead(), registrationRead()]);
      observedStart = await processStartRead(legacyHealth ? lock.pid : health.pid);
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    const registrationSha = registration.match(/DONA_UPDATER_BUILD_SHA => ([0-9a-f]{40})/)?.[1];
    const registrationPid = Number(registration.match(/\bpid = ([0-9]+)/)?.[1]);
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0 ||
        typeof lock.process_start !== "string" || !lock.process_start ||
        (!legacyHealth && (lock.pid !== health.pid || lock.process_start !== health.process_start)) ||
        observedStart !== lock.process_start || registrationSha !== expectedSha ||
        registrationPid !== lock.pid) {
      throw new Error("updater socket, PID, start identity, and launchd registration disagree");
    }
    return;
  } while (Date.now() < deadline);
  throw new Error("updater process identity was not observed before timeout");
}

export async function waitForDispatcherSha(socketPath, expectedSha, domain, timeoutMs, options = {}) {
  if (!path.isAbsolute(socketPath) || !/^[0-9a-f]{40}$/.test(expectedSha) ||
      !/^gui\/[1-9][0-9]*$/.test(domain) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("wait-dispatcher-sha arguments are invalid");
  }
  const healthRead = options.healthRead ?? (() => udsJson(socketPath, "/health/version", 2_000));
  const registrationRead = options.registrationRead ?? (async () =>
    (await execute("/bin/launchctl", ["print", `${domain}/dev.dona.dispatcher`],
      { timeout: 2_000, killSignal: "SIGKILL" })).stdout);
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const [health, registration] = await Promise.all([healthRead(), registrationRead()]);
      const registeredPid = Number(registration.match(/\bpid = ([0-9]+)/)?.[1]);
      if (health?.status === "ready" && health.service === "dispatcher" &&
          health.build_sha === expectedSha && Number.isSafeInteger(registeredPid) && registeredPid > 0) return;
    } catch { /* launchd activation and UDS publication are observed until the bounded deadline. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`dispatcher ${expectedSha} was not observed under its fixed launchd label`);
}

export async function waitForSlackSha(socketPath, expectedSha, domain, timeoutMs, options = {}) {
  if (!path.isAbsolute(socketPath) || !/^[0-9a-f]{40}$/.test(expectedSha) ||
      !/^gui\/[1-9][0-9]*$/.test(domain) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("wait-slack-sha arguments are invalid");
  }
  const observe = options.observe ?? observeLaunchdRegistration;
  const healthRead = options.healthRead ?? (() => udsJson(socketPath, "/health/version", 2_000));
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let matches = 0;
  do {
    const remaining = Math.max(1, deadline - now());
    const registered = await observeBeforeDeadline(observe, `${domain}/dev.dona.slack-adapter`, remaining);
    let ready = false;
    try {
      const health = await healthRead();
      ready = health?.schema_version === 1 && health.status === "ready" &&
        health.service === "slack_adapter" && health.build_sha === expectedSha;
    } catch { /* Socket publication may follow launchd registration. */ }
    matches = registered && ready ? matches + 1 : 0;
    if (matches >= 3) return;
    await sleep(100);
  } while (now() < deadline);
  throw new Error("Slack Adapter registration and exact SHA health were not observed");
}

async function observeLaunchdRegistration(serviceTarget, timeoutMs) {
  try {
    await execute("/bin/launchctl", ["print", serviceTarget], { timeout: timeoutMs, killSignal: "SIGKILL" });
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === 113) return false;
    if (error && typeof error === "object" && error.killed === true) {
      throw new Error("launchd registration observation timed out");
    }
    const exitCode = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
    throw new Error(`launchd registration observation failed with exit ${exitCode}`);
  }
}

async function observeBeforeDeadline(observe, serviceTarget, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      observe(serviceTarget, timeoutMs),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("launchd registration observation timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForLaunchdServiceAbsent(domain,label,timeoutMs,options={}) {
  if(!/^gui\/[1-9][0-9]*$/.test(domain)||!/^dev\.dona\.(?:dispatcher|updater|slack-adapter)$/.test(label)||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<=0)throw new Error("wait-launchd-unregistered arguments are invalid");
  const observe=options.observe??observeLaunchdRegistration;
  const sleep=options.sleep??((milliseconds)=>new Promise(resolve=>setTimeout(resolve,milliseconds)));
  const now=options.now??Date.now;
  const intervalMs=options.intervalMs??100;
  const settledObservations=options.settledObservations??3;
  if(!Number.isSafeInteger(intervalMs)||intervalMs<=0||!Number.isSafeInteger(settledObservations)||settledObservations<2) {
    throw new Error("wait-launchd-unregistered observation policy is invalid");
  }
  const serviceTarget=`${domain}/${label}`;
  const deadline=now()+timeoutMs;
  let absentObservations=0;
  do {
    const remainingMs=Math.max(1,deadline-now());
    if(await observeBeforeDeadline(observe,serviceTarget,remainingMs)) absentObservations=0;
    else if(++absentObservations>=settledObservations)return;
    await sleep(intervalMs);
  } while(now()<deadline);
  throw new Error(`${label} remained registered after bootout timeout`);
}

export async function waitForLaunchdUpdaterSha(domain, expectedSha, timeoutMs, options = {}) {
  if (!/^gui\/[1-9][0-9]*$/.test(domain) || !/^[0-9a-f]{40}$/.test(expectedSha) ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("wait-launchd-updater-sha arguments are invalid");
  const observe = options.observe ?? (async (target, remainingMs) => {
    try {
      const result = await execute("/bin/launchctl", ["print", target], { timeout: remainingMs, killSignal: "SIGKILL" });
      return result.stdout;
    } catch (error) {
      if (error && typeof error === "object" && error.code === 113) return null;
      throw new Error("launchd updater registration observation failed");
    }
  });
  const sleep = options.sleep ?? ((milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let matches = 0;
  do {
    const output = await observeBeforeDeadline(observe, `${domain}/dev.dona.updater`, Math.max(1, deadline - now()));
    if (output !== null && typeof output !== "string") throw new Error("launchd updater registration is invalid");
    const observedSha = output?.match(/DONA_UPDATER_BUILD_SHA => ([0-9a-f]{40})/)?.[1];
    if (observedSha && observedSha !== expectedSha) throw new Error("a different updater SHA is registered");
    matches = observedSha === expectedSha ? matches + 1 : 0;
    if (matches >= 3) return;
    await sleep(100);
  } while (now() < deadline);
  throw new Error("updater registration could not be reconciled to the exact SHA");
}

export async function launchctlOnce(operation, domain, target, timeoutMs, options = {}) {
  if (!/^gui\/[1-9][0-9]*$/.test(domain) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
      !["bootout", "bootstrap"].includes(operation)) throw new Error("launchctl operation arguments are invalid");
  let arguments_;
  if (operation === "bootout" &&
      ["dev.dona.updater", "dev.dona.dispatcher", "dev.dona.slack-adapter"].includes(target)) {
    arguments_ = ["bootout", `${domain}/${target}`];
  } else if (operation === "bootstrap" &&
      ["dev.dona.updater.plist", "dev.dona.dispatcher.plist", "dev.dona.slack-adapter.plist"].includes(path.basename(target)) &&
      path.dirname(target) === path.join(process.env.HOME ?? "", "Library", "LaunchAgents")) {
    arguments_ = ["bootstrap", domain, target];
  } else {
    throw new Error("launchctl target is invalid");
  }
  const run = options.run ?? ((args) => execute("/bin/launchctl", args,
    { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }));
  await run(arguments_);
}

async function releaseTreeDigest(root, immutable = false) {
  const rootStats = await fs.lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error("release comparison root is invalid");
  if (rootStats.uid !== process.getuid() || (rootStats.mode & 0o077) !== 0 ||
    (immutable && (rootStats.mode & 0o777) !== 0o500)) throw new Error("release comparison root ownership or mode is invalid");
  const hash = createHash("sha256");
  const visit = async (directory, relativeDirectory = "") => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = path.join(relativeDirectory, entry.name);
      if (relativeDirectory === "" && entry.name === ".git") continue;
      const fullPath = path.join(directory, entry.name);
      const stats = await fs.lstat(fullPath);
      if (stats.uid !== process.getuid() || (!stats.isSymbolicLink() && (stats.mode & 0o077) !== 0) ||
        (immutable && ((stats.isDirectory() && (stats.mode & 0o777) !== 0o500) ||
          (stats.isFile() && (stats.mode & 0o777) !== 0o400))) ||
        (stats.isFile() && stats.nlink !== 1)) {
        throw new Error("release comparison ownership, mode, or hardlink is invalid");
      }
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        hash.update(`d\0${relative}\0`);
        await visit(fullPath, relative);
      } else if (stats.isFile() && !stats.isSymbolicLink()) {
        hash.update(`f\0${relative}\0`);
        if (relative === "release-manifest.json") {
          const manifest = JSON.parse(await fs.readFile(fullPath, "utf8"));
          if (typeof manifest.built_at !== "string") throw new Error("release manifest identity is invalid");
          hash.update(JSON.stringify({ ...manifest, built_at: null }));
        } else hash.update(await fs.readFile(fullPath));
        hash.update("\0");
      } else if (stats.isSymbolicLink()) {
        const resolved = await fs.realpath(fullPath);
        const fromRoot = path.relative(root, resolved);
        if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
          throw new Error("release comparison encountered an escaping symlink");
        }
        hash.update(`l\0${relative}\0${await fs.readlink(fullPath)}\0`);
      } else {
        throw new Error("release comparison encountered an unsupported file type");
      }
    }
  };
  await visit(root);
  return hash.digest("hex");
}

export async function validateStagedRelease(stagingPath, expectedSha) {
  if (!path.isAbsolute(stagingPath) || !/^[0-9a-f]{40}$/.test(expectedSha)) {
    throw new Error("staged release validation arguments are invalid");
  }
  const manifestPath = path.join(stagingPath, "release-manifest.json");
  const manifestStats = await fs.lstat(manifestPath);
  if (!manifestStats.isFile() || manifestStats.isSymbolicLink() || manifestStats.uid !== process.getuid() ||
      manifestStats.nlink !== 1 || (manifestStats.mode & 0o077) !== 0) {
    throw new Error("staged release manifest is invalid");
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const expectedManifestKeys = ["schema_version", "sha", "repository", "policy_version", "lock_hashes", "node_version", "npm_version", "built_at", "compatibility"];
  if (!isDeepStrictEqual(Object.keys(manifest).sort(), expectedManifestKeys.sort()) ||
      !isDeepStrictEqual(Object.keys(manifest.lock_hashes ?? {}).sort(), ["dispatcher", "sources/slack", "updater"].sort()) ||
      typeof manifest.built_at !== "string" || Number.isNaN(Date.parse(manifest.built_at))) {
    throw new Error("staged release manifest shape is invalid");
  }
  if (manifest.schema_version !== 1 || manifest.sha !== expectedSha || manifest.repository !== "hiragram/dona" ||
      manifest.policy_version !== "2026-09-03.2" || manifest.node_version !== process.versions.node ||
      typeof manifest.npm_version !== "string" || !/^\d+\.\d+\.\d+/.test(manifest.npm_version) ||
      !manifest.lock_hashes || typeof manifest.lock_hashes !== "object" ||
      manifest.compatibility?.protocol !== 1 || manifest.compatibility?.config !== 1 ||
      manifest.compatibility?.app_schema_read_min !== 2 || manifest.compatibility?.app_schema_read_max !== 3 ||
      manifest.compatibility?.app_schema_write !== 3 || manifest.compatibility?.rollback_safe !== true) {
    throw new Error("staged release manifest contract is invalid");
  }
  for (const [component, relative] of [["dispatcher", "dispatcher"], ["sources/slack", "sources/slack"], ["updater", "updater"]]) {
    const lock = await fs.readFile(path.join(stagingPath, relative, "package-lock.json"));
    if (manifest.lock_hashes[component] !== createHash("sha256").update(lock).digest("hex")) {
      throw new Error("staged release lockfile identity is invalid");
    }
  }
  for (const relative of ["dispatcher/dist/cli.js", "sources/slack/dist/index.js", "updater/dist/cli.js"]) {
    const stats = await fs.lstat(path.join(stagingPath, relative));
    if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== process.getuid() || stats.nlink !== 1) {
      throw new Error("staged release build is incomplete");
    }
  }
  return releaseTreeDigest(stagingPath);
}

export async function validatePublishedRelease(releasePath, expectedSha, expectedDigest) {
  if (path.basename(releasePath) !== expectedSha || !/^[0-9a-f]{64}$/.test(expectedDigest ?? "")) {
    throw new Error("published release validation arguments are invalid");
  }
  await validateStagedRelease(releasePath, expectedSha);
  const digest = await releaseTreeDigest(releasePath, true);
  if (digest !== expectedDigest) throw new Error("published release differs from completed staging");
}

export async function validateExistingRelease(existingRelease, stagedRelease, expectedSha) {
  if (!path.isAbsolute(existingRelease) || !path.isAbsolute(stagedRelease) ||
    !/^[0-9a-f]{40}$/.test(expectedSha) || path.basename(existingRelease) !== expectedSha) {
    throw new Error("existing release validation arguments are invalid");
  }
  const existingManifestPath = path.join(existingRelease, "release-manifest.json");
  const stagedManifestPath = path.join(stagedRelease, "release-manifest.json");
  for (const [file, immutable] of [[existingManifestPath, true], [stagedManifestPath, false]]) {
    const stats = await fs.lstat(file);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== process.getuid() || stats.nlink !== 1 ||
      (stats.mode & 0o077) !== 0 || (immutable && (stats.mode & 0o777) !== 0o400)) {
      throw new Error("release manifest ownership, mode, or hardlink is invalid");
    }
  }
  const manifest = JSON.parse(await fs.readFile(existingManifestPath, "utf8"));
  const stagedManifest = JSON.parse(await fs.readFile(stagedManifestPath, "utf8"));
  const compatibility = manifest?.compatibility;
  if (manifest?.schema_version !== 1 || manifest.sha !== expectedSha ||
    manifest.repository !== "hiragram/dona" || manifest.policy_version !== "2026-09-03.2" ||
    compatibility?.protocol !== 1 || compatibility?.config !== 1 ||
    compatibility?.app_schema_read_min !== 2 || compatibility?.app_schema_read_max !== 3 ||
    compatibility?.app_schema_write !== 3 || compatibility?.rollback_safe !== true) {
    throw new Error("existing release manifest does not match the control-plane contract");
  }
  const identity = ({ built_at: _builtAt, ...rest }) => rest;
  if (!isDeepStrictEqual(identity(manifest), identity(stagedManifest))) {
    throw new Error("existing release identity does not match the freshly verified staging manifest");
  }
  const [existingDigest, stagedDigest] = await Promise.all([
    releaseTreeDigest(existingRelease, true),
    releaseTreeDigest(stagedRelease),
  ]);
  if (existingDigest !== stagedDigest) {
    throw new Error("existing release tree does not match the freshly verified staging tree");
  }
}

async function main() {
  const [mode, value, secondValue] = process.argv.slice(2);
  if (!value) {
    console.error(
      "Usage: self-update-install-preflight.mjs validate-remote <remote> | assert-socket-unused <socket> | cleanup-staging <release-root> <staging-dir> | assert-control-upgrade-safe <socket> | quiesce-dispatcher <socket> <sha> | wait-launchd-unregistered <domain> <label> <timeout-ms> | wait-dispatcher-sha <socket> <sha> <timeout-ms> | wait-updater-sha <socket> <sha> <timeout-ms> [update-schema] | validate-existing-release <release> <staging> <sha>",
    );
    return 2;
  }
  if (mode === "validate-remote") return normalizeCanonicalRemote(value) ? 0 : 1;
  if (mode === "assert-private-file") {
    try { await assertPrivateFile(value); return 0; }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
  }
  if (mode === "assert-control-target-paths" && secondValue && process.argv[5] && process.argv[6]) {
    try { await assertControlTargetPaths(value, secondValue, process.argv[5], process.argv[6]); return 0; }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
  }
  if (mode === "launchctl-once" && secondValue && process.argv[5] && process.argv[6]) {
    try { await launchctlOnce(value, secondValue, process.argv[5], Number(process.argv[6])); return 0; }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
  }
  if (mode === "validate-staged-release" && secondValue) {
    try { console.log(await validateStagedRelease(value, secondValue)); return 0; }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
  }
  if (mode === "validate-published-release" && secondValue && process.argv[5]) {
    try { await validatePublishedRelease(value, secondValue, process.argv[5]); return 0; }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
  }
  if (mode === "assert-socket-unused") {
    if (await socketIsListening(value)) {
      console.error("指定したsocketでprocessが応答中です。管理対象processの停止状態を確認してください。");
      return 1;
    }
    return 0;
  }
  if (mode === "cleanup-staging" && secondValue) {
    try {
      await cleanupInstallStaging(value, secondValue);
      return 0;
    } catch {
      console.error("staging directory cleanup targetが不正です。");
      return 1;
    }
  }
  if (mode === "assert-control-upgrade-safe") {
    try {
      console.log(await assertControlUpgradeSafe(value));
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if(mode==="quiesce-dispatcher"&&secondValue) {
    try { await quiesceDispatcherForControlUpgrade(value,secondValue); return 0; }
    catch(error) { console.error(error instanceof Error?error.message:String(error)); return 1; }
  }
  if(mode==="wait-launchd-unregistered"&&secondValue&&process.argv[5]) {
    try { await waitForLaunchdServiceAbsent(value,secondValue,Number(process.argv[5])); return 0; }
    catch(error) { console.error(error instanceof Error?error.message:String(error)); return 1; }
  }
  if (mode === "wait-launchd-updater-sha" && secondValue && process.argv[5]) {
    try { await waitForLaunchdUpdaterSha(value, secondValue, Number(process.argv[5])); return 0; }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
  }
  if (mode === "wait-updater-sha" && secondValue && process.argv[5]) {
    try {
      await waitForUpdaterSha(
        value,
        secondValue,
        Number(process.argv[5]),
        process.argv[6] === undefined ? undefined : Number(process.argv[6]),
      );
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (mode === "wait-updater-identity" && secondValue && process.argv[5] && process.argv[6]) {
    try {
      if (process.argv[7] !== undefined && process.argv[7] !== "legacy-health") throw new Error("wait-updater-identity mode is invalid");
      await waitForUpdaterIdentity(value, secondValue, process.argv[5], Number(process.argv[6]),
        { allowLegacyHealth: process.argv[7] === "legacy-health" });
      return 0;
    }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
  }
  if(mode==="wait-dispatcher-sha"&&secondValue&&process.argv[5]&&process.argv[6]) {
    try { await waitForDispatcherSha(value,secondValue,process.argv[5],Number(process.argv[6])); return 0; }
    catch(error) { console.error(error instanceof Error?error.message:String(error)); return 1; }
  }
  if (mode === "wait-slack-sha" && secondValue && process.argv[5] && process.argv[6]) {
    try { await waitForSlackSha(value, secondValue, process.argv[5], Number(process.argv[6])); return 0; }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
  }
  if (mode === "validate-existing-release" && secondValue && process.argv[5]) {
    try {
      await validateExistingRelease(value, secondValue, process.argv[5]);
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  console.error("Unknown preflight mode");
  return 2;
}

const invokedPath = process.argv[1];
if (invokedPath && await fs.realpath(invokedPath) === await fs.realpath(fileURLToPath(import.meta.url))) process.exitCode = await main();
