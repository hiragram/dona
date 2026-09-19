import { createHash } from "node:crypto";
import { z } from "zod";
import { assertSynchronousCallback, assertSynchronousResult } from "../audit/synchronous.js";

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).refine(value => !/\s/.test(value));
const scopeSchema = z.strictObject({ instance_id: identifier, ledger_id: identifier,
  purpose: z.enum(["audit_anchor", "clock_mark"]) });
export type UsedTransactionScope = z.infer<typeof scopeSchema>;
export type UsedTransactionNodeReader = (digest: string) => string | undefined;
export interface UsedTransactionNode { readonly digest: string; readonly wire: string }
export interface UsedTransactionInsert {
  readonly expected_root: string;
  readonly proposed_root: string;
  readonly nodes: readonly UsedTransactionNode[];
}
export class UsedTransactionError extends Error {
  constructor() { super("used_transaction_unverified"); this.name = "UsedTransactionError"; }
}
export class TransactionAlreadyUsedError extends Error {
  constructor() { super("transaction_already_used"); this.name = "TransactionAlreadyUsedError"; }
}
const domain = Buffer.from("dona.used-transaction-node.v1\0");
function hash(bytes: Uint8Array): Buffer { return createHash("sha256").update(domain).update(bytes).digest(); }
function scopeHash(input: unknown): Buffer {
  assertSynchronousResult(input);
  const scope = scopeSchema.parse(input);
  return createHash("sha256").update("dona.used-transaction-scope.v1\0")
    .update(`${scope.instance_id}\0${scope.ledger_id}\0${scope.purpose}`).digest();
}
function key(scope: Buffer, transactionId: string): Buffer {
  identifier.parse(transactionId);
  return createHash("sha256").update("dona.used-transaction-key.v1\0").update(scope).update(transactionId).digest();
}
function prefix(index: Buffer, depth: number): Buffer {
  const bytes = Buffer.from(index); const whole = Math.floor(depth / 8); const bits = depth % 8;
  if (bits) bytes[whole] = bytes[whole]! & (0xff << (8 - bits));
  bytes.fill(0, whole + (bits ? 1 : 0)); return bytes;
}
function bit(index: Buffer, depth: number): number { return (index[Math.floor(depth / 8)]! >> (7 - depth % 8)) & 1; }
function sibling(index: Buffer, depth: number): Buffer {
  const result = prefix(index, depth + 1); result[Math.floor(depth / 8)]! ^= 1 << (7 - depth % 8); return result;
}
function header(type: number, scope: Buffer, index: Buffer, depth: number): Buffer {
  const result = Buffer.alloc(67); result[0] = type; scope.copy(result, 1); result.writeUInt16BE(depth, 33);
  prefix(index, depth).copy(result, 35); return result;
}
function empty(scope: Buffer, index: Buffer, depth: number): Buffer { return hash(header(0x45, scope, index, depth)); }
function digest(input: string): Buffer {
  if (typeof input !== "string" || input.length !== 64 || !/^[0-9a-f]+$/.test(input)) throw new UsedTransactionError();
  return Buffer.from(input, "hex");
}
function guarded<T>(operation: () => T): T {
  try { return operation(); } catch (error) {
    if (error instanceof TransactionAlreadyUsedError) throw error;
    throw new UsedTransactionError();
  }
}

/** Provisioning aid only. A missing protected head must never select this root.
 * Scope and expected root come from the authenticated protected provider, not a
 * client or the untrusted node store. This module does not provision a provider. */
export function emptyUsedTransactionRoot(scopeInput: unknown): string {
  return guarded(() => empty(scopeHash(scopeInput), Buffer.alloc(32), 0).toString("hex"));
}

function walk(scopeInput: unknown, rootInput: string, transactionId: string, reader: UsedTransactionNodeReader) {
  const scope = scopeHash(scopeInput); const index = key(scope, transactionId); let current = digest(rootInput);
  assertSynchronousCallback(reader);
  const siblings: Buffer[] = [];
  for (let depth = 0; depth <= 256; depth++) {
    if (current.equals(empty(scope, index, depth))) {
      for (let rest = depth; rest < 256; rest++) siblings.push(empty(scope, sibling(index, rest), rest + 1));
      return { scope, index, siblings, used: false };
    }
    // Missing is unverified, never an absent leaf. At most 257 fixed-size reads.
    const wire = reader(current.toString("hex"));
    if (typeof wire !== "string" || wire.length > 176) throw new UsedTransactionError();
    const raw = Buffer.from(wire, "base64");
    if (raw.toString("base64") !== wire || raw.length !== (depth === 256 ? 67 : 131)
      || !hash(raw).equals(current) || !raw.subarray(0, 67).equals(header(depth === 256 ? 0x4c : 0x49, scope, index, depth))) {
      throw new UsedTransactionError();
    }
    if (depth === 256) return { scope, index, siblings, used: true };
    const left = raw.subarray(67, 99); const right = raw.subarray(99, 131);
    const side = bit(index, depth); const otherEmpty = empty(scope, sibling(index, depth), depth + 1);
    const ownEmpty = empty(scope, index, depth + 1);
    if ((side ? right : left).equals(ownEmpty) && (side ? left : right).equals(otherEmpty)) throw new UsedTransactionError();
    siblings.push(Buffer.from(side ? left : right)); current = Buffer.from(side ? right : left);
  }
  throw new UsedTransactionError();
}

/** Verifies membership against a trusted current root without changing state.
 * The reader is an internal synchronous read-only callback, not a JS sandbox. */
export function isTransactionUsed(scope: unknown, root: string, transactionId: string, reader: UsedTransactionNodeReader): boolean {
  return guarded(() => walk(scope, root, transactionId, reader).used);
}

/** Computes immutable nodes only; it does not reserve an ID. Before any domain
 * decision, the provider must durably stage/read back these nodes and CAS the
 * expected root AND domain head together. Never retry an uncertain CAS or drop
 * used IDs at retention. No authenticated broker/storage adapter is supplied. */
export function prepareUsedTransactionInsert(scopeInput: unknown, root: string, transactionId: string,
  reader: UsedTransactionNodeReader): UsedTransactionInsert {
  return guarded(() => {
    const path = walk(scopeInput, root, transactionId, reader);
    if (path.used) throw new TransactionAlreadyUsedError();
    const nodes: UsedTransactionNode[] = [];
    const add = (raw: Buffer): Buffer => {
      const result = hash(raw); nodes.push(Object.freeze({ digest: result.toString("hex"), wire: raw.toString("base64") })); return result;
    };
    let current = add(header(0x4c, path.scope, path.index, 256));
    for (let depth = 255; depth >= 0; depth--) {
      const other = path.siblings[depth]!; const children = bit(path.index, depth) ? [other, current] : [current, other];
      current = add(Buffer.concat([header(0x49, path.scope, path.index, depth), ...children]));
    }
    return Object.freeze({ expected_root: root, proposed_root: current.toString("hex"), nodes: Object.freeze(nodes) });
  });
}
