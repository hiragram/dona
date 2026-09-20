import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { DiagnosticLogStore } from "../src/diagnostic-log.js";
import { UpdateDatabase } from "../src/database.js";
import { ProcessRunner } from "../src/process.js";
import { currentSha, removeTree, targetSha, tempPolicy } from "./helpers.js";

describe("DiagnosticLogStore", { concurrency: false }, () => {
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeTree)));

async function fixture(perLogLimit = 16 * 1024) {
  const { root, policy } = await tempPolicy();
  roots.push(root);
  const database = new UpdateDatabase(path.join(policy.control_root, "updater.sqlite3"));
  const replyTarget = { kind: "slack_thread" as const, workspace_id: "T_TEST", channel_id: "C_TEST", thread_ts: "1.000001" };
  const planned = database.createPlan({ source_event_id: "evt_01M2Y000000000000000000001", reply_target: replyTarget }, {
    current_sha: currentSha,
    target_sha: targetSha,
    previous_sha: null,
    policy_version: policy.policy_version,
    compatibility: policy.compatibility,
    rollback_compatible: true,
  });
  database.approve({
    source_event_id: "evt_01M2Y000000000000000000002",
    reply_target: replyTarget,
    plan_id: planned.plan.plan_id,
    plan_hash: planned.plan.plan_hash,
    approval_id: "approval-diagnostics",
  });
  const claimed = database.claim(planned.row.request_id, "diagnostic-test", 60_000)!;
  const store = new DiagnosticLogStore(policy.control_root, perLogLimit, database);
  return { root, policy, database, store, claimed };
}

test("durable capture keeps a late failure after the memory prefix is truncated", async () => {
  const f = await fixture(32 * 1024);
  try {
    const result = await new ProcessRunner().run(process.execPath, ["-e",
      "process.stdout.write('ok\\n'.repeat(2000)); process.stderr.write('setup ok\\n'.repeat(2000) + 'late assertion failure\\n'); process.exitCode=1"], {
      timeoutMs: 2_000,
      outputLimitBytes: 1_024,
      diagnostic: { store: f.store, identity: { request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "updater:npm-test" } },
    });
    assert.equal(result.exit_code, 1);
    assert.equal(result.output_truncated, true);
    assert.equal(result.stderr.includes("late assertion failure"), false);
    const row = f.database.diagnosticLogs(f.claimed.request_id)[0]!;
    const projected = f.store.project(row, 8_192);
    assert.equal(projected.capture_state, "complete");
    assert.match(String(projected.detail_tail), /\[stderr\]/);
    assert.match(String(projected.detail_tail), /late assertion failure/);
    assert.equal(projected.log_id, result.diagnostic_log?.log_id);
    assert.match(String(row.content_sha256), /^[0-9a-f]{64}$/);
  } finally {
    f.database.close();
  }
});

test("streaming redaction covers split UTF-8, token, URL, and local path before persistence", async () => {
  const f = await fixture();
  try {
    const capture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "dispatcher:npm-test" });
    const utf8Prefix = Buffer.from("前半🙂 token=sec");
    const splitInsideEmoji = Buffer.byteLength("前半") + 2;
    capture.write("stdout", utf8Prefix.subarray(0, splitInsideEmoji));
    capture.write("stdout", utf8Prefix.subarray(splitInsideEmoji));
    capture.write("stdout", Buffer.from("ret-value https://private.example/in"));
    capture.write("stderr", Buffer.from("ternal /Users/example/private/file 後半"));
    const completed = capture.finish(true)!;
    const row = f.database.diagnosticLogs(f.claimed.request_id)[0]!;
    const projected = f.store.project(row, completed.byte_size);
    const detail = String(projected.detail_tail);
    assert.equal(detail.includes("secret-value"), false);
    assert.equal(detail.includes("private.example"), false);
    assert.equal(detail.includes("/Users/example"), false);
    assert.match(detail, /REDACTED/);
    assert.match(detail, /前半🙂/);

    const longCapture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "dispatcher:npm-build" });
    longCapture.write("stderr", Buffer.from(`${"x".repeat(5_000)}fetch(https://private.example/signed?token=secret-value`));
    longCapture.finish(true);
    const longDetail = String(f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[1]!, 16_384).detail_tail);
    assert.equal(longDetail.includes("private.example"), false);
    assert.equal(longDetail.includes("secret-value"), false);

    const quotedCapture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "dispatcher:npm-test" });
    quotedCapture.write("stderr", Buffer.from("password=\""));
    quotedCapture.write("stderr", Buffer.from("quoted-secret".repeat(500)));
    quotedCapture.write("stderr", Buffer.from("\" visible-after-secret"));
    quotedCapture.finish(true);
    const quotedDetail = String(f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[2]!, 16_384).detail_tail);
    assert.equal(quotedDetail.includes("quoted-secret"), false);
    assert.match(quotedDetail, /REDACTED_STREAM/);
    assert.match(quotedDetail, /visible-after-secret/);

    const spacedCapture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "dispatcher:npm-ci" });
    spacedCapture.write("stderr", Buffer.from("Authorization "));
    spacedCapture.write("stderr", Buffer.from(": Bearer secret-token\npassword=\"alpha beta\" visible"));
    spacedCapture.finish(true);
    const spacedDetail = String(f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[3]!, 16_384).detail_tail);
    assert.equal(spacedDetail.includes("secret-token"), false);
    assert.equal(spacedDetail.includes("alpha beta"), false);
    assert.match(spacedDetail, /REDACTED_STREAM/);

    const escapedCapture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "dispatcher:npm-build-escaped" });
    escapedCapture.write("stderr", Buffer.from('password="alpha\\"secret-tail" visible-after-escaped'));
    escapedCapture.finish(true);
    const escapedDetail = String(f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[4]!, 16_384).detail_tail);
    assert.equal(escapedDetail.includes("secret-tail"), false);
    assert.match(escapedDetail, /visible-after-escaped/);

    const partialCapture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "dispatcher:npm-build-partial" });
    partialCapture.write("stderr", Buffer.from(`password${" ".repeat(5_000)}`));
    partialCapture.write("stderr", Buffer.from("secret-after-long-carry\nvisible-after-line"));
    partialCapture.finish(true);
    const partialDetail = String(f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[5]!, 16_384).detail_tail);
    assert.equal(partialDetail.includes("secret-after-long-carry"), false);
    assert.match(partialDetail, /visible-after-line/);

    const environmentCapture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "dispatcher:npm-env" });
    environmentCapture.write("stderr", Buffer.from("NPM_TOKEN=supersecret\nGITHUB_TOKEN=github-secret\nMY_PASSWORD=human-secret\nvisible"));
    environmentCapture.finish(true);
    const environmentDetail = String(f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[6]!, 16_384).detail_tail);
    assert.equal(environmentDetail.includes("supersecret"), false);
    assert.equal(environmentDetail.includes("github-secret"), false);
    assert.equal(environmentDetail.includes("human-secret"), false);
    assert.match(environmentDetail, /visible/);

    const pathCapture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "dispatcher:npm-path" });
    pathCapture.write("stderr", Buffer.from("failed at /Users/alice/Library/Application "));
    pathCapture.write("stderr", Buffer.from("Support/Dona/private.log\nvisible-after-path"));
    pathCapture.finish(true);
    const pathDetail = String(f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[7]!, 16_384).detail_tail);
    assert.equal(pathDetail.includes("Support/Dona"), false);
    assert.match(pathDetail, /visible-after-path/);

    const npmAuthCapture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "dispatcher:npm-auth" });
    npmAuthCapture.write("stderr", Buffer.from("//registry.example/:_auth"));
    npmAuthCapture.write("stderr", Buffer.from("Token=supersecret\nvisible-after-auth"));
    npmAuthCapture.finish(true);
    const npmAuthDetail = String(f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[8]!, 16_384).detail_tail);
    assert.equal(npmAuthDetail.includes("supersecret"), false);
    assert.match(npmAuthDetail, /REDACTED_STREAM/);
    assert.match(npmAuthDetail, /visible-after-auth/);

    const middleSecretCapture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "dispatcher:aws-auth" });
    middleSecretCapture.write("stderr", Buffer.from("AWS_SECRET_"));
    middleSecretCapture.write("stderr", Buffer.from("ACCESS_KEY=cloud-secret\nvisible-after-cloud-auth"));
    middleSecretCapture.finish(true);
    const middleSecretDetail = String(f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[9]!, 16_384).detail_tail);
    assert.equal(middleSecretDetail.includes("cloud-secret"), false);
    assert.match(middleSecretDetail, /REDACTED_STREAM/);
    assert.match(middleSecretDetail, /visible-after-cloud-auth/);

    const jsonCapture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "dispatcher:json-auth" });
    jsonCapture.write("stderr", Buffer.from('{"to'));
    jsonCapture.write("stderr", Buffer.from('ken":"json-secret"}\nvisible-after-json'));
    jsonCapture.finish(true);
    const jsonDetail = String(f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[10]!, 16_384).detail_tail);
    assert.equal(jsonDetail.includes("json-secret"), false, jsonDetail);
    assert.match(jsonDetail, /REDACTED_STREAM/);
    assert.match(jsonDetail, /visible-after-json/);

    const apiKeyCapture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "dispatcher:api-key" });
    apiKeyCapture.write("stderr", Buffer.from("OPENAI_API_"));
    apiKeyCapture.write("stderr", Buffer.from('KEY=environment-secret\n{"apiKey":"json-api-secret"}\nvisible-after-api-key'));
    apiKeyCapture.finish(true);
    const apiKeyDetail = String(f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[11]!, 16_384).detail_tail);
    assert.equal(apiKeyDetail.includes("environment-secret"), false, apiKeyDetail);
    assert.equal(apiKeyDetail.includes("json-api-secret"), false, apiKeyDetail);
    assert.match(apiKeyDetail, /visible-after-api-key/);

    const legacyNpmAuthCapture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "dispatcher:npm-legacy-auth" });
    legacyNpmAuthCapture.write("stderr", Buffer.from("//registry.example/:_au"));
    legacyNpmAuthCapture.write("stderr", Buffer.from("th=BASE64_CREDENTIAL\nvisible-after-legacy-auth"));
    legacyNpmAuthCapture.finish(true);
    const legacyNpmAuthDetail = String(f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[12]!, 16_384).detail_tail);
    assert.equal(legacyNpmAuthDetail.includes("BASE64_CREDENTIAL"), false, legacyNpmAuthDetail);
    assert.match(legacyNpmAuthDetail, /REDACTED_STREAM/);
    assert.match(legacyNpmAuthDetail, /visible-after-legacy-auth/);

    const hyphenatedApiKeyCapture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "dispatcher:hyphenated-api-key" });
    hyphenatedApiKeyCapture.write("stderr", Buffer.from("X-API-"));
    hyphenatedApiKeyCapture.write("stderr", Buffer.from("Key: header-secret\nx-api-key='config-secret'\nvisible-after-hyphenated-api-key"));
    hyphenatedApiKeyCapture.finish(true);
    const hyphenatedApiKeyDetail = String(f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[13]!, 16_384).detail_tail);
    assert.equal(hyphenatedApiKeyDetail.includes("header-secret"), false, hyphenatedApiKeyDetail);
    assert.equal(hyphenatedApiKeyDetail.includes("config-secret"), false, hyphenatedApiKeyDetail);
    assert.match(hyphenatedApiKeyDetail, /REDACTED_STREAM/);
    assert.match(hyphenatedApiKeyDetail, /visible-after-hyphenated-api-key/);
  } finally {
    f.database.close();
  }
});

test("disk quota is independent from memory capture and reports truncation", async () => {
  const f = await fixture(4_096);
  try {
    const result = await new ProcessRunner().run(process.execPath, ["-e", "process.stdout.write('x'.repeat(12000)); process.exitCode=1"], {
      timeoutMs: 2_000,
      outputLimitBytes: 512,
      diagnostic: { store: f.store, identity: { request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "slack:npm-build" } },
    });
    assert.equal(Buffer.byteLength(result.stdout), 512);
    assert.equal(result.diagnostic_log?.capture_state, "truncated");
    assert.equal(result.diagnostic_log?.byte_size, 4_096);
    assert.equal(f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[0]!).capture_state, "truncated");
  } finally {
    f.database.close();
  }
});

test("preserves stderr and stdout arrival order while redaction carry is pending", async () => {
  const f = await fixture();
  try {
    const capture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "updater:npm-order" });
    capture.write("stderr", Buffer.from("first"));
    capture.write("stdout", Buffer.from("second\n"));
    capture.finish(true);
    const detail = String(f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[0]!, 16_384).detail_tail);
    assert.ok(detail.indexOf("[stderr] first") < detail.indexOf("[stdout] second"), detail);
  } finally {
    f.database.close();
  }
});

test("bounds ordered output while an earlier stream keeps redaction carry pending", async () => {
  const f = await fixture(4_096);
  try {
    const capture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "updater:npm-order-limit" });
    capture.write("stderr", Buffer.from("first"));
    capture.write("stdout", Buffer.from(`${"x".repeat(16_384)}\n`));
    const result = capture.finish(true)!;
    assert.equal(result.capture_state, "truncated");
    assert.equal(result.byte_size, 4_096);
  } finally {
    f.database.close();
  }
});

test("timeout cleanup and signal exit both finalize their bound diagnostics", async () => {
  const f = await fixture();
  const pidPath = path.join(f.root, "diagnostic-child.pid");
  try {
    const timeoutScript = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      process.on("SIGTERM", () => {});
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
      fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
      process.stderr.write("waiting for timeout detail\\n");
      setInterval(() => {}, 1000);
    `;
    const timedOut = await new ProcessRunner().run(process.execPath, ["-e", timeoutScript], {
      timeoutMs: 50,
      outputLimitBytes: 512,
      diagnostic: { store: f.store, identity: { request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "updater:npm-test-timeout" } },
    });
    assert.equal(timedOut.timed_out, true);
    assert.equal(timedOut.exit_signal, "SIGKILL");
    assert.equal(timedOut.cleanup_status, "term=group-sent,kill=group-sent,closed=yes");
    assert.equal(timedOut.diagnostic_log?.capture_state, "complete");
    const childPid = Number(await fs.readFile(pidPath, "utf8"));
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });

    const signalled = await new ProcessRunner().run(process.execPath, ["-e",
      "process.stderr.write('signal failure detail\\n'); process.kill(process.pid, 'SIGTERM')"], {
      timeoutMs: 2_000,
      outputLimitBytes: 512,
      diagnostic: { store: f.store, identity: { request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "updater:npm-build-signal" } },
    });
    assert.equal(signalled.exit_code, null);
    assert.equal(signalled.exit_signal, "SIGTERM");
    assert.equal(signalled.diagnostic_log?.capture_state, "complete");
    assert.deepEqual(f.database.diagnosticLogs(f.claimed.request_id).map(({ step }) => step), [
      "updater:npm-test-timeout", "updater:npm-build-signal",
    ]);
  } finally {
    f.database.close();
  }
});

test("read projection refuses missing, size-mismatched, and hard-linked files", async () => {
  const f = await fixture();
  try {
    const make = (step: string) => {
      const capture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step });
      capture.write("stderr", Buffer.from("failure"));
      return capture.finish(true)!;
    };
    const first = make("dispatcher:npm-ci");
    const firstPath = path.join(f.policy.control_root, "diagnostics", first.relative_ref!);
    await fs.appendFile(firstPath, "tamper");
    assert.equal(f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[0]!).capture_state, "size_mismatch");

    const second = make("dispatcher:npm-build");
    const secondPath = path.join(f.policy.control_root, "diagnostics", second.relative_ref!);
    await fs.link(secondPath, `${secondPath}.hardlink`);
    assert.equal(f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[1]!).capture_state, "read_error");

    const third = make("dispatcher:npm-typecheck");
    await fs.unlink(path.join(f.policy.control_root, "diagnostics", third.relative_ref!));
    assert.equal(f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[2]!).capture_state, "missing");
  } finally {
    f.database.close();
  }
});

test("read projection rejects same-inode same-size content replacement", async () => {
  const f = await fixture();
  try {
    const capture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "dispatcher:npm-digest" });
    capture.write("stderr", Buffer.from("redacted failure detail"));
    const completed = capture.finish(true)!;
    const row = f.database.diagnosticLogs(f.claimed.request_id)[0]!;
    const file = path.join(f.policy.control_root, "diagnostics", completed.relative_ref!);
    const before = await fs.stat(file);
    await fs.writeFile(file, Buffer.alloc(row.byte_size, 0x78), { flag: "r+" });
    const after = await fs.stat(file);
    assert.equal(after.ino, before.ino);
    assert.equal(after.size, before.size);
    const projected = f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[0]!);
    assert.equal(projected.capture_state, "read_error");
    assert.equal(projected.error_code, "diagnostic_read_failed");
  } finally {
    f.database.close();
  }
});

test("read projection rejects symlink, unsafe mode, forged reference, and cross-request binding", async () => {
  const f = await fixture();
  try {
    const make = (step: string) => {
      const capture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step });
      capture.write("stderr", Buffer.from("failure"));
      return capture.finish(true)!;
    };
    const symlinked = make("dispatcher:npm-ci-symlink");
    const symlinkPath = path.join(f.policy.control_root, "diagnostics", symlinked.relative_ref!);
    await fs.unlink(symlinkPath);
    await fs.symlink("/dev/null", symlinkPath);
    assert.equal(f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[0]!).capture_state, "read_error");

    const unsafe = make("dispatcher:npm-test-mode");
    await fs.chmod(path.join(f.policy.control_root, "diagnostics", unsafe.relative_ref!), 0o666);
    assert.equal(f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[1]!).capture_state, "read_error");

    const row = f.database.diagnosticLogs(f.claimed.request_id)[1]!;
    assert.equal(f.store.project({ ...row, relative_ref: "/tmp/forged.log" }).capture_state, "read_error");
    assert.equal(f.store.project({ ...row, relative_ref: "../forged.log" }).capture_state, "read_error");
    assert.equal(f.store.project({ ...row, request_id: "upd_01m2y000000000000000000099" }, 4_096, f.claimed.request_id).error_code,
      "diagnostic_request_binding_mismatch");
    assert.throws(() => f.database.finalizeDiagnosticLog({
      ...unsafe,
      attempt: f.claimed.attempt + 1,
      capture_state: "complete",
    }), /diagnostic_log_finalize_binding_mismatch/);
  } finally {
    f.database.close();
  }
});

test("write, atomic finalize, and read faults retain the command failure state", async () => {
  const f = await fixture();
  const originalWrite = fsSync.writeSync;
  const originalRead = fsSync.readSync;
  try {
    const writeCapture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "updater:npm-ci-write" });
    fsSync.writeSync = (() => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); }) as typeof fsSync.writeSync;
    writeCapture.write("stderr", Buffer.from("original command failure\n"));
    fsSync.writeSync = originalWrite;
    assert.equal(writeCapture.finish(true)?.error_code, "diagnostic_write_failed");

    const shortWriteCapture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "updater:npm-ci-short-write" });
    let firstWrite = true;
    fsSync.writeSync = ((descriptor: number, buffer: Uint8Array, offset?: number, length?: number) => {
      const selectedOffset = offset ?? 0;
      const selectedLength = length ?? buffer.byteLength;
      const writeLength = firstWrite ? Math.max(1, Math.floor(selectedLength / 2)) : selectedLength;
      firstWrite = false;
      return originalWrite(descriptor, buffer, selectedOffset, writeLength);
    }) as typeof fsSync.writeSync;
    shortWriteCapture.write("stderr", Buffer.from("original command failure after short write"));
    fsSync.writeSync = originalWrite;
    const shortWrite = shortWriteCapture.finish(true)!;
    assert.equal(shortWrite.capture_state, "complete");
    const shortWriteDetail = String(f.store.project(f.database.diagnosticLogs(f.claimed.request_id)[1]!, shortWrite.byte_size).detail_tail);
    assert.match(shortWriteDetail, /original command failure after short/);
    assert.match(shortWriteDetail, /write/);

    const finalizeCapture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "updater:npm-ci-finalize" });
    finalizeCapture.write("stderr", Buffer.from("failure"));
    const logsRoot = path.join(f.policy.control_root, "diagnostics", "logs");
    const part = (await fs.readdir(logsRoot)).find((entry) => entry.endsWith(".part"))!;
    await fs.writeFile(path.join(logsRoot, part.replace(/\.part$/, ".log")), "existing", { mode: 0o600 });
    assert.equal(finalizeCapture.finish(true)?.error_code, "diagnostic_finalize_failed");

    const readCapture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "updater:npm-ci-read" });
    readCapture.write("stderr", Buffer.from("failure"));
    readCapture.finish(true);
    const readable = f.database.diagnosticLogs(f.claimed.request_id).find(({ step }) => step === "updater:npm-ci-read")!;
    fsSync.readSync = (() => { throw Object.assign(new Error("read"), { code: "EIO" }); }) as typeof fsSync.readSync;
    assert.equal(f.store.project(readable).capture_state, "read_error");
    fsSync.readSync = originalRead;

    let firstRead = true;
    fsSync.readSync = ((descriptor: number, buffer: Uint8Array, offset: number, length: number, position: number | null) => {
      const readLength = firstRead ? Math.max(1, Math.floor(length / 2)) : length;
      firstRead = false;
      return originalRead(descriptor, buffer, offset, readLength, position);
    }) as typeof fsSync.readSync;
    assert.match(String(f.store.project(readable).detail_tail), /failure/);
    fsSync.readSync = originalRead;
    assert.deepEqual(f.database.diagnosticLogs(f.claimed.request_id).map(({ capture_state }) => capture_state), [
      "write_failed", "complete", "write_failed", "complete",
    ]);
  } finally {
    fsSync.writeSync = originalWrite;
    fsSync.readSync = originalRead;
    f.database.close();
  }
});

test("open validation failure closes its descriptor and removes the managed partial file", async () => {
  const f = await fixture();
  const originalFstat = fsSync.fstatSync;
  const originalClose = fsSync.closeSync;
  let closeCalls = 0;
  try {
    fsSync.fstatSync = (() => { throw Object.assign(new Error("fstat"), { code: "EIO" }); }) as typeof fsSync.fstatSync;
    fsSync.closeSync = ((descriptor) => { closeCalls += 1; return originalClose(descriptor); }) as typeof fsSync.closeSync;
    const capture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "updater:npm-ci-open-validation" });
    fsSync.fstatSync = originalFstat;
    fsSync.closeSync = originalClose;
    assert.equal(capture.finish(true)?.error_code, "diagnostic_open_failed");
    assert.equal(closeCalls, 2);
    const logsRoot = path.join(f.policy.control_root, "diagnostics", "logs");
    assert.deepEqual((await fs.readdir(logsRoot)).filter((entry) => entry.endsWith(".part")), []);
    const row = f.database.diagnosticLogs(f.claimed.request_id)[0]!;
    assert.equal(row.capture_state, "write_failed");
    assert.equal(row.relative_ref, null);
  } finally {
    fsSync.fstatSync = originalFstat;
    fsSync.closeSync = originalClose;
    f.database.close();
  }
});

test("failed post-publish metadata update removes the final file before dropping its reference", async () => {
  const f = await fixture();
  const originalChmod = fsSync.chmodSync;
  const originalUnlink = fsSync.unlinkSync;
  try {
    const capture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "updater:npm-ci-post-publish" });
    capture.write("stderr", Buffer.from("failure"));
    fsSync.chmodSync = (() => { throw Object.assign(new Error("chmod"), { code: "EIO" }); }) as typeof fsSync.chmodSync;
    const failed = capture.finish(true)!;
    fsSync.chmodSync = originalChmod;
    assert.equal(failed.error_code, "diagnostic_finalize_failed");
    assert.equal(failed.relative_ref, null);
    const logsRoot = path.join(f.policy.control_root, "diagnostics", "logs");
    assert.deepEqual((await fs.readdir(logsRoot)).filter((entry) => entry.includes(failed.log_id)), []);
    const row = f.database.diagnosticLogs(f.claimed.request_id)[0]!;
    assert.equal(row.capture_state, "write_failed");
    assert.equal(row.relative_ref, null);

    const retryCapture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "updater:npm-build-post-publish" });
    retryCapture.write("stderr", Buffer.from("failure"));
    fsSync.chmodSync = (() => { throw Object.assign(new Error("chmod"), { code: "EIO" }); }) as typeof fsSync.chmodSync;
    fsSync.unlinkSync = ((file) => {
      if (String(file).endsWith(".log")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return originalUnlink(file);
    }) as typeof fsSync.unlinkSync;
    const recoverable = retryCapture.finish(true)!;
    fsSync.chmodSync = originalChmod;
    fsSync.unlinkSync = originalUnlink;
    assert.equal(recoverable.relative_ref, `logs/${recoverable.log_id}.log`);
    assert.equal(f.database.diagnosticLogs(f.claimed.request_id)[1]!.capture_state, "capturing");

    f.store.recoverInterruptedCaptures(new Date("2026-09-19T03:00:00.000Z"));
    const recovered = f.database.diagnosticLogs(f.claimed.request_id)[1]!;
    assert.equal(recovered.capture_state, "write_failed");
    assert.equal(recovered.relative_ref, null);
    assert.deepEqual((await fs.readdir(logsRoot)).filter((entry) => entry.includes(recoverable.log_id)), []);
  } finally {
    fsSync.chmodSync = originalChmod;
    fsSync.unlinkSync = originalUnlink;
    f.database.close();
  }
});

test("finalize rejects a path swapped away from the descriptor used for redacted writes", async () => {
  const f = await fixture();
  let displacedPath: string | undefined;
  try {
    const capture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "updater:npm-ci-path-swap" });
    capture.write("stderr", Buffer.from("failure"));
    const logsRoot = path.join(f.policy.control_root, "diagnostics", "logs");
    const part = (await fs.readdir(logsRoot)).find((entry) => entry.endsWith(".part"))!;
    const partPath = path.join(logsRoot, part);
    displacedPath = `${partPath}.displaced`;
    await fs.rename(partPath, displacedPath);
    const displaced = await fs.stat(displacedPath);
    await fs.writeFile(partPath, Buffer.alloc(displaced.size, 0x78), { mode: 0o600, flag: "wx" });

    const failed = capture.finish(true)!;
    assert.equal(failed.error_code, "diagnostic_finalize_failed");
    assert.equal(failed.relative_ref, null);
    assert.equal(f.database.diagnosticLogs(f.claimed.request_id)[0]?.capture_state, "write_failed");
    assert.deepEqual((await fs.readdir(logsRoot)).filter((entry) => entry === `${failed.log_id}.log`), []);
  } finally {
    if (displacedPath) await fs.rm(displacedPath, { force: true });
    f.database.close();
  }
});

test("successful command keeps a recoverable row when partial-file cleanup fails", async () => {
  const f = await fixture();
  const originalUnlink = fsSync.unlinkSync;
  try {
    const capture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "updater:npm-test-cleanup" });
    capture.write("stdout", Buffer.from("successful output"));
    fsSync.unlinkSync = ((file) => {
      if (String(file).endsWith(".part")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return originalUnlink(file);
    }) as typeof fsSync.unlinkSync;
    assert.equal(capture.finish(false), undefined);
    fsSync.unlinkSync = originalUnlink;

    const pending = f.database.diagnosticLogs(f.claimed.request_id)[0]!;
    assert.equal(pending.capture_state, "capturing");
    assert.equal((await fs.stat(path.join(f.policy.control_root, "diagnostics", "logs", `${pending.log_id}.part`))).isFile(), true);

    f.store.recoverInterruptedCaptures(new Date("2026-09-19T02:00:00.000Z"));
    const recovered = f.database.diagnosticLogs(f.claimed.request_id)[0]!;
    assert.equal(recovered.capture_state, "write_failed");
    assert.equal(recovered.error_code, "diagnostic_capture_interrupted");
    assert.equal(recovered.relative_ref, null);
  } finally {
    fsSync.unlinkSync = originalUnlink;
    f.database.close();
  }
});

test("read projection verifies the opened descriptor still names the checked inode", async () => {
  const f = await fixture();
  const originalFstat = fsSync.fstatSync;
  try {
    const capture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "updater:npm-test-read-race" });
    capture.write("stderr", Buffer.from("failure"));
    capture.finish(true);
    const row = f.database.diagnosticLogs(f.claimed.request_id)[0]!;
    fsSync.fstatSync = ((descriptor: number) => {
      const stats = originalFstat(descriptor);
      Object.defineProperty(stats, "ino", { value: stats.ino + 1 });
      return stats;
    }) as typeof fsSync.fstatSync;
    assert.equal(f.store.project(row).capture_state, "read_error");
  } finally {
    fsSync.fstatSync = originalFstat;
    f.database.close();
  }
});

test("unsafe managed root becomes write_failed without changing command failure", async () => {
  const f = await fixture();
  try {
    const diagnosticRoot = path.join(f.policy.control_root, "diagnostics");
    await fs.mkdir(diagnosticRoot, { recursive: true, mode: 0o777 });
    await fs.chmod(diagnosticRoot, 0o777);
    const result = await new ProcessRunner().run(process.execPath, ["-e", "process.exitCode=1"], {
      timeoutMs: 2_000,
      outputLimitBytes: 512,
      diagnostic: { store: f.store, identity: { request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "updater:npm-ci" } },
    });
    assert.equal(result.exit_code, 1);
    assert.equal(result.diagnostic_log?.capture_state, "write_failed");
    assert.equal(f.database.diagnosticLogs(f.claimed.request_id)[0]?.capture_state, "write_failed");
  } finally {
    await fs.chmod(path.join(f.policy.control_root, "diagnostics"), 0o700);
    f.database.close();
  }
});

test("creates the managed logs directory before reserving a capturing row", async () => {
  const f = await fixture();
  const originalReserve = f.database.reserveDiagnosticLog.bind(f.database);
  let directoryExistedAtReservation = false;
  try {
    f.database.reserveDiagnosticLog = ((capture) => {
      directoryExistedAtReservation = fsSync.existsSync(path.join(f.policy.control_root, "diagnostics", "logs"));
      return originalReserve(capture);
    }) as typeof f.database.reserveDiagnosticLog;
    const capture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "updater:npm-directory-order" });
    capture.write("stderr", Buffer.from("failure"));
    capture.finish(true);
    assert.equal(directoryExistedAtReservation, true);
  } finally {
    f.database.reserveDiagnosticLog = originalReserve;
    f.database.close();
  }
});

test("spawn failure is durable and retention never purges a non-terminal capture", async () => {
  const f = await fixture();
  try {
    const result = await new ProcessRunner().run("/definitely/missing/dona-command", [], {
      timeoutMs: 2_000,
      outputLimitBytes: 512,
      diagnostic: { store: f.store, identity: { request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "dispatcher:npm-typecheck" } },
    });
    assert.equal(result.exit_code, null);
    assert.equal(result.spawn_error, "ENOENT");
    assert.equal(result.diagnostic_log?.capture_state, "complete");
    assert.deepEqual(f.database.diagnosticRetentionCandidates(new Date("2999-01-01T00:00:00Z"), 1), []);

    f.database.terminal(f.claimed.request_id, f.claimed.fence, "failed", "pre_activation_failed", {
      last_error_code: "pre_activation_failed",
      last_error_message: "spawn failed",
    });
    f.store.enforceRetention(new Date("2999-01-01T00:00:00Z"), 1, 1);
    const purged = f.database.diagnosticLogs(f.claimed.request_id)[0]!;
    assert.equal(purged.capture_state, "purged");
    assert.equal(f.store.project(purged).capture_state, "purged");
  } finally {
    f.database.close();
  }
});

test("aggregate retention keeps the newest bounded set and records older logs as purged", async () => {
  const f = await fixture();
  try {
    for (const step of ["dispatcher:npm-ci", "dispatcher:npm-test", "dispatcher:npm-build"]) {
      const capture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step });
      capture.write("stderr", Buffer.from(`failure-${step}`));
      capture.finish(true);
    }
    f.database.terminal(f.claimed.request_id, f.claimed.fence, "failed", "pre_activation_failed", {
      last_error_code: "pre_activation_failed",
      last_error_message: "build failed",
    });
    const before = f.database.diagnosticLogs(f.claimed.request_id);
    const largestSingleLog = Math.max(...before.map(({ byte_size }) => byte_size));
    const purgeCandidates = f.database.diagnosticRetentionCandidates(new Date("1900-01-01T00:00:00Z"), largestSingleLog);
    const expectedOldestFirst = [...purgeCandidates].sort((left, right) =>
      (left.finalized_at ?? "").localeCompare(right.finalized_at ?? "") || left.log_id.localeCompare(right.log_id));
    assert.deepEqual(purgeCandidates.map(({ log_id }) => log_id), expectedOldestFirst.map(({ log_id }) => log_id));
    f.store.enforceRetention(new Date(), 9_999, largestSingleLog);
    const states = f.database.diagnosticLogs(f.claimed.request_id).map(({ capture_state }) => capture_state);
    assert.equal(states.filter((state) => state === "complete").length, 1);
    assert.equal(states.filter((state) => state === "purged").length, 2);
  } finally {
    f.database.close();
  }
});

test("aggregate retention excludes missing files before selecting quota victims", async () => {
  const f = await fixture();
  try {
    for (const step of ["dispatcher:npm-old", "dispatcher:npm-new"]) {
      const capture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step });
      capture.write("stderr", Buffer.from(`failure-${step}`));
      capture.finish(true);
    }
    f.database.terminal(f.claimed.request_id, f.claimed.fence, "failed", "pre_activation_failed", {
      last_error_code: "pre_activation_failed",
      last_error_message: "build failed",
    });
    const newestFirst = f.database.diagnosticRetentionLogs();
    const missing = newestFirst[0]!;
    const retained = newestFirst[1]!;
    fsSync.unlinkSync(path.join(f.policy.control_root, "diagnostics", missing.relative_ref!));
    f.store.enforceRetention(new Date(), 9_999, retained.byte_size);
    const rows = f.database.diagnosticLogs(f.claimed.request_id);
    assert.equal(rows.find(({ log_id }) => log_id === missing.log_id)?.capture_state, "purged");
    assert.equal(rows.find(({ log_id }) => log_id === retained.log_id)?.capture_state, "complete");
  } finally {
    f.database.close();
  }
});

test("retention fsyncs a removed directory entry before marking its row purged", async () => {
  const f = await fixture();
  const syncStore = f.store as unknown as { fsyncLogsDirectory(): void };
  const originalFsync = syncStore.fsyncLogsDirectory.bind(f.store);
  const originalMark = f.database.markDiagnosticPurged.bind(f.database);
  const events: string[] = [];
  try {
    const capture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "dispatcher:npm-retention" });
    capture.write("stderr", Buffer.from("failure"));
    capture.finish(true);
    f.database.terminal(f.claimed.request_id, f.claimed.fence, "failed", "pre_activation_failed", {
      last_error_code: "pre_activation_failed",
      last_error_message: "build failed",
    });
    syncStore.fsyncLogsDirectory = () => { events.push("fsync"); originalFsync(); };
    f.database.markDiagnosticPurged = ((logId, at) => { events.push("mark"); return originalMark(logId, at); }) as typeof f.database.markDiagnosticPurged;
    f.store.enforceRetention(new Date("2999-01-01T00:00:00Z"), 1, 1);
    assert.deepEqual(events, ["fsync", "mark"]);
    assert.equal(f.database.diagnosticLogs(f.claimed.request_id)[0]?.capture_state, "purged");
  } finally {
    syncStore.fsyncLogsDirectory = originalFsync;
    f.database.markDiagnosticPurged = originalMark;
    f.database.close();
  }
});

test("retention fsyncs an already absent directory entry before marking its row purged", async () => {
  const f = await fixture();
  const syncStore = f.store as unknown as { fsyncLogsDirectory(): void };
  const originalFsync = syncStore.fsyncLogsDirectory.bind(f.store);
  const originalMark = f.database.markDiagnosticPurged.bind(f.database);
  const events: string[] = [];
  try {
    const capture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "dispatcher:npm-retention-missing" });
    capture.write("stderr", Buffer.from("failure"));
    capture.finish(true);
    f.database.terminal(f.claimed.request_id, f.claimed.fence, "failed", "pre_activation_failed", {
      last_error_code: "pre_activation_failed",
      last_error_message: "build failed",
    });
    const row = f.database.diagnosticLogs(f.claimed.request_id)[0]!;
    fsSync.unlinkSync(path.join(f.policy.control_root, "diagnostics", row.relative_ref!));
    syncStore.fsyncLogsDirectory = () => { events.push("fsync"); originalFsync(); };
    f.database.markDiagnosticPurged = ((logId, at) => { events.push("mark"); return originalMark(logId, at); }) as typeof f.database.markDiagnosticPurged;
    f.store.enforceRetention(new Date("2999-01-01T00:00:00Z"), 1, 1);
    assert.deepEqual(events, ["fsync", "mark"]);
    assert.equal(f.database.diagnosticLogs(f.claimed.request_id)[0]?.capture_state, "purged");
  } finally {
    syncStore.fsyncLogsDirectory = originalFsync;
    f.database.markDiagnosticPurged = originalMark;
    f.database.close();
  }
});

test("successful capture fsyncs its removed partial before discarding the row", async () => {
  const f = await fixture();
  const syncStore = f.store as unknown as { fsyncLogsDirectory(): void };
  const originalFsync = syncStore.fsyncLogsDirectory.bind(f.store);
  const originalDiscard = f.database.discardDiagnosticLog.bind(f.database);
  const events: string[] = [];
  try {
    const capture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "dispatcher:npm-success" });
    capture.write("stdout", Buffer.from("success"));
    syncStore.fsyncLogsDirectory = () => { events.push("fsync"); originalFsync(); };
    f.database.discardDiagnosticLog = ((logId) => { events.push("discard"); return originalDiscard(logId); }) as typeof f.database.discardDiagnosticLog;
    assert.equal(capture.finish(false), undefined);
    assert.deepEqual(events, ["fsync", "discard"]);
    assert.deepEqual(f.database.diagnosticLogs(f.claimed.request_id), []);
  } finally {
    syncStore.fsyncLogsDirectory = originalFsync;
    f.database.discardDiagnosticLog = originalDiscard;
    f.database.close();
  }
});

test("an unavailable diagnostic index never prevents or rewrites the command result", async () => {
  const throwingStore = {
    start() { throw new Error("diagnostic index unavailable"); },
  } as unknown as DiagnosticLogStore;
  const result = await new ProcessRunner().run(process.execPath, ["-e", "process.stderr.write('failure'); process.exitCode=7"], {
    timeoutMs: 2_000,
    outputLimitBytes: 512,
    diagnostic: { store: throwingStore, identity: {
      request_id: "upd_01m2y000000000000000000001", attempt: 1, step: "updater:npm-test",
    } },
  });
  assert.equal(result.exit_code, 7);
  assert.equal(result.stderr, "failure");
  assert.equal(result.diagnostic_log, undefined);
});

test("a read-only database open does not interrupt another process capture", async () => {
  const f = await fixture();
  const databasePath = path.join(f.policy.control_root, "updater.sqlite3");
  try {
    const capture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "updater:npm-typecheck" });
    capture.write("stderr", Buffer.from("active failure detail"));
    const reader = new UpdateDatabase(databasePath);
    try {
      assert.equal(reader.diagnosticLogs(f.claimed.request_id)[0]?.capture_state, "capturing");
    } finally {
      reader.close();
    }
    assert.equal(capture.finish(true)?.capture_state, "complete");
  } finally {
    f.database.close();
  }
});

test("singleton startup recovers interrupted rows and removes their bounded partial files", async () => {
  const f = await fixture();
  const databasePath = path.join(f.policy.control_root, "updater.sqlite3");
  const capture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "updater:npm-typecheck" });
  capture.write("stderr", Buffer.from("partial failure detail"));
  const row = f.database.diagnosticLogs(f.claimed.request_id)[0]!;
  const partialPath = path.join(f.policy.control_root, "diagnostics", "logs", `${row.log_id}.part`);
  assert.equal((await fs.stat(partialPath)).isFile(), true);
  f.database.close();
  const reopened = new UpdateDatabase(databasePath);
  try {
    const recoveryStore = new DiagnosticLogStore(f.policy.control_root, f.policy.diagnostic_log_limit_bytes, reopened);
    const syncStore = recoveryStore as unknown as { fsyncLogsDirectory(): void };
    const originalFsync = syncStore.fsyncLogsDirectory.bind(recoveryStore);
    const originalInterrupt = reopened.interruptDiagnosticLog.bind(reopened);
    const events: string[] = [];
    syncStore.fsyncLogsDirectory = () => { events.push("fsync"); originalFsync(); };
    reopened.interruptDiagnosticLog = ((logId, errorCode, at) => {
      events.push("interrupt");
      return originalInterrupt(logId, errorCode, at);
    }) as typeof reopened.interruptDiagnosticLog;
    recoveryStore.recoverInterruptedCaptures(new Date("2026-09-19T01:00:00.000Z"));
    assert.deepEqual(events, ["fsync", "interrupt"]);
    const recovered = reopened.diagnosticLogs(f.claimed.request_id)[0]!;
    assert.equal(recovered.capture_state, "write_failed");
    assert.equal(recovered.error_code, "diagnostic_capture_interrupted");
    assert.equal(recovered.relative_ref, null);
    await assert.rejects(fs.stat(partialPath), { code: "ENOENT" });
  } finally {
    reopened.close();
    capture.finish(false);
  }
});

test("singleton recovery fsyncs an already absent capture before dropping its DB reference", async () => {
  const f = await fixture();
  const capture = f.store.start({ request_id: f.claimed.request_id, attempt: f.claimed.attempt, step: "updater:npm-recovery-missing" });
  capture.write("stderr", Buffer.from("partial failure detail"));
  const row = f.database.diagnosticLogs(f.claimed.request_id)[0]!;
  const partialPath = path.join(f.policy.control_root, "diagnostics", "logs", `${row.log_id}.part`);
  await fs.unlink(partialPath);
  const syncStore = f.store as unknown as { fsyncLogsDirectory(): void };
  const originalFsync = syncStore.fsyncLogsDirectory.bind(f.store);
  const originalInterrupt = f.database.interruptDiagnosticLog.bind(f.database);
  const events: string[] = [];
  try {
    syncStore.fsyncLogsDirectory = () => { events.push("fsync"); originalFsync(); };
    f.database.interruptDiagnosticLog = ((logId, errorCode, at) => {
      events.push("interrupt");
      return originalInterrupt(logId, errorCode, at);
    }) as typeof f.database.interruptDiagnosticLog;
    f.store.recoverInterruptedCaptures(new Date("2026-09-19T01:30:00.000Z"));
    assert.deepEqual(events, ["fsync", "interrupt"]);
    const recovered = f.database.diagnosticLogs(f.claimed.request_id)[0]!;
    assert.equal(recovered.capture_state, "write_failed");
    assert.equal(recovered.relative_ref, null);
  } finally {
    syncStore.fsyncLogsDirectory = originalFsync;
    f.database.interruptDiagnosticLog = originalInterrupt;
    f.database.close();
    capture.finish(false);
  }
});
});
