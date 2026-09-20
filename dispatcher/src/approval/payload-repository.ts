import type Database from "better-sqlite3";
import { z } from "zod";
import { AuditRepository, assertCurrentAuditReadState, type AuditAnchorStore } from "../audit/repository.js";
import type { AuditKeyLookup, VerifiedAuditState } from "../audit/codec.js";
import { assertSynchronousResult } from "../audit/synchronous.js";
import { ApprovalMetadataNodes } from "./metadata-store.js";
import { readMetadataValue } from "./metadata-tree.js";
import { approvalPayloadMetadataKey, encodeApprovalPayloadMetadata, type ApprovalPayloadMetadata } from "./payload-metadata.js";
import { ApprovalPayloadSql, type ApprovalPayloadOwnerKind, type ApprovalPayloadSecret } from "./payload-sql.js";
const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const scopeSchema=z.strictObject({instance_id:id,workspace_id:id});
export class ApprovalPayloadRepositoryError extends Error {
  constructor(){super("approval_payload_repository_unverified");this.name="ApprovalPayloadRepositoryError";}
}
export interface ApprovalPayloadInspection { readonly metadata:ApprovalPayloadMetadata; readonly secret:ApprovalPayloadSecret }
/** 共有監査が認証したpayload metadataの内部検査。本文を復号せず、owner
 * recordとの照合・現在のactor認可・TTLを代行しない。missing/invalidの復旧
 * 判断にも使えるが、それらを本文の取得成功として扱ってはならない。 */
export class ApprovalPayloadRepository {
  private readonly audit:AuditRepository;
  private readonly nodes:ApprovalMetadataNodes;
  private readonly sql:ApprovalPayloadSql;
  private readonly scope:z.infer<typeof scopeSchema>;
  constructor(private readonly db:Database.Database,anchors:AuditAnchorStore,keys:AuditKeyLookup,scopeInput:z.infer<typeof scopeSchema>){
    try{
      assertSynchronousResult(scopeInput);this.scope=Object.freeze(scopeSchema.parse(scopeInput));
      this.audit=new AuditRepository(db,anchors,keys);this.nodes=new ApprovalMetadataNodes(db);this.sql=new ApprovalPayloadSql(db,this.scope);
    }catch{throw new ApprovalPayloadRepositoryError();}
  }
  inspect(kind:ApprovalPayloadOwnerKind,ownerId:string):ApprovalPayloadInspection|null {
    try{return this.audit.readVerifiedState(state=>this.inspectInState(state,kind,ownerId));}
    catch{throw new ApprovalPayloadRepositoryError();}
  }
  /** 同じ監査callbackのexact stateだけを使う。SQL metadataの真正性と
   * secretの存在/形式を照合するが、owner認可・本文認証・TTLは上位が行う。 */
  inspectInState(state:VerifiedAuditState,kind:ApprovalPayloadOwnerKind,ownerId:string):ApprovalPayloadInspection|null {
    try{
      assertCurrentAuditReadState(this.db,state);
      const key=approvalPayloadMetadataKey(this.scope,kind,ownerId);
      const result=this.nodes.read(reader=>{
        const root=approvalPayloadRoot(state,this.scope);
        const digest=readMetadataValue({...this.scope,collection:"approval_payloads_v1"},root,key,reader);
        const metadata=this.sql.readMetadata(kind,ownerId);
        if((metadata===null?null:encodeApprovalPayloadMetadata(metadata,this.scope).digest)!==digest)throw Error();
        return metadata===null?null:Object.freeze({metadata,secret:this.sql.readSecret(metadata)});
      });
      assertCurrentAuditReadState(this.db,state);return result;
    }catch{throw new ApprovalPayloadRepositoryError();}
  }
}
/** 既存runPrepared/readVerifiedStateのstateだけを使う内部helper。
 * state所持は認可ではなく、欠落rootを初期化する権限も与えない。 */
export function approvalPayloadRoot(state:VerifiedAuditState,scope:z.infer<typeof scopeSchema>):string {
  assertSynchronousResult(state);assertSynchronousResult(scope);scopeSchema.parse(scope);
  const roots=state.resource_bindings.filter(value=>value.resource_id==="approval_payloads"
    && value.scope.instance_id===scope.instance_id && value.scope.tenant_id===scope.workspace_id);
  if(roots.length!==1)throw new ApprovalPayloadRepositoryError();return roots[0]!.resource_digest;
}
