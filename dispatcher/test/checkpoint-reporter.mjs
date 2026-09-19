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
  const identitiesByExecution = new Map();
  const leafOrdinals = new Map();
  const terminalOccurrences = new Map();
  const queuedTypes = new Map();
  let supportsComplete = false;
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
      if (type === "suite") {
        leafOrdinals.set(event.data.nesting + 1, 0);
        continue;
      }
      if (type !== "test") continue;
      if (path.isAbsolute(event.data.name)) continue;
      const digest = createHash("sha256").update(event.data.name).digest("hex").slice(0, 12);
      const occurrence = (startOccurrences.get(digest) ?? 0) + 1;
      startOccurrences.set(digest, occurrence);
      const location = `${event.data.file}:${event.data.line}:${event.data.column}`;
      const testNumber = (leafOrdinals.get(event.data.nesting) ?? 0) + 1;
      leafOrdinals.set(event.data.nesting, testNumber);
      identitiesByExecution.set(`${location}:${testNumber}`, `${digest}#${occurrence}`);
      yield `\n[dispatcher-test:${nonce}] case-start ${file}:${digest}#${occurrence}\n`;
      continue;
    }
    if (event.type === "test:complete" && event.data.details?.type === "test") {
      supportsComplete = true;
      const location = `${event.data.file}:${event.data.line}:${event.data.column}`;
      const execution = `${location}:${event.data.testNumber}`;
      const identity = identitiesByExecution.get(execution);
      identitiesByExecution.delete(execution);
      if (!identity) continue;
      const action = event.data.details?.passed ? "case-finish" : "case-fail";
      const elapsed = Math.round(event.data.details?.duration_ms ?? 0);
      yield `\n[dispatcher-test:${nonce}] ${action} ${file}:${identity} elapsed_ms=${elapsed}\n`;
      continue;
    }
    if (supportsComplete || (event.type !== "test:pass" && event.type !== "test:fail")) continue;
    if (event.data.details?.type === "suite") continue;
    const digest = createHash("sha256").update(event.data.name).digest("hex").slice(0, 12);
    const occurrence = (terminalOccurrences.get(digest) ?? 0) + 1;
    if (occurrence > (startOccurrences.get(digest) ?? 0)) continue;
    terminalOccurrences.set(digest, occurrence);
    const action = event.type === "test:pass" ? "case-finish" : "case-fail";
    const elapsed = Math.round(event.data.details?.duration_ms ?? 0);
    yield `\n[dispatcher-test:${nonce}] ${action} ${file}:${digest}#${occurrence} elapsed_ms=${elapsed}\n`;
  }
}
