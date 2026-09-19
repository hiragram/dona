import path from "node:path";
import { z } from "zod";

export class WebBoundaryError extends Error {
  constructor(readonly code: "deployment_invalid" | "origin_invalid" | "csrf_invalid" | "cookie_ambiguous" | "cookie_invalid" | "identity_invalid" | "identity_unavailable") {
    super(code); this.name = "WebBoundaryError";
  }
}
const opaque = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const endpoint = z.string().max(2048).refine(value => {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.hash && !u.search && (u.href === value || u.origin === value); }
  catch { return false; }
});
const origin = z.string().max(2048).refine(value => {
  try { const u = new URL(value); return u.protocol === "https:" && u.origin === value && !u.username && !u.password; }
  catch { return false; }
});
const localPath = z.string().max(1024).refine(value => path.isAbsolute(value) && path.normalize(value) === value && !value.includes("\0"));
const listener = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("direct_tls"), host: z.enum(["127.0.0.1", "::1"]), port: z.number().int().min(1).max(65535), certificate_ref: opaque, private_key_ref: opaque }),
  z.strictObject({ kind: z.literal("proxy_uds"), socket_path: localPath, proxy_credential_ref: opaque }),
]);
const schema = z.strictObject({
  schema_version: z.literal(1), instance_id: opaque, tenant_id: opaque,
  mode: z.enum(["loopback", "private", "internet"]), internet_enabled: z.boolean(),
  origin, listener, dispatcher_socket_path: localPath, service_credential_ref: opaque,
  oidc: z.strictObject({
    issuer: endpoint, access_token_audience: z.string().min(1).max(256), client_id: z.string().min(1).max(256), client_secret_ref: opaque,
    authorization_endpoint: endpoint, token_endpoint: endpoint, jwks_endpoint: endpoint,
    introspection_endpoint: endpoint, redirect_uri: endpoint,
    algorithms: z.array(z.enum(["RS256", "ES256"])).min(1).max(2),
  }),
}).superRefine((value, ctx) => {
  const reject = () => ctx.addIssue({ code: "custom", message: "deployment_invalid" });
  if ((value.mode === "internet") !== value.internet_enabled) reject();
  if ((value.mode === "loopback") !== (value.listener.kind === "direct_tls")) reject();
  if (value.listener.kind === "direct_tls") {
    const url = new URL(value.origin);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || Number(url.port || 443) !== value.listener.port) reject();
  }
  if (value.oidc.redirect_uri !== value.origin + "/oidc/callback") reject();
  if (new Set(value.oidc.algorithms).size !== value.oidc.algorithms.length) reject();
});
export type WebPolicy = z.infer<typeof schema>;
/** Shape validation is only one readiness gate; it does not attest TLS, socket
 * ownership, provider revocation behavior, protected stores, or live credentials. */
export function parseWebPolicy(input: unknown): WebPolicy {
  try { return schema.parse(input); } catch { throw new WebBoundaryError("deployment_invalid"); }
}
