import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import Database from "better-sqlite3";

import {
  AnalysisRuntimeError,
  AnalysisRuntimeStore,
  FixedInferenceBroker,
  analysisSnapshotDigest,
  authorizedAnalysisSandboxLaunch,
  startAnalysisScratchGuard,
  type AnalysisReceipt,
} from "../../src/web/analysis-runtime.js";

const start = "2026-09-20T00:00:00.000Z";
const receipt: AnalysisReceipt = {
  codec_version: 1, profile: "analysis.read_only.v1", receipt_id: "receipt_1", job_id: "job_1",
  instance_id: "instance", tenant_id: "tenant", principal_id: "principal", session_generation: 1,
  authz_revision: 1, owner_revision: 1, source_manifest_id: "manifest_1",
  source_manifest_digest: "a".repeat(64), source_grant_revision: 1, snapshot_digest: "b".repeat(64),
  broker_id: "broker", broker_generation: 1, model: "fixed_model", tokenizer: "fixed_tokenizer",
  maximum_calls: 2, maximum_tokens: 20, maximum_runtime_ms: 60_000, maximum_scratch_bytes: 1024,
  issued_at: start, expires_at: "2026-09-20T00:01:00.000Z",
};
const current = {
  receipt_id: receipt.receipt_id, job_id: receipt.job_id, instance_id: receipt.instance_id,
  tenant_id: receipt.tenant_id, principal_id: receipt.principal_id, session_generation: receipt.session_generation,
  authz_revision: receipt.authz_revision, owner_revision: receipt.owner_revision,
  source_manifest_id: receipt.source_manifest_id, source_manifest_digest: receipt.source_manifest_digest,
  source_grant_revision: receipt.source_grant_revision, snapshot_digest: receipt.snapshot_digest,
  broker_id: receipt.broker_id, broker_generation: receipt.broker_generation,
};

function authorization(value: AnalysisReceipt) {
  return { receipt_id: value.receipt_id, job_id: value.job_id, instance_id: value.instance_id,
    tenant_id: value.tenant_id, principal_id: value.principal_id, session_generation: value.session_generation,
    authz_revision: value.authz_revision, owner_revision: value.owner_revision,
    source_manifest_id: value.source_manifest_id, source_manifest_digest: value.source_manifest_digest,
    source_grant_revision: value.source_grant_revision, snapshot_digest: value.snapshot_digest,
    broker_id: value.broker_id, broker_generation: value.broker_generation };
}
function setup(t: test.TestContext, configured = receipt) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dona-analysis-runtime-"));
  const filename = path.join(directory, "runtime.sqlite");
  const db = new Database(filename); db.pragma("foreign_keys=ON"); db.pragma("journal_mode=WAL"); db.pragma("synchronous=FULL");
  const secret = Buffer.alloc(32, 0x41); const store = new AnalysisRuntimeStore(db, secret); store.register(configured);
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { db, filename, secret, store };
}

test("analysis profileはnetwork・shell・snapshot外filesystemとambient credentialを公開しない", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dona-analysis-profile-"));
  const worker = path.join(directory, "analysis-worker"), snapshot = path.join(directory, "snapshot"), scratch = path.join(directory, "scratch");
  fs.writeFileSync(worker, "fixture"); fs.mkdirSync(snapshot); fs.mkdirSync(scratch);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configured = { ...receipt, snapshot_digest: analysisSnapshotDigest(snapshot) };
  const { store } = setup(t, configured);
  const permit = store.authorizeStage(configured.receipt_id, "snapshot_open", authorization(configured), 1, start);
  const launch = authorizedAnalysisSandboxLaunch({ store, snapshot_permit: permit, current: authorization(configured),
    worker_executable: worker, snapshot_path: snapshot, scratch_path: scratch, now: start });
  assert.equal(launch.executable, "/usr/bin/sandbox-exec");
  assert.equal(launch.args[2], fs.realpathSync(worker));
  assert.match(launch.args[1], /\(deny network\*\)/);
  assert.ok(launch.args[1].includes(`(allow process-exec (literal "${fs.realpathSync(worker)}"))`));
  assert.match(launch.args[1], /\(deny process-fork\)/);
  assert.doesNotMatch(launch.args[1], /allow network|allow process\*|\/Users|\.ssh|Keychain/);
  assert.deepEqual(launch.env, { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });
  for (const name of ["HOME", "GH_TOKEN", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY"]) assert.equal(name in launch.env, false);
  assert.equal(launch.scratch_quota.maximum_bytes, configured.maximum_scratch_bytes);
  fs.writeFileSync(path.join(scratch, "overflow"), Buffer.alloc(configured.maximum_scratch_bytes + 1));
  let killed = false; const stop = startAnalysisScratchGuard(launch, () => { killed = true; }); stop(); assert.equal(killed, true);
});

test("macOS sandbox実体でnetwork・shell・snapshot外file到達が0になる", { skip: process.platform !== "darwin" }, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dona-analysis-sandbox-"));
  const snapshot = path.join(directory, "snapshot"), scratch = path.join(directory, "scratch"), outside = path.join(directory, "outside");
  fs.mkdirSync(snapshot); fs.mkdirSync(scratch); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(snapshot, "allowed.txt"), "snapshot"); fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  const source = path.join(directory, "worker.c"), worker = path.join(snapshot, "worker");
  fs.writeFileSync(source, `#include <arpa/inet.h>\n#include <fcntl.h>\n#include <stdio.h>\n#include <sys/socket.h>\n#include <sys/wait.h>\n#include <unistd.h>\nint main(int n,char**v){char b[9]={0};int f=open(v[1],O_RDONLY);int snapshot=f>=0&&read(f,b,8)==8;if(f>=0)close(f);f=open(v[2],O_WRONLY|O_CREAT,0600);int scratch=f>=0;if(f>=0){write(f,"ok",2);close(f);}f=open(v[3],O_RDONLY);int outside=f>=0;if(f>=0)close(f);pid_t p=fork();int shell=0;if(p==0){execl("/bin/sh","sh","-c","true",NULL);_exit(127);}else if(p>0){int s;waitpid(p,&s,0);shell=WIFEXITED(s)&&WEXITSTATUS(s)==0;}int s=socket(AF_INET,SOCK_STREAM,0),network=0;if(s>=0){struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(9)};inet_pton(AF_INET,"127.0.0.1",&a.sin_addr);network=connect(s,(struct sockaddr*)&a,sizeof(a))==0;close(s);}printf("{\\\"snapshot\\\":%s,\\\"scratch\\\":%s,\\\"outside\\\":%s,\\\"shell\\\":%s,\\\"network\\\":%s}",snapshot?"true":"false",scratch?"true":"false",outside?"true":"false",shell?"true":"false",network?"true":"false");}`);
  const compiled = spawnSync("/usr/bin/clang", [source, "-o", worker], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configured = { ...receipt, snapshot_digest: analysisSnapshotDigest(snapshot) };
  const { store } = setup(t, configured);
  const launch = authorizedAnalysisSandboxLaunch({ store,
    snapshot_permit: store.authorizeStage(configured.receipt_id, "snapshot_open", authorization(configured), 1, start),
    current: authorization(configured), worker_executable: worker, snapshot_path: snapshot, scratch_path: scratch, now: start });
  const run = spawnSync(launch.executable, [...launch.args, path.join(snapshot, "allowed.txt"),
    path.join(scratch, "result.txt"), path.join(outside, "secret.txt")], { cwd: launch.cwd, env: launch.env, encoding: "utf8" });
  assert.equal(run.status, 0, JSON.stringify({ error: run.error?.message, signal: run.signal, stderr: run.stderr, stdout: run.stdout })); assert.deepEqual(JSON.parse(run.stdout),
    { snapshot: true, scratch: true, outside: false, shell: false, network: false });
});

test("receiptはowner・source manifest・quotaをdurableに固定しpayload差替えを拒否する", (t) => {
  const f = setup(t);
  assert.equal(f.store.register(receipt).outcome, "reused");
  assert.throws(() => f.store.register({ ...receipt, source_manifest_digest: "c".repeat(64) }),
    (error) => error instanceof AnalysisRuntimeError && error.code === "conflict");
  const other = new Database(f.filename); other.pragma("journal_mode=WAL"); other.pragma("synchronous=FULL"); other.pragma("foreign_keys=ON");
  try { assert.equal(new AnalysisRuntimeStore(other, f.secret).register(receipt).outcome, "reused"); } finally { other.close(); }
});

test("stageごとにcurrent owner・grant・broker identityを再認可する", (t) => {
  const { store } = setup(t);
  assert.throws(() => store.authorizeStage(receipt.receipt_id, "inference", { ...current, authz_revision: 2 }, 5, start),
    (error) => error instanceof AnalysisRuntimeError && error.code === "denied");
  assert.throws(() => store.authorizeStage(receipt.receipt_id, "inference", { ...current, source_manifest_digest: "c".repeat(64) }, 5, start));
  assert.throws(() => store.authorizeStage(receipt.receipt_id, "inference", { ...current, broker_generation: 2 }, 5, start));
  assert.match(store.authorizeStage(receipt.receipt_id, "inference", current, 5, start), /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test("snapshot_openはone-shot permitと実snapshot digestを照合する", (t) => {
  const { store } = setup(t);
  const permit = store.authorizeStage(receipt.receipt_id, "snapshot_open", current, 1, start);
  assert.throws(() => store.consumeSnapshotPermit(permit, current, "c".repeat(64), start),
    (error) => error instanceof AnalysisRuntimeError && error.code === "denied");
});

test("receipt payloadやquota ledgerのDB改変はpermit発行をfail closedする", (t) => {
  const { store, db } = setup(t);
  db.prepare("UPDATE analysis_runtime_receipts SET payload_json=? WHERE receipt_id=?")
    .run(JSON.stringify({ ...receipt, maximum_tokens: 999 }), receipt.receipt_id);
  assert.throws(() => store.authorizeStage(receipt.receipt_id, "inference", current, 5, start),
    (error) => error instanceof AnalysisRuntimeError && error.code === "denied");
  db.prepare("UPDATE analysis_runtime_receipts SET payload_json=?,payload_digest=?,used_calls=1,reserved_tokens=1 WHERE receipt_id=?")
    .run(JSON.stringify(receipt), createHash("sha256").update(JSON.stringify(receipt)).digest("hex"), receipt.receipt_id);
  assert.throws(() => store.authorizeStage(receipt.receipt_id, "inference", current, 5, start),
    (error) => error instanceof AnalysisRuntimeError && error.code === "denied");
});

test("in-memory・rollback journal・非同期durability設定を拒否する", (t) => {
  const memory = new Database(":memory:"); t.after(() => memory.close());
  assert.throws(() => new AnalysisRuntimeStore(memory, Buffer.alloc(32)), AnalysisRuntimeError);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dona-analysis-durability-"));
  const db = new Database(path.join(directory, "bad.sqlite")); t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.throws(() => new AnalysisRuntimeStore(db, Buffer.alloc(32)), AnalysisRuntimeError);
});

test("permitはone-shot fenceでconcurrent利用とtamper・expiryを拒否する", async (t) => {
  const { store } = setup(t); let now = start; let calls = 0;
  const broker = new FixedInferenceBroker(store, { broker_id: "broker", broker_generation: 1,
    endpoint: "https://inference.invalid/v1/fixed", model: "fixed_model", tokenizer: "fixed_tokenizer" }, Buffer.alloc(32, 0x42),
  { invoke: async () => { calls++; return { output: "ok", usage_tokens: 2 }; } }, () => now);
  const permit = store.authorizeStage(receipt.receipt_id, "inference", current, 5, start);
  const settled = await Promise.allSettled([broker.invoke({ permit, prompt: "one" }), broker.invoke({ permit, prompt: "one" })]);
  assert.equal(settled.filter((value) => value.status === "fulfilled").length, 1); assert.equal(calls, 1);
  const tampered = `${permit.slice(0, -1)}${permit.endsWith("A") ? "B" : "A"}`;
  await assert.rejects(broker.invoke({ permit: tampered, prompt: "two" }));
  const expiring = store.authorizeStage(receipt.receipt_id, "inference", current, 5, start);
  now = "2026-09-20T00:00:11.000Z"; await assert.rejects(broker.invoke({ permit: expiring, prompt: "late" }));
});

test("brokerだけがcredentialを受け取りmodel・endpoint・quotaを固定する", async (t) => {
  const { store } = setup(t); let observed: Record<string, unknown> | undefined;
  const credential = Buffer.alloc(32, 0x55);
  const broker = new FixedInferenceBroker(store, { broker_id: "broker", broker_generation: 1,
    endpoint: "https://inference.invalid/v1/fixed", model: "fixed_model", tokenizer: "fixed_tokenizer" }, credential,
  { invoke: async (input) => { observed = input; return { output: "answer", usage_tokens: 3 }; } }, () => start);
  const permit = store.authorizeStage(receipt.receipt_id, "inference", current, 5, start);
  const result = await broker.invoke({ permit, prompt: "private snapshot excerpt" });
  assert.equal(result.output, "answer"); assert.equal(observed?.endpoint, "https://inference.invalid/v1/fixed");
  assert.equal(observed?.model, "fixed_model"); assert.equal(observed?.maximum_tokens, 5);
  assert.strictEqual(observed?.credential, credential);
  assert.ok(!JSON.stringify(store.reconcileCall(result.call_id)).includes("private snapshot excerpt"));
  assert.ok(!JSON.stringify(store.reconcileCall(result.call_id)).includes(credential.toString("hex")));
});

test("broker identity・scope・quota改変はprovider call前に拒否する", async (t) => {
  const { store } = setup(t); let calls = 0;
  const wrong = new FixedInferenceBroker(store, { broker_id: "other", broker_generation: 1,
    endpoint: "https://inference.invalid/v1/fixed", model: "fixed_model", tokenizer: "fixed_tokenizer" }, Buffer.alloc(32, 1),
  { invoke: async () => { calls++; return { output: "bad", usage_tokens: 1 }; } }, () => start);
  const permit = store.authorizeStage(receipt.receipt_id, "inference", current, 5, start);
  await assert.rejects(wrong.invoke({ permit, prompt: "x" }), (error) => error instanceof AnalysisRuntimeError && error.code === "denied");
  assert.equal(calls, 0);
  assert.throws(() => store.authorizeStage(receipt.receipt_id, "inference", current, 21, start),
    (error) => error instanceof AnalysisRuntimeError && error.code === "quota");
});

test("timeout・crash後はreservationを返さずrestart後にacceptance_unknownを照合する", async (t) => {
  const f = setup(t);
  const broker = new FixedInferenceBroker(f.store, { broker_id: "broker", broker_generation: 1,
    endpoint: "https://inference.invalid/v1/fixed", model: "fixed_model", tokenizer: "fixed_tokenizer" }, Buffer.alloc(32, 1),
  { invoke: async () => { throw new Error("connection lost"); } }, () => start);
  const permit = f.store.authorizeStage(receipt.receipt_id, "inference", current, 8, start);
  await assert.rejects(broker.invoke({ permit, prompt: "x" }), (error) => error instanceof AnalysisRuntimeError && error.code === "ambiguous");
  const call = f.db.prepare("SELECT call_id FROM analysis_runtime_calls").get() as { call_id: string };
  const other = new Database(f.filename); other.pragma("journal_mode=WAL"); other.pragma("synchronous=FULL"); other.pragma("foreign_keys=ON");
  try {
    const recovered = new AnalysisRuntimeStore(other, f.secret).reconcileCall(call.call_id);
    assert.equal(recovered?.status, "acceptance_unknown"); assert.equal(recovered?.reserved_tokens, 8);
    const recoveredStore = new AnalysisRuntimeStore(other, f.secret);
    assert.throws(() => recoveredStore.authorizeStage(receipt.receipt_id, "inference", current, 1, start),
      (error) => error instanceof AnalysisRuntimeError && error.code === "denied");
  } finally { other.close(); }
});

test("broker timeoutはtransportをabortしてacceptance_unknownを永続化する", async (t) => {
  const f = setup(t); let aborted = false;
  const broker = new FixedInferenceBroker(f.store, { broker_id: "broker", broker_generation: 1,
    endpoint: "https://inference.invalid/v1/fixed", model: "fixed_model", tokenizer: "fixed_tokenizer" }, Buffer.alloc(32, 1),
  { invoke: ({ signal }) => new Promise((resolve) => {
    signal.addEventListener("abort", () => { aborted = true; resolve({ output: "late", usage_tokens: 1 }); }, { once: true });
  }) }, () => start, 5);
  const permit = f.store.authorizeStage(receipt.receipt_id, "inference", current, 8, start);
  await assert.rejects(broker.invoke({ permit, prompt: "x" }), (error) => error instanceof AnalysisRuntimeError && error.code === "ambiguous");
  assert.equal(aborted, true);
  const call = f.db.prepare("SELECT call_id FROM analysis_runtime_calls").get() as { call_id: string };
  assert.equal(f.store.reconcileCall(call.call_id)?.status, "acceptance_unknown");
});

test("provider受理後の応答検証失敗はreceiptをneeds_reviewで停止する", async (t) => {
  const { store } = setup(t);
  const broker = new FixedInferenceBroker(store, { broker_id: "broker", broker_generation: 1,
    endpoint: "https://inference.invalid/v1/fixed", model: "fixed_model", tokenizer: "fixed_tokenizer" }, Buffer.alloc(32, 1),
  { invoke: async () => ({ output: "overspent", usage_tokens: 6 }) }, () => start);
  const permit = store.authorizeStage(receipt.receipt_id, "inference", current, 5, start);
  await assert.rejects(broker.invoke({ permit, prompt: "x" }),
    (error) => error instanceof AnalysisRuntimeError && error.code === "ambiguous");
  assert.throws(() => store.authorizeStage(receipt.receipt_id, "inference", current, 1, start),
    (error) => error instanceof AnalysisRuntimeError && error.code === "denied");
});

test("resultはsource manifestへ結合しredacted digestだけを保存する", async (t) => {
  const { store } = setup(t);
  const broker = new FixedInferenceBroker(store, { broker_id: "broker", broker_generation: 1,
    endpoint: "https://inference.invalid/v1/fixed", model: "fixed_model", tokenizer: "fixed_tokenizer" }, Buffer.alloc(32, 1),
  { invoke: async () => ({ output: "sensitive answer", usage_tokens: 2 }) }, () => start);
  const result = await broker.invoke({ permit: store.authorizeStage(receipt.receipt_id, "inference", current, 5, start), prompt: "input" });
  assert.equal(store.reconcileCall(result.call_id)?.status, "succeeded");
  const wrongPermit = store.authorizeStage(receipt.receipt_id, "result_commit", current, 1, start);
  assert.throws(() => store.commitResult(receipt.receipt_id, wrongPermit, current, "e".repeat(64), "d".repeat(64), start));
  const permit = store.authorizeStage(receipt.receipt_id, "result_commit", current, 1, start);
  assert.throws(() => store.commitResult(receipt.receipt_id, permit, { ...current, authz_revision: 2 }, receipt.source_manifest_digest, "d".repeat(64), start));
  const finalPermit = store.authorizeStage(receipt.receipt_id, "result_commit", current, 1, start);
  store.commitResult(receipt.receipt_id, finalPermit, current, receipt.source_manifest_digest, "d".repeat(64), start);
  assert.throws(() => store.authorizeStage(receipt.receipt_id, "inference", current, 1, start));
});
