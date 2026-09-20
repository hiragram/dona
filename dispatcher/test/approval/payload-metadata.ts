import assert from "node:assert/strict";
import test from "node:test";
import { createApprovalContentBinding, sealApprovalPayload, parseApprovalPayloadBinding, parseSealedApprovalPayload, type ApprovalPayloadKey, ApprovalPayloadError } from "../../src/approval/payload-protection.js";
import { encodeApprovalPayloadMetadata, decodeApprovalPayloadMetadata, encodeApprovalPayloadEnvelope, decodeApprovalPayloadEnvelope, approvalPayloadMetadataKey, ApprovalPayloadMetadataError } from "../../src/approval/payload-metadata.js";
import { emptyMetadataRoot, prepareMetadataUpdate, readMetadataValue, MetadataTreeError } from "../../src/approval/metadata-tree.js";
const scope={instance_id:"instance",workspace_id:"workspace"};
const at="2026-09-20T00:00:00.000Z";
const mark={codec_version:1 as const,transaction_id:"tx",previous_transaction_id:null,boot_id:"fixture_boot",continuous_ms:1000,effective_utc:at};
const contentKey:ApprovalPayloadKey={version:1,purpose:"approval_content",state:"active",activated_at:"2026-09-01T00:00:00.000Z",signing_expires_at:"2026-11-01T00:00:00.000Z",secret:Buffer.alloc(32,11)};
const wrapKey:ApprovalPayloadKey={...contentKey,purpose:"approval_payload_wrap",secret:Buffer.alloc(32,12)};
const content=createApprovalContentBinding("fixture-only",scope,"draft",contentKey,mark);
const binding={codec_version:1 as const,scope,owner_kind:"request" as const,owner_id:"request",request_id:"request",semantic_hash:"a".repeat(64),payload_ref:"payload",content,created_at:at,expires_at:"2026-09-20T00:20:00.000Z"};
const envelope=sealApprovalPayload("fixture-only",binding,wrapKey,contentKey,mark);
const encodedEnvelope=encodeApprovalPayloadEnvelope(envelope);
const metadata={codec_version:1 as const,binding,consume_id:null,envelope_digest:encodedEnvelope.digest,state:"active" as const,deleted_at:null};
const encoded=encodeApprovalPayloadMetadata(metadata,scope);

test("payload metadataはciphertextと分離してcanonical round-tripしownerごとに独立する",()=>{
  assert.deepEqual(decodeApprovalPayloadMetadata(encoded.canonical,encoded.digest,scope),encoded);
  assert.deepEqual(encodeApprovalPayloadMetadata(Object.fromEntries(Object.entries(metadata).reverse()),scope),encoded);
  assert.equal(encoded.key,approvalPayloadMetadataKey(scope,"request","request"));
  assert.notEqual(encoded.key,approvalPayloadMetadataKey(scope,"attempt","request"));
  assert.notEqual(encoded.key,approvalPayloadMetadataKey({...scope,workspace_id:"other"},"request","request"));
  assert.equal(encoded.canonical.includes(envelope.ciphertext),false);
  assert.equal(encoded.canonical.includes("fixture-only"),false);
  for(const value of [encoded,encoded.metadata,encoded.metadata.binding,encoded.metadata.binding.scope,encoded.metadata.binding.content])assert.ok(Object.isFrozen(value));
  assert.deepEqual(decodeApprovalPayloadEnvelope(encodedEnvelope.canonical,encodedEnvelope.digest),encodedEnvelope);
  assert.ok(Object.isFrozen(encodedEnvelope.envelope));
});

test("ownerとconsumeの組・active/deleted timestamp・scopeを厳格に検証する",()=>{
  const deleted=encodeApprovalPayloadMetadata({...metadata,state:"deleted",deleted_at:"2026-09-20T00:01:00.000Z"},scope);
  assert.equal(deleted.key,encoded.key);assert.notEqual(deleted.digest,encoded.digest);
  const attempt=encodeApprovalPayloadMetadata({...metadata,binding:{...binding,owner_kind:"attempt",owner_id:"attempt"},consume_id:"consume"},scope);
  assert.notEqual(attempt.key,encoded.key);
  for(const value of [{...metadata,consume_id:"consume"},{...metadata,state:"deleted"},{...metadata,deleted_at:at},
    {...metadata,state:"deleted",deleted_at:"2026-09-19T23:59:59.999Z"},{...metadata,binding:{...binding,owner_kind:"attempt",owner_id:"attempt"}},
    {...metadata,codec_version:2},{...metadata,envelope_digest:"G".repeat(64)},{...metadata,raw:"fixture"}])assert.throws(()=>encodeApprovalPayloadMetadata(value,scope),ApprovalPayloadMetadataError);
  assert.throws(()=>encodeApprovalPayloadMetadata(metadata,{...scope,workspace_id:"other"}),ApprovalPayloadMetadataError);
});

test("保存wireの非canonical・改変・未知field・過大入力を固定errorで拒否する",()=>{
  for(const wire of [" "+encoded.canonical,encoded.canonical.replace('"consume_id":null','"consume_id":null,"consume_id":null'),
    encoded.canonical.replace('"codec_version":1','"codec_version":1.0'),encoded.canonical.replace('"active"','"deleted"'),"x".repeat(8193),"null","[]"])
    assert.throws(()=>decodeApprovalPayloadMetadata(wire,encoded.digest,scope),ApprovalPayloadMetadataError);
  assert.throws(()=>decodeApprovalPayloadMetadata(encoded.canonical,"0".repeat(64),scope),ApprovalPayloadMetadataError);
  for(const wire of [" "+encodedEnvelope.canonical,encodedEnvelope.canonical.replace('"codec_version":1','"codec_version":1,"codec_version":1'),"x".repeat(360449)])
    assert.throws(()=>decodeApprovalPayloadEnvelope(wire,encodedEnvelope.digest),ApprovalPayloadMetadataError);
  assert.throws(()=>decodeApprovalPayloadEnvelope(encodedEnvelope.canonical,"0".repeat(64)),ApprovalPayloadMetadataError);
});

test("公開parserはpassive dataとbase64url byte長を検査し認証済みと扱わない",()=>{
  assert.deepEqual(parseApprovalPayloadBinding(binding),binding);
  assert.deepEqual(parseSealedApprovalPayload(envelope),envelope);
  let invoked=false;const getter={...binding};Object.defineProperty(getter,"scope",{get(){invoked=true;throw Error("private");},enumerable:true});
  for(const value of [getter,new Proxy(binding,{}),{...binding,raw:"private"}])assert.throws(()=>parseApprovalPayloadBinding(value),ApprovalPayloadError);
  assert.equal(invoked,false);
  for(const value of [{...envelope,wrapped_key:"a".repeat(54)},{...envelope,nonce:"!".repeat(16)},{...envelope,tag:"a".repeat(22)},
    {...envelope,ciphertext:"_".repeat(349526)},{...envelope,key_version:0},{...envelope,raw:"private"}])assert.throws(()=>parseSealedApprovalPayload(value),ApprovalPayloadError);
});

test("payload treeとrecord treeは同じowner keyでもrootとnodeを共有できない",()=>{
  const payloadScope={...scope,collection:"approval_payloads_v1" as const},recordScope={...scope,collection:"approval_records_v1" as const};
  const nodes=new Map<string,string>();const reader=(digest:string)=>nodes.get(digest);
  const payloadEmpty=emptyMetadataRoot(payloadScope),recordEmpty=emptyMetadataRoot(recordScope);
  assert.notEqual(payloadEmpty,recordEmpty);
  const update=prepareMetadataUpdate(payloadScope,payloadEmpty,encoded.key,null,encoded.digest,reader);
  for(const node of update.nodes)nodes.set(node.digest,node.wire);
  assert.equal(readMetadataValue(payloadScope,update.proposed_root,encoded.key,reader),encoded.digest);
  assert.throws(()=>readMetadataValue(recordScope,update.proposed_root,encoded.key,reader),MetadataTreeError);
  assert.throws(()=>readMetadataValue(payloadScope,recordEmpty,encoded.key,reader),MetadataTreeError);
  const recordUpdate=prepareMetadataUpdate(recordScope,recordEmpty,encoded.key,null,encoded.digest,reader);
  assert.notEqual(recordUpdate.proposed_root,update.proposed_root);
  assert.throws(()=>emptyMetadataRoot({...scope,collection:"arbitrary"}),MetadataTreeError);
});
