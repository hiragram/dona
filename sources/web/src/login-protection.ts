import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { loginTransactionSchema, type LoginTransaction } from "./oidc.js";
import { assertProtectionKey, type SessionProtectionKey } from "./session-protection.js";

const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const version=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const utc=z.string().refine(value=>Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value);
const bindingSchema=z.strictObject({instance_id:id,tenant_id:id,login_ref:id,bff_generation:version,
  cookie_key_version:version,cookie_digest:z.string().regex(/^[a-f0-9]{64}$/),created_at:utc,expires_at:utc})
  .refine(value=>Date.parse(value.expires_at)-Date.parse(value.created_at)===300000);
export type LoginBinding=z.infer<typeof bindingSchema>;
const envelopeSchema=z.strictObject({codec_version:z.literal(1),key_version:version,sealed_at:utc,
  nonce:z.string().max(16),ciphertext:z.string().min(1).max(1366),tag:z.string().max(22)});
export type SealedLoginTransaction=z.infer<typeof envelopeSchema>;
export class LoginProtectionError extends Error {constructor(){super("login_protection_unverified");this.name="LoginProtectionError";}}
function guard<T>(action:()=>T):T {try{return action();}catch{throw new LoginProtectionError();}}
function decode(value:string,length?:number):Buffer {
  if(!/^[A-Za-z0-9_-]+$/.test(value))throw new LoginProtectionError();
  const bytes=Buffer.from(value,"base64url");
  if(bytes.toString("base64url")!==value || (length!==undefined && bytes.length!==length))throw new LoginProtectionError();
  return bytes;
}
function binding(input:LoginBinding,now:string):LoginBinding {
  const value=bindingSchema.parse(input);const at=Date.parse(utc.parse(now));
  if(at<Date.parse(value.created_at) || at>=Date.parse(value.expires_at))throw new LoginProtectionError();
  return value;
}
function aad(value:LoginBinding,keyVersion:number,sealedAt:string):Buffer {
  return Buffer.from(JSON.stringify(["dona.web.login-transaction",1,keyVersion,sealedAt,value.instance_id,value.tenant_id,
    value.login_ref,value.bff_generation,value.cookie_key_version,value.cookie_digest,value.created_at,value.expires_at]));
}
function transaction(input:unknown,owner:LoginBinding):LoginTransaction {
  const value=loginTransactionSchema.parse(input);
  if(new Date(value.created_at*1000).toISOString()!==owner.created_at || new Date(value.expires_at*1000).toISOString()!==owner.expires_at)
    throw new LoginProtectionError();
  return value;
}
/** Seals only the five-minute login secret. The caller must atomically store the
 * envelope and its cookie binding through the common audited repository. */
export function sealLoginTransaction(input:LoginTransaction,ownerInput:LoginBinding,key:SessionProtectionKey,now:string):SealedLoginTransaction {
 return guard(()=>{
  const owner=binding(ownerInput,now);assertProtectionKey(key,"web_login_transaction",Date.parse(now),true);
  const plaintext=Buffer.from(JSON.stringify(transaction(input,owner)));
  try {
   if(plaintext.length>1024)throw new LoginProtectionError();
   const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key.secret,nonce,{authTagLength:16});
   cipher.setAAD(aad(owner,key.version,now));
   return {codec_version:1,key_version:key.version,sealed_at:now,nonce:nonce.toString("base64url"),
     ciphertext:Buffer.concat([cipher.update(plaintext),cipher.final()]).toString("base64url"),tag:cipher.getAuthTag().toString("base64url")};
  }finally{plaintext.fill(0);}
 });
}
/** Decryption does not consume a login. Call only with the envelope returned by a
 * verified one-shot consume that deletes its stored secret before token exchange.
 * An uncertain consume/exchange must never be retried through this helper. */
export function openLoginTransaction(input:unknown,ownerInput:LoginBinding,key:SessionProtectionKey,now:string):LoginTransaction {
 return guard(()=>{
  const owner=binding(ownerInput,now),envelope=envelopeSchema.parse(input);const at=Date.parse(now),sealed=Date.parse(envelope.sealed_at);
  assertProtectionKey(key,"web_login_transaction",at,false);
  if(envelope.key_version!==key.version || sealed<Date.parse(key.activated_at) || sealed>=Date.parse(key.signing_expires_at)
    || sealed<Date.parse(owner.created_at) || sealed>at)throw new LoginProtectionError();
  const ciphertext=decode(envelope.ciphertext);if(ciphertext.length<1 || ciphertext.length>1024)throw new LoginProtectionError();
  const decipher=createDecipheriv("aes-256-gcm",key.secret,decode(envelope.nonce,12),{authTagLength:16});
  decipher.setAAD(aad(owner,key.version,envelope.sealed_at));decipher.setAuthTag(decode(envelope.tag,16));
  let first:Buffer|undefined,plaintext:Buffer|undefined;
  try {
   first=decipher.update(ciphertext);plaintext=Buffer.concat([first,decipher.final()]);
   const text=new TextDecoder("utf-8",{fatal:true}).decode(plaintext),value=transaction(JSON.parse(text),owner);
   if(JSON.stringify(value)!==text)throw new LoginProtectionError();return value;
  }finally{first?.fill(0);plaintext?.fill(0);}
 });
}
