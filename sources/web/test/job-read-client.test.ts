import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test, { type TestContext } from "node:test";
import { createHash, createHmac } from "node:crypto";
import { WebJobReadClient } from "../src/job-read-client.js";
import { maximumWebJobReadBodyBytes, signWebJobReadProof, WebJobReadWireError, type WebJobReadResult } from "../src/job-read-wire.js";
import type { WebServiceCredential } from "../src/service-auth.js";

const scope={instance_id:"instance",tenant_id:"tenant"},now="2026-09-21T00:00:00.000Z";
const credential:WebServiceCredential={purpose:"web_bff_service",version:1,state:"active",...scope,activated_at:"2026-09-01T00:00:00.000Z",
  signing_expires_at:"2026-11-01T00:00:00.000Z",secret:Buffer.alloc(32,7)};
const lookup=(version:number)=>version===1?credential:undefined,hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const input={codec_version:1 as const,operation:"list" as const,method:"GET" as const,target:"/api/jobs?limit=50",context:"context",limit:50};
function responseProof(requestProof:string,requestBody:string,result:WebJobReadResult):string{const request=JSON.parse(Buffer.from(requestProof.split(".")[0]!,"base64url").toString());
  const response={codec_version:1,key_version:1,...scope,request_nonce:request.nonce,request_body_digest:hash(requestBody),request_proof_digest:hash(requestProof),issued_at:now,expires_at:request.expires_at,result};
  const payload=Buffer.from(JSON.stringify(response)).toString("base64url"),mac=createHmac("sha256",credential.secret).update("dona.web-job-read.response.v1\0").update(payload).digest("base64url");return `${payload}.${mac}`;}
async function server(t:TestContext,handler:(proof:string,body:string,response:http.ServerResponse)=>void){const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"djr-"));fs.chmodSync(directory,0o700);
  const socket=path.join(directory,"s");let calls=0;const listener=http.createServer((request,response)=>{calls++;const chunks:Buffer[]=[];request.on("data",chunk=>chunks.push(chunk));request.once("end",()=>handler(request.headers["x-dona-service-proof"] as string,Buffer.concat(chunks).toString(),response));});
  await new Promise<void>(resolve=>listener.listen(socket,resolve));fs.chmodSync(socket,0o600);t.after(async()=>{listener.closeAllConnections();await new Promise<void>(resolve=>listener.close(()=>resolve()));fs.rmSync(directory,{recursive:true,force:true});});
  return{socket,directory,get calls(){return calls;},client:(deadline=1000)=>new WebJobReadClient(socket,scope,()=>credential,lookup,()=>now,deadline)};}
function send(response:http.ServerResponse,body:string,extra:Record<string,string|string[]>={}){response.writeHead(200,{"content-type":"application/vnd.dona.web-job-read-response","content-length":String(Buffer.byteLength(body)),connection:"close",...extra});response.end(body);}
function largeResult():WebJobReadResult{const artifacts=Array.from({length:32},(_,index)=>({name:`report-${index}.txt`,kind:"report" as const,media_type:"text/plain",size_bytes:index}));
  const items=Array.from({length:50},(_,index)=>({job_id:`job_${index}`,status:"completed" as const,created_at:now,updated_at:now,completed_at:now,progress:null,
    result:{status:"completed" as const,summary:"x".repeat(2000),completed_at:now,artifacts},error_code:null,control:{can_cancel:false}}));return{status:"succeeded",kind:"list",items,next_cursor:null};}

test("最大pageの署名済みresponseをrequest上限と分離して受理する",async t=>{const result=largeResult(),f=await server(t,(proof,body,response)=>{const sealed=responseProof(proof,body,result);
  assert.ok(Buffer.byteLength(sealed)>maximumWebJobReadBodyBytes);send(response,sealed);});assert.deepEqual(await f.client().execute(input),result);assert.equal(f.calls,1);});

test("header・framing・deadline・socket権限を固定し再送しない",async t=>{for(const fault of ["header","partial","slow"] as const){const f=await server(t,(proof,body,response)=>{const sealed=responseProof(proof,body,{status:"succeeded",kind:"list",items:[],next_cursor:null});
    if(fault==="header")send(response,sealed,{"set-cookie":"forbidden"});else if(fault==="partial"){response.writeHead(200,{"content-type":"application/vnd.dona.web-job-read-response","content-length":"999",connection:"close"});response.end("partial");}
    else{response.writeHead(200,{"content-type":"application/vnd.dona.web-job-read-response","content-length":String(sealed.length),connection:"close"});response.write(sealed[0]);}});
  await assert.rejects(f.client(fault==="slow"?40:1000).execute(input),WebJobReadWireError);assert.equal(f.calls,1,fault);}
  const privateSocket=await server(t,(proof,body,response)=>send(response,responseProof(proof,body,{status:"succeeded",kind:"list",items:[],next_cursor:null})));
  fs.chmodSync(privateSocket.directory,0o755);await assert.rejects(privateSocket.client().execute(input),WebJobReadWireError);assert.equal(privateSocket.calls,0);
  assert.throws(()=>privateSocket.client(5001),WebJobReadWireError);
});
