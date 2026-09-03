#!/usr/bin/env node

import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { createHash } from "node:crypto";

const canonicalRemote = "https://github.com/hiragram/dona.git";

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
  await fs.rm(stagingDir, { recursive: true, force: true });
}

function udsJson(socketPath, route, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: route, method: "GET" }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (response.statusCode !== 200) throw new Error(`HTTP ${response.statusCode}`);
          resolve(body);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("request timed out")));
    request.once("error", reject);
    request.end();
  });
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

async function releaseTreeDigest(root) {
  const rootStats = await fs.lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error("release comparison root is invalid");
  const hash = createHash("sha256");
  const visit = async (directory, relativeDirectory = "") => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = path.join(relativeDirectory, entry.name);
      if (relativeDirectory === "" && [".git", "release-manifest.json"].includes(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      const stats = await fs.lstat(fullPath);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        hash.update(`d\0${relative}\0`);
        await visit(fullPath, relative);
      } else if (stats.isFile() && !stats.isSymbolicLink()) {
        hash.update(`f\0${relative}\0`);
        hash.update(await fs.readFile(fullPath));
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

export async function validateExistingRelease(existingRelease, stagedRelease, expectedSha) {
  if (!path.isAbsolute(existingRelease) || !path.isAbsolute(stagedRelease) ||
    !/^[0-9a-f]{40}$/.test(expectedSha) || path.basename(existingRelease) !== expectedSha) {
    throw new Error("existing release validation arguments are invalid");
  }
  const manifest = JSON.parse(await fs.readFile(path.join(existingRelease, "release-manifest.json"), "utf8"));
  const compatibility = manifest?.compatibility;
  if (manifest?.schema_version !== 1 || manifest.sha !== expectedSha ||
    manifest.repository !== "hiragram/dona" || manifest.policy_version !== "2026-09-03.2" ||
    compatibility?.protocol !== 1 || compatibility?.config !== 1 ||
    compatibility?.app_schema_read_min !== 2 || compatibility?.app_schema_read_max !== 2 ||
    compatibility?.app_schema_write !== 2 || compatibility?.rollback_safe !== true) {
    throw new Error("existing release manifest does not match the control-plane contract");
  }
  const [existingDigest, stagedDigest] = await Promise.all([
    releaseTreeDigest(existingRelease),
    releaseTreeDigest(stagedRelease),
  ]);
  if (existingDigest !== stagedDigest) {
    throw new Error("existing release tree does not match the freshly verified staging tree");
  }
}

export async function assertSlackMetadataSchemaAttested(environmentPath) {
  if (!path.isAbsolute(environmentPath)) throw new Error("Slack environment path must be absolute");
  const lines = (await fs.readFile(environmentPath, "utf8")).split(/\r?\n/);
  const declarations = lines.filter((line) =>
    /^\s*SLACK_UPDATE_METADATA_SCHEMA_REGISTERED\s*=/.test(line) && !/^\s*#/.test(line),
  );
  if (declarations.length !== 1 ||
    !/^\s*SLACK_UPDATE_METADATA_SCHEMA_REGISTERED\s*=\s*(?:true|"true"|'true')\s*(?:#.*)?$/i.test(declarations[0])) {
    throw new Error("Slack update metadata schema registration and read scope are not explicitly attested");
  }
}

async function main() {
  const [mode, value, secondValue] = process.argv.slice(2);
  if (!value) {
    console.error(
      "Usage: self-update-install-preflight.mjs validate-remote <remote> | assert-socket-unused <socket> | cleanup-staging <release-root> <staging-dir> | assert-control-upgrade-safe <socket> | wait-updater-sha <socket> <sha> <timeout-ms> [update-schema] | validate-existing-release <release> <staging> <sha> | assert-slack-metadata-attested <environment-file>",
    );
    return 2;
  }
  if (mode === "validate-remote") return normalizeCanonicalRemote(value) ? 0 : 1;
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
  if (mode === "validate-existing-release" && secondValue && process.argv[5]) {
    try {
      await validateExistingRelease(value, secondValue, process.argv[5]);
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (mode === "assert-slack-metadata-attested") {
    try {
      await assertSlackMetadataSchemaAttested(value);
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
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) process.exitCode = await main();
