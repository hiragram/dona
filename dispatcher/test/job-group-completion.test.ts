import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterEach, describe, test } from "node:test";

import Database from "better-sqlite3";

import { DispatcherDatabase, JobCreationError } from "../src/database.js";
import { envelopeFromRow } from "../src/prompt.js";
import { eventEnvelope, tempConfig } from "./helpers.js";

type SqliteRow = Record<string, string | number | null>;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("通常groupのResult統合", () => {
  async function oneJobGroup(externalId: string) {
    const {root,config} = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope(externalId)).row;
    database.beginDispatch(source.event_id, `${config.resultsDir}/${source.event_id}.json`);
    database.markWaiting(source.event_id);
    const job = database.createJob({source_event_id:source.event_id,job_key:"only",objective:"調査",workspace:{kind:"scratch"}},
      config.jobsWorkspaceRoot,config.jobResultsDir).row;
    database.beginJobPreparation(job.job_id);
    database.setJobRuntime(job.job_id,"workspace","pane");
    database.beginJobDispatch(job.job_id);
    database.markJobRunning(job.job_id);
    return {database,source,job,config};
  }

  function sealSource(database: DispatcherDatabase, sourceEventId: string, resultPath: string) {
    database.saveCompleted(sourceEventId, {schema_version:1,event_id:sourceEventId,status:"completed",
      summary:"delegated",completed_at:"2026-09-05T00:00:00.000Z"}, resultPath);
  }

  test("blocked only は再起動後も未解決で、明示取消後だけ最終通知へ進む", async () => {
    const setup = await oneJobGroup("Ev-blocked-fence");
    let {database} = setup;
    database.markJobBlocked(setup.job.job_id,"入力待ち");
    sealSource(database,setup.source.event_id,`${setup.config.resultsDir}/source.json`);
    const attention = database.enqueueJobNotification(setup.job.job_id);
    assert.equal((envelopeFromRow(attention.row).payload.group as Record<string,unknown>).transition,"attention");
    assert.deepEqual(database.listJobsNeedingNotification(),[]);
    database.close();
    database = new DispatcherDatabase(setup.config.databasePath);
    assert.deepEqual(database.listJobsNeedingNotification(),[]);
    assert.equal(database.enqueueJobNotification(setup.job.job_id).row.event_id,attention.row.event_id);
    const followUp = database.enqueue(eventEnvelope("Ev-blocked-cancel")).row;
    database.beginJobCancellation(setup.job.job_id,followUp.event_id);
    database.markJobCancelled(setup.job.job_id,"明示取消");
    assert.equal(database.getJobGroup(setup.source.event_id)?.attention_event_id,null);
    const final = database.enqueueJobNotification(setup.job.job_id);
    const snapshot = envelopeFromRow(final.row).payload.group as Record<string,unknown>;
    assert.equal(snapshot.transition,"all_terminal");
    assert.equal(snapshot.attention_resolution_state,"not_required");
    assert.equal(database.enqueueJobNotification(setup.job.job_id).row.event_id,final.row.event_id);
    database.close();
  });

  test("attentionとrunning siblingは中間通知後も最終化しない", async () => {
    const {database,source,job,config} = await oneJobGroup("Ev-attention-running");
    const sibling = database.createJob({source_event_id:source.event_id,job_key:"second",objective:"別調査",workspace:{kind:"scratch"}},
      config.jobsWorkspaceRoot,config.jobResultsDir).row;
    database.beginJobPreparation(sibling.job_id);
    database.setJobRuntime(sibling.job_id,"workspace-second","pane-second");
    database.beginJobDispatch(sibling.job_id);
    database.markJobRunning(sibling.job_id);
    database.markJobBlocked(job.job_id,"入力待ち");
    sealSource(database,source.event_id,`${config.resultsDir}/source.json`);
    database.enqueueJobNotification(job.job_id);
    assert.equal(database.getJobGroup(source.event_id)?.all_terminal_event_id,null);
    database.saveJobResult(sibling.job_id,{schema_version:1,job_id:sibling.job_id,status:"completed",
      summary:"完了",completed_at:"2026-09-05T00:00:30.000Z"},sibling.result_path);
    const progress = database.enqueueJobNotification(sibling.job_id);
    assert.equal((envelopeFromRow(progress.row).payload.group as Record<string,unknown>).transition,"progress");
    assert.equal(database.getJobGroup(source.event_id)?.all_terminal_event_id,null);
    const followUp = database.enqueue(eventEnvelope("Ev-attention-running-cancel")).row;
    database.beginJobCancellation(job.job_id,followUp.event_id);
    database.markJobCancelled(job.job_id,"明示取消");
    const final = database.enqueueJobNotification(job.job_id);
    assert.equal((envelopeFromRow(final.row).payload.group as Record<string,unknown>).transition,"all_terminal");
    database.close();
  });

  test("attention原因のlate Result後も別の未解決failedへownerを引き継ぐ", async () => {
    const {database,source,job,config}=await oneJobGroup("Ev-attention-handoff");
    const failed=database.createJob({source_event_id:source.event_id,job_key:"failed",objective:"別調査",workspace:{kind:"scratch"}},
      config.jobsWorkspaceRoot,config.jobResultsDir).row;
    database.beginJobPreparation(failed.job_id);
    database.setJobRuntime(failed.job_id,"workspace-failed","pane-failed");
    database.beginJobDispatch(failed.job_id);
    database.markJobRunning(failed.job_id);
    database.markJobNeedsReview(job.job_id,"prompt_interrupted","結果待ち");
    sealSource(database,source.event_id,`${config.resultsDir}/source.json`);
    const first=database.enqueueJobNotification(job.job_id);
    database.saveJobResult(failed.job_id,{schema_version:1,job_id:failed.job_id,status:"failed",
      summary:"失敗",completed_at:"2026-09-05T00:00:30.000Z"},failed.result_path);
    const progress=database.enqueueJobNotification(failed.job_id);
    assert.equal((envelopeFromRow(progress.row).payload.group as Record<string,unknown>).transition,"progress");
    database.saveJobResult(job.job_id,{schema_version:1,job_id:job.job_id,status:"completed",
      summary:"late Result",completed_at:"2026-09-05T00:00:40.000Z"},job.result_path);
    assert.equal(database.get(first.row.event_id)?.last_error_code,"job_result_superseded");
    assert.equal(database.getJobGroup(source.event_id)?.attention_event_id,null);
    assert.equal(database.listJobsNeedingNotification()[0]?.job_id,failed.job_id);
    const replacement=database.enqueueJobNotification(failed.job_id);
    assert.equal((envelopeFromRow(replacement.row).payload.group as Record<string,unknown>).transition,"attention");
    assert.notEqual(replacement.row.event_id,first.row.event_id);
    assert.equal(database.getJobGroup(source.event_id)?.attention_event_id,replacement.row.event_id);
    assert.equal(database.getJobGroup(source.event_id)?.all_terminal_event_id,null);
    database.close();
  });

  test("投稿済みattentionは取消後の最終通知まで同一ownerを保持する", async () => {
    const {database,source,job,config} = await oneJobGroup("Ev-attention-delivered-cancel");
    database.markJobBlocked(job.job_id,"入力待ち");
    sealSource(database,source.event_id,`${config.resultsDir}/source.json`);
    const attention=database.enqueueJobNotification(job.job_id);
    database.beginDispatch(attention.row.event_id,`${config.resultsDir}/attention.json`);
    database.markWaiting(attention.row.event_id);
    database.saveCompleted(attention.row.event_id,{schema_version:1,event_id:attention.row.event_id,
      status:"completed",summary:"attention delivered",completed_at:"2026-09-05T00:01:00.000Z",
      actions:[{tool:"dona_slack.post_message",workspace_id:"T_TEST",channel_id:"C_TEST",thread_ts:"1756722030.123456",message_ts:"123.456"},
        {tool:"dona_slack.set_agent_session_status",workspace_id:"T_TEST",channel_id:"C_TEST",thread_ts:"1756722030.123456",status:"suspended"}]},
      `${config.resultsDir}/attention.json`);
    const followUp=database.enqueue(eventEnvelope("Ev-attention-delivered-cancel-followup")).row;
    database.beginJobCancellation(job.job_id,followUp.event_id);
    database.markJobCancelled(job.job_id,"明示取消");
    assert.equal(database.getJobGroup(source.event_id)?.attention_event_id,attention.row.event_id);
    const final=database.enqueueJobNotification(job.job_id);
    assert.equal((envelopeFromRow(final.row).payload.group as Record<string,unknown>).attention_resolution_state,"resolved");
    assert.equal((envelopeFromRow(final.row).payload.group as Record<string,unknown>).transition,"all_terminal");
    database.close();
  });

  test("needs_review only は検証済みlate Resultまでfenceを保持する", async () => {
    const setup = await oneJobGroup("Ev-review-fence");
    let {database} = setup;
    database.markJobNeedsReview(setup.job.job_id,"prompt_interrupted","結果待ち");
    sealSource(database,setup.source.event_id,`${setup.config.resultsDir}/source.json`);
    const attention = database.enqueueJobNotification(setup.job.job_id);
    assert.deepEqual(database.listJobsNeedingNotification(),[]);
    database.close();
    database = new DispatcherDatabase(setup.config.databasePath);
    assert.equal(database.getJobGroup(setup.source.event_id)?.attention_event_id,attention.row.event_id);
    database.saveJobResult(setup.job.job_id,{schema_version:1,job_id:setup.job.job_id,status:"completed",
      summary:"検証済み",completed_at:"2026-09-05T00:00:30.000Z"},setup.job.result_path);
    assert.equal(database.getJobGroup(setup.source.event_id)?.attention_event_id,null);
    const final = database.enqueueJobNotification(setup.job.job_id);
    assert.equal((envelopeFromRow(final.row).payload.group as Record<string,unknown>).transition,"all_terminal");
    database.close();
  });

  test("曖昧なattention配送は確認receiptまで解消しない", async () => {
    const {database,source,job,config} = await oneJobGroup("Ev-attention-ambiguous");
    database.saveJobResult(job.job_id,{schema_version:1,job_id:job.job_id,status:"failed",
      summary:"失敗",completed_at:"2026-09-05T00:00:30.000Z"},job.result_path);
    sealSource(database,source.event_id,`${config.resultsDir}/source.json`);
    const attention = database.enqueueJobNotification(job.job_id);
    database.beginDispatch(attention.row.event_id,`${config.resultsDir}/attention.json`);
    database.markWaiting(attention.row.event_id);
    database.saveCompleted(attention.row.event_id,{schema_version:1,event_id:attention.row.event_id,
      status:"completed",summary:"配送結果不明",completed_at:"2026-09-05T00:01:00.000Z",
      actions:[{tool:"dona_slack.post_message",ambiguous:true}]},`${config.resultsDir}/attention.json`);
    assert.deepEqual(database.listJobsNeedingNotification(),[]);
    assert.throws(()=>database.resolveFailedJobAttention(source.event_id,job.job_id,attention.row.event_id,
      database.getJob(job.job_id)!.updated_at),/notification_requires_reconciliation/);
    const hash="a".repeat(64),expectedUpdatedAt=database.get(attention.row.event_id)!.updated_at;
    const {request,claimToken}=database.claimAttentionDeliveryReconciliation(source.event_id,attention.row.event_id,
      expectedUpdatedAt,"123.456",hash);
    assert.throws(()=>database.claimAttentionDeliveryReconciliation(source.event_id,attention.row.event_id,
      expectedUpdatedAt,"123.456",hash));
    assert.equal(database.resumeAttentionDeliveryReconciliation(source.event_id,attention.row.event_id,
      expectedUpdatedAt,"123.456",hash,claimToken).claimToken,claimToken);
    assert.throws(()=>database.recordVerifiedAttentionDelivery(source.event_id,attention.row.event_id,
      expectedUpdatedAt,claimToken,{...request,posted_at:"2026-09-05T00:01:00.000Z",reply_broadcast:false,
        identity_block_verified:false,session_status:"suspended"}),/evidence_mismatch/);
    database.recordVerifiedAttentionDelivery(source.event_id,attention.row.event_id,
      expectedUpdatedAt,claimToken,{...request,posted_at:"2026-09-05T00:01:00.000Z",reply_broadcast:false,
        identity_block_verified:true,session_status:"suspended"});
    database.resolveFailedJobAttention(source.event_id,job.job_id,attention.row.event_id,database.getJob(job.job_id)!.updated_at);
    assert.ok(database.getJobGroup(source.event_id)?.all_terminal_event_id);
    database.close();
  });

  test("Session更新timeoutではpost成功記録だけでactiveへ進めない", async () => {
    const {database,source,job,config} = await oneJobGroup("Ev-attention-session-timeout");
    database.saveJobResult(job.job_id,{schema_version:1,job_id:job.job_id,status:"failed",
      summary:"失敗",completed_at:"2026-09-05T00:00:30.000Z"},job.result_path);
    sealSource(database,source.event_id,`${config.resultsDir}/source.json`);
    const attention = database.enqueueJobNotification(job.job_id);
    database.beginDispatch(attention.row.event_id,`${config.resultsDir}/attention.json`);
    database.markWaiting(attention.row.event_id);
    database.saveCompleted(attention.row.event_id,{schema_version:1,event_id:attention.row.event_id,
      status:"completed",summary:"Session更新結果不明",completed_at:"2026-09-05T00:01:00.000Z",
      actions:[{tool:"dona_slack.post_message",workspace_id:"T_TEST",channel_id:"C_TEST",thread_ts:"1756722030.123456",message_ts:"123.456"},
        {tool:"dona_slack.set_agent_session_status",workspace_id:"T_TEST",channel_id:"C_TEST",thread_ts:"1756722030.123456",
          status:"suspended",ambiguous:true}]},`${config.resultsDir}/attention.json`);
    assert.deepEqual(database.listJobsNeedingNotification(),[]);
    assert.throws(()=>database.resolveFailedJobAttention(source.event_id,job.job_id,attention.row.event_id,
      database.getJob(job.job_id)!.updated_at),/notification_requires_reconciliation/);
    assert.equal(database.getJobGroup(source.event_id)?.all_terminal_event_id,null);
    database.close();
  });

  test("別workspaceへのattention投稿記録はresolutionの証拠にしない", async () => {
    const {database,source,job,config}=await oneJobGroup("Ev-attention-wrong-workspace");
    database.saveJobResult(job.job_id,{schema_version:1,job_id:job.job_id,status:"failed",
      summary:"失敗",completed_at:"2026-09-05T00:00:30.000Z"},job.result_path);
    sealSource(database,source.event_id,`${config.resultsDir}/source.json`);
    const attention=database.enqueueJobNotification(job.job_id);
    database.beginDispatch(attention.row.event_id,`${config.resultsDir}/attention.json`);
    database.markWaiting(attention.row.event_id);
    database.saveCompleted(attention.row.event_id,{schema_version:1,event_id:attention.row.event_id,
      status:"completed",summary:"別workspace",completed_at:"2026-09-05T00:01:00.000Z",
      actions:[{tool:"dona_slack.post_message",workspace_id:"T_OTHER",channel_id:"C_TEST",thread_ts:"1756722030.123456",message_ts:"123.456"},
        {tool:"dona_slack.set_agent_session_status",workspace_id:"T_OTHER",channel_id:"C_TEST",thread_ts:"1756722030.123456",status:"suspended"}]},
      `${config.resultsDir}/attention.json`);
    assert.throws(()=>database.resolveFailedJobAttention(source.event_id,job.job_id,attention.row.event_id,
      database.getJob(job.job_id)!.updated_at),/notification_requires_reconciliation/);
    assert.equal(database.getJobGroup(source.event_id)?.all_terminal_event_id,null);
    database.close();
  });

  test("配送reconcileのclaim中はlate resolutionがactiveへ進まない", async () => {
    const {database,source,job,config}=await oneJobGroup("Ev-attention-claim-race");
    database.saveJobResult(job.job_id,{schema_version:1,job_id:job.job_id,status:"failed",
      summary:"失敗",completed_at:"2026-09-05T00:00:30.000Z"},job.result_path);
    sealSource(database,source.event_id,`${config.resultsDir}/source.json`);
    const attention=database.enqueueJobNotification(job.job_id);
    database.beginDispatch(attention.row.event_id,`${config.resultsDir}/attention.json`);
    database.markWaiting(attention.row.event_id);
    database.saveCompleted(attention.row.event_id,{schema_version:1,event_id:attention.row.event_id,
      status:"completed",summary:"投稿済み",completed_at:"2026-09-05T00:01:00.000Z",
      actions:[{tool:"dona_slack.post_message",workspace_id:"T_TEST",channel_id:"C_TEST",thread_ts:"1756722030.123456",message_ts:"123.456"},
        {tool:"dona_slack.set_agent_session_status",workspace_id:"T_TEST",channel_id:"C_TEST",thread_ts:"1756722030.123456",status:"suspended"}]},
      `${config.resultsDir}/attention.json`);
    const hash="b".repeat(64),expectedUpdatedAt=database.get(attention.row.event_id)!.updated_at;
    const {request,claimToken}=database.claimAttentionDeliveryReconciliation(source.event_id,attention.row.event_id,
      expectedUpdatedAt,"123.456",hash);
    database.resolveFailedJobAttention(source.event_id,job.job_id,attention.row.event_id,database.getJob(job.job_id)!.updated_at);
    assert.equal(database.getJobGroup(source.event_id)?.all_terminal_event_id,null);
    database.recordVerifiedAttentionDelivery(source.event_id,attention.row.event_id,expectedUpdatedAt,claimToken,
      {...request,posted_at:"2026-09-05T00:01:00.000Z",reply_broadcast:false,identity_block_verified:true,session_status:"suspended"});
    const final=database.enqueueJobNotification(job.job_id);
    assert.equal((envelopeFromRow(final.row).payload.group as Record<string,unknown>).transition,"all_terminal");
    assert.throws(()=>database.attentionDeliveryVerificationRequest(source.event_id,attention.row.event_id,"123.456",hash),
      /reconciliation_unavailable/);
    database.close();
  });

  test("複数publisherの古い候補とclaim途中のrollbackは単一attentionへ収束する", async () => {
    const setup = await oneJobGroup("Ev-attention-publishers");
    const {database,source,job,config} = setup;
    database.markJobNeedsReview(job.job_id,"prompt_interrupted","結果不明");
    sealSource(database,source.event_id,`${config.resultsDir}/source.json`);
    const peer = new DispatcherDatabase(config.databasePath);
    assert.equal(database.listJobsNeedingNotification().length,1);
    assert.equal(peer.listJobsNeedingNotification().length,1);
    for(const step of ["event_enqueued","transition_claimed","job_linked"] as const) {
      assert.throws(()=>database.enqueueJobNotification(job.job_id,new Date(),current=>{
        if(current===step)throw new Error(`fault:${step}`);
      }),new RegExp(`fault:${step}`));
      assert.equal(peer.getJobGroup(source.event_id)?.attention_event_id,null);
      assert.equal(peer.getJob(job.job_id)?.completion_event_id,null);
    }
    const first = peer.enqueueJobNotification(job.job_id);
    const stale = database.enqueueJobNotification(job.job_id);
    assert.equal(stale.row.event_id,first.row.event_id);
    assert.equal(database.getJobGroup(source.event_id)?.attention_event_id,first.row.event_id);
    assert.deepEqual(peer.listJobsNeedingNotification(),[]);
    peer.close();
    database.close();
  });

  test("provides idempotent group creation, sealing, and transition ownership primitives", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-group-source")).row;
    const created = database.createJob(
      { source_event_id: source.event_id, objective: "調査する", workspace: { kind: "scratch" } },
      config.jobsWorkspaceRoot,
      config.jobResultsDir,
      new Date("2026-09-03T01:00:00.000Z"),
    );
    assert.equal(created.row.job_key, "legacy-default");
    assert.equal(database.getJobGroup(source.event_id)?.notification_mode, "legacy");
    assert.throws(
      () => database.createJob({
        source_event_id: source.event_id,
        job_key: "unexpected.second",
        objective: "別の調査",
        workspace: { kind: "scratch" },
      }, config.jobsWorkspaceRoot, config.jobResultsDir),
      (error) => error instanceof JobCreationError && error.code === "job_group_closed",
    );
    assert.deepEqual(database.ensureJobGroup(source.event_id, "legacy").created, false);
    assert.throws(() => database.ensureJobGroup(source.event_id, "grouped"), /already uses legacy/);

    const sealed = database.sealJobGroup(source.event_id, new Date("2026-09-03T01:01:00.000Z"));
    assert.equal(sealed.sealed_at, "2026-09-03T01:01:00.000Z");
    assert.equal(
      database.sealJobGroup(source.event_id, new Date("2026-09-03T01:02:00.000Z")).sealed_at,
      "2026-09-03T01:01:00.000Z",
    );
    const owner = database.enqueue(eventEnvelope("Ev-group-owner")).row;
    assert.equal(database.claimJobGroupTransition(source.event_id, "attention", owner.event_id).claimed, true);
    const contender = database.enqueue(eventEnvelope("Ev-group-contender")).row;
    const duplicateClaim = database.claimJobGroupTransition(source.event_id, "attention", contender.event_id);
    assert.equal(duplicateClaim.claimed, false);
    assert.equal(duplicateClaim.row.attention_event_id, owner.event_id);
    database.close();
  });
  test("seals queued grouped events on every manual terminal path", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);

    for (const [suffix, terminal] of [
      ["completed", "complete"],
      ["dead-letter", "dead-letter"],
    ] as const) {
      const source = database.enqueue(eventEnvelope(`Ev-manual-${suffix}`)).row;
      const job = database.createJob({
        source_event_id: source.event_id,
        job_key: "only",
        objective: "complete before the source event",
        workspace: { kind: "scratch" },
      }, config.jobsWorkspaceRoot, config.jobResultsDir).row;
      database.beginJobPreparation(job.job_id);
      database.setJobRuntime(job.job_id, `workspace-${suffix}`, `pane-${suffix}`);
      database.beginJobDispatch(job.job_id);
      database.markJobRunning(job.job_id);
      database.saveJobResult(job.job_id, {
        schema_version: 1,
        job_id: job.job_id,
        status: "completed",
        summary: "completed before manual source termination",
        completed_at: "2026-09-05T04:00:00.000Z",
      }, job.result_path);
      assert.deepEqual(database.listJobsNeedingNotification(), []);

      const terminalAt = new Date("2026-09-05T04:01:00.000Z");
      if (terminal === "complete") {
        database.manualComplete(source.event_id, terminalAt);
        database.manualComplete(source.event_id, new Date("2026-09-05T04:02:00.000Z"));
      } else {
        database.manualDeadLetter(source.event_id, terminalAt);
      }

      assert.equal(database.getJobGroup(source.event_id)?.sealed_at, terminalAt.toISOString());
      assert.deepEqual(database.listJobsNeedingNotification().map(({ job_id }) => job_id), [job.job_id]);
      const notification = database.enqueueJobNotification(job.job_id);
      assert.equal(
        (envelopeFromRow(notification.row).payload.group as Record<string, unknown>).transition,
        "all_terminal",
      );
      const contender=database.enqueue(eventEnvelope(`Ev-manual-${suffix}-contender`)).row;
      const repeated=database.claimJobGroupTransition(source.event_id,"all_terminal",contender.event_id);
      assert.equal(repeated.claimed,false);
      assert.equal(repeated.row.all_terminal_event_id,notification.row.event_id);
    }
    database.close();
  });
  test("keeps a failed group suspended until audited attention resolution", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-group-attention")).row;
    database.beginDispatch(source.event_id, `${config.resultsDir}/${source.event_id}.json`);
    database.markWaiting(source.event_id);
    const blocked = database.createJob({
      source_event_id: source.event_id,
      job_key: "blocked",
      objective: "承認を待つ",
      workspace: { kind: "scratch" },
    }, config.jobsWorkspaceRoot, config.jobResultsDir).row;
    for (const job of [blocked]) {
      database.beginJobPreparation(job.job_id);
      database.setJobRuntime(job.job_id, `workspace-${job.job_key}`, `pane-${job.job_key}`);
      database.beginJobDispatch(job.job_id);
      database.markJobRunning(job.job_id);
    }
    database.saveJobResult(blocked.job_id, {
      schema_version: 1,
      job_id: blocked.job_id,
      status: "failed",
      summary: "失敗",
      completed_at: "2026-09-05T00:00:30.000Z",
    }, blocked.result_path);
    database.saveCompleted(source.event_id, {
      schema_version: 1,
      event_id: source.event_id,
      status: "completed",
      completed_at: "2026-09-05T00:02:00.000Z",
    }, `${config.resultsDir}/${source.event_id}.json`);

    const attention = database.enqueueJobNotification(blocked.job_id, new Date("2026-09-05T00:03:00.000Z"));
    assert.equal((envelopeFromRow(attention.row).payload.group as Record<string, unknown>).transition, "attention");
    assert.equal((envelopeFromRow(attention.row).payload.group as Record<string, unknown>).pending, 0);
    assert.equal(database.getJobGroup(source.event_id)?.attention_event_id, attention.row.event_id);

    assert.deepEqual(database.listJobsNeedingNotification(), []);
    assert.equal(database.enqueueJobNotification(blocked.job_id).row.event_id, attention.row.event_id);
    assert.equal(database.getJobGroup(source.event_id)?.all_terminal_event_id, null);
    database.beginDispatch(attention.row.event_id, `${config.resultsDir}/${attention.row.event_id}.json`);
    database.markWaiting(attention.row.event_id);
    database.saveCompleted(attention.row.event_id, {
      schema_version: 1, event_id: attention.row.event_id, status: "completed",
      summary: "attention delivered", completed_at: "2026-09-05T00:03:30.000Z",
      actions: [{tool:"dona_slack.post_message",workspace_id:"T_TEST",channel_id:"C_TEST",thread_ts:"1756722030.123456",message_ts:"123.456"},
        {tool:"dona_slack.set_agent_session_status",workspace_id:"T_TEST",channel_id:"C_TEST",thread_ts:"1756722030.123456",status:"suspended"}],
    }, `${config.resultsDir}/${attention.row.event_id}.json`);
    assert.deepEqual(database.listJobsNeedingNotification(), []);
    assert.throws(() => database.resolveFailedJobAttention(source.event_id, blocked.job_id, "wrong-event", blocked.updated_at), /binding_mismatch/);
    database.resolveFailedJobAttention(source.event_id, blocked.job_id, attention.row.event_id, database.getJob(blocked.job_id)!.updated_at);
    const allTerminal = {row:database.get(database.getJobGroup(source.event_id)!.all_terminal_event_id!)!};
    const finalSnapshot = envelopeFromRow(allTerminal.row).payload.group as Record<string, unknown>;
    assert.equal(finalSnapshot.transition, "all_terminal");
    assert.equal(finalSnapshot.pending, 0);
    assert.deepEqual(finalSnapshot.status_counts, { failed: 1 });
    assert.equal(database.getJobGroup(source.event_id)?.all_terminal_event_id, allTerminal.row.event_id);
    assert.equal(database.getJob(blocked.job_id)?.completion_event_id, attention.row.event_id);
    database.close();
  });
  test("keeps grouped snapshots bounded and redacts job content", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath, {
      jobsPerEventMax: 32,
      jobObjectiveTotalMaxBytes: 400_000,
    });
    const source = database.enqueue(eventEnvelope("Ev-bounded-group")).row;
    database.beginDispatch(source.event_id, `${config.resultsDir}/${source.event_id}.json`);
    database.markWaiting(source.event_id);
    const jobs = Array.from({ length: 32 }, (_, index) => database.createJob({
      source_event_id: source.event_id,
      job_key: `job-${index.toString().padStart(2, "0")}`,
      objective: `SECRET-OBJECTIVE-${index}`,
      workspace: { kind: "scratch" },
    }, config.jobsWorkspaceRoot, config.jobResultsDir).row);
    const preQuotaDatabase = new Database(config.databasePath);
    const seed = preQuotaDatabase.prepare("SELECT * FROM jobs WHERE job_id = ?")
      .get(jobs[0]!.job_id) as SqliteRow;
    const columns = Object.keys(seed);
    const insertPreQuotaJob = preQuotaDatabase.prepare(`
      INSERT INTO jobs (${columns.join(", ")})
      VALUES (${columns.map((column) => `@${column}`).join(", ")})
    `);
    for (let index = 32; index < 35; index += 1) {
      insertPreQuotaJob.run({
        ...seed,
        job_id: `job-pre-quota-${index}`,
        job_key: `job-${index.toString().padStart(2, "0")}`,
        objective: `SECRET-OBJECTIVE-${index}`,
        workspace_path: `${config.jobsWorkspaceRoot}/scratch/job-pre-quota-${index}`,
        result_path: `${config.jobResultsDir}/job-pre-quota-${index}.json`,
        agent_name: `job-pre-quota-${index}`,
      });
    }
    preQuotaDatabase.close();
    const attentionJob = jobs[0]!;
    database.beginJobPreparation(attentionJob.job_id);
    database.setJobRuntime(attentionJob.job_id, "secret-workspace-id", "secret-pane-id");
    database.beginJobDispatch(attentionJob.job_id);
    database.markJobRunning(attentionJob.job_id);
    database.markJobBlocked(attentionJob.job_id, "operator input required");
    database.saveCompleted(source.event_id, {
      schema_version: 1,
      event_id: source.event_id,
      status: "completed",
      completed_at: "2026-09-05T01:00:00.000Z",
    }, `${config.resultsDir}/${source.event_id}.json`);

    const notification = database.enqueueJobNotification(attentionJob.job_id);
    const group = envelopeFromRow(notification.row).payload.group as Record<string, unknown>;
    assert.equal(group.total, 35);
    assert.equal(group.pending, 35);
    assert.equal((group.jobs as unknown[]).length, 32);
    const encoded = JSON.stringify(group);
    assert.equal(encoded.includes("SECRET-OBJECTIVE"), false);
    assert.equal(encoded.includes(config.jobsWorkspaceRoot), false);
    assert.equal(encoded.includes(config.jobResultsDir), false);
    assert.equal(encoded.includes("secret-workspace-id"), false);
    assert.equal(encoded.includes("secret-pane-id"), false);
    database.close();
  });
  test("rolls back notification enqueue, transition claim, and job link at every injected boundary", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-notification-faults")).row;
    database.beginDispatch(source.event_id, `${config.resultsDir}/${source.event_id}.json`);
    database.markWaiting(source.event_id);
    const job = database.createJob({
      source_event_id: source.event_id,
      job_key: "only",
      objective: "complete once",
      workspace: { kind: "scratch" },
    }, config.jobsWorkspaceRoot, config.jobResultsDir).row;
    database.beginJobPreparation(job.job_id);
    database.setJobRuntime(job.job_id, "workspace", "pane");
    database.beginJobDispatch(job.job_id);
    database.markJobRunning(job.job_id);
    database.saveJobResult(job.job_id, {
      schema_version: 1,
      job_id: job.job_id,
      status: "completed",
      summary: "done",
      completed_at: "2026-09-05T02:00:00.000Z",
    }, job.result_path);
    database.saveCompleted(source.event_id, {
      schema_version: 1,
      event_id: source.event_id,
      status: "completed",
      completed_at: "2026-09-05T02:01:00.000Z",
    }, `${config.resultsDir}/${source.event_id}.json`);

    for (const step of ["event_enqueued", "transition_claimed", "job_linked"] as const) {
      assert.throws(
        () => database.enqueueJobNotification(job.job_id, new Date("2026-09-05T02:02:00.000Z"), (current) => {
          if (current === step) throw new Error(`fault:${step}`);
        }),
        new RegExp(`fault:${step}`),
      );
      assert.equal(database.getJob(job.job_id)?.completion_event_id, null);
      assert.equal(database.getJobGroup(source.event_id)?.all_terminal_event_id, null);
      assert.equal(database.getByExternalId("dona_job", `${job.job_id}:completed`), undefined);
    }

    const recovered = database.enqueueJobNotification(job.job_id);
    assert.equal((envelopeFromRow(recovered.row).payload.group as Record<string, unknown>).transition, "all_terminal");
    assert.equal(database.enqueueJobNotification(job.job_id).row.event_id, recovered.row.event_id);
    database.close();
  });
  test("recovers a sealed terminal job without duplicating its grouped transition", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    let database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-group-restart")).row;
    database.beginDispatch(source.event_id, `${config.resultsDir}/${source.event_id}.json`);
    database.markWaiting(source.event_id);
    const job = database.createJob({
      source_event_id: source.event_id,
      job_key: "restart",
      objective: "survive restart",
      workspace: { kind: "scratch" },
    }, config.jobsWorkspaceRoot, config.jobResultsDir).row;
    database.beginJobPreparation(job.job_id);
    database.setJobRuntime(job.job_id, "workspace", "pane");
    database.beginJobDispatch(job.job_id);
    database.markJobRunning(job.job_id);
    database.saveJobResult(job.job_id, {
      schema_version: 1,
      job_id: job.job_id,
      status: "completed",
      summary: "done",
      completed_at: "2026-09-05T03:00:00.000Z",
    }, job.result_path);
    database.saveCompleted(source.event_id, {
      schema_version: 1,
      event_id: source.event_id,
      status: "completed",
      completed_at: "2026-09-05T03:01:00.000Z",
    }, `${config.resultsDir}/${source.event_id}.json`);
    database.close();

    database = new DispatcherDatabase(config.databasePath);
    assert.deepEqual(database.listJobsNeedingNotification().map(({ job_id }) => job_id), [job.job_id]);
    const notification = database.enqueueJobNotification(job.job_id);
    assert.equal((envelopeFromRow(notification.row).payload.group as Record<string, unknown>).transition, "all_terminal");
    database.close();

    database = new DispatcherDatabase(config.databasePath);
    assert.deepEqual(database.listJobsNeedingNotification(), []);
    assert.equal(database.enqueueJobNotification(job.job_id).row.event_id, notification.row.event_id);
    database.close();
  });

});
