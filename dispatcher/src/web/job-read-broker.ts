import { randomBytes } from "node:crypto";
import type { DispatcherDatabase, WebJobReadGrantMutation, WebJobReadIdentity } from "../database.js";
import type { JobProgressPhase, JobRow } from "../types.js";
import type { WebAuthRepository, WebJobReadIngressResult } from "./repository.js";
import { webJobProjectionSchema, type WebJobProjection, type WebJobReadInput, type WebJobReadResult } from "./job-read-wire.js";

export interface WebJobProgressLookup { get(jobId:string):{sequence:number;phase:JobProgressPhase;updated_at:string}|undefined }
const safe=(value:unknown,maximum:number):string|null=>typeof value==="string"&&value.length>0&&value.length<=maximum&&/^[\P{Cc}\t\n\r]+$/u.test(value)?value:null;
const artifact=(value:unknown,index:number)=>{if(!value||typeof value!=="object"||Array.isArray(value))return null;const row=value as Record<string,unknown>;
  const kind=["file","report","log","other"].includes(String(row.kind))?row.kind as "file"|"report"|"log"|"other":null;
  if(!safe(row.name,128)||!kind)return null;const candidate=safe(row.media_type,128),media=candidate&&/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/iu.test(candidate)?candidate:null,size=Number.isSafeInteger(row.size_bytes)&&Number(row.size_bytes)>=0?Number(row.size_bytes):null;
  return{name:`artifact-${index+1}`,kind,...(media?{media_type:media}:{}),...(size!==null?{size_bytes:size}:{})};};
export class WebJobReadBroker {
  constructor(private readonly auth:WebAuthRepository,private readonly database:DispatcherDatabase,private readonly progress?:WebJobProgressLookup){}
  mutateGrant(input:WebJobReadGrantMutation,at=new Date()) {
    const reconciled=this.database.reconcileWebJobReadGrant(input);if(reconciled)return reconciled;
    const current=input.operation==="grant"?this.auth.lookupPrincipalById(input.principal_id)??undefined:undefined;
    return this.database.mutateWebJobReadGrant(input,current,at);
  }
  execute(input:WebJobReadInput):WebJobReadResult {
    let authority:Extract<WebJobReadIngressResult,{status:"succeeded"}>|undefined;
    const operation=input.operation==="list"?"web.job_list.v1":input.operation==="detail"?"web.job_read.v1":"web.sse_subscribe.v1";
    let resourceId="web_jobs";
    const finish=(result:WebJobReadResult,outcome:"succeeded"|"denied"|"failed",reason:"none"|"resource_not_visible"|"scope_denied"|"invalid_input"|"unavailable")=>{
      if(!authority)return result;
      try{const current=this.auth.auditJobReadOutcome(`web_job_outcome_${randomBytes(16).toString("hex")}`,authority,operation,resourceId,outcome,reason);
        return current?result:{status:"denied",reason:"identity_unavailable"} as const;}
      catch{return{status:"denied",reason:"internal_error"} as const;}
    };
    try{
    const ingress=this.auth.verifyJobReadIngress(`web_job_read_${randomBytes(16).toString("hex")}`,input.context,input.method,input.target,Buffer.alloc(0));
    if(ingress.status==="denied")return{status:"denied",reason:ingress.reason==="scope_denied"?"scope_denied":"identity_unavailable"};
    if(ingress.kind!=="job_read_session_verified")return{status:"denied",reason:"identity_unavailable"};
    authority=ingress;const at=new Date(ingress.effective_utc);
    const scopes=new Set(ingress.principal.scopes),owns=scopes.has("job:read:own"),granted=scopes.has("job:read:granted");
    const authorization_kind=owns&&granted?"own_or_granted":owns?"own":granted?"granted":null;
    if(!authorization_kind)return finish({status:"denied",reason:"scope_denied"},"denied","scope_denied");
    const identity:WebJobReadIdentity={instance_id:ingress.principal.instance_id,tenant_id:ingress.principal.tenant_id,
      principal_id:ingress.principal.principal_id,identity_binding_revision:ingress.principal.identity_binding_revision,
      authz_revision:ingress.principal.authz_revision,authorization_kind};
    const url=new URL(input.target,"https://dona.invalid");
    if(input.operation==="list"){
      if(url.pathname!=="/api/jobs"||url.searchParams.size>2||url.searchParams.get("cursor")!==(input.cursor??null)
        ||url.searchParams.get("limit")!==(input.limit===undefined?null:String(input.limit)))return finish({status:"denied",reason:"invalid_request"},"denied","invalid_input");
      const page=this.database.listWebJobs(identity,input.limit??20,input.cursor,at);
      return finish({status:"succeeded",kind:"list",items:page.rows.map(row=>this.project(row,ingress.principal.principal_id,scopes)),next_cursor:page.next_cursor},"succeeded","none");
    }
    const match=/^\/api\/jobs\/([A-Za-z0-9_-]{1,128})(\/events)?$/.exec(url.pathname);
    if(!match||url.search)return finish({status:"denied",reason:"invalid_request"},"denied","invalid_input");
    const jobId=match[1]!;resourceId=jobId;const row=this.database.getWebJobForRead(jobId,identity,at);
    if(!row)return finish({status:"denied",reason:"not_found"},"denied","resource_not_visible");this.syncProgress(row,at);
    if(input.operation==="detail"&&match[2]===undefined){const snapshot=this.database.webJobSnapshot(identity,jobId,at);
      if(!snapshot)return finish({status:"denied",reason:"not_found"},"denied","resource_not_visible");
      return finish({status:"succeeded",kind:"detail",job:this.project(snapshot.row,ingress.principal.principal_id,scopes),event_cursor:snapshot.event_cursor},"succeeded","none");}
    if(input.operation==="events"&&match[2]==="/events"&&input.cursor){const changes=this.database.listWebJobChanges(identity,jobId,input.cursor,50,at);
      const current=this.database.getWebJobForRead(jobId,identity,at);if(!current)return finish({status:"denied",reason:"not_found"},"denied","resource_not_visible");
      return finish({status:"succeeded",kind:"events",job:this.project(current,ingress.principal.principal_id,scopes),event_cursor:changes.next_cursor,
        changed:changes.rows.length>0,reset_required:changes.reset_required},"succeeded","none");}
    return finish({status:"denied",reason:"invalid_request"},"denied","invalid_input");
  }catch(error){const message=error instanceof Error?error.message:"";
    const result:WebJobReadResult={status:"denied",reason:message.includes("cursor")?"cursor_invalid":message.includes("not_found")?"not_found":"internal_error"};
    if(authority)return finish(result,result.reason==="internal_error"?"failed":"denied",result.reason==="not_found"?"resource_not_visible":result.reason==="internal_error"?"unavailable":"invalid_input");
    return result.reason==="internal_error"?result:{status:"denied",reason:result.reason};}}
  private syncProgress(row:JobRow,receivedAt:Date):void{const progress=this.progress?.get(row.job_id);if(progress)this.database.recordWebJobProgress(row.job_id,progress.sequence,progress.updated_at,receivedAt);}
  private project(row:JobRow,principalId:string,scopes:Set<string>):WebJobProjection {const progress=this.progress?.get(row.job_id);let result:WebJobProjection["result"]=null;
    if(row.result_json)try{const parsed=JSON.parse(row.result_json) as Record<string,unknown>,completed=safe(parsed.completed_at,64);
      if((parsed.status==="completed"||parsed.status==="failed")&&completed)result={status:parsed.status,summary:parsed.status==="completed"?"完了":"失敗",completed_at:completed,
        artifacts:Array.isArray(parsed.artifacts)?parsed.artifacts.slice(0,32).map(artifact).filter((value):value is NonNullable<typeof value>=>value!==null):[]};}catch{}
    const candidate=safe(row.last_error_code,64),error=candidate&&/^[a-z0-9_]+$/u.test(candidate)?candidate:null;return webJobProjectionSchema.parse({job_id:row.job_id,status:row.status,created_at:row.created_at,updated_at:row.updated_at,
      completed_at:row.completed_at,progress:progress?{sequence:progress.sequence,phase:progress.phase,updated_at:progress.updated_at}:null,result,error_code:error,
      control:{can_cancel:row.actor_id===principalId&&scopes.has("job:cancel:own")&&["queued","preparing","dispatching","retryable_failed","running","blocked","needs_review"].includes(row.status)}});}
}
