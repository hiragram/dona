import test from "node:test";
import assert from "node:assert/strict";
import { OidcProtocol } from "../src/oidc.js";
import {sealLoginTransaction,openLoginTransaction,LoginProtectionError,type LoginBinding} from "../src/login-protection.js";
import type {SessionProtectionKey} from "../src/session-protection.js";
import {fixturePolicy,fixtureSecret} from "./fixtures.js";
const now="2026-09-19T00:00:00.000Z";
const key:SessionProtectionKey={purpose:"web_login_transaction",version:1,state:"active",activated_at:"2026-09-01T00:00:00.000Z",signing_expires_at:"2026-10-01T00:00:00.000Z",secret:Buffer.alloc(32,19)};
const owner:LoginBinding={instance_id:"i1",tenant_id:"t1",login_ref:"l1",bff_generation:1,cookie_key_version:1,cookie_digest:"a".repeat(64),created_at:now,expires_at:"2026-09-19T00:05:00.000Z"};
function fixture(){return new OidcProtocol(fixturePolicy(),{clientSecret:()=>fixtureSecret}).createLogin(Date.parse(now)/1000).transaction;}
test("loginのstate・nonce・verifierを独立purposeの暗号文へ封印する",()=>{
 const transaction=fixture(),a=sealLoginTransaction(transaction,owner,key,now),b=sealLoginTransaction(transaction,owner,key,now);
 assert.notEqual(a.nonce,b.nonce);assert.deepEqual(openLoginTransaction(a,owner,key,now),transaction);
 for(const secret of [transaction.state,transaction.nonce,transaction.verifier])assert.ok(!JSON.stringify(a).includes(secret));
});
test("login cookie・tenant・世代・期限への差替えは復号しない",()=>{
 const sealed=sealLoginTransaction(fixture(),owner,key,now);
 for(const patch of [{instance_id:"i2"},{tenant_id:"t2"},{login_ref:"l2"},{bff_generation:2},{cookie_key_version:2},{cookie_digest:"b".repeat(64)},
  {created_at:"2026-09-19T00:00:01.000Z",expires_at:"2026-09-19T00:05:01.000Z"}])
   assert.throws(()=>openLoginTransaction(sealed,{...owner,...patch},key,"2026-09-19T00:00:02.000Z"),LoginProtectionError);
 assert.throws(()=>openLoginTransaction(sealed,owner,key,owner.expires_at),LoginProtectionError);
 assert.throws(()=>sealLoginTransaction({...fixture(),created_at:Date.parse(now)/1000+1},owner,key,now),LoginProtectionError);
});
test("login envelopeの改変と別purpose・失効keyを拒否する",()=>{
 const sealed=sealLoginTransaction(fixture(),owner,key,now);
 for(const patch of [{nonce:"a".repeat(16)},{tag:"a".repeat(22)},{ciphertext:"a".repeat(100)},{sealed_at:"2026-09-19T00:00:01.000Z"},{codec_version:2},{extra:true}])
  assert.throws(()=>openLoginTransaction({...sealed,...patch},owner,key,now),{name:"LoginProtectionError",message:"login_protection_unverified"});
 for(const patch of [{purpose:"web_access_token" as const},{state:"revoked" as const},{version:2},{secret:Buffer.alloc(32,20)}])
  assert.throws(()=>openLoginTransaction(sealed,owner,{...key,...patch},now),LoginProtectionError);
});
test("rotation済みkeyはloginの復号だけに利用する",()=>{
 const transaction=fixture(),sealed=sealLoginTransaction(transaction,owner,key,now),old={...key,state:"verification_only" as const};
 assert.deepEqual(openLoginTransaction(sealed,owner,old,now),transaction);
 assert.throws(()=>sealLoginTransaction(transaction,owner,old,now),LoginProtectionError);
 assert.throws(()=>sealLoginTransaction(transaction,owner,{...key,signing_expires_at:now},now),LoginProtectionError);
});
