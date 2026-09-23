import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { setup, scope as auditScope } from "./fixtures/storage.js";
import { installApprovalSchema, installApprovalMetadataSchema, installApprovalIndexSchema, verifyApprovalIndexSchema, ApprovalSchemaError } from "../../src/approval/schema.js";
import { ApprovalMetadataNodes } from "../../src/approval/metadata-store.js";
import { ApprovalIndexBlobs, ApprovalIndexStoreError, type ApprovalIndexBlobReader } from "../../src/approval/index-store.js";
import { encodeApprovalIndex, decodeApprovalIndex } from "../../src/approval/index-codec.js";
import { emptyMetadataRoot, prepareMetadataUpdate, readMetadataValue, MetadataConflictError } from "../../src/approval/metadata-tree.js";
import { ApprovalTransactionError } from "../../src/approval/transaction.js";
import type { AuditEvent } from "../../src/audit/codec.js";
const scope = { instance_id: auditScope.instance_id, workspace_id: auditScope.tenant_id };
const treeScope = { ...scope, collection: "approval_records_v1" } as const;
const index = encodeApprovalIndex({ codec_version: 1, scope, kind: "manifest", list: { record_kind: "request", membership: "all" }, count: 0, head: null, tail: null }, scope);
const blob = { digest: index.digest, wire: index.wire };
const event: Omit<AuditEvent, "occurred_at"> = { scope: auditScope, actor: { kind: "system", id: "fixture" }, action: "approval_request", operation: "slack.post_thread_reply.v1", resource_id: "approval_records", outcome: "succeeded", reason: "none", session_ref: null, receipt_id: null, attempt_id: null, policy_revision: 1, binding_revision: 1, authz_revision: 1 };
function fixture(t: { after(fn: () => void): void }) {
  const f = setup(t); installApprovalMetadataSchema(f.db); installApprovalIndexSchema(f.db);
  return { ...f, nodes: new ApprovalMetadataNodes(f.db), blobs: new ApprovalIndexBlobs(f.db, scope) };
}
function commit(f: ReturnType<typeof fixture>, fail = false) {
  return f.transaction.runPrepared("index_commit", (_mark, verified) => {
    assert.equal(verified.resource_bindings.some(binding => binding.resource_id === "approval_records"), false);
    // 既知の空fixture専用。既存の未認証rowを取り込むbootstrapではない。
    assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_requests").get(), { n: 0 });
    const plan = f.nodes.read(reader => prepareMetadataUpdate(treeScope, emptyMetadataRoot(treeScope), index.key, null, index.digest, reader));
    return { event, resource_digest: plan.proposed_root, mutation: () => {
      f.blobs.stage([blob]); f.nodes.stage(plan.nodes);
      if (fail) throw Error("fixture rollback"); return plan.proposed_root;
    } };
  });
}
function read(f: ReturnType<typeof fixture>): string | undefined {
  return f.audit.readVerifiedState(state => {
    const root = state.resource_bindings.find(binding => binding.resource_id === "approval_records")!.resource_digest;
    return f.nodes.read(nodes => {
      const digest = readMetadataValue(treeScope, root, index.key, nodes); assert.equal(digest, index.digest);
      return f.blobs.read(blobs => {
        const wire = blobs(digest!); if (wire === undefined) throw Error("index missing");
        assert.equal(decodeApprovalIndex(wire, digest!, scope).key, index.key); return wire;
      });
    });
  });
}
function replace(f: ReturnType<typeof setup>) {
  fs.renameSync(f.filename, f.filename + ".detached"); fs.copyFileSync(f.filename + ".detached", f.filename); fs.chmodSync(f.filename, 0o600);
}

test("index blobとMerkle nodeを同一監査commitへ結びcurrent rootから読む", t => {
  const f = fixture(t); commit(f); assert.equal(read(f), index.wire);
  assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_index_blobs").get(), { n: 1 });

  assert.equal(read(f), index.wire); verifyApprovalIndexSchema(f.db);
  // 新しい保存層instanceでも同じdurable内容を検証する。
  const reopened = new ApprovalIndexBlobs(f.db, scope);
  assert.equal(f.audit.readVerified(() => reopened.read(reader => reader(index.digest))), index.wire);
});

test("mutation失敗とanchor応答喪失でblobとnodeのcommit境界が一致する", t => {
  for (const fault of ["mutation", "reserve_after", "finalize_before", "finalize_after"] as const) {
    const f = fixture(t); if (fault !== "mutation") f.anchors.fault = fault;
    assert.throws(() => commit(f, fault === "mutation"), ApprovalTransactionError);
    const committed = fault.startsWith("finalize");
    assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_index_blobs").get(), { n: committed ? 1 : 0 });
    assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_metadata_nodes").get(), { n: committed ? 257 : 0 });
    assert.deepEqual(f.anchors.calls, committed ? ["reserve", "finalize"] : ["reserve"]);
  }
});

test("保存層を読取専用phaseや失効したreaderから書き換えない", t => {
  const f = fixture(t); let leaked: ApprovalIndexBlobReader | undefined;
  assert.throws(() => f.blobs.stage([blob]), ApprovalIndexStoreError);
  assert.throws(() => f.audit.readVerified(() => f.blobs.stage([blob])));
  f.audit.readVerified(() => f.blobs.read(reader => { leaked = reader; assert.equal(reader(index.digest), undefined); return null; }));
  assert.throws(() => leaked!(index.digest), ApprovalIndexStoreError);
  assert.throws(() => f.db.transaction(() => leaked!(index.digest))(), ApprovalIndexStoreError);
  assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_index_blobs").get(), { n: 0 });
});

test("通常競合は固定messageを保ちfile identity喪失があれば優先して拒否する", t => {
  const f = fixture(t); commit(f);
  assert.throws(() => f.db.transaction(() => f.blobs.read(() => { throw Object.assign(new MetadataConflictError(), { message: "private" }); }))(),
    { name: "MetadataConflictError", message: "metadata_value_conflict" });
  for (const when of ["before", "during", "conflict"] as const) {
    const other = fixture(t); commit(other); if (when === "before") replace(other);
    assert.throws(() => other.db.transaction(() => other.blobs.read(reader => {
      const value = reader(index.digest); if (when !== "before") replace(other);
      if (when === "conflict") throw new MetadataConflictError(); return value;
    }))(), { name: "ApprovalIndexStoreError", message: "approval_index_store_unverified" });
  }
});

test("v1からの暗黙移行を拒否しv2既存nodeを保持してv3へ移行する", t => {
  const f = setup(t); assert.throws(() => installApprovalIndexSchema(f.db), ApprovalSchemaError);
  assert.deepEqual(f.db.prepare("SELECT version FROM approval_schema").get(), { version: 1 });
  installApprovalMetadataSchema(f.db);
  const nodes = new ApprovalMetadataNodes(f.db);
  const plan = prepareMetadataUpdate(treeScope, emptyMetadataRoot(treeScope), index.key, null, index.digest, () => undefined);
  f.db.transaction(() => nodes.stage(plan.nodes)).immediate();
  const before = f.db.prepare("SELECT * FROM approval_metadata_nodes ORDER BY digest").all();
  assert.throws(() => new ApprovalIndexBlobs(f.db, scope), ApprovalIndexStoreError);
  installApprovalIndexSchema(f.db); installApprovalIndexSchema(f.db); installApprovalMetadataSchema(f.db); installApprovalSchema(f.db);
  assert.deepEqual(f.db.prepare("SELECT version FROM approval_schema").get(), { version: 3 });
  assert.deepEqual(f.db.prepare("SELECT * FROM approval_metadata_nodes ORDER BY digest").all(), before);
  assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_index_blobs").get(), { n: 0 });
  const blobs = new ApprovalIndexBlobs(f.db, scope); f.db.transaction(() => blobs.stage([blob])).immediate();
  assert.equal(f.db.transaction(() => blobs.read(reader => reader(index.digest)))(), index.wire);
  assert.equal(f.db.transaction(() => nodes.read(reader => readMetadataValue(treeScope, plan.proposed_root, index.key, reader)))(), index.digest);
});

test("未知DDL・version・TEMP shadowをv3 migrationで修復しない", t => {
  for (const version of [2, 3]) for (const sql of ["CREATE TABLE approval_unknown(value TEXT)",
    "CREATE TEMP VIEW approval_index_blobs AS SELECT 'x' AS digest,'x' AS wire",
    "PRAGMA ignore_check_constraints=ON;UPDATE approval_schema SET version=99;PRAGMA ignore_check_constraints=OFF",
    ...(version === 3 ? ["DROP TRIGGER approval_index_blobs_no_delete", "ALTER TABLE approval_index_blobs ADD COLUMN extra TEXT"] : [])]) {
    const f = setup(t); installApprovalMetadataSchema(f.db); if (version === 3) installApprovalIndexSchema(f.db);
    f.db.exec(sql); const before = f.db.prepare("SELECT type,name,sql FROM main.sqlite_master ORDER BY name").all();
    assert.throws(() => installApprovalIndexSchema(f.db), ApprovalSchemaError);
    assert.throws(() => new ApprovalIndexBlobs(f.db, scope), ApprovalIndexStoreError);
    assert.deepEqual(f.db.prepare("SELECT type,name,sql FROM main.sqlite_master ORDER BY name").all(), before);
  }
});

test("移行commit直前と既存v3確認中のDB置換を成功にしない", t => {
  for (const version of [2, 3]) {
    const f = setup(t); installApprovalMetadataSchema(f.db); if (version === 3) installApprovalIndexSchema(f.db);
    const prepare = f.db.prepare.bind(f.db); let checks = 0, replaced = false;
    f.db.prepare = ((...args: Parameters<typeof f.db.prepare>) => {
      const statement = prepare(...args);
      if (args[0] === "PRAGMA main.foreign_key_check") {
        const get = statement.get.bind(statement);
        statement.get = ((...bindings: Parameters<typeof statement.get>) => {
          const value = get(...bindings);
          if (++checks === (version === 2 ? 2 : 1)) { replace(f); replaced = true; }
          return value;
        }) as typeof statement.get;
      }
      return statement;
    }) as typeof f.db.prepare;
    try { assert.throws(() => installApprovalIndexSchema(f.db), ApprovalSchemaError); } finally { f.db.prepare = prepare; }
    assert.equal(replaced, true); assert.deepEqual(f.db.prepare("SELECT version FROM approval_schema").get(), { version });
  }
});

test("blob batchをboundedに検証し重複・別scope・書換・削除を拒否する", t => {
  const f = fixture(t);
  const otherScope = { ...scope, workspace_id: "other" };
  const other = encodeApprovalIndex({ ...index.index, scope: otherScope }, otherScope);
  for (const batch of [[], Array(33).fill(blob), [blob, blob], [{ ...blob, digest: "0".repeat(64) }],
    [{ digest: other.digest, wire: other.wire }], [{ ...blob, wire: "x".repeat(2049) }], [{ ...blob, extra: "private" }]]) {
    assert.throws(() => f.db.transaction(() => f.blobs.stage(batch)).immediate(), ApprovalIndexStoreError);
    assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_index_blobs").get(), { n: 0 });
  }
  f.db.transaction(() => f.blobs.stage([blob])).immediate(); f.db.transaction(() => f.blobs.stage([blob])).immediate();
  assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_index_blobs").get(), { n: 1 });
  for (const sql of ["UPDATE approval_index_blobs SET wire=wire", "DELETE FROM approval_index_blobs", "INSERT OR REPLACE INTO approval_index_blobs SELECT digest,wire FROM approval_index_blobs"])
    assert.throws(() => f.db.exec(sql), /approval_index_blob_immutable/);
});

test("rootが参照するblobの欠落・破損・過大値を空一覧に変換しない", t => {
  for (const wire of [undefined, "{}", "x".repeat(1000000)]) {
    const f = fixture(t); commit(f);
    const trigger = wire === undefined ? "approval_index_blobs_no_delete" : "approval_index_blobs_no_update";
    const ddl = (f.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(trigger) as { sql: string }).sql;
    f.db.exec("DROP TRIGGER " + trigger + "; PRAGMA ignore_check_constraints=ON");
    if (wire === undefined) f.db.prepare("DELETE FROM approval_index_blobs WHERE digest=?").run(index.digest);
    else f.db.prepare("UPDATE approval_index_blobs SET wire=? WHERE digest=?").run(wire, index.digest);
    f.db.exec("PRAGMA ignore_check_constraints=OFF; " + ddl); verifyApprovalIndexSchema(f.db);
    assert.throws(() => read(f), { name: "AuditIntegrityError", message: "audit_integrity_unverified" });
  }
});
