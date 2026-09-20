import assert from "node:assert/strict";
import { WebAuthController, type BrowserAuthKeys, type BrowserAuthConnections, type BrowserAuthRequest } from "../src/auth-controller.js";
import { cookieDigest, sealAccessToken, sessionCsrf, type SessionBinding, type SessionProtectionKey } from "../src/session-protection.js";
import { encodeWebPayload, webPayloadBinding, type StoredWebSession, type StoredWebPayload } from "../src/store-wire.js";
import { evaluateSession, type RegistryPrincipal } from "../src/domain.js";
import { ingressContextRequest, verifyIngressContext, type ContextKey } from "../src/context.js";
import { subjectLookupIndexes, type IdentityIndexInventory } from "../src/identity-index.js";
import { fixturePolicy } from "./fixtures.js";
import type { OnlineToken } from "../src/oidc.js";

// In-memory connection doubles for controller unit tests only. Durable audit,
// one-use, OS protection and authenticated UDS are independently tested by their
// real repositories/clients; this fixture is never a runtime provider.
export function controllerFixture(policy = fixturePolicy()) {
  const initial = "2026-09-19T00:00:01.000Z";
  const calls: string[] = [], contexts: string[] = [];
  let at = initial, online: OnlineToken = { active: true, sub: "subject-A", expires_at: Date.parse(initial) / 1000 + 300 };
  const key = (purpose: SessionProtectionKey["purpose"]): SessionProtectionKey => ({ purpose, version: 1, state: "active",
    activated_at: "2026-09-01T00:00:00.000Z", signing_expires_at: "2026-11-01T00:00:00.000Z", secret: Buffer.alloc(32, purpose.length) });
  const contextKey: ContextKey = { ...key("web_csrf"), purpose: "web_ingress_context", secret: Buffer.alloc(32, 99) };
  const identityInventory: IdentityIndexInventory = { active_version: 1, retained_versions: [1],
    keys: [{ purpose: "web_identity_index", version: 1, state: "active", secret: Buffer.alloc(32, 8) }] };
  const principal: RegistryPrincipal = { codec_version: 1, instance_id: policy.instance_id, tenant_id: policy.tenant_id,
    principal_id: "principal", state: "active", revoke_generation: 1, identity_binding_revision: 1, authz_revision: 1,
    role_ids: ["requester"], scopes: ["job:read:own"] };
  const owner: SessionBinding = { instance_id: policy.instance_id, tenant_id: policy.tenant_id, principal_id: "principal", session_ref: "session",
    session_generation: 1, identity_binding_revision: 1, authz_revision: 1, issued_at: initial, expires_at: "2026-09-19T01:00:01.000Z" };
  const cookie = Buffer.alloc(32, 9).toString("base64url"), token = "fixture-access-token-only";
  const session: StoredWebSession = { state: { codec_version: 1, instance_id: policy.instance_id, tenant_id: policy.tenant_id,
    principal_id: "principal", session_ref: "session", state: "active", session_generation: 1, principal_revoke_generation: 1,
    identity_binding_revision: 1, authz_revision: 1, bff_generation: 1, authenticated_at: initial, expires_at: owner.expires_at,
    access_token_expires_at: owner.expires_at, last_activity_at: initial }, cookie_key_version: 1,
    cookie_digest: cookieDigest(cookie, key("web_cookie_index"), initial, "create"), csrf_key_version: 1, token_key_version: 1,
    payload_ref: "payload", payload_digest: "0".repeat(64) };
  const encoded = encodeWebPayload({ codec_version: 1, purpose: "web_access_token", payload_ref: "payload", binding_digest: webPayloadBinding(session),
    envelope: sealAccessToken(token, owner, key("web_access_token"), initial) });
  session.payload_digest = encoded.digest;
  const snapshot: { session: StoredWebSession; principal: RegistryPrincipal; bff_generation: number; payload: StoredWebPayload | null } = {
    session, principal, bff_generation: 1, payload: encoded.payload };
  const csrf = sessionCsrf(owner, key("web_csrf"), initial, "create");
  const expectedIndexes = subjectLookupIndexes({ instance_id: policy.instance_id, tenant_id: policy.tenant_id,
    issuer: policy.oidc.issuer, subject: "subject-A" }, identityInventory).map(value => ({ key_version: value.identity_index_key_version, digest: value.subject_digest }));
  const keys: BrowserAuthKeys = { cookies: () => ({ retained_versions: [1], keys: [key("web_cookie_index")] }),
    protection: (purpose, version) => { assert.equal(version, 1); return key(purpose); }, identities: () => identityInventory, context: () => contextKey };
  const connections: BrowserAuthConnections = {
    read: { read: async input => {
      calls.push("read:" + input.operation);
      if (input.operation === "session_lookup") {
        const found = input.cookie_indexes.some(value => value.key_version === session.cookie_key_version && value.digest === session.cookie_digest);
        return { operation: input.operation, snapshot: found ? structuredClone(snapshot) : null };
      }
      if (input.operation === "principal_lookup") return { operation: input.operation,
        snapshot: JSON.stringify(input.subject_indexes) === JSON.stringify(expectedIndexes) ? { principal: structuredClone(principal), bff_generation: snapshot.bff_generation } : null };
      return { operation: input.operation, bff_generation: snapshot.bff_generation, retained_subject_key_versions: [1] };
    } },
    write: { mutate: async input => {
      calls.push("write:" + input.operation);
      if (input.operation === "record_denial") return { operation: input.operation, result: { status: "denied", reason: input.reason } };
      if (input.operation !== "revoke_session" && input.operation !== "revoke_inactive") throw Error("unsupported fixture operation");
      assert.equal(input.session_ref, session.state.session_ref);
      assert.deepEqual(input.cookie, { key_version: session.cookie_key_version, digest: session.cookie_digest });
      session.state.state = "revoked"; session.payload_ref = null; session.payload_digest = null; snapshot.payload = null;
      return { operation: input.operation, result: input.operation === "revoke_inactive" ? { status: "denied", reason: "identity_invalid" }
        : { status: "succeeded", kind: "revoked", generation: snapshot.bff_generation } };
    } },
    oidc: { introspect: async (accessToken, clock) => { calls.push("oidc"); clock(); assert.equal(accessToken, token); return structuredClone(online); } },
    session: { confirm: async (input, identity) => {
      calls.push("confirm"); contexts.push(input.context);
      verifyIngressContext(input.context, contextKey, identity, ingressContextRequest(input.method, input.target, Buffer.alloc(0)), at);
      const decision = evaluateSession(principal, session.state, { instance_id: policy.instance_id, tenant_id: policy.tenant_id, bff_generation: snapshot.bff_generation }, at);
      return decision.allowed ? { status: "succeeded", principal: decision.principal } : { status: "denied", reason: decision.reason };
    } },
  };
  const controller = new WebAuthController(policy, connections, keys, () => at, 1);
  function request(target = "/api/session", method = "GET"): BrowserAuthRequest {
    return { target, method, transportVerified: true, body: Buffer.from(method === "POST" ? "{}" : ""),
      headers: [["host", new URL(policy.origin).host], ["sec-fetch-site", "same-origin"], ["cookie", "__Host-dona_session=" + cookie],
        ...(method === "POST" ? [["origin", policy.origin], ["content-type", "application/json"], ["x-dona-csrf", csrf]] as const : [])] };
  }
  return { controller, connections, keys, key, snapshot, policy, csrf, cookie, token, initial, calls, contexts, request,
    now: () => at, setNow: (value: string) => { at = value; }, setOnline: (value: OnlineToken) => { online = value; } };
}
