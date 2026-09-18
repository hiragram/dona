import { createHash } from "node:crypto";
import process from "node:process";
import { beforeEach } from "node:test";

const file = process.env.DONA_DISPATCHER_TEST_FILE;
if (!file || !/^test\/[A-Za-z0-9._-]+\.test\.ts$/.test(file)) {
  throw new Error("DONA_DISPATCHER_TEST_FILE must be a repository-relative test file");
}

let sequence = 0;

beforeEach((context) => {
  const digest = createHash("sha256").update(context.name).digest("hex").slice(0, 12);
  const identity = `${file}:${digest}#${++sequence}`;
  process.stderr.write(`\n[dispatcher-test] case-start ${identity}\n`);
});
