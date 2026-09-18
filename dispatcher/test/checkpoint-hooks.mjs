import { createHash } from "node:crypto";
import process from "node:process";
import { beforeEach } from "node:test";

const file = process.env.DONA_DISPATCHER_TEST_FILE;
const nonce = process.env.DONA_CHECKPOINT_START_NONCE;
delete process.env.DONA_CHECKPOINT_START_NONCE;
delete process.env.DONA_CHECKPOINT_REPORTER_NONCE;
if (!file || !/^test\/[A-Za-z0-9._-]+\.test\.ts$/.test(file) || !nonce || !/^[a-f0-9]{32}$/.test(nonce)) {
  throw new Error("DONA_DISPATCHER_TEST_FILE must be a repository-relative test file");
}

const occurrences = new Map();

beforeEach((context) => {
  const digest = createHash("sha256").update(context.name).digest("hex").slice(0, 12);
  const occurrence = (occurrences.get(digest) ?? 0) + 1;
  occurrences.set(digest, occurrence);
  process.stderr.write(`\n[dispatcher-test:${nonce}] case-start ${file}:${digest}#${occurrence}\n`);
});
