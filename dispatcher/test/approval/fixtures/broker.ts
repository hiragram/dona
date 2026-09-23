import assert from "node:assert/strict";
import { setup, scope as auditScope } from "./storage.js";
import { snapshotFixture } from "./records.js";
import { ApprovalCreateBroker, type ApprovalCreateGrant, type ApprovalCreateIntent, type ApprovalCreateKeyLookup } from "../../../src/approval/create-broker.js";
import { ApprovalMetadataNodes } from "../../../src/approval/metadata-store.js";
import { ApprovalIndexBlobs } from "../../../src/approval/index-store.js";
import { ApprovalMetadataPlan } from "../../../src/approval/metadata-plan.js";
import { ApprovalMetadataPlanWriter } from "../../../src/approval/metadata-plan-store.js";
import { emptyMetadataRoot } from "../../../src/approval/metadata-tree.js";
import { installApprovalMetadataSchema, installApprovalIndexSchema, installApprovalPayloadSchema } from "../../../src/approval/schema.js";
import { ApprovalRecordRepository } from "../../../src/approval/record-repository.js";
import { ApprovalPayloadRepository } from "../../../src/approval/payload-repository.js";
import { ApprovalClockHistory } from "../../../src/approval/clock-history.js";
import type { ApprovalPayloadKey } from "../../../src/approval/payload-protection.js";
import type { ApprovalNotificationKey } from "../../../src/approval/notification-marker.js";
import type { ApprovalRecordKind } from "../../../src/approval/record-codec.js";
import type { AuditEvent } from "../../../src/audit/codec.js";
export const scope={instance_id:auditScope.instance_id,workspace_id:auditScope.tenant_id};
export const start="2026-09-19T00:00:00.000Z",body="fixture_only_private_draft_123";
export const content:ApprovalPayloadKey={version:1,purpose:"approval_content",state:"active",activated_at:"2026-09-01T00:00:00.000Z",signing_expires_at:"2026-11-01T00:00:00.000Z",secret:Buffer.alloc(32,71)};
export const wrapping:ApprovalPayloadKey={...content,purpose:"approval_payload_wrap",secret:Buffer.alloc(32,72)};
export const notification:ApprovalNotificationKey={...content,purpose:"approval_notification_marker",secret:Buffer.alloc(32,73)};
const source=snapshotFixture();
export const intent:ApprovalCreateIntent={source_ref:"authenticated_fixture_connection",operation_slot:source.request_source.operation_slot,target:source.target,text:body};
export function grant():Extract<ApprovalCreateGrant,{status:"authorized"}>{
 const {encrypted_content_ref:_ref,content_hmac_sha256:_mac,content_hmac_key_version:_version,...base}=source;
 return {status:"authorized",snapshot:{...structuredClone(base),...scope,policy:{...base.policy,allowed_user_mentions:[]}},binding_id:"binding",model_version:"fixture_model",
  display:{workspace_name:"Workspace",channel_name:"Channel",supervisor_name:"Supervisor",mentioned_users:[]}};
}
export function fixture(t:{after(fn:()=>void):void},initialize=true){
 const f=setup(t);f.setNow(start);installApprovalMetadataSchema(f.db);installApprovalIndexSchema(f.db);installApprovalPayloadSchema(f.db);
 if(initialize){
  const nodes=new ApprovalMetadataNodes(f.db),indexes=new ApprovalIndexBlobs(f.db,scope),writer=new ApprovalMetadataPlanWriter(f.db,scope);
  const event:Omit<AuditEvent,"occurred_at">={scope:auditScope,actor:{kind:"system",id:"fixture"},action:"approval_request",operation:"slack.post_thread_reply.v1",resource_id:"fixture_roots",outcome:"succeeded",reason:"none",session_ref:null,receipt_id:null,attempt_id:null,policy_revision:1,binding_revision:1,authz_revision:1};
  f.transaction.runPrepared("fixture_roots",()=>{
   const plan=nodes.read(n=>indexes.read(i=>{
    const p=new ApprovalMetadataPlan(scope,emptyMetadataRoot({...scope,collection:"approval_records_v1"}),n,i);
    for(const record_kind of ["request","decision","consume","execution","notification","event","presentation"] as ApprovalRecordKind[])
     for(const membership of ["all","active"] as const){if(membership==="active"&&["decision","consume"].includes(record_kind))continue;
      p.putIndex(null,{codec_version:1,scope,kind:"manifest",list:{record_kind,membership},count:0,head:null,tail:null});}
    return p.finish();
   }));
   return {event,resource_commitments:[{scope:auditScope,resource_id:"approval_clock_marks",resource_digest:emptyMetadataRoot({...scope,collection:"approval_clock_marks_v1"})},
    {scope:auditScope,resource_id:"approval_payloads",resource_digest:emptyMetadataRoot({...scope,collection:"approval_payloads_v1"})},
    {scope:auditScope,resource_id:"approval_records",resource_digest:plan.proposed_root}],mutation:()=>{writer.stage(plan);return null;}};
  });
 }
 let current:ApprovalCreateGrant=grant(),rotated=false,revoked=false,authorityCalls=0,activeCalls=0,wrapCalls=0;
 const lookup:ApprovalCreateKeyLookup={content:version=>{if(version===null){activeCalls++;return rotated?{...content,version:2,secret:Buffer.alloc(32,74)}:content;}
  return {...content,state:revoked?"revoked":rotated?"verification_only":"active"};},wrapping:()=>{wrapCalls++;return wrapping;},notification:()=>notification};
 // Only an in-memory authority fixture. No real source/binding authorization.
 const broker=new ApprovalCreateBroker(f.db,f.providers,scope,actual=>{authorityCalls++;assert.equal(actual.source_ref,intent.source_ref);return current;},lookup);
 return {...f,broker,lookup,records:new ApprovalRecordRepository(f.db,f.providers.auditAnchors,f.providers.auditKeys,scope),
  payloads:new ApprovalPayloadRepository(f.db,f.providers.auditAnchors,f.providers.auditKeys,scope),history:new ApprovalClockHistory(f.db,scope),
  setGrant:(value:ApprovalCreateGrant)=>{current=value;},rotate:()=>{rotated=true;},revoke:()=>{revoked=true;},counts:()=>({authorityCalls,activeCalls,wrapCalls})};
}
export const count=(f:ReturnType<typeof fixture>,table:"approval_requests"|"approval_notifications"|"approval_payload_secrets")=>f.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
