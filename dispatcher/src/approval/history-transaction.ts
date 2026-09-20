import type Database from "better-sqlite3";
import { types } from "node:util";
import { z } from "zod";
import { assertSynchronousCallback, assertSynchronousResult, type SynchronousCallback } from "../audit/synchronous.js";
import { auditEventSchema, type AuditEvent, type AuditResourceCommitment, type VerifiedAuditState } from "../audit/codec.js";
import type { AuditPreparedPlan } from "../audit/repository.js";
import { ApprovalTransaction, type ApprovalTransactionProviders } from "./transaction.js";
import { ApprovalClockHistory, approvalClockHistoryResource } from "./clock-history.js";
import type { ClockMark } from "./clock.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const scopeSchema = z.strictObject({ instance_id: id, workspace_id: id });
const resourceOrder = (item: AuditResourceCommitment) => JSON.stringify([item.scope.instance_id, item.scope.tenant_id, item.resource_id]);
/** 既存ApprovalTransactionへ過去markのcommitmentを必ず同梱する内部境界。
 * 新しいclock/audit sequenceやCASは作らず、rootの自動初期化も行わない。 */
export class ApprovalHistoryTransaction {
  private readonly transaction: ApprovalTransaction;
  private readonly history: ApprovalClockHistory;
  private readonly scope: z.infer<typeof scopeSchema>;
  constructor(db: Database.Database, providers: ApprovalTransactionProviders, scope: z.infer<typeof scopeSchema>) {
    assertSynchronousResult(scope); this.scope = Object.freeze(scopeSchema.parse(scope));
    this.transaction = new ApprovalTransaction(db, providers); this.history = new ApprovalClockHistory(db, this.scope);
  }
  runPrepared<F extends () => unknown>(transactionId: string,
    prepare: (mark: Readonly<ClockMark>, state: VerifiedAuditState) => AuditPreparedPlan<Omit<AuditEvent, "occurred_at">, SynchronousCallback<F>>): ReturnType<F>;
  runPrepared(transactionId: string,
    prepare: (mark: Readonly<ClockMark>, state: VerifiedAuditState) => AuditPreparedPlan<Omit<AuditEvent, "occurred_at">, () => unknown>): unknown {
    assertSynchronousCallback(prepare);
    return this.transaction.runPrepared(transactionId, (mark, state) => {
      const input = prepare(mark, state);
      if (input === null || typeof input !== "object" || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) throw Error();
      const fields = Object.getOwnPropertyDescriptors(input);
      const resourceField = Object.hasOwn(fields, "resource_commitments") ? "resource_commitments" : "resource_digest";
      if (Reflect.ownKeys(fields).length !== 3 || !["event", resourceField, "mutation"].every(name => fields[name] && "value" in fields[name]!)) throw Error();
      const mutation = fields.mutation!.value as () => unknown;
      assertSynchronousCallback(mutation);
      assertSynchronousResult({ event: fields.event!.value, resources: fields[resourceField]!.value });
      const event = auditEventSchema.omit({ occurred_at: true }).parse(fields.event!.value);
      if (event.scope.instance_id !== this.scope.instance_id || event.scope.tenant_id !== this.scope.workspace_id || event.resource_id === null) throw Error();
      const history = this.history.prepare(mark, state);
      const supplied = resourceField === "resource_commitments" ? fields.resource_commitments!.value as AuditResourceCommitment[]
        : fields.resource_digest!.value === null ? [] : [{ scope: event.scope, resource_id: event.resource_id, resource_digest: fields.resource_digest!.value as string }];
      if (!Array.isArray(supplied) || (resourceField === "resource_commitments" && supplied.length === 0)) throw Error();
      const resources = [...supplied];
      for (const resource of resources) {
        if (resource.scope.instance_id !== this.scope.instance_id || resource.scope.tenant_id !== this.scope.workspace_id
          || resource.resource_id === approvalClockHistoryResource) throw Error();
      }
      resources.push(...history.resource_commitments);
      resources.sort((a, b) => resourceOrder(a) < resourceOrder(b) ? -1 : resourceOrder(a) > resourceOrder(b) ? 1 : 0);
      // The shared audit codec rejects duplicates, excessive roots and malformed
      // commitments before reserving its external anchor.
      return { event, resource_commitments: resources, mutation: () => { history.mutation(); return mutation(); } };
    });
  }
}
