import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {openAccessToken,cookieDigest,type SessionProtectionKey} from "../src/session-protection.js";
import {openLoginTransaction} from "../src/login-protection.js";
import {evaluateSession} from "../src/domain.js";

test("Dispatcherと共有する固定fixtureの暗号化形式とsession拒否契約を検証する",()=>{
 const wire=JSON.parse(fs.readFileSync(new URL("../../../test-fixtures/web-auth-wire-v1.json",import.meta.url),"utf8"));
 assert.equal(wire.fixture_only,true);
 const key=(purpose:SessionProtectionKey["purpose"],byte:number):SessionProtectionKey=>({purpose,version:1,state:"active",
  activated_at:"2026-09-01T00:00:00.000Z",signing_expires_at:"2026-11-01T00:00:00.000Z",secret:Buffer.alloc(32,byte)});
 assert.equal(openAccessToken(wire.payload.envelope,wire.session_binding,key("web_access_token",0x54),wire.now),"fixture-access-token");
 assert.deepEqual(openLoginTransaction(wire.login_payload.envelope,wire.login.binding,key("web_login_transaction",0x4c),wire.now),wire.login_plaintext);
 assert.equal(cookieDigest(wire.cookie,key("web_cookie_index",0x43),wire.now,"lookup"),wire.session.cookie_digest);
 assert.equal(cookieDigest(wire.login_cookie,key("web_cookie_index",0x43),wire.now,"lookup"),wire.login.binding.cookie_digest);
 for(const entry of wire.session_cases){
  assert.deepEqual(evaluateSession({...wire.principal,...entry.principal},{...wire.session.state,...entry.session},
   {instance_id:"instance",tenant_id:"tenant",bff_generation:1,...entry.runtime},entry.now??wire.now),{allowed:false,reason:entry.reason});
 }
});
