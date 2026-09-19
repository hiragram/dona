import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const clockParts = ["dispatcher", "dist", "native", "security-clock"];

/** 既存releaseにはhelperがなくてもよいが、存在する場合は別名を許さない。 */
export async function validateNativeClockPath(root: string): Promise<void> {
  let current = root;
  for (const [index, part] of clockParts.entries()) {
    current = path.join(current, part);
    let stats;
    try { stats = await fs.lstat(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const valid = index === clockParts.length - 1
      ? stats.isFile() && stats.nlink === 1 && (stats.mode & 0o100) !== 0
      : stats.isDirectory();
    if (!valid || stats.isSymbolicLink() || stats.uid !== process.getuid?.() || (stats.mode & 0o022) !== 0) {
      throw new Error("native_clock_release_invalid");
    }
  }
}

/** 初期installと更新公開に共通の固定権限。pointer操作は行わない。 */
export async function makeReleaseImmutable(root: string): Promise<void> {
  await validateNativeClockPath(root);
  async function visit(current: string): Promise<void> {
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) return;
    if (stats.isDirectory()) {
      for (const child of await fs.readdir(current)) await visit(path.join(current, child));
      await fs.chmod(current, 0o500);
    } else if (stats.isFile()) {
      const clock = path.relative(root, current) === path.join(...clockParts);
      await fs.chmod(current, clock ? 0o500 : 0o400);
    }
  }
  await visit(root);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2]!)) throw new Error();
    const root = process.argv[2]!;
    const stats = await fs.lstat(root);
    if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== process.getuid?.() || (stats.mode & 0o022) !== 0) throw new Error();
    await makeReleaseImmutable(root);
  } catch {
    process.stderr.write("release_permissions_failed\n");
    process.exitCode = 1;
  }
}
