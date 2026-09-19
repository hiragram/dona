import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {openSecurityDatabase} from "../../src/audit/coordination.js";
import {AuditRepository,installAuditSchema,type AuditAnchorStore} from "../../src/audit/repository.js";
import {signAuditCheckpoint,type AuditAnchor,type AuditKey,type AuditEvent} from "../../src/audit/codec.js";
import {installApprovalSchema} from "../../src/approval/schema.js";
import {ApprovalTransaction,type ApprovalTransactionProviders} from "../../src/approval/transaction.js";
import type {ClockMark,ClockMarkStore} from "../../src/approval/clock.js";
import {installWebAuthSchema} from "../../src/web/schema.js";
import {WebAuthRepository} from "../../src/web/repository.js";
import {encodeWebAuthState,type WebAuthState,type StoredWebLogin,type StoredWebSession,type StoredWebPayload} from "../../src/web/model.js";
import type {RegistryPrincipal} from "../../src/web/domain.js";
export const wire=JSON.parse(fs.readFileSync(new URL("../../../test-fixtures/web-auth-wire-v1.json",import.meta.url),"utf8")) as {
 fixture_only:boolean;now:string;principal:RegistryPrincipal;login:StoredWebLogin;session:StoredWebSession;login_payload:StoredWebPayload;payload:StoredWebPayload;
 session_cases:Array<{principal?:Record<string,unknown>;session?:Record<string,unknown>;runtime?:Record<string,unknown>;now?:string;reason:string}>;
};
assert.equal(wire.fixture_only,true);
export const scope={instance_id:"instance",tenant_id:"tenant"};
const start="2026-09-19T00:00:00.000Z";
const key:AuditKey={version:1,purpose:"audit",state:"active",activated_at:"2026-09-01T00:00:00.000Z",signing_expires_at:"2026-11-01T00:00:00.000Z",secret:Buffer.alloc(32,0x45)};
const keys=(version:number)=>version===1?key:undefined;
const genesis=signAuditCheckpoint({codec_version:1,chain_id:"web_fixture",transaction_id:"genesis",signed_at:start,key_version:1},keys);
// In-memory fixture only. This is not a production rollback-resistant provider.
class Anchors implements AuditAnchorStore {
 value:AuditAnchor={chain_id:"web_fixture",sequence:0,mac:"0".repeat(64),checkpoint_mac:genesis.mac,pending_transaction_id:null};
 fault:"none"|"reserve_before"|"reserve_after"|"finalize_before"|"finalize_after"="none";
 calls:string[]=[];used=new Set<string>();
 read(){return structuredClone(this.value);}
 reserve(expected:AuditAnchor,proposed:AuditAnchor){
  this.calls.push("reserve");assert.deepEqual(expected,this.value);
  if(this.fault==="reserve_before")throw Error("fixture reserve failed");
  assert.ok(proposed.pending_transaction_id && !this.used.has(proposed.pending_transaction_id));this.used.add(proposed.pending_transaction_id);
  this.value=structuredClone(proposed);if(this.fault==="reserve_after")throw Error("fixture response lost");return this.read();
 }
 finalize(expected:AuditAnchor){
  this.calls.push("finalize");assert.deepEqual(expected,this.value);if(this.fault==="finalize_before")throw Error("fixture finalize failed");
  this.value={...this.value,pending_transaction_id:null};if(this.fault==="finalize_after")throw Error("fixture response lost");return this.read();
 }
}
class Marks implements ClockMarkStore {
 value:ClockMark={codec_version:1,transaction_id:"initial_mark",previous_transaction_id:null,boot_id:"fixture_boot",continuous_ms:1000,effective_utc:start};
 used=new Set<string>(["initial_mark"]);
 read(){return structuredClone(this.value);}
 reserve(expected:ClockMark,proposed:ClockMark){assert.deepEqual(expected,this.value);assert.ok(!this.used.has(proposed.transaction_id));this.used.add(proposed.transaction_id);this.value=structuredClone(proposed);return this.read();}
}
export function setup(t:{after(fn:()=>void):void}){
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.homedir()),".dona-web-storage-fixture-"));
 const filename=path.join(directory,"fixture.sqlite");fs.writeFileSync(filename,"",{mode:0o600,flag:"wx"});
 const db=openSecurityDatabase(filename);db.pragma("journal_mode=WAL");db.pragma("foreign_keys=ON");db.pragma("synchronous=FULL");
 installAuditSchema(db);installApprovalSchema(db);installWebAuthSchema(db);
 const anchors=new Anchors(),marks=new Marks();let now=Date.parse(wire.now);
 const providers:ApprovalTransactionProviders={clock:{observe:()=>({boot_id:"fixture_boot",wall_utc:new Date(now).toISOString(),continuous_ms:1000+now-Date.parse(start)})},
  clockMarks:marks,auditAnchors:anchors,auditKeys:keys,auditSigningKeyVersion:1,maximumClockDriftMs:1000};
 const audit=new AuditRepository(db,anchors,keys);audit.initialize(genesis);
 const transaction=new ApprovalTransaction(db,providers),store=new WebAuthRepository(db,providers,scope);
 const readState=()=>JSON.parse((db.prepare("SELECT state_json FROM web_auth_state WHERE instance_id=? AND tenant_id=?").get(scope.instance_id,scope.tenant_id) as {state_json:string}).state_json) as WebAuthState;
 // Simulates already-authorized registry provisioning in a fixture. There is no
 // production registration endpoint, fake approval proof or operator bypass.
 const seedRegistry=(versions=[1])=>transaction.runPrepared("fixture_registry",(mark,verified)=>{
  const before=readState(),prior=encodeWebAuthState(before);
  assert.equal(verified.resource_bindings.find(binding=>binding.resource_id==="web_auth_state")?.resource_digest,prior.digest);
  const next=encodeWebAuthState({...before,updated_at:mark.effective_utc,principals:[wire.principal],retained_subject_key_versions:versions,
   aliases:versions.map(version=>({principal_id:"principal",index_key_version:version,subject_digest:"a".repeat(64)})).sort((a,b)=>JSON.stringify([a.index_key_version,a.subject_digest])<JSON.stringify([b.index_key_version,b.subject_digest])?-1:1)});
  const event:Omit<AuditEvent,"occurred_at">={scope,actor:{kind:"system",id:"fixture_registry_seed"},action:"identity_change",operation:"identity.change.v1",resource_id:"web_auth_state",outcome:"succeeded",reason:"none",session_ref:null,receipt_id:null,attempt_id:null,policy_revision:1,binding_revision:1,authz_revision:1};
  return{event,resource_digest:next.digest,mutation:()=>{db.prepare("UPDATE web_auth_state SET state_json=? WHERE instance_id=? AND tenant_id=?").run(next.canonical,scope.instance_id,scope.tenant_id);return null;}};
 });
 t.after(()=>{db.close();fs.rmSync(directory,{recursive:true,force:true});});
 return{db,filename,providers,store,audit,anchors,marks,transaction,readState,seedRegistry,setNow:(value:string)=>{now=Date.parse(value);}};
}
export const loginCookie={key_version:1,digest:wire.login.binding.cookie_digest};
export const sessionCookie={key_version:1,digest:wire.session.cookie_digest};
export function activeSession(fixture:ReturnType<typeof setup>){
 assert.equal(fixture.store.initialize("initialize").status,"succeeded");fixture.seedRegistry();
 assert.equal(fixture.store.createLogin("create_login",wire.login,wire.login_payload).status,"succeeded");
 assert.equal(fixture.store.consumeLogin("consume_login","login",loginCookie).status,"succeeded");
 assert.equal(fixture.store.createSession("create_session","consume_login",[{key_version:1,digest:"a".repeat(64)}],wire.session,wire.payload).status,"succeeded");
}
