import { createHmac } from "node:crypto";
import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export interface IdentityIndexKey {
  version: number; purpose: "web_identity_index"; state: "active" | "lookup_only" | "revoked";
  secret: Uint8Array;
}
export interface IdentityIndexInventory {
  /** Complete, current inventory from the protected key store, including every
   * historical version. A caller-supplied partial list is not authoritative. */
  retained_versions: readonly number[];
  active_version: number;
  keys: readonly IdentityIndexKey[];
}
export interface IdentitySubject {
  instance_id: string; tenant_id: string; issuer: string; subject: string;
}
export interface SubjectIndex { identity_index_key_version: number; subject_digest: string }
export class IdentityIndexError extends Error {
  constructor() { super("identity_index_unverified"); this.name = "IdentityIndexError"; }
}
function guarded<T>(action: () => T): T { try { return action(); } catch { throw new IdentityIndexError(); } }
function inventory(input: IdentityIndexInventory): IdentityIndexKey[] {
  const expected = z.array(version).min(1).max(1024).parse(input.retained_versions);
  version.parse(input.active_version);
  if (new Set(expected).size !== expected.length || input.keys.length !== expected.length) throw new IdentityIndexError();
  const keys = new Map<number, IdentityIndexKey>();
  for (const key of input.keys) {
    version.parse(key.version);
    if (keys.has(key.version) || !expected.includes(key.version) || key.purpose !== "web_identity_index"
      || !(key.secret instanceof Uint8Array) || key.secret.byteLength !== 32
      || key.state !== (key.version === input.active_version ? "active" : "lookup_only")) throw new IdentityIndexError();
    keys.set(key.version, key);
  }
  if (!keys.has(input.active_version)) throw new IdentityIndexError();
  return [...keys.values()].sort((a,b) => a.version-b.version);
}
function canonical(input: IdentitySubject): Buffer {
  id.parse(input.instance_id); id.parse(input.tenant_id);
  if (typeof input.issuer !== "string" || input.issuer.length > 2048 || typeof input.subject !== "string") throw new IdentityIndexError();
  const issuer = new URL(input.issuer);
  if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash
    || (issuer.href !== input.issuer && issuer.origin !== input.issuer)) throw new IdentityIndexError();
  const subject = Buffer.from(input.subject,"utf8");
  if (subject.length < 1 || subject.length > 1024 || subject.toString("utf8") !== input.subject || input.subject.includes("\0")) throw new IdentityIndexError();
  const parts: Buffer[] = [];
  for (const field of ["dona.web.identity-index", "1", input.instance_id, input.tenant_id, input.issuer, input.subject]) {
    const value = Buffer.from(field,"utf8"); const size = Buffer.alloc(4); size.writeUInt32BE(value.length);
    parts.push(size,value);
  }
  return Buffer.concat(parts);
}
/** Compute every version before looking up any row. No raw subject is retained
 * here; the durable registry must perform lookup and registration atomically. */
export function subjectLookupIndexes(subject: IdentitySubject, input: IdentityIndexInventory): SubjectIndex[] {
  return guarded(() => {
    const keys = inventory(input); const bytes = canonical(subject);
    try { return keys.map(key => ({ identity_index_key_version:key.version,
      subject_digest:createHmac("sha256",key.secret).update(String(key.version)).update("\0").update(bytes).digest("hex") })); }
    finally { bytes.fill(0); }
  });
}
export function newSubjectIndex(subject: IdentitySubject, input: IdentityIndexInventory): SubjectIndex {
  return guarded(() => {
    const indexes = subjectLookupIndexes(subject,input);
    const active = indexes.find(value => value.identity_index_key_version === input.active_version);
    if (!active) throw new IdentityIndexError(); return active;
  });
}
/** All rows must come from one verified registry snapshot restricted to the
 * candidate indexes and the same instance/tenant. This only chooses an existing
 * ID; it never allocates a principal, resets quota, or grants a browser role. */
export function matchSubjectPrincipal(candidates: readonly SubjectIndex[], rows: readonly (SubjectIndex & { principal_id: string })[]): string | null {
  return guarded(() => {
    if (!candidates.length || candidates.length > 1024 || rows.length > 1024) throw new IdentityIndexError();
    const expected = new Map<number,string>();
    for (const candidate of candidates) {
      version.parse(candidate.identity_index_key_version); digest.parse(candidate.subject_digest);
      if (expected.has(candidate.identity_index_key_version)) throw new IdentityIndexError();
      expected.set(candidate.identity_index_key_version,candidate.subject_digest);
    }
    const principals = new Set<string>(); const seen = new Set<number>();
    for (const row of rows) {
      id.parse(row.principal_id); version.parse(row.identity_index_key_version); digest.parse(row.subject_digest);
      if (seen.has(row.identity_index_key_version) || expected.get(row.identity_index_key_version) !== row.subject_digest) throw new IdentityIndexError();
      seen.add(row.identity_index_key_version); principals.add(row.principal_id);
    }
    if (principals.size > 1) throw new IdentityIndexError();
    return principals.values().next().value ?? null;
  });
}
