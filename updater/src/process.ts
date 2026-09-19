import { spawn } from "node:child_process";

import type { CommandResult } from "./types.js";

export interface RunOptions {
  cwd?: string;
  timeoutMs: number;
  outputLimitBytes: number;
  env?: Readonly<Record<string, string>>;
}

export function minimalEnvironment(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    CI: "1",
    ...extra,
  };
}

export class ProcessRunner {
  run(executable: string, args: readonly string[], options: RunOptions): Promise<CommandResult> {
    if (!executable.startsWith("/") || args.some((arg) => arg.includes("\0"))) {
      throw new Error("Executable and argv must be validated before execution");
    }
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: options.env ? { ...options.env } : minimalEnvironment(),
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let truncated = false;
      let capturedBytes = 0;
      let checkpointBuffer = "";
      let outputCheckpoint: string | undefined;
      let checkpointNonce: string | undefined;
      let currentFile: string | undefined;
      let fileState: string | undefined;
      let lastFinished: string | undefined;
      let metrics: string | undefined;
      const unfinishedCases = new Set<string>();
      let timedOut = false;
      let timeoutCheckpoint: string | undefined;
      let termOutcome = "not-sent";
      let killOutcome = "not-sent";
      const marker = /^\[dispatcher-test:([a-f0-9]{32})\] (file-(?:start|finish|fail)) (test\/[A-Za-z0-9._-]+\.test\.ts)(?: elapsed_ms=(\d{1,9}))?(?: load=(\d+\.\d{3}))?$/;
      const caseMarker = /^\[dispatcher-test:([a-f0-9]{32})\] (case-(?:start|finish|fail)) (test\/[A-Za-z0-9._-]+\.test\.ts:[a-f0-9]{12}#\d+)(?: elapsed_ms=(\d{1,9}))?$/;
      const metricsMarker = /^\[dispatcher-test:([a-f0-9]{32})\] metrics scope=2;(node=\d+\/\d+,git=\d+\/\d+,shell=\d+\/\d+,other=\d+\/\d+;active=\d+;overhead_us=\d+)$/;
      const refreshCheckpoint = (): void => {
        if (timeoutCheckpoint) {
          outputCheckpoint = timeoutCheckpoint;
          return;
        }
        const unfinished = [...unfinishedCases].at(-1) ?? currentFile ?? "none";
        outputCheckpoint = `file=${fileState ?? "none"}; last_finish=${lastFinished ?? "none"}; unfinished=${unfinished}${metrics ? `; ${metrics}` : ""}`;
      };
      const inspectCheckpoints = (chunk: Buffer<ArrayBufferLike>): void => {
        const lines = (checkpointBuffer + chunk.toString("utf8")).split(/\r?\n/);
        checkpointBuffer = (lines.pop() ?? "").slice(-256);
        for (const line of lines) {
          const metricsMatch = metricsMarker.exec(line);
          if (metricsMatch && metricsMatch[1] === checkpointNonce) {
            metrics = `metrics=${metricsMatch[2]}`;
            refreshCheckpoint();
            continue;
          }
          const fileMatch = marker.exec(line);
          if (fileMatch) {
            const nonce = fileMatch[1];
            const action = fileMatch[2];
            const identity = fileMatch[3];
            if (!nonce || !action || !identity) continue;
            if (!checkpointNonce && action === "file-start") checkpointNonce = nonce;
            if (nonce !== checkpointNonce) continue;
            if (action === "file-start") metrics = undefined;
            fileState = `${action} ${identity}${fileMatch[4] ? ` elapsed_ms=${fileMatch[4]}` : ""}${fileMatch[5] ? ` load=${fileMatch[5]}` : ""}`;
            if (action === "file-start") currentFile = identity;
            else {
              if (!lastFinished) lastFinished = fileState;
              currentFile = undefined;
              unfinishedCases.clear();
              checkpointNonce = undefined;
            }
            refreshCheckpoint();
            continue;
          }
          const testMatch = caseMarker.exec(line);
          const nonce = testMatch?.[1];
          const action = testMatch?.[2];
          const identity = testMatch?.[3];
          if (!nonce || nonce !== checkpointNonce || !action || !identity) continue;
          if (action === "case-start") unfinishedCases.add(identity);
          else {
            unfinishedCases.delete(identity);
            lastFinished = `${action} ${identity}${testMatch[4] ? ` elapsed_ms=${testMatch[4]}` : ""}`;
          }
          refreshCheckpoint();
        }
      };
      const append = (
        current: Buffer<ArrayBufferLike>,
        chunk: Buffer<ArrayBufferLike>,
        inspect: boolean,
      ): Buffer<ArrayBufferLike> => {
        if (inspect) inspectCheckpoints(chunk);
        if (capturedBytes >= options.outputLimitBytes) {
          truncated = true;
          return current;
        }
        const remaining = options.outputLimitBytes - capturedBytes;
        if (chunk.length > remaining) truncated = true;
        const captured = chunk.subarray(0, remaining);
        capturedBytes += captured.length;
        return Buffer.concat([current, captured]);
      };
      child.stdout.on("data", (chunk: Buffer) => void (stdout = append(stdout, chunk, false)));
      child.stderr.on("data", (chunk: Buffer) => void (stderr = append(stderr, chunk, true)));
      let hardKillTimer: NodeJS.Timeout | undefined;
      let closedCode: number | null | undefined;
      let exitSignal: NodeJS.Signals | null = null;
      const finish = (): void => {
        if (closedCode === undefined) return;
        const cleanupStatus = timedOut
          ? `term=${termOutcome},kill=${killOutcome},closed=yes`
          : "term=not-sent,kill=not-sent,closed=yes";
        resolve({
          exit_code: closedCode,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          timed_out: timedOut,
          output_truncated: truncated,
          ...(outputCheckpoint ? { output_checkpoint: outputCheckpoint } : {}),
          ...(exitSignal ? { exit_signal: exitSignal } : {}),
          cleanup_status: cleanupStatus,
        });
      };
      const signalGroup = (signal: NodeJS.Signals): string => {
        if (child.pid) {
          try {
            process.kill(-child.pid, signal);
            return "group-sent";
          } catch {
            // Fall back to the direct child when process groups are unavailable.
          }
        }
        return child.kill(signal) ? "child-sent" : "unavailable";
      };
      const timer = setTimeout(() => {
        timedOut = true;
        const unfinished = [...unfinishedCases].at(-1) ?? currentFile ?? "none";
        timeoutCheckpoint = `file=${fileState ?? "none"}; last_finish=${lastFinished ?? "none"}; timeout=${unfinished}${metrics ? `; ${metrics}` : ""}`;
        outputCheckpoint = timeoutCheckpoint;
        termOutcome = signalGroup("SIGTERM");
        hardKillTimer = setTimeout(() => {
          killOutcome = signalGroup("SIGKILL");
          hardKillTimer = undefined;
          finish();
        }, 1_000);
      }, options.timeoutMs);
      timer.unref();
      child.once("error", (error) => {
        clearTimeout(timer);
        if (hardKillTimer) clearTimeout(hardKillTimer);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        closedCode = code;
        exitSignal = signal;
        if (!hardKillTimer) finish();
      });
    });
  }
}
