import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

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

export async function ensurePrivateToken(tokenPath: string): Promise<string> {
  const existing = await readPrivateToken(tokenPath);
  if (existing) return existing;
  try {
    await fs.lstat(tokenPath);
    throw new Error("Private token is present but invalid");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const directory = path.dirname(tokenPath);
  await fs.mkdir(directory, { recursive:true, mode:0o700 });
  const temporary = path.join(directory, `.${path.basename(tokenPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${randomBytes(32).toString("hex")}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(temporary, tokenPath);
    const directoryHandle = await fs.open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
  const created = await readPrivateToken(tokenPath);
  if (!created) throw new Error("Private token could not be created safely");
  return created;
}
