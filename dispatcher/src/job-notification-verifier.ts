import fs from "node:fs/promises";
import http from "node:http";
import type { DispatcherConfig } from "./config.js";
import type { JobNotificationEvidence,JobNotificationVerificationRequest } from "./database.js";

export interface JobNotificationVerifier { verify(input:JobNotificationVerificationRequest):Promise<JobNotificationEvidence>;settle(input:JobNotificationVerificationRequest):Promise<JobNotificationEvidence>; }

async function token(path:string):Promise<string> {
  const stat=await fs.lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0) throw new Error("job_delivery_internal_token_unavailable");
  const value=(await fs.readFile(path,"utf8")).trim(); if(value.length<32) throw new Error("job_delivery_internal_token_unavailable"); return value;
}

export class SlackAdapterJobNotificationVerifier implements JobNotificationVerifier {
  constructor(private readonly config:DispatcherConfig) {}
  verify(input:JobNotificationVerificationRequest):Promise<JobNotificationEvidence> { return this.request({...input,desired_session_status:null}); }
  settle(input:JobNotificationVerificationRequest):Promise<JobNotificationEvidence> { return this.request(input); }
  private async request(input:JobNotificationVerificationRequest):Promise<JobNotificationEvidence> {
    const encoded=Buffer.from(JSON.stringify(input)),secret=await token(this.config.updateInternalTokenPath);
    return new Promise((resolve,reject)=>{
      const request=http.request({socketPath:this.config.slackAdapterSocketPath,path:"/v1/internal/job-delivery-confirmations",method:"POST",headers:{"content-type":"application/json","content-length":String(encoded.length),"x-dona-update-token":secret}},response=>{
        const chunks:Buffer[]=[]; response.on("data",(chunk:Buffer)=>chunks.push(chunk)); response.on("end",()=>{try {
          const body=JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string,unknown>;
          if(response.statusCode!==200) throw new Error("job_delivery_not_confirmed");
          resolve(body as unknown as JobNotificationEvidence);
        } catch(error){reject(error);}});
      });
      request.setTimeout(this.config.jobCommandTimeoutMs,()=>request.destroy(new Error("job_delivery_confirmation_timeout")));
      request.once("error",reject); request.end(encoded);
    });
  }
}
