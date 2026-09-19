import { parseWebPolicy } from "../src/policy.js";
// All domains, identities, and secret bytes in this suite are synthetic fixtures.
export const fixturePolicy = () => parseWebPolicy({
  schema_version: 1, instance_id: "instance_a", tenant_id: "tenant_a", mode: "loopback", internet_enabled: false,
  origin: "https://localhost:7443", listener: { kind: "direct_tls", host: "127.0.0.1", port: 7443, certificate_ref: "test_cert", private_key_ref: "test_tls" },
  dispatcher_socket_path: "/fixture/dispatcher.sock", service_credential_ref: "test_service",
  oidc: { issuer: "https://idp.example.test/", access_token_audience: "dona-api", client_id: "dona-web", client_secret_ref: "test_client",
    authorization_endpoint: "https://idp.example.test/authorize", token_endpoint: "https://idp.example.test/token", jwks_endpoint: "https://idp.example.test/jwks",
    introspection_endpoint: "https://idp.example.test/introspect", redirect_uri: "https://localhost:7443/oidc/callback", algorithms: ["ES256"] },
});
export const fixtureSecret = "test-only-client-secret-000000000000000000000000";
