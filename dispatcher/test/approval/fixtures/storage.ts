import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSecurityDatabase } from "../../../src/audit/coordination.js";
import { AuditRepository, installAuditSchema, type AuditAnchorStore } from "../../../src/audit/repository.js";
import { signAuditCheckpoint, type AuditAnchor, type AuditKey } from "../../../src/audit/codec.js";
import { installApprovalSchema } from "../../../src/approval/schema.js";
import { ApprovalTransaction, type ApprovalTransactionProviders } from "../../../src/approval/transaction.js";
import type { ClockMark, ClockMarkStore } from "../../../src/approval/clock.js";

export const scope = { instance_id: "instance", tenant_id: "tenant" };
const start = "2026-09-19T00:00:00.000Z";
const key: AuditKey = { version: 1, purpose: "audit", state: "active", activated_at: "2026-09-01T00:00:00.000Z", signing_expires_at: "2026-11-01T00:00:00.000Z", secret: Buffer.alloc(32, 0x45) };
const keys = (version: number) => version === 1 ? key : undefined;
const genesis = signAuditCheckpoint({ codec_version: 1, chain_id: "approval_fixture", transaction_id: "genesis", signed_at: start, key_version: 1 }, keys);
class Anchors implements AuditAnchorStore {
 value: AuditAnchor = { chain_id: "approval_fixture", sequence: 0, mac: "0".repeat(64), checkpoint_mac: genesis.mac, pending_transaction_id: null };
 fault: "none" | "reserve_before" | "reserve_after" | "finalize_before" | "finalize_after" = "none";
 calls: string[] = []; used = new Set<string>();
 read() { return structuredClone(this.value); }
 reserve(expected: AuditAnchor, proposed: AuditAnchor) {
  this.calls.push("reserve"); assert.deepEqual(expected, this.value);
  if (this.fault === "reserve_before") throw Error("fixture reserve failed");
  assert.ok(proposed.pending_transaction_id && !this.used.has(proposed.pending_transaction_id)); this.used.add(proposed.pending_transaction_id);
  this.value = structuredClone(proposed); if (this.fault === "reserve_after") throw Error("fixture response lost"); return this.read();
 }
 finalize(expected: AuditAnchor) {
  this.calls.push("finalize"); assert.deepEqual(expected, this.value); if (this.fault === "finalize_before") throw Error("fixture finalize failed");
  this.value = { ...this.value, pending_transaction_id: null }; if (this.fault === "finalize_after") throw Error("fixture response lost"); return this.read();
 }
}
class Marks implements ClockMarkStore {
 value: ClockMark = { codec_version: 1, transaction_id: "initial_mark", previous_transaction_id: null, boot_id: "fixture_boot", continuous_ms: 1000, effective_utc: start };
 used = new Set<string>(["initial_mark"]);
 read() { return structuredClone(this.value); }
 reserve(expected: ClockMark, proposed: ClockMark) { assert.deepEqual(expected, this.value); assert.ok(!this.used.has(proposed.transaction_id)); this.used.add(proposed.transaction_id); this.value = structuredClone(proposed); return this.read(); }
}
export function setup(t: { after(fn: () => void): void }) {
 const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.homedir()), ".dona-approval-storage-fixture-"));
 const filename = path.join(directory, "fixture.sqlite"); fs.writeFileSync(filename, "", { mode: 0o600, flag: "wx" });
 const db = openSecurityDatabase(filename); db.pragma("journal_mode=WAL"); db.pragma("foreign_keys=ON"); db.pragma("synchronous=FULL");
 installAuditSchema(db); installApprovalSchema(db);
 const anchors = new Anchors(), marks = new Marks(); let now = Date.parse(start);
 const providers: ApprovalTransactionProviders = { clock: { observe: () => ({ boot_id: "fixture_boot", wall_utc: new Date(now).toISOString(), continuous_ms: 1000 + now - Date.parse(start) }) }, clockMarks: marks, auditAnchors: anchors, auditKeys: keys, auditSigningKeyVersion: 1, maximumClockDriftMs: 1000 };
 const audit = new AuditRepository(db, anchors, keys); audit.initialize(genesis);
 const transaction = new ApprovalTransaction(db, providers);
 t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
 return { db, filename, providers, audit, anchors, marks, transaction, setNow: (value: string) => { now = Date.parse(value); } };
}
