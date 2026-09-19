// Independently validate the BFF wire contract inside Dispatcher. Shared golden
// fixtures run in both packages without importing another runtime's dependencies.
import { z } from "zod";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const utc = z.string().refine(value => { const n=Date.parse(value); return Number.isFinite(n) && new Date(n).toISOString()===value; });
export const roleSchema = z.enum(["requester", "observer", "supervisor"]);
export const scopeSchema = z.enum(["job:submit", "job:read:own", "job:cancel:own", "job:read:granted", "approval:read:bound", "approval:decide:bound"]);
const scopeByRole = {
  requester: ["job:submit", "job:read:own", "job:cancel:own"],
  observer: ["job:read:granted"],
  supervisor: ["approval:read:bound", "approval:decide:bound"],
} as const;
export const registryPrincipalSchema = z.strictObject({
  codec_version:z.literal(1), instance_id:id,tenant_id:id,principal_id:id,
  state:z.enum(["active","revoked"]),revoke_generation:version,
  identity_binding_revision:version,authz_revision:version,
  role_ids:z.array(roleSchema).min(1).max(3),scopes:z.array(scopeSchema).max(6),
}).superRefine((value,ctx) => {
  const allowed = new Set<string>(value.role_ids.flatMap(role=>[...scopeByRole[role]]));
  if (new Set(value.role_ids).size!==value.role_ids.length || new Set(value.scopes).size!==value.scopes.length
    || value.scopes.some(scope=>!allowed.has(scope))) ctx.addIssue({code:"custom",message:"registry_invalid"});
});
export type RegistryPrincipal = z.infer<typeof registryPrincipalSchema>;
export const sessionStateSchema = z.strictObject({
  codec_version:z.literal(1),instance_id:id,tenant_id:id,principal_id:id,session_ref:id,
  state:z.enum(["active","revoked"]),session_generation:version,principal_revoke_generation:version,
  identity_binding_revision:version,authz_revision:version,bff_generation:version,
  authenticated_at:utc,expires_at:utc,access_token_expires_at:utc,last_activity_at:utc,
}).superRefine((value,ctx)=>{
  const start=Date.parse(value.authenticated_at);const end=Date.parse(value.expires_at);const last=Date.parse(value.last_activity_at);
  if(end<=start || end-start>8*3600*1000 || end>Date.parse(value.access_token_expires_at) || last<start || last>=end)
    ctx.addIssue({code:"custom",message:"session_invalid"});
});
export type SessionState=z.infer<typeof sessionStateSchema>;
export const runtimeStateSchema=z.strictObject({instance_id:id,tenant_id:id,bff_generation:version});
export type WebRuntimeState=z.infer<typeof runtimeStateSchema>;
export interface WebPrincipal {
  codec_version:1;instance_id:string;tenant_id:string;principal_id:string;
  identity_binding_revision:number;authz_revision:number;role_ids:RegistryPrincipal["role_ids"];scopes:RegistryPrincipal["scopes"];
  session_ref:string;session_generation:number;authenticated_at:string;expires_at:string;
}
export type SessionDenial="session_invalid"|"session_revoked"|"session_expired"|"identity_mismatch"|"revision_mismatch"|"clock_anomaly";
export type SessionDecision={allowed:false;reason:SessionDenial}|{allowed:true;principal:WebPrincipal};
/** Inputs must be read from the current verified registry/session snapshot.
 * This pure function does not perform introspection, audit, nonce consumption,
 * current resource authorization, or protected-clock verification itself. */
export function evaluateSession(registryInput:unknown,sessionInput:unknown,runtimeInput:unknown,nowInput:string):SessionDecision {
  try {
    const registry=registryPrincipalSchema.parse(registryInput);const session=sessionStateSchema.parse(sessionInput);
    const runtime=runtimeStateSchema.parse(runtimeInput);const now=Date.parse(utc.parse(nowInput));
    if([registry,session].some(value=>value.instance_id!==runtime.instance_id || value.tenant_id!==runtime.tenant_id)
      || registry.principal_id!==session.principal_id) return {allowed:false,reason:"identity_mismatch"};
    if(registry.state!=="active" || session.state!=="active" || registry.revoke_generation!==session.principal_revoke_generation
      || runtime.bff_generation!==session.bff_generation) return {allowed:false,reason:"session_revoked"};
    if(registry.identity_binding_revision!==session.identity_binding_revision || registry.authz_revision!==session.authz_revision)
      return {allowed:false,reason:"revision_mismatch"};
    if(now<Date.parse(session.last_activity_at) || now<Date.parse(session.authenticated_at)) return {allowed:false,reason:"clock_anomaly"};
    if(now>=Date.parse(session.expires_at) || now>=Date.parse(session.access_token_expires_at)
      || now-Date.parse(session.last_activity_at)>=30*60*1000) return {allowed:false,reason:"session_expired"};
    return {allowed:true,principal:{codec_version:1,instance_id:registry.instance_id,tenant_id:registry.tenant_id,principal_id:registry.principal_id,
      identity_binding_revision:registry.identity_binding_revision,authz_revision:registry.authz_revision,
      role_ids:[...registry.role_ids],scopes:[...registry.scopes],session_ref:session.session_ref,session_generation:session.session_generation,
      authenticated_at:session.authenticated_at,expires_at:session.expires_at}};
  }catch{return {allowed:false,reason:"session_invalid"};}
}
/** Eligibility only. Every resource predicate, bound supervisor and step-up proof
 * is still required by its authoritative repository; this never permits an action. */
export function scopeEligible(principal:WebPrincipal,scope:unknown):boolean {
  try {
    const value=scopeSchema.parse(scope);
    const roles=z.array(roleSchema).min(1).max(3).parse(principal.role_ids);
    const granted=z.array(scopeSchema).max(6).parse(principal.scopes);
    if(new Set(roles).size!==roles.length || new Set(granted).size!==granted.length) return false;
    const allowed=new Set<string>(roles.flatMap(role=>[...scopeByRole[role]]));
    return granted.every(scope=>allowed.has(scope)) && granted.includes(value);
  }catch{return false;}
}
export type SessionActivity="user_navigation"|"user_command"|"automatic_poll"|"sse"|"internal_revalidation";
export function nextActivity(sessionInput:unknown,kind:SessionActivity,nowInput:string):string {
 try {
  const session=sessionStateSchema.parse(sessionInput);const now=Date.parse(utc.parse(nowInput));
  if(session.state!=="active" || now<Date.parse(session.last_activity_at) || now>=Date.parse(session.expires_at)
    || now-Date.parse(session.last_activity_at)>=30*60*1000) throw new Error("session_activity_invalid");
  if(kind==="user_navigation" || kind==="user_command") return nowInput;
  if(kind==="automatic_poll" || kind==="sse" || kind==="internal_revalidation") return session.last_activity_at;
  throw new Error("session_activity_invalid");
 } catch { throw new Error("session_activity_invalid"); }
}
