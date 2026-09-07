import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import { createNotionRegistration, fetchLatestNotionState } from "../src/notion.js";

const receivedAt = "2026-09-07T00:00:00.000Z";
const body = Buffer.from(JSON.stringify({ id: "evt_1", timestamp: receivedAt, workspace_id: "ws_1",
  subscription_id: "sub_1", integration_id: "int_1", type: "page.content_updated",
  entity: { id: "page_1", type: "page" }, attempt_number: 8 }));
function request(payload: Buffer, signature?: string) { return { body: payload,
  headers: signature ? [["x-notion-signature", signature] as const] : [], method: "POST" as const,
  requestTarget: "/v1/ingress/notion", receivedAt }; }
function setup() {
  let secret: Buffer | undefined;
  const registration = createNotionRegistration({ connectionId: "notion_test", verificationSecretRef: "cred_notion_verify",
    secrets: { async get() { return secret; }, async put(_ref, value) { secret = Buffer.from(value); } },
    bindings: { async resolve(input) { return input.resourceId === "page_1" && input.eventType === "page.content_updated"
      ? { connectionId: "notion_test", account: "ws_1", revision: 1, credentialRevision: 1,
        resource: "page_1", generation: 1 } : undefined; } } });
  return { registration, secret: () => secret };
}

describe("Notion ingress", () => {
  test("verification token is stored but omitted from the normalized event", async () => {
    const { registration, secret } = setup();
    const raw = request(Buffer.from(JSON.stringify({ verification_token: "secret-verification-token" })));
    const principal = await registration.authenticate(raw);
    const normalized = await registration.normalize(raw, principal) as Record<string, unknown>;
    assert.equal(secret()?.toString(), "secret-verification-token");
    assert.equal(JSON.stringify(normalized).includes("secret-verification-token"), false);
  });
  test("authenticates exact raw bytes and strictly normalizes an allowlisted event", async () => {
    const { registration } = setup();
    const verification = request(Buffer.from(JSON.stringify({ verification_token: "secret-verification-token" })));
    await registration.authenticate(verification);
    const signature = createHmac("sha256", "secret-verification-token").update(body).digest("hex");
    const principal = await registration.authenticate(request(body, signature));
    const normalized = await registration.normalize(request(body, signature), principal) as any;
    assert.equal(normalized.providerEventId, "evt_1");
    assert.deepEqual(normalized.payload, { attempt_number: 8 });
    assert.deepEqual(registration.queueSignal?.(normalized, principal),
      { resourceKey: "page_1", signalKey: "page_1", requiresFetch: true });
    await assert.rejects(registration.authenticate(request(Buffer.concat([body, Buffer.from(" ")]), signature)));
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
    for (const [status, outcome] of [[200, "fetched"], [404, "deleted"], [403, "permission_lost"],
      [429, "rate_limited"], [500, "degraded"]] as const) {
      const result = await fetchLatestNotionState({ async fetch() { return status === 200
        ? { status, retryAfter: 3, value: { id: "page_1", last_edited_time: receivedAt } }
        : { status, retryAfter: 3 }; } }, "page_1");
      assert.equal(result.outcome, outcome);
    }
  });
});
