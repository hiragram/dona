import { createHash } from "node:crypto";
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
  recordFailedDiagnosticLog(capture: DiagnosticLogCapture): void;
  finalizeDiagnosticLog(capture: DiagnosticLogCapture): void;
  discardDiagnosticLog(logId: string): void;
  diagnosticLogs(requestId: string): DiagnosticLogRow[];
  capturingDiagnosticLogs(): DiagnosticLogRow[];
  interruptDiagnosticLog(logId: string, errorCode: string, at?: Date): void;
  diagnosticRetentionLogs(): DiagnosticLogRow[];
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
  private droppingQuote: "\"" | "'" | undefined;
  private quoteBackslashParity = false;

  constructor(private readonly privateRoots: readonly string[] = []) {}

  write(chunk: Buffer): RedactedChunk {
    const decoded = this.decoder.write(chunk);
    this.pending += decoded;
    return { ...this.drain(false), decoded };
  }

  finish(): RedactedChunk {
    const decoded = this.decoder.end();
    this.pending += decoded;
    return { ...this.drain(true), decoded };
  }

  hasPending(): boolean {
    return this.pending.length > 0 || this.droppingSensitive;
  }

  private drain(final: boolean): Omit<RedactedChunk, "decoded"> {
    const initialLength = this.pending.length;
    let output = "";
    while (this.pending.length > 0) {
      if (this.droppingSensitive) {
        const boundary = this.droppingQuote
          ? this.findClosingQuote(this.droppingQuote)
          : this.pending.search(/[\r\n]/);
        if (boundary < 0) {
          // The whole carried value is sensitive. Drop it immediately so an
          // unterminated quoted value cannot grow memory without bound.
          this.pending = "";
          return { text: output, consumedCharacters: initialLength };
        }
        output += "[REDACTED_STREAM]";
        this.pending = this.pending.slice(boundary + (this.droppingQuote ? 1 : 0));
        this.droppingSensitive = false;
        this.droppingQuote = undefined;
        this.quoteBackslashParity = false;
        continue;
      }
      const assignment = /(?:^|[^a-z0-9_-])(?:"[a-z0-9_-]*(?:authorization|auth[-_]?token|_auth|api[-_]?key|private[-_]?key|token|secret|password)[a-z0-9_-]*"|'[a-z0-9_-]*(?:authorization|auth[-_]?token|_auth|api[-_]?key|private[-_]?key|token|secret|password)[a-z0-9_-]*'|[a-z0-9_-]*(?:authorization|auth[-_]?token|_auth|api[-_]?key|private[-_]?key|token|secret|password)[a-z0-9_-]*)\s*[:=]\s*(["']?)/i
        .exec(this.pending);
      if (assignment?.index !== undefined) {
        output += redactText(this.pending.slice(0, assignment.index), Number.MAX_SAFE_INTEGER);
        this.pending = this.pending.slice(assignment.index + assignment[0].length);
        this.droppingSensitive = true;
        this.droppingQuote = assignment[1] === "\"" || assignment[1] === "'" ? assignment[1] : undefined;
        continue;
      }
      const localPath = /\/(?:Users|home|private|var\/folders|tmp)\//i.exec(this.pending);
      if (localPath?.index !== undefined) {
        output += redactText(this.pending.slice(0, localPath.index), Number.MAX_SAFE_INTEGER);
        output += "[REDACTED_STREAM]";
        this.pending = this.pending.slice(localPath.index + localPath[0].length);
        this.droppingSensitive = true;
        this.droppingQuote = undefined;
        continue;
      }
      const configuredPath = this.privateRoots
        .map((root) => ({ index: this.pending.indexOf(root), root }))
        .filter((match) => match.index >= 0)
        .sort((left, right) => left.index - right.index || right.root.length - left.root.length)[0];
      if (configuredPath) {
        output += redactText(this.pending.slice(0, configuredPath.index), Number.MAX_SAFE_INTEGER);
        output += "[REDACTED_STREAM]";
        this.pending = this.pending.slice(configuredPath.index + configuredPath.root.length);
        this.droppingSensitive = true;
        this.droppingQuote = undefined;
        continue;
      }
      const credentialUri = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>/@:]*:[^\s"'<>/@]*@[^\s"'<>]*/i.exec(this.pending);
      if (credentialUri?.index !== undefined) {
        output += redactText(this.pending.slice(0, credentialUri.index), Number.MAX_SAFE_INTEGER);
        output += "[REDACTED_STREAM]";
        this.pending = this.pending.slice(credentialUri.index + credentialUri[0].length);
        continue;
      }
      if (final) {
        output += redactText(this.pending, Number.MAX_SAFE_INTEGER);
        this.pending = "";
        return { text: output, consumedCharacters: initialLength };
      }
      let configuredCarryStart = this.pending.length;
      for (const root of this.privateRoots) {
        const maximum = Math.min(root.length - 1, this.pending.length);
        for (let length = maximum; length > 0; length -= 1) {
          if (this.pending.endsWith(root.slice(0, length))) {
            configuredCarryStart = Math.min(configuredCarryStart, this.pending.length - length);
            break;
          }
        }
      }
      if (configuredCarryStart < this.pending.length) {
        output += redactText(this.pending.slice(0, configuredCarryStart), Number.MAX_SAFE_INTEGER);
        this.pending = this.pending.slice(configuredCarryStart);
        return { text: output, consumedCharacters: initialLength - this.pending.length };
      }
      const partialQuotedKey = /(?:^|[^a-z0-9_-])["'][a-z0-9_-]*$/i.exec(this.pending);
      if (partialQuotedKey?.index !== undefined) {
        output += redactText(this.pending.slice(0, partialQuotedKey.index), Number.MAX_SAFE_INTEGER);
        this.pending = this.pending.slice(partialQuotedKey.index);
        if (this.pending.length > maxCarryCharacters) {
          output += "[REDACTED_STREAM]";
          this.pending = "";
          this.droppingSensitive = true;
          this.droppingQuote = undefined;
        }
        return { text: output, consumedCharacters: initialLength - this.pending.length };
      }
      let lastBoundary = -1;
      for (const match of this.pending.matchAll(/[\s"'<>]/g)) lastBoundary = match.index;
      if (lastBoundary >= 0) {
        const safe = this.pending.slice(0, lastBoundary + 1);
        const partialAssignment = /(?:^|[^a-z0-9_-])(?:"[a-z0-9_-]*(?:authorization|auth[-_]?token|_auth|api[-_]?key|private[-_]?key|token|secret|password)[a-z0-9_-]*"|'[a-z0-9_-]*(?:authorization|auth[-_]?token|_auth|api[-_]?key|private[-_]?key|token|secret|password)[a-z0-9_-]*'|[a-z0-9_-]*(?:authorization|auth[-_]?token|_auth|api[-_]?key|private[-_]?key|token|secret|password)[a-z0-9_-]*)\s*$/i.exec(safe);
        if (partialAssignment?.index !== undefined) {
          output += redactText(safe.slice(0, partialAssignment.index), Number.MAX_SAFE_INTEGER);
          this.pending = safe.slice(partialAssignment.index) + this.pending.slice(lastBoundary + 1);
          if (this.pending.length > maxCarryCharacters) {
            output += "[REDACTED_STREAM]";
            this.pending = "";
            this.droppingSensitive = true;
            this.droppingQuote = undefined;
          }
          return { text: output, consumedCharacters: initialLength - this.pending.length };
        }
        output += redactText(safe, Number.MAX_SAFE_INTEGER);
        this.pending = this.pending.slice(lastBoundary + 1);
        continue;
      }
      if (this.pending.length <= maxCarryCharacters) return { text: output, consumedCharacters: initialLength - this.pending.length };
      const sensitive = /(?:\b(?:xapp|xox[abp])[-_]|\b(?:ghp|github_pat)_|(?:^|[^a-z0-9_-])(?:"[a-z0-9_-]*(?:authorization|auth[-_]?token|_auth|api[-_]?key|private[-_]?key|token|secret|password)[a-z0-9_-]*"|'[a-z0-9_-]*(?:authorization|auth[-_]?token|_auth|api[-_]?key|private[-_]?key|token|secret|password)[a-z0-9_-]*'|[a-z0-9_-]*(?:authorization|auth[-_]?token|_auth|api[-_]?key|private[-_]?key|token|secret|password)[a-z0-9_-]*)\s*[:=]|\b[a-z][a-z0-9+.-]*:\/\/|\/(?:Users|home|private|var\/folders|tmp)\/)/i.exec(this.pending);
      if (sensitive?.index !== undefined) {
        output += redactText(this.pending.slice(0, sensitive.index), Number.MAX_SAFE_INTEGER);
        this.pending = this.pending.slice(sensitive.index);
        this.droppingSensitive = true;
        continue;
      }
      const emitLength = this.pending.length - maxCarryCharacters;
      output += redactText(this.pending.slice(0, emitLength), Number.MAX_SAFE_INTEGER);
      this.pending = this.pending.slice(emitLength);
    }
    return { text: output, consumedCharacters: initialLength - this.pending.length };
  }

  private findClosingQuote(quote: "\"" | "'"): number {
    let escaped = this.quoteBackslashParity;
    for (let index = 0; index < this.pending.length; index += 1) {
      const character = this.pending[index]!;
      if (character === quote && !escaped) return index;
      escaped = character === "\\" ? !escaped : false;
    }
    this.quoteBackslashParity = escaped;
    return -1;
  }
}

interface RedactedChunk {
  text: string;
  decoded: string;
  consumedCharacters: number;
}

export interface DiagnosticCaptureSession {
  write(stream: "stdout" | "stderr", chunk: Buffer): void;
  finish(failed: boolean): DiagnosticLogCapture | undefined;
}

export class DiagnosticLogStore {
  private readonly root: string;
  private readonly logsRoot: string;
  private readonly privateRoots: readonly string[];

  constructor(
    controlRoot: string,
    private readonly perLogLimitBytes: number,
    private readonly index?: DiagnosticLogIndex,
    privateRoots: readonly string[] = [],
  ) {
    this.root = path.join(controlRoot, "diagnostics");
    this.logsRoot = path.join(this.root, "logs");
    this.privateRoots = [...new Set([controlRoot, ...privateRoots])]
      .filter((root) => path.isAbsolute(root))
      .sort((left, right) => right.length - left.length);
  }

  recoverInterruptedCaptures(at = new Date()): void {
    if (!this.index) return;
    for (const row of this.index.capturingDiagnosticLogs()) {
      try {
        if (!logIdentifier.test(row.log_id) || row.relative_ref !== `logs/${row.log_id}.log`) {
          throw new Error("diagnostic_reference_invalid");
        }
        const temporary = path.join(this.logsRoot, `${row.log_id}.part`);
        const finalPath = path.join(this.logsRoot, `${row.log_id}.log`);
        let entries: Array<{ path: string; stats: fs.Stats }> = [];
        try {
          this.assertPrivateDirectory(this.root);
          this.assertPrivateDirectory(this.logsRoot);
          entries = [temporary, finalPath].flatMap((candidate) => {
            try { return [{ path: candidate, stats: fs.lstatSync(candidate) }]; }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
              throw error;
            }
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        for (const entry of entries) {
          if (!entry.stats.isFile() || entry.stats.isSymbolicLink() || (entry.stats.mode & 0o077) !== 0 ||
            entry.stats.uid !== process.getuid?.()) throw new Error("diagnostic_recovery_file_unsafe");
        }
        if (entries.length === 1 && entries[0]!.stats.nlink !== 1) throw new Error("diagnostic_recovery_link_unsafe");
        if (entries.length === 2) {
          const [first, second] = entries;
          if (first!.stats.nlink !== 2 || second!.stats.nlink !== 2 ||
            first!.stats.dev !== second!.stats.dev || first!.stats.ino !== second!.stats.ino) {
            throw new Error("diagnostic_recovery_link_unsafe");
          }
        }
        for (const entry of entries) fs.unlinkSync(entry.path);
        // The files may already be absent because a previous cleanup unlinked
        // them but failed before its directory fsync. Make that absence durable
        // before dropping the DB reference in every case.
        this.fsyncLogsDirectory();
      } catch {
        // Keep the bound row intact so a later singleton startup can retry;
        // never turn an unremoved managed file into an unreferenced orphan.
        continue;
      }
      try { this.index.interruptDiagnosticLog(row.log_id, "diagnostic_capture_interrupted", at); }
      catch { /* recovery is diagnostic-only and must not prevent service startup */ }
    }
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
      content_sha256: null,
      capture_state: "write_failed",
      error_code: null,
      created_at: at.toISOString(),
      finalized_at: at.toISOString(),
    };
    try {
      this.ensurePrivateDirectory(this.root);
      this.ensurePrivateDirectory(this.logsRoot);
    } catch {
      const failed = { ...initial, relative_ref: null, error_code: "diagnostic_root_unavailable" };
      return { write() {}, finish: (commandFailed) => {
        if (commandFailed) {
          try { this.index?.recordFailedDiagnosticLog(failed); }
          catch { /* diagnostic failure must not hide command outcome */ }
        }
        return commandFailed ? failed : undefined;
      } };
    }
    this.index?.reserveDiagnosticLog(initial);
    const temporary = path.join(this.logsRoot, `${logId}.part`);
    const finalPath = path.join(this.logsRoot, `${logId}.log`);
    let descriptor = -1;
    try {
      descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o077) !== 0 || opened.uid !== process.getuid?.()) {
        throw new Error("diagnostic_temp_not_private");
      }
    } catch {
      let recoveryRequired = descriptor >= 0;
      if (descriptor >= 0) {
        try { fs.closeSync(descriptor); recoveryRequired = false; } catch { /* preserve the row and file for singleton recovery */ }
        if (!recoveryRequired) {
          try { this.cleanupFailedFinalize(temporary, finalPath, false); }
          catch { recoveryRequired = true; }
        }
      }
      const failed = {
        ...initial,
        relative_ref: recoveryRequired ? relativeRef : null,
        error_code: "diagnostic_open_failed",
      };
      return { write() {}, finish: (commandFailed) => {
        try {
          if (!recoveryRequired) {
            if (commandFailed) this.index?.finalizeDiagnosticLog(failed);
            else this.index?.discardDiagnosticLog(logId);
          }
        } catch { /* diagnostic failure must not hide command outcome */ }
        return commandFailed ? failed : undefined;
      } };
    }
    const redactors = {
      stdout: new StreamingRedactor(this.privateRoots),
      stderr: new StreamingRedactor(this.privateRoots),
    };
    let bytes = 0;
    const contentHash = createHash("sha256");
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
          let written = 0;
          while (written < selected.length) {
            const count = fs.writeSync(descriptor, selected, written, selected.length - written);
            if (count <= 0) throw new Error("diagnostic_short_write");
            contentHash.update(selected.subarray(written, written + count));
            written += count;
            bytes += count;
          }
          if (selected.length < encoded.length) truncated = true;
        } catch {
          writeFailed = true;
        }
        offset = end;
      }
    };
    interface OrderedOutput {
      stream: "stdout" | "stderr";
      text: string;
      remainingSource: string;
      resolved: boolean;
    }
    const orderedOutput: OrderedOutput[] = [];
    const streamOutput: Record<"stdout" | "stderr", OrderedOutput[]> = { stdout: [], stderr: [] };
    let orderedOutputBytes = 0;
    let orderedOutputTruncated = false;
    const queueText = (event: OrderedOutput, text: string): void => {
      if (!text || orderedOutputTruncated) return;
      const encoded = Buffer.from(text, "utf8");
      const remaining = Math.max(0, this.perLogLimitBytes - bytes - orderedOutputBytes);
      const selected = encoded.subarray(0, remaining);
      event.text += selected.toString("utf8");
      orderedOutputBytes += selected.length;
      if (selected.length < encoded.length) orderedOutputTruncated = true;
    };
    const flushOrderedOutput = (): void => {
      while (orderedOutput[0]?.resolved) {
        const next = orderedOutput.shift()!;
        orderedOutputBytes -= Buffer.byteLength(next.text, "utf8");
        append(next.stream, next.text);
      }
      if (orderedOutput.length === 0 && orderedOutputTruncated) truncated = true;
    };
    const applyRedacted = (stream: "stdout" | "stderr", redacted: RedactedChunk): void => {
      let remaining = redacted.consumedCharacters;
      const consumed: Array<{ event: OrderedOutput; source: string }> = [];
      for (const event of streamOutput[stream]) {
        if (remaining <= 0) break;
        const length = Math.min(remaining, event.remainingSource.length);
        if (length > 0) {
          consumed.push({ event, source: event.remainingSource.slice(0, length) });
          event.remainingSource = event.remainingSource.slice(length);
          remaining -= length;
        }
      }
      const original = consumed.map((entry) => entry.source).join("");
      if (original === redacted.text) {
        for (const entry of consumed) queueText(entry.event, entry.source);
      } else if (redacted.text) {
        const first = consumed[0]?.event ?? streamOutput[stream][0];
        if (first) queueText(first, redacted.text);
      }
      for (const event of streamOutput[stream]) {
        if (event.remainingSource.length > 0) break;
        event.resolved = true;
      }
      while (streamOutput[stream][0]?.resolved) streamOutput[stream].shift();
      flushOrderedOutput();
    };
    const redactInOrder = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      const redacted = redactors[stream].write(chunk);
      if (orderedOutputTruncated) {
        applyRedacted(stream, redacted);
        return;
      }
      const event = { stream, text: "", remainingSource: redacted.decoded, resolved: redacted.decoded.length === 0 };
      orderedOutput.push(event);
      if (!event.resolved) streamOutput[stream].push(event);
      applyRedacted(stream, redacted);
    };
    const finishRedactors = (): void => {
      for (const stream of ["stdout", "stderr"] as const) {
        const redacted = redactors[stream].finish();
        if (redacted.decoded) {
          const event = { stream, text: "", remainingSource: redacted.decoded, resolved: false };
          orderedOutput.push(event);
          streamOutput[stream].push(event);
        }
        applyRedacted(stream, redacted);
        for (const event of streamOutput[stream]) event.resolved = true;
        streamOutput[stream] = [];
      }
      flushOrderedOutput();
    };
    let finished = false;
    return {
      write: redactInOrder,
      finish: (commandFailed) => {
        if (finished) return undefined;
        finished = true;
        finishRedactors();
        if (!commandFailed) {
          try { fs.closeSync(descriptor); } catch { /* best effort */ }
          let removed = false;
          try { fs.unlinkSync(temporary); removed = true; } catch { /* preserve the index row for singleton recovery */ }
          if (removed) {
            try {
              this.fsyncLogsDirectory();
              this.index?.discardDiagnosticLog(logId);
            } catch { /* preserve the index row for singleton recovery */ }
          }
          return undefined;
        }
        let errorCode: string | null = null;
        let recoveryRequired = false;
        let published = false;
        let contentSha256: string | null = null;
        try {
          if (writeFailed) throw new Error("write");
          fs.fsyncSync(descriptor);
          const writtenStats = fs.fstatSync(descriptor);
          const temporaryStats = fs.lstatSync(temporary);
          if (!writtenStats.isFile() || writtenStats.nlink !== 1 || (writtenStats.mode & 0o077) !== 0 ||
            writtenStats.uid !== process.getuid?.() || writtenStats.size !== bytes ||
            !temporaryStats.isFile() || temporaryStats.isSymbolicLink() || temporaryStats.nlink !== writtenStats.nlink ||
            temporaryStats.mode !== writtenStats.mode || temporaryStats.uid !== writtenStats.uid ||
            temporaryStats.size !== writtenStats.size || temporaryStats.dev !== writtenStats.dev ||
            temporaryStats.ino !== writtenStats.ino || fs.existsSync(finalPath)) {
            throw new Error("unsafe_finalize");
          }
          this.assertPrivateDirectory(this.root);
          this.assertPrivateDirectory(this.logsRoot);
          // link+unlink gives an atomic no-clobber publish on the same filesystem.
          // A crash between the calls leaves nlink=2, which the read path rejects.
          fs.linkSync(temporary, finalPath);
          published = true;
          fs.unlinkSync(temporary);
          fs.chmodSync(finalPath, 0o600);
          fs.closeSync(descriptor);
          this.fsyncLogsDirectory();
          contentSha256 = contentHash.digest("hex");
        } catch {
          errorCode = writeFailed ? "diagnostic_write_failed" : "diagnostic_finalize_failed";
          try { fs.closeSync(descriptor); } catch { /* already closed */ }
          try { this.cleanupFailedFinalize(temporary, finalPath, published); }
          catch { recoveryRequired = true; }
        }
        const capture: DiagnosticLogCapture = {
          ...initial,
          relative_ref: errorCode && !recoveryRequired ? null : relativeRef,
          byte_size: errorCode && !recoveryRequired ? 0 : bytes,
          content_sha256: errorCode ? null : contentSha256,
          capture_state: errorCode ? "write_failed" : truncated ? "truncated" : "complete",
          error_code: errorCode,
          finalized_at: new Date().toISOString(),
        };
        if (recoveryRequired) return capture;
        try { this.index?.finalizeDiagnosticLog(capture); } catch {
          try { if (capture.relative_ref) fs.unlinkSync(finalPath); } catch { /* best effort */ }
          return { ...capture, relative_ref: null, byte_size: 0, content_sha256: null, capture_state: "write_failed", error_code: "diagnostic_index_write_failed" };
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
      if (!row.content_sha256 || !/^[0-9a-f]{64}$/.test(row.content_sha256)) {
        return { ...common, capture_state: "read_error" satisfies DiagnosticLogState, error_code: "diagnostic_digest_missing" };
      }
      const start = Math.max(0, stats.size - previewLimitBytes);
      const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(descriptor);
        if (!opened.isFile() || opened.nlink !== stats.nlink || (opened.mode & 0o7777) !== (stats.mode & 0o7777) ||
          opened.uid !== stats.uid || opened.dev !== stats.dev || opened.ino !== stats.ino || opened.size !== stats.size) {
          throw new Error("diagnostic_open_identity_mismatch");
        }
        const digest = createHash("sha256");
        let tail = Buffer.alloc(0);
        let offset = 0;
        while (offset < stats.size) {
          const buffer = Buffer.alloc(Math.min(64 * 1024, stats.size - offset));
          const count = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
          if (count <= 0) throw new Error("diagnostic_short_read");
          const selected = buffer.subarray(0, count);
          digest.update(selected);
          tail = Buffer.concat([tail, selected]).subarray(-previewLimitBytes);
          offset += count;
        }
        if (digest.digest("hex") !== row.content_sha256) throw new Error("diagnostic_digest_mismatch");
        return { ...common, capture_state: row.capture_state, detail_tail: tail.toString("utf8") };
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
    for (const row of this.index.diagnosticRetentionLogs()) {
      if (!row.relative_ref) continue;
      try {
        fs.lstatSync(this.resolveRow(row));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
        try {
          // Persist the observed absence before removing its durable DB
          // reference, then exclude the missing file from quota accounting.
          this.fsyncLogsDirectory();
          this.index.markDiagnosticPurged(row.log_id, now);
        } catch { /* a later maintenance pass will reconcile it */ }
      }
    }
    for (const row of this.index.diagnosticRetentionCandidates(cutoff, aggregateLimitBytes)) {
      let directoryEntryMustBeSynced = false;
      try {
        if (row.relative_ref) {
          fs.unlinkSync(this.resolveRow(row));
          directoryEntryMustBeSynced = true;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
        // A previous sweep may have unlinked the entry but crashed or failed
        // before fsync. Synchronize that absence before dropping the DB ref.
        directoryEntryMustBeSynced = true;
      }
      if (directoryEntryMustBeSynced) {
        try {
          this.fsyncLogsDirectory();
        } catch {
          // Keep the durable reference so a later maintenance pass can
          // reconcile the unlink before marking the row as purged.
          continue;
        }
      }
      this.index.markDiagnosticPurged(row.log_id, now);
    }
  }

  private ensurePrivateDirectory(directory: string): void {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.assertPrivateDirectory(directory);
    fs.chmodSync(directory, 0o700);
  }

  private fsyncLogsDirectory(): void {
    const directory = fs.openSync(this.logsRoot, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }

  private cleanupFailedFinalize(temporary: string, finalPath: string, published: boolean): void {
    const candidates = published ? [temporary, finalPath] : [temporary];
    const entries = candidates.flatMap((candidate) => {
      try { return [{ path: candidate, stats: fs.lstatSync(candidate) }]; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    });
    for (const entry of entries) {
      if (!entry.stats.isFile() || entry.stats.isSymbolicLink() || (entry.stats.mode & 0o077) !== 0 ||
        entry.stats.uid !== process.getuid?.()) throw new Error("diagnostic_finalize_cleanup_unsafe");
    }
    if (entries.length === 1 && entries[0]!.stats.nlink !== 1) throw new Error("diagnostic_finalize_cleanup_unsafe");
    if (entries.length === 2) {
      const [first, second] = entries;
      if (first!.stats.nlink !== 2 || second!.stats.nlink !== 2 ||
        first!.stats.dev !== second!.stats.dev || first!.stats.ino !== second!.stats.ino) {
        throw new Error("diagnostic_finalize_cleanup_unsafe");
      }
    }
    for (const entry of entries) fs.unlinkSync(entry.path);
    if (entries.length > 0) this.fsyncLogsDirectory();
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
