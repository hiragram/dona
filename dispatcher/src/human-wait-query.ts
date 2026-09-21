import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { AgentExecutionContext } from "./agent-context.js";
import type { AgentReadAuthorization } from "./agent-read-authorization.js";
import type { HumanWaitItemRow, HumanWaitRepository, HumanWaitScanCursor } from "./human-wait.js";
import { stableStringify } from "./validation.js";

export class HumanWaitQueryError extends Error {
  constructor(readonly code:"human_wait_query_unavailable"|"human_wait_cursor_invalid"|"human_wait_origin_unavailable") {
    super(code); this.name="HumanWaitQueryError";
  }
}

interface CursorPayload extends HumanWaitScanCursor {
  v:1; tenant_id:string; workspace_id:string; principal_id:string; policy_revision:number;
  event_id:string;cursor_scope:"list"|"presentation";destination_sha256:string;grant_revision:string;visibility_revision:string;read_revision:number;
}

export interface HumanWaitProjection {
  item_id:string; category:HumanWaitItemRow["resource_kind"]; reason:HumanWaitItemRow["reason_code"];
  decision:HumanWaitItemRow["decision_kind"]; state:"open"; opened_at:string; updated_at:string;
  origin:{available:true;origin_ref:string}; revision:number;
}

function canonical(payload:CursorPayload):string {
  return JSON.stringify({v:payload.v,tenant_id:payload.tenant_id,workspace_id:payload.workspace_id,
    principal_id:payload.principal_id,event_id:payload.event_id,cursor_scope:payload.cursor_scope,destination_sha256:payload.destination_sha256,
    policy_revision:payload.policy_revision,grant_revision:payload.grant_revision,
    visibility_revision:payload.visibility_revision,read_revision:payload.read_revision,
    updated_at:payload.updated_at,item_id:payload.item_id});
}

export class HumanWaitQueryService {
  constructor(private readonly waits:HumanWaitRepository,private readonly reads:AgentReadAuthorization,
    private readonly cursorKey:Buffer,private readonly internalScanMax=500) {
    if(cursorKey.length<32)throw new Error("human_wait_cursor_key_invalid");
  }

  private encode(payload:CursorPayload):string {
    const body=Buffer.from(canonical(payload)).toString("base64url");
    return `${body}.${createHmac("sha256",this.cursorKey).update(body).digest("base64url")}`;
  }

  private decode(value:string):CursorPayload {
    try {
      const [body,signature,...extra]=value.split(".");
      if(!body||!signature||extra.length||value.length>2048)throw new Error();
      const expected=createHmac("sha256",this.cursorKey).update(body).digest();
      const actual=Buffer.from(signature,"base64url");
      if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error();
      const parsed=JSON.parse(Buffer.from(body,"base64url").toString("utf8")) as CursorPayload;
      if(parsed.v!==1||(parsed.cursor_scope!=="list"&&parsed.cursor_scope!=="presentation")||canonical(parsed)!==Buffer.from(body,"base64url").toString("utf8")||
        !Number.isSafeInteger(parsed.read_revision)||parsed.read_revision<1||
        !Number.isFinite(Date.parse(parsed.updated_at))||!/^wait_[a-f0-9]{32}$/.test(parsed.item_id))throw new Error();
      return parsed;
    } catch { throw new HumanWaitQueryError("human_wait_cursor_invalid"); }
  }

  private resource(item:HumanWaitItemRow) {
    return {item_id:item.item_id,source_event_id:item.parent_resource_id??item.resource_id,
      resource_kind:item.resource_kind,resource_id:item.resource_id,resource_revision:item.resource_revision,
      owner_kind:item.owner_kind,owner_principal_kind:item.owner_principal_kind,owner_principal_id:item.owner_principal_id,
      tenant_id:item.tenant_id,workspace_id:item.workspace_id,owner_binding_current:this.waits.authorizationCurrent(item),
      disclosure_origin:{kind:"human_wait_origin",origin_ref:item.origin_ref,resource_kind:item.resource_kind}} as const;
  }

  list(input:{context:AgentExecutionContext;destination:unknown;limit:number;cursor?:string;cursorScope?:"list"|"presentation";allowCrossEventCursor?:boolean}):{
    schema_version:1;items:HumanWaitProjection[];next_cursor?:string;has_more:boolean
  } {
    if(!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>50)throw new HumanWaitQueryError("human_wait_query_unavailable");
    const snapshot=this.reads.snapshot({context:input.context,operation:"read_own_human_waits",surface:"list_human_waits",
      disclosure_destination:input.destination});
    if(!snapshot)throw new HumanWaitQueryError("human_wait_query_unavailable");
    const revisionScope={tenantId:input.context.tenant_id,workspaceId:input.context.workspace_id,principalId:input.context.principal_id};
    const readRevision=this.waits.ownerRevision(revisionScope);
    const cursorScope=input.cursorScope??"list";
    const destinationSha256=createHash("sha256").update(stableStringify(input.destination)).digest("hex");
    const cursor=input.cursor?this.decode(input.cursor):undefined;
    if(cursor&&(cursor.tenant_id!==input.context.tenant_id||cursor.workspace_id!==input.context.workspace_id||
      cursor.principal_id!==input.context.principal_id||cursor.policy_revision!==snapshot.policy_revision||
      cursor.cursor_scope!==cursorScope||
      (cursor.event_id!==input.context.event_id&&!(input.allowCrossEventCursor&&cursorScope==="presentation"))||cursor.destination_sha256!==destinationSha256||
      cursor.grant_revision!==snapshot.grant_revision||cursor.visibility_revision!==snapshot.visibility_revision||
      cursor.read_revision!==readRevision))throw new HumanWaitQueryError("human_wait_cursor_invalid");
    const rows=this.waits.scanOwnerOpen({tenantId:input.context.tenant_id,workspaceId:input.context.workspace_id,
      principalId:input.context.principal_id,limit:this.internalScanMax+1,...(cursor?{after:cursor}:{})});
    const candidates=rows.slice(0,this.internalScanMax);
    const visible:HumanWaitItemRow[]=[];
    for(const item of candidates) {
      const decision=this.reads.authorizeResource({context:input.context,operation:"read_own_human_waits",surface:"list_human_waits",
        resource:this.resource(item),disclosure_destination:input.destination});
      if(decision.provider_failed)throw new HumanWaitQueryError("human_wait_query_unavailable");
      if(decision.allowed)visible.push(item);
      if(visible.length>input.limit)break;
    }
    if(this.waits.ownerRevision(revisionScope)!==readRevision)throw new HumanWaitQueryError("human_wait_cursor_invalid");
    if(rows.length>this.internalScanMax&&visible.length<=input.limit)throw new HumanWaitQueryError("human_wait_query_unavailable");
    const page=visible.slice(0,input.limit),hasMore=visible.length>input.limit;
    const continuation=page.at(-1);
    return {schema_version:1,items:page.map(item=>({item_id:item.item_id,category:item.resource_kind,reason:item.reason_code,
      decision:item.decision_kind,state:"open",opened_at:item.opened_at,updated_at:item.updated_at,
      origin:{available:true,origin_ref:item.origin_ref},revision:item.resource_revision})),has_more:hasMore,
      ...(hasMore&&continuation?{next_cursor:this.encode({v:1,tenant_id:input.context.tenant_id,workspace_id:input.context.workspace_id,
        principal_id:input.context.principal_id,event_id:input.context.event_id,cursor_scope:cursorScope,destination_sha256:destinationSha256,
        policy_revision:snapshot.policy_revision,grant_revision:snapshot.grant_revision,
        visibility_revision:snapshot.visibility_revision,read_revision:readRevision,
        updated_at:continuation.updated_at,item_id:continuation.item_id})}:{})};
  }

  resolveOrigin(input:{context:AgentExecutionContext;destination:unknown;originRef:string}):Record<string,unknown> {
    if(!/^origin_[a-f0-9]{32}$/.test(input.originRef))throw new HumanWaitQueryError("human_wait_origin_unavailable");
    const snapshot=this.reads.snapshot({context:input.context,operation:"resolve_origin_ref",surface:"resolve_human_wait_origin",
      disclosure_destination:input.destination});
    if(!snapshot)throw new HumanWaitQueryError("human_wait_origin_unavailable");
    const revisionScope={tenantId:input.context.tenant_id,workspaceId:input.context.workspace_id,principalId:input.context.principal_id};
    const before=this.waits.ownerRevision(revisionScope),item=this.waits.getByOriginRef(input.originRef);
    if(!item)throw new HumanWaitQueryError("human_wait_origin_unavailable");
    const decision=this.reads.authorizeResource({context:input.context,operation:"resolve_origin_ref",surface:"resolve_human_wait_origin",
      resource:this.resource(item),disclosure_destination:input.destination});
    if(!decision.allowed||decision.provider_failed||this.waits.ownerRevision(revisionScope)!==before)
      throw new HumanWaitQueryError("human_wait_origin_unavailable");
    return {schema_version:1,status:"available",origin:{kind:"opaque_origin",origin_ref:item.origin_ref,revision:item.resource_revision}};
  }
}
