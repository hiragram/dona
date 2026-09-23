import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
const root=fileURLToPath(new URL("../",import.meta.url));
const source=path.join(root,"src/native/security-clock.c"),directory=path.join(root,"dist/native");
const target=path.join(directory,"security-clock"),manifestPath=path.join(directory,"security-clock.json");
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
if(!["darwin","linux"].includes(process.platform) || !["arm64","x64"].includes(process.arch))throw Error("security_clock_platform_unsupported");
const inputs={codec_version:1,platform:process.platform,arch:process.arch,source:hash(fs.readFileSync(source))};
let current=false;
try{
 const metadata=JSON.parse(fs.readFileSync(manifestPath,"utf8")),info=fs.lstatSync(target);
 current=JSON.stringify(metadata)===JSON.stringify({...inputs,binary:hash(fs.readFileSync(target))})
  && info.isFile() && !info.isSymbolicLink() && info.nlink===1 && (info.mode&0o022)===0 && (info.mode&0o100)!==0;
}catch{/* Missing or stale build is rebuilt before tests and packaging. */}
if(!current){
 fs.mkdirSync(directory,{recursive:true});const temporary=target+"."+randomUUID(),manifestTemporary=manifestPath+"."+randomUUID();
 try{
  const flags=process.platform==="darwin"?["-arch",process.arch==="x64"?"x86_64":"arm64"]:[];
  const result=spawnSync("/usr/bin/cc",[...flags,"-std=c11","-O2","-Wall","-Wextra","-Werror",source,"-o",temporary],
   {shell:false,encoding:"utf8",env:{PATH:"/usr/bin:/bin",LC_ALL:"C"},timeout:30000,maxBuffer:8192});
  if(result.error || result.status!==0 || result.signal!==null)throw Error("security_clock_build_failed");
  fs.chmodSync(temporary,0o755);
  fs.writeFileSync(manifestTemporary,JSON.stringify({...inputs,binary:hash(fs.readFileSync(temporary))})+"\n",{flag:"wx",mode:0o644});
  fs.renameSync(temporary,target);fs.renameSync(manifestTemporary,manifestPath);
 }finally{fs.rmSync(temporary,{force:true});fs.rmSync(manifestTemporary,{force:true});}
}
