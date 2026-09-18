import { createHash } from "node:crypto";
import process from "node:process";

const file = process.env.DONA_DISPATCHER_TEST_FILE;
const nonce = process.env.DONA_CHECKPOINT_REPORTER_NONCE;
delete process.env.DONA_CHECKPOINT_REPORTER_NONCE;
if (!file || !/^test\/[A-Za-z0-9._-]+\.test\.ts$/.test(file) || !nonce || !/^[a-f0-9]{32}$/.test(nonce)) {
  throw new Error("DONA_DISPATCHER_TEST_FILE must be a repository-relative test file");
}

export default async function* checkpointReporter(source) {
  const occurrences = new Map();
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const digest = createHash("sha256").update(event.data.name).digest("hex").slice(0, 12);
    const occurrence = (occurrences.get(digest) ?? 0) + 1;
    occurrences.set(digest, occurrence);
    const action = event.type === "test:pass" ? "case-finish" : "case-fail";
    yield `\n[dispatcher-test:${nonce}] ${action} ${file}:${digest}#${occurrence}\n`;
  }
}
