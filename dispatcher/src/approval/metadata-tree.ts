import { createHash } from "node:crypto";
import { z } from "zod";
import { assertSynchronousCallback, assertSynchronousResult } from "../audit/synchronous.js";

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).refine(value => !/\s/.test(value));
const scopeSchema = z.strictObject({ instance_id: identifier, workspace_id: identifier,
  collection: z.enum(["approval_records_v1", "approval_payloads_v1", "approval_clock_marks_v1"]) });
export type MetadataTreeScope = z.infer<typeof scopeSchema>;
export type MetadataTreeNodeReader = (digest: string) => string | undefined;
export interface MetadataTreeNode { readonly digest: string; readonly wire: string }
export interface MetadataTreeUpdate {
  readonly expected_root: string;
  readonly proposed_root: string;
  readonly nodes: readonly MetadataTreeNode[];
}
export class MetadataTreeError extends Error {
  constructor() { super("metadata_tree_unverified"); this.name = "MetadataTreeError"; }
}
export class MetadataConflictError extends Error {
  constructor() { super("metadata_value_conflict"); this.name = "MetadataConflictError"; }
}
const domain = Buffer.from("dona.metadata-tree-node.v1\0");
function hash(bytes: Uint8Array): Buffer { return createHash("sha256").update(domain).update(bytes).digest(); }
function scopeHash(input: unknown): Buffer {
  assertSynchronousResult(input);
  const scope = scopeSchema.parse(input);
  return createHash("sha256").update("dona.metadata-tree-scope.v1\0")
    .update(`${scope.instance_id}\0${scope.workspace_id}\0${scope.collection}`).digest();
}
function key(scope: Buffer, recordKey: string): Buffer {
  identifier.parse(recordKey);
  return createHash("sha256").update("dona.metadata-tree-key.v1\0").update(scope).update(recordKey).digest();
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
  if (typeof input !== "string" || input.length !== 64 || !/^[0-9a-f]+$/.test(input)) throw new MetadataTreeError();
  return Buffer.from(input, "hex");
}
function guarded<T>(operation: () => T): T {
  try { return operation(); } catch { throw new MetadataTreeError(); }
}

/** 明示的なgenesis作成用。共有監査のbinding欠落・未知versionを
 * この空rootへfallbackしない。scope/rootの正本は呼出側の検証済み共有監査。 */
export function emptyMetadataRoot(scopeInput: unknown): string {
  return guarded(() => empty(scopeHash(scopeInput), Buffer.alloc(32), 0).toString("hex"));
}

function walk(scopeInput: unknown, rootInput: string, recordKey: string, reader: MetadataTreeNodeReader) {
  const scope = scopeHash(scopeInput); const index = key(scope, recordKey); let current = digest(rootInput);
  assertSynchronousCallback(reader);
  const siblings: Buffer[] = [];
  for (let depth = 0; depth <= 256; depth++) {
    if (current.equals(empty(scope, index, depth))) {
      for (let rest = depth; rest < 256; rest++) siblings.push(empty(scope, sibling(index, rest), rest + 1));
      return { scope, index, siblings, value: null };
    }
    // 欠落は不在leafではなく検証不能。固定サイズnodeを最大257回読む。
    const wire = reader(current.toString("hex"));
    if (typeof wire !== "string" || wire.length > 176) throw new MetadataTreeError();
    const raw = Buffer.from(wire, "base64");
    if (raw.toString("base64") !== wire || raw.length !== (depth === 256 ? 99 : 131)
      || !hash(raw).equals(current) || !raw.subarray(0, 67).equals(header(depth === 256 ? 0x4c : 0x49, scope, index, depth))) {
      throw new MetadataTreeError();
    }
    if (depth === 256) return { scope, index, siblings, value: raw.subarray(67, 99).toString("hex") };
    const left = raw.subarray(67, 99); const right = raw.subarray(99, 131);
    const side = bit(index, depth); const otherEmpty = empty(scope, sibling(index, depth), depth + 1);
    const ownEmpty = empty(scope, index, depth + 1);
    if ((side ? right : left).equals(ownEmpty) && (side ? left : right).equals(otherEmpty)) throw new MetadataTreeError();
    siblings.push(Buffer.from(side ? left : right)); current = Buffer.from(side ? right : left);
  }
  throw new MetadataTreeError();
}

/** 個別recordの期待digestを検証する。rootは共有監査から取得し、
 * SQL一覧の完全性や現在の認可をこのpoint lookupだけで証明しない。 */
export function readMetadataValue(scope: unknown, root: string, recordKey: string, reader: MetadataTreeNodeReader): string | null {
  return guarded(() => walk(scope, root, recordKey, reader).value);
}

/** 純粋な更新案。業務recordとnodeを同じ共有監査transactionで保存し、
 * current rootとexpected valueを再検証してからcommitする。独立CASや
 * audit sequence、削除・retention権限、初期化・runtime接続は提供しない。 */
export function prepareMetadataUpdate(scopeInput: unknown, root: string, recordKey: string,
  expectedValue: string | null, proposedValue: string, reader: MetadataTreeNodeReader): MetadataTreeUpdate {
  const { path, value } = guarded(() => {
    if (expectedValue !== null) digest(expectedValue);
    const value = digest(proposedValue);
    const path = walk(scopeInput, root, recordKey, reader);
    return { path, value };
  });
  // readerや入力検証から伝播した例外を競合として扱わない。
  if (path.value !== expectedValue) throw new MetadataConflictError();
  return guarded(() => {
    if (expectedValue === proposedValue) throw new MetadataTreeError();
    const nodes: MetadataTreeNode[] = [];
    const add = (raw: Buffer): Buffer => {
      const result = hash(raw); nodes.push(Object.freeze({ digest: result.toString("hex"), wire: raw.toString("base64") })); return result;
    };
    let current = add(Buffer.concat([header(0x4c, path.scope, path.index, 256), value]));
    for (let depth = 255; depth >= 0; depth--) {
      const other = path.siblings[depth]!; const children = bit(path.index, depth) ? [other, current] : [current, other];
      current = add(Buffer.concat([header(0x49, path.scope, path.index, depth), ...children]));
    }
    return Object.freeze({ expected_root: root, proposed_root: current.toString("hex"), nodes: Object.freeze(nodes) });
  });
}
