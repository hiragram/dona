import fs from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import {verifyIngressContext,untrustedContextHints,ingressContextRequest,type ContextKey} from "../../src/web/context.js";
const fixture=JSON.parse(fs.readFileSync(new URL("../../../test-fixtures/web-ingress-context-v1.json",import.meta.url),"utf8"));
const key:ContextKey={purpose:"web_ingress_context",version:1,state:"active",activated_at:"2026-09-01T00:00:00.000Z",signing_expires_at:"2026-11-01T00:00:00.000Z",secret:Buffer.alloc(32,fixture.key_byte)};
test("BFF生成fixtureをDispatcherが独立に照合し改変を拒否する",()=>{
 assert.equal(fixture.fixture_only,true);
 for(const item of fixture.fixtures){
  const request=ingressContextRequest("GET",item.target,Buffer.alloc(0));
  assert.deepEqual(request,item.request);
  assert.deepEqual(untrustedContextHints(item.token),{key_version:1,session_ref:"session"});
  assert.equal(verifyIngressContext(item.token,key,fixture.identity,request,fixture.now).identity.session_ref,"session");
  for(const [name,value] of Object.entries(fixture.identity)) {
   const changed={...fixture.identity,[name]:typeof value==="number"?2:"different"};
   assert.throws(()=>verifyIngressContext(item.token,key,changed,request,fixture.now));
  }
  assert.throws(()=>verifyIngressContext(item.token,key,fixture.identity,{...request,body_digest:"0".repeat(64)},fixture.now));
  assert.throws(()=>verifyIngressContext(item.token,key,fixture.identity,request,"2026-09-19T00:00:11.000Z"));
  assert.throws(()=>verifyIngressContext(item.token,{...key,state:"revoked"},fixture.identity,request,fixture.now));
 }
 const job1=fixture.fixtures.find((item:{target:string})=>item.target==="/api/jobs/job_1");
 assert.throws(()=>verifyIngressContext(job1.token,key,fixture.identity,ingressContextRequest("GET","/api/jobs/job_2",Buffer.alloc(0)),fixture.now));
});
