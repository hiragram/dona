import type Database from "better-sqlite3";
import { assertSecurityDurability } from "../audit/durability.js";
import { auditEventSchema, type AuditEvent, type AuditKeyLookup } from "../audit/codec.js";
import { AuditRepository, type AuditAnchorStore } from "../audit/repository.js";
import { withSecurityTransactionLock, SecurityCoordinationBusyError } from "../audit/coordination.js";
import { assertSynchronousCallback, type SynchronousCallback } from "../audit/synchronous.js";
import { reserveClockMark, type ClockMark, type ClockMarkStore, type ProtectedClockSource } from "./clock.js";
import { verifyApprovalSchema } from "./schema.js";
import { applyClockBoundMutation } from "./clock-provenance.js";

export interface ApprovalTransactionProviders {
  clock: ProtectedClockSource;
  clockMarks: ClockMarkStore;
  auditAnchors: AuditAnchorStore;
  auditKeys: AuditKeyLookup;
  auditSigningKeyVersion: number;
  maximumClockDriftMs: number;
  /** Local operational admission wait, 0..30,000 ms. No automatic retry. */
  lockWaitTimeoutMs?: number;
}
export class ApprovalTransactionError extends Error {
  constructor() { super("approval_transaction_unverified"); this.name = "ApprovalTransactionError"; }
}
export class ApprovalTransactionBusyError extends Error {
  constructor() { super("approval_transaction_busy"); this.name = "ApprovalTransactionBusyError"; }
}

/** Internal repository boundary, not an approval API. The broker must authenticate
 * identity and revalidate current binding/policy/visibility inside the mutation.
 * The callback may perform synchronous SQL on this exact connection only; it must
 * never commit, send external writes, or defer work. A result is released only
 * after the shared audit anchor is finalized and its complete chain reread. */
export class ApprovalTransaction {
  private readonly audit: AuditRepository;
  constructor(private readonly db: Database.Database, private readonly providers: ApprovalTransactionProviders) {
    this.audit = new AuditRepository(db, providers.auditAnchors, providers.auditKeys);
  }
  run<F extends (mark: Readonly<ClockMark>) => unknown>(transactionId: string, eventInput: Omit<AuditEvent, "occurred_at">, mutation: SynchronousCallback<F>): ReturnType<F>;
  run(transactionId: string, eventInput: Omit<AuditEvent, "occurred_at">, mutation: (mark: Readonly<ClockMark>) => unknown): unknown {
    try {
      assertSynchronousCallback(mutation);
      return withSecurityTransactionLock(this.db, () => this.runInside(transactionId, eventInput, mutation), this.providers.lockWaitTimeoutMs);
    } catch (error) {
      if (error instanceof SecurityCoordinationBusyError) throw new ApprovalTransactionBusyError();
      throw new ApprovalTransactionError();
    }
  }
  private runInside(transactionId: string, eventInput: Omit<AuditEvent, "occurred_at">, mutation: (mark: Readonly<ClockMark>) => unknown): unknown {
    try {
      assertSecurityDurability(this.db);
      if (this.db.inTransaction || this.db.pragma("foreign_keys", { simple: true }) !== 1
        || (this.db.pragma("synchronous", { simple: true }) as number) < 2) throw new ApprovalTransactionError();
      const event = auditEventSchema.omit({ occurred_at: true }).parse(eventInput);
      verifyApprovalSchema(this.db);
      // Protect audit integrity before making even an unused clock reservation.
      this.audit.verify();
      const mark = Object.freeze(reserveClockMark(this.providers.clockMarks, this.providers.clock,
        transactionId, this.providers.maximumClockDriftMs));
      const requireCurrent = () => {
        const current = this.providers.clockMarks.read();
        if (Object.keys(current).length !== Object.keys(mark).length || !(Object.keys(mark) as Array<keyof ClockMark>).every(key => current[key] === mark[key])) throw new ApprovalTransactionError();
      };
      requireCurrent();
      return this.audit.append(transactionId, this.providers.auditSigningKeyVersion,
        { ...event, occurred_at: mark.effective_utc }, () => {
          requireCurrent(); verifyApprovalSchema(this.db);
          const result = applyClockBoundMutation(this.db, mark, () => mutation(mark));
          requireCurrent();
          verifyApprovalSchema(this.db);
          return result;
        }).result;
    } catch { throw new ApprovalTransactionError(); }
  }
}
