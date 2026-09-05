#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [releaseRoot, sha, npmVersion, policyVersion] = process.argv.slice(2);
if (!releaseRoot || !path.isAbsolute(releaseRoot) || !/^[0-9a-f]{40}$/.test(sha ?? "") || !npmVersion || !policyVersion) {
  throw new Error("Usage: write-release-manifest.mjs <release-root> <sha> <npm-version> <policy-version>");
}
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const compatibilityFile = JSON.parse(fs.readFileSync(path.join(releaseRoot, "config", "release-compatibility.json"), "utf8"));
if (compatibilityFile.schema_version !== 1) throw new Error("Unsupported release compatibility schema");
// 非rollback migrationの承認・復元経路をintegrationで実装するまでreleaseを生成しない。
if (compatibilityFile.rollback_safe !== true) {
  throw new Error("non_rollback_migration_requires_release_workflow");
}
const { schema_version: _compatibilitySchema, ...compatibility } = compatibilityFile;
const manifest = {
  schema_version: 1,
  sha,
  repository: "hiragram/dona",
  policy_version: policyVersion,
  lock_hashes: {
    dispatcher: hash(path.join(releaseRoot, "dispatcher", "package-lock.json")),
    "sources/slack": hash(path.join(releaseRoot, "sources", "slack", "package-lock.json")),
    updater: hash(path.join(releaseRoot, "updater", "package-lock.json")),
  },
  node_version: process.versions.node,
  npm_version: npmVersion,
  built_at: new Date().toISOString(),
  compatibility,
};
const target = path.join(releaseRoot, "release-manifest.json");
const temporary = path.join(releaseRoot, `.release-manifest.${process.pid}.tmp`);
const descriptor = fs.openSync(temporary, "wx", 0o600);
try {
  fs.writeFileSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.fsyncSync(descriptor);
} finally {
  fs.closeSync(descriptor);
}
fs.renameSync(temporary, target);
const directory = fs.openSync(releaseRoot, "r");
try {
  fs.fsyncSync(directory);
} finally {
  fs.closeSync(directory);
}
