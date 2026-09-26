import { readJobResultEnvelope } from "./job-result.js";

// Read-only prepublish check. Never print arbitrary schema paths, input, or OS errors.
const [candidatePath, jobId, ...extra] = process.argv.slice(2);
if (!candidatePath || !jobId || extra.length) {
  process.stderr.write("usage: job-result-validate <candidate> <job_id>\n");
  process.exitCode = 2;
} else {
  try {
    await readJobResultEnvelope(candidatePath, jobId);
    process.stdout.write("Job Result validation passed\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const reason = message === "completed_at must be UTC RFC 3339 with trailing Z"
      ? message
      : message === "completed_at must be a valid calendar date and time"
        ? message
        : "Job Result validation failed (file, JSON, schema, or job identity)";
    process.stderr.write(`${reason}\n`);
    process.exitCode = 1;
  }
}
