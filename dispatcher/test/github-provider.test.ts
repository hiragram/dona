import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import { afterEach, describe, test } from "node:test";
import { tempConfig } from "./helpers.js";
import type { Logger } from "../src/logger.js";
import { DispatcherDatabase } from "../src/database.js";
import { DispatcherApi } from "../src/api.js";
import { ExternalIngressRegistry } from "../src/ingress.js";
import { GitHubReadOnlyInstallationClient, githubPilotRegistration, verifyGitHubSignature } from "../src/providers/github.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const jobs = { isRunning: () => true, wake() {}, async steer() { throw new Error("unused"); }, async cancel() { throw new Error("unused"); } };
const delivery = "01234567-89ab-4def-8123-0123456789ab";
const secretText = "a-secure-webhook-secret-with-32-bytes";
const payload = Buffer.from(JSON.stringify({ action: "opened", installation: { id: 77 }, repository: { id: 42, full_name: "hiragram/dona" }, issue: { updated_at: "2026-09-07T00:00:00Z" } }));
const signature = (body = payload) => `sha256=${createHmac("sha256", secretText).update(body).digest("hex")}`;

function registration() {
  return githubPilotRegistration({ connectionId: "github-pilot", account: "installation:77", connectionRevision: 1, credentialRevision: 1,
    repositoryId: 42, repositoryFullName: "hiragram/dona", events: { issues: ["opened"] },
    resolveWebhookSecret: async () => Buffer.from(secretText) });
}

describe("GitHub provider pilot", () => {
  test("raw bytesのHMAC-SHA256だけをconstant-time比較する", () => {
    assert.doesNotThrow(() => verifyGitHubSignature(payload, signature(), Buffer.from(secretText)));
    assert.throws(() => verifyGitHubSignature(Buffer.concat([payload, Buffer.from(" ")]), signature(), Buffer.from(secretText)));
    for (const malformed of ["", "sha1=abc", "sha256=xyz", `sha256=${"a".repeat(62)}`]) {
      assert.throws(() => verifyGitHubSignature(payload, malformed, Buffer.from(secretText)));
    }
  });

  test("header、event/action、repository allowlistをstrictに検証する", async () => {
    const base = { body: payload, method: "POST" as const, requestTarget: "/", receivedAt: "2026-09-07T00:00:00Z" };
    const good = [["X-GitHub-Delivery", delivery], ["X-GitHub-Event", "issues"], ["X-Hub-Signature-256", signature()]] as const;
    const verified = await registration().authenticate({ ...base, headers: good });
    const normalized = registration().normalize({ ...base, headers: good }, verified);
    assert.deepEqual((normalized as { payload: unknown }).payload, { action: "opened" });
    await assert.rejects(registration().authenticate({ ...base, headers: [...good, ["x-github-event", "issues"]] }));
    await assert.rejects(registration().authenticate({ ...base, headers: good.map(([name, value]) => [name, name === "X-GitHub-Event" ? "push" : value]) }));
    const wrong = Buffer.from(JSON.stringify({ action: "opened", installation: { id: 77 }, repository: { id: 43, full_name: "other/repo" }, issue: { updated_at: "2026-09-07T00:00:00Z" } }));
    const wrongHeaders = good.map(([name, value]) => [name, name === "X-Hub-Signature-256" ? signature(wrong) : value] as const);
    const wrongVerified = await registration().authenticate({ ...base, body: wrong, headers: wrongHeaders });
    assert.throws(() => registration().normalize({ ...base, body: wrong, headers: wrongHeaders }, wrongVerified));
  });

  test("実HTTPで署名検証後のcommitだけを202でACKしduplicate/conflictを分離する", async () => {
    const { root, config } = await tempConfig(); roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    database.connections.register({ id: "github-pilot", provider: "github", account: "installation:77",
      allowlist: [{ resource: "42", events: ["issues.opened"] }], credentialRef: "cred_github_pilot", credentialRevision: 1,
      capability: { kind: "manual", cursor: false } });
    database.connections.attachManual("github-pilot", 1, "42", "hook:1", null);
    database.connections.observe("github-pilot", 1, "42", 1, { providerId: "hook:1", expiresAt: null, verified: true, cutoverConfirmed: false });
    const api = new DispatcherApi(database, { isRunning: () => true, wake() {} }, jobs, config, logger, undefined, undefined, undefined,
      new ExternalIngressRegistry([registration()]));
    await api.start();
    const send = (body: Buffer, deliveryId = delivery) => new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const request = http.request({ socketPath: config.socketPath, path: "/v1/ingress/github", method: "POST",
        headers: { "x-github-delivery": deliveryId, "x-github-event": "issues", "x-hub-signature-256": signature(Buffer.from(body)), "content-length": body.length } }, response => {
        const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      }); request.on("error", reject); request.end(body);
    });
    try {
      assert.equal((await send(payload)).status, 202);
      const duplicates = await Promise.all(Array.from({ length: 8 }, () => send(payload)));
      assert.deepEqual(duplicates.map(result => result.status), Array(8).fill(202));
      const changed = Buffer.from(payload.toString().replace('"id":77', '"id":78'));
      assert.equal((await send(changed)).status, 409);
      assert.equal(database.list().length, 1);
      assert.equal(database.list()[0]?.source, "github");
    } finally { await api.stop(); database.close(); }
  });

  test("installation clientはallowlisted repositoryへのGETだけを行いwrite/redeliveryを持たない", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = new GitHubReadOnlyInstallationClient("hiragram/dona", { token: async () => "test-token" }, async (input, init) => {
      calls.push({ url: String(input), ...(init === undefined ? {} : { init }) }); return new Response(JSON.stringify({ id: 52 }), { status: 200 });
    });
    assert.deepEqual(await client.get("/issues/52"), { id: 52 });
    assert.equal(calls[0]?.init?.method, "GET");
    await assert.rejects(client.get("/../other/repo"));
  });
});
