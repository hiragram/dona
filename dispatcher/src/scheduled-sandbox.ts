import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { HerdrCommandResult } from "./herdr.js";

export const scheduledPermissionProfile = "dona_scheduled";

export async function scheduledExecutablePaths(executable:string):Promise<string[]> {
  const candidates=executable.includes(path.sep) ? [path.resolve(executable)] : (process.env.PATH??"").split(path.delimiter).filter(Boolean).map(directory=>path.resolve(directory,executable));
  for(const candidate of candidates) {
    try { await fs.access(candidate,constants.X_OK); return [...new Set([candidate,await fs.realpath(candidate)])]; }
    catch { /* 次のPATH候補だけを確認する。 */ }
  }
  throw new Error("Scheduled sandbox executable is unavailable");
}

export function scheduledPermissionArguments(resultDirectory:string,executables:readonly string[]):string[] {
  if(!executables.length||executables.some(value=>!path.isAbsolute(value))) throw new Error("Scheduled sandbox executable identity is required");
  const rules=[`\":root\" = \"deny\"`,`\":minimal\" = \"read\"`,`${JSON.stringify(resultDirectory)} = "write"`,
    ...executables.map(value=>`${JSON.stringify(value)} = "read"`)];
  return [...["memories","shell_snapshot","shell_snapshot_v2","browser_use","browser_use_external","browser_use_full_cdp_access"].flatMap(feature=>["--disable",feature]),"-c",`default_permissions = "${scheduledPermissionProfile}"`,"-c",`permissions = { ${scheduledPermissionProfile} = { filesystem = { ${rules.join(", ")} }, network = { enabled = false } } }`,
    "-c",'shell_environment_policy = { inherit = "none", set = { PATH = "/usr/bin:/bin" } }',"-c","project_doc_max_bytes = 0","-c",'web_search = "disabled"'];
}

export function verifyScheduledPermissionContext(output:string,resultDirectory:string,executables:readonly string[]):void {
  const messages=JSON.parse(output) as Array<{content?:Array<{text?:string}>}>;
  if(!Array.isArray(messages)) throw new Error("Scheduled permission context is invalid");
  const context=messages.flatMap(message=>message.content??[]).map(content=>content.text??"").filter(text=>text.includes("<environment_context>")).at(-1)??"";
  const filesystem=/<file_system type="restricted">([\s\S]*?)<\/file_system>/.exec(context)?.[1]??"";
  const entries=[...filesystem.matchAll(/<entry access="(read|write|deny)"[^>]*>([\s\S]*?)<\/entry>/g)];
  const decode=(value:string)=>value.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");
  const normalize=(value:string)=>path.resolve(value).replace(/^\/private\/(var|tmp)(?=\/)/,"/$1");
  const codexHome=process.env.CODEX_HOME??path.join(os.homedir(),".codex");
  const helperRoot=normalize(path.join(codexHome,"tmp","arg0"))+path.sep;
  const runtimeShell=path.resolve(path.dirname(executables.at(-1)!),"..","codex-resources","zsh","bin","zsh");
  let deniedRoot=false,writes=0;
  for(const entry of entries) {
    const special=/<special>(.*?)<\/special>/.exec(entry[2]!)?.[1];
    const file=/<path>(.*?)<\/path>/.exec(entry[2]!)?.[1];
    if(special===":root"&&entry[1]==="deny"&&entry[0].includes('escalatable="false"')) {deniedRoot=true;continue;}
    if(special===":minimal"&&entry[1]==="read") continue;
    if(entry[1]==="deny") continue;
    if(!file) throw new Error("Scheduled permission context contains an unexpected grant");
    const resolved=normalize(decode(file));
    if(entry[1]==="write"&&resolved===normalize(resultDirectory)){writes++;continue;}
    if(entry[1]==="read"&&(executables.some(value=>normalize(value)===resolved)||resolved===normalize(runtimeShell)||resolved.startsWith(helperRoot))) continue;
    throw new Error("Scheduled permission context contains an unexpected grant");
  }
  if(!deniedRoot||writes!==1) throw new Error("Scheduled read isolation is not active");
}

// 実際のCodex OS sandboxで、隣接canaryとsymlink経由のreadを拒否し、許可したResultへのwrite/readだけが成功することを確認する。
export async function verifyScheduledSandbox(resultDirectory:string,executables:readonly string[],timeoutMs:number,
  run:(executable:string,args:string[],timeoutMs:number)=>Promise<HerdrCommandResult>):Promise<void> {
  const outside=await fs.mkdtemp(path.join(path.dirname(resultDirectory),".sandbox-canary-"));
  const canary=path.join(outside,"private-input");
  const link=path.join(resultDirectory,`.sandbox-link-${path.basename(outside)}`);
  const output=path.join(resultDirectory,`.sandbox-output-${path.basename(outside)}`);
  await fs.writeFile(canary,"fixture-only",{mode:0o600});
  try {
    await fs.symlink(canary,link);
    const context=await run(executables.at(-1)!,["-C",resultDirectory,"--ask-for-approval","never",...scheduledPermissionArguments(resultDirectory,executables),
      "-c",`projects = { ${JSON.stringify(resultDirectory)} = { trust_level = "trusted" } }`,
      "debug","prompt-input"],timeoutMs);
    if(!context.ok) throw new Error("Scheduled permission context could not be verified");
    verifyScheduledPermissionContext(context.stdout,resultDirectory,executables);
    const checked=await run(executables.at(-1)!,[...scheduledPermissionArguments(resultDirectory,executables),
      "sandbox","--permission-profile",scheduledPermissionProfile,"-C",resultDirectory,"--","/bin/sh","-c",
      'if /bin/cat "$1" >/dev/null 2>&1 || /bin/cat "$2" >/dev/null 2>&1; then exit 70; fi; printf verified > "$3" && test "$(/bin/cat "$3")" = verified',
      "sandbox-probe",canary,link,output],timeoutMs);
    if(!checked.ok||await fs.readFile(output,"utf8").catch(()=>"")!=="verified") throw new Error("Scheduled read isolation could not be verified");
  } finally {
    await fs.rm(link,{force:true}); await fs.rm(output,{force:true}); await fs.rm(outside,{recursive:true,force:true});
  }
}
