import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ConnectionError } from "./domain.js";

const credentialReference = /^cred_[A-Za-z0-9_-]{1,100}$/;

export class PrivateFileSecretStore {
  constructor(private readonly root: string) {}

  private async checkedRoot(): Promise<void> {
    const stats = await fs.lstat(this.root);
    if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0)
      throw new ConnectionError("not_authorized");
  }

  private file(reference: string, revision: number): string {
    if (!credentialReference.test(reference) || !Number.isSafeInteger(revision) || revision < 1) throw new ConnectionError("invalid_input");
    return path.join(this.root, `${reference}.${revision}.secret`);
  }

  async write(reference: string, revision: number, secret: Uint8Array): Promise<{ created: true }> {
    if (!(secret instanceof Uint8Array) || secret.byteLength < 16 || secret.byteLength > 65_536) throw new ConnectionError("invalid_input");
    await this.checkedRoot();
    const target = this.file(reference, revision);
    try {
      const existing = await fs.lstat(target);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.uid !== process.getuid?.() || (existing.mode & 0o077) !== 0)
        throw new ConnectionError("not_authorized");
      throw new ConnectionError("revision_conflict");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = path.join(this.root, `.${reference}.${revision}.${randomBytes(12).toString("hex")}.tmp`);
    let handle: fs.FileHandle | undefined, published = false;
    try {
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(secret);
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close(); handle = undefined;
      // link(2) は既存targetを置換せず、同一filesystem上でpublishを原子的に確定する。
      await fs.link(temporary, target); published = true;
      await fs.unlink(temporary);
      const directory = await fs.open(this.root, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
      const stats = await fs.lstat(target);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0)
        throw new ConnectionError("not_authorized");
      return { created: true };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      if (published) throw new ConnectionError("durability_unconfirmed");
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ConnectionError("revision_conflict");
      throw error;
    }
  }

  async reconcile(reference: string, revision: number, expected: Uint8Array): Promise<boolean> {
    if (!(expected instanceof Uint8Array) || expected.byteLength < 16 || expected.byteLength > 65_536)
      throw new ConnectionError("invalid_input");
    await this.checkedRoot();
    const target = this.file(reference, revision), targetStats = await fs.lstat(target);
    const temporaryPattern = new RegExp(`^\\.${reference}\\.${revision}\\.[a-f0-9]{24}\\.tmp$`);
    if (targetStats.isFile() && !targetStats.isSymbolicLink() && targetStats.uid === process.getuid?.() && (targetStats.mode & 0o077) === 0) {
      for (const entry of await fs.readdir(this.root)) {
        if (!temporaryPattern.test(entry)) continue;
        const temporary = path.join(this.root, entry), stats = await fs.lstat(temporary);
        if (stats.isFile() && !stats.isSymbolicLink() && stats.uid === targetStats.uid && stats.dev === targetStats.dev && stats.ino === targetStats.ino)
          await fs.unlink(temporary);
      }
    }
    const stored = await this.read(reference, revision);
    const candidate = Buffer.from(expected);
    const matches = stored.length === candidate.length && timingSafeEqual(stored, candidate);
    stored.fill(0); candidate.fill(0);
    if (!matches) return false;
    const directory = await fs.open(this.root, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    return true;
  }

  async read(reference: string, revision: number): Promise<Buffer> {
    await this.checkedRoot();
    const handle = await fs.open(this.file(reference, revision), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.nlink !== 1 || stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0)
        throw new ConnectionError("not_authorized");
      return await handle.readFile();
    } finally { await handle.close(); }
  }

}
