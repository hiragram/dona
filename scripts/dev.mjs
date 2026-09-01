#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.dirname(scriptDir);
const dispatcherDir = path.join(repoDir, "dispatcher");
const slackDir = path.join(repoDir, "sources", "slack");
const defaultSocketPath = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Dona",
  "run",
  "dispatcher.sock",
);
const readyTimeoutMs = positiveInteger(process.env.DONA_DEV_READY_TIMEOUT_MS, 15_000);
const shutdownTimeoutMs = positiveInteger(process.env.DONA_DEV_SHUTDOWN_TIMEOUT_MS, 5_000);

function positiveInteger(value, fallback) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("Development launcher timeout settings must be positive integers");
  }
  return parsed;
}

async function packageEnvironment(directory) {
  let fileEnvironment = {};
  try {
    const contents = await fsPromises.readFile(path.join(directory, ".env"), "utf8");
    fileEnvironment = parseEnv(contents);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { ...fileEnvironment, ...process.env };
}

function configuredSocketPath(environment, directory) {
  const configured = environment.DONA_SOCKET_PATH;
  if (!configured) return defaultSocketPath;
  if (configured === "~") return os.homedir();
  if (configured.startsWith("~/")) return path.join(os.homedir(), configured.slice(2));
  return path.resolve(directory, configured);
}

async function assertExecutable(file, packageName) {
  try {
    await fsPromises.access(file, fsConstants.X_OK);
  } catch {
    throw new Error(
      `${packageName}の依存関係がありません。npm --prefix ${path.relative(repoDir, path.dirname(path.dirname(path.dirname(file))))} install を実行してください。`,
    );
  }
}

function requestHealth(socketPath, timeoutMs = 500) {
  return new Promise((resolve) => {
    const request = http.request(
      {
        socketPath,
        path: "/health/ready",
        method: "GET",
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", () => resolve(undefined));
    request.setTimeout(timeoutMs, () => request.destroy());
    request.end();
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function childExit(child, name) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) => finish({ name, code: 1, signal: null, error }));
    child.once("exit", (code, signal) => finish({ name, code, signal, error: null }));
  });
}

function isRunning(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

function stopChild(child, signal) {
  if (isRunning(child)) child.kill(signal);
}

async function waitForDispatcher(socketPath, dispatcher, dispatcherExit) {
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(dispatcher)) {
      const result = await dispatcherExit;
      throw childFailure(result, "Dispatcherがreadyになる前に終了しました");
    }
    if ((await requestHealth(socketPath)) === 200) return;
    await delay(100);
  }
  throw new Error(`Dispatcherのready待機が${readyTimeoutMs}msでタイムアウトしました`);
}

function childFailure(result, prefix) {
  const detail = result.error
    ? result.error.message
    : result.signal
      ? `signal=${result.signal}`
      : `exit_code=${result.code}`;
  return new Error(`${prefix}: ${detail}`);
}

function startTsx(name, directory, arguments_, environment) {
  const executable = path.join(directory, "node_modules", ".bin", "tsx");
  console.log(`[dev] ${name}を起動します`);
  return spawn(executable, arguments_, {
    cwd: directory,
    env: environment,
    stdio: "inherit",
  });
}

async function stopAll(children, exitPromises) {
  for (const child of children) stopChild(child, "SIGTERM");

  const completed = Promise.all(exitPromises);
  let timeoutHandle;
  const timedOut = await Promise.race([
    completed.then(() => false),
    new Promise((resolve) => {
      timeoutHandle = setTimeout(() => resolve(true), shutdownTimeoutMs);
    }),
  ]);
  clearTimeout(timeoutHandle);
  if (!timedOut) return;

  console.error(`[dev] ${shutdownTimeoutMs}ms以内に終了しなかったプロセスを強制終了します`);
  for (const child of children) stopChild(child, "SIGKILL");
  await completed;
}

async function main() {
  const dispatcherEnvironment = await packageEnvironment(dispatcherDir);
  const slackEnvironment = await packageEnvironment(slackDir);
  const dispatcherSocketPath = configuredSocketPath(dispatcherEnvironment, dispatcherDir);
  const slackSocketPath = configuredSocketPath(slackEnvironment, slackDir);
  if (dispatcherSocketPath !== slackSocketPath) {
    throw new Error(
      `DispatcherとSlack AdapterのDONA_SOCKET_PATHが一致しません: ${dispatcherSocketPath} / ${slackSocketPath}`,
    );
  }

  const dispatcherTsx = path.join(dispatcherDir, "node_modules", ".bin", "tsx");
  const slackTsx = path.join(slackDir, "node_modules", ".bin", "tsx");
  await assertExecutable(dispatcherTsx, "Dispatcher");
  await assertExecutable(slackTsx, "Slack Adapter");

  if ((await requestHealth(dispatcherSocketPath)) !== undefined) {
    throw new Error(
      `Dispatcherが既に起動しています (${dispatcherSocketPath})。LaunchAgentまたは既存の開発プロセスを停止してください。`,
    );
  }

  let requestedSignal;
  let resolveSignal;
  const signalReceived = new Promise((resolve) => {
    resolveSignal = resolve;
  });
  const receiveSignal = (signal) => {
    if (requestedSignal) return;
    requestedSignal = signal;
    resolveSignal({ kind: "signal", signal });
  };
  process.once("SIGINT", () => receiveSignal("SIGINT"));
  process.once("SIGTERM", () => receiveSignal("SIGTERM"));

  const dispatcher = startTsx(
    "Dispatcher",
    dispatcherDir,
    ["src/cli.ts", "serve"],
    dispatcherEnvironment,
  );
  const dispatcherExit = childExit(dispatcher, "Dispatcher");
  let slack;
  let slackExit;

  try {
    const startupOutcome = await Promise.race([
      waitForDispatcher(dispatcherSocketPath, dispatcher, dispatcherExit).then(() => ({
        kind: "ready",
      })),
      signalReceived,
    ]);
    if (startupOutcome.kind === "ready") {
      console.log("[dev] Dispatcherがreadyになりました");

      slack = startTsx("Slack Adapter", slackDir, ["src/index.ts"], slackEnvironment);
      slackExit = childExit(slack, "Slack Adapter");

      const outcome = await Promise.race([
        dispatcherExit.then((result) => ({ kind: "exit", result })),
        slackExit.then((result) => ({ kind: "exit", result })),
        signalReceived,
      ]);

      if (outcome.kind === "exit" && !requestedSignal) {
        if (outcome.result.code === 130 || outcome.result.signal === "SIGINT") {
          requestedSignal = "SIGINT";
        } else if (outcome.result.code === 143 || outcome.result.signal === "SIGTERM") {
          requestedSignal = "SIGTERM";
        } else {
          throw childFailure(outcome.result, `${outcome.result.name}が終了しました`);
        }
      }
    }
  } finally {
    console.log("[dev] Donaを停止します");
    const children = slack ? [slack, dispatcher] : [dispatcher];
    const exits = slackExit ? [slackExit, dispatcherExit] : [dispatcherExit];
    await stopAll(children, exits);
  }

  if (requestedSignal === "SIGINT") process.exitCode = 130;
  if (requestedSignal === "SIGTERM") process.exitCode = 143;
}

main().catch((error) => {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = process.exitCode || 1;
});
