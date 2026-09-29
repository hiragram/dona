import fs from "node:fs";
import path from "node:path";

import type { DispatcherDatabase, JobNotificationHook } from "./database.js";
import { jobResultEnvelopeMaxBytes, type AuthorizedJobResultPublish } from "./job-result-publish.js";
import type { JobResultPublishSink } from "./job-result-publish-transport.js";
import type { JobResultEnvelope } from "./types.js";
import { parseJobResultEnvelope, stableStringify } from "./validation.js";

function pathOccupied(filePath: string): boolean {
  try { fs.lstatSync(filePath); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function verifiedFile(filePath: string, jobId: string): JobResultEnvelope | undefined {
  let handle: number;
  try { handle = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > jobResultEnvelopeMaxBytes) throw new Error("job_result_file_invalid");
    return parseJobResultEnvelope(JSON.parse(fs.readFileSync(handle, "utf8")), jobId);
  } finally { fs.closeSync(handle); }
}

/** The DB receipt owns the winning payload before a file is materialized. */
export class JobResultDurablePublisher implements JobResultPublishSink {
  constructor(private readonly database: DispatcherDatabase,
    private readonly notificationHook: JobNotificationHook = () => {},
    private readonly faultHook: (point: "after_reserve" | "before_rename" | "after_rename" | "before_db_commit" | "after_db_commit") => void = () => {}) {}

  async reconcile(candidate: AuthorizedJobResultPublish): Promise<{ outcome: "reused" | "pending" | "needs_review" | "conflict"; receipt_id?: string }> {
    const outcome = this.database.inspectPublishedJobResult(candidate.fence.jobId,candidate.canonicalDigest);
    return { outcome, ...(outcome === "reused" ? { receipt_id: candidate.canonicalDigest } : {}) };
  }

  async commit(candidate: AuthorizedJobResultPublish): Promise<{ outcome: "created" | "reused" | "pending" | "conflict"; receipt_id?: string }> {
    const reserved = this.database.reservePublishedJobResult(candidate);
    if (reserved.outcome !== "reserved") return { outcome: reserved.outcome,
      ...(reserved.outcome === "reused" ? { receipt_id: candidate.canonicalDigest } : {}) };
    this.faultHook("after_reserve");
    const job = this.database.getJob(candidate.fence.jobId);
    if (!job) return { outcome: "conflict" };
    candidate.envelope = reserved.envelope;
    const encoded = stableStringify(reserved.envelope);
    if (Buffer.byteLength(encoded, "utf8") > jobResultEnvelopeMaxBytes) throw new Error("job_result_file_invalid");
    const existing = verifiedFile(job.result_path,job.job_id);
    if (existing) {
      if (stableStringify(existing) !== encoded) return { outcome: "conflict" };
    } else {
      const temporary = `${job.result_path}.publish-${candidate.canonicalDigest}.tmp`;
      let handle: number | undefined;
      try {
        // A stale, differently owned temp is never replaced or adopted.
        handle = fs.openSync(temporary,fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,0o600);
        fs.writeFileSync(handle,encoded,"utf8");
        fs.fsyncSync(handle);
        fs.closeSync(handle); handle = undefined;
        const checked = verifiedFile(temporary,job.job_id);
        if (!checked || stableStringify(checked) !== encoded) throw new Error("job_result_temp_invalid");
        if (pathOccupied(job.result_path)) return { outcome: "conflict" };
        this.faultHook("before_rename");
        fs.renameSync(temporary,job.result_path);
        this.faultHook("after_rename");
        const directory = fs.openSync(path.dirname(job.result_path),fs.constants.O_RDONLY);
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      } finally { if (handle !== undefined) fs.closeSync(handle); }
    }
    const readBack = verifiedFile(job.result_path,job.job_id);
    if (!readBack || stableStringify(readBack) !== encoded) throw new Error("job_result_readback_invalid");
    this.faultHook("before_db_commit");
    const committed = this.database.commitPublishedJobResult(candidate,new Date(),this.notificationHook);
    this.faultHook("after_db_commit");
    return committed === "reused"
      ? { outcome: reserved.fresh ? "created" : "reused", receipt_id: candidate.canonicalDigest }
      : { outcome: "conflict" };
  }
}
