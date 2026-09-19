import { createHash } from "node:crypto";
import { z } from "zod";
import { registryPrincipalSchema, sessionStateSchema } from "./domain.js";
const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const utc=z.string().refine(value=>Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value);
export const maximumWebMetadataBytes=4*1024*1024;
export const webStateScopeSchema=z.strictObject({instance_id:id,tenant_id:id});
export type WebStateScope=z.infer<typeof webStateScopeSchema>;
const aliasSchema=z.strictObject({principal_id:id,index_key_version:revision,subject_digest:digest});
const sessionSchema=z.strictObject({state:sessionStateSchema,cookie_key_version:revision,cookie_digest:digest,
 csrf_key_version:revision,token_key_version:revision,payload_ref:id.nullable(),payload_digest:digest.nullable()})
 .refine(value=>(value.state.state==="active") === (value.payload_ref!==null && value.payload_digest!==null)
  && (value.state.state!=="revoked" || (value.payload_ref===null && value.payload_digest===null)));
export type StoredWebSession=z.infer<typeof sessionSchema>;
const loginBindingSchema=z.strictObject({instance_id:id,tenant_id:id,login_ref:id,bff_generation:revision,
 cookie_key_version:revision,cookie_digest:digest,created_at:utc,expires_at:utc})
 .refine(value=>Date.parse(value.expires_at)-Date.parse(value.created_at)===300000);
const loginSchema=z.strictObject({binding:loginBindingSchema,payload_ref:id,payload_digest:digest,key_version:revision});
export type StoredWebLogin=z.infer<typeof loginSchema>;
const nonceSchema=z.strictObject({nonce_digest:digest,session_ref:id,issued_at:utc,expires_at:utc})
 .refine(value=>Date.parse(value.expires_at)>Date.parse(value.issued_at)
  && Date.parse(value.expires_at)-Date.parse(value.issued_at)<=10000);
const consumedLoginSchema=z.strictObject({receipt_id:id,login_ref:id,bff_generation:revision,consumed_at:utc,expires_at:utc})
 .refine(value=>Date.parse(value.expires_at)>Date.parse(value.consumed_at)
  && Date.parse(value.expires_at)-Date.parse(value.consumed_at)<=10000);
function ordered<T>(rows:readonly T[],key:(row:T)=>string):boolean {
 return rows.every((row,index)=>index===0 || key(row)>key(rows[index-1]!));
}
export const webAuthStateSchema=z.strictObject({
 codec_version:z.literal(1),instance_id:id,tenant_id:id,bff_generation:revision,created_at:utc,updated_at:utc,
 retained_subject_key_versions:z.array(revision).max(128),
 principals:z.array(registryPrincipalSchema).max(1024),aliases:z.array(aliasSchema).max(16384),
 sessions:z.array(sessionSchema).max(2048),logins:z.array(loginSchema).max(512),used_nonces:z.array(nonceSchema).max(2048),
 consumed_logins:z.array(consumedLoginSchema).max(512),
}).superRefine((value,ctx)=>{
 const bad=()=>ctx.addIssue({code:"custom",message:"web_state_invalid"});
 if(Date.parse(value.updated_at)<Date.parse(value.created_at)
  || !value.retained_subject_key_versions.every((version,index)=>index===0 || version>value.retained_subject_key_versions[index-1]!))bad();
 if(!ordered(value.principals,p=>p.principal_id) || !ordered(value.aliases,a=>JSON.stringify([a.index_key_version,a.subject_digest]))
  || !ordered(value.sessions,s=>s.state.session_ref) || !ordered(value.logins,l=>l.binding.login_ref)
  || !ordered(value.used_nonces,n=>n.nonce_digest) || !ordered(value.consumed_logins,l=>l.receipt_id))bad();
 const principals=new Set(value.principals.map(p=>p.principal_id)),sessionIds=new Set(value.sessions.map(s=>s.state.session_ref));
 const inScope=(candidate:WebStateScope)=>candidate.instance_id===value.instance_id && candidate.tenant_id===value.tenant_id;
 if(value.principals.some(p=>!inScope(p)) || value.sessions.some(s=>!inScope(s.state) || !principals.has(s.state.principal_id))
  || value.logins.some(l=>!inScope(l.binding)) || value.aliases.some(a=>!principals.has(a.principal_id)
    || !value.retained_subject_key_versions.includes(a.index_key_version))
  || value.used_nonces.some(n=>!sessionIds.has(n.session_ref)))bad();
 if(value.sessions.some(s=>s.state.bff_generation>value.bff_generation) || value.logins.some(l=>l.binding.bff_generation!==value.bff_generation))bad();
 if(value.consumed_logins.some(l=>l.bff_generation!==value.bff_generation)
  || value.sessions.some(s=>Date.parse(s.state.last_activity_at)>Date.parse(value.updated_at))
  || value.logins.some(l=>Date.parse(l.binding.created_at)>Date.parse(value.updated_at))
  || value.consumed_logins.some(l=>Date.parse(l.consumed_at)>Date.parse(value.updated_at))
  || value.used_nonces.some(n=>Date.parse(n.issued_at)>Date.parse(value.updated_at)))bad();
 const loginRefs=[...value.logins.map(l=>l.binding.login_ref),...value.consumed_logins.map(l=>l.login_ref)];
 if(new Set(loginRefs).size!==loginRefs.length)bad();
 const cookies=[...value.sessions.map(s=>JSON.stringify([s.cookie_key_version,s.cookie_digest])),
  ...value.logins.map(l=>JSON.stringify([l.binding.cookie_key_version,l.binding.cookie_digest]))];
 const refs=[...value.sessions.flatMap(s=>s.payload_ref?[s.payload_ref]:[]),...value.logins.map(l=>l.payload_ref)];
 if(new Set(cookies).size!==cookies.length || new Set(refs).size!==refs.length)bad();
});
export type WebAuthState=z.infer<typeof webAuthStateSchema>;
export class WebStateError extends Error {constructor(){super("web_state_unverified");this.name="WebStateError";}}
function guard<T>(callback:()=>T):T {try{return callback();}catch{throw new WebStateError();}}
function canonical(value:unknown):string {
 if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
 if(value!==null && typeof value==="object")return `{${Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)
  .map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
 return JSON.stringify(value);
}
function hash(value:string):string{return createHash("sha256").update(value,"utf8").digest("hex");}
export function encodeWebAuthState(input:unknown):{state:WebAuthState;canonical:string;digest:string} {
 return guard(()=>{const state=webAuthStateSchema.parse(input),encoded=canonical(state);
  if(Buffer.byteLength(encoded,"utf8")>maximumWebMetadataBytes)throw new WebStateError();
  return {state,canonical:encoded,digest:hash("dona.web.auth-state.v1\0"+encoded)};});
}
export function decodeWebAuthState(encoded:string,scope:WebStateScope):ReturnType<typeof encodeWebAuthState> {
 return guard(()=>{if(typeof encoded!=="string" || Buffer.byteLength(encoded,"utf8")>maximumWebMetadataBytes)throw new WebStateError();
  const expected=webStateScopeSchema.parse(scope),result=encodeWebAuthState(JSON.parse(encoded));
  if(result.canonical!==encoded || result.state.instance_id!==expected.instance_id || result.state.tenant_id!==expected.tenant_id)throw new WebStateError();
  return result;});
}
function base64(value:string,maximum:number,exact?:number):boolean {
 if(!/^[A-Za-z0-9_-]+$/.test(value))return false;
 const bytes=Buffer.from(value,"base64url");return bytes.toString("base64url")===value && bytes.length<=maximum && (exact===undefined || bytes.length===exact);
}
const envelopeSchema=z.strictObject({codec_version:z.literal(1),key_version:revision,sealed_at:utc,
 nonce:z.string().length(16).refine(value=>base64(value,12,12)),
 ciphertext:z.string().min(1).max(10923).refine(value=>base64(value,8192)),
 tag:z.string().length(22).refine(value=>base64(value,16,16))});
export const storedPayloadSchema=z.strictObject({codec_version:z.literal(1),purpose:z.enum(["web_access_token","web_login_transaction"]),
 payload_ref:id,binding_digest:digest,envelope:envelopeSchema}).refine(value=>value.purpose!=="web_login_transaction" || base64(value.envelope.ciphertext,1024));
export type StoredWebPayload=z.infer<typeof storedPayloadSchema>;
export function encodeWebPayload(input:unknown):{payload:StoredWebPayload;canonical:string;digest:string} {
 return guard(()=>{const payload=storedPayloadSchema.parse(input),encoded=canonical(payload);
  return {payload,canonical:encoded,digest:hash("dona.web.sealed-payload.v1\0"+encoded)};});
}
export function webPayloadBinding(owner:StoredWebSession|StoredWebLogin):string {
 return guard(()=>{
  if("binding" in owner)return hash("dona.web.login-binding.v1\0"+canonical(loginSchema.parse(owner).binding));
  const session=sessionSchema.parse(owner).state;
  const binding={instance_id:session.instance_id,tenant_id:session.tenant_id,principal_id:session.principal_id,
   session_ref:session.session_ref,session_generation:session.session_generation,identity_binding_revision:session.identity_binding_revision,
   authz_revision:session.authz_revision,issued_at:session.authenticated_at,expires_at:session.expires_at};
  return hash("dona.web.session-binding.v1\0"+canonical(binding));
 });
}
export function verifyWebPayload(input:unknown,owner:StoredWebSession|StoredWebLogin):StoredWebPayload {
 return guard(()=>{const {payload,digest:actual}=encodeWebPayload(input),login="binding" in owner;
  const value=login?loginSchema.parse(owner):sessionSchema.parse(owner);
  const issued=login?(value as StoredWebLogin).binding.created_at:(value as StoredWebSession).state.authenticated_at;
  const expires=login?(value as StoredWebLogin).binding.expires_at:(value as StoredWebSession).state.expires_at;
  const key=login?(value as StoredWebLogin).key_version:(value as StoredWebSession).token_key_version;
  if(payload.purpose!==(login?"web_login_transaction":"web_access_token") || payload.payload_ref!==value.payload_ref
   || actual!==value.payload_digest || payload.binding_digest!==webPayloadBinding(owner) || payload.envelope.key_version!==key
   || Date.parse(payload.envelope.sealed_at)<Date.parse(issued) || Date.parse(payload.envelope.sealed_at)>=Date.parse(expires))throw new WebStateError();
  return payload;});
}
