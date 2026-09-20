import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { matchWebRoute, matchesRouteBinding } from "./routes.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const utc = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const contextIdentitySchema = z.strictObject({
  instance_id:id, tenant_id:id, principal_id:id, session_ref:id,
  session_generation:revision, principal_revoke_generation:revision,
  identity_binding_revision:revision, authz_revision:revision, bff_generation:revision,
});
export type ContextIdentity = z.infer<typeof contextIdentitySchema>;
const requestSchema = z.strictObject({ method:z.enum(["GET","POST"]), route_id:id, body_digest:digest,
  resource:z.strictObject({kind:z.enum(["job","approval"]),id}).nullable(),
}).refine(value => matchesRouteBinding(value.route_id,value.method,value.resource));
export type ContextRequest = z.infer<typeof requestSchema>;
const claimsSchema = z.strictObject({
  codec_version:z.literal(1), audience:z.literal("dona.dispatcher.web-ingress"),
  key_version:revision, identity:contextIdentitySchema, request:requestSchema,
  issued_at:utc, expires_at:utc, nonce:z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).refine(value => Date.parse(value.expires_at)>Date.parse(value.issued_at)
  && Date.parse(value.expires_at)-Date.parse(value.issued_at)<=10_000);
export type ContextClaims=z.infer<typeof claimsSchema>;
export interface ContextKey {
  purpose:"web_ingress_context"; version:number; state:"active"|"verification_only"|"revoked";
  activated_at:string; signing_expires_at:string; secret:Uint8Array;
}
export class ContextError extends Error { constructor(){super("web_context_unverified");this.name="ContextError";} }
function guard<T>(action:()=>T):T {try{return action();}catch{throw new ContextError();}}
function millis(value:string):number {return Date.parse(utc.parse(value));}
function keyCheck(key:ContextKey,issued:number,now:number,sign:boolean):void {
  revision.parse(key.version);
  const start=millis(key.activated_at), end=millis(key.signing_expires_at);
  if(key.purpose!=="web_ingress_context" || !(key.secret instanceof Uint8Array) || key.secret.length!==32
    || !["active","verification_only"].includes(key.state) || (sign && key.state!=="active")
    || end<=start || end-start>90*24*3600*1000 || issued<start || issued>=end || now<issued) throw new ContextError();
}
export function assertContextSigningKey(key:ContextKey,now:string):void {
  guard(()=>{const at=millis(now);keyCheck(key,at,at,true);});
}
function canonical(claims:ContextClaims):string {return JSON.stringify(claimsSchema.parse(claims));}
function mac(payload:string,key:ContextKey):Buffer {
  return createHmac("sha256",key.secret).update("dona.web.ingress-context.v1\0").update(payload).digest();
}
function decode(value:string):Buffer {
  if(!/^[A-Za-z0-9_-]+$/.test(value))throw new ContextError();
  const result=Buffer.from(value,"base64url");if(result.toString("base64url")!==value)throw new ContextError();return result;
}
export function requestBodyDigest(bytes:Uint8Array):string {
  return guard(()=>{if(!(bytes instanceof Uint8Array) || bytes.byteLength>65536)throw new ContextError();
    return createHash("sha256").update(bytes).digest("hex");});
}
/** Both peers derive the binding independently from the actual raw request
 * target and body, before URL normalization or resource authorization. */
export function ingressContextRequest(method:unknown,target:unknown,body:Uint8Array):ContextRequest {
  return guard(()=>{const route=matchWebRoute(method,target);
    return requestSchema.parse({method:route.method,route_id:route.id,resource:route.resource,body_digest:requestBodyDigest(body)});});
}
/** Caller supplies a freshly introspected, current verified session and a protected
 * clock. route_id comes from a fixed local route table, never a browser header. */
export function signIngressContext(identity:ContextIdentity,request:ContextRequest,key:ContextKey,now:string,sessionExpiresAt:string):string {
  return guard(()=>{
    const at=millis(now);keyCheck(key,at,at,true);
    const expires=Math.min(at+10000,millis(sessionExpiresAt));
    const claims=claimsSchema.parse({codec_version:1,audience:"dona.dispatcher.web-ingress",key_version:key.version,
      identity,request,issued_at:now,expires_at:new Date(expires).toISOString(),nonce:randomBytes(32).toString("base64url")});
    const payload=Buffer.from(canonical(claims)).toString("base64url");
    return payload+"."+mac(payload,key).toString("base64url");
  });
}
/** Cryptographic verification only. The authoritative repository MUST compare
 * current identity/revisions and consume nonce in the same audited transaction
 * as the authorized gate. No action or replay protection is provided here. */
export function verifyIngressContext(token:string,key:ContextKey,identityInput:ContextIdentity,requestInput:ContextRequest,now:string):ContextClaims {
  return guard(()=>{
    if(typeof token!=="string" || token.length>8192)throw new ContextError();
    const parts=token.split(".");if(parts.length!==2)throw new ContextError();
    const payload=parts[0]!, signature=decode(parts[1]!);
    if(signature.length!==32 || !timingSafeEqual(mac(payload,key),signature))throw new ContextError();
    const text=new TextDecoder("utf-8",{fatal:true}).decode(decode(payload));
    const claims=claimsSchema.parse(JSON.parse(text));
    if(canonical(claims)!==text || decode(claims.nonce).length!==32)throw new ContextError();
    const at=millis(now);keyCheck(key,millis(claims.issued_at),at,false);
    if(claims.key_version!==key.version || at>=millis(claims.expires_at)
      || JSON.stringify(contextIdentitySchema.parse(identityInput))!==JSON.stringify(claims.identity)
      || JSON.stringify(requestSchema.parse(requestInput))!==JSON.stringify(claims.request))throw new ContextError();
    return claims;
  });
}
