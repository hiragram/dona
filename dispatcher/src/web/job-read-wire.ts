import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ServiceScope, WebServiceCredentialLookup } from "./service-auth.js";

export const webJobReadServicePath = "/v1/web/jobs/read";
export const webJobReadServiceHost = "dona-web-job-read";
export const maximumWebJobReadBodyBytes = 32768;
export const maximumWebJobReadResponseBytes = 8 * 1024 * 1024;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), cursor = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const utc = z.string().datetime(), digest = z.string().regex(/^[0-9a-f]{64}$/);
export const webJobReadInputSchema = z.strictObject({ codec_version: z.literal(1), operation: z.enum(["list","detail","events"]),
  method: z.literal("GET"), target: z.string().min(1).max(8192), context: z.string().min(1).max(8192),
  cursor: cursor.optional(), limit: z.number().int().min(1).max(50).optional() });
export type WebJobReadInput = z.infer<typeof webJobReadInputSchema>;
const artifact = z.strictObject({ name: z.string().min(1).max(128), kind: z.enum(["file","report","log","other"]),
  media_type: z.string().min(1).max(128).optional(), size_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() });
const progress = z.strictObject({ sequence: z.number().int().min(0), phase: z.enum(["preparing","implementing","testing","reviewing","waiting_ci","reconciling"]), updated_at: utc });
export const webJobProjectionSchema = z.strictObject({ job_id: id,
  status: z.enum(["queued","preparing","dispatching","running","retryable_failed","cancelling","blocked","completed","failed","cancelled","needs_review"]),
  created_at: utc, updated_at: utc, completed_at: utc.nullable(), progress: progress.nullable(),
  result: z.strictObject({ status: z.enum(["completed","failed"]), summary: z.string().max(2000), completed_at: utc,
    artifacts: z.array(artifact).max(32) }).nullable(), error_code: z.string().max(128).nullable(),
  control: z.strictObject({ can_cancel: z.boolean() }) });
export type WebJobProjection = z.infer<typeof webJobProjectionSchema>;
export const webJobReadResultSchema = z.union([
  z.strictObject({ status:z.literal("succeeded"), kind:z.literal("list"), items:z.array(webJobProjectionSchema).max(50), next_cursor:cursor.nullable() }),
  z.strictObject({ status:z.literal("succeeded"), kind:z.literal("detail"), job:webJobProjectionSchema, event_cursor:cursor }),
  z.strictObject({ status:z.literal("succeeded"), kind:z.literal("events"), job:webJobProjectionSchema, event_cursor:cursor,
    changed:z.boolean(), reset_required:z.boolean() }),
  z.strictObject({ status:z.literal("denied"), reason:z.enum(["invalid_request","identity_unavailable","scope_denied","not_found","cursor_invalid","internal_error"]) })]);
export type WebJobReadResult = z.infer<typeof webJobReadResultSchema>;
export class WebJobReadWireError extends Error { constructor(){super("web_job_read_unverified");this.name="WebJobReadWireError";} }
const claimsSchema=z.strictObject({codec_version:z.literal(1),key_version:z.number().int().min(1),instance_id:id,tenant_id:id,
  body_digest:digest,issued_at:utc,expires_at:utc,nonce:z.string().regex(/^[A-Za-z0-9_-]{43}$/)});
const responseSchema=z.strictObject({codec_version:z.literal(1),key_version:z.number().int().min(1),instance_id:id,tenant_id:id,
  request_nonce:z.string().regex(/^[A-Za-z0-9_-]{43}$/),request_body_digest:digest,request_proof_digest:digest,
  issued_at:utc,expires_at:utc,result:webJobReadResultSchema});
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
export function parseWebJobReadInput(raw:string):WebJobReadInput {try{if(Buffer.byteLength(raw)>maximumWebJobReadBodyBytes)throw Error();
  const value=webJobReadInputSchema.parse(JSON.parse(raw));if(JSON.stringify(value)!==raw)throw Error();return value;}catch{throw new WebJobReadWireError();}}
export function verifyWebJobReadProof(proof:string,raw:string,scope:ServiceScope,lookup:WebServiceCredentialLookup,now:string):void{try{
  const parts=proof.split(".");if(parts.length!==2)throw Error();const text=Buffer.from(parts[0]!,"base64url").toString("utf8"),claims=claimsSchema.parse(JSON.parse(text));
  if(Buffer.from(parts[0]!,"base64url").toString("base64url")!==parts[0]||JSON.stringify(claims)!==text)throw Error();
  const credential=lookup(claims.key_version),at=Date.parse(now),issued=Date.parse(claims.issued_at),expires=Date.parse(claims.expires_at);
  if(!credential||credential.purpose!=="web_bff_service"||credential.version!==claims.key_version||credential.state==="revoked"
    ||credential.instance_id!==scope.instance_id||credential.tenant_id!==scope.tenant_id||claims.instance_id!==scope.instance_id||claims.tenant_id!==scope.tenant_id
    ||claims.body_digest!==hash(raw)||at<issued||at>=expires||expires-issued>10000||issued<Date.parse(credential.activated_at)||issued>=Date.parse(credential.signing_expires_at))throw Error();
  const actual=Buffer.from(parts[1]!,"base64url"),expected=createHmac("sha256",credential.secret).update("dona.web-job-read.request.v1\0").update(parts[0]!).digest();
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error();}catch{throw new WebJobReadWireError();}}
export function signWebJobReadResponse(requestProof:string,requestBody:string,result:WebJobReadResult,scope:ServiceScope,
  lookup:WebServiceCredentialLookup,now:string):string{try{verifyWebJobReadProof(requestProof,requestBody,scope,lookup,now);
  const request=claimsSchema.parse(JSON.parse(Buffer.from(requestProof.split(".")[0]!,"base64url").toString("utf8"))),credential=lookup(request.key_version),at=Date.parse(now);
  if(!credential||credential.state==="revoked"||at<Date.parse(request.issued_at)||at>=Date.parse(request.expires_at))throw Error();
  const response=responseSchema.parse({codec_version:1,key_version:request.key_version,...scope,request_nonce:request.nonce,request_body_digest:request.body_digest,
    request_proof_digest:hash(requestProof),issued_at:now,expires_at:request.expires_at,result:webJobReadResultSchema.parse(result)});
  const payload=Buffer.from(JSON.stringify(response)).toString("base64url"),mac=createHmac("sha256",credential.secret)
    .update("dona.web-job-read.response.v1\0").update(payload).digest("base64url");return `${payload}.${mac}`;}catch{throw new WebJobReadWireError();}}
