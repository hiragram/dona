import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import { assertSynchronousResult } from "../audit/synchronous.js";
import { ApprovalMetadataNodes } from "./metadata-store.js";
import { ApprovalIndexBlobs } from "./index-store.js";
import { encodeApprovalIndex, decodeApprovalIndex } from "./index-codec.js";
import type { ApprovalRecordScope } from "./record-codec.js";
import type { PreparedApprovalMetadata } from "./metadata-plan.js";
import { readMetadataValue, prepareMetadataUpdate } from "./metadata-tree.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const scopeSchema = z.strictObject({ instance_id: id, workspace_id: id });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z.strictObject({ codec_version: z.literal(1), scope: scopeSchema, expected_root: digest, proposed_root: digest,
  point_updates: z.array(z.strictObject({ key: z.string().regex(/^(index|record)_[a-f0-9]{64}$/), value: digest })).max(32)
    .refine(points => points.every((point, index) => index === 0 || points[index - 1]!.key < point.key)),
  index_wires: z.array(z.string().max(2048)).max(32) });
export class ApprovalMetadataPlanStoreError extends Error {
  constructor() { super("approval_metadata_plan_store_unverified"); this.name = "ApprovalMetadataPlanStoreError"; }
}
/** 1つの既存connectionへ全batchを保存する内部writer。独自commitや再試行はない。
 * planは同じ共有監査prepareで作り、current rootと業務rowを同時に確定する。 */
export class ApprovalMetadataPlanWriter {
  private readonly nodes: ApprovalMetadataNodes;
  private readonly indexes: ApprovalIndexBlobs;
  private readonly scope: ApprovalRecordScope;
  constructor(private readonly db: Database.Database, scope: ApprovalRecordScope) {
    try {
      assertSynchronousResult(scope); this.scope = Object.freeze(scopeSchema.parse(scope));
      this.nodes = new ApprovalMetadataNodes(db); this.indexes = new ApprovalIndexBlobs(db, this.scope);
    } catch { throw new ApprovalMetadataPlanStoreError(); }
  }
  stage(input: PreparedApprovalMetadata): undefined {
    try {
      if (!this.db.inTransaction) throw Error();
      assertSynchronousResult(input); const plan = schema.parse(input);
      if (plan.scope.instance_id !== this.scope.instance_id || plan.scope.workspace_id !== this.scope.workspace_id) throw Error();
      if ((plan.point_updates.length === 0) !== (plan.expected_root === plan.proposed_root)) throw Error();
      const pointValues = new Map(plan.point_updates.map(point => [point.key, point.value]));
      const indexes = plan.index_wires.map(wire => {
        if (Buffer.byteLength(wire) > 2048) throw Error();
        const decoded = encodeApprovalIndex(JSON.parse(wire), this.scope);
        if (decoded.wire !== wire || pointValues.get(decoded.key) !== decoded.digest) throw Error();
        return { wire, digest: decoded.digest };
      });
      if (new Set(indexes.map(index => index.digest)).size !== indexes.length) throw Error();
      // callerが渡すnode配列を保存しない。全point変更からnodeを再生成し、
      // proposed rootと一致してから保存するため、経路外nodeも欠落しない。
      const treeScope = { ...this.scope, collection: "approval_records_v1" } as const;
      const wires = this.nodes.read(reader => {
        let root = plan.expected_root; const generated = new Map<string, string>();
        const combined = (hash: string) => generated.get(hash) ?? reader(hash);
        for (const point of plan.point_updates) {
          const previous = readMetadataValue(treeScope, root, point.key, combined);
          if (previous === point.value) continue;
          const update = prepareMetadataUpdate(treeScope, root, point.key, previous, point.value, combined);
          for (const node of update.nodes) generated.set(node.digest, node.wire);
          root = update.proposed_root;
        }
        if (root !== plan.proposed_root || generated.size > 32 * 257) throw Error();
        // 変更なしの場合も、scope付きrootとpathの検証を省略しない。
        readMetadataValue(treeScope, root, "approval_plan_scope_check", combined);
        for (const point of plan.point_updates) if (readMetadataValue(treeScope, root, point.key, combined) !== point.value) throw Error();
        const retained = new Map<string, string>(), stack = [root];
        while (stack.length) {
          const hash = stack.pop()!; if (retained.has(hash)) continue;
          const wire = generated.get(hash); if (wire === undefined) continue;
          retained.set(hash, wire); const raw = Buffer.from(wire, "base64");
          if (raw.length === 131) stack.push(raw.subarray(67, 99).toString("hex"), raw.subarray(99, 131).toString("hex"));
        }
        return [...retained].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, wire]) => wire);
      });
      const supplied = new Map(indexes.map(index => [index.digest, index.wire]));
      this.indexes.read(reader => {
        for (const point of plan.point_updates) if (point.key.startsWith("index_")) {
          const wire = supplied.get(point.value) ?? reader(point.value); if (wire === undefined) throw Error();
          if (decodeApprovalIndex(wire, point.value, this.scope).key !== point.key) throw Error();
        }
        return null;
      });
      const nodes = wires.map(wire => ({ wire,
        digest: createHash("sha256").update("dona.metadata-tree-node.v1\0").update(Buffer.from(wire, "base64")).digest("hex") }));
      for (let offset = 0; offset < nodes.length; offset += 257) this.nodes.stage(nodes.slice(offset, offset + 257));
      if (indexes.length) this.indexes.stage(indexes);
      return undefined;
    } catch { throw new ApprovalMetadataPlanStoreError(); }
  }
}
