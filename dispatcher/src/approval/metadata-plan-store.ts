import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import { assertSynchronousResult } from "../audit/synchronous.js";
import { ApprovalMetadataNodes } from "./metadata-store.js";
import { ApprovalIndexBlobs } from "./index-store.js";
import { encodeApprovalIndex } from "./index-codec.js";
import type { ApprovalRecordScope } from "./record-codec.js";
import type { PreparedApprovalMetadata } from "./metadata-plan.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const scopeSchema = z.strictObject({ instance_id: id, workspace_id: id });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z.strictObject({ codec_version: z.literal(1), scope: scopeSchema, expected_root: digest, proposed_root: digest,
  node_wires: z.array(z.string().max(176)).max(32 * 257), index_wires: z.array(z.string().max(2048)).max(32) });
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
      if ((plan.node_wires.length === 0) !== (plan.expected_root === plan.proposed_root)
        || (plan.node_wires.length === 0 && plan.index_wires.length !== 0)) throw Error();
      const nodes = plan.node_wires.map(wire => {
        const raw = Buffer.from(wire, "base64");
        if (![99, 131].includes(raw.length) || raw.toString("base64") !== wire) throw Error();
        return { wire, digest: createHash("sha256").update("dona.metadata-tree-node.v1\0").update(raw).digest("hex") };
      });
      if (new Set(nodes.map(node => node.digest)).size !== nodes.length) throw Error();
      const indexes = plan.index_wires.map(wire => {
        if (Buffer.byteLength(wire) > 2048) throw Error();
        const decoded = encodeApprovalIndex(JSON.parse(wire), this.scope);
        if (decoded.wire !== wire) throw Error(); return { wire, digest: decoded.digest };
      });
      if (new Set(indexes.map(index => index.digest)).size !== indexes.length) throw Error();
      if (nodes.length && !nodes.some(node => node.digest === plan.proposed_root)) throw Error();
      // 空のplanでも同じschema/file/transaction条件を確認する。
      if (nodes.length === 0) this.nodes.read(() => null);
      if (indexes.length === 0) this.indexes.read(() => null);
      for (let offset = 0; offset < nodes.length; offset += 257) this.nodes.stage(nodes.slice(offset, offset + 257));
      if (indexes.length) this.indexes.stage(indexes);
      return undefined;
    } catch { throw new ApprovalMetadataPlanStoreError(); }
  }
}
