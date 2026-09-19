import { createHash } from "node:crypto";
import process from "node:process";

const file = process.env.DONA_DISPATCHER_TEST_FILE;
const nonce = process.env.DONA_CHECKPOINT_REPORTER_NONCE ?? globalThis[Symbol.for("dona.checkpoint-nonce")];
if (!file || !/^test\/[A-Za-z0-9._-]+\.test\.ts$/.test(file) || !nonce || !/^[a-f0-9]{32}$/.test(nonce)) {
  throw new Error("DONA_DISPATCHER_TEST_FILE must be a repository-relative test file");
}

export default async function* checkpointReporter(source) {
  delete process.env.DONA_CHECKPOINT_REPORTER_NONCE;
  const occurrences = new Map();
  const queuedTypes = new Map();
  for await (const event of source) {
    const key = `${event.data?.nesting}:${event.data?.name}`;
    if (event.type === "test:enqueue") {
      const types = queuedTypes.get(key) ?? [];
      types.push(event.data.type);
      queuedTypes.set(key, types);
      continue;
    }
    if (event.type === "test:start") {
      const types = queuedTypes.get(key) ?? [];
      const type = types.shift();
      if (types.length === 0) queuedTypes.delete(key);
      if (type !== "test") continue;
      const digest = createHash("sha256").update(event.data.name).digest("hex").slice(0, 12);
      const occurrence = (occurrences.get(digest) ?? 0) + 1;
      occurrences.set(digest, occurrence);
      yield `\n[dispatcher-test:${nonce}] case-start ${file}:${digest}#${occurrence}\n`;
      continue;
    }
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    if (event.data.details?.type === "suite") continue;
    const digest = createHash("sha256").update(event.data.name).digest("hex").slice(0, 12);
    const occurrence = occurrences.get(digest);
    if (!occurrence) continue;
    const action = event.type === "test:pass" ? "case-finish" : "case-fail";
    const identity = `${digest}#${occurrence}`;
    const elapsed = Math.round(event.data.details?.duration_ms ?? 0);
    yield `\n[dispatcher-test:${nonce}] ${action} ${file}:${identity} elapsed_ms=${elapsed}\n`;
  }
}
