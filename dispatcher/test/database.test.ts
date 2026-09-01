import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterEach, describe, test } from "node:test";

import Database from "better-sqlite3";

import { DispatcherDatabase } from "../src/database.js";
import { envelopeFromRow } from "../src/prompt.js";
import { eventEnvelope, tempConfig } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("DispatcherDatabase", () => {
  test("migrates an existing schema v1 database to the jobs schema", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const legacy = new Database(config.databasePath);
    legacy.exec("CREATE TABLE events (event_id TEXT PRIMARY KEY); PRAGMA user_version = 1;");
    legacy.close();
    const database = new DispatcherDatabase(config.databasePath);
    assert.deepEqual(database.listJobs(), []);
    database.close();
  });

  test("deduplicates the same source event without overwriting its payload", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const first = database.enqueue(eventEnvelope("Ev-1"));
    for (let index = 0; index < 9; index += 1) {
      const duplicate = database.enqueue(eventEnvelope("Ev-1"));
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.row.event_id, first.row.event_id);
      assert.equal(duplicate.row.sequence, first.row.sequence);
    }
    const changed = eventEnvelope("Ev-1");
    changed.payload.text = "different";
    assert.equal(database.enqueue(changed).payloadMismatch, true);

    const redelivery = eventEnvelope("Ev-1");
    redelivery.trace = { socket_envelope_id: "new-delivery-envelope" };
    assert.equal(database.enqueue(redelivery).payloadMismatch, false);
    assert.equal(database.list().length, 1);
    database.close();
  });

  test("selects events by insertion sequence and recovers stale dispatching safely", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const first = database.enqueue(eventEnvelope("Ev-1")).row;
    const second = database.enqueue(eventEnvelope("Ev-2")).row;
    assert.equal(database.nextAvailable()?.event_id, first.event_id);
    database.beginDispatch(first.event_id, `${config.resultsDir}/${first.event_id}.json`);
    assert.equal(database.recoverStaleDispatching(), 1);
    assert.equal(database.get(first.event_id)?.status, "needs_review");
    assert.equal(database.nextAvailable()?.event_id, second.event_id);
    database.close();
  });

  test("requires force before retrying an ambiguous event", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const event = database.enqueue(eventEnvelope("Ev-1")).row;
    database.beginDispatch(event.event_id, `${config.resultsDir}/${event.event_id}.json`);
    database.markNeedsReview(event.event_id, "prompt_timeout", "unknown acceptance");
    assert.throws(() => database.manualRetry(event.event_id, false), /--force/);
    assert.equal(database.manualRetry(event.event_id, true).status, "queued");
    database.close();
  });

  test("does not skip a head event while its retry backoff is active", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const first = database.enqueue(eventEnvelope("Ev-1")).row;
    database.enqueue(eventEnvelope("Ev-2"));
    database.recordPreDispatchFailure(first.event_id, "herdr_unavailable", "offline", 5);
    assert.equal(database.nextAvailable(), undefined);
    database.close();
  });

  test("persists jobs, scopes follow-up input to the Slack thread, and emits one completion event", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-job-source")).row;
    const created = database.createJob(
      { source_event_id: source.event_id, objective: "調査する", workspace: { kind: "scratch" } },
      config.jobsWorkspaceRoot,
      config.jobResultsDir,
    );
    assert.equal(created.duplicate, false);
    assert.match(created.row.job_id, /^job_[0-9a-hjkmnp-tv-z]{26}$/);
    assert.equal(created.row.workspace_path, `${config.jobsWorkspaceRoot}/scratch/${created.row.job_id}`);
    assert.equal(database.createJob(
      { source_event_id: source.event_id, objective: "調査する", workspace: { kind: "scratch" } },
      config.jobsWorkspaceRoot,
      config.jobResultsDir,
    ).duplicate, true);

    const followUp = database.enqueue(eventEnvelope("Ev-job-follow-up")).row;
    database.appendQueuedJobInstruction(created.row.job_id, followUp.event_id, "条件を追加する");
    assert.match(database.getJob(created.row.job_id)!.objective, /条件を追加する/);
    assert.equal(database.listThreadJobs("T_TEST", "C_TEST", "1756722030.123456").length, 1);

    const otherThreadEnvelope = eventEnvelope("Ev-other-thread");
    otherThreadEnvelope.reply_target!.thread_ts = "1756722031.000001";
    otherThreadEnvelope.subject.thread_ts = "1756722031.000001";
    const otherThread = database.enqueue(otherThreadEnvelope).row;
    assert.throws(
      () => database.appendQueuedJobInstruction(created.row.job_id, otherThread.event_id, "wrong thread"),
      /does not belong/,
    );

    database.beginJobPreparation(created.row.job_id);
    database.setJobRuntime(created.row.job_id, "1", "w1:p1");
    database.beginJobDispatch(created.row.job_id);
    database.markJobRunning(created.row.job_id);
    database.saveJobResult(created.row.job_id, {
      schema_version: 1,
      job_id: created.row.job_id,
      status: "completed",
      summary: "完了",
      output: { format: "markdown", text: "結果" },
      completed_at: new Date().toISOString(),
    }, created.row.result_path);
    const notification = database.enqueueJobNotification(created.row.job_id);
    const duplicate = database.enqueueJobNotification(created.row.job_id);
    assert.equal(notification.row.source, "dona_job");
    assert.equal(notification.row.event_type, "job_completed");
    assert.equal(envelopeFromRow(notification.row).source, "dona_job");
    assert.equal(duplicate.row.event_id, notification.row.event_id);
    database.close();
  });
});
