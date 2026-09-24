import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";

import { JobResultPublishCapabilities, JobResultPublishError, jobResultEnvelopeMaxBytes, validateJobResultPublish } from "../src/job-result-publish.js";
import { buildJobResultPublishInstructions } from "../src/job-prompt.js";
import { JobResultPublishServer } from "../src/job-result-publish-transport.js";
import type { JobRow } from "../src/types.js";

const base = { schema_version: 1, status: "completed", summary: "確認済み", artifacts: [{ kind: "report" }], actions: [] };
const row = (overrides: Partial<JobRow> = {}): JobRow => ({
  job_id: "job_one", status: "dispatching", attempt_count: 1, herdr_pane_id: "pane-1",
  ...overrides,
} as JobRow);
const code = (expected: string) => (error: unknown): boolean => error instanceof JobResultPublishError && error.code === expected;

describe("job result publish contract", () => {
  test("構造化入力だけを許し、Dispatcher所有fieldを補完する", () => {
    const result = validateJobResultPublish(base, row(), "2026-09-24T00:00:00.000Z");
    assert.equal(result.envelope.job_id, "job_one");
    assert.equal(result.envelope.completed_at, "2026-09-24T00:00:00.000Z");
    assert.equal(result.envelope.artifacts?.length, 1);
    for (const extra of [{ job_id: "job_two" }, { completed_at: "2020-01-01T00:00:00Z" }, { owner: "other" }, { result_path: "/tmp/x" }]) {
      assert.throws(() => validateJobResultPublish({ ...base, ...extra }, row(), "2026-09-24T00:00:00Z"), code("invalid_request"));
    }
    assert.throws(() => validateJobResultPublish({ ...base, schema_version: 2 }, row(), "2026-09-24T00:00:00Z"), code("invalid_request"));
    assert.throws(() => validateJobResultPublish({ ...base, artifacts: ["text"] }, row(), "2026-09-24T00:00:00Z"), code("invalid_request"));
    assert.throws(() => validateJobResultPublish({ ...base, artifacts: [{ bad: undefined }] }, row(), "2026-09-24T00:00:00Z"), code("invalid_request"));
    let nested: unknown = "value";
    for (let index = 0; index < 70; index++) nested = { child: nested };
    assert.throws(() => validateJobResultPublish({ ...base, artifacts: [{ nested }] }, row(), "2026-09-24T00:00:00Z"), code("invalid_request"));
  });

  test("UTF-8と最終envelopeの1 MiB境界を検証する", () => {
    const at = (size: number) => validateJobResultPublish({ ...base, summary: "あ".repeat(size) }, row(), "2026-09-24T00:00:00Z");
    let low = 1; let high = jobResultEnvelopeMaxBytes;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      try { at(middle); low = middle; } catch (error) { assert.ok(code("payload_too_large")(error)); high = middle - 1; }
    }
    assert.ok(at(low).encodedBytes <= jobResultEnvelopeMaxBytes);
    assert.throws(() => at(low + 1), code("payload_too_large"));
    assert.throws(() => validateJobResultPublish({ ...base, summary: "\ud800" }, row(), "2026-09-24T00:00:00Z"), code("invalid_request"));
  });

  test("secret、private URL、local pathは本文を返さない型付きerrorで拒否する", () => {
    assert.equal(validateJobResultPublish({ ...base, summary: "公開資料: https://github.com/hiragram/dona/issues/290" }, row(), "2026-09-24T00:00:00Z").envelope.status, "completed");
    for (const canary of ["secret=CANARY_VALUE", "Bearer abcdefghijklmnop", "https://files.slack.com/private/abc", "https://blob.example.test/file?sv=1&sig=CANARY_VALUE", "https://CANARY_VALUE@private.example/repo", "https://user:@private.example/repo", "postgresql://admin:CANARY_VALUE@db.internal/app", "redis://:CANARY_VALUE@cache.internal/0", "amqps://user:CANARY_VALUE@mq.internal/vhost", "/Users/example/private.txt", "/root/.dona/workspaces/job", "/workspace/dona/job", "`/workspace/dona/job`", "path=/root/.dona/job", "ghp_abcdefghijklmnop"]) {
      try {
        validateJobResultPublish({ ...base, artifacts: [{ nested: { value: canary } }] }, row(), "2026-09-24T00:00:00Z");
        assert.fail("must reject");
      } catch (error) {
        assert.ok(code("content_requires_redaction")(error));
        assert.equal(JSON.stringify(error).includes(canary), false);
        assert.equal(String(error).includes(canary), false);
      }
    }
    assert.throws(() => validateJobResultPublish({ ...base, artifacts: [{ token: "CANARY_VALUE" }] }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    assert.throws(() => validateJobResultPublish({ ...base, actions: [{ nested: { api_key: "CANARY_VALUE" } }] }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    for (const key of ["client_secret", "clientSecret", "refresh_token", "authorization", "cookie", "set-cookie", "passwd", "passphrase", "herdr_pane_id", "agent_session", "workspacePath"]) {
      assert.throws(() => validateJobResultPublish({ ...base, artifacts: [{ [key]: "CANARY_VALUE" }] }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    }
    for (const assignment of ["AWS_SECRET_ACCESS_KEY=CANARY_VALUE", "PGPASSWORD=CANARY_VALUE", "GITHUB_TOKEN=CANARY_VALUE", '{"client_secret":"CANARY_VALUE"}', '{"client-secret":"CANARY_VALUE"}', '{"set-cookie":"sessionid=CANARY_VALUE"}', '"password" = "CANARY_VALUE"']) {
      assert.throws(() => validateJobResultPublish({ ...base, output: { format: "text", text: assignment } }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    }
    assert.equal(validateJobResultPublish({ ...base, summary: `x://:${"a:".repeat(5000)}` }, row(), "2026-09-24T00:00:00Z").envelope.status, "completed");
    const repeatedUrls = "http://x?foo=".repeat(20_000);
    const started = performance.now();
    assert.equal(validateJobResultPublish({ ...base, summary: repeatedUrls }, row(), "2026-09-24T00:00:00Z").envelope.status, "completed");
    assert.ok(performance.now() - started < 2_000, "署名URL検査は大きな本文でも線形時間で終わる");
  });

  test("canonical digestはkey順とDispatcher時刻によらず同一で、内容の差を識別する", () => {
    const first = validateJobResultPublish(base, row(), "2026-09-24T00:00:00Z");
    const reordered = validateJobResultPublish({ actions: [], artifacts: [{ kind: "report" }], summary: "確認済み", status: "completed", schema_version: 1 }, row(), "2026-09-24T01:00:00Z");
    assert.equal(first.canonicalDigest, reordered.canonicalDigest);
    assert.notEqual(first.canonicalDigest, validateJobResultPublish({ ...base, summary: "別内容" }, row(), "2026-09-24T00:00:00Z").canonicalDigest);
    assert.notEqual(first.canonicalDigest, validateJobResultPublish(base, row({ job_id: "job_two" }), "2026-09-24T00:00:00Z").canonicalDigest);
    const unicode = validateJobResultPublish({ ...base, artifacts: [{ "😀": 2, "\ue000": 1 }] }, row(), "2026-09-24T00:00:00Z");
    const codePointJson = '{"actions":[],"artifacts":[{"\ue000":1,"😀":2}],"schema_version":1,"status":"completed","summary":"確認済み"}';
    assert.equal(unicode.canonicalDigest, createHash("sha256").update(`job-result-publish:v1\njob_one\n${codePointJson}`).digest("hex"));
  });

  test("単一job、失効、revocation、stale worker、restart時fail closed", () => {
    let now = Date.parse("2026-09-24T00:00:00Z");
    let persistedSession = "session-1";
    const grants = new JobResultPublishCapabilities(() => persistedSession, () => now);
    const original = row();
    const grant = grants.issue(original, "session-1");
    const instructions = buildJobResultPublishInstructions();
    assert.ok(!instructions.includes(grant.capability));
    assert.ok(!instructions.includes(grant.expiresAt));
    assert.ok(instructions.includes("job_id、path、completed_at、ownerは送らず"));
    let current = row({ status: "running" });
    const getJob = (id: string) => id === current.job_id ? current : undefined;
    assert.equal(grants.validate(grant.capability, "session-1", base, getJob).envelope.job_id, "job_one");
    assert.throws(() => grants.validate(grant.capability, "session-1", { ...base, summary: `prefix-${grant.capability}-suffix` }, getJob), code("content_requires_redaction"));
    current = row({ status: "running", agent_name: "internal-worker-42" });
    assert.throws(() => grants.validate(grant.capability, "session-1", { ...base, summary: "internal-worker-42" }, getJob), code("content_requires_redaction"));
    current = row({ status: "running", agent_name: "s1" });
    assert.throws(() => grants.validate(grant.capability, "session-1", { ...base, summary: "s1" }, getJob), code("content_requires_redaction"));
    assert.equal(grants.validate(grant.capability, "session-1", { ...base, summary: "task s1 is complete" }, getJob).envelope.status, "completed");
    current = row({ status: "running" });
    assert.throws(() => grants.validate(grant.capability, "session-1", base, () => row({ job_id: "job_two" })), code("capability_invalid"));
    assert.throws(() => grants.validate(grant.capability, "session-2", base, getJob), code("worker_session_stale"));
    persistedSession = "session-2";
    assert.throws(() => grants.validate(grant.capability, "session-1", base, getJob), code("worker_session_stale"));
    persistedSession = "session-1";
    current = row({ status: "running", attempt_count: 2 });
    assert.throws(() => grants.validate(grant.capability, "session-1", base, getJob), code("worker_session_stale"));
    current = row({ status: "running" });
    assert.throws(() => grants.renew(grant.capability, "session-1", getJob), code("renewal_not_due"));
    now += 15 * 60_000;
    const renewed = grants.renew(grant.capability, "session-1", getJob);
    assert.notEqual(renewed.capability, grant.capability);
    assert.throws(() => grants.renew(renewed.capability, "session-1", getJob), code("renewal_not_due"));
    assert.equal(grants.renew(grant.capability, "session-1", getJob).capability, renewed.capability);
    assert.equal(grants.validate(grant.capability, "session-1", base, getJob).envelope.job_id, "job_one");
    assert.throws(() => grants.validate(renewed.capability, "session-1", { ...base, summary: grant.capability }, getJob), code("content_requires_redaction"));
    assert.throws(() => new JobResultPublishCapabilities(() => persistedSession, () => now).validate(grant.capability, "session-1", base, getJob), code("capability_invalid"));
    now = Date.parse(renewed.expiresAt);
    assert.throws(() => grants.validate(renewed.capability, "session-1", base, getJob), code("capability_expired"));
    now -= 1;
    grants.revokeJob("job_one");
    assert.throws(() => grants.validate(renewed.capability, "session-1", base, getJob), code("capability_revoked"));
  });

  test("永続live sessionの512文字上限を発行でも受理する", () => {
    const session = "s".repeat(512);
    const grants = new JobResultPublishCapabilities(() => session);
    const grant = grants.issue(row(), session);
    assert.equal(grants.authorize(grant.capability, session, () => row({ status: "running" })).job_id, "job_one");
    assert.throws(() => grants.issue(row(), `${session}s`), code("job_not_publishable"));
    const short = new JobResultPublishCapabilities(() => "s1");
    const shortGrant = short.issue(row(), "s1");
    assert.throws(() => short.validate(shortGrant.capability, "s1", { ...base, summary: "s1" }, () => row({ status: "running" })), code("content_requires_redaction"));
    assert.equal(short.validate(shortGrant.capability, "s1", { ...base, summary: "task s1 is complete" }, () => row({ status: "running" })).envelope.status, "completed");
  });

  test("同じjobの旧worker世代のsessionとpaneもResultから除外する", () => {
    let live = "session-old";
    const grants = new JobResultPublishCapabilities(() => live);
    grants.issue(row({ herdr_pane_id: "pane-old" }), live);
    live = "session-new";
    const current = row({ status: "running", attempt_count: 2, herdr_pane_id: "pane-new" });
    const grant = grants.issue({ ...current, status: "dispatching" }, live);
    for (const oldIdentity of ["session-old", "pane-old"]) {
      assert.throws(() => grants.validate(grant.capability, live, { ...base, summary: oldIdentity }, () => current), code("content_requires_redaction"));
    }
  });

  test("terminal cleanup後は同じgrantでread-only照合できる", () => {
    let session: string | undefined = "session-1";
    const grants = new JobResultPublishCapabilities(() => session);
    const grant = grants.issue(row(), "session-1");
    session = undefined;
    const terminal = row({ status: "completed", herdr_pane_id: null, result_json: "{}" });
    const candidate = grants.validate(grant.capability, "session-1", base, () => terminal);
    assert.equal(candidate.reconcileOnly, true);
    assert.deepEqual(candidate.fence, { jobId: "job_one", attemptCount: 1, paneId: "pane-1", session: "session-1" });
    assert.throws(() => grants.validate(grant.capability, "other-session", base, () => terminal), code("worker_session_stale"));
    assert.throws(() => grants.validate(grant.capability, "session-1", base, () => row({ status: "completed", herdr_pane_id: null, result_json: null })), code("worker_session_stale"));
  });

  test("専用UDSだけで認可し、本文・capabilityを応答せずcommit材料へ渡す", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dona-result-contract-"));
    const socket = path.join(directory, "p.sock");
    let now = Date.now();
    const grants = new JobResultPublishCapabilities(() => "session-1", () => now);
    const grant = grants.issue(row(), "session-1");
    let current = row({ status: "running" });
    const accepted: string[] = [];
    const reconciled: string[] = [];
    const server = new JobResultPublishServer(socket, grants, id => id === current.job_id ? current : undefined,
      { commit: async candidate => { assert.deepEqual(candidate.fence, { jobId: "job_one", attemptCount: 1, paneId: "pane-1", session: "session-1" }); accepted.push(candidate.canonicalDigest); return { outcome: "created" }; },
        reconcile: async candidate => { reconciled.push(candidate.canonicalDigest); return { outcome: "reused" }; } });
    const post = (body: string | Buffer, capability?: string, session = "session-1", route = "/v1/job-result-publish") => new Promise<{ status: number; body: string; connection: string | undefined }>((resolve, reject) => {
      const request = http.request({ socketPath: socket, path: route, method: "POST",
        headers: { "content-type": "application/json", ...(capability ? { "x-dona-job-result-capability": capability } : {}), "x-dona-worker-session": Buffer.from(JSON.stringify(session), "utf8").toString("base64url") } }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8"), connection: response.headers.connection }));
      });
      request.on("error", reject); request.end(body);
    });
    try {
      await server.start();
      const unauthorized = await post(JSON.stringify(base));
      assert.equal(unauthorized.status, 403);
      assert.equal(unauthorized.connection, "close");
      const acceptedResult = await post(JSON.stringify(base), grant.capability);
      assert.equal(acceptedResult.status, 202);
      assert.equal(accepted.length, 1);
      assert.equal(acceptedResult.body.includes(grant.capability), false);
      const secret = await post(JSON.stringify({ ...base, summary: "secret=CANARY_VALUE" }), grant.capability);
      assert.equal(secret.status, 400);
      assert.equal(secret.connection, "close");
      assert.equal(secret.body.includes("CANARY_VALUE"), false);
      const leaked = await post(JSON.stringify({ ...base, summary: `capability ${grant.capability}` }), grant.capability);
      assert.equal(leaked.status, 400);
      assert.equal(leaked.body.includes(grant.capability), false);
      assert.equal((await post(JSON.stringify({ ...base, artifacts: [{ capability: "CANARY_VALUE" }] }), grant.capability)).status, 400);
      assert.equal((await post(JSON.stringify({ ...base, artifacts: [{ herdr_pane_id: "pane-1", agent_session: "session-1" }] }), grant.capability)).status, 400);
      assert.equal((await post(JSON.stringify({ ...base, summary: "session-1" }), grant.capability)).status, 400);
      assert.equal((await post("{", grant.capability)).status, 400);
      assert.equal((await post(Buffer.from([0xff]), grant.capability)).status, 400);
      assert.equal((await post(JSON.stringify(base), grant.capability, "old-session")).status, 403);
      assert.equal((await post(" ".repeat(jobResultEnvelopeMaxBytes + 1), grant.capability)).status, 413);
      assert.equal((await post("", grant.capability, "session-1", "/v1/job-result-publish/renew")).status, 425);
      now += 15 * 60_000;
      const renewal = await post("", grant.capability, "session-1", "/v1/job-result-publish/renew");
      assert.equal(renewal.status, 200);
      const retriedRenewal = await post("", grant.capability, "session-1", "/v1/job-result-publish/renew");
      assert.equal(retriedRenewal.body, renewal.body);
      assert.equal((await post(JSON.stringify(base), grant.capability)).status, 202);
      assert.equal((await post(JSON.stringify({ ...base, summary: grant.capability }), JSON.parse(renewal.body).capability)).status, 400);
      assert.equal((await post(JSON.stringify(base), JSON.parse(renewal.body).capability)).status, 202);
      assert.equal(accepted.length, 3);
      current = row({ status: "completed", result_json: "{}" });
      const retry = await post(JSON.stringify(base), grant.capability);
      assert.equal(retry.status, 200);
      assert.equal(accepted.length, 3);
      assert.deepEqual(reconciled, [accepted[0]]);
    } finally {
      await server.stop();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("Unicodeと制御文字を含む永続sessionを可逆に認証する", async () => {
    let session = "セッション\n\ud800";
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dona-result-session-"));
    const socket = path.join(directory, "p.sock");
    const grants = new JobResultPublishCapabilities(() => session);
    let grant = grants.issue(row(), session);
    const server = new JobResultPublishServer(socket, grants, () => row({ status: "running" }),
      { commit: async candidate => {
        assert.equal(candidate.fence.session, session);
        return { outcome: "created" };
      }, reconcile: async () => ({ outcome: "reused" }) });
    const post = (encodedSession: string) => new Promise<number>((resolve, reject) => {
      const request = http.request({ socketPath: socket, path: "/v1/job-result-publish", method: "POST",
        headers: { "x-dona-job-result-capability": grant.capability, "x-dona-worker-session": encodedSession } }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode!));
      });
      request.on("error", reject); request.end(JSON.stringify(base));
    });
    try {
      await server.start();
      assert.equal(await post(Buffer.from(JSON.stringify(session), "utf8").toString("base64url")), 202);
      session = "\ud800".repeat(512);
      grant = grants.issue(row(), session);
      const maximumSessionHeader = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
      assert.equal(maximumSessionHeader.length, 4099);
      assert.equal(await post(maximumSessionHeader), 202);
      assert.equal(await post(Buffer.from(JSON.stringify("別session"), "utf8").toString("base64url")), 403);
      assert.equal(await post("%%%"), 403);
    } finally {
      await server.stop();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("本文未完了の接続を期限切れと停止時に閉じる", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dona-result-stall-"));
    const socket = path.join(directory, "p.sock");
    const grants = new JobResultPublishCapabilities(() => "session-1");
    const grant = grants.issue(row(), "session-1");
    const server = new JobResultPublishServer(socket, grants, () => row({ status: "running" }),
      { commit: async () => ({ outcome: "created" }), reconcile: async () => ({ outcome: "reused" }) }, 40);
    const partial = () => new Promise<http.ClientRequest>((resolve, reject) => {
      const request = http.request({ socketPath: socket, path: "/v1/job-result-publish", method: "POST",
        headers: { "x-dona-job-result-capability": grant.capability,
          "x-dona-worker-session": Buffer.from(JSON.stringify("session-1")).toString("base64url") } });
      request.on("error", () => {});
      request.on("socket", client => client.once("connect", () => resolve(request)));
      request.write("{");
      setTimeout(() => reject(new Error("partial request did not connect")), 1_000).unref();
    });
    try {
      await server.start();
      const timed = await partial();
      await Promise.race([new Promise<void>(resolve => timed.once("close", () => resolve())), new Promise((_, reject) => setTimeout(() => reject(new Error("body deadline missed")), 1_000))]);
      const active = await partial();
      const started = performance.now();
      await server.stop();
      assert.ok(performance.now() - started < 1_000);
      active.destroy();
    } finally {
      await server.stop();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("認証拒否時に未完了本文の接続を閉じ、開始済みcommitは停止前に待つ", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dona-result-stop-"));
    const socket = path.join(directory, "p.sock");
    const grants = new JobResultPublishCapabilities(() => "session-1");
    const grant = grants.issue(row(), "session-1");
    let enteredCommit!: () => void;
    const committed = new Promise<void>(resolve => { enteredCommit = resolve; });
    let finishCommit!: () => void;
    const commitBarrier = new Promise<void>(resolve => { finishCommit = resolve; });
    const server = new JobResultPublishServer(socket, grants, () => row({ status: "running" }),
      { commit: async () => { enteredCommit(); await commitBarrier; return { outcome: "created" }; },
        reconcile: async () => ({ outcome: "reused" }) });
    try {
      await server.start();
      const rejected = http.request({ socketPath: socket, path: "/v1/job-result-publish", method: "POST",
        headers: { "content-length": "100000" } });
      rejected.on("error", () => {});
      const rejectedClosed = new Promise<void>(resolve => rejected.once("close", () => resolve()));
      rejected.write("{");
      await Promise.race([rejectedClosed, new Promise((_, fail) => setTimeout(() => fail(new Error("unauthorized socket stayed open")), 1_000))]);
      const accepted = new Promise<number>((resolve, fail) => {
        const request = http.request({ socketPath: socket, path: "/v1/job-result-publish", method: "POST",
          headers: { "x-dona-job-result-capability": grant.capability,
            "x-dona-worker-session": Buffer.from(JSON.stringify("session-1")).toString("base64url") } }, response => {
          response.resume(); response.once("end", () => resolve(response.statusCode!));
        });
        request.once("error", fail); request.end(JSON.stringify(base));
      });
      await committed;
      let stopped = false;
      const stopping = server.stop().then(() => { stopped = true; });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(stopped, false);
      finishCommit();
      assert.equal(await accepted, 202);
      await stopping;
      assert.equal(stopped, true);
    } finally {
      finishCommit();
      await server.stop();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("commit中にworkerが切断しても停止待機が解放される", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dona-result-disconnect-"));
    const socket = path.join(directory, "p.sock");
    const grants = new JobResultPublishCapabilities(() => "session-1");
    const grant = grants.issue(row(), "session-1");
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const server = new JobResultPublishServer(socket, grants, () => row({ status: "running" }),
      { commit: async () => { entered(); await barrier; return { outcome: "created" }; },
        reconcile: async () => ({ outcome: "reused" }) });
    try {
      await server.start();
      const request = http.request({ socketPath: socket, path: "/v1/job-result-publish", method: "POST",
        headers: { "x-dona-job-result-capability": grant.capability,
          "x-dona-worker-session": Buffer.from(JSON.stringify("session-1")).toString("base64url") } });
      request.on("error", () => {});
      request.end(JSON.stringify(base));
      await started;
      request.destroy();
      release();
      await Promise.race([server.stop(), new Promise((_, fail) => setTimeout(() => fail(new Error("disconnected commit blocked stop")), 1_000))]);
    } finally {
      release();
      await server.stop();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("停止済みUDSを復旧し、稼働中の別ownerは保持する", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dona-result-socket-"));
    const socket = path.join(directory, "p.sock");
    const child = spawn(process.execPath, ["-e", `require('net').createServer().listen(${JSON.stringify(socket)},()=>process.stdout.write('ready'))`], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await once(child.stdout!, "data");
      const server = new JobResultPublishServer(socket, new JobResultPublishCapabilities(() => undefined), () => undefined,
        { commit: async () => ({ outcome: "created" }), reconcile: async () => ({ outcome: "reused" }) });
      await assert.rejects(server.start(), /publish_socket_owned/);
      child.kill("SIGKILL");
      await once(child, "exit");
      assert.equal((await fs.lstat(socket)).isSocket(), true);
      await server.start();
      await server.stop();
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
