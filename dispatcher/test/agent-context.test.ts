import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterEach, test } from "node:test";

import { agentOperation, AgentContextManager } from "../src/agent-context.js";
import { AgentReadAuthorization } from "../src/agent-read-authorization.js";
import { DispatcherApi } from "../src/api.js";
import { DispatcherApiClient, DispatcherClientError } from "../src/client.js";
import { DispatcherDatabase } from "../src/database.js";
import type { VerifiedSlackPrincipalProof } from "../src/principal-proof.js";
import { eventEnvelope, tempConfig } from "./helpers.js";

const roots: string[] = [];
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const jobs = { isRunning: () => true, wake() {}, async steer(): Promise<never> { throw new Error("unused"); }, async cancel(): Promise<never> { throw new Error("unused"); } };

afterEach(async () => Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))));

function proof(externalEventId: string): VerifiedSlackPrincipalProof {
  return {
    version: 1,
    key_id: "sha256:0123456789abcdef",
    event_id: externalEventId,
    attempt: 1,
    tenant_id: "T_TEST",
    workspace_id: "T_TEST",
    principal_kind: "human",
    principal_id: "U_TEST",
    issued_at: "2026-09-21T00:00:00Z",
    expires_at: "2026-09-21T00:02:00Z",
    nonce: `nonce-${createHash("sha256").update(externalEventId).digest("hex").slice(0, 24)}`,
    adapter_id: "slack_socket:T_TEST",
    proof_sha256: createHash("sha256").update(externalEventId).digest("hex"),
  };
}

function rawRequest(socketPath: string, route: string, headers: Record<string, string>, method = "GET", body?: unknown) {
  return new Promise<number>((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({ socketPath, path: route, method, headers: {
      ...headers,
      ...(encoded === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) }),
    } }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject); request.end(encoded);
  });
}

test("live session receipt routeをjob status読取として分類する", () => {
  assert.equal(agentOperation("GET",new URL("http://localhost/v1/jobs/job_01j00000000000000000000000/live-session-receipts/lsr_test")),"get_job_status");
});

test("agent update statusはcurrent eventへ束縛したallowlistだけを返す", async () => {
  const {root,config}=await tempConfig(); roots.push(root);
  config.agentSocketPath=path.join(root,"a","a.sock"); config.agentCredentialPath=path.join(root,"a","a.token");
  const database=new DispatcherDatabase(config.databasePath);
  const envelope=eventEnvelope("agent-update-status"),source=database.enqueue(envelope,new Date(),proof(envelope.external_event_id)).row;
  const dispatching=database.beginDispatch(source.event_id,path.join(config.resultsDir,`${source.event_id}.json`));
  const contexts=new AgentContextManager(database,config.agentCredentialPath,60_000);
  const requestId="upd_01m1es03xy5cf8d9pm5cwx4srv";
  const updates={
    async plan():Promise<never>{throw new Error("unused");},async apply():Promise<never>{throw new Error("unused");},
    async cancel():Promise<never>{throw new Error("unused");},
    async status(id?:string){return {schema_version:1,update:{request_id:id,source_event_id:source.event_id,
      reply_target_json:source.reply_target_json,state:"needs_review",current_sha:"1".repeat(40),target_sha:"2".repeat(40),
      previous_sha:null,policy_version:"test",rollback_compatible:1,last_error_code:"safe_code",
      last_error_message:"PRIVATE-CANARY",approval_id:"PRIVATE-APPROVAL",lease_owner:"PRIVATE-LEASE",
      created_at:"2026-09-21T00:00:00Z",updated_at:"2026-09-21T00:01:00Z",completed_at:null,observed_active_sha:null},
      audit:["PRIVATE-AUDIT"],diagnostics:{secret:"PRIVATE-DIAGNOSTIC"}};},
  };
  const api=new DispatcherApi(database,{isRunning:()=>true,wake(){}},jobs,config,logger,updates,undefined,undefined,undefined,undefined,undefined,undefined,contexts);
  await api.start();
  try {
    await contexts.issue(dispatching);
    const client=new DispatcherApiClient(config.agentSocketPath,1_000,config.agentCredentialPath);
    const status=await client.getSelfUpdateStatus(source.event_id,requestId);
    assert.equal((status.update as {request_id:string}).request_id,requestId);
    assert.doesNotMatch(JSON.stringify(status),/PRIVATE-|source_event_id|reply_target_json|approval_id|lease_owner|last_error_message|audit|diagnostics/);
    await assert.rejects(()=>client.getSelfUpdateStatus(source.event_id),error=>error instanceof DispatcherClientError&&error.statusCode===404);
    const otherEnvelope=eventEnvelope("agent-update-status-other");
    const other=database.enqueue(otherEnvelope,new Date(Date.now()+1),proof(otherEnvelope.external_event_id)).row;
    await contexts.issue(database.beginDispatch(other.event_id,path.join(config.resultsDir,`${other.event_id}.json`)));
    await assert.rejects(()=>client.getSelfUpdateStatus(other.event_id,requestId),error=>error instanceof DispatcherClientError&&error.statusCode===404);
  } finally { await api.stop(); database.close(); }
});

test("agent専用transportはcurrent event/attemptとpurposeを固定しrestartで失効する", async () => {
  const { root, config } = await tempConfig(); roots.push(root);
  config.agentSocketPath = path.join(root, "a", "a.sock");
  config.agentCredentialPath = path.join(root, "a", "a.token");
  const database = new DispatcherDatabase(config.databasePath);
  const envelope = eventEnvelope("agent-context-source");
  const source = database.enqueue(envelope, new Date(), proof(envelope.external_event_id)).row;
  const dispatching = database.beginDispatch(source.event_id, path.join(config.resultsDir, `${source.event_id}.json`));
  const contexts = new AgentContextManager(database, config.agentCredentialPath, 60_000);
  const api = new DispatcherApi(database, { isRunning: () => true, wake() {} }, jobs, config, logger,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, contexts);
  await api.start();
  try {
    assert.equal((await fs.stat(path.dirname(config.agentSocketPath))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(config.agentSocketPath)).mode & 0o777, 0o600);
    const client = new DispatcherApiClient(config.agentSocketPath, 1_000, config.agentCredentialPath);
    await assert.rejects(() => client.listOwnerJobs(source.event_id), /Agent context is unavailable/);
    const context = await contexts.issue(dispatching);
    assert.deepEqual(context, {
      event_id: source.event_id, attempt: 1, purpose: "human_command", tenant_id: "T_TEST",
      workspace_id: "T_TEST", principal_kind: "human", principal_id: "U_TEST",
      expires_at: context.expires_at, policy_revision: 1,
    });
    assert.deepEqual((await client.listOwnerJobs(source.event_id)).jobs, []);

    const otherEnvelope = eventEnvelope("agent-context-other");
    const other = database.enqueue(otherEnvelope, new Date(Date.now() + 1), proof(otherEnvelope.external_event_id)).row;
    await assert.rejects(() => client.listOwnerJobs(other.event_id), (error: unknown) =>
      error instanceof DispatcherClientError && error.statusCode === 403);
    await assert.rejects(() => client.listEventJobs(other.event_id), (error: unknown) =>
      error instanceof DispatcherClientError && error.statusCode === 403);

    const credential = JSON.parse(await fs.readFile(config.agentCredentialPath, "utf8")) as {token:string;event_id:string};
    const headers = { "x-dona-agent-token": credential.token, "x-dona-source-event-id": credential.event_id };
    assert.equal(await rawRequest(config.agentSocketPath,
      `/v1/events/${encodeURIComponent(other.event_id)}/jobs?source_event_id=${encodeURIComponent(source.event_id)}`, headers), 403);
    assert.equal(await rawRequest(config.agentSocketPath, "/v1/jobs", headers, "POST", {
      source_event_id: other.event_id,
      job_key: "source-event-swap",
      objective: "拒否されるべき操作",
      workspace: { kind: "scratch" },
    }), 403);
    assert.deepEqual(database.listEventJobs(other.event_id), []);
    assert.equal(contexts.authorize(credential.token, source.event_id, "list_owner_jobs", new Date(context.expires_at)), undefined);
    assert.equal(await rawRequest(config.agentSocketPath, "/v1/admin/update-safety", headers), 403);
    assert.equal(contexts.authorize(credential.token, source.event_id, "authorize_job_notification"), undefined);

    await contexts.issue({ ...dispatching, attempt_count: dispatching.attempt_count + 1 });
    assert.equal(contexts.authorize(credential.token, source.event_id, "list_owner_jobs"), undefined);

    const completionEnvelope = {
      ...eventEnvelope("agent-context-completion"),
      source: "dona_job" as const,
      type: "job_completed",
      subject: { source_event_id: source.event_id },
      trace: { source_event_id: source.event_id },
    };
    const completion = database.enqueue(completionEnvelope).row;
    const completionDispatch = database.beginDispatch(completion.event_id, path.join(config.resultsDir, `${completion.event_id}.json`));
    await contexts.issue(completionDispatch);
    const completionCredential = JSON.parse(await fs.readFile(config.agentCredentialPath, "utf8")) as {token:string;event_id:string};
    assert.ok(contexts.authorize(completionCredential.token, completion.event_id, "get_job_status"));
    assert.equal(contexts.authorize(completionCredential.token, completion.event_id, "delegate_job"), undefined);
    assert.deepEqual((await client.listEventJobs(source.event_id)).jobs, []);

    const restarted = new AgentContextManager(database, config.agentCredentialPath);
    await restarted.initialize();
    assert.equal(restarted.authorize(credential.token, source.event_id, "list_owner_jobs"), undefined);
    await assert.rejects(() => fs.access(config.agentCredentialPath));
    const resumed = await restarted.ensure(completionDispatch);
    const resumedCredential = JSON.parse(await fs.readFile(config.agentCredentialPath, "utf8")) as {token:string;event_id:string};
    assert.equal(resumed.event_id, completion.event_id);
    assert.notEqual(resumedCredential.token, completionCredential.token);
    assert.ok(restarted.authorize(resumedCredential.token, completion.event_id, "get_job_status"));
    await assert.rejects(() => client.listOwnerJobs(completion.event_id), (error: unknown) =>
      error instanceof DispatcherClientError && error.statusCode === 403);
  } finally {
    await api.stop(); database.close();
  }
});

test("agent read境界は認可後だけallowlist投影し不可視と不存在を同形にする", async () => {
  const { root, config } = await tempConfig(); roots.push(root);
  config.agentSocketPath = path.join(root, "a", "a.sock");
  config.agentCredentialPath = path.join(root, "a", "a.token");
  const database = new DispatcherDatabase(config.databasePath);
  const envelope = {...eventEnvelope("agent-read-source"),payload:{text:"<@U_BOT> 私の待ちを一覧で見せて",event_ts:"1756722030.123456"}};
  const source = database.enqueue(envelope, new Date(), proof(envelope.external_event_id)).row;
  const dispatching = database.beginDispatch(source.event_id, path.join(config.resultsDir, `${source.event_id}.json`));
  const contexts = new AgentContextManager(database, config.agentCredentialPath, 60_000);
  const hidden = new Set<string>();
  const restrictedAudit: unknown[] = [];
  let currentAccess=true;
  const accessChecks:Array<Record<string,string>>=[];
  const reads = new AgentReadAuthorization({ authorize: () => true,revision:()=>"grant-1" }, {
    authorize: input => {
      const origin = input.disclosure_origin as { kind?:string;destination?: { channel_id?: string } };
      const destination = input.disclosure_destination as { channel_id?: string };
      return !hidden.has(input.job_id) && (origin.kind==="human_wait_origin"||origin.destination?.channel_id === destination.channel_id);
    },
    revision:()=>"visibility-1",
  }, { record: value => restrictedAudit.push(value) });
  const api = new DispatcherApi(database, { isRunning: () => true, wake() {} }, jobs, config, logger,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, contexts, reads,
    {async authorize(input){accessChecks.push(input);return currentAccess;}});
  await api.start();
  try {
    await contexts.issue(dispatching);
    const client = new DispatcherApiClient(config.agentSocketPath, 1_000, config.agentCredentialPath);
    const first = (await client.createJob({ source_event_id: source.event_id, job_key: "first", objective: "PRIVATE-CANARY", workspace: { kind: "scratch" } })).job as { job_id: string };
    const second = (await client.createJob({ source_event_id: source.event_id, job_key: "second", objective: "other", workspace: { kind: "scratch" } })).job as { job_id: string };
    database.markJobBlocked(first.job_id, "PRIVATE-CANARY-error", ["queued"]);
    const beforeReads = [database.getJob(first.job_id), database.getJob(second.job_id)];

    const visible = (await client.getJob(first.job_id, source.event_id)).job as Record<string, unknown>;
    assert.equal(visible.status, "blocked");
    assert.equal(visible.last_error_code, "agent_blocked");
    assert.equal(visible.result_json, undefined);
    assert.equal(visible.last_error_message, undefined);
    assert.doesNotMatch(JSON.stringify(visible), /PRIVATE-CANARY/);

    const waits=await client.listHumanWaits(source.event_id,20);
    assert.equal((waits.items as unknown[]).length,1);
    assert.doesNotMatch(JSON.stringify(waits),/PRIVATE-CANARY|resource_id|source_event_id/);
    const originRef=((waits.items as Array<{origin:{origin_ref:string}}>)[0]!).origin.origin_ref;
    assert.equal((await client.resolveHumanWaitOrigin(source.event_id,originRef)).status,"available");
    const presentation=await client.presentHumanWaits(source.event_id,10);
    assert.equal(presentation.status,"ok");
    assert.match(String(presentation.text),/自分待ちは1件/);
    assert.doesNotMatch(JSON.stringify(presentation),/PRIVATE-CANARY|resource_id|source_event_id|item_id/);
    assert.deepEqual(accessChecks[0],{event_id:source.event_id,workspace_id:"T_TEST",channel_id:"C_TEST",user_id:"U_TEST"});

    currentAccess=false;
    await assert.rejects(()=>client.listHumanWaits(source.event_id,20),
      (error:unknown)=>error instanceof DispatcherClientError&&error.statusCode===503&&
        (error.body as {error?:{code?:string}}).error?.code==="human_wait_query_unavailable");
    await assert.rejects(()=>client.resolveHumanWaitOrigin(source.event_id,originRef),
      (error:unknown)=>error instanceof DispatcherClientError&&error.statusCode===503);
    currentAccess=true;

    hidden.add(first.job_id);
    assert.deepEqual((await client.listHumanWaits(source.event_id,20)).items,[]);
    assert.equal((await client.presentHumanWaits(source.event_id,10)).status,"empty");
    await assert.rejects(()=>client.resolveHumanWaitOrigin(source.event_id,originRef),
      (error:unknown)=>error instanceof DispatcherClientError&&error.statusCode===404);
    const listed = await client.listEventJobs(source.event_id);
    assert.deepEqual((listed.jobs as Array<{job_id:string}>).map(row => row.job_id), [second.job_id]);
    assert.equal(listed.truncated, undefined);
    assert.doesNotMatch(JSON.stringify(listed), /PRIVATE-CANARY/);

    let hiddenError: DispatcherClientError | undefined;
    let missingError: DispatcherClientError | undefined;
    try { await client.getJob(first.job_id, source.event_id); } catch (error) { hiddenError = error as DispatcherClientError; }
    try { await client.getJob("job_01j00000000000000000000000", source.event_id); } catch (error) { missingError = error as DispatcherClientError; }
    assert.equal(hiddenError?.statusCode, 404);
    assert.deepEqual(hiddenError?.body, missingError?.body);
    assert.deepEqual(hiddenError?.body, { schema_version: 1, error: { code: "not_available", message: "Resource is not available" } });
    const digest = "a".repeat(64);
    assert.equal((await client.listEventJobs(source.event_id, "first", digest)).reconciliation, "not_found");
    assert.equal((await client.listEventJobs(source.event_id, "missing", digest)).reconciliation, "not_found");

    await assert.rejects(() => client.listThreadJobs(source.event_id, "T_TEST", "C_OTHER", "1756722030.123456"),
      (error: unknown) => error instanceof DispatcherClientError && error.statusCode === 403);
    assert.deepEqual([database.getJob(first.job_id), database.getJob(second.job_id)], beforeReads);
    assert.doesNotMatch(JSON.stringify(restrictedAudit), /PRIVATE-CANARY/);
    assert.ok(restrictedAudit.some(value => (value as {reason?:string}).reason === "visibility_unavailable"));

    for (let index = 0; index < 101; index++) {
      const extraEnvelope = eventEnvelope(`agent-read-hidden-${index}`);
      const extra = database.enqueue(extraEnvelope, new Date(Date.now() + index + 1), proof(extraEnvelope.external_event_id)).row;
      const row = database.createJob({ source_event_id: extra.event_id, job_key: "hidden", objective: "hidden",
        workspace: { kind: "scratch" } }, config.jobsWorkspaceRoot, config.jobResultsDir).row;
      hidden.add(row.job_id);
    }
    const deepThread = await client.listThreadJobs(source.event_id, "T_TEST", "C_TEST", "1756722030.123456");
    assert.deepEqual((deepThread.jobs as Array<{job_id:string}>).map(row => row.job_id), [second.job_id]);
    assert.equal(deepThread.truncated, false);
    const deepOwner = await client.listOwnerJobs(source.event_id);
    assert.deepEqual((deepOwner.jobs as Array<{job_id:string}>).map(row => row.job_id), [second.job_id]);
    assert.equal(deepOwner.truncated, false);

    const listOwnerJobs=database.listOwnerJobs.bind(database),listThreadJobs=database.listThreadJobs.bind(database);
    database.listOwnerJobs=(()=>Array.from({length:1_001},()=>database.getJob(second.job_id)!)) as typeof database.listOwnerJobs;
    await assert.rejects(()=>client.listOwnerJobs(source.event_id),
      (error:unknown)=>error instanceof DispatcherClientError&&error.statusCode===503&&
        (error.body as {error?:{code?:string}}).error?.code==="owner_query_unavailable");
    database.listOwnerJobs=(()=>{throw new Error("storage unavailable");}) as typeof database.listOwnerJobs;
    await assert.rejects(()=>client.listOwnerJobs(source.event_id),
      (error:unknown)=>error instanceof DispatcherClientError&&error.statusCode===503);
    database.listOwnerJobs=listOwnerJobs;
    database.listThreadJobs=(()=>Array.from({length:1_001},()=>database.getJob(second.job_id)!)) as typeof database.listThreadJobs;
    await assert.rejects(()=>client.listThreadJobs(source.event_id,"T_TEST","C_TEST","1756722030.123456"),
      (error:unknown)=>error instanceof DispatcherClientError&&error.statusCode===503&&
        (error.body as {error?:{code?:string}}).error?.code==="thread_query_unavailable");
    database.listThreadJobs=listThreadJobs;

    const nonIntentEnvelope={...eventEnvelope("agent-read-non-intent"),payload:{text:"雑談です",event_ts:"1756722031.123456"}};
    const nonIntent=database.enqueue(nonIntentEnvelope,new Date(Date.now()+200),proof(nonIntentEnvelope.external_event_id)).row;
    await contexts.issue(database.beginDispatch(nonIntent.event_id,path.join(config.resultsDir,`${nonIntent.event_id}.json`)));
    await assert.rejects(()=>client.listHumanWaits(nonIntent.event_id,20),
      (error:unknown)=>error instanceof DispatcherClientError&&error.statusCode===403&&
        (error.body as {error?:{code?:string}}).error?.code==="human_wait_intent_not_explicit");

    const completionEnvelope = {
      ...eventEnvelope("agent-read-completion"), source: "dona_job" as const, type: "job_completed",
      subject: { source_event_id: source.event_id }, trace: { source_event_id: source.event_id },
    };
    const completion = database.enqueue(completionEnvelope).row;
    await contexts.issue(database.beginDispatch(completion.event_id, path.join(config.resultsDir, `${completion.event_id}.json`)));
    const internal = await client.listEventJobs(source.event_id);
    assert.equal((internal.jobs as unknown[]).length, 2);
    assert.doesNotMatch(JSON.stringify(internal), /PRIVATE-CANARY|result_json|last_error_message|last_error_code/);
  } finally {
    await api.stop(); database.close();
  }
});

test("起動に失敗したprocessは既存agent socketとcredentialを削除しない", async () => {
  const { root, config } = await tempConfig(); roots.push(root);
  await fs.mkdir(path.dirname(config.agentSocketPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(config.agentCredentialPath, "foreign-credential\n", { mode: 0o600 });
  const foreign = net.createServer(socket => socket.end());
  await new Promise<void>((resolve, reject) => {
    foreign.once("error", reject);
    foreign.listen(config.agentSocketPath, resolve);
  });
  const database = new DispatcherDatabase(config.databasePath);
  const contexts = new AgentContextManager(database, config.agentCredentialPath, 60_000);
  const api = new DispatcherApi(database, { isRunning: () => true, wake() {} }, jobs, config, logger,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, contexts);
  try {
    await assert.rejects(() => api.start(), /Another agent API is already listening/);
    await api.stop();
    assert.equal(await fs.readFile(config.agentCredentialPath, "utf8"), "foreign-credential\n");
    assert.equal((await fs.lstat(config.agentSocketPath)).isSocket(), true);
  } finally {
    await new Promise<void>(resolve => foreign.close(() => resolve()));
    database.close();
  }
});
