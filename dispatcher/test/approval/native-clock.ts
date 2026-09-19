import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {NativeClockSource,NativeClockError,parseObservation,parseHelperResult} from "../../src/approval/native-clock.js";
test("OS clockを別processで再読しbootとcontinuous値を検証する",()=>{
 const source=new NativeClockSource(),a=source.observe(),b=source.observe();
 assert.ok(a.boot_id===b.boot_id);assert.ok(b.continuous_ms>=a.continuous_ms);
 assert.ok(Date.parse(b.wall_utc)>=Date.parse(a.wall_utc));
});
test("clock helperの不正protocolを共通errorとして拒否する",()=>{
 const value={boot_id:"00000000-0000-0000-0000-000000000001",continuous_ms:1,wall_utc:"2026-09-19T00:00:00.000Z"};
 assert.deepEqual(parseObservation(JSON.stringify(value)),value);
 for(const raw of ["private data","x".repeat(1025),JSON.stringify({...value,continuous_ms:-1}),JSON.stringify({...value,continuous_ms:1.5}),JSON.stringify({...value,boot_id:"unknown"}),JSON.stringify({...value,wall_utc:"2026-09-19"}),JSON.stringify({...value,extra:true})]){
  assert.throws(()=>parseObservation(raw),{name:"NativeClockError",message:"clock_observation_unverified"});
 }
 assert.ok(new NativeClockError());
});
test("helper失敗・timeout・signal・stderr・曖昧JSONは観測値へ変換しない",()=>{
 const value={boot_id:"00000000-0000-0000-0000-000000000001",continuous_ms:1,wall_utc:"2026-09-19T00:00:00.000Z"};
 const valid={status:0,signal:null,stdout:JSON.stringify(value)+"\n",stderr:""};
 assert.deepEqual(parseHelperResult(valid),value);
 for(const patch of [{status:1},{status:null},{signal:"SIGTERM"},{error:new Error("fixture private context")},{stderr:"fixture private context"},
  {stdout:JSON.stringify(value).replace('"continuous_ms":1','"continuous_ms":2,"continuous_ms":1')},{stdout:" "+valid.stdout}])
  assert.throws(()=>parseHelperResult({...valid,...patch}),{name:"NativeClockError",message:"clock_observation_unverified"});
});
test("build manifestの改変を実行前に拒否しprivate errorを隠す",t=>{
 const original=fs.readFileSync.bind(fs);
 t.mock.method(fs,"readFileSync",((file:fs.PathOrFileDescriptor,...args:unknown[])=>{
  if(String(file).endsWith("security-clock.json"))throw Error("fixture private path or secret");
  return (original as (...a:unknown[])=>unknown)(file,...args);
 }) as typeof fs.readFileSync);
 assert.throws(()=>new NativeClockSource().observe(),{name:"NativeClockError",message:"clock_observation_unverified"});
});
test("source・binary hashとplatformの不一致ではhelperを信頼しない",t=>{
 const original=fs.readFileSync.bind(fs);
 for(const patch of [{source:"0".repeat(64)},{binary:"0".repeat(64)},{platform:"unsupported"},{arch:"unsupported"}]){
  t.mock.method(fs,"readFileSync",((file:fs.PathOrFileDescriptor,...args:unknown[])=>{
   const result=(original as (...a:unknown[])=>unknown)(file,...args);
   if(String(file).endsWith("security-clock.json"))return JSON.stringify({...JSON.parse(String(result)),...patch});
   return result;
  }) as typeof fs.readFileSync);
  assert.throws(()=>new NativeClockSource().observe(),{name:"NativeClockError",message:"clock_observation_unverified"});t.mock.reset();
 }
});
test("非通常fileと容量超過を内容の読取前に拒否する",t=>{
 const original=fs.lstatSync.bind(fs);
 for(const patch of [{isFile:()=>false},{size:1024*1024+1},{nlink:2},{mode:0o666}]){
  let reads=0;
  t.mock.method(fs,"lstatSync",((file:fs.PathLike)=>Object.assign(original(file),patch)) as typeof fs.lstatSync);
  t.mock.method(fs,"readFileSync",(()=>{reads++;throw Error("must not read invalid file");}) as typeof fs.readFileSync);
  assert.throws(()=>new NativeClockSource().observe(),{name:"NativeClockError",message:"clock_observation_unverified"});
  assert.equal(reads,0);t.mock.reset();
 }
});
