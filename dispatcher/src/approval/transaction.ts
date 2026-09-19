import { applyClockBoundMutation } from "./clock-provenance.js";
import { assertSecurityDurability } from "../audit/durability.js";
import { types } from "node:util";
import { assertSynchronousCallback, assertSynchronousResult, type SynchronousCallback } from "../audit/synchronous.js";
import { withSecurityTransactionLock, SecurityCoordinationBusyError } from "../audit/coordination.js";
import type Database from "better-sqlite3";
import { auditEventSchema, type AuditEvent, type AuditKeyLookup, type VerifiedAuditState } from "../audit/codec.js";
import { AuditRepository, type AuditAnchorStore, type AuditPreparedPlan } from "../audit/repository.js";
import { reserveClockMark, type ClockMark, type ClockMarkStore, type ProtectedClockSource } from "./clock.js";
import { verifyApprovalSchema, verifyApprovalIntegrity } from "./schema.js";

export interface ApprovalTransactionProviders {
  clock: ProtectedClockSource;
  clockMarks: ClockMarkStore;
  auditAnchors: AuditAnchorStore;
  auditKeys: AuditKeyLookup;
  auditSigningKeyVersion: number;
  maximumClockDriftMs: number;
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
    try { verifyApprovalIntegrity(db); } catch { throw new ApprovalTransactionError(); }
    this.audit = new AuditRepository(db, providers.auditAnchors, providers.auditKeys);
  }
  run<F extends (mark: Readonly<ClockMark>) => unknown>(transactionId: string, eventInput: Omit<AuditEvent, "occurred_at">, mutation: SynchronousCallback<F>): ReturnType<F>;
  run(transactionId: string, eventInput: Omit<AuditEvent, "occurred_at">, mutation: (mark: Readonly<ClockMark>) => unknown): unknown {
    try {
      assertSynchronousCallback(mutation);
      const event = auditEventSchema.omit({ occurred_at: true }).parse(eventInput);
      return this.runPrepared(transactionId, mark => ({ event, resource_digest: null, mutation: () => mutation(mark) }));
    } catch (error) { if (error instanceof ApprovalTransactionBusyError) throw error; throw new ApprovalTransactionError(); }
  }

  /** prepare performs synchronous reads under the writer lock. It chooses the
   * actual audit outcome and planned metadata digest before anchor reservation;
   * an ordinary duplicate/conflict should return a denial plan, not throw after
   * reserve. Plaintext and transport proof must never enter resource metadata. */
  runPrepared<F extends () => unknown>(transactionId: string, prepare: (mark: Readonly<ClockMark>, state: VerifiedAuditState) => AuditPreparedPlan<Omit<AuditEvent, "occurred_at">, SynchronousCallback<F>>): ReturnType<F>;
  runPrepared(transactionId: string, prepare: (mark: Readonly<ClockMark>, state: VerifiedAuditState) => AuditPreparedPlan<Omit<AuditEvent, "occurred_at">, () => unknown>): unknown {
    try {
      assertSynchronousCallback(prepare);
      return withSecurityTransactionLock(this.db, () => this.runPreparedInside(transactionId, prepare), this.providers.lockWaitTimeoutMs);
    }
    catch (error) { if (error instanceof SecurityCoordinationBusyError) throw new ApprovalTransactionBusyError(); throw new ApprovalTransactionError(); }
  }
  private runPreparedInside(transactionId: string, prepare: (mark: Readonly<ClockMark>, state: VerifiedAuditState) => AuditPreparedPlan<Omit<AuditEvent, "occurred_at">, () => unknown>): unknown {
    try {
      assertSecurityDurability(this.db);
      if (this.db.inTransaction || this.db.pragma("foreign_keys", { simple: true }) !== 1
        || (this.db.pragma("synchronous", { simple: true }) as number) < 2) throw new ApprovalTransactionError();
      verifyApprovalSchema(this.db);
      this.audit.verify();
      const mark = Object.freeze(reserveClockMark(this.providers.clockMarks, this.providers.clock,
        transactionId, this.providers.maximumClockDriftMs));
      const requireCurrent = () => {
        const current = this.providers.clockMarks.read();
        if (Object.keys(current).length !== Object.keys(mark).length
          || !(Object.keys(mark) as Array<keyof ClockMark>).every(key => current[key] === mark[key])) throw new ApprovalTransactionError();
      };
      requireCurrent();
      return this.audit.appendPrepared(transactionId, this.providers.auditSigningKeyVersion, state => {
        requireCurrent(); verifyApprovalSchema(this.db);
        const plan = prepare(mark, state);
        if (plan === null || typeof plan !== "object" || types.isProxy(plan)
          || Object.getPrototypeOf(plan) !== Object.prototype) throw new ApprovalTransactionError();
        const descriptors = Object.getOwnPropertyDescriptors(plan);
        const resourceField = Object.hasOwn(descriptors, "resource_commitments") ? "resource_commitments" : "resource_digest";
        if (Reflect.ownKeys(descriptors).length !== 3 || !["event", resourceField, "mutation"].every(name => {
          const descriptor = descriptors[name]; return descriptor !== undefined && "value" in descriptor;
        })) throw new ApprovalTransactionError();
        assertSynchronousCallback(descriptors.mutation!.value);
        assertSynchronousResult({ event: descriptors.event!.value, resources: descriptors[resourceField]!.value });
        const event = auditEventSchema.omit({ occurred_at: true }).parse(plan.event);
        const update = "resource_commitments" in plan ? { resource_commitments: plan.resource_commitments } : { resource_digest: plan.resource_digest };
        return { event: { ...event, occurred_at: mark.effective_utc }, ...update,
          mutation: () => {
            requireCurrent();
            const result = applyClockBoundMutation(this.db, mark, plan.mutation); requireCurrent(); verifyApprovalSchema(this.db); return result;
          } };
      }).result;
    } catch { throw new ApprovalTransactionError(); }
  }
}
