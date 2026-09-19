import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { OidcProtocol } from "../src/oidc.js";
import { fixturePolicy, fixtureSecret } from "./fixtures.js";
const now = 1_789_819_200;
const key = await generateKeyPair("ES256", { extractable: true });
const publicJwk = { ...await exportJWK(key.publicKey), kid: "fixture-key", alg: "ES256", use: "sig" };
function json(value: unknown): Response { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }); }
test("通信中に発行されたtokenは応答後の保護時計で検証する", async () => {
  let current=now;
  const f=await fixture({claims:{iat:now+1},clock:()=>current,on_request:route=>{if(route==="/token")current=now+1;}});
  assert.equal((await f.exchange()).sub,"subject-A");
});
test("通信中の失効と時計巻戻りは成功応答でも拒否する", async () => {
  for(const after of [now-1,now+300]) {
    let current=now;
    const f=await fixture({clock:()=>current,on_request:route=>{if(route==="/introspect")current=after;}});
    await assert.rejects(f.exchange(),{code:"identity_invalid"});
  }
  let current=now;
  const f=await fixture({clock:()=>current,token:{expires_in:1},on_request:route=>{if(route==="/introspect")current=now+1;}});
  await assert.rejects(f.exchange(),{code:"identity_invalid"});
});
async function fixture(options: { claims?: Record<string, unknown>; token?: Record<string, unknown>; online?: Record<string, unknown>; kid?: string; jwks?: unknown; corrupt_signature?: boolean; clock?: () => number; on_request?: (route: string) => void } = {}) {
  const policy = fixturePolicy(); const calls: { path: string; init: RequestInit }[] = [];
  let token = "";
  const protocol = new OidcProtocol(policy, { clientSecret: () => fixtureSecret }, { fetch: (async (input, init) => {
    assert.equal(typeof input, "string"); const pathname = new URL(input as string).pathname;
    options.on_request?.(pathname);
    calls.push({ path: pathname, init: init! }); assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    if (pathname === "/token") return json({ access_token: "test-only-access-token", id_token: token, token_type: "Bearer", expires_in: 300, ...options.token });
    if (pathname === "/jwks") return json(options.jwks ?? { keys: [publicJwk] });
    if (pathname === "/introspect") return json({ active: true, sub: "subject-A", client_id: policy.oidc.client_id, aud: "dona-api", exp: now + 300, token_type: "Bearer", ...options.online });
    throw new Error("unexpected endpoint");
  }) as typeof fetch });
  const login = protocol.createLogin(now);
  token = await new SignJWT({ iss: policy.oidc.issuer, sub: "subject-A", aud: policy.oidc.client_id, iat: now, exp: now + 300, nonce: login.transaction.nonce, ...options.claims })
    .setProtectedHeader({ alg: "ES256", kid: options.kid ?? "fixture-key" }).sign(key.privateKey);
  if (options.corrupt_signature) {
    const parts = token.split("."); const signature = parts[2]!;
    parts[2] = (signature[0] === "A" ? "B" : "A") + signature.slice(1); token = parts.join(".");
  }
  return { protocol, login, calls, exchange: () => protocol.exchange(login.transaction, { code: "test-only-code", state: login.transaction.state }, options.clock ?? (() => now)) };
}
test("固定code flowのPKCE/nonceを検証しonline tokenだけを返す", async () => {
  const f = await fixture({ claims: { role: "operator", groups: ["administrators"] }, token: { token_type: "bearer" } });
  const url = new URL(f.login.authorization_url);
  assert.equal(url.origin, "https://idp.example.test"); assert.equal(url.searchParams.get("scope"), "openid");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256"); assert.notEqual(url.searchParams.get("code_challenge"), f.login.transaction.verifier);
  assert.deepEqual(await f.exchange(), { sub: "subject-A", access_token: "test-only-access-token", expires_at: now + 300 });
  assert.deepEqual(f.calls.map(c => c.path), ["/token", "/jwks", "/introspect"]);
  const body = new URLSearchParams(String(f.calls[0]!.init.body)); assert.equal(body.get("code_verifier"), f.login.transaction.verifier);
  assert.ok(!body.has("refresh_token")); assert.equal(new Headers(f.calls[0]!.init.headers).get("authorization"), "Basic " + Buffer.from("dona-web:" + fixtureSecret).toString("base64"));
});
test("state不一致と期限切れではtoken endpointを呼ばない", async () => {
  const f = await fixture();
  await assert.rejects(f.protocol.exchange(f.login.transaction, { code: "code", state: "wrong" }, () => now), { code: "identity_invalid" });
  await assert.rejects(f.protocol.exchange(f.login.transaction, { code: "code", state: f.login.transaction.state }, () => now + 300), { code: "identity_invalid" });
  assert.equal(f.calls.length, 0);
});
test("署名claimとkeyの不一致を検証しintrospection前に拒否する", async () => {
  for (const claims of [{ nonce: "wrong" }, { iss: "https://other.example/" }, { aud: "other" }, { exp: now }, { iat: now + 1 }, { sub: "" }, { aud: ["dona-web", "other"] }, { azp: "other" }, { aud: ["dona-web", "dona-web"], azp: "dona-web" }]) {
    const f = await fixture({ claims }); await assert.rejects(f.exchange(), { code: "identity_invalid" });
    assert.ok(!f.calls.some(c => c.path === "/introspect"));
  }
  for (const options of [{ corrupt_signature: true }, { kid: "unknown" }, { jwks: { keys: [publicJwk, publicJwk] } }, { token: { refresh_token: "test-only-forbidden-refresh" } }]) {
    const f = await fixture(options); await assert.rejects(f.exchange(), { code: "identity_invalid" });
    assert.ok(!f.calls.some(c => c.path === "/introspect"));
  }
});
test("online subject/client/audience/expiry不一致は認証成功にしない", async () => {
  for (const online of [{ active: false }, { sub: "subject-a" }, { client_id: "other" }, { aud: "other" }, { exp: now }, { active: "true" }]) {
    const f = await fixture({ online }); await assert.rejects(f.exchange(), { code: "identity_invalid" });
    assert.equal(f.calls.filter(c => c.path === "/introspect").length, 1);
  }
});
test("introspection成功をcacheせず各呼出しで状態を取得する", async () => {
  let active = true; let calls = 0;
  const p = new OidcProtocol(fixturePolicy(), { clientSecret: () => fixtureSecret }, { fetch: (async () => {
    calls++; return json(active ? { active: true, sub: "subject-A", client_id: "dona-web", aud: ["dona-api"], exp: now + 10 } : { active: false });
  }) as typeof fetch });
  assert.equal((await p.inspect("test-token", "subject-A", () => now)).active, true); active = false;
  assert.deepEqual(await p.inspect("test-token", "subject-A", () => now), { active: false }); assert.equal(calls, 2);
});
test("raw subjectを保存せずindex照合へ渡すintrospectionでも固定audienceとclientを要求する", async () => {
  const f = await fixture({ online: { groups: ["administrators"], email: "fixture@example.test" } });
  assert.deepEqual(await f.protocol.introspect("test-token", () => now), { active: true, sub: "subject-A", expires_at: now + 300 });
  for (const online of [{ sub: undefined }, { client_id: undefined }, { aud: undefined }, { exp: undefined },
    { client_id: "other" }, { aud: "other" }, { exp: now }]) {
    const invalid = await fixture({ online });
    await assert.rejects(invalid.protocol.introspect("test-token", () => now), { code: "identity_invalid" });
    assert.equal(invalid.calls.length, 1);
  }
  await assert.rejects(f.protocol.inspect("test-token", "subject-a", () => now), { code: "identity_invalid" });
});
test("subject未保存のintrospectionでも毎回online状態と応答後の時計を確認する", async () => {
  let calls = 0, current = now;
  const p = new OidcProtocol(fixturePolicy(), { clientSecret: () => fixtureSecret }, { fetch: (async () => {
    calls++; if (calls === 3) current = now - 1;
    return json(calls === 2 ? { active: false } : { active: true, sub: "subject-A", client_id: "dona-web", aud: "dona-api", exp: now + 10 });
  }) as typeof fetch });
  assert.equal((await p.introspect("test-token", () => current)).active, true);
  assert.deepEqual(await p.introspect("test-token", () => current), { active: false });
  await assert.rejects(p.introspect("test-token", () => current), { code: "identity_invalid" });
  assert.equal(calls, 3);
});
test("IdP障害とcredential例外をredactし再送しない", async () => {
  let calls = 0;
  const p = new OidcProtocol(fixturePolicy(), { clientSecret: () => fixtureSecret }, { fetch: (async () => { calls++; throw new Error("test-private-provider-detail"); }) as typeof fetch });
  await assert.rejects(p.inspect("test-token", "subject-A", () => now), { message: "identity_unavailable" }); assert.equal(calls, 1);
  const invalid = new OidcProtocol(fixturePolicy(), { clientSecret: () => { throw new Error("test-secret-value"); } }, { fetch: (async () => { throw new Error("must not call"); }) as typeof fetch });
  await assert.rejects(invalid.inspect("test-token", "subject-A", () => now), { message: "identity_unavailable" });
});
test("oversize responseと未知content typeをboundedに拒否する", async () => {
  for (const response of [new Response("x".repeat(32769), { headers: { "content-type": "application/json" } }), new Response("private-provider-page", { headers: { "content-type": "text/html" } })]) {
    let calls = 0; const p = new OidcProtocol(fixturePolicy(), { clientSecret: () => fixtureSecret }, { fetch: (async () => { calls++; return response; }) as typeof fetch });
    await assert.rejects(p.inspect("test-token", "subject-A", () => now), { code: "identity_invalid" }); assert.equal(calls, 1);
  }
});
test("IdP timeoutでabortしpositive結果や自動再送へfallbackしない", async () => {
  let calls = 0; let signal: AbortSignal | undefined;
  const p = new OidcProtocol(fixturePolicy(), { clientSecret: () => fixtureSecret }, { fetch: (async (_input, init) => { calls++; signal = init?.signal ?? undefined; return await new Promise<Response>(() => {}); }) as typeof fetch });
  await assert.rejects(p.inspect("test-token", "subject-A", () => now), { code: "identity_unavailable" });
  assert.equal(calls, 1); assert.equal(signal?.aborted, true);
});


test("TLS証明書検証を無効にしたprocessでは認証providerを構成しない", () => {
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    assert.throws(() => new OidcProtocol(fixturePolicy(), { clientSecret: () => fixtureSecret }), { code: "deployment_invalid" });
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
});
