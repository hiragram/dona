import fs from "node:fs/promises";
import path from "node:path";

import type { UpdatePolicy } from "./policy.js";
import type { ActivationReceipt, ReleaseManifest, UpdateRow } from "./types.js";
import { canonicalJson, fullSha, parseReleaseManifest } from "./validation.js";

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function writeAtomic(filePath: string, body: string, mode = 0o600): Promise<void> {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  const handle = await fs.open(temporary, "wx", mode);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, filePath);
  await fsyncDirectory(path.dirname(filePath));
}

export class ReleaseStore {
  constructor(private readonly policy: UpdatePolicy) {}

  async preflight(): Promise<{ free_bytes: number; disk_floor_bytes: number; same_filesystem: true }> {
    const [releaseStats, pointerParentStats, filesystem] = await Promise.all([
      fs.stat(this.policy.release_root),
      fs.stat(path.dirname(this.policy.current_pointer)),
      fs.statfs(this.policy.release_root),
    ]);
    if (!releaseStats.isDirectory() || releaseStats.uid !== process.getuid?.() || (releaseStats.mode & 0o022) !== 0) {
      throw new Error("release_root_owner_or_permissions_invalid");
    }
    if (releaseStats.dev !== pointerParentStats.dev) throw new Error("release_pointer_cross_filesystem");
    const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    if (freeBytes < this.policy.disk_floor_bytes) throw new Error("disk_floor_not_met");
    return { free_bytes: freeBytes, disk_floor_bytes: this.policy.disk_floor_bytes, same_filesystem: true };
  }

  async readCurrentManifest(): Promise<ReleaseManifest> {
    return this.readPointerManifest(this.policy.current_pointer, true) as Promise<ReleaseManifest>;
  }

  async readPreviousManifest(): Promise<ReleaseManifest | null> {
    return this.readPointerManifest(this.policy.previous_pointer, false);
  }

  async releaseManifest(sha: string): Promise<ReleaseManifest | null> {
    fullSha(sha);
    const releasePath = path.join(this.policy.release_root, sha);
    try {
      await this.validateReleasePath(releasePath, sha);
      return await this.readManifest(releasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async prepareStaging(requestId: string, fence: number): Promise<string> {
    await this.ensureRoots();
    const stats = await fs.statfs(this.policy.release_root);
    const free = Number(stats.bavail) * Number(stats.bsize);
    if (free < this.policy.disk_floor_bytes) throw new Error("disk_floor_not_met");
    const stagingRoot = path.join(this.policy.release_root, ".staging");
    await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(stagingRoot, 0o700);
    const destination = path.join(stagingRoot, `${requestId}-${fence}`);
    await this.assertGeneratedPath(stagingRoot, destination);
    await fs.mkdir(destination, { mode: 0o700 });
    await fsyncDirectory(stagingRoot);
    return destination;
  }

  async publish(stagingPath: string, manifest: ReleaseManifest): Promise<string> {
    fullSha(manifest.sha, "manifest.sha");
    const stagingRoot = path.join(this.policy.release_root, ".staging");
    await this.assertGeneratedPath(stagingRoot, stagingPath);
    await this.scanTree(stagingPath, stagingPath);
    const releasePath = path.join(this.policy.release_root, manifest.sha);
    await this.assertGeneratedPath(this.policy.release_root, releasePath);
    const stageDevice = (await fs.stat(stagingPath)).dev;
    const releaseDevice = (await fs.stat(this.policy.release_root)).dev;
    if (stageDevice !== releaseDevice) throw new Error("cross_filesystem_release_publish");
    await writeAtomic(path.join(stagingPath, "release-manifest.json"), `${canonicalJson(manifest)}\n`);
    await this.scanTree(stagingPath, stagingPath);
    try {
      await fs.rename(stagingPath, releasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
      const existing = await this.readManifest(releasePath);
      if (existing.sha !== manifest.sha || canonicalJson(existing) !== canonicalJson(manifest)) {
        throw new Error("immutable_release_collision");
      }
      await this.removeGeneratedTree(stagingRoot, stagingPath);
    }
    await this.makeImmutable(releasePath);
    await fsyncDirectory(this.policy.release_root);
    return releasePath;
  }

  async activate(request: UpdateRow, releasePath: string): Promise<ActivationReceipt> {
    const target = await this.validateReleasePath(releasePath, request.target_sha);
    const current = await this.resolvePointer(this.policy.current_pointer, true);
    if (!current || path.basename(current) !== request.current_sha) throw new Error("current_pointer_cas_mismatch");
    await this.atomicPointer(this.policy.previous_pointer, current);
    await this.atomicPointer(this.policy.current_pointer, target);
    const receipt: ActivationReceipt = {
      schema_version: 1,
      request_id: request.request_id,
      fence: request.fence,
      generation: request.activation_generation + 1,
      from_sha: request.current_sha,
      to_sha: request.target_sha,
      pointer_switched_at: new Date().toISOString(),
    };
    await this.writeReceipt(receipt);
    return receipt;
  }

  async rollback(request: UpdateRow): Promise<ActivationReceipt> {
    const current = await this.resolvePointer(this.policy.current_pointer, true);
    const previous = await this.resolvePointer(this.policy.previous_pointer, true);
    if (!current || !previous || path.basename(current) !== request.target_sha || path.basename(previous) !== request.current_sha) {
      throw new Error("rollback_pointer_cas_mismatch");
    }
    // Switch current first. A crash between the two renames leaves both pointers on
    // the known-good release, while the target remains recoverable by its exact SHA.
    await this.atomicPointer(this.policy.current_pointer, previous);
    await this.atomicPointer(this.policy.previous_pointer, current);
    const receipt: ActivationReceipt = {
      schema_version: 1,
      request_id: request.request_id,
      fence: request.fence,
      generation: request.activation_generation + 1,
      from_sha: request.target_sha,
      to_sha: request.current_sha,
      pointer_switched_at: new Date().toISOString(),
    };
    await this.writeReceipt(receipt);
    return receipt;
  }

  async observe(): Promise<{ current_sha: string | null; previous_sha: string | null; receipt: ActivationReceipt | null }> {
    const [current, previous] = await Promise.all([
      this.resolvePointer(this.policy.current_pointer, false),
      this.resolvePointer(this.policy.previous_pointer, false),
    ]);
    let receipt: ActivationReceipt | null = null;
    try {
      const body = await fs.readFile(path.join(this.policy.control_root, "activation-receipt.json"), "utf8");
      receipt = JSON.parse(body) as ActivationReceipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {
      current_sha: current ? path.basename(current) : null,
      previous_sha: previous ? path.basename(previous) : null,
      receipt,
    };
  }

  async cleanupPlan(protectedShas: ReadonlySet<string>): Promise<string[]> {
    await this.ensureRoots();
    const candidates: Array<{ sha: string; mtime: number }> = [];
    for (const name of await fs.readdir(this.policy.release_root)) {
      if (!/^[0-9a-f]{40}$/.test(name) || protectedShas.has(name)) continue;
      const releasePath = path.join(this.policy.release_root, name);
      await this.validateReleasePath(releasePath, name);
      candidates.push({ sha: name, mtime: (await fs.stat(releasePath)).mtimeMs });
    }
    candidates.sort((left, right) => right.mtime - left.mtime);
    return candidates.slice(this.policy.retain_successful).map(({ sha }) => sha);
  }

  async cleanup(protectedShas: ReadonlySet<string>): Promise<string[]> {
    const planned = await this.cleanupPlan(protectedShas);
    for (const sha of planned) {
      const releasePath = path.join(this.policy.release_root, sha);
      await this.validateReleasePath(releasePath, sha);
      await this.makeMutableForRemoval(releasePath);
      await this.removeGeneratedTree(this.policy.release_root, releasePath);
    }
    return planned;
  }

  private async ensureRoots(): Promise<void> {
    await fs.mkdir(this.policy.control_root, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.policy.release_root, { recursive: true, mode: 0o700 });
    await fs.chmod(this.policy.control_root, 0o700);
    await fs.chmod(this.policy.release_root, 0o700);
    if ((await fs.stat(this.policy.control_root)).dev === (await fs.stat(this.policy.release_root)).dev) {
      // Separate directories are intentional; sharing a filesystem is safe and simplifies durable rename.
    }
  }

  private async readPointerManifest(pointer: string, required: boolean): Promise<ReleaseManifest | null> {
    const resolved = await this.resolvePointer(pointer, required);
    return resolved ? this.readManifest(resolved) : null;
  }

  private async resolvePointer(pointer: string, required: boolean): Promise<string | null> {
    try {
      const stats = await fs.lstat(pointer);
      if (!stats.isSymbolicLink()) throw new Error(`${path.basename(pointer)} pointer is not a symlink`);
      const resolved = await fs.realpath(pointer);
      return this.validateReleasePath(resolved);
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async readManifest(releasePath: string): Promise<ReleaseManifest> {
    const manifestPath = path.join(releasePath, "release-manifest.json");
    const stats = await fs.lstat(manifestPath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("release manifest is not a regular file");
    const manifest = parseReleaseManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")));
    if (path.basename(releasePath) !== manifest.sha) throw new Error("release manifest SHA does not match its directory");
    return manifest;
  }

  private async validateReleasePath(releasePath: string, expectedSha?: string): Promise<string> {
    const realRoot = await fs.realpath(this.policy.release_root);
    const realRelease = await fs.realpath(releasePath);
    if (!inside(realRoot, realRelease) || !/^[0-9a-f]{40}$/.test(path.basename(realRelease))) {
      throw new Error("release_path_escape");
    }
    if (expectedSha && path.basename(realRelease) !== expectedSha) throw new Error("release_sha_mismatch");
    const stats = await fs.lstat(realRelease);
    if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== process.getuid?.()) throw new Error("release_owner_or_type_invalid");
    if ((stats.mode & 0o022) !== 0) throw new Error("release_permissions_invalid");
    return realRelease;
  }

  private async assertGeneratedPath(root: string, candidate: string): Promise<void> {
    const normalizedRoot = path.resolve(root);
    const normalizedCandidate = path.resolve(candidate);
    if (!inside(normalizedRoot, normalizedCandidate) || path.dirname(normalizedCandidate) !== normalizedRoot) {
      throw new Error("generated_path_escape");
    }
  }

  private async scanTree(root: string, current: string): Promise<void> {
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) {
      const resolved = await fs.realpath(current);
      const realRoot = await fs.realpath(root);
      if (!inside(realRoot, resolved)) throw new Error("staging_symlink_escape");
      return;
    }
    if (stats.uid !== process.getuid?.() || (stats.mode & 0o022) !== 0 || stats.nlink > (stats.isDirectory() ? 2 + (await fs.readdir(current)).length : 1)) {
      throw new Error("staging_owner_permissions_or_hardlink_invalid");
    }
    if (!stats.isDirectory()) return;
    for (const child of await fs.readdir(current)) await this.scanTree(root, path.join(current, child));
  }

  private async makeImmutable(current: string): Promise<void> {
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) return;
    if (stats.isDirectory()) {
      for (const child of await fs.readdir(current)) await this.makeImmutable(path.join(current, child));
      await fs.chmod(current, 0o500);
    } else if (stats.isFile()) {
      await fs.chmod(current, 0o400);
    }
  }

  private async atomicPointer(pointer: string, target: string): Promise<void> {
    await this.validateReleasePath(target);
    const parent = path.dirname(pointer);
    if ((await fs.stat(parent)).dev !== (await fs.stat(target)).dev) throw new Error("cross_filesystem_pointer_switch");
    const temporary = path.join(parent, `.${path.basename(pointer)}.${process.pid}.tmp`);
    try {
      await fs.unlink(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const realParent = await fs.realpath(parent);
    await fs.symlink(path.relative(realParent, target), temporary, "dir");
    await fs.rename(temporary, pointer);
    await fsyncDirectory(parent);
  }

  private async writeReceipt(receipt: ActivationReceipt): Promise<void> {
    await fs.mkdir(this.policy.control_root, { recursive: true, mode: 0o700 });
    await writeAtomic(path.join(this.policy.control_root, "activation-receipt.json"), `${canonicalJson(receipt)}\n`);
  }

  private async removeGeneratedTree(root: string, target: string): Promise<void> {
    await this.assertGeneratedPath(root, target);
    const stats = await fs.lstat(target);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("cleanup_target_invalid");
    await fs.chmod(target, 0o700);
    await fs.rm(target, { recursive: true });
    await fsyncDirectory(root);
  }


  private async makeMutableForRemoval(current: string): Promise<void> {
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) throw new Error("cleanup_symlink_rejected");
    if (stats.isDirectory()) {
      await fs.chmod(current, 0o700);
      for (const child of await fs.readdir(current)) await this.makeMutableForRemoval(path.join(current, child));
    } else {
      await fs.chmod(current, 0o600);
    }
  }
}
