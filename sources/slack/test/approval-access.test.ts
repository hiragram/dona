import assert from "node:assert/strict";
import { test } from "node:test";
import { SlackApprovalAccessProbe, SlackApprovalAccessError } from "../src/approval-access.js";
import { channelFromResponse } from "../src/slack-api.js";
import type { SlackWorkspaceRegistry } from "../src/workspace-registry.js";

const binding = { instance_id: "instance", workspace_id: "T123", alias: "primary", team_id: "T123", supervisor_user_id: "U123" };
const target = { channel_id: "C123", thread_ts: "1234567890.123456" };
function fixture() {
  let deleted = false, suspended = false, shared = false, available = true, loop = false, member = true, im = false;
  let deletionKnown = true, sharingKnown = true, strangerKnown = true, suspendedKnown = true;
  const client = {
    async getUser() {
      if (!available) throw Error("unavailable private context");
      return { id: "U123", teamId: "T123", isDeleted: deleted, deletionKnown,
        ...(suspendedKnown ? { isSuspended: suspended } : {}),
        ...(strangerKnown ? { isStranger: false } : {}), isBot: false, isAppUser: false };
    },
    async getChannel() { return { id: "C123", isArchived: false, isShared: shared,
      sharingKnown: im ? false : sharingKnown, isMember: !im, isIm: im, isPrivate: true }; },
    async getChannelMembers(_channel: string, _limit: number, cursor?: string) {
      if (loop) return { members: ["U999"], nextCursor: "repeat" };
      return cursor ? { members: member ? ["U123"] : [], nextCursor: undefined }
        : { members: ["U999"], nextCursor: "second" };
    },
  };
  const connection = { alias: "primary", teamId: "T123", client };
  const registry = { get(alias: string) { if (alias !== "primary") throw Error(); return connection; },
    getByTeamId(team: string) { if (team !== "T123") throw Error(); return connection; } } as unknown as Pick<SlackWorkspaceRegistry, "get" | "getByTeamId">;
  const probe = new SlackApprovalAccessProbe(registry, () => new Date("2026-09-19T00:00:00.000Z"));
  return { probe, set: (fault: "deleted" | "suspended" | "shared" | "unavailable" | "loop" | "nonmember"
    | "missing_user_status" | "missing_channel_status" | "missing_stranger_status" | "missing_suspended_status" | "dm") => {
    if (fault === "deleted") deleted = true;
    if (fault === "suspended") suspended = true;
    if (fault === "shared") shared = true;
    if (fault === "unavailable") available = false;
    if (fault === "loop") loop = true;
    if (fault === "nonmember") member = false;
    if (fault === "missing_user_status") deletionKnown = false;
    if (fault === "missing_channel_status") sharingKnown = false;
    if (fault === "missing_stranger_status") strangerKnown = false;
    if (fault === "missing_suspended_status") suspendedKnown = false;
    if (fault === "dm") im = true;
  } };
}

test("registryと現在のuser・channel membershipを確認して短命な観測だけ返す", async () => {
  const f = fixture();
  const receipt = await f.probe.observe(binding, target, "transaction", "decision");
  assert.deepEqual(receipt, { transaction_id: "transaction", phase: "decision", instance_id: "instance",
    workspace_id: "T123", alias: "primary", team_id: "T123", user_id: "U123",
    operation_kind: "slack.post_thread_reply.v1", target,
    active: true, can_approve: true, target_visible: true, shared: false,
    observed_at: "2026-09-19T00:00:00.000Z", expires_at: "2026-09-19T00:00:30.000Z" });
});

test("別workspace、alias違い、退職・停止・shared・API欠落・membership不明をfail closedする", async () => {
  for (const change of [{ workspace_id: "T999" }, { team_id: "T999" }, { alias: "wrong" }]) {
    await assert.rejects(fixture().probe.observe({ ...binding, ...change }, target, "transaction", "decision"), SlackApprovalAccessError);
  }
  for (const fault of ["deleted", "suspended", "shared", "unavailable", "loop", "nonmember",
    "missing_user_status", "missing_channel_status", "missing_stranger_status", "missing_suspended_status"] as const) {
    const f = fixture(); f.set(fault);
    await assert.rejects(f.probe.observe(binding, target, "transaction", "decision"), SlackApprovalAccessError);
  }
});

test("DMではconversationのis_member省略を許すがuser membershipは確認する", async () => {
  const f = fixture(); f.set("dm");
  assert.equal((await f.probe.observe(binding, target, "transaction", "decision")).active, true);
  f.set("nonmember");
  await assert.rejects(f.probe.observe(binding, target, "transaction", "decision"), SlackApprovalAccessError);
});

test("channelの共有状態は全flagが明示された場合だけ既知とする", () => {
  assert.equal(channelFromResponse({ id: "C123", is_shared: false }).sharingKnown, undefined);
  assert.equal(channelFromResponse({ id: "C123", is_shared: false, is_ext_shared: false,
    is_pending_ext_shared: false }).sharingKnown, true);
  assert.equal(channelFromResponse({ id: "C123", is_shared: false, is_ext_shared: true,
    is_pending_ext_shared: false }).isShared, true);
  assert.equal(channelFromResponse({ id: "D123", is_im: true }).isIm, true);
});
