import { createHash } from "node:crypto";
import { z } from "zod";
import { assertSynchronousResult } from "../audit/synchronous.js";
import { parseApprovalPayloadBinding, parseSealedApprovalPayload, type ApprovalPayloadBinding } from "./payload-protection.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const utc = z.string().length(24).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const scopeSchema = z.strictObject({ instance_id:id, workspace_id:id });
const metadataSchema = z.strictObject({ codec_version:z.literal(1), binding:z.unknown(), consume_id:id.nullable(), envelope_digest:digest,
  state:z.enum(["active","deleted"]), deleted_at:utc.nullable() });
export interface ApprovalPayloadMetadata {
  readonly codec_version: 1;
  readonly binding: ApprovalPayloadBinding;
  readonly consume_id: string | null;
  readonly envelope_digest: string;
  readonly state: "active" | "deleted";
  readonly deleted_at: string | null;
}
export class ApprovalPayloadMetadataError extends Error {
  constructor() { super("approval_payload_metadata_unverified"); this.name="ApprovalPayloadMetadataError"; }
}
function guard<T>(fn:()=>T):T { try { return fn(); } catch { throw new ApprovalPayloadMetadataError(); } }
function hash(domain:string,wire:string):string { return createHash("sha256").update(domain).update(wire).digest("hex"); }
function scope(input:unknown) { assertSynchronousResult(input); return scopeSchema.parse(input); }
export function approvalPayloadMetadataKey(scopeInput:unknown, ownerKind:"request"|"attempt", ownerId:string):string {
  return guard(() => { const s=scope(scopeInput); z.enum(["request","attempt"]).parse(ownerKind); id.parse(ownerId);
    return hash("dona.approval.payload-key.v1\0",JSON.stringify([s.instance_id,s.workspace_id,ownerKind,ownerId])); });
}
/** 保存用canonical metadata。SQL/rootの真正性や現在の認可を証明しない。 */
export function encodeApprovalPayloadMetadata(input:unknown, scopeInput:unknown) {
  return guard(() => {
    assertSynchronousResult(input); const s=scope(scopeInput), parsed=metadataSchema.parse(input), binding=parseApprovalPayloadBinding(parsed.binding);
    if (binding.scope.instance_id!==s.instance_id || binding.scope.workspace_id!==s.workspace_id
      || (binding.owner_kind==="request" ? parsed.consume_id!==null : parsed.consume_id===null)
      || (parsed.state==="active" ? parsed.deleted_at!==null : parsed.deleted_at===null)
      || (parsed.deleted_at!==null && Date.parse(parsed.deleted_at)<Date.parse(binding.created_at))) throw Error();
    const metadata:ApprovalPayloadMetadata=Object.freeze({codec_version:1,binding,consume_id:parsed.consume_id,envelope_digest:parsed.envelope_digest,
      state:parsed.state,deleted_at:parsed.deleted_at});
    const canonical=JSON.stringify(metadata); if(Buffer.byteLength(canonical)>8192) throw Error();
    return Object.freeze({metadata,canonical,digest:hash("dona.approval.payload-metadata.v1\0",canonical),
      key:approvalPayloadMetadataKey(s,binding.owner_kind,binding.owner_id)});
  });
}
export function decodeApprovalPayloadMetadata(wire:string,expectedDigest:string,scopeInput:unknown) {
  return guard(() => {
    if(typeof wire!=="string" || wire.length>8192 || Buffer.byteLength(wire)>8192) throw Error();
    digest.parse(expectedDigest); const value=encodeApprovalPayloadMetadata(JSON.parse(wire),scopeInput);
    if(value.canonical!==wire || value.digest!==expectedDigest) throw Error(); return value;
  });
}
/** 暗号化envelopeのdigest。plaintext hashではなく、復号/認証も行わない。 */
export function encodeApprovalPayloadEnvelope(input:unknown) {
  return guard(() => { const envelope=parseSealedApprovalPayload(input), canonical=JSON.stringify(envelope);
    return Object.freeze({envelope,canonical,digest:hash("dona.approval.payload-envelope.v1\0",canonical)}); });
}
export function decodeApprovalPayloadEnvelope(wire:string,expectedDigest:string) {
  return guard(() => {
    if(typeof wire!=="string" || wire.length>360448 || Buffer.byteLength(wire)>360448) throw Error();
    digest.parse(expectedDigest); const value=encodeApprovalPayloadEnvelope(JSON.parse(wire));
    if(value.canonical!==wire || value.digest!==expectedDigest) throw Error(); return value;
  });
}
