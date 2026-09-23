import assert from "node:assert/strict";
import test from "node:test";
import { advanceClockMark, reserveClockMark, approvalExpiry, approvalExpired, clockFailureDisposition,
  ApprovalClockError, type ClockMark, type ClockObservation, type ClockMarkStore } from "../../src/approval/clock.js";

const initial: ClockMark = { codec_version: 1, transaction_id: "clock_genesis", previous_transaction_id: null,
  boot_id: "boot_a", continuous_ms: 1000, effective_utc: "2026-09-19T00:00:00.000Z" };
const observation: ClockObservation = { boot_id: "boot_a", continuous_ms: 2000, wall_utc: "2026-09-19T00:00:01.000Z" };
class MarkFixture implements ClockMarkStore {
  value = structuredClone(initial); reserves = 0; used = new Set([initial.transaction_id]); mode: "ok" | "before" | "after" | "stale" = "ok";
  read() { return structuredClone(this.value); }
  reserve(expected: ClockMark, proposed: ClockMark) {
    this.reserves++; assert.deepEqual(expected, this.value);
    if (this.mode === "before") throw new Error("fixture unavailable");
    if (this.mode === "stale") return expected;
    if (this.used.has(proposed.transaction_id)) throw new Error("fixture transaction already used");
    this.used.add(proposed.transaction_id);
    this.value = structuredClone(proposed);
    if (this.mode === "after") throw new Error("fixture response lost");
    return this.read();
  }
}
test("UTCとsuspendを含むcontinuous経過の大きい方を使い、再起動でもmarkを継承する", () => {
  const store = new MarkFixture();
  const first = reserveClockMark(store, { observe: () => observation }, "tx_1", 1000);
  assert.equal(first.effective_utc, observation.wall_utc); assert.equal(store.reserves, 1);
  const later = advanceClockMark(store.read(), { ...observation, continuous_ms: 302000, wall_utc: "2026-09-19T00:05:00.500Z" }, "tx_2", 1000);
  assert.equal(later.effective_utc, "2026-09-19T00:05:01.000Z");
  assert.equal(later.previous_transaction_id, first.transaction_id);
  const wallAhead = advanceClockMark(initial, { ...observation, wall_utc: "2026-09-19T00:00:01.500Z" }, "tx_3", 1000);
  assert.equal(wallAhead.effective_utc, "2026-09-19T00:00:01.500Z");
});
test("boot変更、continuous巻戻り、wall巻戻り、過剰driftは予約前に拒否する", () => {
  const invalid = [
    { ...observation, boot_id: "boot_b" }, { ...observation, continuous_ms: 999 },
    { ...observation, wall_utc: "2026-09-18T23:59:59.999Z" },
    { ...observation, wall_utc: "2026-09-19T00:00:03.001Z" },
    { ...observation, continuous_ms: 0.5 }, { ...observation, wall_utc: "invalid" },
  ];
  for (const value of invalid) {
    const store = new MarkFixture();
    assert.throws(() => reserveClockMark(store, { observe: () => value }, "tx_1", 1000), ApprovalClockError);
    assert.equal(store.reserves, 0); assert.deepEqual(store.read(), initial);
  }
  assert.throws(() => advanceClockMark(initial, observation, initial.transaction_id, 1000), ApprovalClockError);
  assert.throws(() => advanceClockMark({ ...initial, codec_version: 2 }, observation, "tx_1", 1000), ApprovalClockError);
});
test("CAS競合と受理不明では成功せず、未使用reservationも時刻を巻き戻さない", () => {
  for (const mode of ["before", "after", "stale"] as const) {
    const store = new MarkFixture(); store.mode = mode;
    assert.throws(() => reserveClockMark(store, { observe: () => observation }, "tx_1", 1000), ApprovalClockError);
    assert.equal(store.reserves, 1);
    assert.equal(store.value.transaction_id, mode === "after" ? "tx_1" : "clock_genesis");
  }
});
test("request15分とconsume5分はexact境界で期限切れになり、時計異常を期限延長しない", () => {
  const request = approvalExpiry(initial, "request"); const consume = approvalExpiry(initial, "consume");
  assert.equal(request, "2026-09-19T00:15:00.000Z"); assert.equal(consume, "2026-09-19T00:05:00.000Z");
  assert.equal(approvalExpired(request, { ...initial, effective_utc: "2026-09-19T00:14:59.999Z" }), false);
  assert.equal(approvalExpired(request, { ...initial, effective_utc: request }), true);
  assert.equal(approvalExpired(consume, { ...initial, effective_utc: consume }), true);
  for (const state of ["nonterminal_request", "approved", "claimed", "executing", "acceptance_unknown"] as const) {
    assert.deepEqual(clockFailureDisposition(state), { state: "needs_review", delete_payload: true,
      record_acceptance_unknown: state === "executing", external_call_allowed: false });
  }
});
test("provider例外に含まれる秘密を時計エラーへ転載しない", () => {
  const store = new MarkFixture();
  try { reserveClockMark(store, { observe: () => { throw new Error("secret clock provider context"); } }, "tx_1", 1000); }
  catch (error) { assert.equal(String(error), "ApprovalClockError: approval_clock_unverified"); assert.equal(store.reserves, 0); return; }
  assert.fail("must fail closed");
});

test("過去のreservation IDを再利用せず、DB未使用でもmarkを取り消さない", () => {
  const store = new MarkFixture();
  reserveClockMark(store, { observe: () => observation }, "tx_1", 1000);
  reserveClockMark(store, { observe: () => ({ ...observation, continuous_ms: 3000, wall_utc: "2026-09-19T00:00:02.000Z" }) }, "tx_2", 1000);
  const before = store.read();
  assert.throws(() => reserveClockMark(store, { observe: () => ({ ...observation, continuous_ms: 4000, wall_utc: "2026-09-19T00:00:03.000Z" }) }, "tx_1", 1000), ApprovalClockError);
  assert.deepEqual(store.read(), before); assert.equal(store.reserves, 3);
});
