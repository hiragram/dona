import fs from "node:fs/promises";

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
  try {
    const stats = await fs.lstat(tokenPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0) return undefined;
    const raw = await fs.readFile(tokenPath);
    let end = raw.length;
    while (end > 0 && (raw[end - 1] === 10 || raw[end - 1] === 13)) { raw[end - 1] = 0; end -= 1; }
    if (end < 32) { raw.fill(0); return undefined; }
    return raw.subarray(0, end);
  } catch { return undefined; }
}
