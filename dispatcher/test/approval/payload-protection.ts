import assert from "node:assert/strict";
import { test } from "node:test";
import { webcrypto } from "node:crypto";
import { createApprovalContentBinding, verifyApprovalContentBinding, sealApprovalPayload, openApprovalPayload,
  ApprovalPayloadError, maximumApprovalPayloadBytes, type ApprovalPayloadBinding, type ApprovalPayloadKey } from "../../src/approval/payload-protection.js";
import type { ClockMark } from "../../src/approval/clock.js";
const at = "2026-09-19T00:00:00.000Z", scope = { instance_id: "instance_a", workspace_id: "workspace_a" };
const text = "承認済みの返信\n👋";
function mark(effective_utc = at): ClockMark { return { codec_version: 1, transaction_id: "transaction", previous_transaction_id: null, boot_id: "boot", continuous_ms: 1, effective_utc }; }
function key(purpose: ApprovalPayloadKey["purpose"]): ApprovalPayloadKey {
  return { version: 1, purpose, state: "active", activated_at: "2026-09-01T00:00:00.000Z", signing_expires_at: "2026-10-01T00:00:00.000Z",
    secret: purpose === "approval_content" ? Uint8Array.from({ length: 32 }, (_, i) => i) : new Uint8Array(32).fill(83) };
}
const content = () => key("approval_content"), wrapping = () => key("approval_payload_wrap");
function binding(): ApprovalPayloadBinding {
  return { codec_version: 1, scope: { ...scope }, owner_kind: "request", owner_id: "request_a", request_id: "request_a",
    semantic_hash: "a".repeat(64), payload_ref: "payload_a", content: createApprovalContentBinding(text, scope, "draft", content(), mark()),
    created_at: at, expires_at: "2026-09-19T00:20:00.000Z" };
}
function changed(value: string): string { const raw = Buffer.from(value, "base64url"); raw[0] = raw[0]! ^ 1; return raw.toString("base64url"); }

test("本文HMACは独立算出値に一致しscope・用途・本文へ結合する", () => {
  const value = createApprovalContentBinding(text, scope, "draft", content(), mark());
  // Python標準hmac/hashlibと固定UTF-8 framingから独立算出したfixture。
  assert.equal(value.mac, "6492fcf134ec2a7b7a1fad0a924b567b1fe4feac6b1dd6c2b3473af319a6651d");
  assert.ok(Object.isFrozen(value)); verifyApprovalContentBinding(text, scope, "draft", value, content());
  for (const [body, owner, purpose] of [[text + " ", scope, "draft"], [text, { ...scope, instance_id: "other" }, "draft"],
    [text, { ...scope, workspace_id: "other" }, "draft"], [text, scope, "thread_message"]] as const)
    assert.throws(() => verifyApprovalContentBinding(body, owner, purpose, value, content()), ApprovalPayloadError);
  assert.throws(() => verifyApprovalContentBinding(text, scope, "draft", { ...value, key_version: 2 }, content()), ApprovalPayloadError);
  const empty = createApprovalContentBinding("", scope, "thread_message", content(), mark());
  verifyApprovalContentBinding("", scope, "thread_message", empty, content());
  assert.throws(() => createApprovalContentBinding("", scope, "draft", content(), mark()), ApprovalPayloadError);
});

test("payloadごとに別DEK/nonceを作りexact UTF-8を復号する", () => {
  const owner = binding(), first = sealApprovalPayload(text, owner, wrapping(), content(), mark()), second = sealApprovalPayload(text, owner, wrapping(), content(), mark());
  assert.ok(Object.isFrozen(first)); assert.notEqual(first.wrapped_key, second.wrapped_key); assert.notEqual(first.nonce, second.nonce);
  assert.equal(Buffer.from(first.wrapped_key, "base64url").length, 40);
  assert.equal(Buffer.from(first.nonce, "base64url").length, 12); assert.equal(Buffer.from(first.tag, "base64url").length, 16);
  assert.equal(openApprovalPayload(first, owner, wrapping(), content(), mark()), text);
  assert.ok(!JSON.stringify(first).includes(text));
  const bomText = "\ufeff" + text, bomOwner = { ...owner, content: createApprovalContentBinding(bomText, scope, "draft", content(), mark()) };
  assert.equal(openApprovalPayload(sealApprovalPayload(bomText, bomOwner, wrapping(), content(), mark()), bomOwner, wrapping(), content(), mark()), bomText);
  assert.throws(() => sealApprovalPayload("違う本文", owner, wrapping(), content(), mark()), ApprovalPayloadError);
});

test("ownerと全暗号fieldの改変をplaintext公開前に拒否する", () => {
  const owner = binding(), sealed = sealApprovalPayload(text, owner, wrapping(), content(), mark());
  const mutations: ApprovalPayloadBinding[] = [
    { ...owner, scope: { ...scope, instance_id: "other" } }, { ...owner, scope: { ...scope, workspace_id: "other" } },
    { ...owner, owner_id: "other", request_id: "other" }, { ...owner, semantic_hash: "b".repeat(64) },
    { ...owner, payload_ref: "other" }, { ...owner, content: { ...owner.content, mac: "c".repeat(64) } },
    { ...owner, expires_at: "2026-09-19T00:19:00.000Z" }, { ...owner, owner_kind: "attempt", owner_id: "attempt" },
  ];
  for (const changed of mutations) assert.throws(() => openApprovalPayload(sealed, changed, wrapping(), content(), mark()), ApprovalPayloadError);
  for (const field of ["wrapped_key", "nonce", "ciphertext", "tag"] as const)
    assert.throws(() => openApprovalPayload({ ...sealed, [field]: changed(sealed[field]) }, owner, wrapping(), content(), mark()), ApprovalPayloadError);
  for (const change of [{ codec_version: 2 }, { algorithm: "aes-256-gcm" }, { key_version: 2 }, { sealed_at: "2026-09-19T00:00:00.001Z" }, { extra: true }, { tag: sealed.tag + "=" }])
    assert.throws(() => openApprovalPayload({ ...sealed, ...change }, owner, wrapping(), content(), mark()), ApprovalPayloadError);
});

test("requestからattemptへ新しいbinding/DEKを作り24時間上限を守る", () => {
  const owner = binding(), request = sealApprovalPayload(text, owner, wrapping(), content(), mark());
  const claim = "2026-09-19T00:19:00.000Z", attempt: ApprovalPayloadBinding = { ...owner, owner_kind: "attempt", owner_id: "attempt_a", payload_ref: "attempt_payload", created_at: claim, expires_at: "2026-09-20T00:19:00.000Z" };
  assert.throws(() => openApprovalPayload(request, attempt, wrapping(), content(), mark(claim)), ApprovalPayloadError);
  const plaintext = openApprovalPayload(request, owner, wrapping(), content(), mark(claim));
  const moved = sealApprovalPayload(plaintext, attempt, wrapping(), content(), mark(claim));
  assert.notEqual(moved.wrapped_key, request.wrapped_key); assert.equal(openApprovalPayload(moved, attempt, wrapping(), content(), mark("2026-09-20T00:18:59.999Z")), text);
  assert.throws(() => openApprovalPayload(moved, attempt, wrapping(), content(), mark(attempt.expires_at)), ApprovalPayloadError);
  assert.throws(() => sealApprovalPayload(text, { ...attempt, expires_at: "2026-09-20T00:19:00.001Z" }, wrapping(), content(), mark(claim)), ApprovalPayloadError);
  assert.throws(() => openApprovalPayload(request, owner, wrapping(), content(), mark(owner.expires_at)), ApprovalPayloadError);
  assert.throws(() => sealApprovalPayload(text, { ...owner, expires_at: "2026-09-19T00:20:00.001Z" }, wrapping(), content(), mark()), ApprovalPayloadError);
  assert.throws(() => openApprovalPayload(moved, { ...attempt, owner_id: "attempt_b" }, wrapping(), content(), mark(claim)), ApprovalPayloadError);
});

test("rotation後は既存検証だけを許しrevoked/用途違い/鍵流用を拒否する", () => {
  const owner = binding(), sealed = sealApprovalPayload(text, owner, wrapping(), content(), mark());
  const oldWrap = { ...wrapping(), state: "verification_only" as const }, oldContent = { ...content(), state: "verification_only" as const };
  assert.equal(openApprovalPayload(sealed, owner, oldWrap, oldContent, mark()), text);
  assert.throws(() => sealApprovalPayload(text, owner, oldWrap, content(), mark()), ApprovalPayloadError);
  assert.throws(() => createApprovalContentBinding(text, scope, "draft", oldContent, mark()), ApprovalPayloadError);
  for (const altered of [{ ...wrapping(), state: "revoked" as const }, { ...wrapping(), purpose: "approval_content" as const },
    { ...wrapping(), secret: new Uint8Array(32).fill(42) }, { ...wrapping(), secret: new Uint8Array(31) }])
    assert.throws(() => openApprovalPayload(sealed, owner, altered, content(), mark()), ApprovalPayloadError);
  assert.throws(() => openApprovalPayload(sealed, owner, wrapping(), { ...content(), state: "revoked" }, mark()), ApprovalPayloadError);
  assert.throws(() => sealApprovalPayload(text, owner, { ...wrapping(), secret: content().secret }, content(), mark()), ApprovalPayloadError);
  for (const altered of [{ ...content(), signing_expires_at: at }, { ...content(), activated_at: "2026-09-20T00:00:00.000Z" },
    { ...content(), signing_expires_at: "2027-01-01T00:00:00.000Z" }, { ...content(), version: 0 }])
    assert.throws(() => createApprovalContentBinding(text, scope, "draft", altered, mark()), ApprovalPayloadError);
});

test("入力byte上限とUTF-8、受動data、保護clockの構造を検証する", () => {
  const owner = binding();
  for (const text of ["a".repeat(maximumApprovalPayloadBytes + 1), "あ".repeat(Math.ceil(maximumApprovalPayloadBytes / 3)), "\ud800"])
    assert.throws(() => createApprovalContentBinding(text, scope, "draft", content(), mark()), ApprovalPayloadError);
  const large = "a".repeat(maximumApprovalPayloadBytes), bound = { ...owner, content: createApprovalContentBinding(large, scope, "draft", content(), mark()) };
  assert.equal(openApprovalPayload(sealApprovalPayload(large, bound, wrapping(), content(), mark()), bound, wrapping(), content(), mark()), large);
  const proxy = new Proxy(owner, { get() { throw Error("private_fixture"); } });
  assert.throws(() => sealApprovalPayload(text, proxy, wrapping(), content(), mark()), { message: "approval_payload_unverified" });
  assert.throws(() => sealApprovalPayload(text, owner, wrapping(), content(), { ...mark(), effective_utc: "invalid" }), ApprovalPayloadError);
  assert.throws(() => sealApprovalPayload(text, owner, wrapping(), content(), mark("2026-09-18T23:59:59.999Z")), ApprovalPayloadError);
});

test("RFC3394の公開wrapped keyとWebCrypto GCMの暗号文を復号する", async () => {
  const owner = binding(), kek = Uint8Array.from({ length: 32 }, (_, i) => i), dek = Buffer.from("00112233445566778899aabbccddeeff000102030405060708090a0b0c0d0e0f", "hex");
  // RFC3394 4.6 の固定公開vector。製品のrandomness APIへfixtureを注入しない。
  const wrapped = Buffer.from("28c9f404c4b810f4cbccb35cfb87f8263f5786e2d80ed326cbc7f0e71a99f43bfb988b9b7a02dd21", "hex").toString("base64url");
  const nonce = new Uint8Array(12).fill(17), cryptoKey = await webcrypto.subtle.importKey("raw", dek, "AES-GCM", false, ["encrypt"]);
  const contentKey = { ...content(), secret: new Uint8Array(32).fill(27) };
  const vectorOwner = { ...owner, content: createApprovalContentBinding(text, scope, "draft", contentKey, mark()) };
  const vectorAad = Buffer.from(JSON.stringify(["dona.approval.payload", 1, "A256KW+A256GCM", 1, at, wrapped,
    "instance_a", "workspace_a", "request", "request_a", "request_a", owner.semantic_hash, "payload_a",
    1, vectorOwner.content.mac, at, at, owner.expires_at]));
  const vectorRaw = Buffer.from(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: vectorAad, tagLength: 128 }, cryptoKey, Buffer.from(text)));
  assert.equal(openApprovalPayload({ codec_version: 1, algorithm: "A256KW+A256GCM", key_version: 1, sealed_at: at, wrapped_key: wrapped, nonce: Buffer.from(nonce).toString("base64url"), ciphertext: vectorRaw.subarray(0, -16).toString("base64url"), tag: vectorRaw.subarray(-16).toString("base64url") }, vectorOwner, { ...wrapping(), secret: kek }, contentKey, mark()), text);
});
