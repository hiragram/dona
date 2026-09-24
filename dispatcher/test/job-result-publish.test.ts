import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

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
    for (const canary of ["secret=CANARY_VALUE", "https://files.slack.com/private/abc", "/Users/example/private.txt", "ghp_abcdefghijklmnop"]) {
      try {
        validateJobResultPublish({ ...base, artifacts: [{ nested: { value: canary } }] }, row(), "2026-09-24T00:00:00Z");
        assert.fail("must reject");
      } catch (error) {
        assert.ok(code("content_requires_redaction")(error));
        assert.equal(JSON.stringify(error).includes(canary), false);
        assert.equal(String(error).includes(canary), false);
      }
    }
  });

  test("canonical digestはkey順とDispatcher時刻によらず同一で、内容の差を識別する", () => {
    const first = validateJobResultPublish(base, row(), "2026-09-24T00:00:00Z");
    const reordered = validateJobResultPublish({ actions: [], artifacts: [{ kind: "report" }], summary: "確認済み", status: "completed", schema_version: 1 }, row(), "2026-09-24T01:00:00Z");
    assert.equal(first.canonicalDigest, reordered.canonicalDigest);
    assert.notEqual(first.canonicalDigest, validateJobResultPublish({ ...base, summary: "別内容" }, row(), "2026-09-24T00:00:00Z").canonicalDigest);
    assert.notEqual(first.canonicalDigest, validateJobResultPublish(base, row({ job_id: "job_two" }), "2026-09-24T00:00:00Z").canonicalDigest);
  });

  test("単一job、失効、revocation、stale worker、restart時fail closed", () => {
    let now = Date.parse("2026-09-24T00:00:00Z");
    let persistedSession = "session-1";
    const grants = new JobResultPublishCapabilities(() => persistedSession, () => now);
    const original = row();
    const grant = grants.issue(original, "session-1");
    const instructions = buildJobResultPublishInstructions(grant.capability, grant.expiresAt);
    assert.ok(instructions.includes(grant.capability));
    assert.ok(instructions.includes("job_id、path、completed_at、ownerは送らず"));
    let current = row({ status: "running" });
    const getJob = (id: string) => id === current.job_id ? current : undefined;
    assert.equal(grants.validate(grant.capability, "session-1", base, getJob).envelope.job_id, "job_one");
    assert.throws(() => grants.validate(grant.capability, "session-1", base, () => row({ job_id: "job_two" })), code("capability_invalid"));
    assert.throws(() => grants.validate(grant.capability, "session-2", base, getJob), code("worker_session_stale"));
    persistedSession = "session-2";
    assert.throws(() => grants.validate(grant.capability, "session-1", base, getJob), code("worker_session_stale"));
    persistedSession = "session-1";
    current = row({ status: "running", attempt_count: 2 });
    assert.throws(() => grants.validate(grant.capability, "session-1", base, getJob), code("worker_session_stale"));
    current = row({ status: "running" });
    const renewed = grants.renew(grant.capability, "session-1", getJob);
    assert.notEqual(renewed.capability, grant.capability);
    assert.throws(() => grants.validate(grant.capability, "session-1", base, getJob), code("capability_revoked"));
    assert.throws(() => new JobResultPublishCapabilities(() => persistedSession, () => now).validate(grant.capability, "session-1", base, getJob), code("capability_invalid"));
    now = Date.parse(renewed.expiresAt);
    assert.throws(() => grants.validate(renewed.capability, "session-1", base, getJob), code("capability_expired"));
    now -= 1;
    grants.revokeJob("job_one");
    assert.throws(() => grants.validate(renewed.capability, "session-1", base, getJob), code("capability_revoked"));
  });

  test("専用UDSだけで認可し、本文・capabilityを応答せずcommit材料へ渡す", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dona-result-contract-"));
    const socket = path.join(directory, "p.sock");
    const grants = new JobResultPublishCapabilities(() => "session-1");
    const grant = grants.issue(row(), "session-1");
    const current = row({ status: "running" });
    const accepted: string[] = [];
    const server = new JobResultPublishServer(socket, grants, id => id === current.job_id ? current : undefined,
      async candidate => { accepted.push(candidate.canonicalDigest); return { outcome: "created" }; });
    const post = (body: string | Buffer, capability?: string, session = "session-1", route = "/v1/job-result-publish") => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request({ socketPath: socket, path: route, method: "POST",
        headers: { "content-type": "application/json", ...(capability ? { "x-dona-job-result-capability": capability } : {}), "x-dona-worker-session": session } }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
      });
      request.on("error", reject); request.end(body);
    });
    try {
      await server.start();
      const unauthorized = await post(JSON.stringify(base));
      assert.equal(unauthorized.status, 403);
      const acceptedResult = await post(JSON.stringify(base), grant.capability);
      assert.equal(acceptedResult.status, 202);
      assert.equal(accepted.length, 1);
      assert.equal(acceptedResult.body.includes(grant.capability), false);
      const secret = await post(JSON.stringify({ ...base, summary: "secret=CANARY_VALUE" }), grant.capability);
      assert.equal(secret.status, 400);
      assert.equal(secret.body.includes("CANARY_VALUE"), false);
      assert.equal((await post("{", grant.capability)).status, 400);
      assert.equal((await post(Buffer.from([0xff]), grant.capability)).status, 400);
      assert.equal((await post(JSON.stringify(base), grant.capability, "old-session")).status, 403);
      assert.equal((await post(" ".repeat(jobResultEnvelopeMaxBytes + 1), grant.capability)).status, 413);
      const renewal = await post("", grant.capability, "session-1", "/v1/job-result-publish/renew");
      assert.equal(renewal.status, 200);
      assert.equal((await post(JSON.stringify(base), grant.capability)).status, 403);
      assert.equal((await post(JSON.stringify(base), JSON.parse(renewal.body).capability)).status, 202);
      assert.equal(accepted.length, 2);
    } finally {
      await server.stop();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
