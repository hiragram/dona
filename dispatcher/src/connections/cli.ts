import fs from "node:fs";
import Database from "better-sqlite3";
import { DispatcherDatabase } from "../database.js";
import { ConnectionError } from "./domain.js";
import { ConnectionRegistry } from "./registry.js";

export function runConnectionCli(databasePath: string, args: string[]): unknown {
  const [command, id, revisionText, inputPath] = args;
  // inspection は migrate/chmod を行わず、SQLite readonly connection で実行する。
  if (command === "list" || command === "show" || command === "health") {
    if ((command === "show" && (!id || args.length !== 2)) || (command !== "show" && args.length !== 1)) throw new ConnectionError("invalid_input");
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const registry = new ConnectionRegistry(db);
      return command === "health" ? registry.health() : registry.inspect(command === "show" ? id : undefined);
    } finally { db.close(); }
  }
  if (!args.includes("--confirm")) throw new ConnectionError("not_authorized");
  const db = new DispatcherDatabase(databasePath);
  try {
    const registry = db.connections;
    if (command === "register" && id && args.length === 3 && revisionText === "--confirm") {
      registry.register(JSON.parse(fs.readFileSync(id, "utf8")));
      return registry.inspect();
    }
    const revision = Number(revisionText);
    if (!id || !Number.isSafeInteger(revision) || revision < 1) throw new ConnectionError("invalid_input");
    if (command === "disable" && args.length === 4 && inputPath === "--confirm") registry.disable(id, revision);
    else if (command === "revise" && inputPath && args.length === 5 && args[4] === "--confirm") registry.revise(id, revision, JSON.parse(fs.readFileSync(inputPath, "utf8")));
    else if (command === "attach" && inputPath && args.length === 5 && args[4] === "--confirm") {
      const input = JSON.parse(fs.readFileSync(inputPath, "utf8")) as {resource: string; providerId: string; expiresAt: number | null};
      registry.attachManual(id, revision, input.resource, input.providerId, input.expiresAt);
    } else throw new ConnectionError("invalid_input");
    return registry.inspect(id);
  } catch (error) {
    // JSON parse/SQLite/FS exception が入力の秘密を反射しない。
    if (error instanceof ConnectionError) throw error;
    throw new ConnectionError("invalid_input");
  } finally { db.close(); }
}
