import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { roleSchema, scopeSchema, scopeEligible } from "./domain.js";

export const webSessionServicePath = "/v1/web/session/verify";
export const webSessionServiceHost = "dona-web-session";
export const maximumServiceBodyBytes = 16384;
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).refine(value => !/\s/.test(value));
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const utc = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const digest = z.string().length(64).regex(/^[a-f0-9]+$/);
const nonce = z.string().length(43).refine(value => /^[A-Za-z0-9_-]+$/.test(value)
  && Buffer.from(value, "base64url").length === 32 && Buffer.from(value, "base64url").toString("base64url") === value);
export const serviceScopeSchema = z.strictObject({ instance_id: id, tenant_id: id });
export type ServiceScope = z.infer<typeof serviceScopeSchema>;
const credentialSchema = z.strictObject({ purpose: z.literal("web_bff_service"), version: revision,
  state: z.enum(["active", "verification_only", "revoked"]), instance_id: id, tenant_id: id,
  activated_at: utc, signing_expires_at: utc, secret: z.instanceof(Uint8Array).refine(value => value.byteLength === 32) });
export type WebServiceCredential = z.infer<typeof credentialSchema>;
export type WebServiceCredentialLookup = (version: number) => WebServiceCredential | undefined;
const requestClaimsSchema = z.strictObject({ codec_version: z.literal(1), audience: z.literal("dona.dispatcher.web-session-service"),
  key_version: revision, instance_id: id, tenant_id: id, method: z.literal("POST"), path: z.literal(webSessionServicePath),
  body_digest: digest, nonce, issued_at: utc, expires_at: utc }).refine(value => Date.parse(value.expires_at) > Date.parse(value.issued_at)
    && Date.parse(value.expires_at) - Date.parse(value.issued_at) <= 10000);
export type ServiceRequestClaims = z.infer<typeof requestClaimsSchema>;
const principalSchema = z.strictObject({ codec_version: z.literal(1), instance_id: id, tenant_id: id, principal_id: id,
  identity_binding_revision: revision, authz_revision: revision, role_ids: z.array(roleSchema).min(1).max(3),
  scopes: z.array(scopeSchema).max(6), session_ref: id, session_generation: revision, authenticated_at: utc, expires_at: utc,
}).refine(value => new Set(value.role_ids).size === value.role_ids.length && new Set(value.scopes).size === value.scopes.length
  && value.scopes.every(scope => scopeEligible(value, scope)) && Date.parse(value.expires_at) > Date.parse(value.authenticated_at)
  && Date.parse(value.expires_at) - Date.parse(value.authenticated_at) <= 8 * 3600 * 1000);
export const sessionServiceDenialSchema = z.enum(["deployment_invalid", "identity_unavailable", "proof_invalid", "operation_unsupported",
  "session_invalid", "session_revoked", "session_expired", "identity_mismatch", "revision_mismatch", "clock_anomaly", "already_consumed", "quota_exceeded"]);
const resultSchema = z.discriminatedUnion("status", [z.strictObject({ status: z.literal("denied"), reason: sessionServiceDenialSchema }),
  z.strictObject({ status: z.literal("succeeded"), principal: principalSchema })]);
export type SessionServiceResult = z.infer<typeof resultSchema>;
const responseClaimsSchema = z.strictObject({ codec_version: z.literal(1), audience: z.literal("dona.bff.web-session-response"),
  key_version: revision, instance_id: id, tenant_id: id, request_nonce: nonce, request_body_digest: digest,
  request_proof_digest: digest, issued_at: utc, expires_at: utc, result: resultSchema });
const inputSchema = z.strictObject({ codec_version: z.literal(1), method: z.literal("GET"), target: z.enum(["/", "/api/session"]),
  context: z.string().min(1).max(8192).regex(/^[A-Za-z0-9_.-]+$/), user_navigation: z.literal(true).optional() })
  .refine(value => value.user_navigation !== true || value.target === "/");
export type SessionServiceInput = z.infer<typeof inputSchema>;
export class WebServiceError extends Error {
  constructor() { super("web_service_unverified"); this.name = "WebServiceError"; }
}
function guard<T>(operation: () => T): T { try { return operation(); } catch { throw new WebServiceError(); } }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function nowMs(value: string): number { return Date.parse(utc.parse(value)); }
function key(input: unknown, scopeInput: ServiceScope, issued: number, now: number, signing: boolean): WebServiceCredential {
  const credential = credentialSchema.parse(input), scope = serviceScopeSchema.parse(scopeInput);
  const start = nowMs(credential.activated_at), end = nowMs(credential.signing_expires_at);
  if (credential.instance_id !== scope.instance_id || credential.tenant_id !== scope.tenant_id || credential.state === "revoked"
    || (signing && credential.state !== "active") || end <= start || end - start > 90 * 24 * 3600 * 1000
    || issued < start || issued >= end || now < issued) throw new WebServiceError();
  return { ...credential, secret: Buffer.from(credential.secret) };
}
function b64(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new WebServiceError();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new WebServiceError();
  return decoded;
}
function seal(kind: "request" | "response", value: unknown, credential: WebServiceCredential): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const mac = createHmac("sha256", credential.secret).update(`dona.web-service.${kind}.v1\0`).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}
function open(kind: "request" | "response", proof: string, credential: WebServiceCredential, maximum: number): { text: string; value: unknown } {
  if (typeof proof !== "string" || proof.length > maximum) throw new WebServiceError();
  const parts = proof.split("."); if (parts.length !== 2) throw new WebServiceError();
  const actual = b64(parts[1]!);
  const expected = createHmac("sha256", credential.secret).update(`dona.web-service.${kind}.v1\0`).update(parts[0]!).digest();
  if (actual.length !== 32 || !timingSafeEqual(actual, expected)) throw new WebServiceError();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(b64(parts[0]!)); return { text, value: JSON.parse(text) };
}
function requestClaims(proof: string): ServiceRequestClaims {
  if (typeof proof !== "string" || proof.length > 2048 || proof.split(".").length !== 2) throw new WebServiceError();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(b64(proof.split(".")[0]!));
  const claims = requestClaimsSchema.parse(JSON.parse(text));
  if (JSON.stringify(claims) !== text) throw new WebServiceError(); return claims;
}
export function encodeSessionServiceInput(input: unknown): string {
  return guard(() => { const result = JSON.stringify(inputSchema.parse(input));
    if (Buffer.byteLength(result) > maximumServiceBodyBytes) throw new WebServiceError(); return result; });
}
export function parseSessionServiceInput(body: string): SessionServiceInput {
  return guard(() => {
    if (typeof body !== "string" || Buffer.byteLength(body) > maximumServiceBodyBytes) throw new WebServiceError();
    const input = inputSchema.parse(JSON.parse(body)); if (encodeSessionServiceInput(input) !== body) throw new WebServiceError(); return input;
  });
}
function verifyRequest(proof: string, body: string, scope: ServiceScope, lookup: WebServiceCredentialLookup, now: string): ServiceRequestClaims {
  const claims = requestClaims(proof), at = nowMs(now);
  const credential = key(lookup(claims.key_version), scope, nowMs(claims.issued_at), at, false);
  if (credential.version !== claims.key_version || claims.instance_id !== scope.instance_id || claims.tenant_id !== scope.tenant_id
    || at >= nowMs(claims.expires_at) || typeof body !== "string" || Buffer.byteLength(body) > maximumServiceBodyBytes
    || claims.body_digest !== hash(body)) throw new WebServiceError();
  const decoded = open("request", proof, credential, 2048);
  if (decoded.text !== JSON.stringify(claims)) throw new WebServiceError(); return claims;
}

/** MAC validation alone grants no principal. The endpoint must call the
 * authoritative repository, which consumes the ingress nonce with its audit. */
export function verifyServiceRequest(proof: string, body: string, scope: ServiceScope, lookup: WebServiceCredentialLookup, now: string): ServiceRequestClaims {
  return guard(() => verifyRequest(proof, body, scope, lookup, now));
}
export function signServiceResponse(requestProof: string, requestBody: string, resultInput: SessionServiceResult,
  scope: ServiceScope, lookup: WebServiceCredentialLookup, now: string): string {
  return guard(() => {
    const request = verifyRequest(requestProof, requestBody, scope, lookup, now), at = nowMs(now);
    const credential = key(lookup(request.key_version), scope, nowMs(request.issued_at), at, false);
    if (credential.version !== request.key_version) throw new WebServiceError();
    const result = resultSchema.parse(resultInput);
    if (result.status === "succeeded" && (result.principal.instance_id !== scope.instance_id || result.principal.tenant_id !== scope.tenant_id
      || at >= nowMs(result.principal.expires_at) || at < nowMs(result.principal.authenticated_at))) throw new WebServiceError();
    const response = responseClaimsSchema.parse({ codec_version: 1, audience: "dona.bff.web-session-response",
      key_version: request.key_version, ...scope, request_nonce: request.nonce, request_body_digest: request.body_digest,
      request_proof_digest: hash(requestProof), issued_at: now, expires_at: request.expires_at, result });
    const proof = seal("response", response, credential);
    if (proof.length > maximumServiceBodyBytes) throw new WebServiceError(); return proof;
  });
}
