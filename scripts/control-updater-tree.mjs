import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function controlUpdaterTreeDigest(root) {
  if (!path.isAbsolute(root)) throw new Error("control updater root is invalid");
  const uid = process.getuid();
  const rootStats = fs.lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || rootStats.uid !== uid ||
      (rootStats.mode & 0o777) !== 0o700) throw new Error("control updater root identity is invalid");
  const hash = createHash("sha256");
  const visit = (directory, relativeDirectory = "") => {
    for (const name of fs.readdirSync(directory).sort((a, b) => a.localeCompare(b))) {
      const relative = path.join(relativeDirectory, name);
      const full = path.join(directory, name);
      const stats = fs.lstatSync(full);
      if (stats.uid !== uid) throw new Error("control updater owner is invalid");
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        if ((stats.mode & 0o777) !== 0o500) throw new Error("control updater directory mode is invalid");
        hash.update(`d\0${relative}\0`);
        visit(full, relative);
      } else if (stats.isFile() && !stats.isSymbolicLink()) {
        if (stats.nlink !== 1 || (stats.mode & 0o777) !== 0o400) throw new Error("control updater file identity is invalid");
        hash.update(`f\0${relative}\0`);
        hash.update(fs.readFileSync(full));
        hash.update("\0");
      } else if (stats.isSymbolicLink()) {
        const resolved = fs.realpathSync(full);
        const inside = path.relative(root, resolved);
        if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
          throw new Error("control updater link escaped");
        }
        hash.update(`l\0${relative}\0${fs.readlinkSync(full)}\0`);
      } else throw new Error("control updater entry is invalid");
    }
  };
  visit(root);
  return hash.digest("hex");
}
