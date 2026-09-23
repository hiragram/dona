import { z } from "zod";
import { assertSynchronousCallback, assertSynchronousResult } from "../audit/synchronous.js";
import { approvalIndexKey, encodeApprovalIndex, decodeApprovalIndex, type ApprovalIndex, type ApprovalIndexIdentity } from "./index-codec.js";
import { approvalRecordKey, encodeApprovalRecord, type ApprovalRecord, type ApprovalRecordKind, type ApprovalRecordScope } from "./record-codec.js";
import { MetadataConflictError, readMetadataValue, prepareMetadataUpdate, type MetadataTreeNodeReader } from "./metadata-tree.js";
import type { ApprovalIndexBlobReader } from "./index-store.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = z.strictObject({ instance_id: id, workspace_id: id });
export class ApprovalMetadataPlanError extends Error {
  constructor() { super("approval_metadata_plan_unverified"); this.name = "ApprovalMetadataPlanError"; }
}
export interface PreparedApprovalMetadata {
  readonly codec_version: 1;
  readonly scope: ApprovalRecordScope;
  readonly expected_root: string;
  readonly proposed_root: string;
  readonly point_updates: readonly { readonly key: string; readonly value: string }[];
  readonly index_wires: readonly string[];
}
/** 共有監査prepare内の内部component。caller rootやrecordの所持は認可ではない。
 * rootは検証済みaudit resourceから渡し、SQLと全batchを同じmutationで保存する。 */
export class ApprovalMetadataPlan {
  private readonly scope: ApprovalRecordScope;
  private readonly initial: string;
  private root: string;
  private readonly nodes = new Map<string, string>();
  private readonly indexes = new Map<string, string>();
  private readonly touched = new Set<string>();
  private readonly indexValues = new Map<string, string>();
  private readonly values = new Map<string, string>();
  private changes = 0;
  private reads = 0;
  private observed = false;
  private failed = false;
  private sealed = false;
  constructor(scope: ApprovalRecordScope, root: string,
    private readonly nodeReader: MetadataTreeNodeReader, private readonly indexReader: ApprovalIndexBlobReader) {
    try {
      assertSynchronousResult(scope); this.scope = Object.freeze(scopeSchema.parse(scope));
      this.initial = this.root = digest.parse(root); assertSynchronousCallback(nodeReader); assertSynchronousCallback(indexReader);
    } catch { throw new ApprovalMetadataPlanError(); }
  }
  private guard<T>(operation: () => T): T {
    try {
      if (this.failed || this.sealed) throw new ApprovalMetadataPlanError();
      return operation();
    } catch (error) {
      this.failed = true;
      if (error instanceof MetadataConflictError) throw new MetadataConflictError();
      throw new ApprovalMetadataPlanError();
    }
  }
  private reader: MetadataTreeNodeReader = value => this.nodes.get(value) ?? this.nodeReader(value);
  private value(key: string): string | null {
    if (++this.reads > 256) throw new ApprovalMetadataPlanError();
    const result = readMetadataValue({ ...this.scope, collection: "approval_records_v1" }, this.root, key, this.reader);
    this.observed = true; return result;
  }
  private update(key: string, expected: string | null, proposed: string): void {
    if (expected !== null) digest.parse(expected); digest.parse(proposed);
    const actual = this.value(key);
    if (actual !== expected) throw new MetadataConflictError();
    if (actual === proposed) return;
    if (++this.changes > 64) throw new ApprovalMetadataPlanError();
    this.touched.add(key); if (this.touched.size > 32) throw new ApprovalMetadataPlanError();
    if (++this.reads > 256) throw new ApprovalMetadataPlanError();
    const plan = prepareMetadataUpdate({ ...this.scope, collection: "approval_records_v1" }, this.root, key, expected, proposed, this.reader);
    for (const node of plan.nodes) {
      const prior = this.nodes.get(node.digest);
      if (prior !== undefined && prior !== node.wire) throw new ApprovalMetadataPlanError();
      this.nodes.set(node.digest, node.wire);
    }
    this.root = plan.proposed_root;
    this.values.set(key, proposed);
    // 同じmanifest/linkの中間versionを保存せず、最終rootから辿れる
    // 新nodeだけを保持する。既存subtreeはreaderに残し全履歴を走査しない。
    const retained = new Map<string, string>(), stack = [this.root];
    while (stack.length) {
      const hash = stack.pop()!; if (retained.has(hash)) continue;
      const wire = this.nodes.get(hash); if (wire === undefined) continue;
      retained.set(hash, wire); const raw = Buffer.from(wire, "base64");
      if (raw.length === 131) stack.push(raw.subarray(67, 99).toString("hex"), raw.subarray(99, 131).toString("hex"));
    }
    this.nodes.clear(); for (const [hash, wire] of retained) this.nodes.set(hash, wire);
    if (this.nodes.size > 32 * 257) throw new ApprovalMetadataPlanError();
  }
  readIndex(identity: ApprovalIndexIdentity): ApprovalIndex | null {
    return this.guard(() => {
      const key = approvalIndexKey(this.scope, identity), hash = this.value(key);
      if (hash === null) return null;
      let wire = this.indexes.get(hash);
      if (wire === undefined) { try { wire = this.indexReader(hash); } catch { throw new ApprovalMetadataPlanError(); } }
      if (wire === undefined) throw new ApprovalMetadataPlanError();
      const decoded = decodeApprovalIndex(wire, hash, this.scope);
      if (decoded.key !== key) throw new ApprovalMetadataPlanError();
      return decoded.index;
    });
  }
  putIndex(expected: ApprovalIndex | null, proposed: ApprovalIndex): void {
    this.guard(() => {
      const next = encodeApprovalIndex(proposed, this.scope), prior = expected === null ? null : encodeApprovalIndex(expected, this.scope);
      if (prior !== null && prior.key !== next.key) throw new ApprovalMetadataPlanError();
      // 旧blobも認証し、保存後の欠落を期待digestだけで隠さない。
      const identity: ApprovalIndexIdentity = next.index.kind === "manifest" ? { kind: "manifest", list: next.index.list }
        : next.index.kind === "link" ? { kind: "link", list: next.index.list, record_id: next.index.record_id }
          : { kind: "alias", selector: next.index.selector };
      const actual = this.readIndex(identity);
      const actualDigest = actual === null ? null : encodeApprovalIndex(actual, this.scope).digest;
      if (actualDigest !== (prior?.digest ?? null)) throw new MetadataConflictError();
      this.update(next.key, prior?.digest ?? null, next.digest);
      if (actualDigest !== next.digest) {
        const existing = this.indexes.get(next.digest);
        if (existing !== undefined && existing !== next.wire) throw new ApprovalMetadataPlanError();
        this.indexes.set(next.digest, next.wire);
        this.indexValues.set(next.key, next.digest);
        const retained = new Set(this.indexValues.values());
        for (const hash of this.indexes.keys()) if (!retained.has(hash)) this.indexes.delete(hash);
        if (this.indexes.size > 32) throw new ApprovalMetadataPlanError();
      }
    });
  }
  readRecordDigest(kind: ApprovalRecordKind, primaryKey: string): string | null {
    return this.guard(() => this.value(approvalRecordKey(this.scope, kind, primaryKey)));
  }
  putRecord(expectedDigest: string | null, proposed: ApprovalRecord): void {
    this.guard(() => {
      const record = encodeApprovalRecord(proposed, this.scope);
      this.update(record.key, expectedDigest, record.digest);
    });
  }
  /** 上位の複合操作が失敗したplanも以後確定させない。 */
  invalidate(): void { this.failed = true; }
  finish(): PreparedApprovalMetadata {
    return this.guard(() => {
      if (!this.observed) throw new ApprovalMetadataPlanError();
      if (this.changes !== 0 && this.root === this.initial) throw new ApprovalMetadataPlanError();
      const result = Object.freeze({ codec_version: 1 as const, scope: this.scope, expected_root: this.initial, proposed_root: this.root,
        point_updates: Object.freeze([...this.values].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => Object.freeze({ key, value }))),
        index_wires: Object.freeze([...this.indexes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, wire]) => wire)) });
      assertSynchronousResult(result); this.sealed = true; return result;
    });
  }
}
