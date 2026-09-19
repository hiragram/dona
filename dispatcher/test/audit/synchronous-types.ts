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
  const asyncIterable: AsyncIterable<string> = { async *[Symbol.asyncIterator]() { yield text; } };
  const iterable: Iterable<string> = { *[Symbol.iterator]() { yield text; } };
  // @ts-expect-error an async iterable wrapper also defers work
  approval.run("tx", event, () => asyncIterable);
  // @ts-expect-error a synchronous iterable wrapper also defers work
  audit.append("tx", 1, event, () => iterable);
  // @ts-expect-error union with an async iterable is deferred
  withSecurityTransactionLock(db, () => number > 0 ? ids : asyncIterable);
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

function nestedContracts(db: Database.Database, audit: AuditRepository, event: AuditEvent) {
  const result: { rows: Array<{ id: string }> } = withSecurityTransactionLock(db, () => ({ rows: [{ id: "safe" }] }));
  // @ts-expect-error callbacks inside arrays are deferred results
  withSecurityTransactionLock(db, () => [() => result]);
  // @ts-expect-error promises inside records and arrays are deferred results
  audit.append("nested", 1, event, () => ({ rows: [{ later: [Promise.resolve(result)] }] }));
}

function preparedContracts(audit:AuditRepository, approval:ApprovalTransaction,event:AuditEvent) {
 const text:string=audit.readVerified(()=>"text");
 const result:number=audit.appendPrepared('tx',1,()=>({event,resource_digest:null,mutation:()=>1})).result;
 const output:string=approval.runPrepared('tx',()=>({event,resource_digest:null,mutation:()=>text}));
 // @ts-expect-error deferred read cannot compile
 audit.readVerified(async()=>text);
 // @ts-expect-error deferred mutation cannot compile
 audit.appendPrepared('tx',1,()=>({event,resource_digest:null,mutation:async()=>result}));
 // @ts-expect-error deferred prepared mutation cannot compile
 approval.runPrepared('tx',()=>({event,resource_digest:null,mutation:()=>Promise.resolve(output)}));
 // @ts-expect-error generator read escapes the transaction
 audit.readVerified(function*(){yield text;});
 // @ts-expect-error generator mutation escapes the transaction
 audit.appendPrepared('tx',1,()=>({event,resource_digest:null,mutation:function*(){yield result;}}));
 // @ts-expect-error iterator mutation escapes the transaction
 approval.runPrepared('tx',()=>({event,resource_digest:null,mutation:()=>[output].values()}));
 const stateCount:number=audit.readVerifiedState(state=>state.resource_bindings.length);
 // @ts-expect-error verified state cannot escape into deferred work
 audit.readVerifiedState(async state=>state.resource_bindings);
 // @ts-expect-error iterator escapes the verified read snapshot
 audit.readVerifiedState(state=>state.resource_bindings.values());
 // @ts-expect-error nested Promise escapes the verified read snapshot
 audit.readVerifiedState(()=>({later:Promise.resolve(stateCount)}));
}
