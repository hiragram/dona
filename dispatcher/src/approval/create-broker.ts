import type Database from "better-sqlite3";
import { types } from "node:util";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { assertSynchronousCallback, assertSynchronousResult } from "../audit/synchronous.js";
import type { VerifiedAuditState } from "../audit/codec.js";
import type { AuditEvent } from "../audit/codec.js";
import type { ApprovalTransactionProviders } from "./transaction.js";
import { ApprovalHistoryTransaction } from "./history-transaction.js";
import { ApprovalRecordRepository } from "./record-repository.js";
import { ApprovalRecordMutation } from "./record-mutation.js";
import type { ApprovalRecord, ApprovalRecordScope } from "./record-codec.js";
import { ApprovalPayloadMutation } from "./payload-mutation.js";
import { approvalCreationKey, decodeApprovalSnapshot, encodeApprovalSnapshot, type ApprovalSnapshot, type ApprovalSourceContext } from "./snapshot.js";
import { approvalExpiry, consumeTtlMs, type ClockMark } from "./clock.js";
import { createApprovalContentBinding, matchesApprovalContentBinding, sealApprovalPayload, type ApprovalPayloadKey } from "./payload-protection.js";
import { encodeApprovalPayloadEnvelope } from "./payload-metadata.js";
import { signApprovalNotificationMarker, type ApprovalNotificationKey } from "./notification-marker.js";
import { approvalSupervisorBindingRequired } from "./schema.js";
import type { SupervisorBindingGuard } from "./supervisor-binding.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const intentSchema = z.strictObject({ source_ref: id, operation_slot: id,
  target: z.strictObject({ channel_id: id, thread_ts: z.string().regex(/^[0-9]{10}\.[0-9]{6}$/) }), text: z.string().min(1).max(3000) });
export type ApprovalCreateIntent = z.infer<typeof intentSchema>;
type SnapshotBase = Omit<ApprovalSnapshot,"encrypted_content_ref"|"content_hmac_sha256"|"content_hmac_key_version">;
const denialReason = z.enum(["unauthenticated","unauthorized","unavailable","scope_mismatch","resource_not_visible","binding_revoked","revision_mismatch","invalid_input"]);
const label = z.string().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const grantSchema = z.discriminatedUnion("status",[
  z.strictObject({status:z.literal("denied"),reason:denialReason}),
  z.strictObject({status:z.literal("authorized"),snapshot:z.unknown(),binding_id:id,
    model_version:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/),
    display:z.strictObject({workspace_name:label,channel_name:label,supervisor_name:label,
      mentioned_users:z.array(z.strictObject({id,display_name:label})).max(3)})}),
]);
export type ApprovalCreateGrant =
  | {status:"denied";reason:z.infer<typeof denialReason>}
  | {status:"authorized";snapshot:SnapshotBase;binding_id:string;model_version:string;
      display:{workspace_name:string;channel_name:string;supervisor_name:string;mentioned_users:Array<{id:string;display_name:string}>}};
/** Trusted runtime dependency, never a browser/MCP supplied callback. The port
 * binds source_ref to the authenticated connection and persisted source owner /
 * operation slot, and freshly verifies binding, policy, requester permission,
 * supervisor visibility, shared-channel state and safe exact-draft disclosure.
 * A source/event/job ID alone must never produce a grant. No default provider is
 * supplied here. The state is valid only during this synchronous callback and
 * permits shared repository reads in the same verified transaction.
 * Production activation requires the real authenticated adapter. */
export type ApprovalCreateAuthority = (intent: Readonly<ApprovalCreateIntent>, mark: Readonly<ClockMark>, state: VerifiedAuditState) => ApprovalCreateGrant;
export interface ApprovalCreateKeyLookup {
  /** null selects the active signing key; a version selects a retained verifier. */
  content(version:number|null):ApprovalPayloadKey;
  wrapping():ApprovalPayloadKey;
  notification():ApprovalNotificationKey;
}
export type ApprovalCreateResult =
  | {status:"created"|"reused";request_handle:string;request_state:Extract<ApprovalRecord,{kind:"request"}>["row"]["state"];expires_at:string}
  | {status:"denied";reason:z.infer<typeof denialReason>|"idempotency_conflict"};
export class ApprovalCreateError extends Error {constructor(){super("approval_create_unverified");this.name="ApprovalCreateError";}}
function freeze<T>(input:T):T {if(input!==null && typeof input==="object"){for(const value of Object.values(input))freeze(value);Object.freeze(input);}return input;}
function mentions(text:string,allowed:readonly string[]):string[] {
 if(Buffer.from(text,"utf8").toString("utf8")!==text || /<!/.test(text))throw Error();
 const found:string[]=[],matches=[...text.matchAll(/<@([^>]*)>/g)];
 if(text.split("<@").length-1!==matches.length)throw Error();
 for(const match of matches){const user=match[1]!;if(!/^[UW][A-Z0-9]+$/.test(user)||!allowed.includes(user))throw Error();if(!found.includes(user))found.push(user);}
 if(found.length>3)throw Error();return found.sort();
}
/** 内部request作成。外部送信・decision・consumeを行わず、現在の認証済み
 * authorityが供給されないruntimeへ公開してはいけない。 */
export class ApprovalCreateBroker {
 private readonly scope:ApprovalRecordScope;
 private readonly transaction:ApprovalHistoryTransaction;
 private readonly records:ApprovalRecordRepository;
 private readonly recordMutation:ApprovalRecordMutation;
 private readonly payloadMutation:ApprovalPayloadMutation;
 private readonly keys:ApprovalCreateKeyLookup;
 constructor(private readonly db:Database.Database,providers:ApprovalTransactionProviders,scope:ApprovalRecordScope,
   private readonly authorize:ApprovalCreateAuthority,keys:ApprovalCreateKeyLookup,
   private readonly bindingGuard?:SupervisorBindingGuard){
  try{
   assertSynchronousResult(scope);this.scope=Object.freeze(z.strictObject({instance_id:id,workspace_id:id}).parse(scope));
   assertSynchronousCallback(authorize);
   if(approvalSupervisorBindingRequired(db)&&bindingGuard===undefined)throw Error();
   // Read descriptors rather than invoking accessor-backed configuration.
   if(keys===null||typeof keys!=="object"||types.isProxy(keys)||Object.getPrototypeOf(keys)!==Object.prototype)throw Error();
   const descriptors=Object.getOwnPropertyDescriptors(keys);
   if(Reflect.ownKeys(descriptors).length!==3)throw Error();
   for(const name of ["content","wrapping","notification"]){const d=descriptors[name];if(!d||!("value" in d))throw Error();assertSynchronousCallback(d.value);}
   this.keys=Object.freeze({content:(version:number|null)=>Reflect.apply(descriptors.content!.value!,undefined,[version]) as ApprovalPayloadKey,
    wrapping:()=>Reflect.apply(descriptors.wrapping!.value!,undefined,[]) as ApprovalPayloadKey,
    notification:()=>Reflect.apply(descriptors.notification!.value!,undefined,[]) as ApprovalNotificationKey});
   this.transaction=new ApprovalHistoryTransaction(db,providers,this.scope);
   this.records=new ApprovalRecordRepository(db,providers.auditAnchors,providers.auditKeys,this.scope);
   this.recordMutation=new ApprovalRecordMutation(db,this.scope);this.payloadMutation=new ApprovalPayloadMutation(db,this.scope);
  }catch{throw new ApprovalCreateError();}
 }
 create(transactionId:string,input:ApprovalCreateIntent):ApprovalCreateResult {
  try{
   if(approvalSupervisorBindingRequired(this.db)&&this.bindingGuard===undefined)throw Error();
   assertSynchronousResult(input);const intent=freeze(intentSchema.parse(input));
   return this.transaction.runPrepared<()=>ApprovalCreateResult>(transactionId,(mark,state)=>{
    const raw=this.authorize(intent,mark,state);assertSynchronousResult(raw);const parsed=grantSchema.parse(raw);
    const denied=(reason:ApprovalCreateResult & {status:"denied"},event:Omit<AuditEvent,"occurred_at">)=>({event,resource_digest:null,mutation:()=>reason});
    const baseEvent:Omit<AuditEvent,"occurred_at">={scope:{instance_id:this.scope.instance_id,tenant_id:this.scope.workspace_id},actor:{kind:"unauthenticated",id:null},
     action:"approval_request",operation:"slack.post_thread_reply.v1",resource_id:"approval_create",outcome:"denied",reason:"unauthenticated",session_ref:null,receipt_id:null,attempt_id:null,policy_revision:0,binding_revision:0,authz_revision:0};
    if(parsed.status==="denied")return denied({status:"denied",reason:parsed.reason},{...baseEvent,reason:parsed.reason});
    const grant=freeze(structuredClone(parsed)) as Extract<ApprovalCreateGrant,{status:"authorized"}>,source=grant.snapshot;
    const context:ApprovalSourceContext={...this.scope,request_source:source.request_source};
    const creationKey=approvalCreationKey(context);
    if(source.instance_id!==this.scope.instance_id||source.workspace_id!==this.scope.workspace_id
      ||source.request_source.operation_slot!==intent.operation_slot||source.target.channel_id!==intent.target.channel_id||source.target.thread_ts!==intent.target.thread_ts)throw Error();
    if(this.bindingGuard&&!this.bindingGuard.current(state,mark,"create",{binding_id:grant.binding_id,
      revision:source.preconditions.workspace_binding_revision,actor_id:null},source.target))
      return denied({status:"denied",reason:"binding_revoked"},{...baseEvent,reason:"binding_revoked"});
    const notified=mentions(intent.text,source.policy.allowed_user_mentions);
    if(JSON.stringify(grant.display.mentioned_users.map(user=>user.id).sort())!==JSON.stringify(notified))throw Error();
    // The full snapshot codec validates all policy/precondition/source fields below.
    const event={...baseEvent,actor:{kind:"principal" as const,id:context.request_source.owner_id},policy_revision:source.policy_revision,
      binding_revision:source.preconditions.workspace_binding_revision,authz_revision:source.preconditions.requester_authorization_revision};
    const prior=this.records.readAliasInState(state,{name:"request_creation",creation_key:creationKey});
    if(prior!==null){
     if(prior.kind!=="request")throw Error();
     const stored=JSON.parse(prior.row.snapshot_json) as ApprovalSnapshot;
     const saved=decodeApprovalSnapshot(prior.row.snapshot_json,prior.row.semantic_hash,{...this.scope,request_source:stored.request_source}).snapshot;
     if(!Object.keys(saved.request_source).every(field=>saved.request_source[field as keyof ApprovalSourceContext["request_source"]]===context.request_source[field as keyof ApprovalSourceContext["request_source"]]))
      return denied({status:"denied",reason:"unauthorized"},{...event,reason:"unauthorized"});
     const sameBody=matchesApprovalContentBinding(intent.text,this.scope,"draft",{key_version:saved.content_hmac_key_version,mac:saved.content_hmac_sha256,signed_at:prior.row.created_at},this.keys.content(saved.content_hmac_key_version));
     if(!sameBody)return denied({status:"denied",reason:"idempotency_conflict"},{...event,reason:"idempotency_conflict"});
     const candidate=encodeApprovalSnapshot({...source,encrypted_content_ref:saved.encrypted_content_ref,content_hmac_sha256:saved.content_hmac_sha256,content_hmac_key_version:saved.content_hmac_key_version},context);
     if(candidate.semantic_hash!==prior.row.semantic_hash||prior.row.binding_id!==grant.binding_id)
      return denied({status:"denied",reason:"idempotency_conflict"},{...event,reason:"idempotency_conflict"});
     return {event:{...event,resource_id:prior.row.request_id,outcome:"succeeded" as const,reason:"none" as const},resource_digest:null,
      mutation:()=>({status:"reused" as const,request_handle:prior.row.request_id,request_state:prior.row.state,expires_at:prior.row.expires_at})};
    }
    const contentKey=this.keys.content(null),wrapKey=this.keys.wrapping(),notificationKey=this.keys.notification();
    if(!(notificationKey.secret instanceof Uint8Array)||notificationKey.secret.byteLength!==32
      ||timingSafeEqual(notificationKey.secret,contentKey.secret)||timingSafeEqual(notificationKey.secret,wrapKey.secret))throw Error();
    const requestId="apr_"+randomUUID().replaceAll("-",""),payloadRef="app_"+randomUUID().replaceAll("-","");
    const content=createApprovalContentBinding(intent.text,this.scope,"draft",contentKey,mark);
    const snapshot=encodeApprovalSnapshot({...source,encrypted_content_ref:"payload-store:"+payloadRef,content_hmac_sha256:content.mac,content_hmac_key_version:content.key_version},context);
    const expires=approvalExpiry(mark,"request");
    const request:Extract<ApprovalRecord,{kind:"request"}>={codec_version:1,scope:this.scope,kind:"request",row:{request_id:requestId,...this.scope,creation_key:creationKey,
     snapshot_json:snapshot.canonical,semantic_hash:snapshot.semantic_hash,binding_id:grant.binding_id,binding_revision:source.preconditions.workspace_binding_revision,
     policy_revision:source.policy_revision,model_version:grant.model_version,state:"delivery_pending",revision:1,created_at:mark.effective_utc,expires_at:expires,consume_expires_at:null,clock_transaction_id:mark.transaction_id}};
    const binding={codec_version:1 as const,scope:this.scope,owner_kind:"request" as const,owner_id:requestId,request_id:requestId,semantic_hash:snapshot.semantic_hash,payload_ref:payloadRef,
     content,created_at:mark.effective_utc,expires_at:new Date(Date.parse(expires)+consumeTtlMs).toISOString()};
    const envelope=sealApprovalPayload(intent.text,binding,wrapKey,contentKey,mark);
    const changes:Array<{previous:null;next:ApprovalRecord}>=[{previous:null,next:request}];
    for(const kind of ["approval_card","pending_notice"] as const){
     const attempt="apn_"+randomUUID().replaceAll("-","");
     const marker=signApprovalNotificationMarker({codec_version:1,...this.scope,request_id:requestId,notification_attempt_id:attempt,kind,semantic_hash:snapshot.semantic_hash,created_at:mark.effective_utc,key_version:notificationKey.version},notificationKey,mark);
     changes.push({previous:null,next:{codec_version:1,scope:this.scope,kind:"notification",row:{notification_attempt_id:attempt,request_id:requestId,kind,state:"pending",request_revision:1,presentation_revision:1,
      marker_mac:marker,marker_key_version:notificationKey.version,fence:0,message_ref:null,clock_transaction_id:mark.transaction_id}}});
    }
    const records=this.recordMutation.prepare(mark,state,changes),payload=this.payloadMutation.prepare(mark,state,[{previous:null,
     next:{codec_version:1,binding,consume_id:null,envelope_digest:encodeApprovalPayloadEnvelope(envelope).digest,state:"active",deleted_at:null},envelope}]);
    return {event:{...event,resource_id:requestId,outcome:"succeeded" as const,reason:"none" as const},resource_commitments:[...payload.resource_commitments,...records.resource_commitments],
     mutation:()=>{records.mutation();payload.mutation();return {status:"created" as const,request_handle:requestId,request_state:request.row.state,expires_at:expires};}};
   });
  }catch{throw new ApprovalCreateError();}
 }
}
