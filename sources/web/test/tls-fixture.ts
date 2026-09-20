import fs from "node:fs";
import net from "node:net";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { fixturePolicy } from "./fixtures.js";
import { controllerFixture } from "./auth-controller-fixture.js";
import type { WebPolicy } from "../src/policy.js";
import type { WebTlsComposition } from "../src/tls-listener.js";
export const certificate = fs.readFileSync(new URL("../../../test-fixtures/tls/loopback-fixture-cert.pem", import.meta.url));
export const privateKey = fs.readFileSync(new URL("../../../test-fixtures/tls/loopback-fixture-key.pem", import.meta.url));
export const wrongNameCertificate = fs.readFileSync(new URL("../../../test-fixtures/tls/wrong-name-fixture-cert.pem", import.meta.url));
export const tlsProvider = { certificate: (_ref: string) => certificate, privateKey: (_ref: string) => privateKey };
export async function tlsPolicy(): Promise<WebPolicy> {
  // Only the test reserves an ephemeral port, then passes its concrete number
  // to policy. The actual listener does not accept port 0 or retry bind errors.
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address(); if (!address || typeof address === "string") throw Error();
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const policy = fixturePolicy(), origin = "https://localhost:" + address.port;
  return { ...policy, origin, listener: { kind: "direct_tls", host: "127.0.0.1", port: address.port, certificate_ref: "fixture_certificate", private_key_ref: "fixture_private_key" },
    oidc: { ...policy.oidc, redirect_uri: origin + "/oidc/callback" } };
}
export function publicComposition(policy: WebPolicy): WebTlsComposition & { calls: string[]; setNow(value: string): void } {
  const local = controllerFixture(policy), calls: string[] = [];
  const fail = (name: string): never => { calls.push(name); throw new Error("synthetic unavailable"); };
  return { keys: { ...local.keys, active: local.key }, protectedNow: local.now, generation: 1, tls: tlsProvider, calls, setNow: local.setNow,
    connections: { read: { read: async () => fail("read") }, write: { mutate: async () => fail("write") },
      session: { confirm: async () => fail("session") }, oidc: { createLogin: () => fail("create_login"),
        exchange: async () => fail("exchange"), introspect: async () => fail("introspect") } } };
}
export interface TlsReply { status: number; headers: IncomingHttpHeaders; body: string }
export function request(policy: WebPolicy, target: string, method = "GET", headers: Record<string, string> = {}, body = ""): Promise<TlsReply> {
  if (policy.listener.kind !== "direct_tls") throw Error();
  return new Promise((resolve, reject) => {
    const req = https.request({ host: policy.listener.kind === "direct_tls" ? policy.listener.host : "", port: Number(new URL(policy.origin).port),
      servername: "localhost", ca: certificate, agent: false, path: target, method,
      headers: { host: new URL(policy.origin).host, ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}), ...headers } }, res => {
      const parts: Buffer[] = []; res.on("data", part => parts.push(part)); res.once("error", reject);
      res.once("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(parts).toString("utf8") }));
    });
    req.setTimeout(15000, () => req.destroy(new Error("fixture request timeout"))); req.once("error", reject); req.end(body);
  });
}
