import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { JobRow } from "./types.js";
export const checkpointSchema=z.object({
  schema_version:z.literal(1),task_id:z.string(),attempt_id:z.string(),sequence:z.number().int().positive(),
  summary:z.string().max(4000),remaining:z.array(z.string().max(2000)).max(32),
  artifacts:z.array(z.object({kind:z.enum(["commit","branch","pull_request","file","external_process"]),reference:z.string().max(2000)}).strict()).max(64),
  unresolved_operations:z.array(z.string().max(2000)).max(32),
  waiting:z.enum(["none","usage_limit","network","human_input","external_effect_unknown"]).default("none"),
  retry_after:z.string().datetime().optional(),
}).strict();
export type TaskCheckpoint=z.infer<typeof checkpointSchema>;
export function checkpointPath(job:JobRow):string{return path.join(path.dirname(job.result_path),"checkpoint.json");}
export async function readCheckpoint(job:JobRow,taskId:string):Promise<TaskCheckpoint|undefined>{
  let file;
  try{file=await fs.open(checkpointPath(job),"r");}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
  try{
    const stat=await file.stat();if(!stat.isFile()||stat.size>128_000)throw new Error("task_checkpoint_invalid");
    const value=checkpointSchema.parse(JSON.parse(await file.readFile("utf8")));
    if(value.task_id!==taskId||value.attempt_id!==job.job_id)throw new Error("task_checkpoint_identity_mismatch");
    return value;
  }finally{await file.close();}
}
