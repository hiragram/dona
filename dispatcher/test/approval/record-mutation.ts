import assert from "node:assert/strict";
import { test } from "node:test";
import { setup, scope as auditScope } from "../web/fixtures.js";
import { recordFixtures, snapshotFixture } from "./fixtures/records.js";
import { encodeApprovalSnapshot } from "../../src/approval/snapshot.js";
import type { ApprovalRecord, ApprovalRecordKind } from "../../src/approval/record-codec.js";
import { ApprovalRecordSql, type ApprovalRecordSqlChange } from "../../src/approval/record-sql.js";
import { ApprovalRecordRepository, ApprovalRecordRepositoryError } from "../../src/approval/record-repository.js";
import { ApprovalRecordMutation } from "../../src/approval/record-mutation.js";
import { ApprovalMetadataNodes } from "../../src/approval/metadata-store.js";
import { ApprovalIndexBlobs } from "../../src/approval/index-store.js";
import { ApprovalMetadataPlan } from "../../src/approval/metadata-plan.js";
import { ApprovalMetadataPlanWriter } from "../../src/approval/metadata-plan-store.js";
import { emptyMetadataRoot } from "../../src/approval/metadata-tree.js";
import { readApprovalListHead, appendApprovalList } from "../../src/approval/index-list.js";
import { approvalRecordAliases } from "../../src/approval/record-indexes.js";
import { withMutationSqlGuard } from "../../src/audit/file-identity.js";
import { openSecurityDatabase } from "../../src/audit/coordination.js";
import { installApprovalMetadataSchema, installApprovalIndexSchema } from "../../src/approval/schema.js";
import { ApprovalTransactionError } from "../../src/approval/transaction.js";
import type { AuditEvent } from "../../src/audit/codec.js";
const scope = { instance_id: auditScope.instance_id, workspace_id: auditScope.tenant_id };
const start = "2026-09-19T00:00:00.000Z";
const event: Omit<AuditEvent, "occurred_at"> = { scope: auditScope, actor: { kind: "system", id: "fixture" }, action: "approval_request", operation: "slack.post_thread_reply.v1", resource_id: "fixture_operation", outcome: "succeeded", reason: "none", session_ref: null, receipt_id: null, attempt_id: null, policy_revision: 1, binding_revision: 1, authz_revision: 1 };
const kinds: ApprovalRecordKind[] = ["request", "decision", "consume", "execution", "notification", "event", "presentation"];
function fixture(t: { after(fn: () => void): void }, initialize = true) {
  const f = setup(t); installApprovalMetadataSchema(f.db); installApprovalIndexSchema(f.db); f.setNow(start);
  const nodes = new ApprovalMetadataNodes(f.db), indexes = new ApprovalIndexBlobs(f.db, scope), writer = new ApprovalMetadataPlanWriter(f.db, scope);
  if (initialize) f.transaction.runPrepared("fixture_records_init", (_mark, state) => {
    assert.equal(state.resource_bindings.find(value => value.resource_id === "approval_records"), undefined);
    assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_requests").get(), { n: 0 });
    const metadata = nodes.read(nodeReader => indexes.read(indexReader => {
      const plan = new ApprovalMetadataPlan(scope, emptyMetadataRoot({ ...scope, collection: "approval_records_v1" }), nodeReader, indexReader);
      for (const record_kind of kinds) for (const membership of ["all", "active"] as const) {
        if (membership === "active" && ["decision", "consume"].includes(record_kind)) continue;
        plan.putIndex(null, { codec_version: 1, scope, kind: "manifest", list: { record_kind, membership }, count: 0, head: null, tail: null });
      }
      return plan.finish();
    }));
    return { event: { ...event, resource_id: "approval_records" }, resource_digest: metadata.proposed_root, mutation: () => { writer.stage(metadata); return null; } };
  });
  return { ...f, nodes, indexes, writer, sql: new ApprovalRecordSql(f.db, scope), mutation: new ApprovalRecordMutation(f.db, scope), records: new ApprovalRecordRepository(f.db, f.providers.auditAnchors, f.providers.auditKeys, scope) };
}
type Fixture = ReturnType<typeof fixture>;
function values(transactionId: string) {
  const records = recordFixtures(), source = { ...snapshotFixture(), ...scope };
  const snapshot = encodeApprovalSnapshot(source, { ...scope, request_source: source.request_source });
  for (const record of Object.values(records)) { record.scope = scope; if ("clock_transaction_id" in record.row) record.row.clock_transaction_id = transactionId; }
  Object.assign(records.request.row, scope, { snapshot_json: snapshot.canonical, creation_key: snapshot.creation_key, semantic_hash: snapshot.semantic_hash, state: "delivery_pending" });
  Object.assign(records.decision.row, scope, { semantic_hash: snapshot.semantic_hash });
  return records;
}
function create(f: Fixture) {
  const records = values("create"), notice = structuredClone(records.notification);
  notice.row.notification_attempt_id = "notice"; notice.row.kind = "pending_notice";
  commit(f, "create", [records.request, records.notification, notice].map(next => ({ previous: null, next })));
}
function commit(f: Fixture, transactionId: string, changes: readonly ApprovalRecordSqlChange[]) {
  return f.transaction.runPrepared(transactionId, (mark, state) => ({ event, ...f.mutation.prepare(mark, state, changes) }));
}
function list(f: Fixture, record_kind: ApprovalRecordKind, membership: "all" | "active") {
  return f.audit.readVerifiedState(state => f.nodes.read(nodes => f.indexes.read(indexes => {
    const root = state.resource_bindings.find(value => value.resource_id === "approval_records")!.resource_digest;
    return readApprovalListHead(new ApprovalMetadataPlan(scope, root, nodes, indexes), { record_kind, membership }, 32);
  })));
}
function deliver(f: Fixture) {
  const notifications = ["notification", "notice"].map(id => f.records.read("notification", id)!);
  const dispatch = notifications.map(previous => ({ previous, next: { ...previous, row: { ...previous.row, state: "dispatching" as const, fence: 1 } } }));
  commit(f, "dispatch", dispatch);
  const request = f.records.read("request", "request")!;
  commit(f, "sent", [
    ...dispatch.map(change => ({ previous: change.next, next: { ...change.next, row: { ...change.next.row, state: "sent" as const, message_ref: "message_" + change.next.row.notification_attempt_id } } })),
    { previous: request, next: { ...request, row: { ...request.row, state: "sent", revision: 2 } } },
  ]);
}

test("requestと2種notificationのrecord・alias・all/activeを1監査commitで保存する", t => {
  const f = fixture(t); assert.equal(f.store.initialize("fixture_web").status, "succeeded"); create(f);
  assert.equal(f.records.read("request", "request")!.row.state, "delivery_pending");
  assert.deepEqual(list(f, "request", "all").ids, ["request"]); assert.deepEqual(list(f, "request", "active").ids, ["request"]);
  assert.deepEqual(list(f, "notification", "all").ids, ["notification", "notice"]);
  assert.equal(list(f, "notification", "active").count, 2);
  const bindings = f.audit.readVerifiedState(state => state.resource_bindings);
  assert.ok(bindings.find(value => value.resource_id === "web_auth_state"));
  assert.ok(bindings.find(value => value.resource_id === "approval_records"));
  assert.equal(bindings.find(value => value.resource_id === "fixture_operation"), undefined);
});

test("配送・decision/event・consume/attemptを異なるrecordとして更新し履歴を保持する", t => {
  const f = fixture(t); create(f); deliver(f);
  assert.equal(list(f, "notification", "active").count, 0); assert.equal(list(f, "notification", "all").count, 2);
  f.setNow("2026-09-19T00:01:00.000Z");
  const request = f.records.read("request", "request")!, data = values("approve"); data.decision.row.decided_at = "2026-09-19T00:01:00.000Z";
  commit(f, "approve", [{ previous: request, next: { ...request, row: { ...request.row, state: "approved", revision: 3, consume_expires_at: "2026-09-19T00:06:00.000Z" } } },
    { previous: null, next: data.event }, { previous: null, next: data.decision }]);
  assert.equal(f.records.read("event", "event")!.row.state, "pending"); assert.equal(list(f, "event", "active").count, 1);
  f.setNow("2026-09-19T00:02:00.000Z"); const approved = f.records.read("request", "request")!, consume = values("consume");
  consume.consume.row.claimed_at = "2026-09-19T00:02:00.000Z";
  Object.assign(consume.execution.row, { claimed_at: "2026-09-19T00:02:00.000Z", execution_expires_at: "2026-09-19T00:02:30.000Z", payload_expires_at: "2026-09-19T00:03:00.000Z" });
  commit(f, "consume", [{ previous: null, next: consume.execution }, { previous: approved, next: { ...approved, row: { ...approved.row, state: "consumed", revision: 4 } } }, { previous: null, next: consume.consume }]);
  assert.equal(f.records.read("execution", "attempt")!.row.state, "claimed");
  assert.equal(list(f, "request", "active").count, 0); assert.equal(list(f, "request", "all").count, 1);
  assert.equal(list(f, "decision", "all").count, 1); assert.equal(list(f, "consume", "all").count, 1); assert.equal(list(f, "execution", "active").count, 1);
  for(const kind of ["request","decision","consume","execution","notification","event"] as const){
    const primary=kind==="execution"?"attempt":kind==="notification"?"notification":kind==="event"?"event":"request";
    const record=f.records.read(kind,primary)!;
    for(const selector of approvalRecordAliases(record))assert.deepEqual(f.records.readAlias(selector),record);
    assert.ok(f.records.readListHead({record_kind:kind,membership:"all"},4).records.some(value=>JSON.stringify(value)===JSON.stringify(record)));
  }
});

test("stale SQL・illegal transition・clock不一致・欠落rootをreserve前に拒否する", t => {
  for (const fault of ["stale", "transition", "clock", "root"] as const) {
    const f = fixture(t, fault !== "root"); if (fault !== "root") create(f);
    const count = f.anchors.calls.length;
    if (fault === "root") assert.throws(() => commit(f, "bad", [{ previous: null, next: values("bad").request }]), ApprovalTransactionError);
    if (fault === "clock") {
      const record = values("other").presentation; record.row.notification_attempt_id = "notification";
      assert.throws(() => commit(f, "bad", [{ previous: null, next: record }]), ApprovalTransactionError);
    }
    if (fault === "stale") {
      const record = f.records.read("request", "request")!, previous = structuredClone(record); previous.row.revision = 2;
      assert.throws(() => commit(f, "bad", [{ previous, next: { ...record, row: { ...record.row, revision: 3 } } }]), ApprovalTransactionError);
    }
    if (fault === "transition") {
      const record = f.records.read("notification", "notification")!;
      assert.throws(() => commit(f, "bad", [{ previous: record, next: { ...record, row: { ...record.row, state: "sent", fence: 1, message_ref: "message" } } }]), ApprovalTransactionError);
    }
    assert.equal(f.anchors.calls.length, count); assert.equal(f.anchors.value.pending_transaction_id, null);
  }
});

test("SQL保存後のmetadata障害とanchor応答喪失で部分成功を公開しない", t => {
  for (const fault of ["metadata", "reserve_after", "finalize_before", "finalize_after"] as const) {
    const f = fixture(t);
    if (fault === "metadata") {
      const prepare = f.db.prepare.bind(f.db);
      f.db.prepare = ((...args: Parameters<typeof f.db.prepare>) => {
        if (args[0].startsWith("INSERT INTO main.approval_metadata_nodes")) {
          assert.deepEqual(prepare("SELECT count(*) AS n FROM approval_requests").get(), { n: 1 }); throw Error("fixture metadata failure");
        }
        return prepare(...args);
      }) as typeof f.db.prepare;
    } else f.anchors.fault = fault;
    assert.throws(() => create(f), ApprovalTransactionError);
    const committed = fault.startsWith("finalize");
    assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_requests").get(), { n: committed ? 1 : 0 });
    if (fault !== "finalize_after") assert.throws(() => f.records.read("request", "request"), ApprovalRecordRepositoryError);
  }
});

test("prepared mutationは一致する保護clock transaction内でだけ実行できる", t => {
  for(const mode of ["plain","unclocked","outside","different"] as const){
    const f = fixture(t); let captured: ReturnType<ApprovalRecordMutation["prepare"]> | undefined;
    f.transaction.runPrepared("prepare_only", (mark, state) => {
      captured = f.mutation.prepare(mark, state, [{ previous: null, next: values("prepare_only").request }]);
      return { event, resource_digest: null, mutation: () => null };
    });
    assert.ok(captured);
    if(mode==="plain") assert.throws(()=>f.db.transaction(()=>captured!.mutation())());
    else if(mode==="unclocked") assert.throws(()=>f.db.transaction(()=>withMutationSqlGuard(f.db,()=>captured!.mutation()))());
    else if(mode==="outside") assert.throws(()=>captured!.mutation());
    else assert.throws(() => f.transaction.runPrepared("later", () => ({ event, ...captured! })), ApprovalTransactionError);
    assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM approval_requests").get(), { n: 0 });
  }
});

test("presentation message fenceを解放してから引継ぎacceptance unknown中の後続writeを拒否する", t => {
  const f = fixture(t); create(f); deliver(f);
  const first = values("updates").presentation; first.row.message_ref = "message_notification";
  const second = structuredClone(first); second.row.update_id = "update_2"; second.row.desired_revision = 3;
  commit(f, "updates", [{ previous: null, next: first }, { previous: null, next: second }]);
  const claimed = { ...first, row: { ...first.row, state: "dispatching" as const, fence: 1 } };
  commit(f, "claim_first", [{ previous: first, next: claimed }]);
  assert.deepEqual(f.records.readAlias({name:"presentation_revision",notification_attempt_id:"notification",desired_revision:2}),claimed);
  assert.deepEqual(f.records.readAlias({name:"presentation_active_message",message_ref:"message_notification"}),claimed);
  const nextClaim = { ...second, row: { ...second.row, state: "dispatching" as const, fence: 1 } };
  const settled = { ...claimed, row: { ...claimed.row, state: "succeeded" as const } };
  // SQL unique indexもmetadata aliasも、release前にacquireする入力順を正規化する。
  commit(f, "handover", [{ previous: second, next: nextClaim }, { previous: claimed, next: settled }]);
  assert.equal(f.records.read("presentation", "update")!.row.state, "succeeded");
  assert.equal(f.records.read("presentation", "update_2")!.row.state, "dispatching");
  assert.deepEqual(list(f, "presentation", "active").ids, ["update_2"]);
  const unknown = { ...nextClaim, row: { ...nextClaim.row, state: "acceptance_unknown" as const } };
  commit(f, "unknown", [{ previous: nextClaim, next: unknown }]);
  assert.deepEqual(f.records.readAlias({name:"presentation_active_message",message_ref:"message_notification"}),unknown);
  assert.deepEqual(f.records.readListHead({record_kind:"presentation",membership:"all"},4).records,[settled,unknown]);
  const third = structuredClone(second); third.row.update_id = "update_3"; third.row.desired_revision = 4; third.row.clock_transaction_id = "third";
  commit(f, "third", [{ previous: null, next: third }]);
  const calls = f.anchors.calls.length;
  assert.throws(() => commit(f, "blocked_write", [{ previous: third, next: { ...third, row: { ...third.row, state: "dispatching", fence: 1 } } }]), ApprovalTransactionError);
  assert.equal(f.anchors.calls.length, calls);
  assert.equal(f.records.read("presentation", "update_3")!.row.state, "pending");
  assert.equal(f.records.read("presentation", "update_2")!.row.state, "acceptance_unknown");
  commit(f,"release_unknown",[{previous:unknown,next:{...unknown,row:{...unknown.row,state:"needs_review"}}}]);
  assert.equal(f.records.readAlias({name:"presentation_active_message",message_ref:"message_notification"}),null);
});

test("message holderの不在はnull tombstoneと未登録aliasの両方でSQLへ照合する", t => {
  for (const state of ["dispatching", "acceptance_unknown"] as const) for (const absent of [false, true]) {
    const f = fixture(t); create(f); deliver(f);
    const first = values("updates").presentation; first.row.message_ref = "message_notification";
    const selector = { name: "presentation_active_message" as const, message_ref: first.row.message_ref };
    commit(f, "updates", [{ previous: null, next: first }]);
    assert.equal(f.records.readAlias(selector), null);
    assert.equal(f.records.readAlias({ ...selector, message_ref: "unused_message" }), null);
    assert.throws(() => f.sql.assertNoPresentationHolder(selector.message_ref));
    if (absent) {
      // 未登録aliasに対し、SQLだけが進んだ不整合を作る。
      f.db.prepare("UPDATE approval_presentation_updates SET state='dispatching',fence=1 WHERE update_id='update'").run();
      if (state === "acceptance_unknown") f.db.prepare("UPDATE approval_presentation_updates SET state='acceptance_unknown' WHERE update_id='update'").run();
    } else {
      const claimed = { ...first, row: { ...first.row, state: "dispatching" as const, fence: 1 } };
      commit(f, "claim", [{ previous: first, next: claimed }]);
      if (state === "acceptance_unknown") commit(f, "unknown", [{ previous: claimed, next: { ...claimed, row: { ...claimed.row, state } } }]);
      f.transaction.runPrepared("inconsistent_tombstone", (_mark, current) => {
        const metadata = f.nodes.read(nodes => f.indexes.read(indexes => {
          const root = current.resource_bindings.find(value => value.resource_id === "approval_records")!.resource_digest;
          const plan = new ApprovalMetadataPlan(scope, root, nodes, indexes);
          const previous = plan.readIndex({ kind: "alias", selector });
          plan.putIndex(previous, { codec_version: 1, scope, kind: "alias", selector, target: null });
          return plan.finish();
        }));
        return { event: { ...event, resource_id: "approval_records" }, resource_digest: metadata.proposed_root, mutation: () => { f.writer.stage(metadata); return null; } };
      });
    }
    assert.throws(() => f.records.readAlias(selector), ApprovalRecordRepositoryError);
  }
});

test("履歴presentationも引継ぎ先holderとその全indexを検証する", t => {
  for (const fault of ["absent", "null", "missing", "terminal", "pending", "other_message", "holder_index"]) {
    const f = fixture(t); create(f); deliver(f);
    const first = values("updates").presentation; first.row.message_ref = "message_notification";
    const second = structuredClone(first); second.row.update_id = "second"; second.row.desired_revision = 3;
    const third = structuredClone(first); third.row.update_id = "third"; third.row.desired_revision = 4;
    const other = structuredClone(first); other.row.update_id = "other"; other.row.notification_attempt_id = "notice"; other.row.message_ref = "message_notice";
    commit(f, "updates", [first, second, third, other].map(next => ({ previous: null, next })));
    commit(f, "abort", [{ previous: first, next: { ...first, row: { ...first.row, state: "aborted" } } }]);
    const revision = { name: "presentation_revision" as const, notification_attempt_id: "notification", desired_revision: 2 };
    if (fault === "absent") {
      f.db.prepare("UPDATE approval_presentation_updates SET state='dispatching',fence=1 WHERE update_id='second'").run();
    } else {
      commit(f, "claims", [second, other].map(previous => ({ previous, next: { ...previous, row: { ...previous.row, state: "dispatching" as const, fence: 1 } } })));
      const byRevision = f.records.readAlias(revision), byList = f.records.readListHead({ record_kind: "presentation", membership: "all" }, 1).records[0];
      assert.ok(byRevision?.kind === "presentation" && byList?.kind === "presentation");
      assert.equal(byRevision.row.state, "aborted"); assert.equal(byList.row.state, "aborted");
      f.transaction.runPrepared("inconsistent_holder", (_mark, current) => {
        const metadata = f.nodes.read(nodes => f.indexes.read(indexes => {
          const root = current.resource_bindings.find(value => value.resource_id === "approval_records")!.resource_digest;
          const plan = new ApprovalMetadataPlan(scope, root, nodes, indexes);
          const selector = fault === "holder_index" ? { ...revision, desired_revision: 3 }
            : { name: "presentation_active_message" as const, message_ref: "message_notification" };
          const previous = plan.readIndex({ kind: "alias", selector });
          const target = fault === "null" ? null : fault === "missing" ? "missing" : fault === "terminal" || fault === "holder_index" ? "update" : fault === "pending" ? "third" : "other";
          plan.putIndex(previous, { codec_version: 1, scope, kind: "alias", selector, target });
          return plan.finish();
        }));
        return { event: { ...event, resource_id: "approval_records" }, resource_digest: metadata.proposed_root, mutation: () => { f.writer.stage(metadata); return null; } };
      });
    }
    assert.throws(() => f.records.readAlias(revision), ApprovalRecordRepositoryError);
    assert.throws(() => f.records.readListHead({ record_kind: "presentation", membership: "all" }, 1), ApprovalRecordRepositoryError);
  }
});

test("内部一覧は4件上限とtruncatedを保持し再open後も同じrootから読む",t=>{
  const f=fixture(t);assert.deepEqual(f.records.readListHead({record_kind:"request",membership:"active"},4),{count:0,records:[],truncated:false});
  for(let i=0;i<5;i++){
    const transactionId="request_"+i,record=values(transactionId).request;
    const source={...snapshotFixture(),...scope};source.request_source.source_event_id="event_"+i;
    const encoded=encodeApprovalSnapshot(source,{...scope,request_source:source.request_source});
    Object.assign(record.row,{request_id:transactionId,creation_key:encoded.creation_key,snapshot_json:encoded.canonical,semantic_hash:encoded.semantic_hash});
    commit(f,transactionId,[{previous:null,next:record}]);
  }
  const sequence=f.audit.verify().sequence,result=f.records.readListHead({record_kind:"request",membership:"active"},4);
  assert.equal(result.count,5);assert.equal(result.records.length,4);assert.equal(result.truncated,true);
  assert.deepEqual(result.records.map(row=>row.kind==="request"?row.row.request_id:null),["request_0","request_1","request_2","request_3"]);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.records) && result.records.every(row=>Object.isFrozen(row)&&Object.isFrozen(row.row)));
  for(const limit of [0,5,NaN,1.5])assert.throws(()=>f.records.readListHead({record_kind:"request",membership:"all"},limit),ApprovalRecordRepositoryError);
  assert.throws(()=>f.records.readListHead({record_kind:"decision",membership:"active"},1),ApprovalRecordRepositoryError);
  assert.equal(f.records.readAlias({name:"decision_id",decision_id:"missing"}),null);assert.equal(f.audit.verify().sequence,sequence);
  assert.throws(()=>f.records.readAlias({name:"__proto__"} as never),ApprovalRecordRepositoryError);
  assert.throws(()=>f.records.readAlias({name:"decision_id",decision_id:"missing",root:"0".repeat(64)} as never),ApprovalRecordRepositoryError);
  const other=new ApprovalRecordRepository(f.db,f.providers.auditAnchors,f.providers.auditKeys,{...scope,workspace_id:"other"});
  assert.throws(()=>other.readAlias({name:"decision_id",decision_id:"missing"}),ApprovalRecordRepositoryError);
  assert.throws(()=>other.readListHead({record_kind:"request",membership:"all"},1),ApprovalRecordRepositoryError);
  f.db.close();const db=openSecurityDatabase(f.filename);
  try{
    db.pragma("foreign_keys=ON");db.pragma("synchronous=FULL");
    const reopened=new ApprovalRecordRepository(db,f.providers.auditAnchors,f.providers.auditKeys,scope);
    assert.deepEqual(reopened.readListHead({record_kind:"request",membership:"active"},4),result);
  }finally{db.close();}
});

test("aliasと一覧でもSQLやparentの改変・pending anchorを空結果へ変換しない",t=>{
  for(const fault of ["sql","parent","pending"]){
    const f=fixture(t);create(f);deliver(f);
    if(fault==="sql")f.db.prepare("UPDATE approval_notifications SET fence=fence+1").run();
    if(fault==="parent")f.db.prepare("UPDATE approval_requests SET revision=revision+1").run();
    if(fault==="pending")f.anchors.value={...f.anchors.value,pending_transaction_id:"unknown"};
    assert.throws(()=>f.records.readAlias({name:"notification_message",message_ref:"message_notification"}),ApprovalRecordRepositoryError);
    assert.throws(()=>f.records.readListHead({record_kind:"notification",membership:"all"},4),ApprovalRecordRepositoryError);
  }
  const f=fixture(t,false);
  assert.throws(()=>f.records.readAlias({name:"decision_id",decision_id:"missing"}),ApprovalRecordRepositoryError);
  assert.throws(()=>f.records.readListHead({record_kind:"request",membership:"all"},1),ApprovalRecordRepositoryError);
});

test("署名済みmetadataでもaliasの別record割当とterminalのactive混入を拒否する",t=>{
  for(const fault of ["alias","active"]){
    const f=fixture(t);create(f);
    if(fault==="active"){
      const previous=f.records.read("request","request")!;
      commit(f,"terminal_fixture",[{previous,next:{...previous,row:{...previous.row,state:"cancelled",revision:2}}}]);
    }
    // 明示的に不整合なsigned storage fixtureを構成し、root照合だけで返さないことを検証する。
    f.transaction.runPrepared("inconsistent_fixture",(_mark,state)=>{
      const metadata=f.nodes.read(nodes=>f.indexes.read(indexes=>{
        const root=state.resource_bindings.find(value=>value.resource_id==="approval_records")!.resource_digest;
        const plan=new ApprovalMetadataPlan(scope,root,nodes,indexes);
        if(fault==="alias")plan.putIndex(null,{codec_version:1,scope,kind:"alias",selector:{name:"request_creation",creation_key:"0".repeat(64)},target:"request"});
        else appendApprovalList(plan,{record_kind:"request",membership:"active"},"request");
        return plan.finish();
      }));
      return{event:{...event,resource_id:"approval_records"},resource_digest:metadata.proposed_root,mutation:()=>{f.writer.stage(metadata);return null;}};
    });
    if(fault==="alias")assert.throws(()=>f.records.readAlias({name:"request_creation",creation_key:"0".repeat(64)}),ApprovalRecordRepositoryError);
    else{
      assert.throws(()=>f.records.readListHead({record_kind:"request",membership:"active"},4),ApprovalRecordRepositoryError);
      assert.throws(()=>f.records.readAlias({name:"request_creation",creation_key:values("unused").request.row.creation_key}),ApprovalRecordRepositoryError);
    }
  }
});

test("別primaryでもcreation/notification aliasの重複をSQL UNIQUEより前に拒否する", t => {
  for (const kind of ["request", "notification"] as const) {
    const f = fixture(t); create(f); const record = values("duplicate")[kind];
    if (record.kind === "request") record.row.request_id = "other_request";
    else record.row.notification_attempt_id = "other_notification";
    const calls = f.anchors.calls.length;
    assert.throws(() => commit(f, "duplicate", [{ previous: null, next: record }]), ApprovalTransactionError);
    assert.equal(f.anchors.calls.length, calls);
    assert.equal(list(f, kind, "all").count, kind === "request" ? 1 : 2);
  }
});

test("cancelとdecision/eventと2つの無効表示outboxを1つのbounded planへ含める", t => {
  const f = fixture(t); create(f); deliver(f); f.setNow("2026-09-19T00:01:00.000Z");
  const request = f.records.read("request", "request")!, data = values("cancel");
  Object.assign(data.decision.row, { kind: "cancel", actor_kind: "requester", actor_id: "requester_a", presentation_revision: null, decided_at: "2026-09-19T00:01:00.000Z" });
  data.presentation.row.message_ref = "message_notification"; data.presentation.row.desired_revision = 3;
  const notice = structuredClone(data.presentation); notice.row.update_id = "notice_update"; notice.row.notification_attempt_id = "notice"; notice.row.message_ref = "message_notice";
  commit(f, "cancel", [{ previous: request, next: { ...request, row: { ...request.row, state: "cancelled", revision: 3 } } },
    ...[data.decision, data.event, data.presentation, notice].map(next => ({ previous: null, next }))]);
  assert.equal(f.records.read("request", "request")!.row.state, "cancelled");
  assert.equal(f.records.read("decision", "request")!.row.kind, "cancel");
  assert.equal(list(f, "request", "active").count, 0); assert.equal(list(f, "event", "active").count, 1);
  assert.equal(list(f, "presentation", "active").count, 2); assert.equal(list(f, "presentation", "all").count, 2);
});
