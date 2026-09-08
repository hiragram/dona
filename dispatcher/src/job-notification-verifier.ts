import fs from "node:fs/promises";
import http from "node:http";
import type { DispatcherConfig } from "./config.js";
import type { JobNotificationEvidence,JobNotificationVerificationRequest } from "./database.js";

export interface JobNotificationVerifier { verify(input:JobNotificationVerificationRequest):Promise<JobNotificationEvidence>;settle(input:JobNotificationVerificationRequest):Promise<JobNotificationEvidence>;settleSession?(input:JobSessionSettlementRequest):Promise<Record<string,unknown>>; }
export interface JobSessionSettlementRequest {schema_version:1;event_id:string;workspace_id:string;channel_id:string;thread_ts:string;desired_session_status:"active"|"suspended";}

const deliveryConfirmationTimeoutMs=120_000;

async function token(path:string):Promise<string> {
  const stat=await fs.lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0) throw new Error("job_delivery_internal_token_unavailable");
  const value=(await fs.readFile(path,"utf8")).trim(); if(value.length<32) throw new Error("job_delivery_internal_token_unavailable"); return value;
}

export class SlackAdapterJobNotificationVerifier implements JobNotificationVerifier {
  constructor(private readonly config:DispatcherConfig) {}
  verify(input:JobNotificationVerificationRequest):Promise<JobNotificationEvidence> { return this.request({...input,desired_session_status:null}); }
  settle(input:JobNotificationVerificationRequest):Promise<JobNotificationEvidence> { return this.request(input); }
  settleSession(input:JobSessionSettlementRequest):Promise<Record<string,unknown>> { return this.post("/v1/internal/job-session-settlements",input,"job_session_not_settled"); }
  private async request(input:JobNotificationVerificationRequest):Promise<JobNotificationEvidence> {
    return this.post("/v1/internal/job-delivery-confirmations",input,"job_delivery_not_confirmed") as unknown as Promise<JobNotificationEvidence>;
  }
  private async post(path:string,input:unknown,errorCode:string):Promise<Record<string,unknown>> {
    const encoded=Buffer.from(JSON.stringify(input)),secret=await token(this.config.updateInternalTokenPath);
    return new Promise((resolve,reject)=>{
      const request=http.request({socketPath:this.config.slackAdapterSocketPath,path,method:"POST",headers:{"content-type":"application/json","content-length":String(encoded.length),"x-dona-update-token":secret}},response=>{
        const chunks:Buffer[]=[]; response.on("data",(chunk:Buffer)=>chunks.push(chunk)); response.on("end",()=>{try {
          const body=JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string,unknown>;
          if(response.statusCode!==200) throw new Error(errorCode);
          resolve(body);
        } catch(error){reject(error);}});
      });
      request.setTimeout(deliveryConfirmationTimeoutMs,()=>request.destroy(new Error("job_delivery_confirmation_timeout")));
      request.once("error",reject); request.end(encoded);
    });
  }
}
