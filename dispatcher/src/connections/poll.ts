import type { DispatcherDatabase } from "../database.js";
import { ConnectionError, type DeliveryBinding } from "./domain.js";
import type { CursorBatch } from "./registry.js";

export type CursorPage = {
  events: CursorBatch["events"];
} & ({ done: false; nextPage: string } | { done: true; checkpoint: string });

// page token は一時変数だけ。最終 page の取得・検証成功まで永続checkpointを触らない。
export async function pollConnectionBatch(database: DispatcherDatabase, binding: DeliveryBinding,
  fetchPage: (checkpoint: string | null, page: string | null) => Promise<CursorPage>,
  limits = { pages: 100, events: 10_000, timeoutMs: 30_000 }): Promise<void> {
  if (![limits.pages,limits.events,limits.timeoutMs].every((n)=>Number.isSafeInteger(n)&&n>0) || limits.timeoutMs>60_000) throw new ConnectionError("invalid_input");
  database.connections.assertPolling(binding);
  const expected=database.connections.cursor(binding.connectionId,binding.resource);
  if (expected.revision !== binding.revision) throw new ConnectionError("cursor_conflict");
  const events: {providerEventId:string;envelope:CursorBatch["events"][number]["envelope"]}[]=[];
  let page: string | null=null;
  const seen=new Set<string>();
  const deadline=performance.now()+limits.timeoutMs;
  for(let count=0;count<limits.pages;count++) {
    database.connections.assertPolling(binding);
    let result: CursorPage; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const remaining=deadline-performance.now();
      if(remaining<=0) throw new ConnectionError("incomplete_batch");
      result=await Promise.race([fetchPage(expected.checkpoint,page),new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(new ConnectionError("incomplete_batch")),remaining);
      })]);
    } catch {throw new ConnectionError("incomplete_batch");}
    finally {if(timer)clearTimeout(timer);}
    if(!Array.isArray(result.events)||events.length+result.events.length>limits.events) throw new ConnectionError("incomplete_batch");
    events.push(...result.events);
    if(result.done===true) {
      database.commitConnectionBatch({binding,expected,checkpoint:result.checkpoint,complete:true,events}); return;
    }
    if(result.done!==false||typeof result.nextPage!=="string"||result.nextPage.length>16_384||seen.has(result.nextPage)) throw new ConnectionError("incomplete_batch");
    seen.add(result.nextPage);page=result.nextPage;
  }
  throw new ConnectionError("incomplete_batch");
}
