import test from "node:test";
import assert from "node:assert/strict";
import {evaluateSession,scopeEligible,nextActivity,type RegistryPrincipal,type SessionState,type WebRuntimeState} from "../src/domain.js";
const runtime:WebRuntimeState={instance_id:"i1",tenant_id:"t1",bff_generation:1};
const registry:RegistryPrincipal={codec_version:1,instance_id:"i1",tenant_id:"t1",principal_id:"p1",state:"active",revoke_generation:1,
  identity_binding_revision:1,authz_revision:1,role_ids:["requester"],scopes:["job:submit","job:read:own","job:cancel:own"]};
const session:SessionState={codec_version:1,instance_id:"i1",tenant_id:"t1",principal_id:"p1",session_ref:"s1",state:"active",session_generation:1,
  principal_revoke_generation:1,identity_binding_revision:1,authz_revision:1,bff_generation:1,authenticated_at:"2026-09-19T00:00:00.000Z",
  expires_at:"2026-09-19T08:00:00.000Z",access_token_expires_at:"2026-09-19T09:00:00.000Z",last_activity_at:"2026-09-19T00:00:00.000Z"};
const now="2026-09-19T00:10:00.000Z";
test("principalは現行registryから再構成し外部identityを含めない",()=>{
  const result=evaluateSession(registry,session,runtime,now);assert.equal(result.allowed,true);
  if(!result.allowed)throw new Error(); assert.equal(result.principal.principal_id,"p1");
  assert.deepEqual(result.principal.role_ids,["requester"]);result.principal.role_ids.push("supervisor");
  assert.deepEqual(registry.role_ids,["requester"]);assert.equal("subject" in result.principal,false);
});
test("scope越境とprincipal差替えを拒否する",()=>{
  for(const change of [{instance_id:"i2"},{tenant_id:"t2"},{principal_id:"p2"}])
    assert.deepEqual(evaluateSession(registry,{...session,...change},runtime,now),{allowed:false,reason:"identity_mismatch"});
});
test("logout・revoke generation・BFF再起動とrevision更新で旧sessionを拒否する",()=>{
  for(const change of [{state:"revoked"},{principal_revoke_generation:2},{bff_generation:2}])
    assert.deepEqual(evaluateSession(registry,{...session,...change},runtime,now),{allowed:false,reason:"session_revoked"});
  for(const change of [{identity_binding_revision:2},{authz_revision:2}])
    assert.deepEqual(evaluateSession({...registry,...change},session,runtime,now),{allowed:false,reason:"revision_mismatch"});
  assert.deepEqual(evaluateSession({...registry,state:"revoked"},session,runtime,now),{allowed:false,reason:"session_revoked"});
});
test("idleと絶対期限のexact境界、token期限とclock巻戻りを拒否する",()=>{
  assert.deepEqual(evaluateSession(registry,session,runtime,"2026-09-19T00:30:00.000Z"),{allowed:false,reason:"session_expired"});
  assert.deepEqual(evaluateSession(registry,{...session,last_activity_at:"2026-09-19T07:59:00.000Z"},runtime,session.expires_at),{allowed:false,reason:"session_expired"});
  assert.deepEqual(evaluateSession(registry,{...session,expires_at:now,access_token_expires_at:now},runtime,now),{allowed:false,reason:"session_expired"});
  assert.deepEqual(evaluateSession(registry,{...session,last_activity_at:now},runtime,"2026-09-19T00:09:59.999Z"),{allowed:false,reason:"clock_anomaly"});
});
test("SSE・poll・内部再認可はidle期限を延長しない",()=>{
  for(const kind of ["sse","automatic_poll","internal_revalidation"] as const)assert.equal(nextActivity(session,kind,now),session.last_activity_at);
  for(const kind of ["user_navigation","user_command"] as const)assert.equal(nextActivity(session,kind,now),now);
  assert.throws(()=>nextActivity(session,"user_command","2026-09-19T00:30:00.000Z"));
});
test("roleとscopeの両方を要求しsupervisorへjob権限を付与しない",()=>{
  const result=evaluateSession({...registry,role_ids:["supervisor"],scopes:["approval:read:bound","approval:decide:bound"]},session,runtime,now);
  assert.equal(result.allowed,true);if(!result.allowed)throw new Error();
  assert.equal(scopeEligible(result.principal,"approval:read:bound"),true);
  assert.equal(scopeEligible(result.principal,"job:read:own"),false);assert.equal(scopeEligible(result.principal,"job:cancel:own"),false);
  const limited=evaluateSession({...registry,scopes:[]},session,runtime,now);assert.equal(limited.allowed,true);
  if(limited.allowed)assert.equal(scopeEligible(limited.principal,"job:submit"),false);
});
test("未知role・operator・scope不一致・sessionへの権限注入を拒否する",()=>{
  for(const input of [{...registry,role_ids:["operator"]},{...registry,scopes:["approval:decide:bound"]},{...registry,role_ids:["requester","requester"]}])
    assert.deepEqual(evaluateSession(input,session,runtime,now),{allowed:false,reason:"session_invalid"});
  assert.deepEqual(evaluateSession(registry,{...session,scopes:["job:submit"]},runtime,now),{allowed:false,reason:"session_invalid"});
});

test("activityエラーへ未検証入力を転載しない",()=>{
  assert.throws(()=>nextActivity({private:"fixture only"},"user_command",now),error=>error instanceof Error && error.message==="session_activity_invalid");
});

test("全roleとcommand・read・approval scopeの適格性を表で検証する",()=>{
  const table={requester:["job:submit","job:read:own","job:cancel:own"],observer:["job:read:granted"],supervisor:["approval:read:bound","approval:decide:bound"]} as const;
  const scopes=Object.values(table).flat();
  for(const role of ["requester","observer","supervisor"] as const){
    const result=evaluateSession({...registry,role_ids:[role],scopes:table[role]},session,runtime,now);
    assert.equal(result.allowed,true);if(!result.allowed)throw new Error();
    for(const scope of scopes)assert.equal(scopeEligible(result.principal,scope),(table[role] as readonly string[]).includes(scope));
    assert.equal(scopeEligible(result.principal,"operator:admin"),false);
  }
});
