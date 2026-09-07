import type { DispatcherDatabase } from "../database.js";
import { validateNormalizedExternalEvent } from "../ingress.js";
import { ConnectionError, type DeliveryBinding } from "./domain.js";
import type { Cursor, CursorBatch } from "./registry.js";

export type CursorPage = {
  events: CursorBatch["events"];
  membership?: CursorBatch["membership"];
  membershipChanges?: CursorBatch["membershipChanges"];
  continuation?: boolean;
} & ({ done: false; nextPage: string } | { done: true; checkpoint: string });

// page token は一時変数だけ。最終 page の取得・検証成功まで永続checkpointを触らない。
export async function pollConnectionBatch(database: DispatcherDatabase, binding: DeliveryBinding,
  fetchPage: (checkpoint: string | null, page: string | null, signal: AbortSignal) => Promise<CursorPage>,
  limits: {pages:number;events:number;timeoutMs:number;bytes?:number} = { pages: 100, events: 10_000, timeoutMs: 30_000, bytes: 16_777_216 },
  initialExpected?: Cursor): Promise<void> {
  const byteLimit=limits.bytes??16_777_216;
  if (![limits.pages,limits.events,limits.timeoutMs,byteLimit].every((n)=>Number.isSafeInteger(n)&&n>0) || limits.timeoutMs>60_000) throw new ConnectionError("invalid_input");
  database.connections.assertPolling(binding);
  const expected=initialExpected ?? database.connections.cursor(binding.connectionId,binding.resource);
  if (expected.revision !== binding.revision) throw new ConnectionError("cursor_conflict");
  const events: {providerEventId:string;envelope:CursorBatch["events"][number]["envelope"]}[]=[];
  let encodedBytes=0;
  let page: string | null=null;
  const seen=new Set<string>();
  const deadline=performance.now()+limits.timeoutMs;
  for(let count=0;count<limits.pages;count++) {
    database.connections.assertPolling(binding);
    let result: CursorPage; let timer: ReturnType<typeof setTimeout> | undefined;
    const controller=new AbortController();
    try {
      const remaining=deadline-performance.now();
      if(remaining<=0) throw new ConnectionError("incomplete_batch");
      result=await Promise.race([fetchPage(expected.checkpoint,page,controller.signal),new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{controller.abort();reject(new ConnectionError("incomplete_batch"));},remaining);
      })]);
    } catch (error) {
      // providerが恒久的なcursor/credential失敗を分類した場合は、retryable batch失敗へ潰さない。
      if (error instanceof ConnectionError && error.code !== "incomplete_batch") throw error;
      throw new ConnectionError("incomplete_batch");
    }
    finally {if(timer)clearTimeout(timer);}
    if(!Array.isArray(result.events)||events.length+result.events.length>limits.events) throw new ConnectionError("incomplete_batch");
    try { events.push(...result.events.map(event=>{
      if(event.envelope.schema_version!==1) throw new ConnectionError("incomplete_batch");
      validateNormalizedExternalEvent({providerEventId:event.providerEventId,type:event.envelope.type,occurredAt:event.envelope.occurred_at,
        subject:event.envelope.subject,payload:event.envelope.payload,replyTarget:event.envelope.reply_target,trace:event.envelope.trace});
      encodedBytes+=Buffer.byteLength(JSON.stringify(event));
      if(encodedBytes>byteLimit) throw new ConnectionError("incomplete_batch");
      return event;
    })); }
    catch { throw new ConnectionError("incomplete_batch"); }
    if(result.done===true) {
      database.commitConnectionBatch({binding,expected,checkpoint:result.checkpoint,complete:true,events,
        ...(result.membership === undefined ? {} : {membership:result.membership}),
        ...(result.membershipChanges === undefined ? {} : {membershipChanges:result.membershipChanges}),
        ...(result.continuation === undefined ? {} : {continuation:result.continuation})}); return;
    }
    if(result.done!==false||typeof result.nextPage!=="string"||result.nextPage.length>16_384||seen.has(result.nextPage)) throw new ConnectionError("incomplete_batch");
    seen.add(result.nextPage);page=result.nextPage;
  }
  throw new ConnectionError("incomplete_batch");
}
