const { createHash } = require("node:crypto");
const fs = require("node:fs");
const nodeTest = require("node:test");
const path = require("node:path");
const process = require("node:process");

const file = process.env.DONA_DISPATCHER_TEST_FILE;
const nonce = process.env.DONA_CASE_CHECKPOINT_NONCE;
const metricsScope = Number(process.env.DONA_PROCESS_METRICS_SCOPE ?? "0");
const isTestWorker = process.env.NODE_TEST_CONTEXT === "child-v8";
const channelDirectory = process.env.DONA_CASE_CHECKPOINT_DIR;

// Only node:test's isolated worker executes test bodies. Deeper application
// children lose the injected NODE_OPTIONS at the metrics scope boundary.
if (isTestWorker && metricsScope === 2) {
  if (!file || !/^test\/[A-Za-z0-9._-]+\.test\.ts$/.test(file)) throw new Error("case checkpoint file must be repository-relative");
  if (!nonce || !/^[a-f0-9]{32}$/.test(nonce)) throw new Error("case checkpoint nonce must be bounded");
  if (!channelDirectory || !path.isAbsolute(channelDirectory) || !/^dona-case-checkpoint-[A-Za-z0-9_-]+$/.test(path.basename(channelDirectory))) {
    throw new Error("case checkpoint channel must be an isolated absolute directory");
  }
  delete process.env.DONA_CASE_CHECKPOINT_NONCE;
  delete process.env.DONA_CASE_CHECKPOINT_DIR;
  const eventsPath = path.join(channelDirectory, "events");
  const acknowledgementPath = path.join(channelDirectory, "ack");
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  let sequence = 0;

  const occurrences = new Map();

  function marker(action, identity, elapsedMs, requireAcknowledgement = false) {
    const elapsed = elapsedMs === undefined ? "" : ` elapsed_ms=${Math.min(999_999_999, Math.max(0, Math.round(elapsedMs)))}`;
    const currentSequence = ++sequence;
    const value = `[dispatcher-test:${nonce}] ${action} ${file}:${identity}${elapsed}`;
    fs.appendFileSync(eventsPath, `${currentSequence}\t${value}\n`, "utf8");
    if (!requireAcknowledgement) return;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        if (fs.readFileSync(acknowledgementPath, "utf8").trim() === String(currentSequence)) return;
      } catch { /* the parent owns channel availability */ }
      Atomics.wait(waitArray, 0, 0, 1);
    }
    throw new Error("case checkpoint parent acknowledgement timed out");
  }

  // A preload-owned beforeEach runs before file and suite hooks without wrapping
  // test registration. That preserves callback arity and Node's source metadata,
  // and it also covers TestContext.test() subtests. TestContext.after() runs only
  // after body and afterEach cleanup have settled, so a synchronous hook stall
  // intentionally leaves this identity unfinished. The Node 24 TestContext passed
  // getter includes hook failures without exposing the error text.
  nodeTest.beforeEach((context) => {
    const fullName = context.fullName;
    if (!fullName || Buffer.byteLength(fullName) > 16 * 1024) throw new Error("case checkpoint full name is invalid");
    const digest = createHash("sha256").update(`${file}\0${fullName}`).digest("hex").slice(0, 12);
    const occurrence = (occurrences.get(digest) ?? 0) + 1;
    occurrences.set(digest, occurrence);
    const identity = `${digest}#${occurrence}`;
    const startedAt = performance.now();
    marker("case-start", identity, undefined, true);
    context.after(() => marker(context.passed === true ? "case-finish" : "case-fail", identity, performance.now() - startedAt));
  });
}
