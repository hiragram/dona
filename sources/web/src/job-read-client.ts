import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { serviceScopeSchema, type ServiceScope, type WebServiceCredential, type WebServiceCredentialLookup } from "./service-auth.js";
import { encodeWebJobReadInput, maximumWebJobReadResponseBytes, signWebJobReadProof, verifyWebJobReadResponse,
  webJobReadServiceHost, webJobReadServicePath, WebJobReadWireError, type WebJobReadInput, type WebJobReadResult } from "./job-read-wire.js";

function socketIdentity(socketPath:string):{dev:number;ino:number}{
  const uid=process.getuid?.(),parent=path.dirname(socketPath);
  if(uid===undefined||!path.isAbsolute(socketPath)||path.normalize(socketPath)!==socketPath||Buffer.byteLength(socketPath)>100
    ||socketPath.includes("\0")||fs.realpathSync(parent)!==parent)throw new WebJobReadWireError();
  const directory=fs.lstatSync(parent),socket=fs.lstatSync(socketPath);
  if(!directory.isDirectory()||directory.uid!==uid||(directory.mode&0o777)!==0o700||!socket.isSocket()||socket.uid!==uid
    ||(socket.mode&0o777)!==0o600||socket.nlink!==1)throw new WebJobReadWireError();
  return{dev:socket.dev,ino:socket.ino};
}
function responseLength(response:http.IncomingMessage):number{
  const headers=new Map<string,string>();
  for(let index=0;index<response.rawHeaders.length;index+=2){const name=response.rawHeaders[index]!.toLowerCase(),value=response.rawHeaders[index+1]!;
    if(!["content-type","content-length","connection","date"].includes(name)||headers.has(name))throw new WebJobReadWireError();headers.set(name,value);}
  const length=headers.get("content-length");
  if(response.statusCode!==200||headers.get("content-type")!=="application/vnd.dona.web-job-read-response"||headers.get("connection")!=="close"
    ||!length||!/^[1-9][0-9]{0,7}$/.test(length)||Number(length)>maximumWebJobReadResponseBytes)throw new WebJobReadWireError();
  return Number(length);
}

export class WebJobReadClient{
  private readonly scope:ServiceScope;
  constructor(private readonly socketPath:string,scope:ServiceScope,private readonly signing:()=>WebServiceCredential,
    private readonly credentials:WebServiceCredentialLookup,private readonly now:()=>string,private readonly deadlineMs=5000){
    this.scope=serviceScopeSchema.parse(scope);if(!Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>5000)throw new WebJobReadWireError();
  }
  async execute(input:WebJobReadInput):Promise<WebJobReadResult>{try{
    const started=performance.now(),raw=encodeWebJobReadInput(input),before=socketIdentity(this.socketPath),proof=signWebJobReadProof(raw,this.scope,this.signing(),this.now());
    if(performance.now()-started>=this.deadlineMs)throw new WebJobReadWireError();
    return await new Promise<WebJobReadResult>((resolve,reject)=>{let settled=false,request:http.ClientRequest|undefined,received:http.IncomingMessage|undefined;
      const finish=(result?:WebJobReadResult)=>{if(settled)return;settled=true;clearTimeout(timer);received?.destroy();request?.destroy();
        result===undefined||performance.now()-started>=this.deadlineMs?reject(new WebJobReadWireError()):resolve(result);};
      const timer=setTimeout(()=>finish(),Math.max(1,this.deadlineMs-(performance.now()-started)));
      try{request=http.request({socketPath:this.socketPath,path:webJobReadServicePath,method:"POST",agent:false,maxHeaderSize:2048,
        headers:{host:webJobReadServiceHost,"content-type":"application/json","content-length":String(Buffer.byteLength(raw)),connection:"close","x-dona-service-proof":proof}},response=>{
        received=response;const chunks:Buffer[]=[];let size=0,length:number;try{length=responseLength(response);}catch{finish();return;}
        response.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>length||size>maximumWebJobReadResponseBytes)finish();else chunks.push(chunk);});
        response.once("aborted",()=>finish());response.once("error",()=>finish());response.once("end",()=>{try{
          if(!response.complete||size!==length||response.rawTrailers.length)throw new WebJobReadWireError();const after=socketIdentity(this.socketPath);
          if(after.dev!==before.dev||after.ino!==before.ino)throw new WebJobReadWireError();finish(verifyWebJobReadResponse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)),proof,raw,this.scope,this.credentials,this.now()));
        }catch{finish();}});response.once("close",()=>{if(!response.complete)finish();});});
        request.once("error",()=>finish());request.once("upgrade",(_response,socket)=>{socket.destroy();finish();});request.end(raw);
      }catch{finish();}});
  }catch{throw new WebJobReadWireError();}}
}
