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
      const tailLimitBytes = Math.min(4_096, Math.floor(options.outputLimitBytes / 2));
      const headLimitBytes = options.outputLimitBytes - tailLimitBytes;
      let outputTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let timedOut = false;
      const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
        outputTail = Buffer.concat([outputTail, chunk]);
        if (outputTail.length > tailLimitBytes) outputTail = outputTail.subarray(outputTail.length - tailLimitBytes);
        if (capturedBytes >= headLimitBytes) {
          truncated = true;
          return current;
        }
        const remaining = headLimitBytes - capturedBytes;
        if (chunk.length > remaining) truncated = true;
        const captured = chunk.subarray(0, remaining);
        capturedBytes += captured.length;
        return Buffer.concat([current, captured]);
      };
      child.stdout.on("data", (chunk: Buffer) => void (stdout = append(stdout, chunk)));
      child.stderr.on("data", (chunk: Buffer) => void (stderr = append(stderr, chunk)));
      let hardKillTimer: NodeJS.Timeout | undefined;
      let closedCode: number | null | undefined;
      const finish = (): void => {
        if (closedCode === undefined) return;
        resolve({
          exit_code: closedCode,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          timed_out: timedOut,
          output_truncated: truncated,
          ...(truncated ? { output_tail: outputTail.toString("utf8") } : {}),
        });
      };
      const signalGroup = (signal: NodeJS.Signals): void => {
        if (child.pid) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // Fall back to the direct child when process groups are unavailable.
          }
        }
        child.kill(signal);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        signalGroup("SIGTERM");
        hardKillTimer = setTimeout(() => {
          signalGroup("SIGKILL");
          hardKillTimer = undefined;
          finish();
        }, 1_000);
        hardKillTimer.unref();
      }, options.timeoutMs);
      timer.unref();
      child.once("error", (error) => {
        clearTimeout(timer);
        if (hardKillTimer) clearTimeout(hardKillTimer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        closedCode = code;
        if (!hardKillTimer) finish();
      });
    });
  }
}
