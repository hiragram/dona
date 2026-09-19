import { publishMutexFile } from "../../src/audit/file-identity.js";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { fork } from "node:child_process";
import Database from "better-sqlite3";
import {
  AuditRepository,
  installAuditSchema,
  type AuditAnchorStore,
} from "../../src/audit/repository.js";
import {
  signAuditCheckpoint,
  type AuditAnchor,
  type AuditKey,
  type AuditEvent,
} from "../../src/audit/codec.js";
import type { ClockMark, ClockMarkStore } from "../../src/approval/clock.js";
import { installApprovalSchema } from "../../src/approval/schema.js";
import {
  ApprovalTransaction,
  ApprovalTransactionError,
  ApprovalTransactionBusyError,
} from "../../src/approval/transaction.js";
import { verifyApprovalSchema } from "../../src/approval/schema.js";
import {
  fixtureKeys,
  fixtureCheckpoint,
  initializeFixtureStore,
  openFixtureStores,
} from "./fixtures/transaction-store.js";
import {
  withSecurityTransactionLock,
  openSecurityDatabase,
  SecurityCoordinationError,
} from "../../src/audit/coordination.js";

// Deliberately test-only stores, without production durability or credentials.
const key: AuditKey = {
  version: 1,
  purpose: "audit",
  state: "active",
  activated_at: "2026-09-01T00:00:00.000Z",
  signing_expires_at: "2026-11-01T00:00:00.000Z",
  secret: Buffer.alloc(32, 17),
};
const keys = (version: number) => (version === 1 ? key : undefined);
const at = "2026-09-19T00:00:00.000Z";
const checkpoint = signAuditCheckpoint(
  {
    codec_version: 1,
    chain_id: "chain1",
    transaction_id: "genesis",
    signed_at: at,
    key_version: 1,
  },
  keys,
);
class Anchors implements AuditAnchorStore {
  value: AuditAnchor = {
    chain_id: "chain1",
    sequence: 0,
    mac: "0".repeat(64),
    checkpoint_mac: checkpoint.mac,
    pending_transaction_id: null,
  };
  fault = "none";
  calls: string[] = [];
  used = new Set<string>();
  read() {
    return structuredClone(this.value);
  }
  reserve(expected: AuditAnchor, proposed: AuditAnchor) {
    this.calls.push("reserve");
    assert.deepEqual(expected, this.value);
    if (this.fault === "reserve_before") throw Error("private fixture context");
    assert.ok(
      proposed.pending_transaction_id &&
        !this.used.has(proposed.pending_transaction_id),
    );
    this.used.add(proposed.pending_transaction_id);
    this.value = structuredClone(proposed);
    if (this.fault === "reserve_after") throw Error("private response loss");
    return this.read();
  }
  finalize(reserved: AuditAnchor) {
    this.calls.push("finalize");
    assert.deepEqual(reserved, this.value);
    if (this.fault === "finalize_before")
      throw Error("private finalize failure");
    this.value = { ...this.value, pending_transaction_id: null };
    if (this.fault === "finalize_after")
      throw Error("private finalize response loss");
    return this.read();
  }
}
class Marks implements ClockMarkStore {
  value: ClockMark = {
    codec_version: 1,
    transaction_id: "initial_clock",
    previous_transaction_id: null,
    boot_id: "boot1",
    continuous_ms: 1000,
    effective_utc: at,
  };
  fail = false;
  used = new Set<string>(["initial_clock"]);
  calls = 0;
  read() {
    return structuredClone(this.value);
  }
  reserve(expected: ClockMark, proposed: ClockMark) {
    this.calls++;
    assert.deepEqual(expected, this.value);
    if (this.fail) throw Error("private clock unavailable");
    assert.ok(!this.used.has(proposed.transaction_id));
    this.used.add(proposed.transaction_id);
    this.value = structuredClone(proposed);
    return this.read();
  }
}
const event: Omit<AuditEvent, "occurred_at"> = {
  scope: { instance_id: "i1", tenant_id: "w1" },
  actor: { kind: "system", id: "dispatcher" },
  action: "approval_request",
  operation: "slack.post_thread_reply.v1",
  resource_id: "r1",
  outcome: "pending",
  reason: "none",
  session_ref: null,
  receipt_id: null,
  attempt_id: null,
  policy_revision: 1,
  binding_revision: 1,
  authz_revision: 1,
};
function setup(t: { after(fn: () => void): void }, lockWaitTimeoutMs?: number) {
  const dir = fs.mkdtempSync(
    path.join(fs.realpathSync(os.homedir()), ".dona-approval-transaction-"),
  );
  const filename = path.join(dir, "fixture.sqlite");
  fs.writeFileSync(filename, "", { mode: 0o600, flag: "wx" });
  const db = openSecurityDatabase(filename);
  db.pragma("journal_mode=WAL");
  db.pragma("foreign_keys=ON");
  db.pragma("synchronous=FULL");
  installAuditSchema(db);
  installApprovalSchema(db);
  const anchors = new Anchors();
  const marks = new Marks();
  const audit = new AuditRepository(db, anchors, keys);
  audit.initialize(checkpoint);
  const transaction = new ApprovalTransaction(db, {
    clock: {
      observe: () => ({
        boot_id: "boot1",
        continuous_ms: 2000,
        wall_utc: "2026-09-19T00:00:01.000Z",
      }),
    },
    clockMarks: marks,
    auditAnchors: anchors,
    auditKeys: keys,
    auditSigningKeyVersion: 1,
    maximumClockDriftMs: 1000,
    ...(lockWaitTimeoutMs === undefined ? {} : { lockWaitTimeoutMs }),
  });
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, filename, anchors, marks, audit, transaction };
}
function insertRequest(db: Database.Database, tx: string) {
  const snapshot = JSON.stringify({
    codec_version: 1,
    operation_kind: "slack.post_thread_reply.v1",
    instance_id: "i1",
    workspace_id: "w1",
    policy_revision: 1,
  });
  db.prepare(
    "INSERT INTO approval_requests VALUES ('r1','i1','w1',?,?,?,'b1',1,1,'model1','requested',1,?, ?,NULL,?)",
  ).run(
    "b".repeat(64),
    snapshot,
    "a".repeat(64),
    at,
    "2026-09-19T00:15:00.000Z",
    tx,
  );
}
function count(db: Database.Database, table: string) {
  return (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number })
    .n;
}
test("callbackはprepare済みSQLでも時計予約を捏造できずguardを解除できない", t => {
  const {db,transaction,anchors}=setup(t);
  const forged=db.prepare("INSERT INTO approval_clock_reservations VALUES (?,?)");
  transaction.run("tx1",event,()=>{
    assert.throws(()=>db.prepare("SELECT dona_mutation_guard(?,3)").get(Buffer.alloc(32)),/security_sql_guard_unverified/);
    assert.throws(()=>forged.run("fake",JSON.stringify({codec_version:1,transaction_id:"fake"})));
    assert.equal(count(db,"approval_clock_reservations"),1);
    return null;
  });
  assert.equal(anchors.value.sequence,1);
  assert.equal(db.prepare("SELECT 1 FROM approval_clock_reservations WHERE transaction_id='fake'").get(),undefined);
});

test("全ledgerの新規rowは過去の時計予約を参照してcommitできない", t => {
  for(const target of ["requests","decisions","consumes","execution_attempts","notifications","presentation_updates"]){
    const {db,transaction,anchors}=setup(t);
    const decision=(clock:string)=>db.prepare("INSERT INTO approval_decisions VALUES ('d1','r1','i1','w1',?,'b1',1,'approve','supervisor','actor1',1,?,?)").run("a".repeat(64),at,clock);
    const notification=(clock:string)=>db.prepare("INSERT INTO approval_notifications VALUES ('n1','r1','approval_card','sent',1,1,?,1,1,'m1',?)").run("a".repeat(64),clock);
    transaction.run("old",event,mark=>{
      if(target!=="requests")insertRequest(db,mark.transaction_id);
      if(target==="consumes" || target==="execution_attempts")decision(mark.transaction_id);
      if(target==="presentation_updates")notification(mark.transaction_id);
    });
    const tables=["approval_clock_reservations","security_audit_records","approval_requests","approval_decisions","approval_consumes","approval_execution_attempts","approval_notifications","approval_presentation_updates"];
    const before=tables.map(table=>db.prepare(`SELECT * FROM ${table}`).all());
    assert.throws(()=>transaction.run("current",event,mark=>{
      if(target==="requests")insertRequest(db,"old");
      else if(target==="decisions")decision("old");
      else if(target==="notifications")notification("old");
      else if(target==="presentation_updates")db.exec("INSERT INTO approval_presentation_updates VALUES ('u1','n1','m1',2,'pending',0,'old')");
      else {
        db.prepare("INSERT INTO approval_consumes VALUES ('c1','r1','d1','approve','a1',?,?)").run(at,target==="consumes"?"old":mark.transaction_id);
        db.prepare("INSERT INTO approval_execution_attempts VALUES ('a1','r1','c1','claimed',1,?,?,?,NULL,NULL,?)")
          .run(at,"2026-09-19T00:05:00.000Z","2026-09-20T00:00:00.000Z",target==="execution_attempts"?"old":mark.transaction_id);
      }
    }),ApprovalTransactionError);
    assert.deepEqual(tables.map(table=>db.prepare(`SELECT * FROM ${table}`).all()),before);
    assert.equal(anchors.value.pending_transaction_id,"current");
  }
});

test("既存ledger更新は作成時の時計参照を保ったまま新しい監査に結ぶ", t => {
  const {db,transaction,audit}=setup(t);
  transaction.run("old",event,mark=>{insertRequest(db,mark.transaction_id);});
  transaction.run("current",event,()=>{db.exec("UPDATE approval_requests SET revision=2 WHERE request_id='r1'");});
  assert.deepEqual(db.prepare("SELECT revision,clock_transaction_id FROM approval_requests").get(),{revision:2,clock_transaction_id:"old"});
  assert.equal(count(db,"approval_clock_reservations"),2);
  assert.equal(audit.verify().sequence,2);
});
test("clock reservation・request・auditを同じtransactionへ結び、再open後も保持する", (t) => {
  const { db, filename, anchors, marks, transaction } = setup(t);
  const result = transaction.run("tx1", event, (mark) => {
    assert.equal(db.inTransaction, true);
    assert.equal(marks.value.transaction_id, mark.transaction_id);
    assert.equal(anchors.value.pending_transaction_id, mark.transaction_id);
    insertRequest(db, mark.transaction_id);
    return "r1";
  });
  assert.equal(result, "r1");
  assert.deepEqual(anchors.calls, ["reserve", "finalize"]);
  const peer = openSecurityDatabase(filename);
  try {
    assert.equal(new AuditRepository(peer, anchors, keys).verify().sequence, 1);
    const clock = peer
      .prepare("SELECT * FROM approval_clock_reservations")
      .get() as { transaction_id: string; mark_json: string };
    assert.equal(clock.transaction_id, "tx1");
    assert.deepEqual(JSON.parse(clock.mark_json), marks.value);
    assert.equal(count(peer, "approval_requests"), 1);
  } finally {
    peer.close();
  }
});
test("clockとauditのreserve失敗では業務rowをcommitせず再試行しない", (t) => {
  for (const fault of ["clock", "reserve_before", "reserve_after"]) {
    const { db, marks, anchors, transaction } = setup(t);
    if (fault === "clock") marks.fail = true;
    else anchors.fault = fault;
    let called = false;
    assert.throws(
      () =>
        transaction.run("tx1", event, () => {
          called = true;
        }),
      ApprovalTransactionError,
    );
    assert.equal(called, false);
    assert.equal(count(db, "approval_clock_reservations"), 0);
    assert.equal(count(db, "approval_requests"), 0);
    assert.equal(marks.calls, 1);
    assert.deepEqual(anchors.calls, fault === "clock" ? [] : ["reserve"]);
    if (fault !== "clock") assert.equal(marks.value.transaction_id, "tx1");
  }
});
test("業務失敗時はrequestとauditをrollbackし、保護reservationを取消しない", (t) => {
  const { db, marks, anchors, transaction } = setup(t);
  assert.throws(
    () =>
      transaction.run("tx1", event, (mark) => {
        insertRequest(db, mark.transaction_id);
        throw Error("private SQL context");
      }),
    ApprovalTransactionError,
  );
  for (const table of [
    "approval_requests",
    "approval_clock_reservations",
    "security_audit_records",
  ])
    assert.equal(count(db, table), 0);
  assert.equal(marks.value.transaction_id, "tx1");
  assert.equal(anchors.value.pending_transaction_id, "tx1");
  assert.deepEqual(anchors.calls, ["reserve"]);
});
test("finalize失敗を受理不明として扱い、commit済み業務を再実行しない", (t) => {
  for (const fault of ["finalize_before", "finalize_after"]) {
    const { db, anchors, transaction, audit } = setup(t);
    anchors.fault = fault;
    assert.throws(
      () =>
        transaction.run("tx1", event, (mark) =>
          insertRequest(db, mark.transaction_id),
        ),
      ApprovalTransactionError,
    );
    assert.equal(count(db, "approval_requests"), 1);
    assert.equal(count(db, "approval_clock_reservations"), 1);
    if (fault === "finalize_before") assert.throws(() => audit.verify());
    else assert.equal(audit.verify().sequence, 1);
    assert.deepEqual(anchors.calls, ["reserve", "finalize"]);
  }
});
test("durability不足・入れ子transaction・不正eventをclock write前に拒否する", (t) => {
  const { db, marks, transaction } = setup(t);
  db.pragma("synchronous=NORMAL");
  assert.throws(
    () => transaction.run("tx1", event, () => {}),
    ApprovalTransactionError,
  );
  db.pragma("synchronous=FULL");
  assert.throws(
    () =>
      db.transaction(() => transaction.run("tx1", event, () => {})).immediate(),
    ApprovalTransactionError,
  );
  assert.throws(
    () =>
      transaction.run(
        "tx1",
        { ...event, resource_id: "https://private.example" } as never,
        () => {},
      ),
    ApprovalTransactionError,
  );
  assert.equal(marks.calls, 0);
});
test("業務mutation中のclock driftではrollbackしaudit reservationを保持する", (t) => {
  const { db, marks, anchors, transaction } = setup(t);
  assert.throws(
    () =>
      transaction.run("tx1", event, (mark) => {
        insertRequest(db, mark.transaction_id);
        marks.value = { ...marks.value, transaction_id: "peer_tx" };
      }),
    ApprovalTransactionError,
  );
  assert.equal(count(db, "approval_requests"), 0);
  assert.equal(anchors.value.pending_transaction_id, "tx1");
});

test(
  "独立workerの並行runをclock予約前からaudit finalizeまで直列化する",
  { timeout: 5000 },
  async (t) => {
    const directory = fs.mkdtempSync(
      path.join(fs.realpathSync(os.homedir()), ".dona-approval-race-"),
    );
    const filename = path.join(directory, "dispatcher.sqlite");
    const storeFile = path.join(directory, "fixture-store.sqlite");
    fs.writeFileSync(filename, "", { mode: 0o600, flag: "wx" });
    const db = openSecurityDatabase(filename);
    db.pragma("journal_mode=WAL");
    db.pragma("synchronous=FULL");
    db.pragma("foreign_keys=ON");
    installAuditSchema(db);
    installApprovalSchema(db);
    initializeFixtureStore(storeFile);
    const stores = openFixtureStores(storeFile);
    const audit = new AuditRepository(db, stores.anchors, fixtureKeys);
    audit.initialize(fixtureCheckpoint);
    const barrier = new SharedArrayBuffer(4);
    const gate = new Int32Array(barrier);
    const workers = [1, 2].map(
      (ordinal) =>
        new Worker(
          new URL("./fixtures/transaction-worker.mjs", import.meta.url),
          {
            workerData: {
              database: filename,
              store: storeFile,
              ordinal,
              barrier,
            },
          },
        ),
    );
    t.after(async () => {
      await Promise.all(workers.map((worker) => worker.terminate()));
      stores.close();
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    let ready = 0;
    const clockViews: Array<{ sequence: number; pending: string | null }> = [];
    const results = await Promise.all(
      workers.map(
        (worker) =>
          new Promise<{ success: boolean; error?: string }>(
            (resolve, reject) => {
              let result: { success: boolean; error?: string } | undefined;
              worker.on("error", reject);
              worker.on("message", (message) => {
                if (message.kind === "ready" && ++ready === 2) {
                  Atomics.store(gate, 0, 1);
                  Atomics.notify(gate, 0, 2);
                } else if (message.kind === "clock") clockViews.push(message);
                else if (message.kind === "done") result = message;
              });
              worker.on("exit", (code) => {
                if (code === 0 && result) resolve(result);
                else reject(new Error("fixture_worker_incomplete"));
              });
            },
          ),
      ),
    );
    assert.equal(
      results.every((result) => result.success),
      true,
      JSON.stringify(results),
    );
    assert.deepEqual(clockViews.map((view) => view.sequence).sort(), [0, 1]);
    assert.equal(
      clockViews.every((view) => view.pending === null),
      true,
    );
    assert.equal(audit.verify().sequence, 2);
    assert.equal(count(db, "approval_requests"), 2);
    assert.equal(count(db, "approval_clock_reservations"), 2);
    assert.equal(
      fs.statSync(filename + ".security-lock.sqlite").mode & 0o777,
      0o600,
    );
  },
);

test("共通lockは再入・不正権限・別用途fileを拒否し、既存dataを上書きしない", (t) => {
  const { db, filename } = setup(t);
  withSecurityTransactionLock(db, () => {
    assert.throws(
      () => withSecurityTransactionLock(db, () => null),
      SecurityCoordinationError,
    );
  });
  assert.equal(
    withSecurityTransactionLock(db, () => "next"),
    "next",
  );
  const alias = filename + ".alias";
  fs.linkSync(filename, alias);
  try {
    assert.throws(
      () => withSecurityTransactionLock(db, () => null),
      SecurityCoordinationError,
    );
  } finally {
    fs.unlinkSync(alias);
  }
  fs.chmodSync(filename, 0o640);
  assert.throws(
    () => withSecurityTransactionLock(db, () => null),
    SecurityCoordinationError,
  );
  fs.chmodSync(filename, 0o600);
  const other = setup(t);
  const lockPath = other.filename + ".security-lock.sqlite";
  const foreign = new Database(lockPath);
  foreign.exec(
    "CREATE TABLE sqliteXunrelated (id TEXT); INSERT INTO sqliteXunrelated VALUES ('original')",
  );
  foreign.close();
  fs.chmodSync(lockPath, 0o600);
  assert.throws(
    () => withSecurityTransactionLock(other.db, () => null),
    SecurityCoordinationError,
  );
  const reopened = new Database(lockPath, { readonly: true });
  try {
    assert.deepEqual(reopened.prepare("SELECT * FROM sqliteXunrelated").all(), [
      { id: "original" },
    ]);
  } finally {
    reopened.close();
  }
});

test("lock fileのsymlinkを開かず、deferred callbackを完了扱いしない", (t) => {
  const { db, filename } = setup(t);
  const destination = path.join(path.dirname(filename), "unrelated.txt");
  fs.writeFileSync(destination, "original", { mode: 0o600 });
  fs.symlinkSync(destination, filename + ".security-lock.sqlite");
  assert.throws(
    () => withSecurityTransactionLock(db, () => null),
    SecurityCoordinationError,
  );
  assert.equal(fs.readFileSync(destination, "utf8"), "original");
  const other = setup(t);
  assert.throws(
    () => withSecurityTransactionLock(other.db, (async () => null) as never),
    SecurityCoordinationError,
  );
  assert.equal(
    withSecurityTransactionLock(other.db, () => "next"),
    "next",
  );
});

test(
  "lock保持processが終了しても手動file削除なしで次のtransactionを開始できる",
  { timeout: 5000 },
  async (t) => {
    const { db, filename, transaction, audit } = setup(t);
    const child = fork(
      new URL("./fixtures/coordination-crash.mjs", import.meta.url),
      [filename],
      { execArgv: [], stdio: "ignore" },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 79);
    transaction.run("after_crash", event, (mark) =>
      insertRequest(db, mark.transaction_id),
    );
    assert.equal(audit.verify().sequence, 1);
    assert.equal(count(db, "approval_requests"), 1);
  },
);

test("DB接続前にsymlinkと不正ancestorを拒否し、接続後のinode差替えも検出する", (t) => {
  const { db, filename } = setup(t);
  const dir = path.dirname(filename);
  const fileLink = filename + ".symlink";
  fs.symlinkSync(filename, fileLink);
  assert.throws(
    () => openSecurityDatabase(fileLink),
    SecurityCoordinationError,
  );
  const linked = new Database(fileLink);
  try {
    const other = setup(t);
    fs.unlinkSync(fileLink);
    fs.symlinkSync(other.filename, fileLink);
    assert.throws(
      () => withSecurityTransactionLock(linked, () => null),
      SecurityCoordinationError,
    );
  } finally {
    linked.close();
    fs.unlinkSync(fileLink);
  }
  const directoryLink = dir + ".symlink";
  fs.symlinkSync(dir, directoryLink);
  try {
    assert.throws(
      () =>
        openSecurityDatabase(path.join(directoryLink, path.basename(filename))),
      SecurityCoordinationError,
    );
  } finally {
    fs.unlinkSync(directoryLink);
  }
  fs.chmodSync(dir, 0o777);
  try {
    assert.throws(
      () => openSecurityDatabase(filename),
      SecurityCoordinationError,
    );
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  const unsafeAncestor = path.join(dir, "writable");
  const privateChild = path.join(unsafeAncestor, "private");
  fs.mkdirSync(unsafeAncestor);
  fs.chmodSync(unsafeAncestor, 0o777);
  fs.mkdirSync(privateChild, { mode: 0o700 });
  const nestedFile = path.join(privateChild, "fixture.sqlite");
  fs.writeFileSync(nestedFile, "", { mode: 0o600, flag: "wx" });
  assert.throws(
    () => openSecurityDatabase(nestedFile),
    SecurityCoordinationError,
  );
  const plain = new Database(filename);
  try {
    assert.throws(
      () => withSecurityTransactionLock(plain, () => null),
      SecurityCoordinationError,
    );
  } finally {
    plain.close();
  }
  const moved = filename + ".original";
  fs.renameSync(filename, moved);
  fs.writeFileSync(filename, "", { mode: 0o600, flag: "wx" });
  let ran = false;
  try {
    assert.throws(
      () =>
        withSecurityTransactionLock(db, () => {
          ran = true;
        }),
      SecurityCoordinationError,
    );
  } finally {
    fs.unlinkSync(filename);
    fs.renameSync(moved, filename);
  }
  assert.equal(ran, false);
  assert.equal(
    withSecurityTransactionLock(db, () => "unchanged"),
    "unchanged",
  );
});

test("型を消したasync callbackもclockとauditの予約前に実行せず拒否する", async (t) => {
  const { db, transaction, audit, marks, anchors } = setup(t);
  let effects = 0;
  const deferred = async () => {
    effects++;
    await Promise.resolve();
    effects++;
  };
  const generator = function* () {
    effects++;
    yield null;
    effects++;
  };
  const asyncGenerator = async function* () {
    effects++;
    yield null;
    effects++;
  };
  for (const callback of [
    deferred,
    deferred.bind(null),
    generator,
    generator.bind(null),
    asyncGenerator,
    asyncGenerator.bind(null),
  ]) {
    assert.throws(
      () => withSecurityTransactionLock(db, callback as never),
      SecurityCoordinationError,
    );
    assert.throws(
      () => transaction.run("async_tx", event, callback as never),
      ApprovalTransactionError,
    );
    assert.throws(() =>
      audit.append(
        "async_audit",
        1,
        { ...event, occurred_at: "2026-09-19T00:00:01.000Z" },
        callback as never,
      ),
    );
  }
  await Promise.resolve();
  assert.equal(effects, 0);
  assert.equal(marks.calls, 0);
  assert.deepEqual(anchors.calls, []);
  assert.equal(audit.verify().sequence, 0);
});

test("pathnameが元へ戻るABAでも開いたSQLite fileの不一致を拒否する", (t) => {
  const dir = fs.mkdtempSync(
    path.join(fs.realpathSync(os.homedir()), ".dona-approval-aba-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, "a.sqlite");
  const second = path.join(dir, "b.sqlite");
  const moved = path.join(dir, "a.moved");
  for (const [file, marker] of [
    [filename, "A"],
    [second, "B"],
  ] as const) {
    const connection = new Database(file);
    try {
      connection.exec("CREATE TABLE marker(value TEXT)");
      connection.prepare("INSERT INTO marker VALUES (?)").run(marker);
    } finally {
      connection.close();
    }
    fs.chmodSync(file, 0o600);
  }
  let phase = 0;
  const original = fs.lstatSync;
  const mocked = t.mock.method(fs, "lstatSync", ((
    ...args: Parameters<typeof fs.lstatSync>
  ) => {
    if (phase === 1 && args[0] === filename) {
      fs.renameSync(filename, second);
      fs.renameSync(moved, filename);
      phase = 2;
    }
    const result = original(...args);
    if (phase === 0 && args[0] === path.parse(filename).root) {
      fs.renameSync(filename, moved);
      fs.renameSync(second, filename);
      phase = 1;
    }
    return result;
  }) as typeof fs.lstatSync);
  try {
    assert.throws(
      () => openSecurityDatabase(filename),
      SecurityCoordinationError,
    );
  } finally {
    mocked.mock.restore();
    if (phase === 1) {
      fs.renameSync(filename, second);
      fs.renameSync(moved, filename);
    }
  }
  assert.equal(phase, 2);
  const accepted = openSecurityDatabase(filename);
  try {
    assert.deepEqual(accepted.prepare("SELECT value FROM marker").get(), {
      value: "A",
    });
  } finally {
    accepted.close();
  }
});

test("型を消した通常関数が返すiteratorもtransaction外へ返さない", (t) => {
  for (const kind of ["lock", "audit", "approval"] as const) {
    const { db, transaction, audit, marks, anchors } = setup(t);
    let effects = 0;
    const callback = () =>
      (function* () {
        effects++;
        yield "later";
      })();
    assert.throws(() =>
      kind === "lock"
        ? withSecurityTransactionLock(db, callback as never)
        : kind === "audit"
          ? audit.append(
              "iterator_tx",
              1,
              { ...event, occurred_at: "2026-09-19T00:00:01.000Z" },
              callback as never,
            )
          : transaction.run("iterator_tx", event, callback as never),
    );
    assert.equal(effects, 0);
    assert.equal(count(db, "approval_clock_reservations"), 0);
    assert.equal(count(db, "security_audit_records"), 0);
    assert.equal(marks.calls, kind === "approval" ? 1 : 0);
    assert.equal(
      anchors.value.pending_transaction_id,
      kind === "lock" ? null : "iterator_tx",
    );
  }
});

test("iterable wrapperの遅延処理を実行せず戻り値とSQL commitを拒否する", (t) => {
  for (const kind of ["lock", "audit", "approval"] as const) {
    for (const asynchronous of [false, true]) {
      const { db, transaction, audit, anchors } = setup(t);
      let effects = 0;
      const wrapper = asynchronous
        ? { async *[Symbol.asyncIterator]() { effects++; yield "later"; } }
        : { *[Symbol.iterator]() { effects++; yield "later"; } };
      const callback = () => wrapper;
      assert.throws(() => kind === "lock"
        ? withSecurityTransactionLock(db, callback as never)
        : kind === "audit"
          ? audit.append("wrapper_tx", 1, { ...event, occurred_at: "2026-09-19T00:00:01.000Z" }, callback as never)
          : transaction.run("wrapper_tx", event, callback as never));
      assert.equal(effects, 0);
      assert.equal(count(db, "approval_clock_reservations"), 0);
      assert.equal(count(db, "security_audit_records"), 0);
      assert.equal(anchors.value.pending_transaction_id, kind === "lock" ? null : "wrapper_tx");
    }
  }
});

test("配列・record内の遅延値とgetter/proxyを実行せず拒否する", (t) => {
  for (const kind of ["lock", "audit", "approval"] as const) {
    for (const deferred of ["function", "promise", "getter", "proxy", "cycle"] as const) {
      const { db, transaction, audit } = setup(t); let effects = 0;
      const bad = deferred === "function" ? () => { effects++; }
        : deferred === "promise" ? Promise.resolve("already-resolved")
          : deferred === "getter" ? Object.defineProperty({}, "value", { get() { effects++; return "later"; } })
            : deferred === "proxy" ? new Proxy({}, { ownKeys() { effects++; return []; } }) : [];
      if (deferred === "cycle") (bad as unknown[]).push(bad);
      const callback = () => ({ rows: [{ nested: [bad] }] });
      assert.throws(() => kind === "lock" ? withSecurityTransactionLock(db, callback as never)
        : kind === "audit" ? audit.append("nested_tx", 1, { ...event, occurred_at: "2026-09-19T00:00:01.000Z" }, callback as never)
          : transaction.run("nested_tx", event, callback as never));
      assert.equal(effects, 0);
      assert.equal(count(db, "approval_clock_reservations"), 0); assert.equal(count(db, "security_audit_records"), 0);
    }
  }
  const { db } = setup(t);
  assert.deepEqual(withSecurityTransactionLock(db, () => ({ rows: [{ id: "plain", counts: [1, 2] }] })), { rows: [{ id: "plain", counts: [1, 2] }] });
});

test("mutex pathのhardlinkへ初期化SQLを書かない", (t) => {
  const { db, transaction, marks, anchors } = setup(t);
  const victim = db.name + ".unrelated";
  const lock = db.name + ".security-lock.sqlite";
  fs.writeFileSync(victim, "", { mode: 0o600 }); fs.linkSync(victim, lock);
  assert.throws(() => transaction.run("hardlink_mutex", event, () => {}));
  assert.equal(fs.statSync(victim).size, 0); assert.equal(fs.statSync(lock).nlink, 2);
  assert.equal(marks.calls, 0); assert.equal(anchors.value.pending_transaction_id, null);
});

test("callable Proxyとtag getterをcallback検査で実行しない", async (t) => {
  for (const kind of ["lock", "audit", "approval"] as const) {
    for (const disguise of ["proxy", "getter", "prototype_proxy"] as const) {
      const { db, transaction, audit, marks, anchors } = setup(t); let effects = 0;
      const asynchronous = async () => { effects++; await Promise.resolve(); effects++; };
      const callback = disguise === "proxy" ? new Proxy(asynchronous, { get() { effects++; return "Function"; }, apply() { effects++; return asynchronous(); } })
        : () => { effects++; };
      if (disguise === "getter") Object.defineProperty(callback, Symbol.toStringTag, { get() { effects++; return "Function"; } });
      if (disguise === "prototype_proxy") Object.setPrototypeOf(callback, new Proxy(Function.prototype, { get() { effects++; return "Function"; } }));
      assert.throws(() => kind === "lock" ? withSecurityTransactionLock(db, callback as never)
        : kind === "audit" ? audit.append("proxy_tx", 1, { ...event, occurred_at: "2026-09-19T00:00:01.000Z" }, callback as never)
          : transaction.run("proxy_tx", event, callback as never));
      await Promise.resolve();
      assert.equal(effects, 0); assert.equal(marks.calls, 0); assert.equal(anchors.value.pending_transaction_id, null);
      assert.equal(count(db, "security_audit_records"), 0);
    }
  }
});

test("prepare済みSQLもcallback内のtransaction切替・pragma・DDLを実行できない", t => {
  for (const sql of ["COMMIT", "ROLLBACK", "SAVEPOINT guard_point", "PRAGMA ignore_check_constraints=ON",
    "PRAGMA recursive_triggers=OFF", "PRAGMA writable_schema=ON",
    "CREATE TRIGGER inject AFTER INSERT ON ordinary BEGIN UPDATE approval_requests SET state='approved'; END"] ) {
    for (const mode of (sql.startsWith("PRAGMA") ? ["exec", "prepare"] : ["exec", "prepare", "precompiled"])) {
      const { db, transaction, anchors } = setup(t);
      db.exec("CREATE TABLE ordinary(id TEXT)");
      const statement = mode === "precompiled" ? db.prepare(sql) : undefined;
      assert.throws(() => transaction.run("guard_tx", event, mark => {
        insertRequest(db, mark.transaction_id);
        if (statement) statement.run(); else if (mode === "prepare") db.prepare(sql).run(); else db.exec(sql);
        db.exec("BEGIN");
      }), ApprovalTransactionError);
      assert.equal(db.inTransaction, false);
      assert.equal(count(db, "approval_requests"), 0);
      assert.equal(count(db, "security_audit_records"), 0);
      assert.deepEqual(anchors.calls, ["reserve"]);
      assert.equal(anchors.value.pending_transaction_id, "guard_tx");
      assert.equal(db.pragma("ignore_check_constraints", { simple: true }), 0);
      verifyApprovalSchema(db);
    }
  }
});

test("別tableの非prefix triggerとCHECK無効化はclock予約前に拒否する", t => {
  for (const kind of ["main", "temp", "checks"] as const) {
    const { db, transaction, audit, marks, anchors } = setup(t);
    if (kind === "checks") db.pragma("ignore_check_constraints=ON");
    else db.exec(`CREATE TABLE ordinary(id TEXT); CREATE ${kind === "temp" ? "TEMP " : ""}TRIGGER inject AFTER INSERT ON ordinary BEGIN UPDATE approval_requests SET state='approved'; END`);
    assert.throws(() => verifyApprovalSchema(db));
    assert.throws(() => audit.verify());
    assert.throws(() => transaction.run("unsafe_schema", event, () => {}));
    assert.equal(marks.calls, 0); assert.deepEqual(anchors.calls, []);
  }
});

test("callbackはSQL guardを別tokenで解除できず監査rowも変更できない", t => {
  for (const operation of ["disable", "audit_write"] as const) {
    const { db, transaction, anchors } = setup(t);
    assert.throws(() => transaction.run("guard_tx", event, mark => {
      insertRequest(db, mark.transaction_id);
      if (operation === "disable") db.prepare("SELECT dona_mutation_guard(zeroblob(32),0)").get();
      else db.exec("DELETE FROM security_audit_records");
    }));
    assert.equal(count(db, "approval_requests"), 0); assert.equal(count(db, "security_audit_records"), 0);
    assert.deepEqual(anchors.calls, ["reserve"]);
  }
});


async function holdPeerMutex(t: { after(fn: () => unknown): void }, filename: string, milliseconds: number) {
  const child = fork(new URL("./fixtures/coordination-hold.mjs", import.meta.url), [filename, String(milliseconds)],
    { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
  await Promise.race([
    new Promise<void>(resolve => child.once("message", message => { assert.deepEqual(message, { kind: "locked" }); resolve(); })),
    exited.then(() => { throw new Error("fixture_exited_before_lock"); }),
  ]);
  return { child, exited };
}

test("設定した待機期限内なら2秒を超える先行transactionの完了後に実行する", { timeout: 10000 }, async t => {
  const { db, filename, transaction, anchors, marks } = setup(t, 5000);
  const peer = await holdPeerMutex(t, filename, 2600);
  const started = performance.now();
  transaction.run("after_slow_peer", event, mark => insertRequest(db, mark.transaction_id));
  assert.ok(performance.now() - started >= 2000);
  assert.deepEqual(anchors.calls, ["reserve", "finalize"]); assert.equal(marks.calls, 1);
  assert.equal(count(db, "approval_requests"), 1); assert.equal(await peer.exited, 0);
});

test("mutex取得前のbusyは予約0件として区別し、取得後のbusyを再試行可能にしない", { timeout: 10000 }, async t => {
  const { db, filename, transaction, anchors, marks } = setup(t, 10);
  const peer = await holdPeerMutex(t, filename, 5000);
  assert.throws(() => transaction.run("busy_then_retry", event, () => {}), ApprovalTransactionBusyError);
  assert.deepEqual(anchors.calls, []); assert.equal(marks.calls, 0);
  assert.equal(count(db, "security_audit_records"), 0);
  peer.child.kill(); await peer.exited;
  transaction.run("busy_then_retry", event, mark => insertRequest(db, mark.transaction_id));
  assert.deepEqual(anchors.calls, ["reserve", "finalize"]);
  const other = setup(t, 10);
  assert.throws(() => other.transaction.run("inner_busy", event, () => { throw Object.assign(new Error("fixture"), { code: "SQLITE_BUSY" }); }), ApprovalTransactionError);
  assert.deepEqual(other.anchors.calls, ["reserve"]); assert.equal(other.anchors.value.pending_transaction_id, "inner_busy");
});

test("不正または過大な待機期限はclock予約前に拒否する", t => {
  for (const wait of [-1, 0.5, 30001, Number.NaN, Infinity]) {
    const { transaction, anchors, marks } = setup(t, wait);
    assert.throws(() => transaction.run("invalid_wait", event, () => {}), ApprovalTransactionError);
    assert.deepEqual(anchors.calls, []); assert.equal(marks.calls, 0);
  }
});


test("mutex公開の直前・直後にprocessが終了しても次processが再取得できる", {timeout:10000}, async t => {
  for(const phase of ["before","after"]) {
    const {db,filename,transaction}=setup(t);
    const child=fork(new URL("./fixtures/coordination-publication-crash.mjs",import.meta.url),[filename,phase],{execArgv:[],stdio:"ignore"});
    t.after(()=>{if(child.exitCode===null)child.kill();});
    const code=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("exit",resolve);});
    assert.equal(code,phase==="before"?80:81);
    const lock=filename+".security-lock.sqlite";
    if(phase==="after")assert.equal(fs.statSync(lock).nlink,1);
    transaction.run("after_publication_crash",event,mark=>insertRequest(db,mark.transaction_id));
    assert.equal(fs.statSync(lock).nlink,1);assert.equal(count(db,"approval_requests"),1);
  }
});

test("mutexのexclusive renameは既存fileを置換せずcallbackから呼べない",t=>{
  const {db,filename,transaction}=setup(t);
  const source=filename+".stage";const target=filename+".target";
  fs.writeFileSync(source,"stage",{mode:0o600});fs.writeFileSync(target,"original",{mode:0o600});
  publishMutexFile(db,source,target);assert.equal(fs.readFileSync(target,"utf8"),"original");assert.equal(fs.readFileSync(source,"utf8"),"stage");
  const fresh=filename+".fresh";publishMutexFile(db,source,fresh);assert.equal(fs.existsSync(source),false);assert.equal(fs.statSync(fresh).nlink,1);
  fs.writeFileSync(source,"another",{mode:0o600});
  assert.throws(()=>transaction.run("rename_in_callback",event,()=>{db.prepare("SELECT DONA_PUBLISH_MUTEX(?,?)").get(source,filename+".forbidden");}));
  assert.equal(fs.existsSync(filename+".forbidden"),false);assert.equal(fs.readFileSync(source,"utf8"),"another");
});


test("非WAL journal modeはclockとaudit予約前に拒否し設定を変更しない", t => {
  for(const mode of ["OFF","MEMORY","DELETE","TRUNCATE","PERSIST"]) {
    const {db,transaction,marks,anchors}=setup(t);db.unsafeMode(true);db.pragma("journal_mode="+mode);
    assert.throws(()=>transaction.run("bad_journal",event,()=>{}),ApprovalTransactionError);
    assert.equal(db.pragma("journal_mode",{simple:true}),mode.toLowerCase());
    assert.equal(marks.calls,0);assert.deepEqual(anchors.calls,[]);
    assert.equal(count(db,"approval_clock_reservations"),0);assert.equal(count(db,"security_audit_records"),0);
  }
});
