import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  signAuditCheckpoint,
  type AuditAnchor,
  type AuditKey,
} from "../../../src/audit/codec.js";
import type { AuditAnchorStore } from "../../../src/audit/repository.js";
import type { ClockMark, ClockMarkStore } from "../../../src/approval/clock.js";

// Test-only shared CAS store: ordinary SQLite is NOT a rollback-resistant
// production credential store. These fixed bytes are fixture keys only.
export const fixtureKey: AuditKey = {
  version: 1,
  purpose: "audit",
  state: "active",
  activated_at: "2026-09-01T00:00:00.000Z",
  signing_expires_at: "2026-11-01T00:00:00.000Z",
  secret: Buffer.alloc(32, 23),
};
export const fixtureKeys = (version: number) =>
  version === 1 ? fixtureKey : undefined;
export const fixtureCheckpoint = signAuditCheckpoint(
  {
    codec_version: 1,
    chain_id: "race_chain",
    transaction_id: "genesis",
    signed_at: "2026-09-19T00:00:00.000Z",
    key_version: 1,
  },
  fixtureKeys,
);
export function initializeFixtureStore(filename: string): void {
  const db = new Database(filename);
  try {
    db.exec(
      "CREATE TABLE state (kind TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE used (kind TEXT,tx TEXT,PRIMARY KEY(kind,tx))",
    );
    const put = db.prepare("INSERT INTO state VALUES (?,?)");
    put.run(
      "audit",
      JSON.stringify({
        chain_id: "race_chain",
        sequence: 0,
        mac: "0".repeat(64),
        checkpoint_mac: fixtureCheckpoint.mac,
        pending_transaction_id: null,
      }),
    );
    put.run(
      "clock",
      JSON.stringify({
        codec_version: 1,
        transaction_id: "clock_genesis",
        previous_transaction_id: null,
        boot_id: "boot1",
        continuous_ms: 1000,
        effective_utc: "2026-09-19T00:00:00.000Z",
      }),
    );
    db.exec("INSERT INTO used VALUES ('clock','clock_genesis')");
  } finally {
    db.close();
  }
}
export function openFixtureStores(
  filename: string,
  afterClock: () => void = () => {},
) {
  const db = new Database(filename);
  db.pragma("busy_timeout=2000");
  function read<T>(kind: string): T {
    return JSON.parse(
      (
        db.prepare("SELECT value FROM state WHERE kind=?").get(kind) as {
          value: string;
        }
      ).value,
    ) as T;
  }
  function reserve<T>(kind: string, expected: T, proposed: T, tx: string): T {
    return db
      .transaction(() => {
        assert.deepEqual(read(kind), expected);
        db.prepare("INSERT INTO used VALUES (?,?)").run(kind, tx);
        db.prepare("UPDATE state SET value=? WHERE kind=?").run(
          JSON.stringify(proposed),
          kind,
        );
        return read<T>(kind);
      })
      .immediate();
  }
  const anchors: AuditAnchorStore = {
    read: () => read<AuditAnchor>("audit"),
    reserve: (expected, proposed) =>
      reserve("audit", expected, proposed, proposed.pending_transaction_id!),
    finalize: (reserved) =>
      db
        .transaction(() => {
          assert.deepEqual(read("audit"), reserved);
          const final = { ...reserved, pending_transaction_id: null };
          db.prepare("UPDATE state SET value=? WHERE kind='audit'").run(
            JSON.stringify(final),
          );
          return final;
        })
        .immediate(),
  };
  const marks: ClockMarkStore = {
    read: () => read<ClockMark>("clock"),
    reserve: (expected, proposed) => {
      const result = reserve(
        "clock",
        expected,
        proposed,
        proposed.transaction_id,
      );
      afterClock();
      return result;
    },
  };
  return { anchors, marks, close: () => db.close() };
}
