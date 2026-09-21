const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
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

  const registrations = new Map();
  const originalTest = nodeTest.test;

  function callerIdentity(name) {
    const stack = new Error().stack?.split("\n").slice(2) ?? [];
    const caller = stack.find((line) => !line.includes("case-checkpoint.cjs")) ?? "unknown";
    const position = /:(\d+):(\d+)\)?$/.exec(caller);
    if (!position) throw new Error("case checkpoint source position is unavailable");
    return createHash("sha256").update(`${file}\0${position[1]}:${position[2]}\0${name}`).digest("hex").slice(0, 12);
  }

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

  function wrapRegistration(register) {
    const wrapped = function checkpointedTest(...args) {
      const callbackIndex = args.findIndex((value) => typeof value === "function");
      if (callbackIndex < 0) return register.apply(this, args);
      const body = args[callbackIndex];
      const name = typeof args[0] === "string" ? args[0] : body.name || "anonymous";
      const digest = callerIdentity(name);
      const occurrence = (registrations.get(digest) ?? 0) + 1;
      registrations.set(digest, occurrence);
      const identity = `${digest}#${occurrence}`;
      args[callbackIndex] = async function checkpointedBody(...bodyArgs) {
        const startedAt = performance.now();
        marker("case-start", identity, undefined, true);
        try {
          const result = await body.apply(this, bodyArgs);
          marker("case-finish", identity, performance.now() - startedAt);
          return result;
        } catch (error) {
          marker("case-fail", identity, performance.now() - startedAt);
          throw error;
        }
      };
      return register.apply(this, args);
    };
    Object.assign(wrapped, register);
    return wrapped;
  }

  const wrappedTest = wrapRegistration(originalTest);
  wrappedTest.skip = wrapRegistration(originalTest.skip);
  wrappedTest.todo = wrapRegistration(originalTest.todo);
  wrappedTest.only = wrapRegistration(originalTest.only);
  nodeTest.test = wrappedTest;
  nodeTest.it = wrappedTest;
  syncBuiltinESMExports();
}
