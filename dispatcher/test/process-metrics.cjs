const childProcess = require("node:child_process");
const path = require("node:path");
const process = require("node:process");
const { performance } = require("node:perf_hooks");
const { syncBuiltinESMExports } = require("node:module");

const scope = Number(process.env.DONA_PROCESS_METRICS_SCOPE ?? "0");
const nonce = process.env.DONA_PROCESS_METRICS_NONCE;
if (!nonce && scope > 2) {
  const originalNodeOptions = process.env.DONA_ORIGINAL_NODE_OPTIONS;
  delete process.env.DONA_ORIGINAL_NODE_OPTIONS;
  if (originalNodeOptions) process.env.NODE_OPTIONS = originalNodeOptions;
  else delete process.env.NODE_OPTIONS;
  return;
}
if (!nonce || !/^[a-f0-9]{32}$/.test(nonce)) {
  throw new Error("DONA_PROCESS_METRICS_NONCE must be a bounded nonce");
}

process.env.DONA_PROCESS_METRICS_SCOPE = String(scope + 1);
if (scope >= 2) {
  globalThis[Symbol.for("dona.checkpoint-nonce")] = nonce;
  const originalNodeOptions = process.env.DONA_ORIGINAL_NODE_OPTIONS;
  delete process.env.DONA_CHECKPOINT_REPORTER_NONCE;
  delete process.env.DONA_PROCESS_METRICS_NONCE;
  delete process.env.DONA_ORIGINAL_NODE_OPTIONS;
  if (originalNodeOptions) process.env.NODE_OPTIONS = originalNodeOptions;
  else delete process.env.NODE_OPTIONS;
}

const totals = Object.fromEntries(["node", "git", "shell", "other"].map((name) => [name, { count: 0, elapsed: 0 }]));
let active = 0;
let overheadNs = 0n;
let emitted = 0;
const markerLimit = 2048;

function classify(file) {
  const name = path.basename(String(file)).toLowerCase();
  if (name === "git" || name.includes("fake-git")) return "git";
  if (name === "node" || name === "tsx" || name.endsWith(".mjs") || name.endsWith(".cjs")) return "node";
  if (["sh", "bash", "zsh"].includes(name)) return "shell";
  return "other";
}

function withNonce(options) {
  if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {
    return options;
  }
  const baseEnv = options?.env ?? process.env;
  return {
    ...(options ?? {}),
    env: {
      ...baseEnv,
      DONA_CHECKPOINT_REPORTER_NONCE: nonce,
      DONA_PROCESS_METRICS_NONCE: nonce,
    },
  };
}

function normalizeArgs(args, options) {
  if (Array.isArray(args)) return [args, options];
  if (args === undefined || args === null) return [[], options];
  return [[], args];
}

function emit() {
  if (emitted >= markerLimit) return;
  const started = process.hrtime.bigint();
  const fields = ["node", "git", "shell", "other"]
    .map((name) => `${name}=${totals[name].count}/${Math.round(totals[name].elapsed)}`)
    .join(",");
  process.stderr.write(`[dispatcher-test:${nonce}] metrics scope=${scope};${fields};active=${active};overhead_us=${Number(overheadNs / 1000n)}\n`);
  emitted += 1;
  overheadNs += process.hrtime.bigint() - started;
}

const originalSpawn = childProcess.spawn;
childProcess.spawn = function instrumentedSpawn(file, args, options) {
  const started = performance.now();
  const processClass = classify(file);
  const [actualArgs, actualOptions] = normalizeArgs(args, options);
  active += 1;
  totals[processClass].count += 1;
  emit();
  let child;
  try {
    child = originalSpawn.call(this, file, actualArgs, withNonce(actualOptions));
  } catch (error) {
    active = Math.max(0, active - 1);
    emit();
    throw error;
  }
  child.once("close", () => {
    totals[processClass].elapsed += performance.now() - started;
    active = Math.max(0, active - 1);
    emit();
  });
  return child;
};

const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function instrumentedSpawnSync(file, args, options) {
  const started = performance.now();
  const processClass = classify(file);
  const [actualArgs, actualOptions] = normalizeArgs(args, options);
  active += 1;
  totals[processClass].count += 1;
  emit();
  try {
    return originalSpawnSync.call(this, file, actualArgs, withNonce(actualOptions));
  } finally {
    totals[processClass].elapsed += performance.now() - started;
    active = Math.max(0, active - 1);
    emit();
  }
};

const originalFork = childProcess.fork;
childProcess.fork = function instrumentedFork(modulePath, args, options) {
  const started = performance.now();
  const [actualArgs, actualOptions] = normalizeArgs(args, options);
  active += 1;
  totals.node.count += 1;
  emit();
  let child;
  try {
    child = originalFork.call(this, modulePath, actualArgs, withNonce(actualOptions));
  } catch (error) {
    active = Math.max(0, active - 1);
    emit();
    throw error;
  }
  child.once("close", () => {
    totals.node.elapsed += performance.now() - started;
    active = Math.max(0, active - 1);
    emit();
  });
  return child;
};

const originalExecFile = childProcess.execFile;
childProcess.execFile = function instrumentedExecFile(file, args, options, callback) {
  const started = performance.now();
  const processClass = classify(file);
  const hasExplicitCallback = arguments.length >= 4 || (!Array.isArray(args) && arguments.length >= 3);
  const explicitCallback = arguments.length >= 4 ? callback : options;
  const [actualArgs, normalizedOptions] = normalizeArgs(args, options);
  const actualOptions = typeof normalizedOptions === "function" ? undefined : normalizedOptions;
  const actualCallback = typeof callback === "function" ? callback : typeof options === "function" ? options : typeof args === "function" ? args : undefined;
  active += 1;
  totals[processClass].count += 1;
  emit();
  try {
    if (hasExplicitCallback && explicitCallback != null && typeof explicitCallback !== "function") {
      return originalExecFile.apply(this, arguments);
    }
    return originalExecFile.call(this, file, actualArgs, withNonce(actualOptions), (...callbackArgs) => {
      totals[processClass].elapsed += performance.now() - started;
      active = Math.max(0, active - 1);
      emit();
      actualCallback?.(...callbackArgs);
    });
  } catch (error) {
    active = Math.max(0, active - 1);
    emit();
    throw error;
  }
};
childProcess.execFile[Symbol.for("nodejs.util.promisify.custom")] = (file, args, options) => {
  let child;
  const promise = new Promise((resolve, reject) => {
    child = childProcess.execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
  promise.child = child;
  return promise;
};

const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function instrumentedExecFileSync(file, args, options) {
  const started = performance.now();
  const processClass = classify(file);
  const [actualArgs, actualOptions] = normalizeArgs(args, options);
  active += 1;
  totals[processClass].count += 1;
  emit();
  try {
    return originalExecFileSync.call(this, file, actualArgs, withNonce(actualOptions));
  } finally {
    totals[processClass].elapsed += performance.now() - started;
    active = Math.max(0, active - 1);
    emit();
  }
};

syncBuiltinESMExports();
