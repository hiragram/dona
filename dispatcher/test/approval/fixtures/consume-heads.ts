import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { AuditAnchor, AuditKey } from "../../../src/audit/codec.js";
import type { ClockMark } from "../../../src/approval/clock.js";
import type { ApprovalTransactionProviders } from "../../../src/approval/transaction.js";
export interface FixtureHeads { anchor:AuditAnchor; mark:ClockMark; audit_used:string[]; clock_used:string[] }
/** Controlled test file only. Native DB writer coordination serializes accesses.
 * This is NOT a production credential store or rollback-resistant provider. */
export function writeFixtureHeads(filename:string,value:FixtureHeads):void {
  const temporary=filename+"."+randomUUID();fs.writeFileSync(temporary,JSON.stringify(value),{mode:0o600,flag:"wx"});fs.renameSync(temporary,filename);
}
export function fixtureHeadProviders(filename:string):ApprovalTransactionProviders {
  const read=()=>JSON.parse(fs.readFileSync(filename,"utf8")) as FixtureHeads;
  const key:AuditKey={version:1,purpose:"audit",state:"active",activated_at:"2026-09-01T00:00:00.000Z",signing_expires_at:"2026-11-01T00:00:00.000Z",secret:Buffer.alloc(32,0x45)};
  return {auditKeys:version=>version===1?key:undefined,auditSigningKeyVersion:1,maximumClockDriftMs:1000,lockWaitTimeoutMs:10,
    clock:{observe:()=>{const mark=read().mark;return {boot_id:mark.boot_id,continuous_ms:mark.continuous_ms,wall_utc:mark.effective_utc};}},
    clockMarks:{read:()=>read().mark,reserve:(expected,proposed)=>{
      const current=read();assert.deepEqual(current.mark,expected);assert.ok(!current.clock_used.includes(proposed.transaction_id));
      writeFixtureHeads(filename,{...current,mark:proposed,clock_used:[...current.clock_used,proposed.transaction_id]});return read().mark;
    }},
    auditAnchors:{read:()=>read().anchor,reserve:(expected,proposed)=>{
      const current=read();assert.deepEqual(current.anchor,expected);assert.ok(proposed.pending_transaction_id&&!current.audit_used.includes(proposed.pending_transaction_id));
      writeFixtureHeads(filename,{...current,anchor:proposed,audit_used:[...current.audit_used,proposed.pending_transaction_id]});return read().anchor;
    },finalize:expected=>{
      const current=read();assert.deepEqual(current.anchor,expected);writeFixtureHeads(filename,{...current,anchor:{...expected,pending_transaction_id:null}});return read().anchor;
    }}
  };
}
