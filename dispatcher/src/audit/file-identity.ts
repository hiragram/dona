import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

const loaded = new WeakSet<Database.Database>();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Fixed, locally built extension only. Neither SQL nor an external request can
 * choose a library path. Missing/unsupported/stale builds fail closed. */
export function verifyOpenDatabaseFile(db: Database.Database): void {
  if (!loaded.has(db)) {
    if (!["darwin", "linux"].includes(process.platform)) throw new Error("security_file_identity_unavailable");
    const manifest = JSON.parse(fs.readFileSync(new URL("../../dist/native/file-identity.json", import.meta.url), "utf8"));
    const library = new URL("../../dist/native/file-identity" + (process.platform === "darwin" ? ".dylib" : ".so"), import.meta.url);
    if (manifest.inputs?.version !== 1 || manifest.inputs.platform !== process.platform || manifest.inputs.arch !== process.arch
      || manifest.inputs.source !== hash(fs.readFileSync(new URL("../../src/native/file-identity.c", import.meta.url)))
      || manifest.inputs.headers !== hash(Buffer.concat([
        fs.readFileSync(new URL("../../node_modules/better-sqlite3/deps/sqlite3/sqlite3.h", import.meta.url)),
        fs.readFileSync(new URL("../../node_modules/better-sqlite3/deps/sqlite3/sqlite3ext.h", import.meta.url)),
      ]))
      || manifest.binary !== hash(fs.readFileSync(library))) throw new Error("security_file_identity_unavailable");
    db.loadExtension(fileURLToPath(library));
    loaded.add(db);
  }
  const row = db.prepare("SELECT dona_file_identity_ok() AS ok").get() as { ok: number };
  if (row.ok !== 1) throw new Error("security_file_identity_unverified");
}
