import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { DispatcherApi, scheduleAccessConfirmationTimeout } from "../src/api.js";
import { DispatcherDatabase } from "../src/database.js";
import type { Logger } from "../src/logger.js";
import { principalProofKeyId } from "../src/principal-proof.js";
import { UpdaterClientError } from "../src/updater-client.js";
import { canonicalJobPayloadSha256, parseCreateJobRequest, stableStringify } from "../src/validation.js";
import { eventEnvelope, tempConfig, testInternalToken, waitFor } from "./helpers.js";
import { JobSupervisor } from "../src/job-supervisor.js";
import type { JobAgentRuntime } from "../src/job-runtime.js";

const roots: string[] = [];
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const jobs = {
  isRunning: () => true,
  wake() {},
  async steer() { throw new Error("not used"); },
  async cancel() { throw new Error("not used"); },
};
const proofIssued = new Date(Math.floor(Date.now() / 1_000) * 1_000);
let proofSequence=0;
function ingressHeaders(body: unknown): Record<string, string> {
  if (!body || typeof body !== "object" || (body as {source?:unknown}).source !== "slack") return {};
  const envelope = body as {external_event_id:string;subject:Record<string,unknown>;trace?:Record<string,unknown>};
  const proof = stableStringify({
    attempt: envelope.trace?.ingress_attempt,
    event_id: envelope.external_event_id,
    expires_at: new Date(proofIssued.getTime() + 120_000).toISOString().replace(/\.000Z$/, "Z"),
    issued_at: proofIssued.toISOString().replace(/\.000Z$/, "Z"),
    key_id: principalProofKeyId(testInternalToken),
    nonce: `test-${createHash("sha256").update(`${envelope.external_event_id}:${String(envelope.trace?.ingress_attempt)}:${proofSequence++}`).digest("hex").slice(0, 24)}`,
    principal_id: envelope.subject.actor_id,
    principal_kind: "human",
    tenant_id: envelope.subject.workspace_id,
    version: 1,
    workspace_id: envelope.subject.workspace_id,
  });
  return {
    "x-dona-slack-principal-proof": Buffer.from(proof).toString("base64url"),
    "x-dona-slack-principal-signature": createHmac("sha256", testInternalToken).update(proof).digest("base64url"),
  };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function request(
  socketPath: string,
  method: string,
  route: string,
  body?: unknown,
  contentType = "application/json",
  extraHeaders: Record<string, string> = {},
) {
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method,
        path: route,
        headers: { ...ingressHeaders(body), ...extraHeaders, ...(encoded ? { "content-type": contentType, "content-length": String(encoded.length) } : {}) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
          }),
        );
      },
    );
    req.once("error", reject);
    req.end(encoded);
  });
}

function requestAndDropResponseBody(socketPath: string, route: string, body: unknown): Promise<void> {
  const encoded = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method: "POST",
        path: route,
        headers: { ...ingressHeaders(body), "content-type": "application/json", "content-length": String(encoded.length) },
      },
      (response) => {
        response.once("error", () => {});
        response.destroy();
        resolve();
      },
    );
    req.once("error", reject);
    req.end(encoded);
  });
}

describe("DispatcherApi", () => {
  test("live session opt-inをthreadへbindしdurable receiptを再読する",async()=>{
    const {root,config}=await tempConfig();roots.push(root);const database=new DispatcherDatabase(config.databasePath);
    const source=database.enqueue(eventEnvelope("Ev-live-api")).row;
    const other=database.enqueue({...eventEnvelope("Ev-live-api-other"),subject:{...eventEnvelope("x").subject,thread_ts:"1756722030.999999"},reply_target:{...eventEnvelope("x").reply_target,thread_ts:"1756722030.999999"}}).row;
    const job=database.createJob({source_event_id:source.event_id,objective:"PRIVATE",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
    database.beginJobPreparation(job.job_id);database.setJobRuntime(job.job_id,"w-private","p-private","s-private");database.beginJobDispatch(job.job_id);
    const calls:string[]=[];let transitioned=false;const runtime:JobAgentRuntime={async prepare(){throw new Error("unused");},async get(agent){calls.push("get");if(!transitioned){database.markJobNeedsReview(job.job_id,"prompt_acceptance_unknown","unknown");transitioned=true;}return {ok:true,stdout:"RAW PRIVATE",stderr:"",exitCode:0,timedOut:false,aborted:false,agentStatus:"working",agentIdentity:JSON.stringify(["w-private","p-private",agent,"s-private"]),stateChangeSeq:5};},async prompt(){calls.push("prompt");throw new Error("forbidden");},async wait(){throw new Error("forbidden");},async cancel(){throw new Error("forbidden");}};
    const supervisor=new JobSupervisor(database,runtime,config,logger,()=>{});const api=new DispatcherApi(database,{isRunning:()=>true,wake(){}},supervisor,config,logger);await api.start();try{
    const durable=await request(config.socketPath,"GET",`/v1/jobs/${job.job_id}?source_event_id=${source.event_id}`);
    assert.equal(durable.status,200);assert.equal("live_session" in durable.body,false);assert.deepEqual(calls,[]);
    const denied=await request(config.socketPath,"GET",`/v1/jobs/${job.job_id}?source_event_id=${other.event_id}&include_live_session=true`);
    assert.equal(denied.status,403);assert.deepEqual(calls,[]);
    const live=await request(config.socketPath,"GET",`/v1/jobs/${job.job_id}?source_event_id=${source.event_id}&include_live_session=true`);
    assert.equal(live.status,200);assert.equal((live.body.live_session as {identity_match:boolean}).identity_match,true);assert.deepEqual(calls,["get"]);
    assert.equal((live.body.job as {status:string}).status,"needs_review");assert.equal((live.body.receipt as {durable_status_after:string}).durable_status_after,"needs_review");
    assert.doesNotMatch(JSON.stringify(live.body),/w-private|p-private|s-private|RAW PRIVATE/);
    const receiptId=(live.body.receipt as {receipt_id:string}).receipt_id;
    const reread=await request(config.socketPath,"GET",`/v1/jobs/${job.job_id}/live-session-receipts/${receiptId}?source_event_id=${source.event_id}`);
    assert.equal(reread.status,200);assert.deepEqual(reread.body.live_session,live.body.live_session);assert.deepEqual(calls,["get"]);
    assert.equal((await request(config.socketPath,"GET",`/v1/jobs/${job.job_id}?source_event_id=${source.event_id}&include_live_session=yes`)).status,400);
    const original=database.appendLiveSessionReceipt.bind(database);database.appendLiveSessionReceipt=()=>{throw new Error("audit unavailable");};
    const failed=await request(config.socketPath,"GET",`/v1/jobs/${job.job_id}?source_event_id=${source.event_id}&include_live_session=true`);
    assert.equal(failed.status,503);assert.equal((failed.body.error as {code:string}).code,"live_session_audit_unavailable");
    assert.doesNotMatch(JSON.stringify(failed.body),/audit unavailable/);database.appendLiveSessionReceipt=original;
    }finally{await api.stop();database.close();}
  });
  test("bounds live access confirmation by the signed receipt lifetime", () => {
    const issuedAt="2026-09-08T00:00:00.000Z",issued=Date.parse(issuedAt);
    assert.equal(scheduleAccessConfirmationTimeout(issuedAt,issued),119_000);
    assert.equal(scheduleAccessConfirmationTimeout(issuedAt,issued+118_500),500);
    assert.throws(()=>scheduleAccessConfirmationTimeout(issuedAt,issued+119_000),/receipt_expired/);
  });
  test("persists before returning 202, rejects proof replay, and accepts a fresh redelivery proof", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    let wakeCount = 0;
    const api = new DispatcherApi(
      database,
      { isRunning: () => true, wake: () => void (wakeCount += 1) },
      jobs,
      config,
      logger,
    );
    await api.start();
    const envelope=eventEnvelope("Ev-1"),replayedProof=ingressHeaders(envelope);
    const first = await request(config.socketPath, "POST", "/v1/events", envelope, "application/json", replayedProof);
    assert.equal(first.status, 202);
    assert.equal(database.list().length, 1);
    assert.equal(database.getVerifiedPrincipalBinding(String(first.body.event_id))?.principal_id, "U_TEST");
    const replay=await request(config.socketPath,"POST","/v1/events",envelope,"application/json",replayedProof);
    assert.equal(replay.status,409);
    const duplicate = await request(config.socketPath, "POST", "/v1/events", envelope);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.event_id, first.body.event_id);
    assert.equal(database.list().length, 1);
    assert.equal(wakeCount, 2);
    assert.equal((await fs.stat(config.socketPath)).mode & 0o777, 0o600);
    assert.equal((await request(config.socketPath, "GET", "/health/ready")).status, 200);
    await api.stop();
    database.close();
  });

  test("readyはprocess liveとscheduler loopを分離しredacted metricsを公開する", async () => {
    const { root, config } = await tempConfig(); roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const api = new DispatcherApi(database,{isRunning:()=>true,wake(){}},jobs,config,logger,undefined,undefined,undefined,undefined,
      ()=>new Date("2026-09-11T00:00:00Z"),()=>{},
      {operationalState:()=>({running:false,last_purge_at:null})});
    await api.start();
    assert.equal((await request(config.socketPath,"GET","/health/live")).status,200);
    const ready=await request(config.socketPath,"GET","/health/ready");
    assert.equal(ready.status,503);
    const metrics=await request(config.socketPath,"GET","/metrics/scheduler");
    assert.equal(metrics.status,200);
    assert.deepEqual(Object.keys(metrics.body),["schema_version","scheduler"]);
    database.assertReadableWritable=()=>{throw new Error("database unavailable");};
    const unavailable=await request(config.socketPath,"GET","/health/ready");
    assert.equal(unavailable.status,503);
    assert.equal((unavailable.body.scheduler as {error_code:string}).error_code,"scheduler_storage_unavailable");
    assert.equal((await request(config.socketPath,"GET","/health/version")).status,503);
    await api.stop(); database.close();
  });

  test("rejects invalid media types and oversized bodies", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    config.requestMaxBytes = 20;
    const database = new DispatcherDatabase(config.databasePath);
    const api = new DispatcherApi(database, { isRunning: () => true, wake() {} }, jobs, config, logger);
    await api.start();
    assert.equal(
      (await request(config.socketPath, "POST", "/v1/events", eventEnvelope("Ev-1"), "text/plain")).status,
      415,
    );
    assert.equal((await request(config.socketPath, "POST", "/v1/events", eventEnvelope("Ev-1"))).status, 413);
    await api.stop();
    database.close();
  });

  test("rejects unauthenticated Slack、forged internal source、conflicting duplicate payload", async () => {
    const { root, config } = await tempConfig(); roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const api = new DispatcherApi(database, { isRunning: () => true, wake() {} }, jobs, config, logger);
    await api.start();
    const unauthenticated = eventEnvelope("Ev-unauthenticated");
    const unauthenticatedStatus = (await request(config.socketPath, "POST", "/v1/events", unauthenticated, "application/json", {
      "x-dona-slack-principal-proof": "",
      "x-dona-slack-principal-signature": "",
    })).status;
    const unauthenticatedRow = database.getByExternalId("slack", "Ev-unauthenticated");

    const forged = { ...eventEnvelope("Ev-forged-completion"), source: "dona_job" };
    const forgedStatus = (await request(config.socketPath, "POST", "/v1/events", forged)).status;
    const forgedRow = database.getByExternalId("dona_job", "Ev-forged-completion");

    const duplicate = eventEnvelope("Ev-proof-conflict");
    const firstStatus = (await request(config.socketPath, "POST", "/v1/events", duplicate)).status;
    const retry = structuredClone(duplicate); retry.trace = { ingress_attempt:2 };
    const retryStatus = (await request(config.socketPath,"POST","/v1/events",retry)).status;
    const changed = structuredClone(retry); changed.payload.text = "tampered";
    const conflict = await request(config.socketPath, "POST", "/v1/events", changed);
    await api.stop(); database.close();
    assert.equal(unauthenticatedStatus,403); assert.equal(unauthenticatedRow,undefined);
    assert.equal(forgedStatus,403); assert.equal(forgedRow,undefined);
    assert.equal(firstStatus,202); assert.equal(retryStatus,200);
    assert.equal(conflict.status, 409);
    assert.equal((conflict.body.error as {code:string}).code, "principal_binding_conflict");
  });

  test("fallback受信時刻だけが変わるSlack再配送を同一eventとして受理する",async()=>{
    const {root,config}=await tempConfig();roots.push(root);
    const database=new DispatcherDatabase(config.databasePath),api=new DispatcherApi(database,{isRunning:()=>true,wake(){}},jobs,config,logger);
    await api.start();
    const first=eventEnvelope("Ev-received-at-retry");first.occurred_at="2026-09-21T00:00:00.000Z";
    first.trace={ingress_attempt:1,occurred_at_source:"received_at"};
    const second=structuredClone(first);second.occurred_at="2026-09-21T00:00:05.000Z";second.trace={ingress_attempt:2,occurred_at_source:"received_at"};
    const firstStatus=(await request(config.socketPath,"POST","/v1/events",first)).status;
    const retryStatus=(await request(config.socketPath,"POST","/v1/events",second)).status;
    await api.stop();database.close();assert.equal(firstStatus,202);assert.equal(retryStatus,200);
  });

  test("creates and reads a durable background job over UDS", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    let jobWakeCount = 0;
    const jobController = { ...jobs, wake: () => void (jobWakeCount += 1) };
    const api = new DispatcherApi(
      database,
      { isRunning: () => true, wake() {} },
      jobController,
      config,
      logger,
    );
    await api.start();
    const accepted = await request(config.socketPath, "POST", "/v1/events", eventEnvelope("Ev-job-api"));
    const created = await request(config.socketPath, "POST", "/v1/jobs", {
      source_event_id: accepted.body.event_id,
      job_key:"primary",
      objective: "リポジトリを調査する",
      workspace: { kind: "github", repository: "owner/repo" },
    });
    assert.equal(created.status, 202);
    assert.equal(created.body.outcome, "created");
    assert.equal(created.body.duplicate, false);
    const job = created.body.job as Record<string, unknown>;
    assert.match(String(job.job_id), /^job_/);
    assert.equal(job.job_key, "primary");
    assert.equal(jobWakeCount, 1);
    const shown = await request(config.socketPath, "GET", `/v1/jobs/${job.job_id}?source_event_id=${accepted.body.event_id}`);
    assert.equal(shown.status, 200);
    assert.equal((shown.body.job as Record<string, unknown>).source_event_id, accepted.body.event_id);
    assert.equal((await request(config.socketPath,"GET",`/v1/jobs/${job.job_id}`)).status,400);
    const otherEnvelope=eventEnvelope("Ev-job-api-other");
    otherEnvelope.reply_target!.thread_ts="1756722031.000001";
    otherEnvelope.subject.thread_ts="1756722031.000001";
    const other=await request(config.socketPath,"POST","/v1/events",otherEnvelope);
    assert.equal((await request(config.socketPath,"GET",`/v1/jobs/${job.job_id}?source_event_id=${other.body.event_id}`)).status,403);
    const siblingRequest={source_event_id:accepted.body.event_id,job_key:"sibling",objective:"追加調査",workspace:{kind:"scratch"}};
    const sibling=await request(config.socketPath,"POST","/v1/jobs",siblingRequest);
    assert.equal(sibling.status,202);
    assert.equal((await request(config.socketPath,"POST","/v1/jobs",siblingRequest)).status,200);
    assert.equal((await request(config.socketPath,"POST","/v1/jobs",{...siblingRequest,objective:"差し替え"})).status,409);
    const ownerList=await request(config.socketPath,"GET",`/v1/jobs?source_event_id=${accepted.body.event_id}`);
    assert.equal(ownerList.status,200);
    assert.equal((ownerList.body.jobs as unknown[]).length,2);
    assert.equal("objective" in (ownerList.body.jobs as Array<Record<string,unknown>>)[0]!,false);
    assert.equal("workspace_json" in (ownerList.body.jobs as Array<Record<string,unknown>>)[0]!,false);
    const listed = await request(
      config.socketPath,
      "GET",
      "/v1/jobs?workspace_id=T_TEST&channel_id=C_TEST&thread_ts=1756722030.123456",
    );
    assert.equal(listed.status, 200);
    assert.equal((listed.body.jobs as unknown[]).length, 2);
    const reconciled = await request(
      config.socketPath,
      "GET",
      `/v1/events/${accepted.body.event_id}/jobs?job_key=primary`,
    );
    assert.equal(reconciled.status, 200);
    assert.equal((reconciled.body.jobs as Array<Record<string, unknown>>)[0]?.job_id, job.job_id);
    assert.equal(JSON.stringify(reconciled.body).includes(config.jobsWorkspaceRoot), false);
    assert.equal(JSON.stringify(reconciled.body).includes("リポジトリを調査する"), false);
    await api.stop();
    database.close();
  });

  test("converges concurrent keyed creates and exposes stable conflict and closed-group errors", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    let jobWakeCount = 0;
    const api = new DispatcherApi(
      database,
      { isRunning: () => true, wake() {} },
      { ...jobs, wake: () => void (jobWakeCount += 1) },
      config,
      logger,
    );
    await api.start();
    const accepted = await request(config.socketPath, "POST", "/v1/events", eventEnvelope("Ev-keyed-job-api"));
    const sourceEventId = String(accepted.body.event_id);
    const createBody = {
      source_event_id: sourceEventId,
      job_key: "report.daily",
      objective: "  prepare report  ",
      workspace: { kind: "scratch", ignored: true },
      ignored: true,
    };
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () => request(config.socketPath, "POST", "/v1/jobs", createBody)),
    );
    assert.deepEqual(attempts.map(({ status }) => status).sort(), [200, 200, 200, 200, 202]);
    assert.deepEqual(new Set(attempts.map(({ body }) => (body.job as Record<string, unknown>).job_id)).size, 1);
    assert.deepEqual(new Set(attempts.map(({ body }) => body.outcome)), new Set(["created", "reused"]));
    assert.equal(database.listEventJobs(sourceEventId).length, 1);
    assert.equal(jobWakeCount, 5);

    const conflict = await request(config.socketPath, "POST", "/v1/jobs", {
      ...createBody,
      objective: "different report",
    });
    assert.equal(conflict.status, 409);
    assert.equal((conflict.body.error as Record<string, unknown>).code, "job_idempotency_conflict");
    assert.equal(database.listEventJobs(sourceEventId).length, 1);

    const second = await request(config.socketPath, "POST", "/v1/jobs", {
      ...createBody,
      job_key: "report.secondary",
      objective: "prepare another report",
    });
    assert.equal(second.status, 202);
    assert.notEqual(
      (second.body.job as Record<string, unknown>).job_id,
      (attempts[0]!.body.job as Record<string, unknown>).job_id,
    );
    const allJobs = await request(config.socketPath, "GET", `/v1/events/${sourceEventId}/jobs`);
    assert.equal((allJobs.body.jobs as unknown[]).length, 2);
    const trimmedLookup = await request(
      config.socketPath,
      "GET",
      `/v1/events/${sourceEventId}/jobs?job_key=%20report.daily%20`,
    );
    assert.equal((trimmedLookup.body.jobs as Array<Record<string, unknown>>)[0]?.job_key, "report.daily");

    database.sealJobGroup(sourceEventId);
    const reusedAfterSeal = await request(config.socketPath, "POST", "/v1/jobs", {
      source_event_id: sourceEventId,
      job_key: "report.daily",
      objective: "prepare report",
      workspace: { kind: "scratch" },
    });
    assert.equal(reusedAfterSeal.status, 200);
    assert.equal(reusedAfterSeal.body.outcome, "reused");
    const closed = await request(config.socketPath, "POST", "/v1/jobs", {
      ...createBody,
      job_key: "report.after-seal",
    });
    assert.equal(closed.status, 409);
    assert.equal((closed.body.error as Record<string, unknown>).code, "job_group_closed");
    assert.equal((await request(config.socketPath, "POST", "/v1/jobs", {
      ...createBody,
      job_key: "legacy-default",
    })).status, 400);
    await api.stop();
    database.close();
  });

  test("returns a stable quota error and logs only bounded resource fields", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    config.jobsPerEventMax = 1;
    const database = new DispatcherDatabase(config.databasePath, {
      jobsPerEventMax: config.jobsPerEventMax,
      jobObjectiveTotalMaxBytes: config.jobObjectiveTotalMaxBytes,
    });
    const warnings: Array<Record<string, unknown>> = [];
    const quotaLogger: Logger = {
      debug() {}, info() {}, error() {},
      warn(message, fields) {
        if (message === "Job creation rejected by resource limit") warnings.push(fields ?? {});
      },
    };
    const api = new DispatcherApi(
      database,
      { isRunning: () => true, wake() {} },
      jobs,
      config,
      quotaLogger,
    );
    await api.start();
    const accepted = await request(config.socketPath, "POST", "/v1/events", eventEnvelope("Ev-job-quota-api"));
    const sourceEventId = String(accepted.body.event_id);
    const requestBody = {
      source_event_id: sourceEventId,
      job_key: "private.key",
      objective: "private objective",
      workspace: { kind: "scratch" },
      display: { short_name: "応答喪失の照合" },
    };
    assert.equal((await request(config.socketPath, "POST", "/v1/jobs", requestBody)).status, 202);
    assert.equal((await request(config.socketPath, "POST", "/v1/jobs", requestBody)).status, 200);
    const rejected = await request(config.socketPath, "POST", "/v1/jobs", {
      ...requestBody,
      job_key: "private.second",
    });

    assert.equal(rejected.status, 409);
    assert.equal((rejected.body.error as Record<string, unknown>).code, "job_group_limit_exceeded");
    assert.deepEqual(warnings, [{
      error_code: "job_group_limit_exceeded",
      resource: "jobs_per_event",
      current_value: 1,
      attempted_value: 2,
      limit_value: 1,
    }]);
    assert.equal(JSON.stringify(warnings).includes("private"), false);
    assert.equal(database.listEventJobs(sourceEventId).length, 1);
    await api.stop();
    database.close();
  });

  test("recovers a committed job after the create response body is lost without resending the write", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    let jobWakeCount = 0;
    const api = new DispatcherApi(
      database,
      { isRunning: () => true, wake() {} },
      { ...jobs, wake: () => void (jobWakeCount += 1) },
      config,
      logger,
    );
    await api.start();
    const accepted = await request(config.socketPath, "POST", "/v1/events", eventEnvelope("Ev-lost-job-response"));
    const sourceEventId = String(accepted.body.event_id);

    const createBody = {
      source_event_id: sourceEventId,
      job_key: "response.lost",
      objective: "recover through read-only lookup",
      workspace: { kind: "scratch" },
      display: { short_name: "応答喪失の表示" },
    };
    await requestAndDropResponseBody(config.socketPath, "/v1/jobs", createBody);
    const persisted = database.listEventJobs(sourceEventId, "response.lost");
    assert.equal(persisted.length, 1);
    assert.equal(jobWakeCount, 1);

    const reconciled = await request(
      config.socketPath,
      "GET",
      `/v1/events/${sourceEventId}/jobs?job_key=response.lost&canonical_payload_sha256=${
        canonicalJobPayloadSha256(parseCreateJobRequest(createBody))
      }`,
    );
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.reconciliation, "matched");
    assert.equal((reconciled.body.jobs as Array<Record<string, unknown>>)[0]?.job_id, persisted[0]?.job_id);
    assert.equal(
      canonicalJobPayloadSha256(parseCreateJobRequest(createBody)),
      canonicalJobPayloadSha256(parseCreateJobRequest({ ...createBody, display: undefined })),
    );
    const conflict = await request(
      config.socketPath,
      "GET",
      `/v1/events/${sourceEventId}/jobs?job_key=response.lost&canonical_payload_sha256=${"0".repeat(64)}`,
    );
    assert.equal(conflict.body.reconciliation, "conflict");
    const notFound = await request(
      config.socketPath,
      "GET",
      `/v1/events/${sourceEventId}/jobs?job_key=missing&canonical_payload_sha256=${"0".repeat(64)}`,
    );
    assert.equal(notFound.body.reconciliation, "not_found");
    assert.equal((await request(
      config.socketPath,
      "GET",
      `/v1/events/${sourceEventId}/jobs?canonical_payload_sha256=${"0".repeat(64)}`,
    )).status, 400);
    assert.equal(database.listEventJobs(sourceEventId).length, 1);
    assert.equal(jobWakeCount, 1);
    await api.stop();
    database.close();
  });

  test("separates external events from authenticated dona_update injection and deduplicates completion", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    await fs.mkdir(path.dirname(config.updateInternalTokenPath), { recursive: true, mode: 0o700 });
    const token = "a".repeat(64);
    await fs.writeFile(config.updateInternalTokenPath, token, { mode: 0o600 });
    const database = new DispatcherDatabase(config.databasePath);
    const api = new DispatcherApi(database, { isRunning: () => true, wake() {} }, jobs, config, logger);
    await api.start();
    const envelope = {
      schema_version: 1,
      source: "dona_update",
      external_event_id: "update:upd_01m1es03xy5cf8d9pm5cwx4srv:terminal:1",
      type: "update_succeeded",
      occurred_at: "2026-09-02T00:00:00.000Z",
      subject: { request_id: "upd_01m1es03xy5cf8d9pm5cwx4srv" },
      payload: {
        request_id: "upd_01m1es03xy5cf8d9pm5cwx4srv",
        update_status: "succeeded",
        current_sha: "1".repeat(40),
        target_sha: "2".repeat(40),
        previous_sha: null,
        plan_hash: "a".repeat(64),
        policy_version: "2026-09-02.1",
        rollback_compatible: true,
        active_sha: "2".repeat(40),
        error: null,
      },
      reply_target: { kind: "slack_thread", workspace_id: "T_TEST", channel_id: "C_TEST", thread_ts: "1756722030.123456" },
    };
    assert.equal((await request(config.socketPath, "POST", "/v1/events", envelope)).status, 400);
    assert.equal((await request(config.socketPath, "POST", "/v1/internal/update-events", envelope)).status, 403);
    const first = await request(config.socketPath, "POST", "/v1/internal/update-events", envelope, "application/json", { "x-dona-update-token": token });
    const duplicate = await request(config.socketPath, "POST", "/v1/internal/update-events", envelope, "application/json", { "x-dona-update-token": token });
    assert.equal(first.status, 202);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.event_id, first.body.event_id);
    const mismatched = structuredClone(envelope);
    mismatched.payload.active_sha = "3".repeat(40);
    assert.equal((await request(
      config.socketPath,
      "POST",
      "/v1/internal/update-events",
      mismatched,
      "application/json",
      { "x-dona-update-token": token },
    )).status, 409);
    const payloadSha256 = createHash("sha256").update(stableStringify(envelope)).digest("hex");
    const lookup = await request(
      config.socketPath,
      "GET",
      `/v1/internal/update-events/lookup?external_event_id=${encodeURIComponent(envelope.external_event_id)}&payload_sha256=${payloadSha256}`,
      undefined,
      "application/json",
      { "x-dona-update-token": token },
    );
    assert.equal(lookup.body.exists, true);
    assert.equal((await request(
      config.socketPath,
      "GET",
      `/v1/internal/update-events/lookup?external_event_id=${encodeURIComponent(envelope.external_event_id)}&payload_sha256=${"f".repeat(64)}`,
      undefined,
      "application/json",
      { "x-dona-update-token": token },
    )).status, 409);
    await fs.chmod(config.updateInternalTokenPath, 0o644);
    assert.equal((await request(
      config.socketPath,
      "GET",
      `/v1/internal/update-events/lookup?external_event_id=${encodeURIComponent(envelope.external_event_id)}&payload_sha256=${payloadSha256}`,
      undefined,
      "application/json",
      { "x-dona-update-token": token },
    )).status, 403);
    await api.stop();
    database.close();
  });

  test("binds self-update planning to persisted event context and exposes terminal and quiesce barriers", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    let workerRunning = true;
    let jobsRunning = true;
    let finishQuiesce!: () => void;
    const quiesceMayFinish = new Promise<void>((resolve) => {
      finishQuiesce = resolve;
    });
    const calls: unknown[] = [];
    const updates = {
      async plan(input: unknown) { calls.push(input); return { schema_version: 1, plan: {} }; },
      async apply(input: unknown) { calls.push({ apply: input }); return { schema_version: 1, accepted: true }; },
      async status() { return { schema_version: 1, updates: [] }; },
      async cancel() { return { schema_version: 1, state: "cancelled" }; },
    };
    const api = new DispatcherApi(
      database,
      { isRunning: () => workerRunning, wake() {} },
      { ...jobs, isRunning: () => jobsRunning },
      config,
      logger,
      updates,
      { async quiesce() { await quiesceMayFinish; workerRunning = false; jobsRunning = false; } },
    );
    await api.start();
    const accepted = await request(config.socketPath, "POST", "/v1/events", eventEnvelope("Ev-update-plan"));
    const eventId = accepted.body.event_id as string;
    assert.equal((await request(config.socketPath, "GET", `/v1/events/${eventId}/terminal`)).body.terminal, false);
    assert.equal((await request(config.socketPath, "POST", "/v1/self-update/plan", { source_event_id: eventId })).status, 200);
    assert.deepEqual(calls, [{
      source_event_id: eventId,
      reply_target: { kind: "slack_thread", workspace_id: "T_TEST", channel_id: "C_TEST", thread_ts: "1756722030.123456" },
    }]);
    const version = await request(config.socketPath, "GET", "/health/version");
    assert.deepEqual(
      {
        app_schema: version.body.app_schema,
        app_schema_read_min: version.body.app_schema_read_min,
        app_schema_read_max: version.body.app_schema_read_max,
        app_schema_write: version.body.app_schema_write,
      },
      { app_schema: 3, app_schema_read_min: 2, app_schema_read_max: 3, app_schema_write: 3 },
    );
    assert.equal(JSON.stringify(version.body).includes(config.databasePath), false);
    database.manualComplete(eventId);
    assert.equal((await request(config.socketPath, "GET", `/v1/events/${eventId}/terminal`)).body.terminal, true);
    assert.equal((await request(config.socketPath, "POST", "/v1/self-update/apply", {
      source_event_id: eventId,
      plan_id: "plan_01m1es03xy5cf8d9pm5cwx4srw",
      plan_hash: "a".repeat(64),
      approval_id: "approval-1",
    })).status, 202);
    assert.deepEqual(calls[1], { apply: {
      source_event_id: eventId,
      plan_id: "plan_01m1es03xy5cf8d9pm5cwx4srw",
      plan_hash: "a".repeat(64),
      approval_id: "approval-1",
      reply_target: { kind: "slack_thread", workspace_id: "T_TEST", channel_id: "C_TEST", thread_ts: "1756722030.123456" },
    } });
    const quiesced = await request(config.socketPath, "POST", "/v1/admin/quiesce", {
      schema_version: 1,
      protocol: 1,
      operation_id: "upd_01m1es03xy5cf8d9pm5cwx4srv",
      target_sha: "2".repeat(40),
    });
    assert.equal(quiesced.status, 202);
    assert.equal(quiesced.body.drained, false);
    finishQuiesce();
    await waitFor(() => !workerRunning && !jobsRunning);
    const drained = await request(config.socketPath, "GET", "/v1/admin/drain-status");
    assert.equal(drained.status, 200);
    assert.equal(drained.body.drained, true);
    assert.equal((await request(config.socketPath, "GET", "/health/version")).status, 503);
    assert.equal((await request(config.socketPath, "POST", "/v1/self-update/apply", {
      source_event_id: eventId,
      plan_id: "plan_01m1es03xy5cf8d9pm5cwx4srw",
      plan_hash: "a".repeat(64),
      approval_id: "approval-1",
    })).status, 503);
    await api.stop();
    database.close();
  });

  test("preserves structured Updater planning rejections", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const updates = {
      async plan() {
        throw new UpdaterClientError(409, "request_failed", "target_does_not_pass_fixed_ci_trust_gate");
      },
      async apply() { return { schema_version: 1 }; },
      async status() { return { schema_version: 1, updates: [] }; },
      async cancel() { return { schema_version: 1 }; },
    };
    const api = new DispatcherApi(
      database,
      { isRunning: () => true, wake() {} },
      jobs,
      config,
      logger,
      updates,
    );
    await api.start();
    const accepted = await request(config.socketPath, "POST", "/v1/events", eventEnvelope("Ev-update-rejected"));
    const rejected = await request(config.socketPath, "POST", "/v1/self-update/plan", {
      source_event_id: accepted.body.event_id,
    });
    assert.equal(rejected.status, 409);
    assert.deepEqual(rejected.body, {
      schema_version: 1,
      error: { code: "request_failed", message: "target_does_not_pass_fixed_ci_trust_gate" },
    });
    await api.stop();
    database.close();
  });

  test("exposes preview, CRUD and transition contracts over UDS", async () => {
    const { root, config } = await tempConfig(); roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const api = new DispatcherApi(database, { isRunning: () => true, wake() {} }, jobs, config, logger,
      undefined, undefined, undefined, undefined, () => new Date("2026-09-06T00:00:00Z"));
    await api.start();
    const event = await request(config.socketPath, "POST", "/v1/events", eventEnvelope("Ev-schedule-uds"));
    database.beginDispatch(event.body.event_id as string, path.join(root, "schedule-result.json"));
    database.markWaiting(event.body.event_id as string);
    const definition = { recurrence: { version: 1, kind: "once", at: "2026-09-08T00:00:00Z" }, action: { kind: "reminder", body: "UDS確認" } };
    const preview = await request(config.socketPath, "POST", "/v1/schedules/preview", { source_event_id: event.body.event_id, definition, after: "2026-09-06T00:00:00Z", before_or_equal: "2026-09-09T00:00:00Z", limit: 10 });
    assert.equal(preview.status, 200);
    const invalid = await request(config.socketPath, "POST", "/v1/schedules/preview", { source_event_id: event.body.event_id, definition: { ...definition, recurrence: { version: 1, kind: "daily", start_date: "2026-09-01", local_time: "09:00:00", timezone: "Invalid/Zone", tzdb_version: "2025b", interval: 1 } }, after: "2026-09-06T00:00:00Z", before_or_equal: "2026-09-09T00:00:00Z", limit: 10 });
    assert.equal(invalid.status, 400);
    assert.equal((invalid.body.error as { code: string }).code, "invalid_timezone");
    const created = await request(config.socketPath, "POST", "/v1/schedules", { source_event_id: event.body.event_id, idempotency_key: "uds-create", definition });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const schedule = created.body.schedule as { schedule_id: string; revision: number };
    assert.equal((await request(config.socketPath, "GET", `/v1/schedules/${schedule.schedule_id}?source_event_id=${event.body.event_id}`)).status, 200);
    assert.equal((await request(config.socketPath, "GET", `/v1/schedules?source_event_id=${event.body.event_id}&limit=10`)).status, 200);
    assert.equal((await request(config.socketPath, "POST", `/v1/schedules/${schedule.schedule_id}/pause`, { source_event_id: event.body.event_id, expected_revision: 1 })).status, 200);
    assert.equal((await request(config.socketPath, "GET", `/v1/schedules/${schedule.schedule_id}/runs?source_event_id=${event.body.event_id}&limit=10`)).status, 200);
    assert.equal((await request(config.socketPath, "GET", `/v1/schedules/%ZZ?source_event_id=${event.body.event_id}`)).status, 400);
    await api.stop(); database.close();
  });
});
