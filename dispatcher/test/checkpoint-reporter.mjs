import { createHash } from "node:crypto";
import process from "node:process";
import { Transform } from "node:stream";

const file = process.env.DONA_DISPATCHER_TEST_FILE;
const nonce = process.env.DONA_CHECKPOINT_REPORTER_NONCE ?? globalThis[Symbol.for("dona.checkpoint-nonce")];
if (!file || !/^test\/[A-Za-z0-9._-]+\.test\.ts$/.test(file) || !nonce || !/^[a-f0-9]{32}$/.test(nonce)) throw new Error("DONA_DISPATCHER_TEST_FILE must be a repository-relative test file");

export default function checkpointReporter() {
  delete process.env.DONA_CHECKPOINT_REPORTER_NONCE;
  const starts = new Map(), terminals = new Map(), completed = new Set(), queued = new Map();
  let supportsComplete = false;
  const reporter = new Transform({
    writableObjectMode: true,
    transform(event, _encoding, callback) {
      let output = "";
      if (event.type === "test:stderr") {
        const message = typeof event.data?.message === "string" ? event.data.message : "";
        for (const line of message.split(/\r?\n/)) {
          const start = new RegExp(`^\\[dispatcher-test:${nonce}\\] case-start ${file}:([a-f0-9]{12})#(\\d+)$`).exec(line);
          if (start) {
            starts.set(start[1], Math.max(starts.get(start[1]) ?? 0, Number(start[2])));
            output += `\n${line}\n`;
          } else if (new RegExp(`^\\[dispatcher-test:${nonce}\\] metrics scope=2;node=\\d+\/\\d+,git=\\d+\/\\d+,shell=\\d+\/\\d+,other=\\d+\/\\d+;active=\\d+;overhead_us=\\d+$`).test(line)) output += `\n${line}\n`;
        }
        callback(null, output); return;
      }
      const key = `${event.data?.nesting}:${event.data?.name}`;
      if (event.type === "test:enqueue") {
        const types = queued.get(key) ?? []; types.push(event.data.type); queued.set(key, types);
      } else if (event.type === "test:dequeue") {
        const types = queued.get(key) ?? [], type = types.shift();
        if (types.length === 0) queued.delete(key);
        const wrapper = type === "test" && event.data.nesting === 0 && event.data.name === event.data.file;
        if (type === "test" && !wrapper) {
          const digest = createHash("sha256").update(event.data.name).digest("hex").slice(0, 12);
          const occurrence = (starts.get(digest) ?? 0) + 1; starts.set(digest, occurrence);
          output = `\n[dispatcher-test:${nonce}] case-start ${file}:${digest}#${occurrence}\n`;
        }
      } else if (event.type === "test:complete" && event.data.details?.type === "test") {
        supportsComplete = true;
        const signature = `${event.data.file}:${event.data.line}:${event.data.column}:${event.data.testNumber}:${event.data.details.duration_ms}:${event.data.details.passed}`;
        if (!completed.has(signature) && event.data.details?.error?.failureType !== "cancelledByParent") {
          completed.add(signature);
          const digest = createHash("sha256").update(event.data.name).digest("hex").slice(0, 12);
          const occurrence = (terminals.get(digest) ?? 0) + 1;
          if (occurrence <= (starts.get(digest) ?? 0)) {
            terminals.set(digest, occurrence);
            const action = event.data.details?.passed ? "case-finish" : "case-fail";
            output = `\n[dispatcher-test:${nonce}] ${action} ${file}:${digest}#${occurrence} elapsed_ms=${Math.round(event.data.details?.duration_ms ?? 0)}\n`;
          }
        }
      } else if (!supportsComplete && (event.type === "test:pass" || event.type === "test:fail") && event.data.details?.type !== "suite") {
        const digest = createHash("sha256").update(event.data.name).digest("hex").slice(0, 12);
        const occurrence = (terminals.get(digest) ?? 0) + 1;
        if (occurrence <= (starts.get(digest) ?? 0)) {
          terminals.set(digest, occurrence);
          output = `\n[dispatcher-test:${nonce}] ${event.type === "test:pass" ? "case-finish" : "case-fail"} ${file}:${digest}#${occurrence} elapsed_ms=${Math.round(event.data.details?.duration_ms ?? 0)}\n`;
        }
      }
      callback(null, output);
    },
  });
  return reporter;
}
