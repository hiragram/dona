import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { DispatcherDatabase } from "../../src/database.js";
import {
  installApprovalSchema,
  verifyApprovalSchema,
  verifyApprovalIntegrity,
  ApprovalSchemaError,
} from "../../src/approval/schema.js";

test("起動とoffline整合性検査は既存の外部キー破損を修復せず拒否する", t => {
  const {db}=setup(t);
  db.pragma("foreign_keys=OFF");
  db.exec("INSERT INTO approval_event_outbox VALUES ('orphan','missing','dona_approval.decision.v1','pending',NULL)");
  db.pragma("foreign_keys=ON");
  verifyApprovalSchema(db);
  assert.throws(()=>verifyApprovalIntegrity(db),ApprovalSchemaError);
  assert.throws(()=>installApprovalSchema(db),ApprovalSchemaError);
  assert.deepEqual(db.prepare("SELECT count(*) AS n FROM approval_event_outbox").get(),{n:1});
});

test("terminal requestを古いwriterが再承認・再消費可能状態へ戻せない", t => {
  const {db}=setup(t);
  for(const state of ["rejected","cancelled","expired","delivery_failed","consumed","execution_cancelled","consume_expired","needs_review"]){
    request(db,state);db.prepare("UPDATE approval_requests SET state=? WHERE request_id=?").run(state,state);
    for(const next of ["requested","sent","approved"])
      assert.throws(()=>db.prepare("UPDATE approval_requests SET state=?,revision=revision+1 WHERE request_id=?").run(next,state),/approval_request_terminal/);
    db.prepare("UPDATE approval_requests SET state=? WHERE request_id=?").run(state,state);
  }
});
test("attemptの受理不明とterminalから再claimできず確定receiptも差替えできない", t => {
  const {db}=setup(t);
  for(const state of ["succeeded","failed","needs_review","acceptance_unknown"]){
    request(db,state);decide(db,state);db.transaction(()=>consume(db,state)).immediate();
    db.prepare("UPDATE approval_execution_attempts SET state='executing' WHERE request_id=?").run(state);
    db.prepare("UPDATE approval_execution_attempts SET state=?,receipt_ref='receipt',failure_code='bounded_reason' WHERE request_id=?").run(state,state);
    for(const next of ["claimed","executing"])
      assert.throws(()=>db.prepare("UPDATE approval_execution_attempts SET state=?,fence=fence+1 WHERE request_id=?").run(next,state),/approval_execution_transition/);
    if(state!=="acceptance_unknown"){
      assert.throws(()=>db.prepare("UPDATE approval_execution_attempts SET receipt_ref='different' WHERE request_id=?").run(state),/approval_execution_result_immutable/);
      assert.throws(()=>db.prepare("UPDATE approval_execution_attempts SET failure_code=NULL WHERE request_id=?").run(state),/approval_execution_result_immutable/);
    } else db.prepare("UPDATE approval_execution_attempts SET state='succeeded' WHERE request_id=?").run(state);
  }
});
test("受理不明と確定したnotificationは再配送へ戻せない", t => {
  for(const state of ["sent","failed","needs_review","aborted","acceptance_unknown"]){
    const {db}=setup(t);request(db);notification(db,"n1");
    if(state!=="aborted")db.exec("UPDATE approval_notifications SET state='dispatching',fence=1");
    db.prepare("UPDATE approval_notifications SET state=?,message_ref=?").run(state,state==="sent"?"message":null);
    for(const next of ["pending","dispatching"])
      assert.throws(()=>db.prepare("UPDATE approval_notifications SET state=?,message_ref=NULL,fence=fence+1").run(next));
    if(state==="acceptance_unknown")db.exec("UPDATE approval_notifications SET state='sent',message_ref='message'");
  }
});
test("受理不明とterminal presentationを同じ更新slotで再送できない", t => {
  for(const state of ["succeeded","failed","needs_review","aborted","acceptance_unknown"]){
    const {db}=setup(t);request(db);notification(db,"n1");
    db.exec("UPDATE approval_notifications SET state='dispatching',fence=1; UPDATE approval_notifications SET state='sent',message_ref='message'");
    db.exec("INSERT INTO approval_presentation_updates VALUES ('u1','n1','message',2,'pending',0,'tx_1')");
    if(state!=="aborted")db.exec("UPDATE approval_presentation_updates SET state='dispatching',fence=1");
    db.prepare("UPDATE approval_presentation_updates SET state=?").run(state);
    for(const next of ["pending","dispatching"])
      assert.throws(()=>db.prepare("UPDATE approval_presentation_updates SET state=?,fence=fence+1").run(next),/approval_presentation_transition/);
    if(state==="acceptance_unknown")db.exec("UPDATE approval_presentation_updates SET state='succeeded'");
  }
});
test("snapshotの保存上限は多byte文字でも256KiBを越えない", t => {
  const {db}=setup(t);request(db);
  const original=db.prepare("SELECT * FROM approval_requests").get() as Record<string,unknown>;
  const columns=Object.keys(original);
  const insert=db.prepare(`INSERT INTO approval_requests (${columns.join(',')}) VALUES (${columns.map(name=>'@'+name).join(',')})`);
  for(const [id,padding,allowed] of [["ascii","a".repeat(200000),true],["emoji","😀".repeat(200000),false]] as const){
    const snapshot=JSON.stringify({...JSON.parse(original.snapshot_json as string),padding});
    assert.equal(Buffer.byteLength(snapshot)<=262144,allowed);
    const value={...original,request_id:id,creation_key:id.padEnd(64,"0"),snapshot_json:snapshot};
    if(allowed)insert.run(value);else assert.throws(()=>insert.run(value),/CHECK constraint failed/);
  }
});

test("UTF-16 databaseをUTF-8のbyte上限として受け付けない", t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"approval-encoding-"));
  const db=new Database(path.join(directory,"fixture.sqlite"));
  t.after(()=>{db.close();fs.rmSync(directory,{recursive:true,force:true});});
  db.pragma("encoding='UTF-16le'");db.pragma("foreign_keys=ON");
  db.exec("CREATE TABLE original(id INTEGER); INSERT INTO original VALUES(1)");
  assert.throws(()=>installApprovalSchema(db),ApprovalSchemaError);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='approval_schema'").get(),undefined);
  assert.deepEqual(db.prepare("SELECT id FROM original").get(),{id:1});
  assert.equal(db.pragma("encoding",{simple:true}),"UTF-16le");
});

function setup(t: { after(fn: () => void): void }, existing = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "approval-schema-"));
  const filename = path.join(root, "fixture.sqlite");
  if (existing) new DispatcherDatabase(filename).close();
  const db = new Database(filename);
  db.pragma("journal_mode=WAL");
  db.pragma("foreign_keys=ON");
  if (existing)
    db.exec(
      "CREATE TABLE existing_events (id TEXT PRIMARY KEY); INSERT INTO existing_events VALUES ('original')",
    );
  installApprovalSchema(db);
  db.prepare("INSERT INTO approval_clock_reservations VALUES (?,?)").run(
    "tx_1",
    JSON.stringify({ codec_version: 1, transaction_id: "tx_1" }),
  );
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { db, filename };
}
function request(db: Database.Database, id = "r1") {
  const snapshot = {
    codec_version: 1,
    operation_kind: "slack.post_thread_reply.v1",
    instance_id: "i1",
    workspace_id: "w1",
    policy_revision: 1,
  };
  db.prepare(
    `INSERT INTO approval_requests (request_id,instance_id,workspace_id,creation_key,snapshot_json,semantic_hash,
    binding_id,binding_revision,policy_revision,model_version,state,revision,created_at,expires_at,clock_transaction_id)
    VALUES (?,'i1','w1',?,?,?,'b1',1,1,'model-1','sent',1,'2026-09-19T00:00:00.000Z','2026-09-19T00:15:00.000Z','tx_1')`,
  ).run(id, id.padEnd(64, "0"), JSON.stringify(snapshot), "a".repeat(64));
}
function decide(
  db: Database.Database,
  id = "r1",
  kind = "approve",
  workspace = "w1",
  presentation: number | null = 1,
) {
  const actor =
    kind === "cancel"
      ? "requester"
      : kind === "expire"
        ? "system"
        : "supervisor";
  db.prepare(
    `INSERT INTO approval_decisions VALUES (?,?, 'i1',?,?,'b1',1,?,?, 'actor1',?,'2026-09-19T00:01:00.000Z','tx_1')`,
  ).run("d_" + id, id, workspace, "a".repeat(64), kind, actor, presentation);
}
function consume(db: Database.Database, requestId = "r1") {
  db.prepare(
    "INSERT INTO approval_consumes VALUES (?,?,?,'approve',?,'2026-09-19T00:02:00.000Z','tx_1')",
  ).run("c_" + requestId, requestId, "d_" + requestId, "a_" + requestId);
  db.prepare(
    `INSERT INTO approval_execution_attempts VALUES (?,?,?,'claimed',1,'2026-09-19T00:02:00.000Z',
    '2026-09-19T00:03:00.000Z','2026-09-20T00:02:00.000Z',NULL,NULL,'tx_1')`,
  ).run("a_" + requestId, requestId, "c_" + requestId);
}
function notification(
  db: Database.Database,
  id: string,
  kind = "approval_card",
) {
  db.prepare(
    "INSERT INTO approval_notifications VALUES (?,'r1',?,'pending',1,1,?,1,0,NULL,'tx_1')",
  ).run(id, kind, "b".repeat(64));
}

test("既存データ・WAL・schema versionを保ち、再open後も制約を維持する", (t) => {
  for (const existing of [false, true]) {
    const { db, filename } = setup(t, existing);
    const originalVersion = db.pragma("user_version", { simple: true });
    request(db);
    decide(db);
    db.transaction(() => consume(db)).immediate();
    const reopened = new Database(filename);
    reopened.pragma("foreign_keys=ON");
    try {
      installApprovalSchema(reopened);
      assert.equal(
        reopened.pragma("user_version", { simple: true }),
        originalVersion,
      );
      assert.equal(reopened.pragma("journal_mode", { simple: true }), "wal");
      if (existing)
        assert.deepEqual(
          reopened.prepare("SELECT * FROM existing_events").all(),
          [{ id: "original" }],
        );
      assert.equal(
        (
          reopened
            .prepare("SELECT state FROM approval_execution_attempts")
            .get() as { state: string }
        ).state,
        "claimed",
      );
      assert.deepEqual(reopened.pragma("foreign_key_check"), []);
      assert.equal(reopened.pragma("integrity_check", { simple: true }), "ok");
    } finally {
      reopened.close();
    }
  }
});
test("部分schema・欠落したfence・未知versionを自動修復せず拒否する", (t) => {
  const { db } = setup(t);
  db.exec("DROP INDEX approval_one_message_write");
  assert.throws(() => installApprovalSchema(db), ApprovalSchemaError);
  assert.equal(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name='approval_one_message_write'",
      )
      .get(),
    undefined,
  );
  const other = new Database(":memory:");
  other.pragma("foreign_keys=ON");
  try {
    other.exec("CREATE TABLE approval_requests (id TEXT)");
    assert.throws(() => installApprovalSchema(other), ApprovalSchemaError);
    assert.equal(
      other
        .prepare("SELECT 1 FROM sqlite_master WHERE name='approval_schema'")
        .get(),
      undefined,
    );
    other.exec(
      "DROP TABLE approval_requests; CREATE TABLE approval_schema(version INTEGER); INSERT INTO approval_schema VALUES(2)",
    );
    assert.throws(() => installApprovalSchema(other), ApprovalSchemaError);
  } finally {
    other.close();
  }
});
test("decision slotはscope越境・presentation欠落・再open後の重複decisionを拒否する", (t) => {
  const { db, filename } = setup(t);
  request(db);
  assert.throws(() => decide(db, "r1", "approve", "other"));
  assert.throws(() => decide(db, "r1", "approve", "w1", null));
  decide(db);
  const peer = new Database(filename);
  peer.pragma("foreign_keys=ON");
  try {
    assert.throws(() => decide(peer, "r1", "cancel"));
    assert.equal(
      (
        peer.prepare("SELECT kind FROM approval_decisions").get() as {
          kind: string;
        }
      ).kind,
      "approve",
    );
  } finally {
    peer.close();
  }
});
test("consumeとattemptを同時にcommitし、未承認と二重attemptを拒否する", (t) => {
  const { db, filename } = setup(t);
  request(db);
  decide(db);
  request(db, "r2");
  decide(db, "r2", "reject");
  assert.throws(() =>
    db
      .transaction(() =>
        db.exec(
          "INSERT INTO approval_consumes VALUES ('c_r1','r1','d_r1','approve','a_r1','now','tx_1')",
        ),
      )
      .immediate(),
  );
  assert.equal(
    (
      db.prepare("SELECT count(*) n FROM approval_consumes").get() as {
        n: number;
      }
    ).n,
    0,
  );
  assert.throws(() => db.transaction(() => consume(db, "r2")).immediate());
  db.transaction(() => consume(db)).immediate();
  const peer = new Database(filename);
  peer.pragma("foreign_keys=ON");
  try {
    assert.throws(() => peer.transaction(() => consume(peer)).immediate());
    assert.equal(
      (
        peer
          .prepare("SELECT count(*) n FROM approval_execution_attempts")
          .get() as { n: number }
      ).n,
      1,
    );
  } finally {
    peer.close();
  }
});
test("受理不明でもnotificationのcreation keyを維持し、pending noticeは別slotを使う", (t) => {
  const { db } = setup(t);
  request(db);
  notification(db, "n1");
  db.exec(
    "UPDATE approval_notifications SET state='dispatching',fence=1 WHERE notification_attempt_id='n1'; UPDATE approval_notifications SET state='acceptance_unknown',fence=1 WHERE notification_attempt_id='n1'",
  );
  assert.throws(() =>
    db.exec(
      "UPDATE approval_notifications SET marker_mac='" +
        "c".repeat(64) +
        "' WHERE notification_attempt_id='n1'",
    ),
  );
  assert.throws(() =>
    db.exec(
      "UPDATE approval_notifications SET state='sent' WHERE notification_attempt_id='n1'",
    ),
  );
  db.exec(
    "UPDATE approval_notifications SET state='sent',message_ref='exact_message' WHERE notification_attempt_id='n1'",
  );
  assert.throws(() =>
    db.exec(
      "UPDATE approval_notifications SET message_ref='other_message' WHERE notification_attempt_id='n1'",
    ),
  );
  assert.throws(() => notification(db, "n2"));
  notification(db, "notice1", "pending_notice");
  assert.equal(
    (
      db.prepare("SELECT count(*) n FROM approval_notifications").get() as {
        n: number;
      }
    ).n,
    2,
  );
});
test("受理不明のmessage更新が確定するまで後続writeをfenceする", (t) => {
  const { db } = setup(t);
  request(db);
  notification(db, "n1");
  db.exec(
    "UPDATE approval_notifications SET state='dispatching',fence=1 WHERE notification_attempt_id='n1'; UPDATE approval_notifications SET state='sent',fence=1,message_ref='message1' WHERE notification_attempt_id='n1'",
  );
  const insert = db.prepare(
    "INSERT INTO approval_presentation_updates VALUES (?,'n1','message1',?, ?,1,'tx_1')",
  );
  insert.run("u1", 1, "dispatching");
  insert.run("u2", 2, "pending");
  assert.throws(() =>
    db.exec(
      "UPDATE approval_presentation_updates SET desired_revision=3 WHERE update_id='u1'",
    ),
  );
  db.exec(
    "UPDATE approval_presentation_updates SET state='acceptance_unknown' WHERE update_id='u1'",
  );
  assert.throws(() =>
    db.exec(
      "UPDATE approval_presentation_updates SET state='dispatching' WHERE update_id='u2'",
    ),
  );
  db.exec(
    "UPDATE approval_presentation_updates SET state='succeeded' WHERE update_id='u1'",
  );
  db.exec(
    "UPDATE approval_presentation_updates SET state='dispatching' WHERE update_id='u2'",
  );
});

test("presentationは親の確定messageへ結び、外部call前の正のfenceを要求する", (t) => {
  const { db } = setup(t);
  request(db);
  notification(db, "n1");
  const insert = db.prepare(
    "INSERT INTO approval_presentation_updates VALUES (?,'n1',?,1,'pending',0,'tx_1')",
  );
  assert.throws(() => insert.run("unknown_parent", "message1"));
  db.exec(
    "UPDATE approval_notifications SET state='dispatching',fence=1 WHERE notification_attempt_id='n1'; UPDATE approval_notifications SET state='sent',fence=1,message_ref='message1' WHERE notification_attempt_id='n1'",
  );
  request(db, "r2");
  db.prepare(
    "INSERT INTO approval_notifications VALUES ('n2','r2','approval_card','sent',1,1,?,1,1,'message2','tx_1')",
  ).run("b".repeat(64));
  assert.throws(() => insert.run("wrong_parent", "message2"));
  insert.run("u1", "message1");
  for (const state of ["dispatching", "acceptance_unknown"]) {
    assert.throws(() =>
      db
        .prepare(
          "UPDATE approval_presentation_updates SET state=? WHERE update_id='u1'",
        )
        .run(state),
    );
  }
  db.exec(
    "UPDATE approval_presentation_updates SET state='dispatching',fence=1 WHERE update_id='u1'",
  );
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});

test("設定済みconsume期限は延長もNULLへの差戻しもできない", (t) => {
  const { db } = setup(t);
  request(db);
  decide(db);
  const update = db.prepare(
    "UPDATE approval_requests SET consume_expires_at=? WHERE request_id='r1'",
  );
  update.run("2026-09-19T00:06:00.000Z");
  update.run("2026-09-19T00:06:00.000Z");
  assert.throws(() => update.run("2026-09-20T00:06:00.000Z"));
  assert.throws(() => update.run(null));
  assert.equal(
    (
      db.prepare("SELECT consume_expires_at FROM approval_requests").get() as {
        consume_expires_at: string;
      }
    ).consume_expires_at,
    "2026-09-19T00:06:00.000Z",
  );
});

test("retention未認可のledger削除でconsumeとattemptを再利用できない", (t) => {
  const { db } = setup(t);
  request(db);
  decide(db);
  db.transaction(() => consume(db)).immediate();
  assert.throws(() =>
    db
      .transaction(() => {
        db.exec(
          "DELETE FROM approval_consumes; DELETE FROM approval_execution_attempts",
        );
      })
      .immediate(),
  );
  for (const table of [
    "approval_consumes",
    "approval_execution_attempts",
    "approval_decisions",
    "approval_requests",
    "approval_clock_reservations",
  ]) {
    assert.throws(() => db.exec(`DELETE FROM ${table}`));
  }
  assert.throws(() => db.transaction(() => consume(db)).immediate());
  assert.equal(
    (
      db
        .prepare("SELECT count(*) n FROM approval_execution_attempts")
        .get() as { n: number }
    ).n,
    1,
  );
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});
test("immutable source・clock・decisionの差替えと存在しないreservation参照を拒否する", (t) => {
  const { db } = setup(t);
  request(db);
  decide(db);
  for (const sql of [
    "UPDATE approval_requests SET snapshot_json='{}'",
    "UPDATE approval_requests SET expires_at='later'",
    "UPDATE approval_decisions SET kind='reject'",
    "UPDATE approval_clock_reservations SET mark_json='{}'",
    "UPDATE approval_requests SET clock_transaction_id='missing'",
  ])
    assert.throws(() => db.exec(sql));
  assert.throws(() =>
    db
      .prepare("INSERT INTO approval_clock_reservations VALUES (?,?)")
      .run("tx_2", "{}"),
  );
});
test("decision event outboxは安定したevent identityで重複を防ぎ、外部配送と分離する", (t) => {
  const { db } = setup(t);
  request(db);
  decide(db);
  db.exec(
    "INSERT INTO approval_event_outbox VALUES ('evt1','d_r1','dona_approval.decision.v1','pending',NULL)",
  );
  assert.throws(() =>
    db.exec(
      "INSERT INTO approval_event_outbox VALUES ('evt2','d_r1','dona_approval.decision.v1','pending',NULL)",
    ),
  );
  assert.throws(() =>
    db.exec("UPDATE approval_event_outbox SET state='delivered'"),
  );
  db.exec(
    "UPDATE approval_event_outbox SET state='delivered',delivered_at='2026-09-19T00:02:00.000Z'",
  );
  for (const sql of [
    "UPDATE approval_event_outbox SET state='pending',delivered_at=NULL",
    "UPDATE approval_event_outbox SET delivered_at='2026-09-19T00:03:00.000Z'",
    "UPDATE approval_event_outbox SET delivered_at=NULL",
  ]) assert.throws(() => db.exec(sql), /approval_event_delivery_immutable/);
  assert.deepEqual(db.prepare("SELECT count(*) AS n FROM approval_event_outbox WHERE state='pending'").get(), { n: 0 });
  db.exec("UPDATE approval_event_outbox SET state='delivered',delivered_at='2026-09-19T00:02:00.000Z'");
});

test(
  "独立workerのconsume競合は一件だけをcommitし、同じattemptを二重作成しない",
  { timeout: 5000 },
  async (t) => {
    const { db, filename } = setup(t);
    request(db);
    decide(db);
    const barrier = new SharedArrayBuffer(4);
    const gate = new Int32Array(barrier);
    const modulePath = createRequire(import.meta.url).resolve("better-sqlite3");
    const extensionPath = fileURLToPath(new URL("../../dist/native/file-identity" + (process.platform === "darwin" ? ".dylib" : ".so"), import.meta.url));
    const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require(workerData.modulePath);
    const db = new Database(workerData.filename);
    db.loadExtension(workerData.extensionPath);
    db.pragma('foreign_keys=ON'); db.pragma('recursive_triggers=ON'); db.pragma('busy_timeout=2000');
    const gate = new Int32Array(workerData.barrier);
    parentPort.postMessage('ready');
    while (Atomics.load(gate,0)===0) Atomics.wait(gate,0,0,2000);
    try {
      db.transaction(() => {
        db.exec("INSERT INTO approval_consumes VALUES ('c_r1','r1','d_r1','approve','a_r1','now','tx_1')");
        db.exec("INSERT INTO approval_execution_attempts VALUES ('a_r1','r1','c_r1','claimed',1,'now','expiry','payload-expiry',NULL,NULL,'tx_1')");
      }).immediate();
      parentPort.postMessage('claimed');
    } catch (error) { parentPort.postMessage(error.code.startsWith('SQLITE_CONSTRAINT') ? 'conflict' : error.code); }
    finally { db.close(); }
  `;
    let readyCount = 0;
    const workers = [0, 1].map(
      () =>
        new Worker(source, {
          eval: true,
          workerData: { filename, barrier, modulePath, extensionPath },
        }),
    );
    t.after(async () => {
      await Promise.all(workers.map((worker) => worker.terminate()));
    });
    const results = await Promise.all(
      workers.map(
        (worker) =>
          new Promise<string>((resolve, reject) => {
            worker.on("error", reject);
            worker.on("message", (message: string) => {
              if (message === "ready") {
                if (++readyCount === 2) {
                  Atomics.store(gate, 0, 1);
                  Atomics.notify(gate, 0, 2);
                }
              } else resolve(message);
            });
          }),
      ),
    );
    assert.deepEqual(results.sort(), ["claimed", "conflict"]);
    assert.equal(
      (
        db.prepare("SELECT count(*) n FROM approval_consumes").get() as {
          n: number;
        }
      ).n,
      1,
    );
    assert.equal(
      (
        db
          .prepare("SELECT count(*) n FROM approval_execution_attempts")
          .get() as { n: number }
      ).n,
      1,
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  },
);

test("異なるnotificationによる同じmessageの所有を拒否する", (t) => {
  const { db } = setup(t);
  request(db);
  request(db, "r2");
  notification(db, "n1");
  db.exec(
    "UPDATE approval_notifications SET state='dispatching',fence=1 WHERE notification_attempt_id='n1'; UPDATE approval_notifications SET state='sent',fence=1,message_ref='message1' WHERE notification_attempt_id='n1'",
  );
  const insert = db.prepare(
    "INSERT INTO approval_notifications VALUES ('n2','r2','approval_card','sent',1,1,?,1,1,'message1','tx_1')",
  );
  assert.throws(() => insert.run("b".repeat(64)));
  db.prepare(
    "INSERT INTO approval_notifications VALUES ('n2','r2','approval_card','pending',1,1,?,1,0,NULL,'tx_1')",
  ).run("b".repeat(64));
  assert.throws(() =>
    db.exec(
      "UPDATE approval_notifications SET state='dispatching',fence=1 WHERE notification_attempt_id='n2'; UPDATE approval_notifications SET state='sent',fence=1,message_ref='message1' WHERE notification_attempt_id='n2'",
    ),
  );
  db.exec(
    "UPDATE approval_notifications SET state='dispatching',fence=1 WHERE notification_attempt_id='n2'; UPDATE approval_notifications SET state='sent',fence=1,message_ref='message2' WHERE notification_attempt_id='n2'",
  );
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});

test("sent以外のnotificationはmessageを確定できず子updateも作れない", (t) => {
  const { db } = setup(t);
  request(db);
  notification(db, "n1");
  for (const state of [
    "pending",
    "dispatching",
    "failed",
    "acceptance_unknown",
    "needs_review",
    "aborted",
  ]) {
    assert.throws(() =>
      db
        .prepare(
          "UPDATE approval_notifications SET state=?,fence=1,message_ref='message1' WHERE notification_attempt_id='n1'",
        )
        .run(state),
    );
  }
  assert.throws(() =>
    db.exec(
      "INSERT INTO approval_presentation_updates VALUES ('u1','n1','message1',1,'dispatching',1,'tx_1')",
    ),
  );
  db.exec(
    "UPDATE approval_notifications SET state='dispatching',fence=1 WHERE notification_attempt_id='n1'; UPDATE approval_notifications SET state='sent',fence=1,message_ref='message1' WHERE notification_attempt_id='n1'",
  );
  db.exec(
    "INSERT INTO approval_presentation_updates VALUES ('u1','n1','message1',1,'dispatching',1,'tx_1')",
  );
});

test("別tableに付いたapproval名のtriggerとindexも未知schemaとして拒否する", (t) => {
  for (const kind of ["trigger", "index"]) {
    const { db } = setup(t);
    request(db);
    db.exec("CREATE TABLE existing_events (id TEXT)");
    db.exec(
      kind === "trigger"
        ? "CREATE TRIGGER approval_inject AFTER INSERT ON existing_events BEGIN UPDATE approval_requests SET state='approved'; END"
        : "CREATE INDEX approval_foreign_index ON existing_events(id)",
    );
    assert.throws(() => verifyApprovalSchema(db), ApprovalSchemaError);
    assert.throws(() => installApprovalSchema(db), ApprovalSchemaError);
    assert.equal(
      (
        db.prepare("SELECT state FROM approval_requests").get() as {
          state: string;
        }
      ).state,
      "sent",
    );
  }
});

test("REPLACEによるimmutable ledgerの削除・再挿入を拒否する", (t) => {
  const { db } = setup(t); request(db); decide(db);
  db.transaction(() => consume(db)).immediate(); notification(db, "n1");
  db.exec("UPDATE approval_notifications SET state='dispatching',fence=1 WHERE notification_attempt_id='n1'; UPDATE approval_notifications SET state='sent',fence=1,message_ref='message1' WHERE notification_attempt_id='n1'");
  db.exec("INSERT INTO approval_event_outbox VALUES ('e1','d_r1','dona_approval.decision.v1','pending',NULL)");
  db.exec("INSERT INTO approval_presentation_updates VALUES ('u1','n1','message1',2,'pending',0,'tx_1')");
  assert.equal(db.pragma("recursive_triggers", { simple: true }), 1);
  for (const table of ["approval_clock_reservations", "approval_requests", "approval_decisions", "approval_consumes", "approval_execution_attempts", "approval_notifications", "approval_event_outbox", "approval_presentation_updates"]) {
    const before = db.prepare(`SELECT * FROM ${table}`).all();
    assert.throws(() => db.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`), /approval_retention_not_authorized/);
    assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), before);
  }
  db.pragma("recursive_triggers=OFF");
  assert.throws(() => verifyApprovalSchema(db), ApprovalSchemaError);
});

test("TEMP schemaの承認table・trigger・indexも検証対象にする", (t) => {
  for (const ddl of [
    "CREATE TEMP TRIGGER approval_inject AFTER INSERT ON approval_requests BEGIN UPDATE approval_requests SET state='needs_review'; END",
    "CREATE TEMP TABLE approval_shadow(value TEXT)",
    "CREATE TEMP TABLE unrelated(value TEXT); CREATE INDEX temp.approval_inject ON unrelated(value)",
  ]) {
    const { db } = setup(t); db.exec(ddl);
    assert.throws(() => verifyApprovalSchema(db), ApprovalSchemaError);
    assert.throws(() => installApprovalSchema(db), ApprovalSchemaError);
  }
});


test("request・attempt・notification・presentationのclock参照を差し替えない", t => {
  const { db } = setup(t); request(db); decide(db); db.transaction(()=>consume(db))(); notification(db,"n1");
  db.exec("UPDATE approval_notifications SET state='dispatching',fence=1 WHERE notification_attempt_id='n1'; UPDATE approval_notifications SET state='sent',fence=1,message_ref='message1' WHERE notification_attempt_id='n1'");
  db.exec("INSERT INTO approval_presentation_updates VALUES ('u1','n1','message1',1,'pending',0,'tx_1')");
  db.prepare("INSERT INTO approval_clock_reservations VALUES (?,?)").run("tx_2",JSON.stringify({codec_version:1,transaction_id:"tx_2"}));
  for (const table of ["approval_requests","approval_execution_attempts","approval_notifications","approval_presentation_updates"]) {
    assert.throws(()=>db.exec(`UPDATE ${table} SET clock_transaction_id='tx_2'`));
    assert.deepEqual(db.prepare(`SELECT DISTINCT clock_transaction_id FROM ${table}`).all(),[{clock_transaction_id:"tx_1"}]);
  }
});

test("全承認tableをSTRICTにしfractional revision・key version・fenceを拒否する", t => {
  const { db } = setup(t); request(db); decide(db); db.transaction(()=>consume(db))(); notification(db,"n1");
  db.exec("UPDATE approval_notifications SET state='dispatching',fence=1 WHERE notification_attempt_id='n1'; UPDATE approval_notifications SET state='sent',fence=1,message_ref='message1' WHERE notification_attempt_id='n1'");
  db.exec("INSERT INTO approval_presentation_updates VALUES ('u1','n1','message1',1,'pending',0,'tx_1')");
  const tables=(db.pragma("table_list") as Array<{schema:string;name:string;strict:number}>).filter(row=>row.schema==="main" && row.name.startsWith("approval_"));
  assert.equal(tables.length,9); assert.ok(tables.every(table=>table.strict===1));
  for(const table of tables.filter(table=>table.name!=="approval_schema")) {
    const columns=db.pragma(`table_info(${table.name})`) as Array<{name:string;type:string}>;
    for(const column of columns.filter(column=>column.type==="INTEGER")) {
      const values=columns.map(value=>value.name===column.name ? "0.5" : value.name).join(",");
      assert.throws(()=>db.exec(`INSERT INTO ${table.name} SELECT ${values} FROM ${table.name} LIMIT 1`),
        error=>(error as {code:string}).code==="SQLITE_CONSTRAINT_DATATYPE",table.name+"."+column.name);
    }
  }
  for(const table of ["approval_execution_attempts","approval_notifications","approval_presentation_updates"])
    assert.throws(()=>db.exec(`UPDATE ${table} SET fence=9007199254740992`));
});

test("大文字小文字を変えたTEMP承認tableもshadowとして拒否する", t => {
  for(const name of ["APPROVAL_SCHEMA","Approval_Requests","APPROVAL_CLOCK_RESERVATIONS"]) {
    const { db }=setup(t); db.exec(`CREATE TEMP TABLE ${name} AS SELECT * FROM main.${name}`);
    assert.throws(()=>verifyApprovalSchema(db),ApprovalSchemaError); assert.throws(()=>installApprovalSchema(db),ApprovalSchemaError);
  }
});


test("fenceとrequest revisionは巻き戻らず古いgenerationのCASを復活させない", t => {
  const {db}=setup(t);request(db);decide(db);db.transaction(()=>consume(db))();notification(db,"n1");
  db.exec("UPDATE approval_notifications SET state='dispatching',fence=1; UPDATE approval_notifications SET state='sent',fence=1,message_ref='message1'");
  db.exec("INSERT INTO approval_presentation_updates VALUES ('u1','n1','message1',1,'pending',1,'tx_1')");
  for(const table of ["approval_execution_attempts","approval_notifications","approval_presentation_updates"]) {
    db.exec(`UPDATE ${table} SET fence=2`);
    assert.throws(()=>db.exec(`UPDATE ${table} SET fence=1`),/approval_fence_rollback/);
    assert.equal(db.prepare(`UPDATE ${table} SET fence=2 WHERE fence=1`).run().changes,0);
    db.exec(`UPDATE ${table} SET fence=3`);
    assert.deepEqual(db.prepare(`SELECT fence FROM ${table}`).all(),[{fence:3}]);
  }
  db.exec("UPDATE approval_requests SET revision=2");
  assert.throws(()=>db.exec("UPDATE approval_requests SET revision=1"),/approval_revision_rollback/);
  assert.equal(db.prepare("UPDATE approval_requests SET revision=2 WHERE revision=1").run().changes,0);
});
