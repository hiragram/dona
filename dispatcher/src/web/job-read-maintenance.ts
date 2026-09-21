import type { DispatcherDatabase } from "../database.js";

export const webJobProjectionRetentionMs=24*60*60*1000;
export const webJobProjectionMaintenanceIntervalMs=60*60*1000;

export function maintainWebJobProjection(database:DispatcherDatabase,at=new Date()):{events:number;cursors:number}{
  if(!Number.isFinite(at.getTime()))throw new Error("web_job_retention_invalid");
  return database.pruneWebJobProjection(new Date(at.getTime()-webJobProjectionRetentionMs),at,1000);
}

export function startWebJobProjectionMaintenance(database:DispatcherDatabase,onError:(error:unknown)=>void,
  clock:()=>Date=()=>new Date()):()=>void {
  let stopped=false,running=false,pending:ReturnType<typeof setImmediate>|undefined;
  const drain=()=>{pending=undefined;if(stopped){running=false;return;}try{
    const result=maintainWebJobProjection(database,clock());
    if(result.events+result.cursors===1000){pending=setImmediate(drain);return;}
  }catch(error){onError(error);}running=false;};
  const run=()=>{if(stopped||running)return;running=true;drain();};
  run();const timer=setInterval(run,webJobProjectionMaintenanceIntervalMs);timer.unref();
  return()=>{if(stopped)return;stopped=true;clearInterval(timer);if(pending)clearImmediate(pending);pending=undefined;running=false;};
}
