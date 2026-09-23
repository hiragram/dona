import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import type { ProtectedClockSource, ClockObservation } from "./clock.js";

const schema=z.strictObject({boot_id:z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
 continuous_ms:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
 wall_utc:z.string().refine(value=>Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value)});
const hash=(buffer:Buffer)=>createHash("sha256").update(buffer).digest("hex");
export class NativeClockError extends Error {constructor(){super("clock_observation_unverified");this.name="NativeClockError";}}
export function parseObservation(raw:string):ClockObservation {
 try {if(Buffer.byteLength(raw)>1024)throw new Error();const value=schema.parse(JSON.parse(raw));const encoded=JSON.stringify(value);
  if(raw!==encoded && raw!==encoded+"\n")throw new Error();return value;}
 catch {throw new NativeClockError();}
}
export function parseHelperResult(result:{error?:unknown;status:number|null;signal:string|null;stdout:string;stderr:string}):ClockObservation {
 try {if(result.error || result.status!==0 || result.signal!==null || result.stderr!=="")throw new Error();return parseObservation(result.stdout);}
 catch {throw new NativeClockError();}
}
/** Fixed helper, no caller-controlled command/path/environment. This observes
 * the OS only; protected high-water CAS is enforced by the shared transaction. */
export class NativeClockSource implements ProtectedClockSource {
 observe():ClockObservation {
  try {
   if(!["darwin","linux"].includes(process.platform) || !["arm64","x64"].includes(process.arch))throw new Error();
   const directory=fileURLToPath(new URL("../../dist/native/",import.meta.url));
   const source=fileURLToPath(new URL("../../src/native/security-clock.c",import.meta.url)), binary=directory+"security-clock", manifest=directory+"security-clock.json";
   for(const [path,limit] of [[source,16384],[binary,1024*1024],[manifest,2048]] as const){
    const info=fs.lstatSync(path);
    if(!info.isFile() || info.isSymbolicLink() || info.nlink!==1 || (info.mode&0o022)!==0 || info.size<1 || info.size>limit)throw new Error();
   }
   const metadata=z.strictObject({codec_version:z.literal(1),platform:z.string(),arch:z.string(),source:z.string().regex(/^[0-9a-f]{64}$/),binary:z.string().regex(/^[0-9a-f]{64}$/)}).parse(JSON.parse(fs.readFileSync(manifest,"utf8")));
   if(metadata.platform!==process.platform || metadata.arch!==process.arch || metadata.source!==hash(fs.readFileSync(source)) || metadata.binary!==hash(fs.readFileSync(binary)))throw new Error();
   const result=spawnSync(binary,[],{shell:false,env:{PATH:"/usr/bin:/bin",LC_ALL:"C"},cwd:directory,encoding:"utf8",timeout:2000,killSignal:"SIGKILL",maxBuffer:1024,windowsHide:true});
   return parseHelperResult(result);
  }catch{throw new NativeClockError();}
 }
}
