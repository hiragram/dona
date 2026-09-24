import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { createHash } from "node:crypto";

import { JobResultPublishCapabilities, JobResultPublishError, jobResultEnvelopeMaxBytes, jobResultPublishTtlMs, validateJobResultPublish } from "../src/job-result-publish.js";
import { buildJobResultPublishInstructions } from "../src/job-prompt.js";
import { JobResultPublishServer } from "../src/job-result-publish-transport.js";
import type { JobRow } from "../src/types.js";

const base = { schema_version: 1, status: "completed", summary: "確認済み", artifacts: [{ kind: "report" }], actions: [] };
const row = (overrides: Partial<JobRow> = {}): JobRow => ({
  job_id: "job_one", status: "dispatching", attempt_count: 1, herdr_pane_id: "pane-1",
  ...overrides,
} as JobRow);
const code = (expected: string) => (error: unknown): boolean => error instanceof JobResultPublishError && error.code === expected;
const testListeners = new WeakMap<JobResultPublishServer, net.Server>();
async function startServer(server: JobResultPublishServer, socket: string, onConnection?: (connection: net.Socket) => void): Promise<void> {
  const listener = net.createServer(connection => { onConnection?.(connection); server.accept(connection); });
  await new Promise<void>((resolve, reject) => listener.once("error", reject).listen(socket, resolve));
  testListeners.set(server, listener);
}
async function stopServer(server: JobResultPublishServer): Promise<void> {
  await server.stop();
  const listener = testListeners.get(server);
  if (listener?.listening) await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  testListeners.delete(server);
}

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
    for (const canary of ["secret=CANARY_VALUE", "auth=CANARY_VALUE", "session_id=CANARY_VALUE", "session-id=CANARY_VALUE", "AccountKey=CANARY_VALUE", "Bearer abcdefghijklmnop", "-----BEGIN ENCRYPTED PRIVATE KEY-----", "-----BEGIN PGP PRIVATE KEY BLOCK-----", "https://files.slack.com/private/abc", "https://files.slack.com./private/abc", "https://blob.example.test/file?sv=1&sig=CANARY_VALUE", "https://blob.example.test/file?sv=1&%73ig=CANARY_VALUE", "http://localhost:3000/download/OPAQUE_VALUE", "http://localhost.:3000/download/OPAQUE_VALUE", "http://127.0.0.1:8080/private", "http://127.1/private", "http://[::1]/private", "http://10.0.0.5/download/OPAQUE_VALUE", "http://172.16.0.1/private", "http://192.168.1.1/private", "http://169.254.169.254/private", "http://[fc00::1]/private", "http://[fe80::1]/private", "http://[::ffff:10.0.0.5]/private", "https://CANARY_VALUE@private.example/repo", "https://user:@private.example/repo", "postgresql://admin:CANARY_VALUE@db.internal/app", "redis://:CANARY_VALUE@cache.internal/0", "amqps://user:CANARY_VALUE@mq.internal/vhost", "/Users/example/private.txt", "/root/.dona/workspaces/job", "/workspace/dona/job", "`/workspace/dona/job`", "path=/root/.dona/job", "C:/Users/example/.ssh/id_rsa", "D:/private/result.json", "\\\\fileserver\\share\\private\\result.json", "//fileserver/share/private/result.json", "<!channel>", "<!here>", "<!everyone>", "<!subteam^S12345678>", "<@U12345678>", "ghp_abcdefghijklmnop"]) {
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
    for (const key of ["client_secret", "clientSecret", "refresh_token", "authorization", "auth", "session_id", "sessionId", "sessionid", "cookie", "set-cookie", "passwd", "passphrase", "account_key", "AccountKey", "herdr_pane_id", "agent_session", "workspacePath"]) {
      assert.throws(() => validateJobResultPublish({ ...base, artifacts: [{ [key]: "CANARY_VALUE" }] }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    }
    for (const value of ["session=CANARY_VALUE", "api.key=CANARY_VALUE", "access.key=CANARY_VALUE", "private.key=CANARY_VALUE",
      '{"to\\u006ben":"CANARY_VALUE"}',
      '{"kty":"RSA","n":"public","e":"AQAB","d":"PRIVATE_VALUE"}',
      '{"d":"PRIVATE_VALUE","kty":"RSA","n":"public"}',
      '{"kty":"R\\u0053A","n":"public","d":"PRIVATE_VALUE"}',
      '{"kty":"RSA","n":"public","d":"PRIVATE_VALUE"']) {
      assert.throws(() => validateJobResultPublish({ ...base, summary: value }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    }
    for (const value of [{ session: "CANARY_VALUE" }, { kty: "RSA", n: "public", e: "AQAB", d: "PRIVATE_VALUE" },
      { kty: "oct", k: "PRIVATE_VALUE" }]) {
      assert.throws(() => validateJobResultPublish({ ...base, artifacts: [value] }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    }
    for (const value of ["http://artifact-service.internal/download/OPAQUE_VALUE", "http://artifact/download/OPAQUE_VALUE",
      "http://cache.local/private", "ftp://10.0.0.5/private/archive.zip", "sftp://artifact.internal/result",
      "https://example.com/file?access%5Ftoken=CANARY_VALUE", "https://example.com/file?client%5Fsecret=CANARY_VALUE",
      "prefix_https://10.0.0.1/private", "https://example.com/callback#access%5Ftoken=CANARY_VALUE",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGVzdHNpZ25hdHVyZQ",
      "eyJhbGciOiJIUzI1NiJ9.e30.dGVzdHNpZ25hdHVyZQ",
      "//user:CANARY_VALUE@cdn.example.com/private", "//cdn.example.com/file?sig=CANARY_VALUE",
      "//user:CANARY_VALUE@cdn.example.com", "//cdn.example.com?sig=CANARY_VALUE",
      "report,[/root/.dona/result.json]", "report,/home/worker/private.txt",
      "path:/root/.dona/result.json", "保存先:/home/worker/private.txt"]) {
      assert.throws(() => validateJobResultPublish({ ...base, summary: value }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    }
    for (const value of ["//cdn.example.com/assets/report.json", '{"kty":"RSA","n":"public"} {"d":"done"}']) {
      assert.equal(validateJobResultPublish({ ...base, summary: value }, row(), "2026-09-24T00:00:00Z").envelope.status, "completed");
    }
    assert.equal(validateJobResultPublish({ ...base, artifacts: [{ session_count: 3 }], actions: [{ token_count: 100 }] }, row(), "2026-09-24T00:00:00Z").envelope.status, "completed");
    assert.throws(() => validateJobResultPublish({ ...base, artifacts: [{ session_count: "CANARY_VALUE" }] }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    for (const assignment of ["AWS_SECRET_ACCESS_KEY=CANARY_VALUE", "PGPASSWORD=CANARY_VALUE", "GITHUB_TOKEN=CANARY_VALUE", '{"client_secret":"CANARY_VALUE"}', '{"client-secret":"CANARY_VALUE"}', '{"set-cookie":"sessionid=CANARY_VALUE"}', '"password" = "CANARY_VALUE"']) {
      assert.throws(() => validateJobResultPublish({ ...base, output: { format: "text", text: assignment } }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    }
    assert.throws(() => validateJobResultPublish({ ...base, summary: `x://:${"a:".repeat(5000)}` }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    const repeatedUrls = "http://example.com?foo=".repeat(10_000);
    const started = performance.now();
    assert.equal(validateJobResultPublish({ ...base, summary: repeatedUrls }, row(), "2026-09-24T00:00:00Z").envelope.status, "completed");
    assert.ok(performance.now() - started < 2_000, "署名URL検査は大きな本文でも線形時間で終わる");
    const publicJwks = '{"kty":"RSA","n":"public"}'.repeat(8_000);
    const jwkStarted = performance.now();
    assert.equal(validateJobResultPublish({ ...base, summary: publicJwks }, row(), "2026-09-24T00:00:00Z").envelope.status, "completed");
    assert.ok(performance.now() - jwkStarted < 2_000, "JWK本文検査は反復しても線形時間で終わる");
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
    assert.throws(() => validateJobResultPublish({ ...base, actions: [{ count: 9_007_199_254_740_992 }] }, row(), "2026-09-24T00:00:00Z"), code("invalid_request"));
    assert.throws(() => validateJobResultPublish({ ...base, actions: [{ count: 1.5 }] }, row(), "2026-09-24T00:00:00Z"), code("invalid_request"));
    assert.throws(() => validateJobResultPublish({ ...base, summary: " \n\t " }, row(), "2026-09-24T00:00:00Z"), code("invalid_request"));
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
    const encodedCapability = `%${grant.capability.charCodeAt(0).toString(16).padStart(2, "0")}${grant.capability.slice(1)}`;
    assert.throws(() => grants.validate(grant.capability, "session-1", { ...base, summary: `https://example.com/?id=${encodedCapability}` }, getJob), code("content_requires_redaction"));
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
    const anotherGrant = grants.issue(row({ job_id: "job_two" }), "session-1");
    assert.throws(() => grants.validate(renewed.capability, "session-1", { ...base, summary: anotherGrant.capability }, getJob), code("content_requires_redaction"));
    assert.throws(() => new JobResultPublishCapabilities(() => persistedSession, () => now).validate(grant.capability, "session-1", base, getJob), code("capability_invalid"));
    now = Date.parse(renewed.expiresAt);
    assert.throws(() => grants.validate(renewed.capability, "session-1", base, getJob), code("capability_expired"));
    now -= 1;
    grants.revokeJob("job_one");
    assert.throws(() => grants.validate(renewed.capability, "session-1", base, getJob), code("capability_revoked"));
  });

  test("検証後の再発行とrevokeはcommit直前のgrant照合で拒否する", () => {
    const grants = new JobResultPublishCapabilities(() => "session-one");
    const first = grants.issue(row(), "session-one");
    const current = row({ status: "running" });
    const candidate = grants.validate(first.capability, "session-one", base, () => current);
    candidate.assertCurrentGrant();
    assert.deepEqual(candidate.fence.publishableStatuses, ["dispatching", "running"]);
    const replacement = grants.issue(row(), "session-one");
    assert.equal(candidate.fence.grantGeneration, 1);
    assert.throws(() => candidate.assertCurrentGrant(), code("capability_revoked"));
    const next = grants.validate(replacement.capability, "session-one", base, () => current);
    assert.equal(next.fence.grantGeneration, 2);
    grants.revokeJob("job_one");
    assert.throws(() => next.assertCurrentGrant(), code("capability_revoked"));
  });

  test("期限切れgrantと終了jobの世代を次の発行前に解放する", () => {
    let now = Date.parse("2026-09-24T00:00:00Z");
    const grants = new JobResultPublishCapabilities(() => "session-one", () => now);
    for (let index = 0; index < 100; index++) grants.issue(row({ job_id: `job_${index}` }), "session-one");
    assert.equal((grants as unknown as { generations: Map<string, number> }).generations.size, 100);
    now += jobResultPublishTtlMs;
    grants.issue(row({ job_id: "new-job" }), "session-one");
    assert.equal((grants as unknown as { generations: Map<string, number> }).generations.size, 1);
  });

  test("永続live sessionの512文字上限を発行でも受理する", () => {
    const session = "s".repeat(512);
    const grants = new JobResultPublishCapabilities(() => session);
    const grant = grants.issue(row(), session);
    assert.equal(grants.authorize(grant.capability, session, () => row({ status: "running" })).job_id, "job_one");
    assert.throws(() => grants.issue(row(), `${session}s`), code("job_not_publishable"));
    const emojiSession = "😀".repeat(300);
    const emojiGrants = new JobResultPublishCapabilities(() => emojiSession);
    const emojiGrant = emojiGrants.issue(row(), emojiSession);
    assert.equal(emojiGrants.authorize(emojiGrant.capability, emojiSession, () => row({ status: "running" })).job_id, "job_one");
    const short = new JobResultPublishCapabilities(() => "s1");
    const shortGrant = short.issue(row(), "s1");
    assert.throws(() => short.validate(shortGrant.capability, "s1", { ...base, summary: "s1" }, () => row({ status: "running" })), code("content_requires_redaction"));
    assert.equal(short.validate(shortGrant.capability, "s1", { ...base, summary: "task s1 is complete" }, () => row({ status: "running" })).envelope.status, "completed");
    const composite = JSON.stringify(["workspace", "pane", "agent", "😀".repeat(512)]);
    const compositeGrants = new JobResultPublishCapabilities(() => composite);
    const compositeGrant = compositeGrants.issue(row(), composite);
    assert.equal(compositeGrants.authorize(compositeGrant.capability, composite, () => row({ status: "running" })).job_id, "job_one");
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

  test("他jobの期限内runtime identityと自jobのobjectiveを本文から除外する", () => {
    const otherSession = JSON.stringify(["workspace-two", "pane-two", "agent-two", "agent-session-two"]);
    const grants = new JobResultPublishCapabilities(id => id === "job_one" ? "session-one" : otherSession);
    const grant = grants.issue(row({ herdr_pane_id: "pane-one" }), "session-one");
    grants.issue(row({ job_id: "job_two", herdr_pane_id: "pane-two", agent_name: "agent-two", herdr_workspace_id: "herdr-two",
      objective: "private objective two", workspace_path: "/workspace/two", result_path: "/result/two" }), otherSession);
    const current = row({ status: "running", herdr_pane_id: "pane-one", objective: "private objective text" });
    for (const privateValue of ["pane-two", "agent-two", "herdr-two", "workspace-two", "agent-session-two",
      "private objective two", "private objective text"]) {
      assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, summary: privateValue }, () => current), code("content_requires_redaction"));
    }
  });

  test("短いobjectiveは全文一致時だけ拒否する", () => {
    const grants = new JobResultPublishCapabilities(() => "session-one");
    const grant = grants.issue(row({ objective: "test" }), "session-one");
    const current = row({ status: "running", objective: "test" });
    assert.equal(grants.validate(grant.capability, "session-one", { ...base, summary: "tests passed" }, () => current).envelope.status, "completed");
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, summary: "test" }, () => current), code("content_requires_redaction"));
  });

  test("多数grantの非公開値を大きい本文で一度だけ走査する", () => {
    const grants = new JobResultPublishCapabilities(id => id);
    let own = "";
    for (let index = 0; index < 300; index++) {
      const id = `job_${index}`;
      const issued = grants.issue(row({ job_id: id, objective: `private objective number ${index}` }), id);
      if (index === 0) own = issued.capability;
    }
    const started = performance.now();
    const candidate = grants.validate(own, "job_0", { ...base, summary: "public report completed ".repeat(5_000) },
      () => row({ status: "running", job_id: "job_0", objective: "private objective number 0" }));
    assert.equal(candidate.envelope.status, "completed");
    assert.ok(performance.now() - started < 2_000, "grant数に比例して本文を再走査しない");
  });

  test("terminal cleanup後は同じgrantでread-only照合できる", () => {
    let session: string | undefined = "session-1";
    const grants = new JobResultPublishCapabilities(() => session);
    const grant = grants.issue(row(), "session-1");
    session = undefined;
    const terminal = row({ status: "completed", herdr_pane_id: null, result_json: "{}" });
    const candidate = grants.validate(grant.capability, "session-1", base, () => terminal);
    assert.equal(candidate.reconcileOnly, true);
    assert.deepEqual(candidate.fence, { jobId: "job_one", publishableStatuses: ["dispatching", "running"], grantGeneration: 1,
      attemptCount: 1, paneId: "pane-1", session: "session-1" });
    assert.throws(() => grants.validate(grant.capability, "other-session", base, () => terminal), code("worker_session_stale"));
    assert.throws(() => grants.validate(grant.capability, "session-1", base, () => row({ status: "completed", herdr_pane_id: null, result_json: null })), code("worker_session_stale"));
  });

  test("専用接続だけで認可し、本文・capabilityを応答せずcommit材料へ渡す", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dona-result-contract-"));
    const socket = path.join(directory, "p.sock");
    let now = Date.now();
    const grants = new JobResultPublishCapabilities(() => "session-1", () => now);
    const grant = grants.issue(row(), "session-1");
    let current = row({ status: "running" });
    const accepted: string[] = [];
    const reconciled: string[] = [];
    const server = new JobResultPublishServer(grants, id => id === current.job_id ? current : undefined,
      { commit: async candidate => { assert.deepEqual(candidate.fence, { jobId: "job_one", publishableStatuses: ["dispatching", "running"], grantGeneration: 1,
        attemptCount: 1, paneId: "pane-1", session: "session-1" }); candidate.assertCurrentGrant(); accepted.push(candidate.canonicalDigest); return { outcome: "created" }; },
        reconcile: async candidate => { reconciled.push(candidate.canonicalDigest); return { outcome: "reused" }; } }, 32);
    const post = (body: string | Buffer, capability?: string, session = "session-1", route = "/v1/job-result-publish", agent?: http.Agent) => new Promise<{ status: number; body: string; connection: string | undefined }>((resolve, reject) => {
      const request = http.request({ socketPath: socket, path: route, method: "POST", agent,
        headers: { "content-type": "application/json", ...(capability ? { "x-dona-job-result-capability": capability } : {}), "x-dona-worker-session": Buffer.from(JSON.stringify(session), "utf8").toString("base64url") } }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8"), connection: response.headers.connection }));
      });
      request.on("error", reject); request.end(body);
    });
    let connections = 0;
    const reusableAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      await startServer(server, socket, () => { connections++; });
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
      assert.equal((await post('{"schema_version":1,"status":"completed","summary":"確認済み","actions":[{"count":1.0000000000000001}]}', grant.capability)).status, 400);
      assert.equal((await post("{", grant.capability)).status, 400);
      assert.equal((await post(Buffer.from([0xff]), grant.capability)).status, 400);
      assert.equal((await post(JSON.stringify(base), grant.capability, "old-session")).status, 403);
      assert.equal((await post(" ".repeat(jobResultEnvelopeMaxBytes + 1), grant.capability)).status, 413);
      assert.equal((await post("", grant.capability, "session-1", "/v1/job-result-publish/renew")).status, 425);
      now += 15 * 60_000;
      const beforeReuse = connections;
      const renewal = await post("", grant.capability, "session-1", "/v1/job-result-publish/renew", reusableAgent);
      assert.equal(renewal.status, 200);
      const retriedRenewal = await post("", grant.capability, "session-1", "/v1/job-result-publish/renew", reusableAgent);
      assert.equal(retriedRenewal.body, renewal.body);
      for (let index = 0; index < 129; index++) {
        assert.equal((await post("", grant.capability, "session-1", "/v1/job-result-publish/renew", reusableAgent)).status, 200);
      }
      assert.equal((await post(JSON.stringify(base), JSON.parse(renewal.body).capability, "session-1", "/v1/job-result-publish", reusableAgent)).status, 202);
      assert.equal(connections, beforeReuse + 1, "renewalとpublishは同じ接続済みFDを再利用する");
      assert.equal((await post(JSON.stringify(base), grant.capability)).status, 202);
      assert.equal((await post(JSON.stringify({ ...base, summary: grant.capability }), JSON.parse(renewal.body).capability)).status, 400);
      assert.equal(accepted.length, 3);
      current = row({ status: "completed", result_json: "{}" });
      const retry = await post(JSON.stringify(base), grant.capability);
      assert.equal(retry.status, 200);
      assert.equal(accepted.length, 3);
      assert.deepEqual(reconciled, [accepted[0]]);
    } finally {
      reusableAgent.destroy();
      await stopServer(server);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("Unicodeと制御文字を含む永続sessionを可逆に認証する", async () => {
    let session = "セッション\n\ud800";
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dona-result-session-"));
    const socket = path.join(directory, "p.sock");
    const grants = new JobResultPublishCapabilities(() => session);
    let grant = grants.issue(row(), session);
    const server = new JobResultPublishServer(grants, () => row({ status: "running" }),
      { commit: async candidate => {
        assert.equal(candidate.fence.session, session);
        return { outcome: "created" };
      }, reconcile: async () => ({ outcome: "reused" }) }, 32);
    const post = (encodedSession: string) => new Promise<number>((resolve, reject) => {
      const request = http.request({ socketPath: socket, path: "/v1/job-result-publish", method: "POST",
        headers: { "x-dona-job-result-capability": grant.capability, "x-dona-worker-session": encodedSession } }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode!));
      });
      request.on("error", reject); request.end(JSON.stringify(base));
    });
    try {
      await startServer(server, socket);
      assert.equal(await post(Buffer.from(JSON.stringify(session), "utf8").toString("base64url")), 202);
      session = "\ud800".repeat(512);
      grant = grants.issue(row(), session);
      const maximumSessionHeader = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
      assert.equal(maximumSessionHeader.length, 4099);
      assert.equal(await post(maximumSessionHeader), 202);
      session = JSON.stringify(["workspace".repeat(100), "pane".repeat(100), "agent".repeat(100), "😀".repeat(512)]);
      grant = grants.issue(row(), session);
      const compositeHeader = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
      assert.ok(compositeHeader.length > 4099);
      assert.equal(await post(compositeHeader), 202);
      assert.equal(await post(Buffer.from(JSON.stringify("別session"), "utf8").toString("base64url")), 403);
      assert.equal(await post("%%%"), 403);
    } finally {
      await stopServer(server);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("本文未完了の接続を期限切れと停止時に閉じる", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dona-result-stall-"));
    const socket = path.join(directory, "p.sock");
    const grants = new JobResultPublishCapabilities(() => "session-1");
    const grant = grants.issue(row(), "session-1");
    const server = new JobResultPublishServer(grants, () => row({ status: "running" }),
      { commit: async () => ({ outcome: "created" }), reconcile: async () => ({ outcome: "reused" }) }, 32, 40);
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
      await startServer(server, socket);
      const timed = await partial();
      await Promise.race([new Promise<void>(resolve => timed.once("close", () => resolve())), new Promise((_, reject) => setTimeout(() => reject(new Error("body deadline missed")), 1_000))]);
      const active = await partial();
      const started = performance.now();
      await stopServer(server);
      assert.ok(performance.now() - started < 1_000);
      active.destroy();
    } finally {
      await stopServer(server);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("初回request前の待機は接続済みFDを失効させず、header途中は期限を設ける", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dona-result-idle-fd-"));
    const socket = path.join(directory, "p.sock");
    const grants = new JobResultPublishCapabilities(() => "session-1");
    const grant = grants.issue(row(), "session-1");
    const server = new JobResultPublishServer(grants, () => row({ status: "running" }),
      { commit: async () => ({ outcome: "created" }), reconcile: async () => ({ outcome: "reused" }) }, 32, 40);
    let client: net.Socket | undefined;
    let stalled: net.Socket | undefined;
    let waiting: net.Socket | undefined;
    try {
      await startServer(server, socket, connection => { waiting = connection; });
      client = net.createConnection(socket);
      client.on("error", () => {});
      await new Promise<void>(resolve => client!.once("connect", resolve));
      await new Promise(resolve => setTimeout(resolve, 80));
      assert.equal(client.destroyed, false);
      const body = JSON.stringify(base);
      const response = new Promise<string>(resolve => client!.once("data", chunk => resolve(String(chunk))));
      client.write(`POST /v1/job-result-publish HTTP/1.1\r\nHost: worker\r\nContent-Length: ${Buffer.byteLength(body)}\r\nx-dona-job-result-capability: ${grant.capability}\r\nx-dona-worker-session: ${Buffer.from(JSON.stringify("session-1")).toString("base64url")}\r\n\r\n${body}`);
      assert.match(await response, /^HTTP\/1\.1 202 /);
      stalled = net.createConnection(socket);
      stalled.on("error", () => {});
      await new Promise<void>(resolve => stalled!.once("connect", resolve));
      stalled.write("POST /v1/job-result-publish HTTP/1.1\r\n");
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal((server as unknown as { headerDeadlines: Map<net.Socket, NodeJS.Timeout> }).headerDeadlines.size, 1);
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(stalled.destroyed, true, "header途中のsocketは期限で閉じる");
      const beforeData = net.createConnection(socket);
      beforeData.on("error", () => {});
      await new Promise<void>(resolve => beforeData.once("connect", resolve));
      assert.ok(waiting);
      waiting.emit("error", new Error("ECONNRESET"));
      await new Promise<void>(resolve => beforeData.once("close", resolve));
    } finally {
      client?.destroy();
      stalled?.destroy();
      await stopServer(server);
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
    const server = new JobResultPublishServer(grants, () => row({ status: "running" }),
      { commit: async () => { enteredCommit(); await commitBarrier; return { outcome: "created" }; },
        reconcile: async () => ({ outcome: "reused" }) }, 32);
    try {
      await startServer(server, socket);
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
      await stopServer(server);
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
    const server = new JobResultPublishServer(grants, () => row({ status: "running" }),
      { commit: async () => { entered(); await barrier; return { outcome: "created" }; },
        reconcile: async () => ({ outcome: "reused" }) }, 32);
    try {
      await startServer(server, socket);
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
      await stopServer(server);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("認証前の接続数を32件に制限する", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dona-result-cap-"));
    const socket = path.join(directory, "p.sock");
    const server = new JobResultPublishServer(new JobResultPublishCapabilities(() => undefined), () => undefined,
      { commit: async () => ({ outcome: "created" }), reconcile: async () => ({ outcome: "reused" }) }, 32);
    const clients: net.Socket[] = [];
    try {
      await startServer(server, socket);
      for (let index = 0; index < 33; index++) {
        const client = net.createConnection(socket);
        client.on("error", () => {});
        clients.push(client);
        await new Promise<void>(resolve => client.once("connect", () => resolve()));
      }
      await Promise.race([new Promise<void>(resolve => clients[32]!.once("close", () => resolve())),
        new Promise((_, reject) => setTimeout(() => reject(new Error("overflow connection remained open")), 1_000))]);
      assert.equal(clients[0]!.destroyed, false);
    } finally {
      for (const client of clients) client.destroy();
      await stopServer(server);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("接続容量を設定された並行job数へ拡張できる", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dona-result-cap64-"));
    const socket = path.join(directory, "p.sock");
    const server = new JobResultPublishServer(new JobResultPublishCapabilities(() => undefined), () => undefined,
      { commit: async () => ({ outcome: "created" }), reconcile: async () => ({ outcome: "reused" }) }, 64);
    const clients: net.Socket[] = [];
    try {
      await startServer(server, socket);
      for (let index = 0; index < 65; index++) {
        const client = net.createConnection(socket);
        client.on("error", () => {});
        clients.push(client);
        await new Promise<void>(resolve => client.once("connect", resolve));
      }
      assert.equal(clients[63]!.destroyed, false);
      await Promise.race([new Promise<void>(resolve => clients[64]!.once("close", resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("configured limit not enforced")), 1_000))]);
    } finally {
      for (const client of clients) client.destroy();
      await stopServer(server);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("切断済みでもcommit中の接続は32件の上限を占有する", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dona-result-orphan-cap-"));
    const socket = path.join(directory, "p.sock");
    const grants = new JobResultPublishCapabilities(() => "session-1");
    const grant = grants.issue(row(), "session-1");
    let started = 0;
    const entrances: Array<() => void> = [];
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const server = new JobResultPublishServer(grants, () => row({ status: "running" }),
      { commit: async () => { started++; entrances.shift()?.(); await barrier; return { outcome: "created" }; },
        reconcile: async () => ({ outcome: "reused" }) }, 32);
    try {
      await startServer(server, socket);
      for (let index = 0; index < 32; index++) {
        const entered = new Promise<void>(resolve => { entrances.push(resolve); });
        const request = http.request({ socketPath: socket, path: "/v1/job-result-publish", method: "POST",
          headers: { "x-dona-job-result-capability": grant.capability,
            "x-dona-worker-session": Buffer.from(JSON.stringify("session-1")).toString("base64url") } });
        request.on("error", () => {});
        request.end(JSON.stringify(base));
        await entered;
        request.destroy();
        await new Promise<void>(resolve => request.once("close", resolve));
      }
      assert.equal(started, 32);
      const overflow = net.createConnection(socket);
      overflow.on("error", () => {});
      await Promise.race([new Promise<void>(resolve => overflow.once("close", resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("orphan publish did not consume admission slot")), 1_000))]);
      assert.equal(started, 32);
    } finally {
      release();
      await stopServer(server);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("単一接続からpipelined publishを複数実行しない", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dona-result-pipeline-"));
    const socket = path.join(directory, "p.sock");
    const grants = new JobResultPublishCapabilities(() => "session-1");
    const grant = grants.issue(row(), "session-1");
    let calls = 0;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const server = new JobResultPublishServer(grants, () => row({ status: "running" }),
      { commit: async () => { calls++; entered(); await barrier; return { outcome: "created" }; },
        reconcile: async () => ({ outcome: "reused" }) }, 32);
    let client: net.Socket | undefined;
    try {
      await startServer(server, socket);
      client = net.createConnection(socket);
      client.on("error", () => {});
      client.on("data", () => {});
      await new Promise<void>(resolve => client!.once("connect", () => resolve()));
      const body = JSON.stringify(base);
      const request = `POST /v1/job-result-publish HTTP/1.1\r\nHost: worker\r\nContent-Length: ${Buffer.byteLength(body)}\r\nx-dona-job-result-capability: ${grant.capability}\r\nx-dona-worker-session: ${Buffer.from(JSON.stringify("session-1")).toString("base64url")}\r\n\r\n${body}`;
      client.write(request.repeat(40));
      await started;
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(calls, 1);
      release();
      await stopServer(server);
      assert.equal(calls, 1);
    } finally {
      release();
      client?.destroy();
      await stopServer(server);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
