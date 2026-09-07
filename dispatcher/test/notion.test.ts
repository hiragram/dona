import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import { createNotionRegistration, fetchLatestNotionState, normalizeNotionFetchValue } from "../src/notion.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DispatcherDatabase } from "../src/database.js";
import { serviceExternalIngressRegistry } from "../src/service.js";
import { loadConfig } from "../src/config.js";

const receivedAt = "2026-09-07T00:00:00.000Z";
const verificationAttempt = "attempt_01M1WK_NOTION";
const body = Buffer.from(JSON.stringify({ id: "evt_1", timestamp: receivedAt, workspace_id: "ws_1",
  subscription_id: "sub_1", integration_id: "int_1", type: "page.content_updated",
  entity: { id: "page_1", type: "page" }, attempt_number: 8 }));
function request(payload: Buffer, signature?: string) { return { body: payload,
  headers: signature ? [["x-notion-signature", signature] as const] : [], method: "POST" as const,
  requestTarget: payload.includes(Buffer.from("verification_token"))
    ? `/v1/ingress/notion?verification_attempt=${verificationAttempt}` : "/v1/ingress/notion", receivedAt }; }
function setup() {
  let secret: Buffer | undefined;
  let pending = true;
  const registration = createNotionRegistration({ connectionId: "notion_test", verificationSecretRef: "cred_notion_verify",
    secrets: { async get() { return secret && Buffer.from(secret); } },
    verification: { async claim(input) {
      if (input.attemptId !== verificationAttempt) return undefined;
      if (!pending && !secret?.equals(input.token)) return undefined;
      pending = false; secret ??= Buffer.from(input.token);
      return { binding: { connectionId: "notion_test", account: "ws_1", revision: 1, credentialRevision: 1,
        resource: "page_1", generation: 1 }, providerEventId: "verification:attempt_1", occurredAt: receivedAt };
    } },
    bindings: { async resolve(input) { return input.resourceId === "page_1" && input.eventType === "page.content_updated"
      ? { connectionId: "notion_test", account: "ws_1", revision: 1, credentialRevision: 1,
        resource: "page_1", generation: 1 } : undefined; } } });
  return { registration, secret: () => secret };
}

describe("Notion ingress", () => {
  test("serve registryはdurable attemptとsecretをrestart後も再利用してactive bindingを解決する", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dona-notion-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const secrets = path.join(root, "secrets"); fs.mkdirSync(secrets, { mode: 0o700 });
    const config = loadConfig({ DONA_DATABASE_PATH: path.join(root, "dispatcher.sqlite"),
      DONA_NOTION_PILOT_CONFIG: JSON.stringify({ connectionId: "notion_test", integrationId: "int_1",
        verificationCredentialRef: "cred_notion_verify", secretStoreRoot: secrets }) });
    let database = new DispatcherDatabase(config.databasePath);
    database.connections.register({ id: "notion_test", provider: "notion", account: "ws_1",
      allowlist: [{ resource: "page_1", events: ["page.content_updated"] }], credentialRef: "cred_integration",
      credentialRevision: 1, capability: { kind: "manual", cursor: false } });
    database.connections.attachManual("notion_test", 1, "page_1", "sub_1", null);
    database.connections.observe("notion_test", 1, "page_1", 1,
      { providerId: "sub_1", expiresAt: null, verified: false, cutoverConfirmed: false });
    const attempt = database.providerRegistration.issue({ provider: "notion", providerId: "sub_1",
      connectionId: "notion_test", account: "ws_1", resource: "page_1" }, 60_000);
    const verification = Buffer.from(JSON.stringify({ verification_token: "secret-verification-token" }));
    const registration = serviceExternalIngressRegistry(config, database).get("notion")!.registration;
    const verified = await registration.authenticate({ body: verification, headers: [], method: "POST", receivedAt,
      requestTarget: `/v1/ingress/notion?verification_attempt=${attempt}` });
    verified.verificationCommit?.();
    assert.equal(database.connections.get("notion_test").state, "active");
    database.close();

    database = new DispatcherDatabase(config.databasePath);
    t.after(() => database.close());
    const restarted = serviceExternalIngressRegistry(config, database).get("notion")!.registration;
    const replay = await restarted.authenticate({ body: verification, headers: [], method: "POST", receivedAt,
      requestTarget: `/v1/ingress/notion?verification_attempt=${attempt}` });
    assert.equal(replay.connection?.resource, "page_1");
    const signature = createHmac("sha256", "secret-verification-token").update(body).digest("hex");
    const event = await restarted.authenticate(request(body, signature));
    assert.equal(event.connection?.generation, 1);
    const unknownBody = Buffer.from(JSON.stringify({ ...JSON.parse(body.toString()), subscription_id: "sub_unknown" }));
    const unknownSignature = createHmac("sha256", "secret-verification-token").update(unknownBody).digest("hex");
    await assert.rejects(restarted.authenticate(request(unknownBody, unknownSignature)), /authentication failed/i);
    database.connections.quarantine("notion_test", 1, "page_1", 1);
    await restarted.authenticate({ body: verification, headers: [], method: "POST", receivedAt,
      requestTarget: `/v1/ingress/notion?verification_attempt=${attempt}` });
    assert.equal(database.connections.subscriptions("notion_test")[0]!.verifiedAt, null);
    database.connections.beginVerification("notion_test", 1, "page_1", 1);
    const nextAttempt = database.providerRegistration.issue({ provider: "notion", providerId: "sub_1",
      connectionId: "notion_test", account: "ws_1", resource: "page_1" }, 60_000);
    const nextVerification = Buffer.from(JSON.stringify({ verification_token: "next-secret-verification-token" }));
    const nextVerified = await restarted.authenticate({ body: nextVerification, headers: [], method: "POST", receivedAt,
      requestTarget: `/v1/ingress/notion?verification_attempt=${nextAttempt}` });
    nextVerified.verificationCommit?.();
    const nextSignature = createHmac("sha256", "next-secret-verification-token").update(body).digest("hex");
    assert.equal((await restarted.authenticate(request(body, nextSignature))).connection?.resource, "page_1");
  });

  test("Notion起動configはpartial・不正識別子をfail closedにする", () => {
    assert.throws(() => loadConfig({ DONA_NOTION_PILOT_CONFIG: JSON.stringify({ connectionId: "notion_test" }) }), /invalid/);
    assert.throws(() => loadConfig({ DONA_NOTION_PILOT_CONFIG: JSON.stringify({ connectionId: "../notion", integrationId: "int_1",
      verificationCredentialRef: "cred_verify", secretStoreRoot: "/tmp/secrets" }) }), /invalid/);
  });
  test("verification credential refとintegration credential refの衝突を起動時に拒否する", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dona-notion-conflict-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = loadConfig({ DONA_DATABASE_PATH: path.join(root, "dispatcher.sqlite"),
      DONA_NOTION_PILOT_CONFIG: JSON.stringify({ connectionId: "notion_test", integrationId: "int_1",
        verificationCredentialRef: "cred_shared", secretStoreRoot: root }) });
    const database = new DispatcherDatabase(config.databasePath);
    t.after(() => database.close());
    database.connections.register({ id: "notion_test", provider: "notion", account: "ws_1",
      allowlist: [{ resource: "page_1", events: ["page.content_updated"] }],
      credentialRef: "cred_shared", credentialRevision: 1, capability: { kind: "manual", cursor: false } });
    assert.throws(() => serviceExternalIngressRegistry(config, database), /must be separate/);
  });
  test("Notion pilotはprovider不一致を起動時に拒否する", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dona-notion-topology-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = loadConfig({ DONA_DATABASE_PATH: path.join(root, "dispatcher.sqlite"),
      DONA_NOTION_PILOT_CONFIG: JSON.stringify({ connectionId: "notion_test", integrationId: "int_1",
        verificationCredentialRef: "cred_verify", secretStoreRoot: root }) });
    const database = new DispatcherDatabase(config.databasePath);
    t.after(() => database.close());
    database.connections.register({ id: "notion_test", provider: "github", account: "ws_1",
      allowlist: [{ resource: "page_1", events: ["page.content_updated"] }],
      credentialRef: "cred_integration", credentialRevision: 1, capability: { kind: "manual", cursor: false } });
    assert.throws(() => serviceExternalIngressRegistry(config, database), /notion provider/);
  });
  test("Notion pilotはmanaged capabilityを起動時に拒否する", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dona-notion-capability-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = loadConfig({ DONA_DATABASE_PATH: path.join(root, "dispatcher.sqlite"),
      DONA_NOTION_PILOT_CONFIG: JSON.stringify({ connectionId: "notion_test", integrationId: "int_1",
        verificationCredentialRef: "cred_verify", secretStoreRoot: root }) });
    const database = new DispatcherDatabase(config.databasePath); t.after(() => database.close());
    database.connections.register({ id: "notion_test", provider: "notion", account: "ws_1",
      allowlist: [{ resource: "page_1", events: ["page.content_updated"] }], credentialRef: "cred_integration",
      credentialRevision: 1, capability: { kind: "managed", cursor: false, renewal: "none" } });
    assert.throws(() => serviceExternalIngressRegistry(config, database), /manual non-cursor/);
  });
  test("pilot scope外の複数resource bindingを起動時に拒否する", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dona-notion-resources-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = loadConfig({ DONA_DATABASE_PATH: path.join(root, "dispatcher.sqlite"),
      DONA_NOTION_PILOT_CONFIG: JSON.stringify({ connectionId: "notion_test", integrationId: "int_1",
        verificationCredentialRef: "cred_verify", secretStoreRoot: root }) });
    const database = new DispatcherDatabase(config.databasePath); t.after(() => database.close());
    database.connections.register({ id: "notion_test", provider: "notion", account: "ws_1",
      allowlist: ["page_1", "page_2"].map(resource => ({ resource, events: ["page.content_updated"] })),
      credentialRef: "cred_integration", credentialRevision: 1, capability: { kind: "manual", cursor: false } });
    for (const resource of ["page_1", "page_2"]) {
      database.connections.attachManual("notion_test", 1, resource, "sub_1", null);
      database.connections.observe("notion_test", 1, resource, 1,
        { providerId: "sub_1", expiresAt: null, verified: false, cutoverConfirmed: false });
    }
    assert.throws(() => serviceExternalIngressRegistry(config, database), /exactly one resource/);
  });
  test("verification token is stored but omitted from the normalized event", async () => {
    const { registration, secret } = setup();
    const raw = request(Buffer.from(JSON.stringify({ verification_token: "secret-verification-token" })));
    const principal = await registration.authenticate(raw);
    const normalized = await registration.normalize(raw, principal) as Record<string, unknown>;
    assert.equal(secret()?.toString(), "secret-verification-token");
    assert.equal(JSON.stringify(normalized).includes("secret-verification-token"), false);
    assert.equal(principal.connection?.resource, "page_1");
    const unbound = request(Buffer.from(JSON.stringify({ verification_token: "secret-verification-token" })));
    await assert.rejects(registration.authenticate({ ...unbound, requestTarget: "/v1/ingress/notion" }));
    await assert.rejects(registration.authenticate({ ...unbound,
      requestTarget: "/v1/ingress/notion?verification_attempt=wrong_attempt_value" }));
    await assert.rejects(registration.authenticate(request(Buffer.from(JSON.stringify({
      verification_token: "different-verification-token" })))));
  });
  test("keeps verification dependency failures retryable", async () => {
    const { registration } = setup();
    registration.authenticate = createNotionRegistration({ connectionId: "notion_test", verificationSecretRef: "cred_notion_verify",
      secrets: { async get() { return undefined; } }, verification: { async claim() { throw new Error("busy"); } },
      bindings: { async resolve() { return undefined; } } }).authenticate;
    await assert.rejects(registration.authenticate(request(Buffer.from(JSON.stringify({
      verification_token: "secret-verification-token" })))), /temporarily unavailable|dependency is unavailable/i);
  });
  test("keeps event secret and binding dependency failures retryable", async () => {
    for (const failing of ["secret", "binding"] as const) {
      const registration = createNotionRegistration({ connectionId: "notion_test", verificationSecretRef: "cred_notion_verify",
        secrets: { async get() { if (failing === "secret") throw new Error("busy"); return Buffer.from("secret-verification-token"); } },
        verification: { async claim() { return undefined; } },
        bindings: { async resolve() { if (failing === "binding") throw new Error("busy"); return undefined; } } });
      const signature = createHmac("sha256", "secret-verification-token").update(body).digest("hex");
      await assert.rejects(registration.authenticate(request(body, signature)), /dependency is unavailable/i);
    }
  });
  test("secret revisionをbindingへ固定し、使用後のbufferを消去する", async () => {
    const secret = Buffer.from("secret-verification-token");
    const registration = createNotionRegistration({ connectionId: "notion_test", verificationSecretRef: "cred_notion_verify",
      secrets: { async get() { return { secret, credentialRevision: 1 }; } }, verification: { async claim() { return undefined; } },
      bindings: { async resolve(input) { return input.credentialRevision === 2 ? { connectionId: "notion_test", account: "ws_1", revision: 2,
        credentialRevision: 2, resource: "page_1", generation: 2 } : undefined; } } });
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    await assert.rejects(registration.authenticate(request(body, signature)));
    assert.ok(secret.every(byte => byte === 0));
  });
  test("署名header欠落・不正hexでも取得済みsecret bufferを消去する", async () => {
    for (const signature of [undefined, "not-hex"]) {
      const secret = Buffer.from("secret-verification-token");
      const registration = createNotionRegistration({ connectionId: "notion_test", verificationSecretRef: "cred_notion_verify",
        secrets: { async get() { return secret; } }, verification: { async claim() { return undefined; } },
        bindings: { async resolve() { return undefined; } } });
      await assert.rejects(registration.authenticate(request(body, signature)));
      assert.ok(secret.every(byte => byte === 0));
    }
  });
  test("authenticates exact raw bytes and strictly normalizes an allowlisted event", async () => {
    const { registration } = setup();
    const verification = request(Buffer.from(JSON.stringify({ verification_token: "secret-verification-token" })));
    await registration.authenticate(verification);
    const signature = createHmac("sha256", "secret-verification-token").update(body).digest("hex");
    const principal = await registration.authenticate(request(body, signature));
    const normalized = await registration.normalize(request(body, signature), principal) as any;
    assert.equal(normalized.providerEventId, "evt_1");
    assert.deepEqual(normalized.payload, {});
    assert.deepEqual(registration.queueSignal?.(normalized, principal),
      { resourceKey: "page_1", signalKey: "page_1", requiresFetch: true, latestState: true });
    await assert.rejects(registration.authenticate(request(Buffer.concat([body, Buffer.from(" ")]), signature)));
  });
  test("accepts documented metadata and keeps retries fingerprint-equivalent", async () => {
    const { registration } = setup();
    await registration.authenticate(request(Buffer.from(JSON.stringify({ verification_token: "secret-verification-token" }))));
    const first = Buffer.from(JSON.stringify({ ...JSON.parse(body.toString()), workspace_name: "Test",
      authors: [{ id: "user_1" }], data: { parent: { id: "page_1" } }, attempt_number: 1 }));
    const retry = Buffer.from(JSON.stringify({ ...JSON.parse(first.toString()), attempt_number: 2 }));
    const normalized = [];
    for (const payload of [first, retry]) {
      const signature = createHmac("sha256", "secret-verification-token").update(payload).digest("hex");
      const principal = await registration.authenticate(request(payload, signature));
      normalized.push(await registration.normalize(request(payload, signature), principal));
    }
    assert.deepEqual(normalized[0], normalized[1]);
  });
  test("rejects non-allowlisted entities and invalid attempts before dispatch", async () => {
    const { registration } = setup();
    const verification = request(Buffer.from(JSON.stringify({ verification_token: "secret-verification-token" })));
    await registration.authenticate(verification);
    for (const replacement of [{ entity: { id: "page_2", type: "page" } }, { attempt_number: 9 }]) {
      const payload = Buffer.from(JSON.stringify({ ...JSON.parse(body.toString()), ...replacement }));
      const signature = createHmac("sha256", "secret-verification-token").update(payload).digest("hex");
      await assert.rejects(registration.authenticate(request(payload, signature)));
    }
  });
  test("classifies latest-state fetch failures without writing provider data", async () => {
    for (const [status, outcome] of [[200, "fetched"], [404, "not_found_or_inaccessible"], [403, "permission_lost"],
      [429, "rate_limited"], [500, "degraded"]] as const) {
      const result = await fetchLatestNotionState({ async fetch() { return status === 200
        ? { status, retryAfter: 3, value: { id: "page_1", last_edited_time: receivedAt } }
        : { status, retryAfter: 3 }; } }, "page_1");
      assert.equal(result.outcome, outcome);
    }
    assert.deepEqual(await fetchLatestNotionState({ async fetch() { throw new Error("timeout"); } }, "page_1"),
      { outcome: "degraded" });
  });
  test("latest-state fetchは必要fieldだけを明示上限内へ正規化する", async () => {
    const normalized = normalizeNotionFetchValue({ id: "page_1", last_edited_time: receivedAt,
      properties: { title: { rich_text: [{ plain_text: "x".repeat(100_000) }] } },
      request_id: "omit", workspace_secret: "omit" });
    assert.equal("request_id" in normalized, false);
    assert.equal("workspace_secret" in normalized, false);
    assert.ok(Buffer.byteLength(JSON.stringify(normalized)) <= 48 * 1024);
    const emptyContainers = normalizeNotionFetchValue({ children: Array.from({ length: 100_000 }, () => ({})) });
    assert.ok(Buffer.byteLength(JSON.stringify(emptyContainers)) <= 48 * 1024);
    assert.equal(emptyContainers.children_truncated, true);
    const oversizedScalar = normalizeNotionFetchValue({ title: "x".repeat(100_000),
      description: "y".repeat(100_000), properties: {} });
    assert.ok(Buffer.byteLength(JSON.stringify(oversizedScalar)) <= 48 * 1024);
  });
});
