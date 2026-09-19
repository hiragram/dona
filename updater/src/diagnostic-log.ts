import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { ulid } from "ulid";

import { redactText } from "./redaction.js";
import type {
  DiagnosticLogCapture,
  DiagnosticLogIdentity,
  DiagnosticLogRow,
  DiagnosticLogState,
} from "./types.js";

const identifier = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const logIdentifier = /^log_[0-9a-hjkmnp-tv-z]{26}$/;
const maxCarryCharacters = 4_096;

export interface DiagnosticLogIndex {
  reserveDiagnosticLog(capture: DiagnosticLogCapture): void;
  finalizeDiagnosticLog(capture: DiagnosticLogCapture): void;
  discardDiagnosticLog(logId: string): void;
  diagnosticLogs(requestId: string): DiagnosticLogRow[];
  diagnosticRetentionCandidates(cutoff: Date, aggregateLimitBytes: number): DiagnosticLogRow[];
  markDiagnosticPurged(logId: string, at?: Date): void;
}

function validateIdentity(identity: DiagnosticLogIdentity): void {
  if (!/^upd_[0-9a-z]{26}$/.test(identity.request_id) || !Number.isSafeInteger(identity.attempt) || identity.attempt < 1 ||
    !identifier.test(identity.step)) throw new Error("diagnostic_log_identity_invalid");
}

class StreamingRedactor {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private droppingSensitive = false;

  write(chunk: Buffer): string {
    this.pending += this.decoder.write(chunk);
    return this.drain(false);
  }

  finish(): string {
    this.pending += this.decoder.end();
    return this.drain(true);
  }

  private drain(final: boolean): string {
    let output = "";
    while (this.pending.length > 0) {
      if (this.droppingSensitive) {
        const boundary = this.pending.search(/[\s"'<>]/);
        if (boundary < 0) {
          if (final) this.pending = "";
          return output;
        }
        output += "[REDACTED_STREAM]";
        this.pending = this.pending.slice(boundary);
        this.droppingSensitive = false;
        continue;
      }
      if (final) {
        output += redactText(this.pending, Number.MAX_SAFE_INTEGER);
        this.pending = "";
        return output;
      }
      let lastBoundary = -1;
      for (const match of this.pending.matchAll(/[\s"'<>]/g)) lastBoundary = match.index;
      if (lastBoundary >= 0) {
        const safe = this.pending.slice(0, lastBoundary + 1);
        const assignment = /(?:^|\s)(?:authorization|token|secret|password)\s*[:=]?\s*$/i.exec(safe);
        if (assignment?.index !== undefined) {
          output += redactText(safe.slice(0, assignment.index), Number.MAX_SAFE_INTEGER);
          this.pending = safe.slice(assignment.index) + this.pending.slice(lastBoundary + 1);
          if (this.pending.length <= maxCarryCharacters) return output;
          output += "[REDACTED_STREAM]";
          this.pending = "";
          this.droppingSensitive = true;
          return output;
        }
        output += redactText(safe, Number.MAX_SAFE_INTEGER);
        this.pending = this.pending.slice(lastBoundary + 1);
        continue;
      }
      if (this.pending.length <= maxCarryCharacters) return output;
      if (/^(?:xapp|xox[abp]|ghp|github_pat)[-_]|^https?:\/\/|^\/(?:Users|home|private|var\/folders|tmp)\/|^(?:authorization|token|secret|password)\s*[:=]/i.test(this.pending)) {
        this.pending = "";
        this.droppingSensitive = true;
        continue;
      }
      const emitLength = this.pending.length - maxCarryCharacters;
      output += redactText(this.pending.slice(0, emitLength), Number.MAX_SAFE_INTEGER);
      this.pending = this.pending.slice(emitLength);
    }
    return output;
  }
}

export interface DiagnosticCaptureSession {
  write(stream: "stdout" | "stderr", chunk: Buffer): void;
  finish(failed: boolean): DiagnosticLogCapture | undefined;
}

export class DiagnosticLogStore {
  private readonly root: string;
  private readonly logsRoot: string;

  constructor(
    controlRoot: string,
    private readonly perLogLimitBytes: number,
    private readonly index?: DiagnosticLogIndex,
  ) {
    this.root = path.join(controlRoot, "diagnostics");
    this.logsRoot = path.join(this.root, "logs");
  }

  start(identity: DiagnosticLogIdentity, at = new Date()): DiagnosticCaptureSession {
    validateIdentity(identity);
    const logId = `log_${ulid().toLowerCase()}`;
    const relativeRef = `logs/${logId}.log`;
    const initial: DiagnosticLogCapture = {
      ...identity,
      log_id: logId,
      relative_ref: relativeRef,
      byte_size: 0,
      capture_state: "write_failed",
      error_code: null,
      created_at: at.toISOString(),
      finalized_at: at.toISOString(),
    };
    this.index?.reserveDiagnosticLog(initial);
    try {
      this.ensurePrivateDirectory(this.root);
      this.ensurePrivateDirectory(this.logsRoot);
    } catch {
      const failed = { ...initial, relative_ref: null, error_code: "diagnostic_root_unavailable" };
      return { write() {}, finish: (commandFailed) => {
        try {
          if (commandFailed) this.index?.finalizeDiagnosticLog(failed);
          else this.index?.discardDiagnosticLog(logId);
        } catch { /* diagnostic failure must not hide command outcome */ }
        return commandFailed ? failed : undefined;
      } };
    }
    const temporary = path.join(this.logsRoot, `${logId}.part`);
    const finalPath = path.join(this.logsRoot, `${logId}.log`);
    let descriptor: number;
    try {
      descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o077) !== 0 || opened.uid !== process.getuid?.()) {
        throw new Error("diagnostic_temp_not_private");
      }
    } catch {
      const failed = { ...initial, relative_ref: null, error_code: "diagnostic_open_failed" };
      return { write() {}, finish: (commandFailed) => {
        try {
          if (commandFailed) this.index?.finalizeDiagnosticLog(failed);
          else this.index?.discardDiagnosticLog(logId);
        } catch { /* diagnostic failure must not hide command outcome */ }
        return commandFailed ? failed : undefined;
      } };
    }
    const redactors = { stdout: new StreamingRedactor(), stderr: new StreamingRedactor() };
    let bytes = 0;
    let truncated = false;
    let writeFailed = false;
    const append = (stream: "stdout" | "stderr", text: string): void => {
      if (!text || writeFailed || truncated) return;
      let offset = 0;
      while (offset < text.length && !writeFailed && !truncated) {
        let end = Math.min(text.length, offset + 1_024);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
        const encoded = Buffer.from(`[${stream}] ${text.slice(offset, end)}`, "utf8");
        const remaining = this.perLogLimitBytes - bytes;
        if (remaining <= 0) { truncated = true; break; }
        const selected = encoded.subarray(0, remaining);
        try {
          fs.writeSync(descriptor, selected);
          bytes += selected.length;
          if (selected.length < encoded.length) truncated = true;
        } catch {
          writeFailed = true;
        }
        offset = end;
      }
    };
    let finished = false;
    return {
      write: (stream, chunk) => append(stream, redactors[stream].write(chunk)),
      finish: (commandFailed) => {
        if (finished) return undefined;
        finished = true;
        append("stdout", redactors.stdout.finish());
        append("stderr", redactors.stderr.finish());
        if (!commandFailed) {
          try { fs.closeSync(descriptor); } catch { /* best effort */ }
          try { fs.unlinkSync(temporary); } catch { /* best effort */ }
          try { this.index?.discardDiagnosticLog(logId); } catch { /* diagnostic cleanup is subordinate to command success */ }
          return undefined;
        }
        let errorCode: string | null = null;
        try {
          if (writeFailed) throw new Error("write");
          fs.fsyncSync(descriptor);
          fs.closeSync(descriptor);
          const temporaryStats = fs.lstatSync(temporary);
          if (!temporaryStats.isFile() || temporaryStats.isSymbolicLink() || temporaryStats.nlink !== 1 ||
            (temporaryStats.mode & 0o077) !== 0 || temporaryStats.uid !== process.getuid?.() ||
            temporaryStats.size !== bytes || fs.existsSync(finalPath)) {
            throw new Error("unsafe_finalize");
          }
          this.assertPrivateDirectory(this.root);
          this.assertPrivateDirectory(this.logsRoot);
          // link+unlink gives an atomic no-clobber publish on the same filesystem.
          // A crash between the calls leaves nlink=2, which the read path rejects.
          fs.linkSync(temporary, finalPath);
          fs.unlinkSync(temporary);
          fs.chmodSync(finalPath, 0o600);
          const directory = fs.openSync(this.logsRoot, fs.constants.O_RDONLY);
          try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
        } catch {
          errorCode = writeFailed ? "diagnostic_write_failed" : "diagnostic_finalize_failed";
          try { fs.closeSync(descriptor); } catch { /* already closed */ }
          try { fs.unlinkSync(temporary); } catch { /* best effort */ }
        }
        const capture: DiagnosticLogCapture = {
          ...initial,
          relative_ref: errorCode ? null : relativeRef,
          byte_size: errorCode ? 0 : bytes,
          capture_state: errorCode ? "write_failed" : truncated ? "truncated" : "complete",
          error_code: errorCode,
          finalized_at: new Date().toISOString(),
        };
        try { this.index?.finalizeDiagnosticLog(capture); } catch {
          try { if (capture.relative_ref) fs.unlinkSync(finalPath); } catch { /* best effort */ }
          return { ...capture, relative_ref: null, byte_size: 0, capture_state: "write_failed", error_code: "diagnostic_index_write_failed" };
        }
        return capture;
      },
    };
  }

  project(row: DiagnosticLogRow, previewLimitBytes = 4_096, expectedRequestId = row.request_id): Record<string, unknown> {
    const common = {
      log_id: row.log_id,
      attempt: row.attempt,
      step: row.step,
      byte_size: row.byte_size,
    };
    if (row.request_id !== expectedRequestId) {
      return { ...common, capture_state: "read_error" satisfies DiagnosticLogState, error_code: "diagnostic_request_binding_mismatch" };
    }
    if (row.capture_state === "purged" || row.capture_state === "write_failed" || row.capture_state === "capturing") {
      return { ...common, capture_state: row.capture_state, error_code: row.error_code };
    }
    try {
      const file = this.resolveRow(row);
      const stats = fs.lstatSync(file);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || (stats.mode & 0o077) !== 0 ||
        stats.uid !== process.getuid?.()) {
        return { ...common, capture_state: "read_error" satisfies DiagnosticLogState, error_code: "diagnostic_file_unsafe" };
      }
      if (stats.size !== row.byte_size) {
        return { ...common, capture_state: "size_mismatch" satisfies DiagnosticLogState, error_code: "diagnostic_size_mismatch" };
      }
      const start = Math.max(0, stats.size - previewLimitBytes);
      const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const buffer = Buffer.alloc(stats.size - start);
        fs.readSync(descriptor, buffer, 0, buffer.length, start);
        return { ...common, capture_state: row.capture_state, detail_tail: buffer.toString("utf8") };
      } finally {
        fs.closeSync(descriptor);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        ...common,
        capture_state: code === "ENOENT" ? "missing" satisfies DiagnosticLogState : "read_error" satisfies DiagnosticLogState,
        error_code: code === "ENOENT" ? "diagnostic_file_missing" : "diagnostic_read_failed",
      };
    }
  }

  enforceRetention(now: Date, retentionDays: number, aggregateLimitBytes: number): void {
    if (!this.index) return;
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    for (const row of this.index.diagnosticRetentionCandidates(cutoff, aggregateLimitBytes)) {
      try {
        if (row.relative_ref) fs.unlinkSync(this.resolveRow(row));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
      this.index.markDiagnosticPurged(row.log_id, now);
    }
  }

  private ensurePrivateDirectory(directory: string): void {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.assertPrivateDirectory(directory);
    fs.chmodSync(directory, 0o700);
  }

  private assertPrivateDirectory(directory: string): void {
    const stats = fs.lstatSync(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.()) {
      throw new Error("diagnostic_directory_unsafe");
    }
  }

  private resolveRow(row: Pick<DiagnosticLogRow, "log_id" | "relative_ref">): string {
    if (!logIdentifier.test(row.log_id) || row.relative_ref !== `logs/${row.log_id}.log`) {
      throw new Error("diagnostic_reference_invalid");
    }
    this.assertPrivateDirectory(this.root);
    this.assertPrivateDirectory(this.logsRoot);
    const resolved = path.resolve(this.root, row.relative_ref);
    if (path.dirname(resolved) !== this.logsRoot) throw new Error("diagnostic_reference_outside_root");
    return resolved;
  }
}
