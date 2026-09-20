import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { readWebTlsMaterial, WebTlsError } from "../src/tls-material.js";
import { fixturePolicy } from "./fixtures.js";
import { certificate, privateKey, wrongNameCertificate, tlsProvider } from "./tls-fixture.js";
const now = "2026-09-19T00:00:02.000Z";
test("TLSの固定参照・leafの鍵一致・SAN・期限を検証し所有copyだけを消去する", () => {
  const policy = fixturePolicy(), references: string[] = [], before = Buffer.from(privateKey);
  const material = readWebTlsMaterial(policy, { certificate: ref => { references.push(ref); return certificate; },
    privateKey: ref => { references.push(ref); return privateKey; } }, now);
  assert.equal(policy.listener.kind, "direct_tls");
  if (policy.listener.kind !== "direct_tls") throw Error();
  assert.deepEqual(references, [policy.listener.certificate_ref, policy.listener.private_key_ref]);
  assert.notEqual(material.privateKey, privateKey); material.validAt(now); material.dispose();
  assert.equal(material.privateKey.every(byte => byte === 0), true); assert.deepEqual(privateKey, before);
  assert.ok(certificate.includes(Buffer.from("BEGIN CERTIFICATE")));
});
test("期限外・時刻逆行・鍵不一致・SAN不一致・過大materialを固定errorで拒否する", () => {
  const policy = fixturePolicy(), wrongKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" });
  for (const value of ["2026-08-31T23:59:59.000Z", "2036-09-01T00:00:00.000Z", "invalid"]) assert.throws(() => readWebTlsMaterial(policy, tlsProvider, value), WebTlsError);
  for (const provider of [{ ...tlsProvider, privateKey: () => Buffer.from(wrongKey) }, { ...tlsProvider, certificate: () => wrongNameCertificate },
    { ...tlsProvider, certificate: () => Buffer.alloc(16385) }, { ...tlsProvider, privateKey: () => Buffer.alloc(8193) },
    { ...tlsProvider, certificate: () => Buffer.concat([certificate, certificate]) }, { ...tlsProvider, privateKey: () => { throw new Error("private path detail"); } }])
    assert.throws(() => readWebTlsMaterial(policy, provider, now), { name: "WebTlsError", message: "web_tls_unavailable" });
  const material = readWebTlsMaterial(policy, tlsProvider, now);
  assert.throws(() => material.validAt("2026-09-19T00:00:01.000Z"), WebTlsError);
  assert.throws(() => material.validAt(now), WebTlsError); material.dispose();
  if (policy.listener.kind !== "direct_tls") throw Error();
  const listener = policy.listener;
  assert.throws(() => readWebTlsMaterial({ ...policy, origin: "https://[::1]:7443", listener: { ...listener, host: "127.0.0.1" } }, tlsProvider, now), WebTlsError);
});
