import fs from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import {signIngressContext,verifyIngressContext,ingressContextRequest,type ContextKey} from "../src/context.js";
const fixture=JSON.parse(fs.readFileSync(new URL("../../../test-fixtures/web-ingress-context-v1.json",import.meta.url),"utf8"));
const key:ContextKey={purpose:"web_ingress_context",version:1,state:"active",activated_at:"2026-09-01T00:00:00.000Z",signing_expires_at:"2026-11-01T00:00:00.000Z",secret:Buffer.alloc(32,fixture.key_byte)};
test("BFFの署名と検証はDispatcher共有wire fixtureに一致する",()=>{
 assert.equal(fixture.fixture_only,true);
 for(const item of fixture.fixtures){
  const request=ingressContextRequest("GET",item.target,Buffer.alloc(0));
  assert.deepEqual(request,item.request);
  const expected=verifyIngressContext(item.token,key,fixture.identity,request,fixture.now);
  const generated=signIngressContext(fixture.identity,request,key,fixture.now,"2026-09-19T08:00:01.000Z");
  const actual=verifyIngressContext(generated,key,fixture.identity,request,fixture.now);
  assert.deepEqual({...actual,nonce:expected.nonce},expected);
  assert.notEqual(actual.nonce,expected.nonce);
  assert.throws(()=>verifyIngressContext(item.token,key,{...fixture.identity,authz_revision:2},request,fixture.now));
  assert.throws(()=>verifyIngressContext(item.token,key,fixture.identity,{...request,body_digest:"0".repeat(64)},fixture.now));
 }
 const job1=fixture.fixtures.find((item:{target:string})=>item.target==="/api/jobs/job_1");
 assert.throws(()=>verifyIngressContext(job1.token,key,fixture.identity,ingressContextRequest("GET","/api/jobs/job_2",Buffer.alloc(0)),fixture.now));
});
