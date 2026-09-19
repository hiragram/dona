import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

const file = process.env.DONA_DISPATCHER_TEST_FILE;
const nonce = process.env.DONA_CHECKPOINT_REPORTER_NONCE ?? globalThis[Symbol.for("dona.checkpoint-nonce")];
if (!file || !/^test\/[A-Za-z0-9._-]+\.test\.ts$/.test(file) || !nonce || !/^[a-f0-9]{32}$/.test(nonce)) {
  throw new Error("DONA_DISPATCHER_TEST_FILE must be a repository-relative test file");
}

export default async function* checkpointReporter(source) {
  delete process.env.DONA_CHECKPOINT_REPORTER_NONCE;
  const startOccurrences = new Map();
  const identitiesByLocation = new Map();
  const queuedTypes = new Map();
  for await (const event of source) {
    if (event.type === "test:stderr") {
      const message = typeof event.data?.message === "string" ? event.data.message : "";
      for (const line of message.split(/\r?\n/)) {
        if (new RegExp(`^\\[dispatcher-test:${nonce}\\] metrics scope=2;node=\\d+\\/\\d+,git=\\d+\\/\\d+,shell=\\d+\\/\\d+,other=\\d+\\/\\d+;active=\\d+;overhead_us=\\d+$`).test(line)) {
          yield `\n${line}\n`;
        }
      }
      continue;
    }
    const key = `${event.data?.nesting}:${event.data?.name}`;
    if (event.type === "test:enqueue") {
      const types = queuedTypes.get(key) ?? [];
      types.push(event.data.type);
      queuedTypes.set(key, types);
      continue;
    }
    if (event.type === "test:dequeue") {
      const types = queuedTypes.get(key) ?? [];
      const type = types.shift();
      if (types.length === 0) queuedTypes.delete(key);
      if (type !== "test") continue;
      if (path.isAbsolute(event.data.name)) continue;
      const digest = createHash("sha256").update(event.data.name).digest("hex").slice(0, 12);
      const occurrence = (startOccurrences.get(digest) ?? 0) + 1;
      startOccurrences.set(digest, occurrence);
      const location = `${event.data.file}:${event.data.line}:${event.data.column}`;
      const identities = identitiesByLocation.get(location) ?? [];
      identities.push(`${digest}#${occurrence}`);
      identitiesByLocation.set(location, identities);
      yield `\n[dispatcher-test:${nonce}] case-start ${file}:${digest}#${occurrence}\n`;
      continue;
    }
    if (event.type !== "test:complete" || event.data.details?.type !== "test") continue;
    const location = `${event.data.file}:${event.data.line}:${event.data.column}`;
    const identities = identitiesByLocation.get(location) ?? [];
    const identity = identities.shift();
    if (identities.length === 0) identitiesByLocation.delete(location);
    if (!identity) continue;
    const action = event.data.details?.passed ? "case-finish" : "case-fail";
    const elapsed = Math.round(event.data.details?.duration_ms ?? 0);
    yield `\n[dispatcher-test:${nonce}] ${action} ${file}:${identity} elapsed_ms=${elapsed}\n`;
  }
}
