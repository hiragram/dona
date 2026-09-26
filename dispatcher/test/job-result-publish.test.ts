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
    for (const canary of ["secret=CANARY_VALUE", "auth=CANARY_VALUE", "session_id=CANARY_VALUE", "session-id=CANARY_VALUE", "AccountKey=CANARY_VALUE", "sig=CANARY_VALUE", "signature=CANARY_VALUE", "Bearer abcdefghijklmnop", "-----BEGIN ENCRYPTED PRIVATE KEY-----", "-----BEGIN PGP PRIVATE KEY BLOCK-----", "https://files.slack.com/private/abc", "https://files.slack.com./private/abc", "https://blob.example.test/file?sv=1&sig=CANARY_VALUE", "https://blob.example.test/file?sv=1&%73ig=CANARY_VALUE", "http://localhost:3000/download/OPAQUE_VALUE", "http://localhost.:3000/download/OPAQUE_VALUE", "http://127.0.0.1:8080/private", "http://127.1/private", "http://[::1]/private", "http://10.0.0.5/download/OPAQUE_VALUE", "http://172.16.0.1/private", "http://192.168.1.1/private", "http://169.254.169.254/private", "http://[fc00::1]/private", "http://[fe80::1]/private", "http://[::ffff:10.0.0.5]/private", "https://CANARY_VALUE@private.example/repo", "https://user:@private.example/repo", "postgresql://admin:CANARY_VALUE@db.internal/app", "redis://:CANARY_VALUE@cache.internal/0", "amqps://user:CANARY_VALUE@mq.internal/vhost", "10.0.0.5/download/OPAQUE_VALUE", "artifact.internal/results/private.json", "/Users/example/private.txt", "/root/.dona/workspaces/job", "/workspace/dona/job", "`/workspace/dona/job`", "path=/root/.dona/job", "GET /home/worker/.ssh/id_rsa returned 200", "POST /workspace/dona/private", "C:/Users/example/.ssh/id_rsa", "D:/private/result.json", "\\\\fileserver\\share\\private\\result.json", "//fileserver/share/private/result.json", "<!channel>", "<!here>", "<!everyone>", "<!subteam^S12345678>", "<@U12345678>", "ghp_abcdefghijklmnop", "glpat-abcdefghijklmnopqrst", "sk_live_abcdefghijklmnopqrst", "AKIA1234567890ABCDEF", "ghp_\u001b[31mabcdefghijklmnop\u001b[0m", "ghp_abcd\u200befghijklmnop"]) {
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
      "{ kty: 'RSA', n: 'public', d: 'PRIVATE_VALUE' }",
      "{ kty: 'RSA', meta: {}, d: 'PRIVATE_VALUE' }",
      "{ note: '}', kty: 'RSA', d: 'PRIVATE_VALUE' }",
      '{"d":"PRIVATE_VALUE","kty":"RSA","n":"public"}',
      '{"kty":"R\\u0053A","n":"public","d":"PRIVATE_VALUE"}',
      '{"kty":"RSA","n":"public","d":"PRIVATE_VALUE"']) {
      assert.throws(() => validateJobResultPublish({ ...base, summary: value }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"), value);
    }
    for (const value of [{ session: "CANARY_VALUE" }, { kty: "RSA", n: "public", e: "AQAB", d: "PRIVATE_VALUE" },
      { kty: "oct", k: "PRIVATE_VALUE" }]) {
      assert.throws(() => validateJobResultPublish({ ...base, artifacts: [value] }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    }
    for (const value of ["http://artifact-service.internal/download/OPAQUE_VALUE", "http://artifact/download/OPAQUE_VALUE",
      "http://cache.local/private", "ftp://10.0.0.5/private/archive.zip", "sftp://artifact.internal/result",
      "https://example.com/file?access%5Ftoken=CANARY_VALUE", "https://example.com/file?client%5Fsecret=CANARY_VALUE",
      "prefix_https://10.0.0.1/private", "prefix_https://user:CANARY_VALUE@cdn.example.com/file", "https://example.com/callback#access%5Ftoken=CANARY_VALUE",
      "pypi-AgEIcHlwaS5vcmcCAAAAAAAAAAAAAAAAAAAA", "dckr_pat_AAAAAAAAAAAAAAAAAAAAAAAA", "ghp_AAAA*BBBB*CCCCCCCCCCCCCCCCCCCCCCCCCCCC", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGVzdHNpZ25hdHVyZQ",
      "eyJhbGciOiJIUzI1NiJ9.e30.dGVzdHNpZ25hdHVyZQ", "jwt_eyJhbGciOiJIUzI1NiJ9.e30.dGVzdHNpZ25hdHVyZQ", "jwt_eyAiYWxnIjoiSFMyNTYifQ.e30.dGVzdHNpZ25hdHVyZQ", "xoxc-abcdefghijkl", "xoxd-abcdefghijkl", "xoxe-abcdefghijkl", "ASIA1234567890ABCDEF", `AIza${"A".repeat(35)}`,
      "https://example.com/?id=eyJhbGciOiJIUzI1NiJ9%2Ee30%2EdGVzdHNpZ25hdHVyZQ",
      "curl --token CANARY_VALUE", "tool --client-secret CANARY_VALUE", "tool --sig CANARY_VALUE", "sv=2024-11-04&sig=CANARY_VALUE",
      "//user:CANARY_VALUE@cdn.example.com/private", "//cdn.example.com/file?sig=CANARY_VALUE",
      "//user:CANARY_VALUE@cdn.example.com", "//cdn.example.com?sig=CANARY_VALUE",
      "10.0.0.5:8080/download/OPAQUE_VALUE", "artifact.internal:8443/results/private.json", "localhost:8080/download/OPAQUE_VALUE", "service:3000/private/result", "[::1]:8080/download/OPAQUE_VALUE", "[fd00::1]:8443/private/result", "127.1/private/result", "2130706433/download/file", "0x7f000001/private/result", "017700000001/download/file", "0x7f.1/private/result", "0177.0.0.1/download/file", "artifact.internal./private/result",
      "GET /run/secrets/db-password returned 200", "GET /proc/self/environ returned 200", "POST /dev/null", "GET /sys/kernel", "保存先は/home/worker/private.txt", "結果を/workspace/dona/privateへ保存", "report,[/root/.dona/result.json]", "report,/home/worker/private.txt",
      "path:/root/.dona/result.json", "保存先:/home/worker/private.txt", "保存先は/mnt/private/result.json", "結果は/srv/dona/secretへ保存", "結果🔒/mnt/private/result.json", "сохранено/srv/dona/secret", "http://198.18.0.1/download/result", "http://192.88.99.1/download/result", "http://[fec0::1]/download/result", "http://[2001:db8::1]/download/result", "http://[64:ff9b:1::a00:1]/download/result", "repo/.ssh/id_rsa", "config/.aws/credentials", "build/secrets/token.json", `npm_${"A".repeat(36)}`, `hf_${"A".repeat(30)}`, `ya29.${"A".repeat(30)}`, "http://[100::1]/download/result", "http://[2001:2::1]/download/result", "localhost/download/result", "foo.localhost/download/result", "user:hunter2@example.com/download", "kty: RSA\nn: PUBLIC_VALUE\ne: AQAB\nd: PRIVATE_VALUE", "kty: RSA # signing key\nn: PUBLIC_VALUE\ne: AQAB\nd: PRIVATE_VALUE", "http://[::ffff:0:127.0.0.1]/download/result", "machine api.example.com login alice password hunter2", "d: PRIVATE_VALUE\nn: PUBLIC_VALUE\ne: AQAB\nkty: RSA", "http://api.test/download/result", "http://api.invalid/download/result", "http://api.example/download/result", "curl -u alice:hunter2 https://example.com", "curl --user alice:hunter2 https://example.com", "GET /download?%74oken=CANARY_VALUE returned 200", "db.example.com:5432:app:alice:hunter2", "http://[2001:20::1]/download/result", "http://[2001:10::1]/download/result", "alice:hunter2@10.0.0.5/download", "http://[::127.0.0.1]/download/result", "http://[::0.0.0.2]/download/result", "http://192.0.0.8/download/result", "curl --proxy-user alice:hunter2 https://github.com", "curl --proxy-user=alice:hunter2 https://github.com", "https://download.corp.com/result", "db.example.com:5432:app:alice:hunter\\:2", "default login alice password hunter2", "PuTTY-User-Key-File-3: ssh-rsa\nPrivate-Lines: 1\nQUJDRA==", "Basic YWxpY2U6aHVudGVyMg=="]) {
      assert.throws(() => validateJobResultPublish({ ...base, summary: value }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    }
    assert.throws(() => validateJobResultPublish({ ...base, artifacts: [{ "client-key-data": "BASE64_PRIVATE_KEY" }] }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    assert.throws(() => validateJobResultPublish({ ...base, artifacts: [{ "tls.key": "BASE64_PRIVATE_KEY" }] }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    assert.throws(() => validateJobResultPublish({ ...base, artifacts: [{ "to\u200bken": "CANARY_VALUE" }] }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    assert.throws(() => validateJobResultPublish({ ...base, artifacts: [{ "to\u034fken": "CANARY_VALUE" }] }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    assert.throws(() => validateJobResultPublish({ ...base, artifacts: [{ "to\u001b[31mken": "CANARY_VALUE" }] }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    assert.throws(() => validateJobResultPublish({ ...base, artifacts: [{ "to\\u200bken": "CANARY_VALUE" }] }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    assert.throws(() => validateJobResultPublish({ ...base, artifacts: [{ "to\\bken": "CANARY_VALUE" }] }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    assert.throws(() => validateJobResultPublish({ ...base, artifacts: [{ kty: "R\\u0053A", d: "PRIVATE_VALUE" }] }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    for (const artifact of [
      { kty: "RSA", "k\\u0074y": "public", d: "PRIVATE_VALUE" },
      { "%5C%75%30%30%37%34oken": "CANARY_VALUE" },
    ]) assert.throws(() => validateJobResultPublish({ ...base, artifacts: [artifact] }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    for (const summary of ["http://[ff02::1]/download/result", "Loaded .ssh/id_rsa", "Read .aws/credentials", "Read secrets/credential.json"]) {
      assert.throws(() => validateJobResultPublish({ ...base, summary }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    }
    assert.throws(() => validateJobResultPublish({ ...base, summary: "\u001b[31m" }, row(), "2026-09-24T00:00:00Z"), code("invalid_request"));
    assert.throws(() => validateJobResultPublish({ ...base, summary: "<https://example.com/| >" }, row(), "2026-09-24T00:00:00Z"), code("invalid_request"));
    assert.throws(() => validateJobResultPublish({ ...base, summary: "ghp_abcd\u034fefghijklmnop" }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    for (const summary of ["machine api.example.com password hunter2 login alice", "curl --pass hunter2 --key client.key https://github.com", "curl --cert client.pem:hunter2 https://github.com", "curl --oauth2-bearer opaque https://github.com", "LOCALHOST/download/result", "LocalHost/private", "..\\Users\\alice\\AppData\\Local\\Dona\\result.json"]) {
      assert.throws(() => validateJobResultPublish({ ...base, summary }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    }
    for (const summary of ["Basic authentication is enabled", "HTTP Basic authentication succeeded", "<details>結果</details>", "<testsuite>ok</testsuite>"]) {
      assert.doesNotThrow(() => validateJobResultPublish({ ...base, summary }, row(), "2026-09-24T00:00:00Z"), summary);
    }
    for (const value of ["//github.com/hiragram/dona", "//[2606:4700:4700::1111]/dns-query", '{"kty":"RSA","n":"public"} {"d":"done"}', "成功/失敗の内訳", "実装/テスト完了", "GET /health returned 200", "POST /v1/job-result-publish", "Updated dispatcher/src/job.ts", "See docs/guide", "build/test passed", "Bearer authentication is enabled", "Bearer credentials were removed", 'payload={\\"status\\":\\"ok\\"}']) {
      assert.doesNotThrow(() => validateJobResultPublish({ ...base, summary: value }, row(), "2026-09-24T00:00:00Z"), value);
    }
    assert.equal(validateJobResultPublish({ ...base, summary: "coverage 95% complete" }, row(), "2026-09-24T00:00:00Z").envelope.status, "completed");
    assert.equal(validateJobResultPublish({ ...base, artifacts: [{ session_count: 3 }], actions: [{ token_count: 100 }] }, row(), "2026-09-24T00:00:00Z").envelope.status, "completed");
    assert.equal(validateJobResultPublish({ ...base, summary: "token_count: 123 session_count=3" }, row(), "2026-09-24T00:00:00Z").envelope.status, "completed");
    assert.throws(() => validateJobResultPublish({ ...base, artifacts: [{ session_count: "CANARY_VALUE" }] }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    for (const assignment of ["AWS_SECRET_ACCESS_KEY=CANARY_VALUE", "PGPASSWORD=CANARY_VALUE", "GITHUB_TOKEN=CANARY_VALUE", '{"client_secret":"CANARY_VALUE"}', '{"client-secret":"CANARY_VALUE"}', '{"set-cookie":"sessionid=CANARY_VALUE"}', '"password" = "CANARY_VALUE"']) {
      assert.throws(() => validateJobResultPublish({ ...base, output: { format: "text", text: assignment } }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    }
    assert.throws(() => validateJobResultPublish({ ...base, summary: `x://:${"a:".repeat(5000)}` }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    const repeatedUrls = "http://github.com?foo=".repeat(10_000);
    const started = performance.now();
    assert.equal(validateJobResultPublish({ ...base, summary: repeatedUrls }, row(), "2026-09-24T00:00:00Z").envelope.status, "completed");
    assert.ok(performance.now() - started < 2_000, "署名URL検査は大きな本文でも線形時間で終わる");
    const plusUrls = "https://github.com/?q=a+b ".repeat(500);
    const plusStarted = performance.now();
    assert.equal(validateJobResultPublish({ ...base, summary: plusUrls }, row(), "2026-09-24T00:00:00Z").envelope.status, "completed");
    assert.ok(performance.now() - plusStarted < 2_000, "plusを含む複数URLもboundedに検査する");
    const publicJwks = '{"kty":"RSA","n":"public"}'.repeat(8_000);
    const jwkStarted = performance.now();
    assert.equal(validateJobResultPublish({ ...base, summary: publicJwks }, row(), "2026-09-24T00:00:00Z").envelope.status, "completed");
    assert.ok(performance.now() - jwkStarted < 2_000, "JWK本文検査は反復しても線形時間で終わる");
    assert.throws(() => validateJobResultPublish({ ...base, summary: "{".repeat(100_000) }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    const oscStarted = performance.now();
    assert.throws(() => validateJobResultPublish({ ...base, summary: "\u001b]".repeat(20_000) }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    assert.ok(performance.now() - oscStarted < 2_000, "未終端OSCをboundedに拒否する");
    const jwtLike = `${"eyJ_".repeat(200)}.e30.dGVzdHNpZ25hdHVyZQ`;
    const jwtStarted = performance.now();
    assert.equal(validateJobResultPublish({ ...base, summary: jwtLike.repeat(300) }, row(), "2026-09-24T00:00:00Z").envelope.status, "completed");
    assert.ok(performance.now() - jwtStarted < 2_000, "JWT候補の走査は大きい本文でもboundedに終わる");
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
    assert.throws(() => validateJobResultPublish({ ...base, summary: "\u200b\u0001" }, row(), "2026-09-24T00:00:00Z"), code("invalid_request"));
    for (const privateUrl of ["files.slack.com/files-pri/T1/F1/download", "hooks.slack.com/services/T/B/SECRET"]) {
      assert.throws(() => validateJobResultPublish({ ...base, summary: privateUrl }, row(), "2026-09-24T00:00:00Z"), code("content_requires_redaction"));
    }
  });

  test("単一job、失効、revocation、stale worker、restart時fail closed", () => {
    let now = Date.parse("2026-09-24T00:00:00Z");
    let monotonic = 0;
    let persistedSession = "session-1";
    const grants = new JobResultPublishCapabilities(() => persistedSession, () => now, () => monotonic);
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
    assert.equal(grants.validate(grant.capability, "session-1", { ...base, summary: "coverage 95% complete" }, getJob).envelope.status, "completed");
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
    monotonic += 15 * 60_000;
    const renewed = grants.renew(grant.capability, "session-1", getJob);
    assert.notEqual(renewed.capability, grant.capability);
    assert.throws(() => grants.renew(renewed.capability, "session-1", getJob), code("renewal_not_due"));
    assert.equal(grants.renew(grant.capability, "session-1", getJob).capability, renewed.capability);
    assert.equal(grants.validate(grant.capability, "session-1", base, getJob).envelope.job_id, "job_one");
    assert.throws(() => grants.validate(renewed.capability, "session-1", { ...base, summary: grant.capability }, getJob), code("content_requires_redaction"));
    const anotherGrant = grants.issue(row({ job_id: "job_two" }), "session-1");
    assert.throws(() => grants.validate(renewed.capability, "session-1", { ...base, summary: anotherGrant.capability }, getJob), code("content_requires_redaction"));
    assert.throws(() => new JobResultPublishCapabilities(() => persistedSession, () => now).validate(grant.capability, "session-1", base, getJob), code("capability_invalid"));
    now = Date.parse(grant.expiresAt);
    assert.equal(grants.renew(grant.capability, "session-1", getJob).capability, renewed.capability);
    now = Date.parse(renewed.expiresAt);
    monotonic += jobResultPublishTtlMs;
    assert.throws(() => grants.validate(renewed.capability, "session-1", base, getJob), code("capability_expired"));
    now -= 1;
    assert.throws(() => grants.validate(renewed.capability, "session-1", base, getJob), code("capability_expired"), "時計が巻き戻っても失効は不可逆");
    grants.revokeJob("job_one");
    assert.throws(() => grants.validate(renewed.capability, "session-1", base, getJob), code("capability_invalid"));
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

  test("wall clockの巻き戻しでも更新とcommit期限は単調時計で判定する", () => {
    let wall = Date.parse("2026-09-24T00:00:00Z");
    let monotonic = 0;
    const grants = new JobResultPublishCapabilities(() => "session-one", () => wall, () => monotonic);
    const grant = grants.issue(row(), "session-one");
    const current = row({ status: "running" });
    const candidate = grants.validate(grant.capability, "session-one", base, () => current);
    wall -= 60 * 60_000;
    monotonic += jobResultPublishTtlMs / 2;
    assert.ok(grants.renew(grant.capability, "session-one", () => current).capability);
    monotonic += jobResultPublishTtlMs / 2;
    assert.throws(() => candidate.assertCurrentGrant(), code("capability_expired"));
  });

  test("pruneしたgrantのcandidateは時計が戻っても復活しない", () => {
    let wall = Date.parse("2026-09-24T00:00:00Z");
    let monotonic = 0;
    const grants = new JobResultPublishCapabilities(() => "session-one", () => wall, () => monotonic);
    const first = grants.issue(row(), "session-one");
    const candidate = grants.validate(first.capability, "session-one", base, () => row({ status: "running" }));
    wall += jobResultPublishTtlMs;
    grants.issue(row(), "session-one");
    wall -= jobResultPublishTtlMs;
    assert.throws(() => candidate.assertCurrentGrant(), code("capability_expired"));
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
    assert.throws(() => short.validate(shortGrant.capability, "s1", { ...base, summary: "task s1 is complete" }, () => row({ status: "running" })), code("content_requires_redaction"));
    assert.throws(() => short.validate(shortGrant.capability, "s1", { ...base, summary: "czE=" }, () => row({ status: "running" })), code("content_requires_redaction"));
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
    grants.issue(row({ job_id: "job_short", objective: "完了", workspace_path: "/workspace/short", result_path: "/result/short" }), otherSession);
    const current = row({ status: "running", herdr_pane_id: "pane-one", objective: "private objective text" });
    assert.equal(grants.validate(grant.capability, "session-one", { ...base, summary: "実装完了" }, () => current).envelope.summary, "実装完了");
    for (const privateValue of ["pane-two", "agent-two", "herdr-two", "workspace-two", "agent-session-two",
      "private objective two", "private objective text"]) {
      assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, summary: privateValue }, () => current), code("content_requires_redaction"));
    }
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, output: { format: "markdown", text: "private *objective* text" } },
      () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, output: { format: "markdown", text: "private _objective_ text" } },
      () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base,
      summary: grant.capability.slice(0, 20), output: { format: "markdown", text: grant.capability.slice(20) } },
      () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base,
      artifacts: [{ part: grant.capability.slice(0, 20) }, { part: grant.capability.slice(20) }] },
      () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base,
      artifacts: [{ part: "private objective " }, { part: "text" }] },
      () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base,
      summary: Buffer.from(grant.capability, "utf8").toString("base64url") }, () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base,
      summary: Buffer.from("private objective text", "utf8").toString("base64") }, () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base,
      summary: "AAAAAAAA ".repeat(1_025) }, () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base,
      summary: Buffer.from('{"password":"hunter2"}', "utf8").toString("base64") }, () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base,
      summary: Buffer.from(grant.capability, "utf8").toString("hex") }, () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base,
      summary: Buffer.from("private objective text", "utf8").toString("hex") }, () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base,
      artifacts: Array.from({ length: 600 }, () => ({ part: "AAAAAAAA" })),
      actions: Array.from({ length: 600 }, () => ({ part: "AAAAAAAA" })) },
      () => current), code("content_requires_redaction"));
    const doubleEncoded = Buffer.from(Buffer.from(grant.capability, "utf8").toString("base64url"), "utf8").toString("base64url");
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base,
      summary: doubleEncoded }, () => current), code("content_requires_redaction"));
    const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let base32Bits = 0, base32Value = 0, base32Capability = "";
    for (const byte of Buffer.from(grant.capability, "utf8")) {
      base32Value = (base32Value << 8) | byte;
      base32Bits += 8;
      while (base32Bits >= 5) {
        base32Bits -= 5;
        base32Capability += base32Alphabet[(base32Value >>> base32Bits) & 31];
        base32Value &= (1 << base32Bits) - 1;
      }
    }
    if (base32Bits) base32Capability += base32Alphabet[(base32Value << (5 - base32Bits)) & 31];
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base,
      summary: base32Capability }, () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base,
      summary: base32Capability.toLowerCase() }, () => current), code("content_requires_redaction"));
    const privateBase32 = Buffer.from("private objective text", "utf8");
    let privateBits = 0, privateValue = 0, encodedPrivate = "";
    for (const byte of privateBase32) {
      privateValue = (privateValue << 8) | byte;
      privateBits += 8;
      while (privateBits >= 5) {
        privateBits -= 5;
        encodedPrivate += base32Alphabet[(privateValue >>> privateBits) & 31];
        privateValue &= (1 << privateBits) - 1;
      }
    }
    if (privateBits) encodedPrivate += base32Alphabet[(privateValue << (5 - privateBits)) & 31];
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base,
      summary: encodedPrivate }, () => current), code("content_requires_redaction"));
    const longObjective = "private-long-objective-".repeat(500);
    const longGrant = new JobResultPublishCapabilities(() => "session-long-base64");
    const longIssued = longGrant.issue(row({ objective: longObjective }), "session-long-base64");
    assert.throws(() => longGrant.validate(longIssued.capability, "session-long-base64", { ...base,
      summary: Buffer.from(longObjective, "utf8").toString("base64") },
      () => row({ status: "running", objective: longObjective })), code("content_requires_redaction"));
    const decoratedCapability = `${grant.capability.slice(0, 20)}*${grant.capability.slice(20)}`;
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, output: { format: "markdown", text: grant.capability } },
      () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, output: { format: "markdown", text: decoratedCapability } },
      () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, output: { format: "markdown", text: "private <https://example.com/|objective> text" } },
      () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, output: { format: "markdown", text: "private <mailto:a@example.com|objective> text" } },
      () => current), code("content_requires_redaction"));
    const linkedCapability = `${grant.capability.slice(0, 20)}<https://example.com/|${grant.capability.slice(20, 30)}>${grant.capability.slice(30)}`;
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, output: { format: "markdown", text: linkedCapability } },
      () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, output: { format: "markdown", text: `${grant.capability.slice(0, 20)}<!date^0^${grant.capability.slice(20)}|x>` } },
      () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, summary: "https://example.com/?detail=private+objective+two" }, () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, summary: "https://example.com/?private+objective+two" }, () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, summary: "example.com/status?detail=private+objective+two" }, () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, summary: "example.com?detail=private+objective+two" }, () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, summary: "参照example.com?detail=private+objective+two" }, () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, summary: "example.xn--p1ai?detail=private+objective+two" }, () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, summary: "//cdn.example.com/?detail=private+objective+two" }, () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, summary: "//cdn.example.com/?private+objective+text=x" }, () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, summary: "GET /status?detail=private+objective+two" }, () => current), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, summary: 'payload={"detail":"private\\u0020objective\\u0020two"}' }, () => current), code("content_requires_redaction"));
    const multiline = new JobResultPublishCapabilities(() => "session-multiline");
    const multilineGrant = multiline.issue(row({ objective: "internal\nplan" }), "session-multiline");
    assert.throws(() => multiline.validate(multilineGrant.capability, "session-multiline", { ...base, summary: 'payload={"detail":"internal\\nplan"}' },
      () => row({ status: "running", objective: "internal\nplan" })), code("content_requires_redaction"));
    const invisible = new JobResultPublishCapabilities(() => "session-invisible");
    const invisibleGrant = invisible.issue(row({ objective: "secret\u200bplan" }), "session-invisible");
    assert.throws(() => invisible.validate(invisibleGrant.capability, "session-invisible", { ...base, summary: "secretplan" },
      () => row({ status: "running", objective: "secret\u200bplan" })), code("content_requires_redaction"));
    const shortInvisible = new JobResultPublishCapabilities(() => "session-short-invisible");
    const shortInvisibleGrant = shortInvisible.issue(row({ objective: "秘\u034f密" }), "session-short-invisible");
    assert.throws(() => shortInvisible.validate(shortInvisibleGrant.capability, "session-short-invisible", { ...base, summary: "対応完了: 秘密" },
      () => row({ status: "running", objective: "秘\u034f密" })), code("content_requires_redaction"));
    const split = new JobResultPublishCapabilities(() => "session-split");
    const splitGrant = split.issue(row({ objective: "private\n\nobjective" }), "session-split");
    assert.throws(() => split.validate(splitGrant.capability, "session-split", { ...base, summary: "private", output: { format: "markdown", text: "objective" } },
      () => row({ status: "running", objective: "private\n\nobjective" })), code("content_requires_redaction"));
    const numeric = new JobResultPublishCapabilities(() => "session-numeric");
    const numericGrant = numeric.issue(row({ objective: "1234" }), "session-numeric");
    assert.throws(() => numeric.validate(numericGrant.capability, "session-numeric", { ...base, artifacts: [{ id: 1234 }] },
      () => row({ status: "running", objective: "1234" })), code("content_requires_redaction"));
    const entity = new JobResultPublishCapabilities(() => "session-entity");
    const entityGrant = entity.issue(row({ objective: "private & objective" }), "session-entity");
    assert.throws(() => entity.validate(entityGrant.capability, "session-entity", { ...base, output: { format: "markdown", text: "private &amp; objective" } },
      () => row({ status: "running", objective: "private & objective" })), code("content_requires_redaction"));
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, summary: "private%252520objective%252520text" }, () => current), code("content_requires_redaction"));
    const japanese = new JobResultPublishCapabilities(() => "session-ja");
    const jaGrant = japanese.issue(row({ objective: "秘密 計画" }), "session-ja");
    assert.throws(() => japanese.validate(jaGrant.capability, "session-ja", { ...base, summary: "https://example.com/?detail=%E7%A7%98%E5%AF%86+%E8%A8%88%E7%94%BB" },
      () => row({ status: "running", objective: "秘密 計画" })), code("content_requires_redaction"));
    const accented = new JobResultPublishCapabilities(() => "session-accent");
    const accentGrant = accented.issue(row({ objective: "café" }), "session-accent");
    assert.throws(() => accented.validate(accentGrant.capability, "session-accent", { ...base, summary: "cafe\u0301" },
      () => row({ status: "running", objective: "café" })), code("content_requires_redaction"));
    const shortAccent = new JobResultPublishCapabilities(() => "session-short");
    const shortAccentGrant = shortAccent.issue(row({ agent_name: "aaaaaaa\u0301" }), "session-short");
    assert.throws(() => shortAccent.validate(shortAccentGrant.capability, "session-short", { ...base, summary: "task aaaaaaá done" },
      () => row({ status: "running", agent_name: "aaaaaaa\u0301" })), code("content_requires_redaction"));
  });

  test("短いobjectiveも文章中で拒否する", () => {
    const grants = new JobResultPublishCapabilities(() => "session-one");
    const grant = grants.issue(row({ objective: "秘密" }), "session-one");
    const current = row({ status: "running", objective: "秘密" });
    assert.equal(grants.validate(grant.capability, "session-one", { ...base, summary: "対応完了" }, () => current).envelope.status, "completed");
    assert.throws(() => grants.validate(grant.capability, "session-one", { ...base, summary: "対応完了: 秘密" }, () => current), code("content_requires_redaction"));
  });

  test("固定schema keyは他jobのprivate valueに左右されない", () => {
    const grants = new JobResultPublishCapabilities(id => id);
    grants.issue(row({ job_id: "job_two", objective: "summary" }), "job_two");
    const own = grants.issue(row({ job_id: "job_one" }), "job_one");
    const current = row({ status: "running" });
    assert.equal(grants.validate(own.capability, "job_one", base, () => current).envelope.status, "completed");
    assert.throws(() => grants.validate(own.capability, "job_one", { ...base, artifacts: [{ summary: "public" }] }, () => current), code("content_requires_redaction"));
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

  test("長いprivate objectiveが多数あってもpublishの検査を完了する", () => {
    const grants = new JobResultPublishCapabilities(id => id);
    let own = "";
    for (let index = 0; index < 100; index++) {
      const id = `job_large_${index}`;
      const issued = grants.issue(row({ job_id: id, objective: `private-${index}-` + "x".repeat(50_000) }), id);
      if (index === 0) own = issued.capability;
    }
    const current = row({ status: "running", job_id: "job_large_0", objective: "private-0-" + "x".repeat(50_000) });
    assert.equal(grants.validate(own, "job_large_0", base, () => current).envelope.status, "completed");
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
    let monotonic = 0;
    const grants = new JobResultPublishCapabilities(() => "session-1", () => now, () => monotonic);
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
    const recoveryAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      await startServer(server, socket, () => { connections++; });
      const unauthorized = await post(JSON.stringify(base));
      assert.equal(unauthorized.status, 403);
      assert.equal(unauthorized.connection, "close");
      const acceptedResult = await post(JSON.stringify(base), grant.capability);
      assert.equal(acceptedResult.status, 202);
      assert.equal(accepted.length, 1);
      assert.equal(acceptedResult.body.includes(grant.capability), false);
      const beforeCorrection = connections;
      const secret = await post(JSON.stringify({ ...base, summary: "secret=CANARY_VALUE" }), grant.capability, "session-1", "/v1/job-result-publish", recoveryAgent);
      assert.equal(secret.status, 400);
      assert.notEqual(secret.connection, "close");
      assert.equal(secret.body.includes("CANARY_VALUE"), false);
      assert.equal((await post(JSON.stringify(base), grant.capability, "session-1", "/v1/job-result-publish", recoveryAgent)).status, 202);
      assert.equal(connections, beforeCorrection + 1, "修正したResultを同じ専用接続で公開する");
      recoveryAgent.destroy();
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
      const beforeReuse = connections;
      const earlyRenewal = await post("", grant.capability, "session-1", "/v1/job-result-publish/renew", reusableAgent);
      assert.equal(earlyRenewal.status, 425);
      assert.notEqual(earlyRenewal.connection, "close");
      now += 15 * 60_000;
      monotonic += 15 * 60_000;
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
      assert.equal(accepted.length, 4);
      current = row({ status: "completed", result_json: "{}" });
      const retry = await post(JSON.stringify(base), grant.capability);
      assert.equal(retry.status, 200);
      assert.equal(accepted.length, 4);
      assert.deepEqual(reconciled, [accepted[0]]);
    } finally {
      reusableAgent.destroy();
      recoveryAgent.destroy();
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

  test("chunkedのwire framingが1 MiBを超えても本文上限内なら受理する", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dona-result-many-chunks-"));
    const socket = path.join(directory, "p.sock");
    const grants = new JobResultPublishCapabilities(() => "session-1");
    const grant = grants.issue(row(), "session-1");
    const server = new JobResultPublishServer(grants, () => row({ status: "running" }),
      { commit: async () => ({ outcome: "created" }), reconcile: async () => ({ outcome: "reused" }) }, 32);
    let client: net.Socket | undefined;
    try {
      await startServer(server, socket);
      client = net.createConnection(socket);
      client.on("error", () => {});
      await new Promise<void>(resolve => client!.once("connect", resolve));
      const body = JSON.stringify({ ...base, summary: "x".repeat(80_000) });
      const encoded = Buffer.from(body);
      const chunks = Array.from(encoded, byte => {
        return Buffer.concat([Buffer.from("0000000000000001\r\n"), Buffer.from([byte]), Buffer.from("\r\n")]);
      });
      assert.ok(chunks.reduce((size, chunk) => size + chunk.length, 0) > jobResultEnvelopeMaxBytes);
      const response = new Promise<string>(resolve => client!.once("data", data => resolve(String(data))));
      client.write(Buffer.concat([Buffer.from(`POST /v1/job-result-publish HTTP/1.1\r\nHost: worker\r\nTransfer-Encoding: chunked\r\nx-dona-job-result-capability: ${grant.capability}\r\nx-dona-worker-session: ${Buffer.from(JSON.stringify("session-1")).toString("base64url")}\r\n\r\n`), ...chunks, Buffer.from("0\r\n\r\n")]));
      let responseDeadline: NodeJS.Timeout | undefined;
      try {
        assert.match(await Promise.race([response, new Promise<string>((_, reject) => {
          responseDeadline = setTimeout(() => reject(new Error("chunked response timeout")), 12_000);
        })]), /^HTTP\/1\.1 202 /);
      } finally { if (responseDeadline) clearTimeout(responseDeadline); }
    } finally {
      client?.destroy();
      await stopServer(server);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("初回request前の待機は接続済みFDを失効させず、header途中は期限を設ける", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dona-result-idle-fd-"));
    const socket = path.join(directory, "p.sock");
    const grants = new JobResultPublishCapabilities(() => "session-1");
    const grant = grants.issue(row(), "session-1");
    let blockCommit = false;
    let releaseCommit: (() => void) | undefined;
    const server = new JobResultPublishServer(grants, () => row({ status: "running" }),
      { commit: async () => {
        if (blockCommit) await new Promise<void>(resolve => { releaseCommit = resolve; });
        return { outcome: "created" };
      }, reconcile: async () => ({ outcome: "reused" }) }, 32, 40);
    let client: net.Socket | undefined;
    let combined: net.Socket | undefined;
    let chunked: net.Socket | undefined;
    let split: net.Socket | undefined;
    let splitBody: net.Socket | undefined;
    let overlapping: net.Socket | undefined;
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
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(client.destroyed, false, "完了requestのdataで次header期限を起動しない");
      client.write("POST /v1/job-result-publish HTTP/1.1\r\n");
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal((server as unknown as { headerDeadlines: Map<net.Socket, NodeJS.Timeout> }).headerDeadlines.size, 1);
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(client.destroyed, true, "keep-alive上の次のpartial headerも期限で閉じる");
      combined = net.createConnection(socket);
      combined.on("error", () => {});
      await new Promise<void>(resolve => combined!.once("connect", resolve));
      const combinedResponse = new Promise<string>(resolve => combined!.once("data", chunk => resolve(String(chunk))));
      combined.write(`POST /v1/job-result-publish HTTP/1.1\r\nHost: worker\r\nContent-Length: ${Buffer.byteLength(body)}\r\nx-dona-job-result-capability: ${grant.capability}\r\nx-dona-worker-session: ${Buffer.from(JSON.stringify("session-1")).toString("base64url")}\r\n\r\n${body}POST /v1/job-result-publish HTTP/1.1\r\n`);
      assert.match(await combinedResponse, /^HTTP\/1\.1 202 /);
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal((server as unknown as { headerDeadlines: Map<net.Socket, NodeJS.Timeout> }).headerDeadlines.size, 1);
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(combined.destroyed, true, "同じchunk内の後続partial headerも期限で閉じる");
      chunked = net.createConnection(socket);
      chunked.on("error", () => {});
      await new Promise<void>(resolve => chunked!.once("connect", resolve));
      const chunkedResponse = new Promise<string>(resolve => chunked!.once("data", data => resolve(String(data))));
      chunked.write(`POST /v1/job-result-publish HTTP/1.1\r\nHost: worker\r\nTransfer-Encoding: chunked\r\nx-dona-job-result-capability: ${grant.capability}\r\nx-dona-worker-session: ${Buffer.from(JSON.stringify("session-1")).toString("base64url")}\r\n\r\n${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`);
      assert.match(await chunkedResponse, /^HTTP\/1\.1 202 /);
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(chunked.destroyed, false, "chunked本文を後続headerと誤認しない");
      split = net.createConnection(socket);
      split.on("error", () => {});
      await new Promise<void>(resolve => split!.once("connect", resolve));
      const splitResponse = new Promise<string>(resolve => split!.once("data", data => resolve(String(data))));
      split.write("POST /v1/job-result-publish HTTP/1.1\r\nHost: worker\r\n");
      await new Promise(resolve => setTimeout(resolve, 10));
      split.write(`Content-Length: ${Buffer.byteLength(body)}\r\nx-dona-job-result-capability: ${grant.capability}\r\nx-dona-worker-session: ${Buffer.from(JSON.stringify("session-1")).toString("base64url")}\r\n\r\n${body}POST /v1/job-result-publish HTTP/1.1\r\n`);
      assert.match(await splitResponse, /^HTTP\/1\.1 202 /);
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(split.destroyed, true, "分割request直後のpartial headerも期限で閉じる");
      splitBody = net.createConnection(socket);
      splitBody.on("error", () => {});
      await new Promise<void>(resolve => splitBody!.once("connect", resolve));
      const splitBodyResponse = new Promise<string>(resolve => splitBody!.once("data", data => resolve(String(data))));
      const splitAt = Math.floor(body.length / 2);
      splitBody.write(`POST /v1/job-result-publish HTTP/1.1\r\nHost: worker\r\nContent-Length: ${Buffer.byteLength(body)}\r\nx-dona-job-result-capability: ${grant.capability}\r\nx-dona-worker-session: ${Buffer.from(JSON.stringify("session-1")).toString("base64url")}\r\n\r\n${body.slice(0, splitAt)}`);
      await new Promise(resolve => setTimeout(resolve, 10));
      splitBody.write(`${body.slice(splitAt)}POST /v1/job-result-publish HTTP/1.1\r\n`);
      assert.match(await splitBodyResponse, /^HTTP\/1\.1 202 /);
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal((server as unknown as { headerDeadlines: Map<net.Socket, NodeJS.Timeout> }).headerDeadlines.size, 1);
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(splitBody.destroyed, true, "分割本文の直後のpartial headerも期限で閉じる");
      blockCommit = true;
      overlapping = net.createConnection(socket);
      overlapping.on("error", () => {});
      await new Promise<void>(resolve => overlapping!.once("connect", resolve));
      overlapping.write(`POST /v1/job-result-publish HTTP/1.1\r\nHost: worker\r\nContent-Length: ${Buffer.byteLength(body)}\r\nx-dona-job-result-capability: ${grant.capability}\r\nx-dona-worker-session: ${Buffer.from(JSON.stringify("session-1")).toString("base64url")}\r\n\r\n${body}`);
      for (let i = 0; i < 20 && !releaseCommit; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.ok(releaseCommit, "commit待機に入る");
      overlapping.write("POST /v1/job-result-publish HTTP/1.1\r\n");
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(overlapping.destroyed, true, "commit中に届いた次headerも期限で閉じる");
      releaseCommit?.();
      blockCommit = false;
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
      combined?.destroy();
      chunked?.destroy();
      split?.destroy();
      splitBody?.destroy();
      releaseCommit?.();
      overlapping?.destroy();
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
