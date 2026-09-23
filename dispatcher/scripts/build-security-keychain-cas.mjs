import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

// Internal library only: no executable frontend or credential provisioning.
// A future native broker must authenticate callers before using this library.
if (process.platform === "darwin") {
  if (!["arm64", "x64"].includes(process.arch)) throw Error("security_keychain_platform_unsupported");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const source = path.join(root, "src/native/security-keychain-cas.m"), directory = path.join(root, "dist/native");
  const header = path.join(root, "src/native/security-keychain-cas.h");
  const target = path.join(directory, "libsecurity-keychain-cas.dylib"), manifestPath = path.join(directory, "libsecurity-keychain-cas.json");
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const inputs = { codec_version: 1, platform: process.platform, arch: process.arch, source: hash(fs.readFileSync(source)), header: hash(fs.readFileSync(header)) };
  let current = false;
  try {
    const metadata = JSON.parse(fs.readFileSync(manifestPath, "utf8")), info = fs.lstatSync(target);
    current = JSON.stringify(metadata) === JSON.stringify({ ...inputs, binary: hash(fs.readFileSync(target)) })
      && info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (info.mode & 0o022) === 0 && (info.mode & 0o111) === 0;
  } catch { /* An absent or stale build is rebuilt before tests/packaging. */ }
  if (!current) {
    fs.mkdirSync(directory, { recursive: true });
    const temporary = target + "." + randomUUID(), manifestTemporary = manifestPath + "." + randomUUID();
    try {
      const result = spawnSync("/usr/bin/cc", ["-arch", process.arch === "x64" ? "x86_64" : "arm64", "-dynamiclib", "-install_name", "@rpath/libsecurity-keychain-cas.dylib", "-fobjc-arc", "-O2", "-Wall", "-Wextra", "-Werror",
        "-framework", "Foundation", "-framework", "Security", "-framework", "LocalAuthentication", source, "-o", temporary],
      { shell: false, encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 30000, killSignal: "SIGKILL", maxBuffer: 8192 });
      if (result.error || result.status !== 0 || result.signal !== null) throw Error("security_keychain_build_failed");
      fs.chmodSync(temporary, 0o644);
      fs.writeFileSync(manifestTemporary, JSON.stringify({ ...inputs, binary: hash(fs.readFileSync(temporary)) }) + "\n", { flag: "wx", mode: 0o644 });
      fs.renameSync(temporary, target); fs.renameSync(manifestTemporary, manifestPath);
    } finally { fs.rmSync(temporary, { force: true }); fs.rmSync(manifestTemporary, { force: true }); }
  }
}
