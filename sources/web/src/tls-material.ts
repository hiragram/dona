import { createPrivateKey, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import type { WebPolicy } from "./policy.js";

export class WebTlsError extends Error {
  constructor() { super("web_tls_unavailable"); this.name = "WebTlsError"; }
}
/** Trusted protected-store adapter. References come only from fixed policy.
 * The listener never accepts a path, environment fallback or request reference. */
export interface WebTlsMaterialProvider {
  certificate(reference: string): Buffer;
  privateKey(reference: string): Buffer;
}
export interface WebTlsMaterial {
  certificate: Buffer; privateKey: Buffer;
  validAt(now: string): void;
  dispose(): void;
}
/** Single leaf certificate for direct loopback TLS. Client trust and protected
 * provider provenance are separate deployment gates, not proven by this check. */
export function readWebTlsMaterial(policy: WebPolicy, provider: WebTlsMaterialProvider, now: string): WebTlsMaterial {
  let cert: Buffer | undefined, key: Buffer | undefined;
  try {
    if (policy.mode !== "loopback" || policy.listener.kind !== "direct_tls") throw Error();
    const inputCert = provider.certificate(policy.listener.certificate_ref);
    if (!Buffer.isBuffer(inputCert) || inputCert.length < 1 || inputCert.length > 16384) throw Error();
    cert = Buffer.from(inputCert);
    const inputKey = provider.privateKey(policy.listener.private_key_ref);
    if (!Buffer.isBuffer(inputKey) || inputKey.length < 1 || inputKey.length > 8192) throw Error();
    key = Buffer.from(inputKey);
    if (!/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----\r?\n?$/.test(cert.toString("utf8"))
      || !/^-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END \1-----\r?\n?$/.test(key.toString("utf8"))) throw Error();
    const leaf = new X509Certificate(cert), privateKey = createPrivateKey(key);
    const kind = privateKey.asymmetricKeyType, details = privateKey.asymmetricKeyDetails;
    if (!(kind === "rsa" && details?.modulusLength !== undefined && details.modulusLength >= 2048 && details.modulusLength <= 4096)
      && !(kind === "ec" && ["prime256v1", "secp384r1"].includes(details?.namedCurve ?? ""))) throw Error();
    if (leaf.ca || !leaf.checkPrivateKey(privateKey) || !leaf.keyUsage?.includes("1.3.6.1.5.5.7.3.1")) throw Error();
    const hostname = new URL(policy.origin).hostname.replace(/^\[|\]$/g, "");
    if (isIP(hostname) && hostname !== policy.listener.host) throw Error();
    if (isIP(hostname) ? leaf.checkIP(hostname) === undefined : leaf.checkHost(hostname,
      { subject: "never", wildcards: false, partialWildcards: false, multiLabelWildcards: false, singleLabelSubdomains: false }) === undefined) throw Error();
    const from = Date.parse(leaf.validFrom), until = Date.parse(leaf.validTo);
    if (!Number.isFinite(from) || !Number.isFinite(until) || from >= until) throw Error();
    let last = -Infinity, failed = false;
    const validAt = (value: string) => {
      const at = Date.parse(value);
      if (failed || !Number.isFinite(at) || new Date(at).toISOString() !== value || at < last || at < from || at >= until) {
        failed = true; throw new WebTlsError();
      }
      last = at;
    };
    validAt(now);
    const ownedCert = cert, ownedKey = key;
    return { certificate: ownedCert, privateKey: ownedKey, validAt, dispose: () => { ownedCert.fill(0); ownedKey.fill(0); } };
  } catch {
    cert?.fill(0); key?.fill(0); throw new WebTlsError();
  }
}
