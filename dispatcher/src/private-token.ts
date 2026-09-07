import fs from "node:fs/promises";
import { constants } from "node:fs";

export async function readPrivateToken(tokenPath: string): Promise<string | undefined> {
  try {
    const stats = await fs.lstat(tokenPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0) {
      return undefined;
    }
    const token = (await fs.readFile(tokenPath, "utf8")).trim();
    return token.length >= 32 ? token : undefined;
  } catch {
    return undefined;
  }
}

export async function readPrivateBuffer(tokenPath: string): Promise<Buffer | undefined> {
  let file: fs.FileHandle | undefined;
  try {
    file = await fs.open(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await file.stat();
    if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0) return undefined;
    const raw = await file.readFile();
    let end = raw.length;
    while (end > 0 && (raw[end - 1] === 10 || raw[end - 1] === 13)) { raw[end - 1] = 0; end -= 1; }
    if (end < 32) { raw.fill(0); return undefined; }
    return raw.subarray(0, end);
  } catch { return undefined; }
  finally { await file?.close(); }
}
