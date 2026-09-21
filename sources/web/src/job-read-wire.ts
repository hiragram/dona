import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ServiceScope, WebServiceCredential, WebServiceCredentialLookup } from "./service-auth.js";

export const webJobReadServicePath="/v1/web/jobs/read",webJobReadServiceHost="dona-web-job-read",maximumWebJobReadBodyBytes=32768,
  maximumWebJobReadResponseBytes=8*1024*1024,maximumWebJobBrowserBodyBytes=4*1024*1024;
const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),cursor=z.string().regex(/^[A-Za-z0-9_-]{43}$/),utc=z.string().datetime(),digest=z.string().regex(/^[0-9a-f]{64}$/);
export const webJobReadInputSchema=z.strictObject({codec_version:z.literal(1),operation:z.enum(["list","detail","events"]),method:z.literal("GET"),
  target:z.string().min(1).max(8192),context:z.string().min(1).max(8192),cursor:cursor.optional(),limit:z.number().int().min(1).max(50).optional()});
export type WebJobReadInput=z.infer<typeof webJobReadInputSchema>;
const artifact=z.strictObject({name:z.string().min(1).max(128),kind:z.enum(["file","report","log","other"]),media_type:z.string().min(1).max(128).optional(),size_bytes:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()});
export const webJobProjectionSchema=z.strictObject({job_id:id,status:z.enum(["queued","preparing","dispatching","running","retryable_failed","cancelling","blocked","completed","failed","cancelled","needs_review"]),
  created_at:utc,updated_at:utc,completed_at:utc.nullable(),progress:z.strictObject({sequence:z.number().int().min(0),phase:z.enum(["preparing","implementing","testing","reviewing","waiting_ci","reconciling"]),updated_at:utc}).nullable(),
  result:z.strictObject({status:z.enum(["completed","failed"]),summary:z.string().max(2000),completed_at:utc,artifacts:z.array(artifact).max(32)}).nullable(),error_code:z.string().max(128).nullable(),control:z.strictObject({can_cancel:z.boolean()})});
export const webJobReadResultSchema=z.union([
  z.strictObject({status:z.literal("succeeded"),kind:z.literal("list"),items:z.array(webJobProjectionSchema).max(50),next_cursor:cursor.nullable()}),
  z.strictObject({status:z.literal("succeeded"),kind:z.literal("detail"),job:webJobProjectionSchema,event_cursor:cursor}),
  z.strictObject({status:z.literal("succeeded"),kind:z.literal("events"),job:webJobProjectionSchema,event_cursor:cursor,changed:z.boolean(),reset_required:z.boolean()}),
  z.strictObject({status:z.literal("denied"),reason:z.enum(["invalid_request","identity_unavailable","scope_denied","not_found","cursor_invalid","internal_error"])})]);
export type WebJobReadResult=z.infer<typeof webJobReadResultSchema>;
export class WebJobReadWireError extends Error{constructor(){super("web_job_read_unverified");this.name="WebJobReadWireError";}}
const claimsSchema=z.strictObject({codec_version:z.literal(1),key_version:z.number().int().min(1),instance_id:id,tenant_id:id,body_digest:digest,issued_at:utc,expires_at:utc,nonce:z.string().regex(/^[A-Za-z0-9_-]{43}$/)});
const responseSchema=z.strictObject({codec_version:z.literal(1),key_version:z.number().int().min(1),instance_id:id,tenant_id:id,request_nonce:z.string().regex(/^[A-Za-z0-9_-]{43}$/),request_body_digest:digest,request_proof_digest:digest,issued_at:utc,expires_at:utc,result:webJobReadResultSchema});
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
export function encodeWebJobReadInput(input:unknown):string{try{const raw=JSON.stringify(webJobReadInputSchema.parse(input));if(Buffer.byteLength(raw)>maximumWebJobReadBodyBytes)throw Error();return raw;}catch{throw new WebJobReadWireError();}}
export function signWebJobReadProof(raw:string,scope:ServiceScope,credential:WebServiceCredential,now:string):string{try{const at=Date.parse(now);
  if(credential.purpose!=="web_bff_service"||credential.state!=="active"||credential.instance_id!==scope.instance_id||credential.tenant_id!==scope.tenant_id||at<Date.parse(credential.activated_at)||at>=Date.parse(credential.signing_expires_at))throw Error();
  const claims={codec_version:1,key_version:credential.version,...scope,body_digest:hash(raw),issued_at:now,expires_at:new Date(at+10000).toISOString(),nonce:randomBytes(32).toString("base64url")};
  const payload=Buffer.from(JSON.stringify(claims)).toString("base64url"),mac=createHmac("sha256",credential.secret).update("dona.web-job-read.request.v1\0").update(payload).digest("base64url");return `${payload}.${mac}`;}catch{throw new WebJobReadWireError();}}
export function verifyWebJobReadResponse(proof:string,requestProof:string,requestBody:string,scope:ServiceScope,lookup:WebServiceCredentialLookup,now:string):WebJobReadResult{try{
  const requestPart=requestProof.split(".")[0]!,requestText=Buffer.from(requestPart,"base64url").toString("utf8"),request=claimsSchema.parse(JSON.parse(requestText));
  if(Buffer.from(requestPart,"base64url").toString("base64url")!==requestPart||JSON.stringify(request)!==requestText)throw Error();
  const credential=lookup(request.key_version),parts=proof.split("."),issued=Date.parse(request.issued_at);if(!credential||credential.purpose!=="web_bff_service"||credential.version!==request.key_version||credential.state==="revoked"||credential.instance_id!==scope.instance_id||credential.tenant_id!==scope.tenant_id||issued<Date.parse(credential.activated_at)||issued>=Date.parse(credential.signing_expires_at)||parts.length!==2)throw Error();
  const actual=Buffer.from(parts[1]!,"base64url"),expected=createHmac("sha256",credential.secret).update("dona.web-job-read.response.v1\0").update(parts[0]!).digest();if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error();
  const text=Buffer.from(parts[0]!,"base64url").toString("utf8"),response=responseSchema.parse(JSON.parse(text)),at=Date.parse(now);
  if(Buffer.from(parts[0]!,"base64url").toString("base64url")!==parts[0]||JSON.stringify(response)!==text||response.key_version!==request.key_version||response.instance_id!==scope.instance_id||response.tenant_id!==scope.tenant_id||response.request_nonce!==request.nonce||response.request_body_digest!==hash(requestBody)||response.request_proof_digest!==hash(requestProof)||response.expires_at!==request.expires_at||at<Date.parse(response.issued_at)||at>=Date.parse(response.expires_at))throw Error();return response.result;}catch{throw new WebJobReadWireError();}}
