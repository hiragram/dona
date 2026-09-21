import { spawn } from "node:child_process";

import type { DiagnosticLogIdentity, CommandResult } from "./types.js";
import type { DiagnosticCaptureSession, DiagnosticLogStore } from "./diagnostic-log.js";
import { ProcessCheckpointTracker } from "./process-checkpoint.js";

export interface RunOptions {
  cwd?: string;
  timeoutMs: number;
  outputLimitBytes: number;
  env?: Readonly<Record<string, string>>;
  diagnostic?: { store: DiagnosticLogStore; identity: DiagnosticLogIdentity };
  /** Test fixtures may shorten the timeout after the child reports ready. */
  timeoutStartAfter?: Promise<void>;
  /** The post-readiness timeout; timeoutMs remains the absolute upper bound. */
  timeoutAfterReadyMs?: number;
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
    if (options.timeoutStartAfter && (!options.timeoutAfterReadyMs || options.timeoutAfterReadyMs <= 0)) {
      throw new Error("timeoutAfterReadyMs is required with timeoutStartAfter");
    }
    if (!options.timeoutStartAfter && options.timeoutAfterReadyMs !== undefined) {
      throw new Error("timeoutStartAfter is required with timeoutAfterReadyMs");
    }
    return new Promise((resolve) => {
      let diagnostic: DiagnosticCaptureSession | undefined;
      try {
        diagnostic = options.diagnostic?.store.start(options.diagnostic.identity);
      } catch {
        // Diagnostic persistence is subordinate to the command. An unavailable
        // index must not prevent the command from running or alter its result.
        diagnostic = undefined;
      }
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
      const checkpoints = new ProcessCheckpointTracker();
      let timedOut = false;
      let readinessFailed = false;
      let settled = false;
      let termOutcome = "not-sent";
      let killOutcome = "not-sent";
      const append = (
        current: Buffer<ArrayBufferLike>,
        chunk: Buffer<ArrayBufferLike>,
        inspect: boolean,
      ): Buffer<ArrayBufferLike> => {
        if (inspect) checkpoints.inspect(chunk);
        if (current.length >= options.outputLimitBytes) {
          truncated = true;
          return current;
        }
        const remaining = options.outputLimitBytes - current.length;
        if (chunk.length > remaining) truncated = true;
        const captured = chunk.subarray(0, remaining);
        return Buffer.concat([current, captured]);
      };
      const rebalance = (): void => {
        const overflow = stdout.length + stderr.length - options.outputLimitBytes;
        if (overflow <= 0) return;
        truncated = true;
        if (stdout.length >= stderr.length) stdout = stdout.subarray(Math.min(overflow, stdout.length));
        else stderr = stderr.subarray(Math.min(overflow, stderr.length));
      };
      const writeDiagnostic = (stream: "stdout" | "stderr", chunk: Buffer): void => {
        try { diagnostic?.write(stream, chunk); } catch { /* command capture remains authoritative */ }
      };
      const finishDiagnostic = (failed: boolean) => {
        try { return diagnostic?.finish(failed); } catch { return undefined; }
      };
      child.stdout.on("data", (chunk: Buffer) => { writeDiagnostic("stdout", chunk); stdout = append(stdout, chunk, false); rebalance(); });
      child.stderr.on("data", (chunk: Buffer) => { writeDiagnostic("stderr", chunk); stderr = append(stderr, chunk, true); rebalance(); });
      let hardKillTimer: NodeJS.Timeout | undefined;
      let cleanupPollTimer: NodeJS.Timeout | undefined;
      let closedCode: number | null | undefined;
      let exitSignal: NodeJS.Signals | null = null;
      const finish = (): void => {
        if (closedCode === undefined || settled) return;
        settled = true;
        const outputCheckpoint = checkpoints.checkpoint();
        const cleanupStatus = timedOut || readinessFailed
          ? `term=${termOutcome},kill=${killOutcome},closed=yes`
          : "term=not-sent,kill=not-sent,closed=yes";
        const diagnosticLog = finishDiagnostic(timedOut || readinessFailed || closedCode !== 0);
        resolve({
          exit_code: closedCode,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          timed_out: timedOut,
          output_truncated: truncated,
          ...(outputCheckpoint ? { output_checkpoint: outputCheckpoint } : {}),
          ...(exitSignal ? { exit_signal: exitSignal } : {}),
          ...(readinessFailed ? { spawn_error: "readiness_failed" } : {}),
          cleanup_status: cleanupStatus,
          ...(diagnosticLog ? { diagnostic_log: diagnosticLog } : {}),
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
      const finishAfterGroupCleanup = (): void => {
        if (!child.pid) { finish(); return; }
        const deadline = Date.now() + 1_000;
        const poll = (): void => {
          try {
            process.kill(-child.pid!, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") {
              cleanupPollTimer = undefined;
              finish();
              return;
            }
          }
          if (Date.now() >= deadline) {
            cleanupPollTimer = undefined;
            finish();
            return;
          }
          cleanupPollTimer = setTimeout(poll, 20);
        };
        poll();
      };
      let timer: NodeJS.Timeout | undefined;
      const terminate = (reason: "timeout" | "readiness_failed"): void => {
        if (settled || timedOut || readinessFailed) return;
        if (reason === "timeout") {
          timedOut = true;
          checkpoints.freezeTimeout();
        } else {
          readinessFailed = true;
        }
        termOutcome = signalGroup("SIGTERM");
        hardKillTimer = setTimeout(() => {
          killOutcome = signalGroup("SIGKILL");
          hardKillTimer = undefined;
          finishAfterGroupCleanup();
        }, 1_000);
      };
      const timeOut = (): void => terminate("timeout");
      const armCommandTimeout = (timeoutMs: number): void => {
        if (settled || timedOut || readinessFailed) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(timeOut, timeoutMs);
        timer.unref();
      };
      const timeoutStartedAt = Date.now();
      armCommandTimeout(options.timeoutMs);
      if (options.timeoutStartAfter) {
        void options.timeoutStartAfter.then(() => {
          const remainingMs = Math.max(0, options.timeoutMs - (Date.now() - timeoutStartedAt));
          armCommandTimeout(Math.min(options.timeoutAfterReadyMs!, remainingMs));
        }, () => terminate("readiness_failed"));
      }
      child.once("error", (error) => {
        if (timer) clearTimeout(timer);
        if (hardKillTimer) clearTimeout(hardKillTimer);
        if (cleanupPollTimer) clearTimeout(cleanupPollTimer);
        if (settled) return;
        settled = true;
        const diagnosticLog = finishDiagnostic(true);
        resolve({
          exit_code: null,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          timed_out: false,
          output_truncated: truncated,
          spawn_error: (error as NodeJS.ErrnoException).code ?? "spawn_error",
          cleanup_status: "spawn-failed",
          ...(diagnosticLog ? { diagnostic_log: diagnosticLog } : {}),
        });
      });
      child.once("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        closedCode = code;
        exitSignal = signal;
        if (!hardKillTimer && !cleanupPollTimer) finish();
      });
    });
  }
}
