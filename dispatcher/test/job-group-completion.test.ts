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
    }
    database.close();
  });
  test("claims attention and all-terminal transitions for a group containing a failure", async () => {
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

    assert.equal(database.listJobsNeedingNotification()[0]?.job_id, blocked.job_id);
    const allTerminal = database.enqueueJobNotification(blocked.job_id, new Date("2026-09-05T00:04:00.000Z"));
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
