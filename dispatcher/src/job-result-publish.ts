import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { z } from "zod";

import type { JobResultEnvelope, JobRow } from "./types.js";

/** The downstream durable writer must use this same encoded-envelope limit. */
export const jobResultEnvelopeMaxBytes = 1_048_576;
export const jobResultPublishTtlMs = 30 * 60_000;

/** Composite identity carries a persisted agent session ID of at most 512 code points. */
export function validJobResultPublishSession(session: string): boolean {
  if (!session || Buffer.byteLength(JSON.stringify(session), "utf8") > 8_192) return false;
  let parts: unknown;
  try { parts = JSON.parse(session); } catch { /* Legacy opaque identity. */ }
  if (Array.isArray(parts) && parts.length === 4 && parts.every(part => typeof part === "string")) {
    const agentSession = parts[3] as string;
    return agentSession.length > 0 && [...agentSession].length <= 512;
  }
  return [...session].length <= 512;
}

export type JobResultPublishErrorCode =
  | "invalid_request" | "payload_too_large" | "content_requires_redaction"
  | "capability_invalid" | "capability_expired" | "capability_revoked"
  | "worker_session_stale" | "job_not_publishable" | "renewal_not_due";

export class JobResultPublishError extends Error {
  constructor(readonly code: JobResultPublishErrorCode) {
    super(code);
    this.name = "JobResultPublishError";
  }
}

// These checks reject credential-shaped content, private URLs, and local paths before
// it can enter a durable Result. Errors never contain any part of the supplied value.
const sensitive = /(?:xox[a-z]-|xapp-|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|gl(?:pat|ptt|ft|rt|cbt|imt|soat|agent)-[A-Za-z0-9_-]{12,}|(?:[rs]k_(?:live|test)|whsec)_[A-Za-z0-9]{12,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|pypi-[A-Za-z0-9_-]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{8,}|-----BEGIN (?:(?:ENCRYPTED |OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----|PGP PRIVATE KEY BLOCK-----)|\b(?:token|password|secret|api[_ -]?key|access[_ -]?key|private[_ -]?key|credential|authorization)\s*[:=]|\bBearer\s+(?:[A-Za-z0-9._~-]{16,}|(?=[A-Za-z0-9._~-]{0,15}[0-9._~-])[A-Za-z0-9._~-]{8,})|file:\/\/\S+|\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s@]+@|https?:\/\/(?:(?:files|hooks)\.slack\.com|localhost|127\.0\.0\.1))/i;
const ansiEscape = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const privateJwkParameter = new Set(["d", "p", "q", "dp", "dq", "qi", "oth", "k"]);
function hasPrivateJwkFields(value: Record<string, unknown>): boolean {
  return typeof value.kty === "string" && ["RSA", "EC", "OKP", "oct"].includes(value.kty) &&
    Object.keys(value).some(key => privateJwkParameter.has(key));
}
function hasPrivateJwkText(value: string): boolean {
  for (const match of value.matchAll(/\{[^{}]{0,8192}\}/g)) {
    const scope = match[0];
    if (/(?:^|[\s,{])['"]?kty['"]?\s*:\s*['"](?:RSA|EC|OKP|oct)['"]/.test(scope) &&
      /(?:^|[\s,{])['"]?(?:d|p|q|dp|dq|qi|oth|k)['"]?\s*:/.test(scope)) return true;
  }
  const scopes: { keyType: boolean; privateParameter: boolean }[] = [];
  const inspectField = /(['"]?)(kty|d|p|q|dp|dq|qi|oth|k)\1\s*:\s*['"]?(RSA|EC|OKP|oct)?/y;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "{") {
      if (scopes.length >= 64) return true;
      scopes.push({ keyType: false, privateParameter: false });
      continue;
    }
    if (char === "}") {
      const scope = scopes.pop();
      if (scope?.keyType && scope.privateParameter) return true;
      continue;
    }
    if (scopes.length > 0 && char && /[A-Za-z']/.test(char)) {
      inspectField.lastIndex = index;
      const field = inspectField.exec(value);
      if (field && (field[2] !== "kty" || field[3] !== undefined)) {
        const scope = scopes.at(-1)!;
        if (field[2] === "kty") scope.keyType = true;
        else scope.privateParameter = true;
      }
    }
    if (char === "'") {
      index++;
      for (; index < value.length; index++) {
        if (value[index] === "\\") { index++; continue; }
        if (value[index] === "'") break;
      }
      continue;
    }
    if (char !== '"') continue;
    const start = index;
    index++;
    for (; index < value.length; index++) {
      if (value[index] === "\\") { index++; continue; }
      if (value[index] === '"') break;
    }
    if (index >= value.length || scopes.length === 0) continue;
    let key: unknown;
    try { key = JSON.parse(value.slice(start, index + 1)); } catch { continue; }
    let next = index + 1;
    while (/\s/.test(value[next] ?? "")) next++;
    if (value[next] !== ":") continue;
    const scope = scopes.at(-1)!;
    if (key === "kty") {
      next++;
      while (/\s/.test(value[next] ?? "")) next++;
      if (value[next] === '"') {
        const valueStart = next++;
        for (; next < value.length; next++) {
          if (value[next] === "\\") { next++; continue; }
          if (value[next] === '"') break;
        }
        try { scope.keyType = ["RSA", "EC", "OKP", "oct"].includes(JSON.parse(value.slice(valueStart, next + 1))); }
        catch { /* Malformed snippets remain handled by the structural validator. */ }
      }
    } else if (typeof key === "string" && privateJwkParameter.has(key)) scope.privateParameter = true;
  }
  return scopes.some(scope => scope.keyType && scope.privateParameter);
}
const localPath = /(?:^|[\s"'<>`()[\]{},:=])\/(?!\/)[^\s"'<>`]+|(?<![A-Za-z0-9._~:/-])\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+|(?<![A-Za-z0-9])~\/|[A-Za-z]:(?:\\|\/(?!\/))/iu;
function hasLocalPath(value: string): boolean {
  if (/(?:^|[\s"'<>`()[\]{},:=/\\])(?:\.ssh|\.aws|\.env(?:\.[A-Za-z0-9_-]+)?|secrets|id_(?:rsa|ed25519))(?:[\\/]|\b)/i.test(value)) return true;
  if (/(?<![A-Za-z0-9/])\/(?:Users|home|root|workspace|var|tmp|etc|opt|private|run|proc|dev|sys)(?:\/|$)/i.test(value)) return true;
  const candidate = new RegExp(localPath.source, "giu");
  for (const match of value.matchAll(candidate)) {
    const route = match[0].trimStart();
    const prefix = value.slice(0, match.index);
    const slashPosition = match.index + match[0].indexOf("/");
    if (/\/\/\[[0-9a-f:.]+\]$/i.test(value.slice(0, slashPosition))) continue;
    if (route.startsWith("/") && /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(prefix.trimEnd()) &&
      !/^\/(?:Users|home|root|workspace|var|tmp|etc|opt|private|run|proc|dev|sys)(?:\/|\b)/i.test(route) &&
      !/\/(?:\.ssh|\.aws|\.env|secrets|id_(?:rsa|ed25519))(?:\/|\b)/i.test(route)) continue;
    return true;
  }
  return false;
}
const windowsUncPath = /(?<![A-Za-z0-9:\\])\\\\[^\\\s]+\\/;
const slashAuthority = /(?<![A-Za-z0-9:/])\/\/([^/?#\s"'<>`]+)(?:[/?#][^\s"'<>`]*)?/g;
function hasPrivateSlashAuthority(value: string, forbiddenValues?: ForbiddenValueMatcher): boolean {
  for (const match of value.matchAll(slashAuthority)) {
    const host = match[1]!;
    let url: URL;
    try { url = new URL(`https:${match[0]}`); } catch { return true; }
    if ((!host.includes(".") && !host.startsWith("[")) || url.username || url.password || hasSignedQueryKey(match[0]) || hasPrivateHttpHost(url.href)) return true;
    for (const parameters of [url.searchParams, new URLSearchParams(url.hash.slice(1))]) {
      for (const [, parameterValue] of parameters) if (forbiddenValues?.contains(parameterValue)) return true;
    }
  }
  return false;
}
const slackMention = /<!(?:channel|here|everyone)(?:\|[^>]*)?>|<!subteam\^[^>]+>|<@[A-Z0-9]+(?:\|[^>]*)?>/i;
const networkUrlCandidate = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;
const schemelessUrlCandidate = /(?:^|[\s"'`(])((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d{1,5})?(?:\/|[?#])[^\s"'<>`]+)/g;
const rootRelativeUrlCandidate = /(?:^|[\s"'`(])\/(?!\/)[^\s"'<>`]+/g;
const privateHostPathCandidate = /(?:^|[^A-Za-z0-9.@:/])((?:(?:0x[0-9a-f]+|0[0-7]{8,}|\d{9,10}|(?:0x[0-9a-f]+|0[0-7]+|\d+)(?:\.(?:0x[0-9a-f]+|0[0-7]+|\d+)){1,3}|[A-Za-z0-9.-]+\.(?:internal|local|lan|home\.arpa)\.?|(?:files|hooks)\.slack\.com\.?|\[[0-9a-f:.]+\])(?::\d{1,5})?|[A-Za-z][A-Za-z0-9-]*:\d{1,5})\/[^\s"'<>`]+)/gi;
const jwtCandidate = /(?:^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{8,})\.([A-Za-z0-9_-]*)\.([A-Za-z0-9_-]{8,})(?=$|[^A-Za-z0-9_-])/g;
function hasJwt(value: string): boolean {
  for (const match of value.matchAll(jwtCandidate)) {
    const first = match[1]!;
    const starts = [0];
    // A JSON header begins with { (base64url: e...).
    // Limit secondary candidates so a hostile 1 MiB body stays bounded.
    for (let start = first.lastIndexOf("e"); start > 0 && starts.length < 17; start = first.lastIndexOf("e", start - 1)) {
      if ((first[start - 1] === "_" || first[start - 1] === "-") && first.length - start <= 1_024) starts.push(start);
    }
    for (const start of starts) {
      if (first.length - start > 1_024) continue;
      try {
        const header = JSON.parse(Buffer.from(first.slice(start), "base64url").toString("utf8"));
        if (header && typeof header === "object" && typeof header.alg === "string") return true;
      } catch { /* Other dotted identifiers are allowed. */ }
    }
  }
  return false;
}
const signedQueryKeys = new Set(["token", "sig", "signature", "x-amz-signature", "x-goog-signature", "api_key", "api-key", "access_key", "access-key", "auth"]);
function hasPrivateHttpHost(candidate: string): boolean {
  let hostname: string;
  try { hostname = new URL(candidate).hostname.toLowerCase().replace(/\.+$/, ""); }
  catch { return true; }
  if (hostname === "localhost" || hostname.endsWith(".localhost") ||
    hostname === "files.slack.com" || hostname === "hooks.slack.com") return true;
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) === 0 && (!host.includes(".") || /\.(?:internal|local|lan|home\.arpa)$/.test(host))) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    const c = Number(host.split(".")[2]);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (isIP(host) === 6) {
    const first = Number.parseInt(host.split(":")[0] || "0", 16);
    if (host === "::" || host === "::1" || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return true;
    const mapped = host.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return hasPrivateHttpHost(`http://${mapped[1]}/`);
    // Also cover compressed hexadecimal IPv4-mapped addresses.
    const hexMapped = host.match(/(?:^|:)ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/i);
    if (hexMapped) {
      const bits = (Number.parseInt(hexMapped[1]!, 16) << 16) | Number.parseInt(hexMapped[2]!, 16);
      return hasPrivateHttpHost(`http://${[(bits >>> 24) & 255, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255].join(".")}/`);
    }
  }
  return false;
}
function hasSignedQueryKey(candidate: string): boolean {
  const queryStart = candidate.indexOf("?");
  const fragmentStart = candidate.indexOf("#");
  const segments = [
    queryStart >= 0 ? candidate.slice(queryStart + 1, fragmentStart >= 0 ? fragmentStart : undefined) : "",
    fragmentStart >= 0 ? candidate.slice(fragmentStart + 1) : "",
  ];
  for (const segment of segments) for (const parameter of segment.split("&")) {
      const equal = parameter.indexOf("=");
      if (equal < 0) continue;
      try {
        const key = decodeURIComponent(parameter.slice(0, equal).replaceAll("+", " ")).toLowerCase();
        if (signedQueryKeys.has(key) || forbiddenKey(key)) return true;
      } catch { return true; }
  }
  return false;
}
function hasForbiddenUrlParameters(url: URL, forbiddenValues?: ForbiddenValueMatcher): boolean {
  for (const parameters of [url.searchParams, new URLSearchParams(url.hash.slice(1))]) {
    for (const [, parameterValue] of parameters) if (forbiddenValues?.contains(parameterValue)) return true;
  }
  return false;
}
const capabilityRun = /[A-Za-z0-9_-]{43,}/g;
const capabilityWindowLength = 43;
const capabilityHashBase = 31;
// A rolling fingerprint narrows candidates; SHA-256 still decides exact matches.
const fingerprintPower = (() => {
  let power = 1;
  for (let index = 1; index < capabilityWindowLength; index++) power = Math.imul(power, capabilityHashBase);
  return power;
})();
function fingerprint(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) hash = (Math.imul(hash, capabilityHashBase) + value.charCodeAt(index)) | 0;
  return hash;
}
function displayProjection(value: string): string {
  return value.replace(/(?<!\\)[*~`]/g, "")
    .replace(/&(?:amp|lt|gt);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">" })[entity]!)
    .normalize("NFC");
}
function containsForbiddenCapability(value: string, digests: ReadonlySet<string>, fingerprints: ReadonlySet<number>): boolean {
  for (const match of value.matchAll(capabilityRun)) {
    const run = match[0];
    let hash = fingerprint(run.slice(0, capabilityWindowLength));
    for (let index = 0; index <= run.length - capabilityWindowLength; index++) {
      if (fingerprints.has(hash) && digests.has(createHash("sha256").update(run.slice(index, index + capabilityWindowLength)).digest("hex"))) return true;
      if (index + capabilityWindowLength < run.length) {
        hash = (Math.imul(hash - Math.imul(run.charCodeAt(index), fingerprintPower), capabilityHashBase) + run.charCodeAt(index + capabilityWindowLength)) | 0;
      }
    }
  }
  return false;
}
const assignmentCandidate = /(?:\b[A-Za-z_][A-Za-z0-9_.-]*|["'][^"'\r\n]+["'])\s*[:=]/g;
const cliCredentialCandidate = /--([A-Za-z][A-Za-z0-9-]*)\s+[^\s]+/g;
function isPublicCountField(key: string, value: unknown): boolean {
  return /_count$/i.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2")) &&
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function forbiddenKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
  return /(?:^|_)(?:token|secret|password|passwd|passphrase|pwd|credential|authorization|auth|capability|cookie|session)(?:_|$)/.test(normalized) ||
    /^(?:sig|signature|x_amz_signature|x_goog_signature)$/.test(normalized) ||
    /(?:token|secret|password|passwd|passphrase|pwd|credential|authorization|auth|apikey|accesskey|accountkey|privatekey|capability|cookie|sessionid)$/.test(normalized.replaceAll("_", "")) ||
    /(?:^|_)(?:api|access|account|private)_key(?:_|$)/.test(normalized) ||
    /^(?:api_key|access_key|private_key|agent_session|pane_id|workspace_path|result_path|agent_name)$/.test(normalized) ||
    normalized.startsWith("herdr_");
}
function normalizedStructuredKey(key: string): string {
  let normalized = key.replace(ansiEscape, "").replace(/[\p{Cc}\p{Cf}]/gu, "");
  for (let depth = 0; depth < 8; depth++) {
    const decoded = normalized.replace(/\\(?:u[0-9A-Fa-f]{4}|["\\/bfnrt])/g, escaped => {
      if (escaped[1] === "u") return String.fromCharCode(Number.parseInt(escaped.slice(2), 16));
      return ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<string, string>)[escaped[1]!] ?? escaped[1]!;
    });
    let next = decoded;
    if (/%[0-9A-Fa-f]{2}/.test(next)) {
      try { next = decodeURIComponent(next); } catch { /* Invalid encodings remain literal. */ }
    }
    next = next.replace(ansiEscape, "").replace(/[\p{Cc}\p{Cf}]/gu, "");
    if (next === normalized) break;
    normalized = next;
  }
  return normalized.normalize("NFC");
}
const hasInvalidUnicode = (value: string): boolean => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);

class ForbiddenValueMatcher {
  private readonly exact = new Set<string>();
  private readonly substrings: string[] = [];
  constructor(values: readonly string[], substringShortValues: ReadonlySet<string> = new Set()) {
    const display = (value: string) => value.replace(ansiEscape, "").replace(/[\p{Cc}\p{Cf}]/gu, "").normalize("NFC");
    const normalizedShortValues = new Set([...substringShortValues].flatMap(value => [value.normalize("NFC"), display(value)]));
    for (const value of new Set(values.flatMap(item => [item.normalize("NFC"), display(item), displayProjection(display(item))]))) {
      if (!value) continue;
      if (value.length < 8 && !normalizedShortValues.has(value)) { this.exact.add(value); continue; }
      this.substrings.push(value);
    }
  }
  contains(value: string): boolean {
    value = value.normalize("NFC");
    const displayed = displayProjection(value);
    for (const candidate of [value, displayed]) {
      if (this.exact.has(candidate) || this.substrings.some(privateValue => candidate.includes(privateValue))) return true;
    }
    return false;
  }
}

function assertSafeJson(value: unknown, depth = 0, forbiddenDigests?: ReadonlySet<string>, forbiddenValues?: ForbiddenValueMatcher, forbiddenFingerprints?: ReadonlySet<number>, decodeDepth = 0): void {
  if (depth > 64) throw new JobResultPublishError("invalid_request");
  if (typeof value === "string") {
    for (const match of value.matchAll(networkUrlCandidate)) {
      let url: URL;
      try { url = new URL(match[0]); } catch { throw new JobResultPublishError("content_requires_redaction"); }
      if (url.username || url.password || hasSignedQueryKey(match[0]) || hasPrivateHttpHost(match[0])) throw new JobResultPublishError("content_requires_redaction");
      if (hasForbiddenUrlParameters(url, forbiddenValues)) throw new JobResultPublishError("content_requires_redaction");
    }
    for (const match of value.matchAll(schemelessUrlCandidate)) {
      const candidate = match[1]!;
      let url: URL;
      try { url = new URL(`https://${candidate}`); }
      catch { throw new JobResultPublishError("content_requires_redaction"); }
      if (hasSignedQueryKey(candidate) || hasForbiddenUrlParameters(url, forbiddenValues)) {
        throw new JobResultPublishError("content_requires_redaction");
      }
    }
    for (const match of value.matchAll(rootRelativeUrlCandidate)) {
      const route = match[0].trimStart();
      if (route.includes("?") || route.includes("#")) {
        if (hasForbiddenUrlParameters(new URL(route, "https://example.com"), forbiddenValues)) throw new JobResultPublishError("content_requires_redaction");
      }
    }
    for (const match of value.matchAll(privateHostPathCandidate)) {
      if (hasPrivateHttpHost(`http://${match[1]}`)) throw new JobResultPublishError("content_requires_redaction");
      if (hasForbiddenUrlParameters(new URL(`http://${match[1]}`), forbiddenValues)) throw new JobResultPublishError("content_requires_redaction");
    }
    for (const match of value.matchAll(assignmentCandidate)) {
      const rawKey = match[0].replace(/\s*[:=]$/, "");
      let key = rawKey;
      if (rawKey.startsWith('"')) {
        try { key = JSON.parse(rawKey); }
        catch { key = rawKey.replace(/\\"/g, '"').replace(/^"|"$/g, ""); }
      } else if (rawKey.startsWith("'")) key = rawKey.slice(1, -1);
      if (forbiddenKey(key)) throw new JobResultPublishError("content_requires_redaction");
    }
    for (const match of value.matchAll(cliCredentialCandidate)) {
      if (forbiddenKey(match[1]!)) throw new JobResultPublishError("content_requires_redaction");
    }
    if (forbiddenDigests && forbiddenFingerprints) {
      if (containsForbiddenCapability(value, forbiddenDigests, forbiddenFingerprints) ||
        containsForbiddenCapability(displayProjection(value), forbiddenDigests, forbiddenFingerprints)) throw new JobResultPublishError("content_requires_redaction");
    }
    if (/[\p{Cc}\p{Cf}]/u.test(value)) {
      if (value.includes("\u001b]")) throw new JobResultPublishError("content_requires_redaction");
      const stripped = value.replace(ansiEscape, "").replace(/[\p{Cc}\p{Cf}]/gu, "");
      if (stripped !== value) assertSafeJson(stripped, depth, forbiddenDigests, forbiddenValues, forbiddenFingerprints, decodeDepth);
    }
    const jsonEscape = /\\(?:u[0-9A-Fa-f]{4}|["\\/bfnrt])/g;
    if (decodeDepth < 2 && jsonEscape.test(value)) {
      jsonEscape.lastIndex = 0;
      const decodedJson = value.replace(jsonEscape, escaped => {
        if (escaped[1] === "u") return String.fromCharCode(Number.parseInt(escaped.slice(2), 16));
        return ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<string, string>)[escaped[1]!] ?? escaped[1]!;
      });
      assertSafeJson(decodedJson, depth, forbiddenDigests, forbiddenValues, forbiddenFingerprints, decodeDepth + 1);
    }
    if (decodeDepth >= 2 && /\\(?:u[0-9A-Fa-f]{4}|["\\/bfnrt])/.test(value)) throw new JobResultPublishError("content_requires_redaction");
    if (decodeDepth < 2 && value.includes("%")) {
      const decoded = value.replace(/(?:%[0-9A-Fa-f]{2})+/g, encoded => {
        try { return decodeURIComponent(encoded); }
        catch { return encoded; }
      });
      if (decoded !== value) assertSafeJson(decoded, depth, forbiddenDigests, forbiddenValues, forbiddenFingerprints, decodeDepth + 1);
    }
    if (decodeDepth >= 2 && /%[0-9A-Fa-f]{2}/.test(value)) throw new JobResultPublishError("content_requires_redaction");
    if (forbiddenValues?.contains(value)) {
      throw new JobResultPublishError("content_requires_redaction");
    }
    if (sensitive.test(value) || hasLocalPath(value) || windowsUncPath.test(value) || hasPrivateSlashAuthority(value, forbiddenValues) || slackMention.test(value) || hasPrivateJwkText(value) || hasJwt(value)) throw new JobResultPublishError("content_requires_redaction");
    if (hasInvalidUnicode(value)) throw new JobResultPublishError("invalid_request");
  } else if (Array.isArray(value)) {
    for (const item of value) assertSafeJson(item, depth + 1, forbiddenDigests, forbiddenValues, forbiddenFingerprints, decodeDepth);
  } else if (value !== null && typeof value === "object") {
    const normalizedEntries = Object.entries(value).map(([key, item]) =>
      [normalizedStructuredKey(key), typeof item === "string" ? normalizedStructuredKey(item) : item] as const);
    if (new Set(normalizedEntries.map(([key]) => key)).size !== normalizedEntries.length) throw new JobResultPublishError("content_requires_redaction");
    const normalizedObject = Object.fromEntries(normalizedEntries);
    if (hasPrivateJwkFields(normalizedObject)) throw new JobResultPublishError("content_requires_redaction");
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenKey(normalizedStructuredKey(key)) && !isPublicCountField(key, item)) throw new JobResultPublishError("content_requires_redaction");
      assertSafeJson(key, depth + 1, forbiddenDigests, forbiddenValues, forbiddenFingerprints, decodeDepth);
      assertSafeJson(item, depth + 1, forbiddenDigests, forbiddenValues, forbiddenFingerprints, decodeDepth);
    }
  } else if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new JobResultPublishError("invalid_request");
  } else if (typeof value !== "boolean" && typeof value !== "number" && value !== null) {
    throw new JobResultPublishError("invalid_request");
  }
}

function assertJsonDepth(value: unknown, depth = 0): void {
  if (depth > 64) throw new JobResultPublishError("invalid_request");
  if (Array.isArray(value)) for (const child of value) assertJsonDepth(child, depth + 1);
  else if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) assertJsonDepth(child, depth + 1);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareCodePoints(left: string, right: string): number {
  const a = left[Symbol.iterator]();
  const b = right[Symbol.iterator]();
  while (true) {
    const currentA = a.next();
    const currentB = b.next();
    if (currentA.done || currentB.done) return currentA.done ? currentB.done ? 0 : -1 : 1;
    const difference = currentA.value.codePointAt(0)! - currentB.value.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
}

const jsonValue: z.ZodType<unknown> = z.json();
const requestSchema = z.object({
  schema_version: z.literal(1),
  status: z.enum(["completed", "failed"]),
  summary: z.string().min(1).refine(value => value.replace(ansiEscape, "").replace(/[\p{Cc}\p{Cf}]/gu, "").trim().length > 0),
  output: z.object({ format: z.enum(["markdown", "text"]), text: z.string() }).strict().optional(),
  artifacts: z.array(z.record(z.string(), jsonValue)).optional(),
  actions: z.array(jsonValue).optional(),
}).strict();

export type JobResultPublishRequest = z.infer<typeof requestSchema>;
export interface ValidatedJobResultPublish {
  request: JobResultPublishRequest;
  envelope: JobResultEnvelope;
  canonicalDigest: string;
  encodedBytes: number;
  reconcileOnly: boolean;
}

export interface AuthorizedJobResultPublish extends ValidatedJobResultPublish {
  /** The durable commit must compare this fence in its Result transaction. */
  fence: { jobId: string; publishableStatuses: readonly ["dispatching", "running"]; grantGeneration: number;
    attemptCount: number; paneId: string | null; session: string };
  /** Call inside the synchronous durable transaction immediately before Result creation. */
  assertCurrentGrant: () => void;
}

export function validateJobResultPublish(input: unknown, job: Pick<JobRow, "job_id" | "status">, completedAt: string, forbiddenDigests?: ReadonlySet<string>, forbiddenValues?: readonly string[], forbiddenFingerprints?: ReadonlySet<number>, shortRuntimeValues?: ReadonlySet<string>): ValidatedJobResultPublish {
  assertJsonDepth(input);
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success || !Number.isFinite(Date.parse(completedAt)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(completedAt)) {
    throw new JobResultPublishError("invalid_request");
  }
  const matcher = forbiddenValues ? new ForbiddenValueMatcher(forbiddenValues, shortRuntimeValues) : undefined;
  // Fixed schema keys are Dispatcher-owned; inspect only worker-provided fields.
  assertSafeJson(parsed.data.summary, 0, forbiddenDigests, matcher, forbiddenFingerprints);
  if (parsed.data.output !== undefined) assertSafeJson(parsed.data.output.text, 0, forbiddenDigests, matcher, forbiddenFingerprints);
  if (parsed.data.artifacts !== undefined) assertSafeJson(parsed.data.artifacts, 0, forbiddenDigests, matcher, forbiddenFingerprints);
  if (parsed.data.actions !== undefined) assertSafeJson(parsed.data.actions, 0, forbiddenDigests, matcher, forbiddenFingerprints);
  const envelope: JobResultEnvelope = {
    schema_version: 1,
    job_id: job.job_id,
    status: parsed.data.status,
    summary: parsed.data.summary,
    ...(parsed.data.output === undefined ? {} : { output: parsed.data.output }),
    ...(parsed.data.artifacts === undefined ? {} : { artifacts: parsed.data.artifacts }),
    ...(parsed.data.actions === undefined ? {} : { actions: parsed.data.actions }),
    completed_at: completedAt,
  };
  const encodedBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  if (encodedBytes > jobResultEnvelopeMaxBytes) throw new JobResultPublishError("payload_too_large");
  // completed_at is Dispatcher-owned and deliberately excluded from request identity.
  const canonicalDigest = createHash("sha256").update(`job-result-publish:v1\n${job.job_id}\n${canonicalJson(parsed.data)}`).digest("hex");
  return { request: parsed.data, envelope, canonicalDigest, encodedBytes,
    reconcileOnly: job.status === "completed" || job.status === "failed" };
}

interface Grant {
  jobId: string;
  generation: number;
  session: string;
  attemptCount: number;
  paneId: string | null;
  agentName: string | null;
  herdrWorkspaceId: string | null;
  privateValues: readonly string[];
  runtimeValues: readonly string[];
  objective: string;
  expiresAt: number;
  monotonicDeadline: number;
  expired: boolean;
  monotonicRenewableAt: number;
  revoked: boolean;
  fingerprint: number;
}

function grantPrivateValues(job: JobRow, session: string): string[] {
  let sessionParts: unknown;
  try { sessionParts = JSON.parse(session); } catch { /* A legacy opaque session is still valid. */ }
  return [session, job.herdr_pane_id, job.herdr_workspace_id, job.agent_name,
    job.objective, job.workspace_path, job.result_path,
    ...(Array.isArray(sessionParts) && sessionParts.length === 4 ? sessionParts : [])]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}
function grantRuntimeValues(job: JobRow, session: string): string[] {
  let sessionParts: unknown;
  try { sessionParts = JSON.parse(session); } catch { /* Legacy opaque session. */ }
  return [session, job.herdr_pane_id, job.herdr_workspace_id, job.agent_name,
    ...(Array.isArray(sessionParts) && sessionParts.length === 4 ? sessionParts : [])]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

/** Process-local grants fail closed on restart. Only the private worker transport receives the raw token. */
export class JobResultPublishCapabilities {
  private readonly grants = new Map<string, Grant>();
  private readonly generations = new Map<string, number>();
  private readonly renewalKey = randomBytes(32);
  constructor(
    private readonly currentSession: (jobId: string) => string | undefined,
    private readonly now: () => number = Date.now,
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {}

  private pruneExpiredGrants(): void {
    for (const [key, grant] of this.grants) if (grant.expiresAt <= this.now() || this.monotonicNow() >= grant.monotonicDeadline) {
      grant.expired = true;
      this.grants.delete(key);
    }
    const retainedJobs = new Set([...this.grants.values()].map(grant => grant.jobId));
    for (const jobId of this.generations.keys()) if (!retainedJobs.has(jobId)) this.generations.delete(jobId);
  }

  issue(job: JobRow, session: string): { capability: string; expiresAt: string } {
    if (job.status !== "dispatching" || !validJobResultPublishSession(session) || this.currentSession(job.job_id) !== session) {
      throw new JobResultPublishError("job_not_publishable");
    }
    return this.mint(job, session);
  }

  renew(capability: string, session: string, getJob: (jobId: string) => JobRow | undefined): { capability: string; expiresAt: string } {
    if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new JobResultPublishError("capability_invalid");
    const next = createHmac("sha256", this.renewalKey).update(`renew:v1\n${capability}`).digest("base64url");
    const key = createHash("sha256").update(next).digest("hex");
    const existing = this.grants.get(key);
    if (existing) {
      const current = this.authorize(next, session, getJob);
      if (current.status !== "running") throw new JobResultPublishError("job_not_publishable");
      return { capability: next, expiresAt: new Date(existing.expiresAt).toISOString() };
    }
    const job = this.authorize(capability, session, getJob);
    if (job.status !== "running") throw new JobResultPublishError("job_not_publishable");
    this.pruneExpiredGrants();
    // The previous token remains valid until its own expiry. A lost response can
    // safely repeat the same renewal and recover the same successor token.
    const predecessor = this.grants.get(createHash("sha256").update(capability).digest("hex"));
    if (!predecessor || this.monotonicNow() < predecessor.monotonicRenewableAt) throw new JobResultPublishError("renewal_not_due");
    const expiresAt = this.now() + jobResultPublishTtlMs;
    this.grants.set(key, { jobId: job.job_id, generation: predecessor.generation, session, attemptCount: job.attempt_count,
      paneId: job.herdr_pane_id, agentName: job.agent_name, herdrWorkspaceId: job.herdr_workspace_id,
      privateValues: grantPrivateValues(job, session),
      runtimeValues: grantRuntimeValues(job, session),
      objective: job.objective,
      expiresAt, monotonicDeadline: this.monotonicNow() + jobResultPublishTtlMs, expired: false,
      monotonicRenewableAt: this.monotonicNow() + jobResultPublishTtlMs / 2,
      revoked: false, fingerprint: fingerprint(next) });
    return { capability: next, expiresAt: new Date(expiresAt).toISOString() };
  }

  private mint(job: JobRow, session: string): { capability: string; expiresAt: string } {
    this.pruneExpiredGrants();
    for (const grant of this.grants.values()) if (grant.jobId === job.job_id) grant.revoked = true;
    const generation = (this.generations.get(job.job_id) ?? 0) + 1;
    this.generations.set(job.job_id, generation);
    const capability = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + jobResultPublishTtlMs;
    this.grants.set(createHash("sha256").update(capability).digest("hex"), {
      jobId: job.job_id, generation, session, attemptCount: job.attempt_count, paneId: job.herdr_pane_id,
      agentName: job.agent_name, herdrWorkspaceId: job.herdr_workspace_id,
      privateValues: grantPrivateValues(job, session),
      runtimeValues: grantRuntimeValues(job, session),
      objective: job.objective,
      expiresAt, monotonicDeadline: this.monotonicNow() + jobResultPublishTtlMs, expired: false,
      monotonicRenewableAt: this.monotonicNow() + jobResultPublishTtlMs / 2,
      revoked: false, fingerprint: fingerprint(capability),
    });
    return { capability, expiresAt: new Date(expiresAt).toISOString() };
  }

  revokeJob(jobId: string): void {
    this.pruneExpiredGrants();
    if (![...this.grants.values()].some(grant => grant.jobId === jobId)) return;
    this.generations.set(jobId, (this.generations.get(jobId) ?? 0) + 1);
    for (const grant of this.grants.values()) if (grant.jobId === jobId) grant.revoked = true;
  }

  authorize(capability: string, session: string, getJob: (jobId: string) => JobRow | undefined): JobRow {
    if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new JobResultPublishError("capability_invalid");
    const digest = createHash("sha256").update(capability).digest("hex");
    let grant: Grant | undefined;
    for (const [key, candidate] of this.grants) {
      if (timingSafeEqual(Buffer.from(key, "hex"), Buffer.from(digest, "hex"))) grant = candidate;
    }
    if (!grant) throw new JobResultPublishError("capability_invalid");
    if (grant.revoked) throw new JobResultPublishError("capability_revoked");
    if (grant.expired || this.now() >= grant.expiresAt || this.monotonicNow() >= grant.monotonicDeadline) {
      grant.expired = true;
      throw new JobResultPublishError("capability_expired");
    }
    const job = getJob(grant.jobId);
    if (!job || job.job_id !== grant.jobId) throw new JobResultPublishError("capability_invalid");
    const terminalReconcile = (job.status === "completed" || job.status === "failed") && typeof job.result_json === "string";
    if (grant.session !== session) throw new JobResultPublishError("worker_session_stale");
    if (terminalReconcile) return job;
    if (this.currentSession(job.job_id) !== session ||
      grant.attemptCount !== job.attempt_count || grant.paneId !== job.herdr_pane_id) {
      throw new JobResultPublishError("worker_session_stale");
    }
    if (job.status !== "running" && job.status !== "dispatching") {
      throw new JobResultPublishError("job_not_publishable");
    }
    return job;
  }

  validate(capability: string, session: string, input: unknown, getJob: (jobId: string) => JobRow | undefined): AuthorizedJobResultPublish {
    const job = this.authorize(capability, session, getJob);
    const grant = this.grants.get(createHash("sha256").update(capability).digest("hex"))!;
    const forbiddenDigests = new Set([...this.grants.entries()]
      .filter(([, candidate]) => candidate.expiresAt > this.now())
      .map(([digest]) => digest));
    const forbiddenFingerprints = new Set([...this.grants.values()]
      .filter(candidate => candidate.expiresAt > this.now())
      .map(candidate => candidate.fingerprint));
    const grantIdentities = [...this.grants.values()]
      .filter(candidate => candidate.expiresAt > this.now())
      .flatMap(candidate => candidate.privateValues);
    const shortRuntimeValues = new Set([...this.grants.values()]
      .filter(candidate => candidate.expiresAt > this.now())
      .flatMap(candidate => candidate.runtimeValues)
      .map(value => value.normalize("NFC"))
      .filter(value => value.length < 8));
    for (const objective of [job.objective, ...[...this.grants.values()].map(candidate => candidate.objective)]) {
      if (objective) shortRuntimeValues.add(objective.normalize("NFC"));
    }
    const forbiddenValues = [grant.paneId, job.herdr_pane_id, job.herdr_workspace_id, job.workspace_path,
      job.result_path, job.agent_name, job.objective, grant.session, ...grantIdentities]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    return { ...validateJobResultPublish(input, job, new Date(this.now()).toISOString(), forbiddenDigests, forbiddenValues, forbiddenFingerprints, shortRuntimeValues),
      fence: { jobId: job.job_id, publishableStatuses: ["dispatching", "running"], grantGeneration: grant.generation,
        attemptCount: grant.attemptCount, paneId: grant.paneId, session: grant.session },
      assertCurrentGrant: () => {
        if (grant.revoked || this.generations.get(grant.jobId) !== grant.generation) throw new JobResultPublishError("capability_revoked");
        if (grant.expired || this.now() >= grant.expiresAt || this.monotonicNow() >= grant.monotonicDeadline) {
          grant.expired = true;
          throw new JobResultPublishError("capability_expired");
        }
      } };
  }
}
