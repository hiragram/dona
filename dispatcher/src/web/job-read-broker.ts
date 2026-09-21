import { randomBytes } from "node:crypto";
import type { DispatcherDatabase, WebJobReadIdentity } from "../database.js";
import type { JobProgressPhase, JobRow } from "../types.js";
import type { WebAuthRepository } from "./repository.js";
import { webJobProjectionSchema, type WebJobProjection, type WebJobReadInput, type WebJobReadResult } from "./job-read-wire.js";

export interface WebJobProgressLookup { get(jobId:string):{sequence:number;phase:JobProgressPhase;updated_at:string}|undefined }
const safe=(value:unknown,maximum:number):string|null=>typeof value==="string"&&value.length>0&&value.length<=maximum&&/^[\P{Cc}\t\n\r]+$/u.test(value)?value:null;
const artifact=(value:unknown,index:number)=>{if(!value||typeof value!=="object"||Array.isArray(value))return null;const row=value as Record<string,unknown>;
  const kind=["file","report","log","other"].includes(String(row.kind))?row.kind as "file"|"report"|"log"|"other":null;
  if(!safe(row.name,128)||!kind)return null;const candidate=safe(row.media_type,128),media=candidate&&/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/iu.test(candidate)?candidate:null,size=Number.isSafeInteger(row.size_bytes)&&Number(row.size_bytes)>=0?Number(row.size_bytes):null;
  return{name:`artifact-${index+1}`,kind,...(media?{media_type:media}:{}),...(size!==null?{size_bytes:size}:{})};};
export class WebJobReadBroker {
  constructor(private readonly auth:WebAuthRepository,private readonly database:DispatcherDatabase,private readonly progress?:WebJobProgressLookup){}
  execute(input:WebJobReadInput):WebJobReadResult {try{
    const ingress=this.auth.verifySessionIngress(`web_job_read_${randomBytes(16).toString("hex")}`,input.context,input.method,input.target,Buffer.alloc(0));
    if(ingress.status==="denied")return{status:"denied",reason:ingress.reason==="scope_denied"?"scope_denied":"identity_unavailable"};
    if(ingress.kind!=="session_verified")return{status:"denied",reason:"identity_unavailable"};
    const identity:WebJobReadIdentity={instance_id:ingress.principal.instance_id,tenant_id:ingress.principal.tenant_id,principal_id:ingress.principal.principal_id};
    const url=new URL(input.target,"https://dona.invalid");
    if(input.operation==="list"){
      if(url.pathname!=="/api/jobs"||url.searchParams.size>2||url.searchParams.get("cursor")!==(input.cursor??null)
        ||url.searchParams.get("limit")!==(input.limit===undefined?null:String(input.limit)))return{status:"denied",reason:"invalid_request"};
      const page=this.database.listWebJobs(identity,input.limit??20,input.cursor);return{status:"succeeded",kind:"list",items:page.rows.map(row=>this.project(row)),next_cursor:page.next_cursor};
    }
    const match=/^\/api\/jobs\/([A-Za-z0-9_-]{1,128})(\/events)?$/.exec(url.pathname);
    if(!match||url.search)return{status:"denied",reason:"invalid_request"};const jobId=match[1]!,row=this.database.getWebJobForRead(jobId,identity);
    if(!row)return{status:"denied",reason:"not_found"};this.syncProgress(row);
    if(input.operation==="detail"&&match[2]===undefined)return{status:"succeeded",kind:"detail",job:this.project(row),event_cursor:this.database.webJobEventCursor(identity,jobId)};
    if(input.operation==="events"&&match[2]==="/events"&&input.cursor){const changes=this.database.listWebJobChanges(identity,jobId,input.cursor);
      return{status:"succeeded",kind:"events",job:this.project(this.database.getWebJobForRead(jobId,identity)!),event_cursor:changes.next_cursor,
        changed:changes.rows.length>0,reset_required:changes.reset_required};}
    return{status:"denied",reason:"invalid_request"};
  }catch(error){const message=error instanceof Error?error.message:"";return{status:"denied",reason:message.includes("cursor")?"cursor_invalid":message.includes("not_found")?"not_found":"internal_error"};}}
  private syncProgress(row:JobRow):void{const progress=this.progress?.get(row.job_id);if(progress)this.database.recordWebJobProgress(row.job_id,progress.sequence,progress.updated_at);}
  private project(row:JobRow):WebJobProjection {const progress=this.progress?.get(row.job_id);let result:WebJobProjection["result"]=null;
    if(row.result_json)try{const parsed=JSON.parse(row.result_json) as Record<string,unknown>,completed=safe(parsed.completed_at,64);
      if((parsed.status==="completed"||parsed.status==="failed")&&completed)result={status:parsed.status,summary:parsed.status==="completed"?"完了":"失敗",completed_at:completed,
        artifacts:Array.isArray(parsed.artifacts)?parsed.artifacts.slice(0,32).map(artifact).filter((value):value is NonNullable<typeof value>=>value!==null):[]};}catch{}
    const candidate=safe(row.last_error_code,64),error=candidate&&/^[a-z0-9_]+$/u.test(candidate)?candidate:null;return webJobProjectionSchema.parse({job_id:row.job_id,status:row.status,created_at:row.created_at,updated_at:row.updated_at,
      completed_at:row.completed_at,progress:progress?{sequence:progress.sequence,phase:progress.phase,updated_at:progress.updated_at}:null,result,error_code:error,
      control:{can_cancel:["queued","retryable_failed","running","blocked"].includes(row.status)}});}
}
