import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentExecutionContext } from "../src/agent-context.js";
import { AgentReadAuthorization } from "../src/agent-read-authorization.js";
import { HumanWaitQueryError, HumanWaitQueryService } from "../src/human-wait-query.js";
import type { HumanWaitItemRow, HumanWaitRepository, HumanWaitScanCursor } from "../src/human-wait.js";

const context:AgentExecutionContext={event_id:"evt_01J00000000000000000000000",attempt:1,purpose:"human_command",
  tenant_id:"T_ONE",workspace_id:"T_ONE",principal_kind:"human",principal_id:"U_ONE",
  expires_at:"2026-09-21T01:00:00.000Z",policy_revision:1};
const destination={kind:"thread",workspace_id:"T_ONE",channel_id:"C_QUERY",thread_ts:"1.1"};

function row(suffix:string,updated:string):HumanWaitItemRow {
  return {item_id:`wait_${suffix.repeat(32).slice(0,32)}`,dedupe_key:`job:${suffix}`,tenant_id:"T_ONE",workspace_id:"T_ONE",
    owner_kind:"human_verified",owner_principal_kind:"human",owner_principal_id:"U_ONE",decision_actor_kind:"owner",
    decision_kind:"provide_input",resource_kind:"job",resource_id:`PRIVATE-${suffix}`,parent_resource_id:"evt_01J00000000000000000000000",
    resource_revision:1,reason_code:"human_input",origin_ref:`origin_${suffix.repeat(32).slice(0,32)}`,source_revision:updated,
    state:"open",session_settlement_verified:1,opened_at:updated,updated_at:updated,resolved_at:null,stale_at:null,
    retain_until:"2026-10-21T00:00:00.000Z"};
}

class FakeWaits {
  revision=1;
  current=true;
  constructor(readonly rows:HumanWaitItemRow[]) {}
  ownerRevision(){return this.revision;}
  authorizationCurrent(){return this.current;}
  scanOwnerOpen(input:{limit:number;after?:HumanWaitScanCursor}) {
    const after=input.after;
    return this.rows.filter(item=>!after||item.updated_at<after.updated_at||
      (item.updated_at===after.updated_at&&item.item_id<after.item_id)).slice(0,input.limit);
  }
  getByOriginRef(value:string){return this.rows.find(item=>item.origin_ref===value);}
}

function service(waits:FakeWaits,visible:(originRef:string)=>boolean=()=>true) {
  const reads=new AgentReadAuthorization(
    {authorize:()=>true,revision:()=>"grant-1"},
    {authorize:value=>visible((value.disclosure_origin as {origin_ref:string}).origin_ref),revision:()=>"visibility-1"},
  );
  return new HumanWaitQueryService(waits as unknown as HumanWaitRepository,reads,Buffer.alloc(32,7),20);
}

test("verified ownerをfilter-after-authしてallowlist projectionとstable cursorだけを返す",()=>{
  const waits=new FakeWaits([row("a","2026-09-21T00:00:03.000Z"),row("b","2026-09-21T00:00:02.000Z"),row("c","2026-09-21T00:00:01.000Z")]);
  const query=service(waits,origin=>!origin.endsWith("b".repeat(32)));
  const first=query.list({context,destination,limit:1});
  assert.equal(first.items.length,1);
  assert.equal(first.has_more,true);
  assert.ok(first.next_cursor);
  assert.equal(JSON.stringify(first).includes("PRIVATE-"),false);
  assert.deepEqual(Object.keys(first.items[0]!).sort(),["category","decision","item_id","opened_at","origin","reason","revision","state","updated_at"]);
  const second=query.list({context,destination,limit:1,cursor:first.next_cursor});
  assert.equal(second.items[0]?.item_id,row("c","2026-09-21T00:00:01.000Z").item_id);
  assert.equal(second.has_more,false);
});

test("cursor改ざんとprincipal/grant/read revision変更はfallbackせず拒否する",()=>{
  const waits=new FakeWaits([row("a","2026-09-21T00:00:03.000Z"),row("b","2026-09-21T00:00:02.000Z")]);
  const query=service(waits);
  const cursor=query.list({context,destination,limit:1}).next_cursor!;
  for(const invalid of [`${cursor}x`,cursor]) {
    if(invalid===cursor)waits.revision++;
    assert.throws(()=>query.list({context,destination,limit:1,cursor:invalid}),
      (error:unknown)=>error instanceof HumanWaitQueryError&&error.code==="human_wait_cursor_invalid");
  }
  const fresh=service(new FakeWaits([row("a","2026-09-21T00:00:03.000Z"),row("b","2026-09-21T00:00:02.000Z")])).list({context,destination,limit:1}).next_cursor!;
  assert.throws(()=>service(new FakeWaits(waits.rows)).list({context:{...context,event_id:"evt_01J00000000000000000000001"},destination,limit:1,cursor:fresh}),
    (error:unknown)=>error instanceof HumanWaitQueryError&&error.code==="human_wait_cursor_invalid");
  assert.throws(()=>service(new FakeWaits(waits.rows)).list({context,destination:{...destination,channel_id:"C_OTHER"},limit:1,cursor:fresh}),
    (error:unknown)=>error instanceof HumanWaitQueryError&&error.code==="human_wait_cursor_invalid");
});

test("provider failureは0件へ縮退せず、originはcurrent accessで再認可する",()=>{
  const waits=new FakeWaits([row("a","2026-09-21T00:00:03.000Z")]);
  const failing=new AgentReadAuthorization(
    {authorize:()=>{throw new Error("provider timeout");},revision:()=>"grant-1"},
    {authorize:()=>true,revision:()=>"visibility-1"},
  );
  const unavailable=new HumanWaitQueryService(waits as unknown as HumanWaitRepository,failing,Buffer.alloc(32,8));
  assert.throws(()=>unavailable.list({context,destination,limit:10}),
    (error:unknown)=>error instanceof HumanWaitQueryError&&error.code==="human_wait_query_unavailable");
  const revoked=service(waits,()=>false);
  assert.throws(()=>revoked.resolveOrigin({context,destination,originRef:waits.rows[0]!.origin_ref}),
    (error:unknown)=>error instanceof HumanWaitQueryError&&error.code==="human_wait_origin_unavailable");
});

test("schedule ownerを含め、binding失効を拒否し、内部走査上限では存在を漏らさずfail closedにする",()=>{
  const schedule={...row("a","2026-09-21T00:00:03.000Z"),owner_kind:"schedule" as const,
    resource_kind:"schedule_run" as const,parent_resource_id:"sch_"+"a".repeat(32)};
  const hidden=row("b","2026-09-21T00:00:02.000Z"),tail=row("c","2026-09-21T00:00:01.000Z");
  const waits=new FakeWaits([schedule,hidden,tail]);
  const query=new HumanWaitQueryService(waits as unknown as HumanWaitRepository,new AgentReadAuthorization(
    {authorize:()=>true,revision:()=>"grant-1"},
    {authorize:value=>value.job_id!==hidden.resource_id,revision:()=>"visibility-1"},
  ),Buffer.alloc(32,9),2);
  assert.throws(()=>query.list({context,destination,limit:1}),
    (error:unknown)=>error instanceof HumanWaitQueryError&&error.code==="human_wait_query_unavailable");
  const bounded=new HumanWaitQueryService(waits as unknown as HumanWaitRepository,new AgentReadAuthorization(
    {authorize:()=>true,revision:()=>"grant-1"},
    {authorize:value=>value.job_id!==hidden.resource_id,revision:()=>"visibility-1"},
  ),Buffer.alloc(32,9),3);
  const first=bounded.list({context,destination,limit:1});
  assert.equal(first.items[0]?.category,"schedule_run");
  assert.equal(first.has_more,true); assert.ok(first.next_cursor);
  assert.equal(bounded.list({context,destination,limit:1,cursor:first.next_cursor}).items[0]?.item_id,tail.item_id);
  waits.current=false;
  assert.deepEqual(bounded.list({context,destination,limit:10}).items,[]);
});
