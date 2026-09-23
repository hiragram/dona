import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, "dist/native");
const source = path.join(root, "src/native/file-identity.c");
const include = path.join(root, "node_modules/better-sqlite3/deps/sqlite3");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (!["darwin", "linux"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) {
  throw new Error("sqlite_identity_platform_unsupported");
}
const target = path.join(directory, "file-identity" + (process.platform === "darwin" ? ".dylib" : ".so"));
const manifestPath = path.join(directory, "file-identity.json");
const inputs = { version: 1, platform: process.platform, arch: process.arch,
  source: hash(fs.readFileSync(source)),
  headers: hash(Buffer.concat([fs.readFileSync(path.join(include, "sqlite3.h")), fs.readFileSync(path.join(include, "sqlite3ext.h"))])) };
let current = false;
try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  current = JSON.stringify(manifest.inputs) === JSON.stringify(inputs) && hash(fs.readFileSync(target)) === manifest.binary;
} catch { /* A missing or stale build is rebuilt before tests or packaging. */ }
if (!current) {
  fs.mkdirSync(directory, { recursive: true });
  const temporary = target + "." + randomUUID();
  const manifestTemporary = manifestPath + "." + randomUUID();
  try {
    const flags = process.platform === "darwin"
      ? ["-dynamiclib", "-arch", process.arch === "x64" ? "x86_64" : "arm64"] : ["-shared", "-fPIC"];
    const result = spawnSync("/usr/bin/cc", [...flags, "-O2", "-Wall", "-Wextra", "-Werror", "-I", include, source, "-o", temporary],
      { shell: false, encoding: "utf8", timeout: 30000, maxBuffer: 8192 });
    if (result.error || result.status !== 0) throw new Error("sqlite_identity_build_failed");
    const manifest = { inputs, binary: hash(fs.readFileSync(temporary)) };
    fs.writeFileSync(manifestTemporary, JSON.stringify(manifest) + "\n", { flag: "wx" });
    fs.renameSync(temporary, target);
    fs.renameSync(manifestTemporary, manifestPath);
  } finally {
    fs.rmSync(temporary, { force: true }); fs.rmSync(manifestTemporary, { force: true });
  }
}
