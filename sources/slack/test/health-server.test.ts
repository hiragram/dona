import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { SlackHealthServer } from "../src/health-server.js";
import type { SlackLogger } from "../src/logger.js";
import { SlackApiError } from "../src/slack-api.js";
import {
  UpdateNotificationPermanentError,
  type UpdateNotificationPort,
} from "../src/update-notification.js";

const roots: string[] = [];
const logger: SlackLogger = { debug() {}, info() {}, warn() {}, error() {} };
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function request(
  socketPath: string,
  route: string,
  method = "GET",
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      path: route,
      method,
      headers: {
        ...extraHeaders,
        ...(encoded ? { "content-type": "application/json", "content-length": encoded.length } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      }));
    });
    req.once("error", reject);
    req.end(encoded);
  });
}

describe("SlackHealthServer", () => {
  test("separates liveness from Socket Mode and Dispatcher readiness", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-slack-health-"));
    roots.push(root);
    const socketPath = path.join(root, "run", "slack.sock");
    let socketReady = false;
    let dispatcherReady = false;
    const server = new SlackHealthServer(
      socketPath,
      {
        isSocketReady: () => socketReady,
        isStopping: () => false,
        connectionStates: () => ({ company: socketReady ? "connected" : "disconnected" }),
        async quiesce() {},
        drainStatus: () => ({ quiescing: false, drained: false, in_flight: 0, unsafe_states: [] }),
      },
      { healthReady: async () => dispatcherReady },
      logger,
    );
    await server.start();
    assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o600);
    assert.equal((await request(socketPath, "/health/live")).status, 200);
    assert.equal((await request(socketPath, "/health/ready")).status, 503);
    socketReady = true;
    dispatcherReady = true;
    assert.equal((await request(socketPath, "/health/ready")).status, 200);
    const version = await request(socketPath, "/health/version");
    assert.equal(version.status, 200);
    assert.equal(version.body.build_sha, "development");
    assert.equal(version.body.app_schema, 3);
    assert.equal(version.body.app_schema_read_min, 2);
    assert.equal(version.body.app_schema_read_max, 3);
    assert.equal(version.body.app_schema_write, 3);
    assert.equal(version.body.update_notification_protocol, undefined);
    await server.stop();
  });

  test("quiesces ingress through a typed request and reports bounded drain state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-slack-health-"));
    roots.push(root);
    const socketPath = path.join(root, "run", "slack.sock");
    let quiescing = false;
    const server = new SlackHealthServer(
      socketPath,
      {
        isSocketReady: () => !quiescing,
        isStopping: () => quiescing,
        connectionStates: () => ({ company: quiescing ? "disconnected" : "connected" }),
        async quiesce() { quiescing = true; },
        drainStatus: () => ({ quiescing, drained: quiescing, in_flight: 0, unsafe_states: [] }),
      },
      { healthReady: async () => true },
      logger,
      "2".repeat(40),
    );
    await server.start();
    const response = await request(socketPath, "/v1/admin/quiesce", "POST", {
      schema_version: 1,
      protocol: 1,
      operation_id: "upd_01m1es03xy5cf8d9pm5cwx4srv",
      target_sha: "2".repeat(40),
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.drained, true);
    assert.equal((await request(socketPath, "/health/version")).status, 503);
    await server.stop();
  });

  test("accepts only authenticated, typed internal update notifications", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-slack-health-"));
    roots.push(root);
    const socketPath = path.join(root, "run", "slack.sock");
    const tokenPath = path.join(root, "control", "dispatcher.token");
    const token = "a".repeat(64);
    await fs.mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(tokenPath, token, { mode: 0o600 });
    let deliveryCount = 0;
    const reporter: UpdateNotificationPort = {
      async deliver(input) {
        deliveryCount += 1;
        return {
          notification_id: input.notification_id,
          workspace_id: input.workspace_id,
          channel_id: input.channel_id,
          thread_ts: input.thread_ts,
          message_ts: "1788390700.384279",
          post_status: "created",
          session_status: input.desired_session_status,
        };
      },
    };
    const server = new SlackHealthServer(
      socketPath,
      {
        isSocketReady: () => true,
        isStopping: () => false,
        connectionStates: () => ({ company: "connected" }),
        async quiesce() {},
        drainStatus: () => ({ quiescing: false, drained: false, in_flight: 0, unsafe_states: [] }),
      },
      { healthReady: async () => true },
      logger,
      "2".repeat(40),
      reporter,
      tokenPath,
    );
    await server.start();
    try {
      assert.equal((await request(socketPath, "/health/version")).body.update_notification_protocol, 1);
      await fs.unlink(tokenPath);
      assert.equal((await request(socketPath, "/health/version")).body.update_notification_protocol, undefined);
      await fs.writeFile(tokenPath, token, { mode: 0o600 });
      assert.equal((await request(socketPath, "/health/version")).body.update_notification_protocol, 1);
      await fs.chmod(tokenPath, 0o644);
      assert.equal((await request(socketPath, "/health/version")).body.update_notification_protocol, undefined);
      const input = {
        schema_version: 1,
        notification_id: "update:upd_01m1es03xy5cf8d9pm5cwx4srv:terminal:2",
        request_id: "upd_01m1es03xy5cf8d9pm5cwx4srv",
        terminal_fence: 2,
        workspace_id: "T123",
        channel_id: "C123",
        thread_ts: "1756722030.123456",
        text: "確認の結果、セルフアップデートは完了していました。",
        desired_session_status: "active",
      };
      assert.equal((await request(
        socketPath,
        "/v1/internal/update-notifications",
        "POST",
        input,
        { "x-dona-update-token": token },
      )).status, 403);
      assert.equal(deliveryCount, 0);
      await fs.chmod(tokenPath, 0o600);
      assert.equal((await request(socketPath, "/v1/internal/update-notifications", "POST", input)).status, 403);
      assert.equal(deliveryCount, 0);
      const accepted = await request(
        socketPath,
        "/v1/internal/update-notifications",
        "POST",
        input,
        { "x-dona-update-token": token },
      );
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.message_ts, "1788390700.384279");
      assert.equal(deliveryCount, 1);
      const invalid = await request(
        socketPath,
        "/v1/internal/update-notifications",
        "POST",
        { ...input, terminal_fence: 3 },
        { "x-dona-update-token": token },
      );
      assert.equal(invalid.status, 400);
      assert.equal(deliveryCount, 1);
    } finally {
      await server.stop();
    }
  });

  test("does not expose or execute the reporter without a private token path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-slack-health-"));
    roots.push(root);
    const socketPath = path.join(root, "run", "slack.sock");
    const tokenPath = path.join(root, "control", "dispatcher.token");
    const token = "a".repeat(64);
    await fs.mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(tokenPath, token, { mode: 0o600 });
    let deliveryCount = 0;
    const server = new SlackHealthServer(
      socketPath,
      {
        isSocketReady: () => true,
        isStopping: () => false,
        connectionStates: () => ({ company: "connected" }),
        async quiesce() {},
        drainStatus: () => ({ quiescing: false, drained: false, in_flight: 0, unsafe_states: [] }),
      },
      { healthReady: async () => true },
      logger,
      "2".repeat(40),
      {
        async deliver(input) {
          deliveryCount += 1;
          return {
            notification_id: input.notification_id,
            workspace_id: input.workspace_id,
            channel_id: input.channel_id,
            thread_ts: input.thread_ts,
            message_ts: "1788390700.384279",
            post_status: "created",
            session_status: input.desired_session_status,
          };
        },
      },
      undefined,
    );
    await server.start();
    try {
      assert.equal((await request(socketPath, "/health/version")).body.update_notification_protocol, undefined);
      const response = await request(socketPath, "/v1/internal/update-notifications", "POST", {
        schema_version: 1,
        notification_id: "update:upd_01m1es03xy5cf8d9pm5cwx4srv:terminal:2",
        request_id: "upd_01m1es03xy5cf8d9pm5cwx4srv",
        terminal_fence: 2,
        workspace_id: "T123",
        channel_id: "C123",
        thread_ts: "1756722030.123456",
        text: "確認の結果、セルフアップデートは完了していました。",
        desired_session_status: "active",
      }, { "x-dona-update-token": token });
      assert.equal(response.status, 503);
      assert.equal(deliveryCount, 0);
    } finally {
      await server.stop();
    }
  });

  test("returns conflict for a permanent notification delivery failure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-slack-health-"));
    roots.push(root);
    const socketPath = path.join(root, "run", "slack.sock");
    const tokenPath = path.join(root, "control", "dispatcher.token");
    const token = "a".repeat(64);
    await fs.mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(tokenPath, token, { mode: 0o600 });
    const reporter: UpdateNotificationPort = {
      async deliver(input) {
        throw new UpdateNotificationPermanentError(
          "identity_block_not_persisted",
          "Slack posted the notification without the exact identity block",
          {
            notification_id: input.notification_id,
            workspace_id: input.workspace_id,
            channel_id: input.channel_id,
            thread_ts: input.thread_ts,
            message_ts: "1788390700.384279",
            post_status: "created",
            session_status: input.desired_session_status,
          },
        );
      },
    };
    const server = new SlackHealthServer(
      socketPath,
      {
        isSocketReady: () => true,
        isStopping: () => false,
        connectionStates: () => ({ company: "connected" }),
        async quiesce() {},
        drainStatus: () => ({ quiescing: false, drained: false, in_flight: 0, unsafe_states: [] }),
      },
      { healthReady: async () => true },
      logger,
      "2".repeat(40),
      reporter,
      tokenPath,
    );
    await server.start();
    try {
      const response = await request(socketPath, "/v1/internal/update-notifications", "POST", {
        schema_version: 1,
        notification_id: "update:upd_01m1es03xy5cf8d9pm5cwx4srv:terminal:2",
        request_id: "upd_01m1es03xy5cf8d9pm5cwx4srv",
        terminal_fence: 2,
        workspace_id: "T999",
        channel_id: "C123",
        thread_ts: "1756722030.123456",
        text: "確認の結果、セルフアップデートは完了していました。",
        desired_session_status: "active",
      }, { "x-dona-update-token": token });
      assert.equal(response.status, 409);
      assert.deepEqual(response.body.error, {
        code: "identity_block_not_persisted",
        message: "Slack posted the notification without the exact identity block",
      });
      assert.deepEqual(response.body.receipt, {
        notification_id: "update:upd_01m1es03xy5cf8d9pm5cwx4srv:terminal:2",
        workspace_id: "T999",
        channel_id: "C123",
        thread_ts: "1756722030.123456",
        message_ts: "1788390700.384279",
        post_status: "created",
        session_status: "active",
      });
    } finally {
      await server.stop();
    }
  });

  test("returns conflict for a permanent progress configuration failure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-slack-health-progress-")); roots.push(root);
    const socketPath = path.join(root, "run", "slack.sock");
    const tokenPath = path.join(root, "control", "dispatcher.token"); const token = "a".repeat(64);
    await fs.mkdir(path.dirname(tokenPath), { recursive:true, mode:0o700 }); await fs.writeFile(tokenPath, token, { mode:0o600 });
    const server = new SlackHealthServer(socketPath, {
      isSocketReady:()=>true, isStopping:()=>false, connectionStates:()=>({ company:"connected" }),
      async quiesce(){}, drainStatus:()=>({ quiescing:false, drained:false, in_flight:0, unsafe_states:[] }),
    }, { healthReady:async()=>true }, logger, "2".repeat(40), undefined, tokenPath, {
      async deliver() { throw Object.assign(new Error("unknown workspace"), { definitelyUnsent:true, progressPermanent:true }); },
    } as never);
    await server.start();
    try {
      const response = await request(socketPath, "/v1/internal/job-progress", "POST", {
        schema_version:1, progress_id:"job_abc:1", delivery_token:"b".repeat(64),
      }, { "x-dona-update-token":token });
      assert.equal(response.status, 409);
      assert.deepEqual(response.body.error, { code:"progress_not_sent" });
    } finally { await server.stop(); }
  });

  test("treats not_in_channel progress rejection as permanent", async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-slack-progress-membership-")); roots.push(root); const socketPath=path.join(root,"run","slack.sock"); const tokenPath=path.join(root,"token"); const token="a".repeat(64); await fs.writeFile(tokenPath,token,{mode:0o600});
    const server=new SlackHealthServer(socketPath,{isSocketReady:()=>true,isStopping:()=>false,connectionStates:()=>({company:"connected"}),async quiesce(){},drainStatus:()=>({quiescing:false,drained:false,in_flight:0,unsafe_states:[]})},{healthReady:async()=>true},logger,"2".repeat(40),undefined,tokenPath,{async deliver(){throw new SlackApiError("not_in_channel","not in channel");}} as never);
    await server.start(); try {
      const response=await request(socketPath,"/v1/internal/job-progress","POST",{schema_version:1,progress_id:"job_abc:1",delivery_token:"b".repeat(64)},{"x-dona-update-token":token});
      assert.equal(response.status,409); assert.deepEqual(response.body.error,{code:"not_in_channel"});
    } finally {await server.stop();}
  });

  test("progress drain waits for an accepted Adapter delivery", async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-slack-progress-drain-")); roots.push(root); const socketPath=path.join(root,"run","slack.sock"); const tokenPath=path.join(root,"token"); const token="a".repeat(64); await fs.writeFile(tokenPath,token,{mode:0o600});
    let release!:()=>void; const gate=new Promise<void>((resolve)=>{release=resolve;});
    const server=new SlackHealthServer(socketPath,{isSocketReady:()=>true,isStopping:()=>false,connectionStates:()=>({company:"connected"}),async quiesce(){},drainStatus:()=>({quiescing:false,drained:false,in_flight:0,unsafe_states:[]})},{healthReady:async()=>true},logger,"2".repeat(40),undefined,tokenPath,{async deliver(input:{progress_id:string}){await gate;return {progress_id:input.progress_id};}} as never);
    await server.start(); try {
      const delivery=request(socketPath,"/v1/internal/job-progress","POST",{schema_version:1,progress_id:"job_abc:1",delivery_token:"b".repeat(64)},{"x-dona-update-token":token});
      await new Promise((resolve)=>setTimeout(resolve,10)); let drained=false; const drain=request(socketPath,"/v1/internal/job-progress/drain","POST",undefined,{"x-dona-update-token":token}).then((value)=>{drained=true;return value;});
      await new Promise((resolve)=>setTimeout(resolve,10)); assert.equal(drained,false); release(); assert.equal((await delivery).status,200); assert.equal((await drain).status,200);
    } finally {await server.stop();}
  });

  test("progress drain waits for a request still reading its body", async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-slack-progress-admission-")); roots.push(root); const socketPath=path.join(root,"run","slack.sock"); const tokenPath=path.join(root,"token"); const token="a".repeat(64); await fs.writeFile(tokenPath,token,{mode:0o600});
    const server=new SlackHealthServer(socketPath,{isSocketReady:()=>true,isStopping:()=>false,connectionStates:()=>({company:"connected"}),async quiesce(){},drainStatus:()=>({quiescing:false,drained:false,in_flight:0,unsafe_states:[]})},{healthReady:async()=>true},logger,"2".repeat(40),undefined,tokenPath,{async deliver(input:{progress_id:string}){return {progress_id:input.progress_id};}} as never); await server.start();
    try {
      const body=Buffer.from(JSON.stringify({schema_version:1,progress_id:"job_abc:1",delivery_token:"b".repeat(64)}));
      let resolveResponse!:(value:{status:number})=>void; const responsePromise=new Promise<{status:number}>((resolve)=>{resolveResponse=resolve;});
      const slow=http.request({socketPath,path:"/v1/internal/job-progress",method:"POST",headers:{"content-type":"application/json","content-length":String(body.length),"x-dona-update-token":token}},(response)=>{response.resume();response.once("end",()=>resolveResponse({status:response.statusCode??0}));});
      slow.write(body.subarray(0,10)); await new Promise((resolve)=>setTimeout(resolve,10)); let drained=false;
      const drain=request(socketPath,"/v1/internal/job-progress/drain","POST",undefined,{"x-dona-update-token":token}).then((value)=>{drained=true;return value;});
      await new Promise((resolve)=>setTimeout(resolve,10)); assert.equal(drained,false); slow.end(body.subarray(10)); assert.equal((await responsePromise).status,200); assert.equal((await drain).status,200);
    } finally {await server.stop();}
  });
});
