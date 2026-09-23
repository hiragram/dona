import { parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
import { openSecurityDatabase } from "../../../src/audit/coordination.js";
import { ApprovalTransaction } from "../../../src/approval/transaction.js";
import { fixtureKeys, openFixtureStores } from "./transaction-store.js";
const input = workerData as {
  database: string;
  store: string;
  ordinal: number;
  barrier: SharedArrayBuffer;
};
const db = openSecurityDatabase(input.database);
db.pragma("foreign_keys=ON");
db.pragma("synchronous=FULL");
const stores = openFixtureStores(input.store, () => {
  const anchor = stores.anchors.read();
  parentPort!.postMessage({
    kind: "clock",
    ordinal: input.ordinal,
    sequence: anchor.sequence,
    pending: anchor.pending_transaction_id,
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
});
try {
  const gate = new Int32Array(input.barrier);
  parentPort!.postMessage({ kind: "ready" });
  while (Atomics.load(gate, 0) === 0) Atomics.wait(gate, 0, 0, 2000);
  const transaction = new ApprovalTransaction(db, {
    clockMarks: stores.marks,
    auditAnchors: stores.anchors,
    auditKeys: fixtureKeys,
    auditSigningKeyVersion: 1,
    maximumClockDriftMs: 1000,
    clock: {
      observe: () => {
        const previous = stores.marks.read();
        return {
          boot_id: previous.boot_id,
          continuous_ms: previous.continuous_ms + 1,
          wall_utc: new Date(
            Date.parse(previous.effective_utc) + 1,
          ).toISOString(),
        };
      },
    },
  });
  const id = "request_" + input.ordinal;
  transaction.run(
    "transaction_" + input.ordinal,
    {
      scope: { instance_id: "i1", tenant_id: "w1" },
      actor: { kind: "system", id: "dispatcher" },
      action: "approval_request",
      operation: "slack.post_thread_reply.v1",
      resource_id: id,
      outcome: "pending",
      reason: "none",
      session_ref: null,
      receipt_id: null,
      attempt_id: null,
      policy_revision: 1,
      binding_revision: 1,
      authz_revision: 1,
    },
    (mark) => {
      const snapshot = JSON.stringify({
        codec_version: 1,
        operation_kind: "slack.post_thread_reply.v1",
        instance_id: "i1",
        workspace_id: "w1",
        policy_revision: 1,
      });
      db.prepare(
        "INSERT INTO approval_requests VALUES (?,'i1','w1',?,?,?,'b1',1,1,'model1','requested',1,?, ?,NULL,?)",
      ).run(
        id,
        createHash("sha256").update(id).digest("hex"),
        snapshot,
        "a".repeat(64),
        mark.effective_utc,
        "2026-09-19T00:15:00.000Z",
        mark.transaction_id,
      );
    },
  );
  parentPort!.postMessage({
    kind: "done",
    ordinal: input.ordinal,
    success: true,
  });
} catch (error) {
  parentPort!.postMessage({
    kind: "done",
    ordinal: input.ordinal,
    success: false,
    error: error instanceof Error ? error.name : "unknown",
  });
} finally {
  db.close();
  stores.close();
}
