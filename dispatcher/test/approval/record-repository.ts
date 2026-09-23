import assert from "node:assert/strict";
import { test } from "node:test";
import { setup, scope as auditScope } from "./fixtures/storage.js";
import { recordFixtures, snapshotFixture } from "./fixtures/records.js";
import { encodeApprovalSnapshot } from "../../src/approval/snapshot.js";
import { encodeApprovalRecord, type ApprovalRecord, type ApprovalRecordKind } from "../../src/approval/record-codec.js";
import { ApprovalRecordSql, ApprovalRecordSqlError, type ApprovalRecordSqlChange } from "../../src/approval/record-sql.js";
import { ApprovalRecordRepository, ApprovalRecordRepositoryError } from "../../src/approval/record-repository.js";
import { ApprovalMetadataNodes } from "../../src/approval/metadata-store.js";
import { ApprovalIndexBlobs } from "../../src/approval/index-store.js";
import { ApprovalMetadataPlan } from "../../src/approval/metadata-plan.js";
import { ApprovalMetadataPlanWriter } from "../../src/approval/metadata-plan-store.js";
import { emptyMetadataRoot } from "../../src/approval/metadata-tree.js";
import { installApprovalMetadataSchema, installApprovalIndexSchema } from "../../src/approval/schema.js";
import { ApprovalTransactionError } from "../../src/approval/transaction.js";
import type { AuditEvent } from "../../src/audit/codec.js";
import { openSecurityDatabase } from "../../src/audit/coordination.js";
const scope = { instance_id: auditScope.instance_id, workspace_id: auditScope.tenant_id };
const event: Omit<AuditEvent, "occurred_at"> = { scope: auditScope, actor: { kind: "system", id: "fixture" }, action: "approval_request", operation: "slack.post_thread_reply.v1", resource_id: "approval_records", outcome: "succeeded", reason: "none", session_ref: null, receipt_id: null, attempt_id: null, policy_revision: 1, binding_revision: 1, authz_revision: 1 };
function fixture(t: { after(fn: () => void): void }) {
  const f = setup(t); installApprovalMetadataSchema(f.db); installApprovalIndexSchema(f.db);
  f.setNow("2026-09-19T00:00:00.000Z");
  return { ...f, sql: new ApprovalRecordSql(f.db, scope), nodes: new ApprovalMetadataNodes(f.db), indexes: new ApprovalIndexBlobs(f.db, scope), writer: new ApprovalMetadataPlanWriter(f.db, scope),
    records: new ApprovalRecordRepository(f.db, f.providers.auditAnchors, f.providers.auditKeys, scope) };
}
type Fixture = ReturnType<typeof fixture>;
function records(transactionId: string): ApprovalRecord[] {
  const values = recordFixtures(), source = { ...snapshotFixture(), ...scope };
  const snapshot = encodeApprovalSnapshot(source, { ...scope, request_source: source.request_source });
  for (const record of Object.values(values)) {
    record.scope = scope;
    if ("clock_transaction_id" in record.row) record.row.clock_transaction_id = transactionId;
  }
  Object.assign(values.request.row, scope, { creation_key: snapshot.creation_key, snapshot_json: snapshot.canonical, semantic_hash: snapshot.semantic_hash,
    state: "consumed", revision: 3, consume_expires_at: "2026-09-19T00:05:00.000Z" });
  Object.assign(values.decision.row, scope, { semantic_hash: snapshot.semantic_hash, decided_at: "2026-09-19T00:00:00.000Z" });
  values.consume.row.claimed_at = "2026-09-19T00:00:00.000Z";
  Object.assign(values.execution.row, { claimed_at: "2026-09-19T00:00:00.000Z", execution_expires_at: "2026-09-19T00:00:30.000Z", payload_expires_at: "2026-09-20T00:00:00.000Z" });
  Object.assign(values.notification.row, { state: "sent", fence: 1, message_ref: "adapter_message" });
  return Object.values(values);
}
function primary(record: ApprovalRecord): string {
  switch (record.kind) {
    case "request": case "decision": case "consume": return record.row.request_id;
    case "execution": return record.row.attempt_id;
    case "notification": return record.row.notification_attempt_id;
    case "event": return record.row.event_id;
    case "presentation": return record.row.update_id;
  }
}
// 既知の空DBへ一貫したstorage fixtureを作る。brokerの認可/遷移を代行しない。
function commit(f: Fixture, transactionId: string, next: ApprovalRecord[], fault?: "sql" | "metadata") {
  f.transaction.runPrepared(transactionId, (_mark, state) => {
    const root = state.resource_bindings.find(value => value.resource_id === "approval_records")?.resource_digest;
    if (root === undefined) assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_requests").get(), { n: 0 });
    const changes: ApprovalRecordSqlChange[] = next.map(record => ({ previous: f.sql.read(record.kind, primary(record)), next: record }));
    const plan = f.nodes.read(nodes => f.indexes.read(indexes => {
      const p = new ApprovalMetadataPlan(scope, root ?? emptyMetadataRoot({ ...scope, collection: "approval_records_v1" }), nodes, indexes);
      for (const change of changes) {
        p.putRecord(change.previous === null ? null : encodeApprovalRecord(change.previous, scope).digest, change.next);
        if (change.next.kind === "decision" && change.previous === null) p.putIndex(null, { codec_version: 1, scope, kind: "alias", selector: { name: "decision_id", decision_id: change.next.row.decision_id }, target: change.next.row.request_id });
      }
      return p.finish();
    }));
    return { event, resource_digest: plan.proposed_root, mutation: () => {
      f.sql.stage(changes); if (fault === "sql") throw Error("fixture SQL fault");
      f.writer.stage(plan); if (fault === "metadata") throw Error("fixture metadata fault"); return null;
    } };
  });
}

test("7種のSQL recordをcurrent audit rootと親参照へ照合して読み出す", t => {
  const f = fixture(t), values = records("seed"); commit(f, "seed", values);
  for (const record of values) {
    assert.deepEqual(f.records.read(record.kind, primary(record)), record);
    assert.equal(f.records.read(record.kind, "missing"), null);
  }
  const read = f.records.read("request", "request")!; assert.ok(Object.isFrozen(read) && Object.isFrozen(read.row));
  f.db.close();
  const db = openSecurityDatabase(f.filename);
  try {
    db.pragma("journal_mode=WAL"); db.pragma("foreign_keys=ON"); db.pragma("synchronous=FULL");
    const reopened = new ApprovalRecordRepository(db, f.providers.auditAnchors, f.providers.auditKeys, scope);
    assert.deepEqual(reopened.read("consume", "request"), values.find(record => record.kind === "consume"));
  } finally { db.close(); }
});

test("current root欠落・別scope・SQLだけの変更・削除を空recordへfallbackしない", t => {
  const absent = fixture(t);
  assert.throws(() => absent.records.read("request", "missing"), ApprovalRecordRepositoryError);
  for (const fault of ["scope", "changed", "deleted", "added"] as const) {
    const f = fixture(t); commit(f, "seed", records("seed"));
    if (fault === "scope") {
      const other = new ApprovalRecordRepository(f.db, f.providers.auditAnchors, f.providers.auditKeys, { ...scope, workspace_id: "other" });
      assert.throws(() => other.read("notification", "notification"), ApprovalRecordRepositoryError);
    } else if (fault === "changed") {
      f.db.prepare("UPDATE approval_requests SET revision=revision+1").run();
      assert.throws(() => f.records.read("request", "request"), ApprovalRecordRepositoryError);
      assert.throws(() => f.records.read("notification", "notification"), ApprovalRecordRepositoryError);
    } else if (fault === "deleted") {
      // storage fault: DDLを元に戻してもrootにあるrowの喪失を許可しない。
      const trigger = f.db.prepare("SELECT sql FROM sqlite_master WHERE name='approval_event_no_delete'").get() as { sql: string };
      f.db.exec("DROP TRIGGER approval_event_no_delete; DELETE FROM approval_event_outbox;"); f.db.exec(trigger.sql);
      assert.throws(() => f.records.read("event", "event"), ApprovalRecordRepositoryError);
    } else {
      // primaryにroot pointがないSQL行を、読取失敗へする（decision aliasとは別）。
      // UNIQUE decisionのため既存fixture行をimmutable trigger復元付きで置換する。
      const trigger = f.db.prepare("SELECT sql FROM sqlite_master WHERE name='approval_event_no_delete'").get() as { sql: string };
      f.db.exec("DROP TRIGGER approval_event_no_delete; DELETE FROM approval_event_outbox;"); f.db.exec(trigger.sql);
      f.db.prepare("INSERT INTO approval_event_outbox VALUES ('extra','decision','dona_approval.decision.v1','pending',NULL)").run();
      assert.throws(() => f.records.read("event", "extra"), ApprovalRecordRepositoryError);
    }
  }
});

test("mutable列だけを更新しimmutable recordとSQL CASの競合を拒否する", t => {
  const f = fixture(t); commit(f, "seed", records("seed"));
  const before = f.records.read("execution", "attempt")!, next = structuredClone(before); next.row.state = "executing"; next.row.fence = 2;
  commit(f, "update", [next]); assert.deepEqual(f.records.read("execution", "attempt"), next);
  assert.throws(() => f.transaction.run("stale", event, () => f.sql.stage([{ previous: before, next }])), ApprovalTransactionError);
  assert.deepEqual(f.db.transaction(() => f.sql.read("execution", "attempt"))(), next);
  assert.throws(() => f.records.read("execution", "attempt"), ApprovalRecordRepositoryError);
  const g = fixture(t); commit(g, "seed", records("seed"));
  const decision = g.records.read("decision", "request")!, changed = structuredClone(decision); changed.row.actor_id = "other";
  assert.throws(() => g.transaction.run("immutable", event, () => g.sql.stage([{ previous: decision, next: changed }])), ApprovalTransactionError);
  assert.deepEqual(g.db.transaction(() => g.sql.read("decision", "request"))(), decision);
});

test("SQLとmetadataのどちらで失敗しても両方をrollbackしanchor応答喪失を成功にしない", t => {
  for (const fault of ["sql", "metadata", "reserve_after", "finalize_before", "finalize_after"] as const) {
    const f = fixture(t);
    if (fault !== "sql" && fault !== "metadata") f.anchors.fault = fault;
    assert.throws(() => commit(f, "seed", records("seed"), fault === "sql" || fault === "metadata" ? fault : undefined), ApprovalTransactionError);
    const committed = fault.startsWith("finalize");
    assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_requests").get(), { n: committed ? 1 : 0 });
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM approval_metadata_nodes").get() as { n: number }).n > 0, committed);
    if (fault !== "sql" && fault !== "metadata" && fault !== "finalize_after") assert.throws(() => f.records.read("request", "request"), ApprovalRecordRepositoryError);
  }
});

test("root認証済みでもconsume時刻・notification revision・presentation参照の不整合を返さない", t => {
  for (const fault of ["consume_time", "notification_revision", "presentation_revision"] as const) {
    const f = fixture(t), values = records("seed");
    if (fault === "consume_time") values.find(record => record.kind === "execution")!.row.claimed_at = "2026-09-19T00:00:01.000Z";
    if (fault === "notification_revision") values.find(record => record.kind === "notification")!.row.request_revision = 4;
    if (fault === "presentation_revision") values.find(record => record.kind === "notification")!.row.presentation_revision = 3;
    commit(f, "seed", values);
    assert.throws(() => f.records.read(fault === "consume_time" ? "consume" : fault === "notification_revision" ? "notification" : "presentation", fault === "consume_time" ? "request" : fault === "notification_revision" ? "notification" : "update"), ApprovalRecordRepositoryError);
  }
});

test("SQL projectionは過大nullable値・SQL NULL・不正kindとtransaction外アクセスを区別する", t => {
  const f = fixture(t); commit(f, "seed", records("seed"));
  assert.throws(() => f.sql.read("request", "request"), ApprovalRecordSqlError);
  assert.throws(() => f.sql.stage([]), ApprovalRecordSqlError);
  f.db.transaction(() => {
    const record = f.sql.read("execution", "attempt"); assert.equal(record?.kind, "execution");
    if (record?.kind === "execution") assert.equal(record.row.receipt_ref, null);
    assert.throws(() => f.sql.read("approval_requests;" as ApprovalRecordKind, "request"), ApprovalRecordSqlError);
    assert.throws(() => f.sql.read("request", "request' OR 1=1"), ApprovalRecordSqlError);
  })();
  f.db.prepare("UPDATE approval_execution_attempts SET receipt_ref=?").run("x".repeat(129));
  f.db.transaction(() => assert.throws(() => f.sql.read("execution", "attempt"), ApprovalRecordSqlError))();
});

test("stageは全入力を検証してから書き、同じprimaryの二重変更と古いclock参照を拒否する", t => {
  for (const fault of ["duplicate", "wrong_clock"] as const) {
    const f = fixture(t), request = records(fault === "duplicate" ? "write" : "other").find(record => record.kind === "request")!;
    const changes = [{ previous: null, next: request }]; if (fault === "duplicate") changes.push(changes[0]!);
    assert.throws(() => f.transaction.run("write", event, () => f.sql.stage(changes)), ApprovalTransactionError);
    assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_requests").get(), { n: 0 });
  }
});

test("eventのsecondary aliasもcurrent rootと実decision IDへ結び付ける", t => {
  const f = fixture(t); commit(f, "seed", records("seed"));
  f.transaction.runPrepared("bad_alias", (_mark, state) => {
    const root = state.resource_bindings.find(value => value.resource_id === "approval_records")!.resource_digest;
    const plan = f.nodes.read(nodes => f.indexes.read(indexes => {
      const p = new ApprovalMetadataPlan(scope, root, nodes, indexes);
      const alias = p.readIndex({ kind: "alias", selector: { name: "decision_id", decision_id: "decision" } });
      assert.equal(alias?.kind, "alias"); if (alias?.kind !== "alias") throw Error();
      p.putIndex(alias, { ...alias, target: "missing_request" }); return p.finish();
    }));
    return { event, resource_digest: plan.proposed_root, mutation: () => { f.writer.stage(plan); return null; } };
  });
  assert.equal(f.records.read("decision", "request")!.row.decision_id, "decision");
  assert.throws(() => f.records.read("event", "event"), ApprovalRecordRepositoryError);
});
