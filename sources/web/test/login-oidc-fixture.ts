import assert from "node:assert/strict";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { OidcProtocol, type LoginTransaction } from "../src/oidc.js";
import { fixtureSecret } from "./fixtures.js";
import type { WebPolicy } from "../src/policy.js";
/** Signed fixture JWT and real OIDC code/PKCE/nonce/introspection logic, with a
 * synthetic fetch transport. Never contacts an IdP or creates real credentials. */
export async function loginOidcFixture(policy: WebPolicy, now: () => string, accessToken: string) {
  const key = await generateKeyPair("ES256", { extractable: true });
  const publicKey = { ...await exportJWK(key.publicKey), kid: "fixture-login", alg: "ES256", use: "sig" };
  let transaction: LoginTransaction | undefined, mode: "valid" | "nonce" | "subject" | "inactive" | "unavailable" = "valid";
  const calls: string[] = [];
  const protocol = new OidcProtocol(policy, { clientSecret: () => fixtureSecret }, { fetch: (async (url, init) => {
    assert.equal(typeof url, "string"); const route = new URL(url as string).pathname; calls.push(route);
    assert.equal(init?.redirect, "error"); const at = Math.floor(Date.parse(now()) / 1000);
    if (mode === "unavailable") throw Error("fixture upstream unavailable");
    let value: unknown;
    if (route === "/token") {
      assert.ok(transaction); const form = new URLSearchParams(init?.body as string);
      assert.equal(form.get("code"), "fixture-code"); assert.equal(form.get("code_verifier"), transaction.verifier);
      const jwt = await new SignJWT({ iss: policy.oidc.issuer, sub: mode === "subject" ? "unregistered" : "subject-A", aud: policy.oidc.client_id,
        iat: at, exp: at + 300, nonce: mode === "nonce" ? "wrong" : transaction.nonce })
        .setProtectedHeader({ alg: "ES256", kid: "fixture-login" }).sign(key.privateKey);
      value = { access_token: accessToken, id_token: jwt, expires_in: 300, token_type: "Bearer" };
    } else if (route === "/jwks") value = { keys: [publicKey] };
    else if (route === "/introspect") value = { active: mode !== "inactive", sub: mode === "subject" ? "unregistered" : "subject-A",
      aud: policy.oidc.access_token_audience, client_id: policy.oidc.client_id, exp: at + 300 };
    else throw Error("unexpected fixture endpoint");
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  }) as typeof fetch });
  return { calls, setMode: (value: typeof mode) => { mode = value; }, connection: {
    createLogin: (at: number) => { const value = protocol.createLogin(at); transaction = value.transaction; return value; },
    exchange: protocol.exchange.bind(protocol),
  } };
}
