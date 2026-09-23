import type Database from "better-sqlite3";
import { z } from "zod";
import { assertSecurityDurability } from "../audit/durability.js";
import { verifyOpenDatabaseFile } from "../audit/file-identity.js";
import { assertSynchronousResult } from "../audit/synchronous.js";
import { verifyApprovalPayloadSchema } from "./schema.js";
import { parseApprovalPayloadBinding, type SealedApprovalPayload } from "./payload-protection.js";
import { encodeApprovalPayloadMetadata, encodeApprovalPayloadEnvelope, decodeApprovalPayloadEnvelope, type ApprovalPayloadMetadata } from "./payload-metadata.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const scopeSchema = z.strictObject({ instance_id:id, workspace_id:id });
const ownerKind = z.enum(["request","attempt"]);
export type ApprovalPayloadOwnerKind = z.infer<typeof ownerKind>;
export interface ApprovalPayloadChange {
  readonly previous: ApprovalPayloadMetadata | null;
  readonly next: ApprovalPayloadMetadata;
  readonly envelope: SealedApprovalPayload | null;
}
export type ApprovalPayloadSecret = Readonly<{ status:"present"; envelope:SealedApprovalPayload } |
  { status:"missing"|"invalid"|"deleted"; envelope:null }>;
export class ApprovalPayloadSqlError extends Error {
  constructor(){super("approval_payload_sql_unverified");this.name="ApprovalPayloadSqlError";}
}
const fields = [
  ["payload_ref",128,false],["instance_id",128,false],["workspace_id",128,false],["owner_kind",8,false],["owner_id",128,false],
  ["request_id",128,false],["attempt_id",128,true],["consume_id",128,true],["binding_json",4096,false],["envelope_digest",64,false],
  ["state",8,false],["created_at",24,false],["expires_at",24,false],["deleted_at",24,true],
] as const;
// SQL identifiers are fixed above; caller strings are bound values only.
const bounded = fields.map(([name,bytes,nullable])=>{
  const value=`typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${bytes}`;
  return nullable?`(${name} IS NULL OR (${value}))`:`(${value})`;
}).join(" AND ");
const readSql=`SELECT CASE WHEN ${bounded} THEN json_object(${fields.map(([name])=>`'${name}',${name}`).join(",")}) ELSE NULL END AS row_json
  FROM main.approval_payload_metadata WHERE owner_kind=? AND owner_id=?`;
const insertSql=`INSERT INTO main.approval_payload_metadata(${fields.map(([name])=>name).join(",")}) VALUES(${fields.map(()=>"?").join(",")})`;
/** 内部SQL保存のみ。current audit root・owner record・actor認可・本文の
 * HMAC/GCM・TTLは上位で検証する。外部transportへ直接公開しない。 */
export class ApprovalPayloadSql {
  private readonly scope: z.infer<typeof scopeSchema>;
  constructor(private readonly db:Database.Database, scopeInput:z.infer<typeof scopeSchema>){
    try{
      assertSynchronousResult(scopeInput);this.scope=Object.freeze(scopeSchema.parse(scopeInput));
      if(db.inTransaction)throw Error();
      assertSecurityDurability(db);verifyOpenDatabaseFile(db);verifyApprovalPayloadSchema(db);
    }catch{throw new ApprovalPayloadSqlError();}
  }
  private guarded<T>(operation:()=>T):T {
    try{
      if(!this.db.inTransaction)throw Error();verifyOpenDatabaseFile(this.db);verifyApprovalPayloadSchema(this.db);
      return operation();
    }catch{throw new ApprovalPayloadSqlError();}
    finally{try{verifyOpenDatabaseFile(this.db);}catch{throw new ApprovalPayloadSqlError();}}
  }
  readMetadata(kind:ApprovalPayloadOwnerKind,ownerId:string):ApprovalPayloadMetadata|null {
    return this.guarded(()=>{
      ownerKind.parse(kind);id.parse(ownerId);
      const result=this.db.prepare(readSql).get(kind,ownerId) as {row_json:string|null}|undefined;
      if(result===undefined)return null;
      if(result.row_json===null || Buffer.byteLength(result.row_json)>8192)throw Error();
      const row=JSON.parse(result.row_json) as Record<string,string|null>;
      const binding=parseApprovalPayloadBinding(JSON.parse(row.binding_json!));
      if(JSON.stringify(binding)!==row.binding_json || binding.scope.instance_id!==row.instance_id || binding.scope.workspace_id!==row.workspace_id
        || binding.payload_ref!==row.payload_ref || binding.owner_kind!==row.owner_kind || binding.owner_id!==row.owner_id
        || binding.request_id!==row.request_id || binding.created_at!==row.created_at || binding.expires_at!==row.expires_at
        || row.attempt_id!==(binding.owner_kind==="attempt"?binding.owner_id:null))throw Error();
      return encodeApprovalPayloadMetadata({codec_version:1,binding,consume_id:row.consume_id,envelope_digest:row.envelope_digest,
        state:row.state,deleted_at:row.deleted_at},this.scope).metadata;
    });
  }
  /** presentはcanonical envelopeとdigestの一致のみ。復号/認可済みではない。
   * missing/invalidを識別し、復旧で本文を再生成せず削除へ収束させる。 */
  readSecret(input:ApprovalPayloadMetadata):ApprovalPayloadSecret {
    return this.guarded(()=>{
      const value=encodeApprovalPayloadMetadata(input,this.scope),binding=value.metadata.binding;
      const current=this.readMetadata(binding.owner_kind,binding.owner_id);
      if(current===null || encodeApprovalPayloadMetadata(current,this.scope).digest!==value.digest)throw Error();
      const row=this.db.prepare("SELECT CASE WHEN typeof(envelope_json)='text' AND length(CAST(envelope_json AS BLOB)) BETWEEN 1 AND 360448 THEN envelope_json ELSE NULL END AS wire FROM main.approval_payload_secrets WHERE payload_ref=?")
        .get(binding.payload_ref) as {wire:string|null}|undefined;
      if(value.metadata.state==="deleted"){
        if(row!==undefined)throw Error();return Object.freeze({status:"deleted",envelope:null});
      }
      if(row===undefined)return Object.freeze({status:"missing",envelope:null});
      if(row.wire===null)return Object.freeze({status:"invalid",envelope:null});
      try{return Object.freeze({status:"present",envelope:decodeApprovalPayloadEnvelope(row.wire,value.metadata.envelope_digest).envelope});}
      catch{return Object.freeze({status:"invalid",envelope:null});}
    });
  }
  validate(input:readonly ApprovalPayloadChange[]):void {this.guarded(()=>{this.checked(input);});}
  private checked(input:readonly ApprovalPayloadChange[]){
    assertSynchronousResult(input);
    if(!Array.isArray(input) || input.length<1 || input.length>2)throw Error();
    const seen=new Set<string>(),refs=new Set<string>();
    return input.map(change=>{
      if(Object.keys(change).sort().join(",")!=="envelope,next,previous")throw Error();
      const next=encodeApprovalPayloadMetadata(change.next,this.scope),previous=change.previous===null?null:encodeApprovalPayloadMetadata(change.previous,this.scope);
      if(seen.has(next.key) || refs.has(next.metadata.binding.payload_ref) || (previous!==null && previous.key!==next.key))throw Error();
      seen.add(next.key);refs.add(next.metadata.binding.payload_ref);
      const actual=this.readMetadata(next.metadata.binding.owner_kind,next.metadata.binding.owner_id);
      if((actual===null?null:encodeApprovalPayloadMetadata(actual,this.scope).digest)!==(previous?.digest??null))throw Error();
      if(previous===null){
        if(next.metadata.state!=="active" || change.envelope===null)throw Error();
        if(this.db.prepare("SELECT 1 FROM main.approval_payload_metadata WHERE payload_ref=?").get(next.metadata.binding.payload_ref))throw Error();
        const envelope=encodeApprovalPayloadEnvelope(change.envelope);
        if(envelope.digest!==next.metadata.envelope_digest)throw Error();
        return {previous,next,envelope};
      }
      if(previous.metadata.state!=="active" || next.metadata.state!=="deleted" || change.envelope!==null
        || encodeApprovalPayloadMetadata({...next.metadata,state:"active",deleted_at:null},this.scope).digest!==previous.digest)throw Error();
      return {previous,next,envelope:null};
    });
  }
  /** 同じ共有監査mutationでroot更新と合わせて使い、例外を捕捉してcommitしない。 */
  stage(input:readonly ApprovalPayloadChange[]):void {
    this.guarded(()=>{
      for(const change of this.checked(input)){
        const m=change.next.metadata,b=m.binding;
        if(change.previous===null){
          const row:Record<string,string|null>={payload_ref:b.payload_ref,instance_id:b.scope.instance_id,workspace_id:b.scope.workspace_id,
            owner_kind:b.owner_kind,owner_id:b.owner_id,request_id:b.request_id,attempt_id:b.owner_kind==="attempt"?b.owner_id:null,
            consume_id:m.consume_id,binding_json:JSON.stringify(b),envelope_digest:m.envelope_digest,state:m.state,created_at:b.created_at,expires_at:b.expires_at,deleted_at:null};
          this.db.prepare(insertSql).run(...fields.map(([name])=>row[name]!));
          this.db.prepare("INSERT INTO main.approval_payload_secrets(payload_ref,envelope_json) VALUES(?,?)").run(b.payload_ref,change.envelope!.canonical);
        }else{
          const result=this.db.prepare("UPDATE main.approval_payload_metadata SET state='deleted',deleted_at=? WHERE payload_ref=? AND state='active' AND deleted_at IS NULL").run(m.deleted_at,b.payload_ref);
          if(result.changes!==1)throw Error();
        }
        const actual=this.readMetadata(b.owner_kind,b.owner_id);
        if(actual===null || encodeApprovalPayloadMetadata(actual,this.scope).digest!==change.next.digest)throw Error();
        const secret=this.readSecret(actual);
        if(secret.status!==(m.state==="active"?"present":"deleted"))throw Error();
      }
    });
  }
}
