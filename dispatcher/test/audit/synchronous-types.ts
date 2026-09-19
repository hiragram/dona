import type Database from "better-sqlite3";
import type { AuditEvent } from "../../src/audit/codec.js";
import type { AuditRepository } from "../../src/audit/repository.js";
import type { ApprovalTransaction } from "../../src/approval/transaction.js";
import { withSecurityTransactionLock } from "../../src/audit/coordination.js";

// Typecheck only; never invoke against a database.
function synchronousContracts(
  db: Database.Database,
  audit: AuditRepository,
  approval: ApprovalTransaction,
  event: AuditEvent,
) {
  const number: number = withSecurityTransactionLock(db, () => 1);
  const text: string = audit.append("tx", 1, event, () => "receipt").result;
  const result: { id: string } = approval.run("tx", event, () => ({
    id: "request",
  }));
  withSecurityTransactionLock(db, () => {});
  const ids: string[] = withSecurityTransactionLock(db, () => ["request"]);
  // @ts-expect-error generator callback must not escape the transaction
  approval.run("tx", event, function* () {
    yield ids;
  });
  // @ts-expect-error async generator is deferred work
  audit.append("tx", 1, event, async function* () {
    yield number;
  });
  // @ts-expect-error a returned iterator is deferred work
  withSecurityTransactionLock(db, () => ids.values());
  // @ts-expect-error a returned callable is deferred work
  withSecurityTransactionLock(db, () => () => number);
  // @ts-expect-error async callback must be rejected before it can run
  withSecurityTransactionLock(db, async () => number);
  // @ts-expect-error an explicit void type must not accept an async callback
  withSecurityTransactionLock<void>(db, async () => {});
  // @ts-expect-error Promise-returning audit mutation is not synchronous
  audit.append("tx", 1, event, () => Promise.resolve(text));
  // @ts-expect-error async approval mutation is not synchronous
  approval.run("tx", event, async () => result);
  // @ts-expect-error PromiseLike-returning mutation is not synchronous
  approval.run("tx", event, () => null as unknown as PromiseLike<string>);
  // @ts-expect-error union with a Promise is not synchronous
  withSecurityTransactionLock(db, () => (number > 0 ? 1 : Promise.resolve(1)));
}
