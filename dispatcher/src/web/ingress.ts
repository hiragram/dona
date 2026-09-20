import { createHash } from "node:crypto";
import type { AuditEvent } from "../audit/codec.js";
import { encodeWebAuthState, WebStateError, type WebAuthState } from "./model.js";
import { evaluateSession, nextActivity, type RegistryPrincipal, type WebPrincipal } from "./domain.js";
import { ingressContextRequest, untrustedContextHints, verifyIngressContext, type ContextKey } from "./context.js";

export type WebContextKeyLookup = (version:number) => ContextKey | undefined;
export type SessionIngressResult = {status:"denied";reason:AuditEvent["reason"]}
 | {status:"succeeded";kind:"session_verified";principal:WebPrincipal};
export interface SessionIngressPlan {
 next:WebAuthState;
 result:SessionIngressResult;
 principal?:RegistryPrincipal;
 session_ref:string|null;
}
/** Pure plan only. The caller must verify the common audit root and current
 * payload in the same protected transaction, persist this nonce/state, and wait
 * for finalization before returning the principal. userNavigation is derived by
 * the BFF and bound by the authenticated service request, never browser JSON.
 * This grants no resource capability. Default confirmation is not activity. */
export function prepareSessionIngress(input:WebAuthState,token:string,method:unknown,target:unknown,
 body:Uint8Array,now:string,lookup:WebContextKeyLookup,userNavigation=false):SessionIngressPlan {
 const state=encodeWebAuthState(input).state;
 const at=Date.parse(now);
 if(!Number.isFinite(at) || new Date(at).toISOString()!==now || at<Date.parse(state.updated_at))throw new WebStateError();
 let authenticated:{principal:RegistryPrincipal;session_ref:string}|undefined;
 const deny=(reason:AuditEvent["reason"]):SessionIngressPlan=>({next:state,result:{status:"denied",reason},session_ref:null,...authenticated});
 let request:ReturnType<typeof ingressContextRequest>,hints:ReturnType<typeof untrustedContextHints>;
 try {request=ingressContextRequest(method,target,body);hints=untrustedContextHints(token);}
 catch {return deny("proof_invalid");}
 if(request.method!=="GET" || !["session","dashboard"].includes(request.route_id) || body.byteLength!==0)return deny("operation_unsupported");
 if(typeof userNavigation!=="boolean" || (userNavigation && request.route_id!=="dashboard"))return deny("operation_unsupported");
 const session=state.sessions.find(row=>row.state.session_ref===hints.session_ref);
 const principal=state.principals.find(row=>row.principal_id===session?.state.principal_id);
 if(!session || !principal)return deny("proof_invalid");
 let claims:ReturnType<typeof verifyIngressContext>;
 try {
  const key=lookup(hints.key_version);if(!key)return deny("proof_invalid");
  // Authenticate the original session binding first. Current registry/runtime
  // revisions are then evaluated below, preserving the audited revocation
  // reason without granting authority from an old binding.
  claims=verifyIngressContext(token,key,{
   instance_id:state.instance_id,tenant_id:state.tenant_id,principal_id:principal.principal_id,
   session_ref:session.state.session_ref,session_generation:session.state.session_generation,
   principal_revoke_generation:session.state.principal_revoke_generation,identity_binding_revision:session.state.identity_binding_revision,
   authz_revision:session.state.authz_revision,bff_generation:session.state.bff_generation,
  },request,now);
 }catch{return deny("proof_invalid");}
 authenticated={principal,session_ref:session.state.session_ref};
 const decision=evaluateSession(principal,session.state,{instance_id:state.instance_id,tenant_id:state.tenant_id,bff_generation:state.bff_generation},now);
 if(!decision.allowed)return deny(decision.reason);
 const nonce_digest=createHash("sha256").update("dona.web.ingress-nonce.v1\0").update(claims.nonce).digest("hex");
 if(state.used_nonces.some(row=>row.nonce_digest===nonce_digest))return deny("already_consumed");
 const retained=state.used_nonces.filter(row=>at<Date.parse(row.expires_at));
 if(retained.length>=2048)return deny("quota_exceeded");
 const sessions=userNavigation?state.sessions.map(row=>row.state.session_ref===session.state.session_ref
  ?{...row,state:{...row.state,last_activity_at:nextActivity(row.state,"user_navigation",now)}}:row):state.sessions;
 const next=encodeWebAuthState({...state,sessions,updated_at:now,used_nonces:[...retained,
  {nonce_digest,session_ref:session.state.session_ref,issued_at:claims.issued_at,expires_at:claims.expires_at}]
  .sort((a,b)=>a.nonce_digest<b.nonce_digest?-1:1)}).state;
 return {next,principal,session_ref:session.state.session_ref,result:{status:"succeeded",kind:"session_verified",principal:decision.principal}};
}
