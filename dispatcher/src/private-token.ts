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
