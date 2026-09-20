import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { removeTree, tempPolicy } from "./helpers.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeTree)));

test("invalid CLI arguments fail before opening or migrating the database", async () => {
  const { root, policy } = await tempPolicy();
  roots.push(root);
  await fs.mkdir(policy.control_root, { recursive: true });
  const databasePath = path.join(policy.control_root, "updater.sqlite3");
  const raw = new Database(databasePath);
  raw.exec("CREATE TABLE update_requests (request_id TEXT PRIMARY KEY); PRAGMA user_version = 4;");
  raw.close();
  const policyPath = path.join(root, "policy.json");
  await fs.writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });

  await assert.rejects(execFileAsync(
    path.resolve("node_modules/.bin/tsx"),
    [path.resolve("src/cli.ts"), "serve", "unexpected"],
    { env: { ...process.env, DONA_UPDATE_POLICY_PATH: policyPath } },
  ), (error: NodeJS.ErrnoException & { code?: number; stderr?: string }) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr ?? "", /Usage:/);
    return true;
  });

  const unchanged = new Database(databasePath, { readonly: true });
  assert.equal(unchanged.pragma("user_version", { simple: true }), 4);
  assert.equal(unchanged.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'update_diagnostic_logs'").get(), undefined);
  unchanged.close();
});
