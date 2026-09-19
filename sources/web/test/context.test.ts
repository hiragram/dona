import test from "node:test";
import assert from "node:assert/strict";
import {signIngressContext,verifyIngressContext,requestBodyDigest,ContextError,type ContextKey,type ContextIdentity} from "../src/context.js";
const key:ContextKey={purpose:"web_ingress_context",version:1,state:"active",activated_at:"2026-09-01T00:00:00.000Z",signing_expires_at:"2026-10-01T00:00:00.000Z",secret:Buffer.alloc(32,11)};
const identity:ContextIdentity={instance_id:"i",tenant_id:"t",principal_id:"p",session_ref:"s",session_generation:1,principal_revoke_generation:1,identity_binding_revision:1,authz_revision:1,bff_generation:1};
const request={method:"POST" as const,route_id:"job_submit",body_digest:requestBodyDigest(Buffer.from("{}"))};
const now="2026-09-19T00:00:00.000Z",end="2026-09-19T01:00:00.000Z";
function issue(){return signIngressContext(identity,request,key,now,end);}
test("contextは10秒とsession期限へ上限を設けnonceを毎回生成する",()=>{
 const a=verifyIngressContext(issue(),key,identity,request,now),b=verifyIngressContext(issue(),key,identity,request,now);
 assert.equal(a.expires_at,"2026-09-19T00:00:10.000Z");assert.notEqual(a.nonce,b.nonce);
 const short=signIngressContext(identity,request,key,now,"2026-09-19T00:00:03.000Z");
 assert.equal(verifyIngressContext(short,key,identity,request,now).expires_at,"2026-09-19T00:00:03.000Z");
 assert.throws(()=>signIngressContext(identity,request,key,now,now),ContextError);
});
test("expiry境界・未来発行・bodyとrouteとmethod差替えを拒否する",()=>{
 const token=issue();
 for(const at of ["2026-09-19T00:00:10.000Z","2026-09-18T23:59:59.999Z"])
   assert.throws(()=>verifyIngressContext(token,key,identity,request,at),ContextError);
 for(const patch of [{method:"GET" as const},{route_id:"cancel_job"},{body_digest:requestBodyDigest(Buffer.from("[]"))}])
   assert.throws(()=>verifyIngressContext(token,key,identity,{...request,...patch},now),ContextError);
});
test("identityとすべての世代・revisionの差替えを拒否する",()=>{
 const token=issue();
 for(const name of Object.keys(identity) as Array<keyof ContextIdentity>){
  const changed={...identity,[name]:typeof identity[name]==="number"?2:"different"};
  assert.throws(()=>verifyIngressContext(token,key,changed,request,now),ContextError);
 }
});
test("用途別鍵と失効を検証し旧鍵では検証だけ許可する",()=>{
 const token=issue();
 assert.ok(verifyIngressContext(token,{...key,state:"verification_only"},identity,request,now));
 for(const change of [{state:"revoked" as const},{version:2},{secret:Buffer.alloc(32,12)},{purpose:"wrong" as ContextKey["purpose"]}])
  assert.throws(()=>verifyIngressContext(token,{...key,...change},identity,request,now),ContextError);
 assert.throws(()=>signIngressContext(identity,request,{...key,state:"verification_only"},now,end),ContextError);
 assert.throws(()=>signIngressContext(identity,request,{...key,signing_expires_at:now},now,end),ContextError);
});
test("不正encodingと過大入力をsecretを含まない共通errorへ落とす",()=>{
 const token=issue();
 for(const value of [token+"=",token+".extra","private-token", "a".repeat(8193)]){
  assert.throws(()=>verifyIngressContext(value,key,identity,request,now),{name:"ContextError",message:"web_context_unverified"});
 }
 assert.throws(()=>requestBodyDigest(Buffer.alloc(65537)),ContextError);
 assert.equal(requestBodyDigest(Buffer.from("a")),requestBodyDigest(Buffer.from("a")));
});
