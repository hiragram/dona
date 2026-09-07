import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { externalEventSource, ExternalIngressAuthenticationError, ExternalIngressProcessor, ExternalIngressRegistry } from "../src/ingress.js";
import { figmaIngress, figmaIngressFromEnv } from "../src/providers/figma.js";

const config = { connectionId: "figma-pilot", webhookId: "webhook-1", fileKey: "file-1", allowedEvents: new Set(["FILE_UPDATE"]), passcode: "top-secret" };
const registration = figmaIngress(config);

function raw(value: Record<string, unknown>) {
  return { body: Buffer.from(JSON.stringify(value)), headers: [], method: "POST" as const, requestTarget: "/v1/ingress/figma", receivedAt: "2026-09-07T00:00:00.000Z" };
}

function event(overrides: Record<string, unknown> = {}) {
  return { passcode: config.passcode, webhook_id: config.webhookId, event_type: "FILE_UPDATE", timestamp: "2026-09-07T00:00:00Z", file_key: config.fileKey, ...overrides };
}

describe("Figma Webhooks V2 ingress", () => {
  test("authenticates before normalization and never emits the passcode", async () => {
    const request = raw(event());
    const verified = await registration.authenticate(request);
    const normalized = registration.parseNormalized(await registration.normalize(request, verified));
    assert.equal(normalized.type, "figma.file_update");
    assert.equal(JSON.stringify(normalized).includes(config.passcode), false);
    assert.match(normalized.providerEventId, /^payload-v1:[0-9a-f]{64}$/);
    const rotated = raw(event({ passcode: "replacement-secret" }));
    const rotatedRegistration = figmaIngress({ ...config, passcode: "replacement-secret" });
    const rotatedEvent = rotatedRegistration.parseNormalized(await rotatedRegistration.normalize(rotated, await rotatedRegistration.authenticate(rotated)));
    assert.equal(rotatedEvent.providerEventId, normalized.providerEventId, "passcode rotation must not change or expose the fingerprint");
  });

  test("rejects wrong passcode, unknown fields, resources, and events", async () => {
    await assert.rejects(registration.authenticate(raw(event({ passcode: "wrong" }))), ExternalIngressAuthenticationError);
    const verified = await registration.authenticate(raw(event()));
    await assert.rejects(Promise.resolve().then(() => registration.normalize(raw(event({ extra: true })), verified)));
    await assert.rejects(Promise.resolve().then(() => registration.normalize(raw(event({ file_key: "other" })), verified)));
    await assert.rejects(Promise.resolve().then(() => registration.normalize(raw(event({ event_type: "FILE_COMMENT" })), verified)));
  });

  test("fails startup for an invalid connection or unsupported event configuration", () => {
    assert.throws(() => figmaIngress({ ...config, connectionId: "figma:pilot" }));
    assert.throws(() => figmaIngress({ ...config, allowedEvents: new Set(["FILE_COMMENT"]) }));
  });

  test("rejects partial environment configuration instead of silently disabling ingress", () => {
    assert.equal(figmaIngressFromEnv({}), undefined);
    assert.throws(() => figmaIngressFromEnv({ FIGMA_WEBHOOK_ID: config.webhookId }));
    assert.ok(figmaIngressFromEnv({ FIGMA_CONNECTION_ID: config.connectionId, FIGMA_WEBHOOK_ID: config.webhookId,
      FIGMA_FILE_KEY: config.fileKey, FIGMA_ALLOWED_EVENTS: "FILE_UPDATE", FIGMA_WEBHOOK_PASSCODE: config.passcode }));
  });

  test("binds the verified owner to the configured file instead of payload data", async () => {
    const verified = await registration.authenticate(raw(event()));
    assert.equal(verified.resourceId, config.fileKey);
  });

  test("converges exact retries, separates different raw payloads, and keeps PING out of persistence", async () => {
    const processor = new ExternalIngressProcessor(new ExternalIngressRegistry([registration]));
    const request = raw(event());
    let persists = 0;
    const persist = () => { persists += 1; return { outcome: "created" as const, duplicate: false, payloadMismatch: false, row: { event_id: "evt_01M1WK7YZX7C741KJ32TQ6SCVN", sequence: persists, created_at: request.receivedAt } as never, committedAt: request.receivedAt }; };
    const source = externalEventSource("figma");
    const first = await processor.process(source, registration, request, persist);
    assert.equal(first.acknowledgement?.statusCode, 200);
    const ping = raw(event({ event_type: "PING", file_key: undefined }));
    const pingResult = await processor.process(source, registration, ping, persist);
    assert.equal(pingResult.acknowledgement?.statusCode, 200);
    assert.equal(persists, 1);
  });
});
