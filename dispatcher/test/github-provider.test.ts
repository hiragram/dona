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
import { serviceExternalIngressRegistry } from "../src/service.js";
import { loadConfig } from "../src/config.js";
import { readPrivateBuffer } from "../src/private-token.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const jobs = { isRunning: () => true, wake() {}, async steer() { throw new Error("unused"); }, async cancel() { throw new Error("unused"); } };
const delivery = "01234567-89ab-4def-8123-0123456789ab";
const secretText = "a-secure-webhook-secret-with-32-bytes";
const payload = Buffer.from(JSON.stringify({ action: "opened", installation: { id: 77 }, repository: { id: 42, full_name: "hiragram/dona" }, issue: { id: 5200, number: 52, updated_at: "2026-09-07T00:00:00Z" } }));
const signature = (body = payload) => `sha256=${createHmac("sha256", secretText).update(body).digest("hex")}`;

function registration() {
  return githubPilotRegistration({ connectionId: "github-pilot", installationId: 77,
    repositoryId: 42, repositoryFullName: "hiragram/dona", events: { issues: ["opened"] },
    resolveBinding: async () => ({ account: "installation:77", revision: 1, credentialRevision: 1, generation: 1 }),
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

  test("resolverのsecret Bufferを使用後に消去する", async () => {
    const secret = Buffer.from(secretText);
    const registered = githubPilotRegistration({ connectionId: "github-pilot", installationId: 77, repositoryId: 42,
      repositoryFullName: "hiragram/dona", events: { issues: ["opened"] },
      resolveBinding: async () => ({ account: "installation:77", revision: 1, credentialRevision: 1, generation: 2 }),
      resolveWebhookSecret: async () => secret });
    await registered.authenticate({ body: payload, method: "POST", requestTarget: "/", receivedAt: "2026-09-07T00:00:00Z",
      headers: [["X-GitHub-Delivery", delivery], ["X-GitHub-Event", "issues"], ["X-Hub-Signature-256", signature()]] });
    assert.ok(secret.every(byte => byte === 0));
  });

  test("header、event/action、repository allowlistをstrictに検証する", async () => {
    const base = { body: payload, method: "POST" as const, requestTarget: "/", receivedAt: "2026-09-07T00:00:00Z" };
    const good = [["X-GitHub-Delivery", delivery], ["X-GitHub-Event", "issues"], ["X-Hub-Signature-256", signature()]] as const;
    const verified = await registration().authenticate({ ...base, headers: good });
    const normalized = registration().normalize({ ...base, headers: good }, verified);
    assert.deepEqual((normalized as { payload: unknown }).payload, { action: "opened", issue_number: 52 });
    assert.equal((normalized as { subject: { issue_id: number } }).subject.issue_id, 5200);
    await assert.rejects(registration().authenticate({ ...base, headers: [...good, ["x-github-event", "issues"]] }));
    await assert.rejects(registration().authenticate({ ...base, headers: good.map(([name, value]) => [name, name === "X-GitHub-Event" ? "push" : value]) }));
    const wrong = Buffer.from(JSON.stringify({ action: "opened", installation: { id: 77 }, repository: { id: 43, full_name: "other/repo" }, issue: { id: 5200, number: 52, updated_at: "2026-09-07T00:00:00Z" } }));
    const wrongHeaders = good.map(([name, value]) => [name, name === "X-Hub-Signature-256" ? signature(wrong) : value] as const);
    const wrongVerified = await registration().authenticate({ ...base, body: wrong, headers: wrongHeaders });
    assert.throws(() => registration().normalize({ ...base, body: wrong, headers: wrongHeaders }, wrongVerified));
    const realistic = Buffer.from(JSON.stringify({ action: "opened", installation: { id: 77, node_id: "I_1" },
      repository: { id: 42, full_name: "hiragram/dona", private: true }, issue: { updated_at: "2026-09-07T00:00:00Z", id: 5200, number: 52, title: "fixture" } }));
    const realisticHeaders = good.map(([name, value]) => [name, name === "X-Hub-Signature-256" ? signature(realistic) : value] as const);
    const realisticVerified = await registration().authenticate({ ...base, body: realistic, headers: realisticHeaders });
    assert.doesNotThrow(() => registration().normalize({ ...base, body: realistic, headers: realisticHeaders }, realisticVerified));
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
    const send = (body: Buffer, deliveryId = delivery, validSignature = true) => new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const request = http.request({ socketPath: config.socketPath, path: "/v1/ingress/github", method: "POST",
        headers: { "x-github-delivery": deliveryId, "x-github-event": "issues", "x-hub-signature-256": validSignature ? signature(Buffer.from(body)) : `sha256=${"0".repeat(64)}`, "content-length": body.length } }, response => {
        const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      }); request.on("error", reject); request.end(body);
    });
    try {
      for (let index = 0; index < 101; index += 1) assert.equal((await send(payload, delivery, false)).status, 401);
      assert.equal((await send(payload)).status, 202);
      const duplicates = await Promise.all(Array.from({ length: 8 }, () => send(payload)));
      assert.deepEqual(duplicates.map(result => result.status), Array(8).fill(202));
      const changed = Buffer.from(payload.toString().replace("2026-09-07T00:00:00Z", "2026-09-07T00:00:01Z"));
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
    await assert.rejects(client.get("/%2e%2e/%2e%2e/installation/repositories"));
    assert.throws(() => new GitHubReadOnlyInstallationClient("../installation", { token: async () => "test-token" }));
    assert.throws(() => githubPilotRegistration({ connectionId: "github-pilot", installationId: 77, repositoryId: 42,
      repositoryFullName: "hiragram/dona", events: { pull_request: ["opened"] },
      resolveBinding: async () => ({ account: "installation:77", revision: 1, credentialRevision: 1, generation: 1 }),
      resolveWebhookSecret: async () => Buffer.from(secretText) }));
    let cancelled = false;
    const failing = new GitHubReadOnlyInstallationClient("hiragram/dona", { token: async () => "test-token" }, async () =>
      new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 429 }));
    await assert.rejects(failing.get("/issues/52"), /429/);
    assert.equal(cancelled, true);
  });

  test("無効な起動configとsymlink secretを起動前に拒否する", async () => {
    for (const candidate of [
      { connectionId: "", installationId: 77, repositoryId: 42, repositoryFullName: "hiragram/dona", events: { issues: ["opened"] }, webhookSecretPath: "/tmp/secret" },
      { connectionId: "github-pilot", installationId: 77, repositoryId: 42, repositoryFullName: "abc", events: { issues: ["opened"] }, webhookSecretPath: "/tmp/secret" },
    ]) assert.throws(() => loadConfig({ DONA_GITHUB_PILOT_CONFIG: JSON.stringify({ ...candidate,
      trustedProxy: { githubMetaIpAllowlist: true, perSourceRateAndConcurrencyLimit: true } }) }));
    const otherwiseValid = { connectionId: "github-pilot", installationId: 77, repositoryId: 42, repositoryFullName: "hiragram/dona",
      events: { issues: ["opened"] }, webhookSecretPath: "/tmp/secret" };
    assert.throws(() => loadConfig({ DONA_GITHUB_PILOT_CONFIG: JSON.stringify(otherwiseValid) }), /invalid/);
    assert.throws(() => loadConfig({ DONA_GITHUB_PILOT_CONFIG: JSON.stringify({ ...otherwiseValid,
      trustedProxy: { githubMetaIpAllowlist: true, perSourceRateAndConcurrencyLimit: false } }) }), /invalid/);
    const { root } = await tempConfig(); roots.push(root);
    const target = `${root}/target`; const link = `${root}/link`;
    await fs.writeFile(target, secretText, { mode: 0o600 }); await fs.symlink(target, link);
    assert.equal(await readPrivateBuffer(link), undefined);
  });

  test("serve起動用registryへconfigとcurrent subscription generationを接続する", async () => {
    const { root, config } = await tempConfig(); roots.push(root);
    const secretPath = `${root}/github-webhook-secret`;
    await fs.writeFile(secretPath, secretText, { mode: 0o600 });
    config.githubPilot = { connectionId: "github-pilot", installationId: 77, repositoryId: 42,
      repositoryFullName: "hiragram/dona", events: { issues: ["opened"] }, webhookSecretPath: secretPath,
      trustedProxy: { githubMetaIpAllowlist: true, perSourceRateAndConcurrencyLimit: true } };
    const database = new DispatcherDatabase(config.databasePath);
    database.connections.register({ id: "github-pilot", provider: "github", account: "installation:77",
      allowlist: [{ resource: "42", events: ["issues.opened"] }], credentialRef: "cred_github_pilot", credentialRevision: 1,
      capability: { kind: "manual", cursor: false } });
    database.connections.attachManual("github-pilot", 1, "42", "hook:2", null);
    database.connections.observe("github-pilot", 1, "42", 1, { providerId: "hook:2", expiresAt: null, verified: true, cutoverConfirmed: false });
    database.connections.revise("github-pilot", 1, { id: "github-pilot", provider: "github", account: "installation:77",
      allowlist: [{ resource: "42", events: ["issues.opened"] }], credentialRef: "cred_github_pilot", credentialRevision: 2,
      capability: { kind: "manual", cursor: false } });
    database.connections.attachManual("github-pilot", 2, "42", "hook:3", null);
    database.connections.observe("github-pilot", 2, "42", 2, { providerId: "hook:3", expiresAt: null, verified: true, cutoverConfirmed: true });
    const registered = serviceExternalIngressRegistry(config, database).get("github")?.registration;
    assert.ok(registered);
    const verified = await registered.authenticate({ body: payload, method: "POST", requestTarget: "/", receivedAt: "2026-09-07T00:00:00Z",
      headers: [["X-GitHub-Delivery", delivery], ["X-GitHub-Event", "issues"], ["X-Hub-Signature-256", signature()]] });
    assert.equal(verified.connection?.generation, 2);
    database.close();
  });

  test("connection accountが設定したinstallationと異なる場合は起動bindingを拒否する", async () => {
    const { root, config } = await tempConfig(); roots.push(root);
    const secretPath = `${root}/github-webhook-secret`; await fs.writeFile(secretPath, secretText, { mode: 0o600 });
    config.githubPilot = { connectionId: "github-pilot", installationId: 77, repositoryId: 42,
      repositoryFullName: "hiragram/dona", events: { issues: ["opened"] }, webhookSecretPath: secretPath,
      trustedProxy: { githubMetaIpAllowlist: true, perSourceRateAndConcurrencyLimit: true } };
    const database = new DispatcherDatabase(config.databasePath);
    database.connections.register({ id: "github-pilot", provider: "github", account: "installation:88",
      allowlist: [{ resource: "42", events: ["issues.opened"] }], credentialRef: "cred_github_pilot", credentialRevision: 1,
      capability: { kind: "manual", cursor: false } });
    database.connections.attachManual("github-pilot", 1, "42", "hook:1", null);
    database.connections.observe("github-pilot", 1, "42", 1, { providerId: "hook:1", expiresAt: null, verified: true, cutoverConfirmed: false });
    const registered = serviceExternalIngressRegistry(config, database).get("github")!.registration;
    await assert.rejects(registered.authenticate({ body: payload, method: "POST", requestTarget: "/", receivedAt: "2026-09-07T00:00:00Z",
      headers: [["X-GitHub-Delivery", delivery], ["X-GitHub-Event", "issues"], ["X-Hub-Signature-256", signature()]] }));
    database.close();
  });
});
