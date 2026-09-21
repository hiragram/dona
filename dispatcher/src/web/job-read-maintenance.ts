import type { DispatcherDatabase } from "../database.js";

export const webJobProjectionRetentionMs=24*60*60*1000;
export const webJobProjectionMaintenanceIntervalMs=60*60*1000;

export function maintainWebJobProjection(database:DispatcherDatabase,at=new Date()):{events:number;cursors:number}{
  if(!Number.isFinite(at.getTime()))throw new Error("web_job_retention_invalid");
  return database.pruneWebJobProjection(new Date(at.getTime()-webJobProjectionRetentionMs),at,1000);
}

export function startWebJobProjectionMaintenance(database:DispatcherDatabase,onError:(error:unknown)=>void,
  clock:()=>Date=()=>new Date()):()=>void {
  let stopped=false;
  const run=()=>{if(stopped)return;try{maintainWebJobProjection(database,clock());}catch(error){onError(error);}};
  run();const timer=setInterval(run,webJobProjectionMaintenanceIntervalMs);timer.unref();
  return()=>{if(stopped)return;stopped=true;clearInterval(timer);};
}
