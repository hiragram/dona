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
  ExternalIngressProcessor,
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
  query = "",
): Promise<{ status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method: "POST",
        path: `/v1/ingress/${encodeURIComponent(source)}${query}`,
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
            headers: response.headers,
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
        assert.equal(raw.requestTarget, "/v1/ingress/fake?tenant=abc");
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
    const response = await request(config.socketPath, "fake", body, signedHeaders(body), "?tenant=abc");
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
    const definition = registration();
    const registry = new ExternalIngressRegistry([{
      ...definition,
      async authenticate(request) {
        const verified = await definition.authenticate(request);
        if (header(request, "x-fake-invalid-connection") === "number") {
          return { ...verified, connectionId: 123 as unknown as string };
        }
        return verified;
      },
    }]);
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
    assert.equal((await request(config.socketPath, "fake", valid, {
      ...signedHeaders(valid),
      "X-Fake-Invalid-Connection": "number",
    })).status, 401);

    const topLevelExtra = fakeBody({ source: "dona_update" });
    assert.equal((await request(config.socketPath, "fake", topLevelExtra, signedHeaders(topLevelExtra))).status, 400);
    const providerFieldMix = fakeBody({ payload: { value: "one", github_installation: 123 } });
    assert.equal((await request(config.socketPath, "fake", providerFieldMix, signedHeaders(providerFieldMix))).status, 400);
    const wrongTime = fakeBody({ occurredAt: "2026-09-05T09:00:00+09:00" });
    assert.equal((await request(config.socketPath, "fake", wrongTime, signedHeaders(wrongTime))).status, 400);
    for (const occurredAt of ["2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z"]) {
      const impossibleDate = fakeBody({ occurredAt });
      assert.equal((await request(config.socketPath, "fake", impossibleDate, signedHeaders(impossibleDate))).status, 400);
    }
    const invalidUtf8 = Buffer.from([0xff, 0xfe]);
    assert.equal((await request(config.socketPath, "fake", invalidUtf8, signedHeaders(invalidUtf8))).status, 400);
    const invalidJson = Buffer.from("{");
    assert.equal((await request(config.socketPath, "fake", invalidJson, signedHeaders(invalidJson))).status, 400);
    assert.equal((await request(config.socketPath, "dona_update", valid, signedHeaders(valid))).status, 404);
    const unknown = await request(config.socketPath, "unknown", valid, signedHeaders(valid));
    assert.equal(unknown.status, 404);
    assert.equal(unknown.headers.connection, "close");

    const partialUnknownResponse = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(config.socketPath);
      let response = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("unknown-source connection did not close"));
      }, 500);
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        socket.write("POST /v1/ingress/unknown HTTP/1.1\r\nHost: localhost\r\nContent-Length: 7\r\n\r\n{");
      });
      socket.on("data", (chunk: string) => {
        response += chunk;
      });
      socket.once("close", () => {
        clearTimeout(timer);
        resolve(response);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    assert.match(partialUnknownResponse, /404 Not Found/);
    assert.match(partialUnknownResponse, /Connection: close/i);
    assert.equal(database.list().length, 0);

    await api.stop();
    database.close();
  });

  test("rejects non-JSON normalized value trees before persistence", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const definition = registration();
    let attempt = 0;
    const registry = new ExternalIngressRegistry([{
      ...definition,
      parseNormalized(input) {
        const parsed = definition.parseNormalized(input);
        attempt += 1;
        if (attempt === 1) return { ...parsed, payload: { value: 1n } };
        if (attempt === 2) {
          const circular: Record<string, unknown> = {};
          circular.self = circular;
          return { ...parsed, payload: circular };
        }
        if (attempt === 3) return { ...parsed, subject: { resourceId: undefined } };
        if (attempt === 4) return { ...parsed, trace: { deliveryAttempt: Number.NaN } };
        return parsed;
      },
    }]);
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
    for (let index = 0; index < 4; index += 1) {
      assert.equal((await request(config.socketPath, "fake", body, signedHeaders(body))).status, 400);
      assert.equal(database.list().length, 0);
    }
    assert.equal((await request(config.socketPath, "fake", body, signedHeaders(body))).status, 202);
    assert.equal(database.list().length, 1);

    await api.stop();
    database.close();
  });

  test("shares one processing deadline across authentication and normalization", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    let acknowledgements = 0;
    const definition = registration({
      async authenticate() {
        await new Promise((resolve) => setTimeout(resolve, 55));
        return { connectionId: "connection-a", principal: { kind: "fake_installation" } };
      },
      onAcknowledge() { acknowledgements += 1; },
    });
    const registry = new ExternalIngressRegistry([{
      ...definition,
      processingTimeoutMs: 80,
      async normalize(raw, verified) {
        await new Promise((resolve) => setTimeout(resolve, 55));
        return definition.normalize(raw, verified);
      },
    }]);
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
    assert.equal((await request(config.socketPath, "fake", body, signedHeaders(body))).status, 408);
    assert.equal(acknowledgements, 0);
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
    const oversizedResponse = await request(config.socketPath, "fake", oversized, signedHeaders(oversized));
    assert.equal(oversizedResponse.status, 413);
    assert.equal(oversizedResponse.headers.connection, "close");
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
    const partial = await partialResponse;
    assert.match(partial, /408 Request Timeout/);
    assert.match(partial, /Connection: close/i);
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

  test("rejects invalid ACK statuses, headers, and bodies after persistence", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const definition = registration();
    let attempt = 0;
    const registry = new ExternalIngressRegistry([{
      ...definition,
      buildAcknowledgement(receipt) {
        attempt += 1;
        if (attempt === 1) return { statusCode: 204, body: {} };
        if (attempt === 2) return { statusCode: 205, body: {} };
        if (attempt === 3) return { statusCode: 202, body: { value: 1n } };
        if (attempt === 4) {
          const circular: Record<string, unknown> = {};
          circular.self = circular;
          return { statusCode: 202, body: circular };
        }
        if (attempt === 5) return { statusCode: 202, headers: { "x-provider-status": "bad\u0000value" }, body: {} };
        if (attempt === 6) return { statusCode: 202, headers: { "x-provider-status": "bad\u0007value" }, body: {} };
        if (attempt === 7) return { statusCode: 202, headers: { "x-provider-status": "snowman \u2603" }, body: {} };
        return definition.buildAcknowledgement(receipt);
      },
    }]);
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
    for (let index = 0; index < 7; index += 1) {
      assert.equal((await request(config.socketPath, "fake", body, signedHeaders(body))).status, 503);
      assert.equal(database.list().length, 1, "the commit survives invalid acknowledgement output");
    }
    const reconciled = await request(config.socketPath, "fake", body, signedHeaders(body));
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.outcome, "duplicate_same");
    assert.equal(database.list().length, 1);

    await api.stop();
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

test("永続connection bindingを認証結果からcommitへ渡しdisable/revision不一致ではACKしない", async () => {
  const {root, config} = await tempConfig(); roots.push(root);
  let now=Date.now();const database = new DispatcherDatabase(config.databasePath,{now:()=>now});
  const connection = {id:"connection-a",provider:"fake",account:"tenant1",credentialRef:"cred_fixture",credentialRevision:1,
    allowlist:[{resource:"resource-1",events:["fake.changed"]}],capability:{kind:"manual" as const,cursor:false}};
  database.connections.register(connection);
  database.connections.attachManual(connection.id,1,"resource-1","fixture-subscription",null);
  database.connections.observe(connection.id,1,"resource-1",1,{providerId:"fixture-subscription",expiresAt:null,verified:true,cutoverConfirmed:false});
  let revision=1;let generation=1; let ackCount=0;
  const base=registration({onAcknowledge:()=>{ackCount++;}});
  const registry=new ExternalIngressRegistry([{...base,async authenticate(raw){
    const verified=await base.authenticate(raw);
    return {...verified,connection:{account:"tenant1",revision,credentialRevision:1,resource:"resource-1",generation}};
  },normalize(raw,verified){
    (verified.connection as {account:string}).account="forged";
    return base.normalize(raw,verified);
  },queueSignal(normalized,verified){
    (verified.connection as {revision:number}).revision=99;
    return base.queueSignal?.(normalized,verified);
  }}]);
  const api=new DispatcherApi(database,{isRunning:()=>true,wake(){}},jobs,config,logger,undefined,undefined,undefined,registry);
  await api.start();
  try {
    const body=fakeBody();
    const initial=await request(config.socketPath,"fake",body,signedHeaders(body));
    assert.equal(initial.status,202,JSON.stringify(initial.body));
    generation=0;
    assert.equal((await request(config.socketPath,"fake",fakeBody({providerEventId:"invalid-binding"}),signedHeaders(fakeBody({providerEventId:"invalid-binding"})))).status,401);
    generation=1;now+=100;
    const anchor=fakeBody({providerEventId:"clock-anchor"});assert.equal((await request(config.socketPath,"fake",anchor,signedHeaders(anchor))).status,202);
    now-=100;
    const rewind=fakeBody({providerEventId:"clock-rewind"});assert.equal((await request(config.socketPath,"fake",rewind,signedHeaders(rewind))).status,503);
    now+=100;
    revision=2;
    const rejected=await request(config.socketPath,"fake",body,signedHeaders(body));
    assert.equal(rejected.status,403);
    assert.deepEqual(rejected.body,{schema_version:1,error:{code:"connection_not_authorized",message:"Connection binding is not authorized"}});
    revision=1;database.connections.disable(connection.id,1);
    assert.equal((await request(config.socketPath,"fake",body,signedHeaders(body))).status,403);
    assert.equal(ackCount,2);assert.equal(database.list().length,2);
    const rawHttp=(method:string,route:string,payload?:unknown)=>new Promise<{status:number;body:Record<string,unknown>}>((resolve,reject)=>{
      const req=http.request({socketPath:config.socketPath,method,path:route,headers:{"content-type":"application/json"}},response=>{
        const chunks:Buffer[]=[];response.on("data",chunk=>chunks.push(chunk));response.on("end",()=>resolve({status:response.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString())}));
      });req.on("error",reject);req.end(payload===undefined?undefined:JSON.stringify(payload));
    });
    const health=await rawHttp("GET","/health/ready");
    assert.equal(health.status,200);assert.equal((health.body.connections as {disabled:number}).disabled,1);
    const normalRoute=await rawHttp("POST","/v1/events",{schema_version:1,source:"fake",external_event_id:"bypass",type:"fake.changed",occurred_at:"2026-09-05T00:00:00.000Z",subject:{},payload:{},reply_target:null});
    assert.equal(normalRoute.status,400);assert.equal(database.list().length,2);
  } finally {await api.stop();database.close();}
});
test("binds owner from authenticated transport metadata before normalization and persists it before ACK", async () => {
  const { root, config } = await tempConfig(); roots.push(root);
  const database = new DispatcherDatabase(config.databasePath);
  const verified = { connectionId: "connection-trusted", resourceId: "resource-trusted", principal: { kind: "fake_installation" } };
  const registered = registration({ authenticate: async () => verified });
  const originalNormalize = registered.normalize;
  registered.normalize = (raw, principal) => {
    const result = originalNormalize(raw, principal);
    // normalizer が返す payload/subject と auth identity を分離する。
    verified.connectionId = "payload-connection"; verified.resourceId = "payload-resource";
    return result;
  };
  const owner = { kind: "provider_resource" as const, source: "fake", connection_id: "connection-trusted", resource_id: "resource-trusted" };
  database.setProviderExecutionPolicy(owner, "fake.changed", { background_job: true, workspace: "scratch" });
  const processor = new ExternalIngressProcessor(new ExternalIngressRegistry([registered]));
  const result = await processor.process(externalEventSource("fake"), registered, {
    body: fakeBody(), headers: [], method: "POST", requestTarget: "/v1/ingress/fake", receivedAt: new Date().toISOString(),
  }, (envelope, context) => database.enqueueProvider(envelope, context.owner, new Date(), context));
  assert.deepEqual(database.getEventBinding(result.receipt.eventId)?.owner, owner);
  assert.equal(database.getEventBinding(result.receipt.eventId)?.execution.background_job, true);
  assert.equal(database.get(result.receipt.eventId)?.reply_target_json, null);
   database.close();
});

test("managed bindingとprovider ownerのresource不一致を認証失敗にする",async()=>{
  const definition=registration();
  const registered={...definition,async authenticate(raw:RawIngressRequest){
    const verified=await definition.authenticate(raw);
    return {...verified,resourceId:"resource-2",connection:{account:"tenant1",revision:1,credentialRevision:1,resource:"resource-1",generation:1}};
  }};
  const processor=new ExternalIngressProcessor(new ExternalIngressRegistry([registered]));
  await assert.rejects(processor.process(externalEventSource("fake"),registered,{
    body:fakeBody(),headers:[],method:"POST",requestTarget:"/v1/ingress/fake",receivedAt:new Date().toISOString(),
  },()=>{throw new Error("must not persist");}),/authentication/i);
});

test("queue receipts expose coalescing and reject overload before provider ACK",async()=>{
  const {root,config}=await tempConfig();roots.push(root);
  const database=new DispatcherDatabase(config.databasePath,{defaults:{depth:1,bytes:1_048_576,rate:100,burst:100,coalescing:true}});
  let ackCount=0;const receipts:any[]=[];
  const definition=registration();
  const registry=new ExternalIngressRegistry([{
    ...definition,
    queueSignal(){return {resourceKey:"resource",signalKey:"changed",requiresFetch:true};},
    buildAcknowledgement(receipt){ackCount++;receipts.push(receipt);return definition.buildAcknowledgement(receipt);},
  }]);
  const api=new DispatcherApi(database,{isRunning:()=>true,wake(){}},jobs,config,logger,undefined,undefined,undefined,registry);
  await api.start();
  try {
    const first=fakeBody();assert.ok((await request(config.socketPath,"fake",first,signedHeaders(first))).status<300);
    const second=fakeBody({providerEventId:"delivery-2"});
    assert.ok((await request(config.socketPath,"fake",second,signedHeaders(second))).status<300);
    assert.equal(receipts[1].admission,"coalesced");assert.equal(receipts[1].ackAllowed,true);
    const mismatch=fakeBody({providerEventId:"delivery-3",payload:{value:"different"}});
    const rejected=await request(config.socketPath,"fake",mismatch,signedHeaders(mismatch));
    assert.equal(rejected.status,429);assert.equal(rejected.body.ack_allowed,false);
    assert.equal((rejected.body.error as any).code,"queue_depth");assert.equal(ackCount,2);
    assert.equal((database.queueHealth().metrics as {code:string;count:number}[]).find(metric=>metric.code==="queue_depth")?.count,1);
    const unauth=fakeBody({providerEventId:"bad"});
    assert.equal((await request(config.socketPath,"fake",unauth,{...signedHeaders(unauth),"X-Fake-Signature":"wrong"})).status,401);
    assert.equal(database.list().length,1);assert.equal(database.queueDispatchMetadata(database.list()[0]!.event_id).requires_fetch,true);
  } finally {await api.stop();database.close();}
});

test("normalizer mutation cannot replace the authenticated queue connection",async()=>{
  const {root,config}=await tempConfig();roots.push(root);
  const database=new DispatcherDatabase(config.databasePath);const definition=registration();
  const registry=new ExternalIngressRegistry([{...definition,normalize(raw,verified){
    (verified as {connectionId:string}).connectionId="forged";
    return definition.normalize(raw,verified);
  }}]);
  const api=new DispatcherApi(database,{isRunning:()=>true,wake(){}},jobs,config,logger,undefined,undefined,undefined,registry);
  await api.start();
  try {
    const body=fakeBody();assert.ok((await request(config.socketPath,"fake",body,signedHeaders(body))).status<300);
    assert.ok(database.getByExternalId("fake",scopedExternalEventId(externalEventSource("fake"),"connection-a","delivery-1")));
    assert.equal(database.getByExternalId("fake",scopedExternalEventId(externalEventSource("fake"),"forged","delivery-1")),undefined);
  } finally {await api.stop();database.close();}
});
