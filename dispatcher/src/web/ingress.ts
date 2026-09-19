import { createHash } from "node:crypto";
import type { AuditEvent } from "../audit/codec.js";
import { encodeWebAuthState, WebStateError, type WebAuthState } from "./model.js";
import { evaluateSession, type RegistryPrincipal, type WebPrincipal } from "./domain.js";
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
 * for finalization before returning the principal. This is session confirmation,
 * not a resource capability and not proof of navigation or user activity. */
export function prepareSessionIngress(input:WebAuthState,token:string,method:unknown,target:unknown,
 body:Uint8Array,now:string,lookup:WebContextKeyLookup):SessionIngressPlan {
 const state=encodeWebAuthState(input).state;
 const at=Date.parse(now);
 if(!Number.isFinite(at) || new Date(at).toISOString()!==now || at<Date.parse(state.updated_at))throw new WebStateError();
 let authenticated:{principal:RegistryPrincipal;session_ref:string}|undefined;
 const deny=(reason:AuditEvent["reason"]):SessionIngressPlan=>({next:state,result:{status:"denied",reason},session_ref:null,...authenticated});
 let request:ReturnType<typeof ingressContextRequest>,hints:ReturnType<typeof untrustedContextHints>;
 try {request=ingressContextRequest(method,target,body);hints=untrustedContextHints(token);}
 catch {return deny("proof_invalid");}
 if(request.method!=="GET" || !["session","dashboard"].includes(request.route_id) || body.byteLength!==0)return deny("operation_unsupported");
 const session=state.sessions.find(row=>row.state.session_ref===hints.session_ref);
 const principal=state.principals.find(row=>row.principal_id===session?.state.principal_id);
 if(!session || !principal)return deny("proof_invalid");
 let claims:ReturnType<typeof verifyIngressContext>;
 try {
  const key=lookup(hints.key_version);if(!key)return deny("proof_invalid");
  claims=verifyIngressContext(token,key,{
   instance_id:state.instance_id,tenant_id:state.tenant_id,principal_id:principal.principal_id,
   session_ref:session.state.session_ref,session_generation:session.state.session_generation,
   principal_revoke_generation:principal.revoke_generation,identity_binding_revision:principal.identity_binding_revision,
   authz_revision:principal.authz_revision,bff_generation:state.bff_generation,
  },request,now);
 }catch{return deny("proof_invalid");}
 authenticated={principal,session_ref:session.state.session_ref};
 const decision=evaluateSession(principal,session.state,{instance_id:state.instance_id,tenant_id:state.tenant_id,bff_generation:state.bff_generation},now);
 if(!decision.allowed)return deny(decision.reason);
 const nonce_digest=createHash("sha256").update("dona.web.ingress-nonce.v1\0").update(claims.nonce).digest("hex");
 if(state.used_nonces.some(row=>row.nonce_digest===nonce_digest))return deny("already_consumed");
 const retained=state.used_nonces.filter(row=>at<Date.parse(row.expires_at));
 if(retained.length>=2048)return deny("quota_exceeded");
 const next=encodeWebAuthState({...state,updated_at:now,used_nonces:[...retained,
  {nonce_digest,session_ref:session.state.session_ref,issued_at:claims.issued_at,expires_at:claims.expires_at}]
  .sort((a,b)=>a.nonce_digest<b.nonce_digest?-1:1)}).state;
 return {next,principal,session_ref:session.state.session_ref,result:{status:"succeeded",kind:"session_verified",principal:decision.principal}};
}
