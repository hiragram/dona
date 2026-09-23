import type Database from "better-sqlite3";
import { z } from "zod";
import type { VerifiedAuditState, AuditResourceCommitment } from "../audit/codec.js";
import { assertSynchronousResult } from "../audit/synchronous.js";
import { assertActiveClockMutation } from "../audit/file-identity.js";
import { parseClockMark, type ClockMark } from "./clock.js";
import { ApprovalMetadataNodes } from "./metadata-store.js";
import { prepareMetadataUpdate, readMetadataValue, MetadataConflictError, type MetadataTreeUpdate } from "./metadata-tree.js";
import { encodeApprovalPayloadMetadata, encodeApprovalPayloadEnvelope } from "./payload-metadata.js";
import { ApprovalPayloadSql, type ApprovalPayloadChange } from "./payload-sql.js";
import { approvalPayloadRoot } from "./payload-repository.js";
const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const scopeSchema=z.strictObject({instance_id:id,workspace_id:id});
export class ApprovalPayloadMutationError extends Error {
  constructor(){super("approval_payload_mutation_unverified");this.name="ApprovalPayloadMutationError";}
}
/** runPreparedへ接続する保存component。owner record・actor/binding・TTLと
 * HMAC/GCMの検証はbrokerが先に行う。最大2変更のSQLとpayload rootを一つの
 * 監査transactionへ結び、record mutationとも同じrunPreparedで合成する。 */
export class ApprovalPayloadMutation {
  private readonly scope:z.infer<typeof scopeSchema>;
  private readonly nodes:ApprovalMetadataNodes;
  private readonly sql:ApprovalPayloadSql;
  constructor(private readonly db:Database.Database,scopeInput:z.infer<typeof scopeSchema>){
    try{
      assertSynchronousResult(scopeInput);this.scope=Object.freeze(scopeSchema.parse(scopeInput));
      this.nodes=new ApprovalMetadataNodes(db);this.sql=new ApprovalPayloadSql(db,this.scope);
    }catch{throw new ApprovalPayloadMutationError();}
  }
  prepare(markInput:Readonly<ClockMark>,state:VerifiedAuditState,input:readonly ApprovalPayloadChange[]){
    try{
      assertSynchronousResult(markInput);assertSynchronousResult(input);assertSynchronousResult(state);
      const mark=parseClockMark(markInput),root=approvalPayloadRoot(state,this.scope);
      if(!Array.isArray(input) || input.length<1 || input.length>2)throw Error();
      const changes=input.map(change=>{
        if(Object.keys(change).sort().join(",")!=="envelope,next,previous")throw Error();
        const next=encodeApprovalPayloadMetadata(change.next,this.scope).metadata;
        const previous=change.previous===null?null:encodeApprovalPayloadMetadata(change.previous,this.scope).metadata;
        const envelope=change.envelope===null?null:encodeApprovalPayloadEnvelope(change.envelope).envelope;
        if(previous===null){
          if(next.binding.created_at!==mark.effective_utc || envelope?.sealed_at!==mark.effective_utc)throw Error();
        }else if(next.deleted_at!==mark.effective_utc)throw Error();
        return Object.freeze({previous,next,envelope});
      });
      Object.freeze(changes);this.sql.validate(changes);
      const treeScope=Object.freeze({...this.scope,collection:"approval_payloads_v1" as const});
      const plan=this.nodes.read(reader=>{
        const staged=new Map<string,string>(),updates:MetadataTreeUpdate[]=[];
        const read=(digest:string)=>staged.get(digest)??reader(digest);let current=root;
        for(const change of changes){
          const next=encodeApprovalPayloadMetadata(change.next,this.scope);
          const previous=change.previous===null?null:encodeApprovalPayloadMetadata(change.previous,this.scope).digest;
          const update=prepareMetadataUpdate(treeScope,current,next.key,previous,next.digest,read);
          for(const node of update.nodes){
            if(staged.has(node.digest) && staged.get(node.digest)!==node.wire)throw Error();staged.set(node.digest,node.wire);
          }
          updates.push(update);current=update.proposed_root;
        }
        return Object.freeze({root:current,updates:Object.freeze(updates)});
      });
      const commitments:AuditResourceCommitment[]=[{scope:{instance_id:this.scope.instance_id,tenant_id:this.scope.workspace_id},
        resource_id:"approval_payloads",resource_digest:plan.root}];
      Object.freeze(commitments[0]!.scope);Object.freeze(commitments[0]);Object.freeze(commitments);
      let used=false;
      return Object.freeze({resource_commitments:commitments,mutation:()=>{
        if(used)throw new ApprovalPayloadMutationError();used=true;
        try{
          assertActiveClockMutation(this.db,mark.transaction_id);this.sql.stage(changes);
          for(const update of plan.updates)this.nodes.stage(update.nodes);
          this.nodes.read(reader=>{
            for(const change of changes){
              const next=encodeApprovalPayloadMetadata(change.next,this.scope);
              if(readMetadataValue(treeScope,plan.root,next.key,reader)!==next.digest)throw Error();
            }
            return null;
          });
          return null;
        }catch{throw new ApprovalPayloadMutationError();}
      }});
    }catch(error){
      if(error instanceof MetadataConflictError)throw new MetadataConflictError();throw new ApprovalPayloadMutationError();
    }
  }
}
