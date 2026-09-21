export interface ManualEnvelopeInput {
  envelope: Record<string, unknown>;
  attempt: number;
  workspaceId: string;
}

export function normalizeManualEnvelope(input: unknown): ManualEnvelopeInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Manual event must be an object");
  }
  const rawEnvelope = input as Record<string, unknown>;
  const rawTrace = rawEnvelope.trace;
  const trace = rawTrace !== null && typeof rawTrace === "object" && !Array.isArray(rawTrace)
    ? rawTrace as Record<string, unknown>
    : {};
  const candidateAttempt = Number(trace.ingress_attempt);
  const attempt = Number.isSafeInteger(candidateAttempt) && candidateAttempt > 0 ? candidateAttempt : 1;
  const envelope: Record<string, unknown> = {
    ...rawEnvelope,
    trace: { ...trace, ingress_attempt: attempt },
  };
  const subject = envelope.subject as Record<string, unknown> | undefined;
  if (typeof subject?.workspace_id !== "string" || subject.workspace_id.length === 0) {
    throw new Error("Manual event workspace is required");
  }
  return { envelope, attempt, workspaceId: subject.workspace_id };
}
