import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { afterEach, describe, test } from "node:test";

import { z } from "zod";

import { DispatcherApi } from "../src/api.js";
import { DispatcherDatabase } from "../src/database.js";
import {
  externalEventSource,
  ExternalIngressRegistry,
  scopedExternalEventId,
  type ExternalEventSourceRegistration,
  type RawIngressRequest,
} from "../src/ingress.js";
import type { Logger } from "../src/logger.js";
import { envelopeFromRow } from "../src/prompt.js";
import { tempConfig } from "./helpers.js";

const roots: string[] = [];
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const jobs = {
  isRunning: () => true,
  wake() {},
  async steer() { throw new Error("not used"); },
  async cancel() { throw new Error("not used"); },
};
const secret = "fake-provider-secret";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const normalizedFakeEventSchema = z.object({
  providerEventId: z.string().min(1),
  type: z.literal("fake.changed"),
  occurredAt: z.string(),
  subject: z.object({ resourceId: z.string() }).strict(),
  payload: z.object({ value: z.string() }).strict(),
  replyTarget: z.null(),
  trace: z.object({ deliveryAttempt: z.number().int().positive() }).strict(),
}).strict();

function signature(body: Buffer): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function header(request: RawIngressRequest, name: string): string | undefined {
  return request.headers.find(([candidate]) => candidate.toLowerCase() === name.toLowerCase())?.[1];
}

function fakeBody(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    providerEventId: "delivery-1",
    type: "fake.changed",
    occurredAt: "2026-09-05T00:00:00.000Z",
    subject: { resourceId: "resource-1" },
    payload: { value: "one" },
    replyTarget: null,
    trace: { deliveryAttempt: 1 },
    ...overrides,
  }));
}

function registration(options: {
  steps?: string[];
  onAuthenticate?: (request: RawIngressRequest) => void;
  onAcknowledge?: (eventId: string) => void;
  failAcknowledgement?: () => boolean;
  authenticate?: ExternalEventSourceRegistration["authenticate"];
  bodyTimeoutMs?: number;
} = {}): ExternalEventSourceRegistration {
  return {
    source: "fake",
    maxBodyBytes: 4_096,
    bodyTimeoutMs: options.bodyTimeoutMs ?? 200,
    processingTimeoutMs: 200,
    async authenticate(request) {
      options.steps?.push("authenticate");
      options.onAuthenticate?.(request);
      if (options.authenticate) return options.authenticate(request);
      if (header(request, "x-fake-signature") !== signature(request.body)) throw new Error("invalid signature");
      const connectionId = header(request, "x-fake-connection");
      if (!connectionId) throw new Error("missing connection");
      return { connectionId, principal: { kind: "fake_installation", id: "principal-1" } };
    },
    normalize(request, verified) {
      options.steps?.push("normalize");
      assert.equal(verified.principal.kind, "fake_installation");
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body)) as unknown;
    },
    parseNormalized(input) {
      return normalizedFakeEventSchema.parse(input);
    },
    buildAcknowledgement(receipt) {
      options.steps?.push("acknowledge");
      if (options.failAcknowledgement?.()) throw new Error("formatter unavailable");
      options.onAcknowledge?.(receipt.eventId);
      return {
        statusCode: receipt.outcome === "created" ? 202 : 200,
        body: {
          schema_version: 1,
          event_id: receipt.eventId,
          outcome: receipt.outcome,
          committed_at: receipt.committedAt,
        },
      };
    },
  };
}

function request(
  socketPath: string,
  source: string,
  body: Buffer,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method: "POST",
        path: `/v1/ingress/${encodeURIComponent(source)}`,
        headers: {
          ...extraHeaders,
          "content-type": "application/octet-stream",
          "content-length": String(body.length),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
          });
        });
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}

function signedHeaders(body: Buffer, connection = "connection-a"): Record<string, string> {
  return {
    "X-Fake-Signature": signature(body),
    "X-Fake-Connection": connection,
  };
}

describe("external ingress contract", () => {
  test("passes identical raw bytes through auth and normalization, persists, then builds the ACK", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const steps: string[] = [];
    let authenticatedBody: Buffer | undefined;
    const definition = registration({
      steps,
      onAuthenticate(raw) {
        authenticatedBody = raw.body;
        assert.equal(raw.method, "POST");
        assert.equal(raw.path, "/v1/ingress/fake");
        assert.match(raw.receivedAt, /Z$/);
        assert.ok(raw.headers.some(([name]) => name === "X-Fake-Signature"));
      },
      onAcknowledge(eventId) {
        assert.ok(database.get(eventId), "the durable row must exist before the ACK is built");
      },
    });
    const registry = new ExternalIngressRegistry([{
      ...definition,
      normalize(raw, verified) {
        assert.equal(raw.body, authenticatedBody, "auth and normalization must receive the same Buffer instance");
        return definition.normalize(raw, verified);
      },
    }]);
    let wakeCount = 0;
    const api = new DispatcherApi(
      database,
      { isRunning: () => true, wake: () => void (wakeCount += 1) },
      jobs,
      config,
      logger,
      undefined,
      undefined,
      undefined,
      registry,
    );
    await api.start();

    const body = fakeBody();
    const response = await request(config.socketPath, "fake", body, signedHeaders(body));
    assert.equal(response.status, 202);
    assert.equal(response.body.outcome, "created");
    assert.deepEqual(steps, ["authenticate", "normalize", "acknowledge"]);
    assert.equal(wakeCount, 1);

    const [row] = database.list();
    assert.ok(row);
    assert.equal(row.source, "fake");
    assert.equal(row.external_event_id, scopedExternalEventId(externalEventSource(row.source), "connection-a", "delivery-1"));
    assert.equal(row.reply_target_json, null);
    assert.equal(envelopeFromRow(row).reply_target, null);
    const persisted = JSON.stringify(row);
    assert.doesNotMatch(persisted, /fake-provider-secret|X-Fake-Signature|principal-1|delivery-1/);

    await api.stop();
    database.close();
  });

  test("converges concurrent redelivery, rejects conflicting content, and scopes IDs by connection", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    let acknowledgements = 0;
    const registry = new ExternalIngressRegistry([registration({
      onAcknowledge() { acknowledgements += 1; },
    })]);
    const api = new DispatcherApi(
      database,
      { isRunning: () => true, wake() {} },
      jobs,
      config,
      logger,
      undefined,
      undefined,
      undefined,
      registry,
    );
    await api.start();

    const body = fakeBody();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => request(config.socketPath, "fake", body, signedHeaders(body))),
    );
    assert.equal(responses.filter(({ status }) => status === 202).length, 1);
    assert.equal(responses.filter(({ status }) => status === 200).length, 7);
    assert.equal(new Set(responses.map(({ body: responseBody }) => responseBody.event_id)).size, 1);
    assert.equal(database.list().length, 1);
    assert.equal(acknowledgements, 8);

    const retriedBody = fakeBody({ trace: { deliveryAttempt: 2 } });
    const retried = await request(config.socketPath, "fake", retriedBody, signedHeaders(retriedBody));
    assert.equal(retried.status, 200);
    assert.equal(retried.body.outcome, "duplicate_same", "delivery metadata is not canonical event content");
    assert.equal(acknowledgements, 9);

    const conflictBody = fakeBody({ payload: { value: "different" } });
    const conflict = await request(config.socketPath, "fake", conflictBody, signedHeaders(conflictBody));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.outcome, "duplicate_conflict");
    assert.equal(acknowledgements, 9, "conflicts must not pass the provider ACK gate");
    assert.match(database.list()[0]!.payload_json, /"one"/);

    const otherConnection = await request(
      config.socketPath,
      "fake",
      body,
      signedHeaders(body, "connection-b"),
    );
    assert.equal(otherConnection.status, 202);
    assert.equal(database.list().length, 2);

    await api.stop();
    database.close();
  });

  test("rejects unauthenticated, invalid, cross-provider, internal, and unknown inputs before persistence", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const registry = new ExternalIngressRegistry([registration()]);
    const api = new DispatcherApi(
      database,
      { isRunning: () => true, wake() {} },
      jobs,
      config,
      logger,
      undefined,
      undefined,
      undefined,
      registry,
    );
    await api.start();

    const valid = fakeBody();
    assert.equal((await request(config.socketPath, "fake", valid, {
      ...signedHeaders(valid),
      "X-Fake-Signature": "wrong",
    })).status, 401);

    const topLevelExtra = fakeBody({ source: "dona_update" });
    assert.equal((await request(config.socketPath, "fake", topLevelExtra, signedHeaders(topLevelExtra))).status, 400);
    const providerFieldMix = fakeBody({ payload: { value: "one", github_installation: 123 } });
    assert.equal((await request(config.socketPath, "fake", providerFieldMix, signedHeaders(providerFieldMix))).status, 400);
    const wrongTime = fakeBody({ occurredAt: "2026-09-05T09:00:00+09:00" });
    assert.equal((await request(config.socketPath, "fake", wrongTime, signedHeaders(wrongTime))).status, 400);
    const invalidUtf8 = Buffer.from([0xff, 0xfe]);
    assert.equal((await request(config.socketPath, "fake", invalidUtf8, signedHeaders(invalidUtf8))).status, 400);
    const invalidJson = Buffer.from("{");
    assert.equal((await request(config.socketPath, "fake", invalidJson, signedHeaders(invalidJson))).status, 400);
    assert.equal((await request(config.socketPath, "dona_update", valid, signedHeaders(valid))).status, 404);
    assert.equal((await request(config.socketPath, "unknown", valid, signedHeaders(valid))).status, 404);
    assert.equal(database.list().length, 0);

    await api.stop();
    database.close();
  });

  test("enforces raw body and processing time limits without acknowledging or persisting", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    let acknowledgements = 0;
    const slow = registration({
      bodyTimeoutMs: 30,
      authenticate: async () => new Promise(() => {}),
      onAcknowledge() { acknowledgements += 1; },
    });
    const registry = new ExternalIngressRegistry([{ ...slow, maxBodyBytes: 8, processingTimeoutMs: 30 }]);
    const api = new DispatcherApi(
      database,
      { isRunning: () => true, wake() {} },
      jobs,
      config,
      logger,
      undefined,
      undefined,
      undefined,
      registry,
    );
    await api.start();

    const oversized = fakeBody();
    assert.equal((await request(config.socketPath, "fake", oversized, signedHeaders(oversized))).status, 413);
    const small = Buffer.from("{}");
    assert.equal((await request(config.socketPath, "fake", small, signedHeaders(small))).status, 408);
    assert.equal(acknowledgements, 0);
    assert.equal(database.list().length, 0);

    const partialResponse = new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(config.socketPath);
      let response = "";
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        socket.write("POST /v1/ingress/fake HTTP/1.1\r\nHost: localhost\r\nContent-Length: 7\r\n\r\n{");
      });
      socket.on("data", (chunk: string) => {
        response += chunk;
        if (response.includes("request_timeout")) {
          socket.end();
          resolve(response);
        }
      });
      socket.once("error", reject);
    });
    assert.match(await partialResponse, /408 Request Timeout/);
    assert.equal(database.list().length, 0);

    await api.stop();
    database.close();
  });

  test("does not ACK a persistence failure and safely reconciles an ACK formatter failure", async () => {
    const first = await tempConfig();
    roots.push(first.root);
    const closedDatabase = new DispatcherDatabase(first.config.databasePath);
    let failedPersistenceAcks = 0;
    const firstApi = new DispatcherApi(
      closedDatabase,
      { isRunning: () => true, wake() {} },
      jobs,
      first.config,
      logger,
      undefined,
      undefined,
      undefined,
      new ExternalIngressRegistry([registration({ onAcknowledge() { failedPersistenceAcks += 1; } })]),
    );
    await firstApi.start();
    closedDatabase.close();
    const body = fakeBody();
    assert.equal((await request(first.config.socketPath, "fake", body, signedHeaders(body))).status, 503);
    assert.equal(failedPersistenceAcks, 0);
    await firstApi.stop();

    const second = await tempConfig();
    roots.push(second.root);
    const database = new DispatcherDatabase(second.config.databasePath);
    let failAcknowledgement = true;
    const secondApi = new DispatcherApi(
      database,
      { isRunning: () => true, wake() {} },
      jobs,
      second.config,
      logger,
      undefined,
      undefined,
      undefined,
      new ExternalIngressRegistry([registration({
        failAcknowledgement: () => failAcknowledgement,
      })]),
    );
    await secondApi.start();
    assert.equal((await request(second.config.socketPath, "fake", body, signedHeaders(body))).status, 503);
    assert.equal(database.list().length, 1, "the commit survives acknowledgement failure");
    failAcknowledgement = false;
    const reconciled = await request(second.config.socketPath, "fake", body, signedHeaders(body));
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.outcome, "duplicate_same");
    assert.equal(database.list().length, 1);

    await secondApi.stop();
    database.close();
  });

  test("rejects duplicate or reserved registrations", () => {
    assert.throws(() => new ExternalIngressRegistry([{ ...registration(), source: "slack" }]), /non-reserved/);
    assert.throws(() => new ExternalIngressRegistry([registration(), registration()]), /already registered/);
    assert.throws(() => new ExternalIngressRegistry([{ ...registration(), maxBodyBytes: 0 }]), /positive integer/);
    assert.throws(
      () => new ExternalIngressRegistry([{ ...registration(), processingTimeoutMs: 60_001 }]),
      /hard limit/,
    );
  });
});
