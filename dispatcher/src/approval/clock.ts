import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const millis = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const utc = z.string().refine((value) => Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value);
const observationSchema = z.strictObject({ boot_id: id, continuous_ms: millis, wall_utc: utc });
export type ClockObservation = z.infer<typeof observationSchema>;
const markSchema = z.strictObject({ codec_version: z.literal(1), transaction_id: id, previous_transaction_id: id.nullable(),
  boot_id: id, continuous_ms: millis, effective_utc: utc });
export type ClockMark = z.infer<typeof markSchema>;

/** The provider authenticates boot identity and a suspend-inclusive continuous
 * clock. performance.now()/Date.now() alone are not a cross-restart proof. */
export interface ProtectedClockSource { observe(): ClockObservation }
/** Fresh integrity-verified, rollback-resistant, DB/backup-external state.
 * CAS persists the full expected/proposed mark and one-shot transaction ledger.
 * A successful unused reservation advances time; never cancel or reuse it. */
export interface ClockMarkStore {
  read(): ClockMark;
  reserve(expected: ClockMark, proposed: ClockMark): ClockMark;
}
export class ApprovalClockError extends Error {
  constructor() { super("approval_clock_unverified"); this.name = "ApprovalClockError"; }
}
function guard<T>(operation: () => T): T {
  try { return operation(); } catch { throw new ApprovalClockError(); }
}
/** Canonical domain validation only; the provider must separately authenticate
 * the observation, protected head, and one-shot transaction reservation. */
export function parseClockMark(input: unknown): ClockMark { return guard(() => markSchema.parse(input)); }
function equal(a: ClockMark, b: ClockMark): boolean {
  return (Object.keys(a) as Array<keyof ClockMark>).every((key) => a[key] === b[key]);
}

/** Pure evaluation; never boots a new trust root or extends an existing expiry.
 * maximumDriftMs is a fixed local policy value, not a browser/MCP argument. */
export function advanceClockMark(previousInput: unknown, observationInput: unknown, transactionId: string, maximumDriftMs: number): ClockMark {
  return guard(() => {
    const previous = markSchema.parse(previousInput);
    const observation = observationSchema.parse(observationInput);
    id.parse(transactionId); millis.parse(maximumDriftMs);
    if (transactionId === previous.transaction_id || observation.boot_id !== previous.boot_id
      || observation.continuous_ms < previous.continuous_ms) throw new ApprovalClockError();
    const priorUtc = Date.parse(previous.effective_utc); const wall = Date.parse(observation.wall_utc);
    if (wall < priorUtc) throw new ApprovalClockError();
    const elapsed = observation.continuous_ms - previous.continuous_ms;
    const continuousUtc = priorUtc + elapsed;
    if (!Number.isSafeInteger(continuousUtc) || Math.abs(wall - continuousUtc) > maximumDriftMs) throw new ApprovalClockError();
    return markSchema.parse({ codec_version: 1, transaction_id: transactionId, previous_transaction_id: previous.transaction_id,
      boot_id: observation.boot_id, continuous_ms: observation.continuous_ms,
      effective_utc: new Date(Math.max(wall, continuousUtc)).toISOString() });
  });
}

/** Call before opening the business DB transaction. Missing/unknown marks and
 * CAS conflicts/response loss stop the caller; this method never retries. */
export function reserveClockMark(store: ClockMarkStore, source: ProtectedClockSource, transactionId: string, maximumDriftMs: number): ClockMark {
  return guard(() => {
    const previous = markSchema.parse(store.read());
    const proposed = advanceClockMark(previous, source.observe(), transactionId, maximumDriftMs);
    const accepted = markSchema.parse(store.reserve(previous, proposed));
    if (!equal(accepted, proposed) || !equal(markSchema.parse(store.read()), proposed)) throw new ApprovalClockError();
    return proposed;
  });
}

export const requestTtlMs = 15 * 60 * 1000;
export const consumeTtlMs = 5 * 60 * 1000;
export function approvalExpiry(markInput: unknown, kind: "request" | "consume"): string {
  return guard(() => {
    const mark = markSchema.parse(markInput);
    if (kind !== "request" && kind !== "consume") throw new ApprovalClockError();
    return new Date(Date.parse(mark.effective_utc) + (kind === "request" ? requestTtlMs : consumeTtlMs)).toISOString();
  });
}
export function approvalExpired(expiresAt: string, markInput: unknown): boolean {
  return guard(() => Date.parse(utc.parse(expiresAt)) <= Date.parse(markSchema.parse(markInput).effective_utc));
}

/** The caller must persist these transitions with payload deletion and audit.
 * It must not resume attempts merely because a new boot has a valid wall clock. */
export function clockFailureDisposition(state: "nonterminal_request" | "approved" | "claimed" | "executing" | "acceptance_unknown") {
  if (!["nonterminal_request", "approved", "claimed", "executing", "acceptance_unknown"].includes(state)) throw new ApprovalClockError();
  return { state: "needs_review" as const, delete_payload: true as const,
    record_acceptance_unknown: state === "executing", external_call_allowed: false as const };
}
