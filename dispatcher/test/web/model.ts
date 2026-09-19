import test from "node:test";
import assert from "node:assert/strict";
import {encodeWebAuthState,decodeWebAuthState,encodeWebPayload,webPayloadBinding,verifyWebPayload,WebStateError,type WebAuthState,type StoredWebLogin,type StoredWebSession} from "../../src/web/model.js";
const scope={instance_id:"instance",tenant_id:"tenant"};
const now="2026-09-19T00:00:00.000Z";
const principal={codec_version:1 as const,instance_id:"instance",tenant_id:"tenant",principal_id:"principal",state:"active" as const,
 revoke_generation:1,identity_binding_revision:1,authz_revision:1,role_ids:["requester" as const],scopes:["job:read:own" as const]};
const empty:WebAuthState={codec_version:1,instance_id:"instance",tenant_id:"tenant",bff_generation:1,created_at:now,updated_at:now,
 retained_subject_key_versions:[1],principals:[],aliases:[],sessions:[],logins:[],consumed_logins:[],used_nonces:[]};
const envelope={codec_version:1 as const,key_version:1,sealed_at:now,nonce:Buffer.alloc(12,1).toString("base64url"),ciphertext:Buffer.alloc(20,2).toString("base64url"),tag:Buffer.alloc(16,3).toString("base64url")};
const login:StoredWebLogin={binding:{instance_id:"instance",tenant_id:"tenant",login_ref:"login",bff_generation:1,cookie_key_version:1,
 cookie_digest:"a".repeat(64),created_at:now,expires_at:"2026-09-19T00:05:00.000Z"},payload_ref:"login_payload",payload_digest:"0".repeat(64),key_version:1};
const session:StoredWebSession={state:{codec_version:1,instance_id:"instance",tenant_id:"tenant",principal_id:"principal",session_ref:"session",state:"active",session_generation:1,principal_revoke_generation:1,
 identity_binding_revision:1,authz_revision:1,bff_generation:1,authenticated_at:now,expires_at:"2026-09-19T08:00:00.000Z",access_token_expires_at:"2026-09-19T08:00:00.000Z",last_activity_at:now},
 cookie_key_version:1,cookie_digest:"b".repeat(64),csrf_key_version:1,token_key_version:1,payload_ref:"session_payload",payload_digest:"0".repeat(64)};
function sealed(owner:StoredWebLogin|StoredWebSession){
 const encoded=encodeWebPayload({codec_version:1,purpose:"binding" in owner?"web_login_transaction":"web_access_token",payload_ref:owner.payload_ref,binding_digest:webPayloadBinding(owner),envelope});
 return {owner:{...owner,payload_digest:encoded.digest},payload:encoded.payload};
}
test("metadata codecはcanonical表現と容量上限とexact scopeを要求する",()=>{
 const a=encodeWebAuthState(empty),b=encodeWebAuthState(Object.fromEntries(Object.entries(empty).reverse()));
 assert.equal(a.canonical,b.canonical);assert.equal(a.digest,b.digest);assert.deepEqual(decodeWebAuthState(a.canonical,scope),a);
 assert.throws(()=>decodeWebAuthState(a.canonical,{...scope,tenant_id:"other"}),WebStateError);
 for(const text of [" "+a.canonical,a.canonical.replace('"codec_version":1','"codec_version":1,"codec_version":1'),"a".repeat(4*1024*1024+1)])assert.throws(()=>decodeWebAuthState(text,scope),WebStateError);
});
test("metadataは重複や孤立したidentity・payload・nonce参照を拒否する",()=>{
 const state={...empty,principals:[principal],sessions:[session],logins:[login]};assert.ok(encodeWebAuthState(state));
 for(const patch of [{principals:[principal,principal]},{principals:[]},{sessions:[session,session]},
  {logins:[{...login,payload_ref:session.payload_ref!}]},
  {aliases:[{principal_id:"other",index_key_version:1,subject_digest:"a".repeat(64)}]},
  {aliases:[{principal_id:"principal",index_key_version:2,subject_digest:"a".repeat(64)}]},
  {used_nonces:[{nonce_digest:"a".repeat(64),session_ref:"other",issued_at:now,expires_at:"2026-09-19T00:00:10.000Z"}]},
  {sessions:[{...session,state:{...session.state,state:"revoked" as const}}]}])assert.throws(()=>encodeWebAuthState({...state,...patch}),WebStateError);
});
test("暗号化payloadをowner・用途・key version・digestへ結ぶ",()=>{
 for(const owner of [login,session]){
  const data=sealed(owner);assert.deepEqual(verifyWebPayload(data.payload,data.owner),data.payload);
  for(const patch of [{payload_ref:"other"},{binding_digest:"c".repeat(64)},{purpose:"unknown"},
   {envelope:{...envelope,key_version:2}},{envelope:{...envelope,nonce:"bad"}},{envelope:{...envelope,ciphertext:Buffer.alloc(8193).toString("base64url")}}])
   assert.throws(()=>verifyWebPayload({...data.payload,...patch},data.owner),WebStateError);
 }
 const data=sealed(login);assert.throws(()=>verifyWebPayload(data.payload,{...data.owner,binding:{...login.binding,login_ref:"other"}} as StoredWebLogin),WebStateError);
});
