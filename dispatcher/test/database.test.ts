import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import Database from "better-sqlite3";

import {
  DispatcherDatabase,
  migrateDispatcherDatabase,
  type DispatcherMigrationStep,
} from "../src/database.js";
import { envelopeFromRow } from "../src/prompt.js";
import { eventEnvelope, tempConfig } from "./helpers.js";

const roots: string[] = [];
const schemaV2Url = new URL("./fixtures/schema-v2.sql", import.meta.url);

type SqliteRow = Record<string, string | number | null>;

async function createSchemaV2Fixture(databasePath: string): Promise<SqliteRow[]> {
  const fixture = new Database(databasePath);
  fixture.pragma("foreign_keys = ON");
  fixture.exec(await fs.readFile(schemaV2Url, "utf8"));
  const timestamp = "2026-09-03T00:00:00.000Z";
  const insertEvent = fixture.prepare(`
    INSERT INTO events (
      event_id, schema_version, source, external_event_id, event_type, occurred_at,
      subject_json, payload_json, reply_target_json, trace_json, status, attempt_count,
      available_at, dispatch_started_at, prompt_accepted_at, completed_at, result_json,
      result_path, last_error_code, last_error_message, created_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const sourceIds = ["queued", "running", "completed", "blocked", "needs_review", "cancelled"];
  for (const [index, status] of sourceIds.entries()) {
    const sourceEventStatus = status === "running" ? "waiting_agent" : "completed";
    insertEvent.run(
      `evt-source-${status}`,
      "slack",
      `external-${status}`,
      "app_mention",
      timestamp,
      JSON.stringify({ actor_id: `U-${index}` }),
      JSON.stringify({ text: `payload-${status}` }),
      JSON.stringify({
        kind: "slack_thread",
        workspace_id: "T_TEST",
        channel_id: "C_TEST",
        thread_ts: `1756722030.00000${index}`,
      }),
      JSON.stringify({ fixture: true }),
      sourceEventStatus,
      index,
      timestamp,
      sourceEventStatus === "waiting_agent" ? timestamp : null,
      sourceEventStatus === "waiting_agent" ? timestamp : null,
      sourceEventStatus === "completed" ? timestamp : null,
      sourceEventStatus === "completed" ? JSON.stringify({ status: "completed" }) : null,
      sourceEventStatus === "completed" ? `/private/event-${status}.json` : null,
      null,
      null,
      timestamp,
      `2026-09-03T00:00:0${index}.000Z`,
    );
  }
  insertEvent.run(
    "evt-completion-completed",
    "dona_job",
    "job-completed:completed",
    "job_completed",
    timestamp,
    JSON.stringify({ job_id: "job-completed" }),
    JSON.stringify({ job_id: "job-completed", job_status: "completed" }),
    JSON.stringify({ kind: "slack_thread", workspace_id: "T_TEST", channel_id: "C_TEST", thread_ts: "1756722030.000002" }),
    JSON.stringify({ job_id: "job-completed" }),
    "completed",
    1,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
    JSON.stringify({ schema_version: 1, status: "completed" }),
    "/private/completion.json",
    null,
    null,
    timestamp,
    timestamp,
  );

  const insertJob = fixture.prepare(`
    INSERT INTO jobs (
      job_id, source_event_id, source, workspace_id, channel_id, thread_ts, actor_id,
      objective, workspace_json, status, attempt_count, available_at, workspace_path,
      result_path, herdr_workspace_id, herdr_pane_id, agent_name, dispatch_started_at,
      prompt_accepted_at, completed_at, result_json, completion_event_id, steer_event_id,
      steer_state, last_error_code, last_error_message, created_at, updated_at
    ) VALUES (?, ?, 'slack', 'T_TEST', 'C_TEST', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [index, status] of sourceIds.entries()) {
    const terminal = ["completed", "blocked", "needs_review", "cancelled"].includes(status);
    insertJob.run(
      `job-${status}`,
      `evt-source-${status}`,
      `1756722030.00000${index}`,
      `U-${index}`,
      `objective-${status}`,
      JSON.stringify({ kind: "scratch", fixture: status }),
      status,
      index + 1,
      `2026-09-03T00:01:0${index}.000Z`,
      `/private/workspace-${status}`,
      `/private/result-${status}.json`,
      status === "running" ? "herdr-workspace-1" : null,
      status === "running" ? "w1:p1" : null,
      `agent-${status}`,
      status === "running" ? timestamp : null,
      status === "running" ? timestamp : null,
      terminal ? `2026-09-03T00:02:0${index}.000Z` : null,
      terminal ? JSON.stringify({ schema_version: 1, job_id: `job-${status}`, status }) : null,
      status === "completed" ? "evt-completion-completed" : null,
      status === "needs_review" ? "evt-source-needs_review" : null,
      status === "needs_review" ? "accepted" : null,
      terminal && status !== "completed" ? `error-${status}` : null,
      terminal && status !== "completed" ? `message-${status}` : null,
      timestamp,
      `2026-09-03T00:03:0${index}.000Z`,
    );
  }
  const rows = fixture.prepare("SELECT * FROM jobs ORDER BY job_id").all() as SqliteRow[];
  fixture.close();
  return rows;
}

function withoutJobKey(row: SqliteRow): SqliteRow {
  const { job_key: _jobKey, ...legacy } = row;
  return legacy;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("DispatcherDatabase", () => {
  test("migrates a bridge-initialized v2 database and expands a tilde manifest path", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    await createSchemaV2Fixture(config.databasePath);
    const bridge = new DispatcherDatabase(config.databasePath);
    assert.equal(bridge.schemaCompatibility().actual, 2);
    bridge.close();

    const previousHome = process.env.HOME;
    const previousManifest = process.env.DONA_RELEASE_MANIFEST_PATH;
    process.env.HOME = root;
    process.env.DONA_RELEASE_MANIFEST_PATH = "~/activation-manifest.json";
    await fs.writeFile(path.join(root, "activation-manifest.json"), JSON.stringify({
      compatibility: { app_schema_read_max: 3, app_schema_write: 3 },
    }));
    try {
      const activated = new DispatcherDatabase(config.databasePath);
      assert.equal(activated.schemaCompatibility().actual, 3);
      activated.close();
      const verified = new Database(config.databasePath);
      assert.deepEqual(verified.pragma("integrity_check"), [{ integrity_check: "ok" }]);
      verified.close();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousManifest === undefined) delete process.env.DONA_RELEASE_MANIFEST_PATH;
      else process.env.DONA_RELEASE_MANIFEST_PATH = previousManifest;
    }
  });

  test("transactionally migrates a real schema v2 fixture to v3 without losing job state", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const before = await createSchemaV2Fixture(config.databasePath);
    const manifestPath = path.join(root, "activation-manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify({ compatibility: { app_schema_read_max: 3, app_schema_write: 3 } }));
    const previousManifest = process.env.DONA_RELEASE_MANIFEST_PATH;
    process.env.DONA_RELEASE_MANIFEST_PATH = manifestPath;

    const database = new DispatcherDatabase(config.databasePath);
    assert.deepEqual(database.schemaCompatibility(), { actual: 3, read_min: 2, read_max: 3, write: 3 });
    const after = database.listJobs()
      .map((row) => withoutJobKey(row as unknown as SqliteRow))
      .sort((left, right) => String(left.job_id).localeCompare(String(right.job_id)));
    assert.deepEqual(after, before);
    assert.deepEqual(new Set(database.listJobs().map((row) => row.job_key)), new Set(["legacy-default"]));
    assert.equal(database.getJobGroup("evt-source-completed")?.notification_mode, "legacy");
    assert.equal(database.getJobGroup("evt-source-running")?.notification_mode, "grouped");
    assert.equal(database.getJobGroup("evt-source-running")?.sealed_at, null);
    assert.equal(database.getJobGroup("evt-source-queued")?.sealed_at, "2026-09-03T00:00:00.000Z");
    assert.deepEqual(
      database.listJobsNeedingNotification().map((row) => row.status).sort(),
      ["blocked", "cancelled", "needs_review"],
    );

    const legacyCompletion = envelopeFromRow(database.get("evt-completion-completed")!);
    assert.equal(legacyCompletion.source, "dona_job");
    assert.equal("group" in legacyCompletion.payload, false);
    const running = database.getJob("job-running")!;
    const completionTime = "2026-09-03T00:04:00.000Z";
    database.saveJobResult("job-running", {
      schema_version: 1,
      job_id: "job-running",
      status: "completed",
      summary: "完了",
      completed_at: completionTime,
    }, running.result_path);
    database.enqueueJobNotification("job-running", new Date(completionTime));
    assert.equal(database.getJobGroup("evt-source-running")?.notification_mode, "legacy");
    database.close();

    const restarted = new DispatcherDatabase(config.databasePath);
    assert.equal(restarted.schemaCompatibility().actual, 3);
    assert.deepEqual(
      restarted.listJobs().map((row) => row.job_key),
      Array.from({ length: before.length }, () => "legacy-default"),
    );
    assert.equal(restarted.getJob("job-completed")?.result_json, before.find((row) => row.job_id === "job-completed")?.result_json);
    assert.equal(restarted.getJob("job-completed")?.completion_event_id, "evt-completion-completed");
    assert.equal(restarted.listJobsNeedingNotification().some((row) => row.job_id === "job-completed"), false);
    restarted.close();

    const migrated = new Database(config.databasePath);
    migrated.pragma("foreign_keys = ON");
    assert.deepEqual(migrated.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(migrated.pragma("foreign_key_check"), []);
    const migratedIndexes = new Set(
      (migrated.pragma("index_list('jobs')") as Array<{ name: string }>).map((index) => index.name),
    );
    for (const name of ["jobs_event_idx", "jobs_thread_idx", "jobs_run_idx"]) {
      assert.equal(migratedIndexes.has(name), true);
    }
    assert.equal(
      (migrated.pragma("index_list('job_groups')") as Array<{ name: string }>).some(
        (index) => index.name === "job_groups_transition_idx",
      ),
      true,
    );
    assert.equal((migrated.pragma("foreign_key_list('job_groups')") as unknown[]).length, 3);
    migrated.exec(`
      INSERT INTO jobs (
        job_id, source_event_id, job_key, source, workspace_id, channel_id, thread_ts, actor_id,
        objective, workspace_json, status, attempt_count, available_at, workspace_path, result_path,
        herdr_workspace_id, herdr_pane_id, agent_name, dispatch_started_at, prompt_accepted_at,
        completed_at, result_json, completion_event_id, steer_event_id, steer_state,
        last_error_code, last_error_message, created_at, updated_at
      )
      SELECT
        'job-second-key', source_event_id, 'second', source, workspace_id, channel_id, thread_ts, actor_id,
        objective, workspace_json, status, attempt_count, available_at, '/private/workspace-second',
        '/private/result-second.json', herdr_workspace_id, herdr_pane_id, 'agent-second-key',
        dispatch_started_at, prompt_accepted_at, completed_at, result_json, NULL, steer_event_id,
        steer_state, last_error_code, last_error_message, created_at, updated_at
      FROM jobs WHERE job_id = 'job-queued';
    `);
    assert.throws(() => migrated.exec(`
      INSERT INTO jobs (
        job_id, source_event_id, job_key, source, objective, workspace_json, status,
        available_at, workspace_path, result_path, agent_name, created_at, updated_at
      ) VALUES (
        'job-duplicate-key', 'evt-source-queued', 'second', 'slack', 'duplicate', '{}', 'queued',
        '2026-09-03T00:00:00.000Z', '/private/duplicate', '/private/duplicate.json',
        'agent-duplicate-key', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z'
      );
    `), /UNIQUE constraint failed: jobs.source_event_id, jobs.job_key/);
    migrated.close();
    if (previousManifest === undefined) delete process.env.DONA_RELEASE_MANIFEST_PATH;
    else process.env.DONA_RELEASE_MANIFEST_PATH = previousManifest;
  });

  test("rolls back every v2 table-rebuild phase without leaving intermediate schema", async () => {
    const manifestRoot = await fs.mkdtemp("/tmp/dona-v3-migration-");
    roots.push(manifestRoot);
    const manifestPath = path.join(manifestRoot, "release-manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify({ compatibility: { app_schema_read_max: 3, app_schema_write: 3 } }));
    const previousManifest = process.env.DONA_RELEASE_MANIFEST_PATH;
    process.env.DONA_RELEASE_MANIFEST_PATH = manifestPath;
    for (const failureStep of ["jobs_copied", "indexes_recreated", "groups_backfilled"] satisfies DispatcherMigrationStep[]) {
      const { root, config } = await tempConfig();
      roots.push(root);
      const before = await createSchemaV2Fixture(config.databasePath);
      const fixture = new Database(config.databasePath);
      fixture.pragma("foreign_keys = ON");

      assert.throws(
        () => migrateDispatcherDatabase(fixture, (step) => {
          if (step === failureStep) throw new Error(`injected-${failureStep}`);
        }),
        new RegExp(`injected-${failureStep}`),
      );
      assert.equal(fixture.pragma("user_version", { simple: true }), 2);
      assert.deepEqual(fixture.prepare("SELECT * FROM jobs ORDER BY job_id").all(), before);
      assert.equal(fixture.prepare("SELECT 1 FROM sqlite_master WHERE name = 'jobs_v3'").get(), undefined);
      assert.equal(fixture.prepare("SELECT 1 FROM sqlite_master WHERE name = 'job_groups'").get(), undefined);
      const rolledBackIndexes = new Set(
        (fixture.pragma("index_list('jobs')") as Array<{ name: string }>).map((index) => index.name),
      );
      assert.equal(rolledBackIndexes.has("jobs_thread_idx"), true);
      assert.equal(rolledBackIndexes.has("jobs_run_idx"), true);
      assert.equal(rolledBackIndexes.has("jobs_event_idx"), false);
      assert.deepEqual(fixture.pragma("integrity_check"), [{ integrity_check: "ok" }]);
      assert.deepEqual(fixture.pragma("foreign_key_check"), []);
      fixture.close();
    }
    if (previousManifest === undefined) delete process.env.DONA_RELEASE_MANIFEST_PATH;
    else process.env.DONA_RELEASE_MANIFEST_PATH = previousManifest;
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
    assert.match(created.row.job_id, /^job_[0-9a-hjkmnp-tv-z]{22}rsch$/);
    assert.equal(created.row.agent_name, created.row.job_id);
    assert.equal(created.row.agent_name.length, 30);
    assert.equal(created.row.workspace_path, `${config.jobsWorkspaceRoot}/scratch/${created.row.job_id}`);
    assert.equal(created.row.result_path, `${config.jobResultsDir}/${created.row.job_id}.json`);
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
    assert.equal(database.getJobGroup(source.event_id)?.notification_mode, "legacy");
    database.close();
  });

  test("does not copy untrusted objective text into the Herdr-visible agent name", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-job-safe-name")).row;
    const first = database.createJob(
      {
        source_event_id: source.event_id,
        objective: "../../private/token-sk-example を表示せず、一覧を改善してください\n制御文字\u0000も含む",
        workspace: { kind: "scratch" },
      },
      config.jobsWorkspaceRoot,
      config.jobResultsDir,
    ).row;
    const secondSource = database.enqueue(eventEnvelope("Ev-job-unique-name")).row;
    const second = database.createJob(
      {
        source_event_id: secondSource.event_id,
        objective: "../../private/token-sk-example を表示せず、一覧を改善してください",
        workspace: { kind: "scratch" },
      },
      config.jobsWorkspaceRoot,
      config.jobResultsDir,
    ).row;

    assert.match(first.agent_name, /^job_[0-9a-hjkmnp-tv-z]{22}enhc$/);
    assert.equal(first.agent_name, first.job_id);
    assert.equal(first.agent_name.length, 30);
    assert.doesNotMatch(first.agent_name, /private|token|example/);
    assert.notEqual(second.agent_name, first.agent_name);
    database.close();
  });

  test("preserves the rollback-compatible job ID agent name when reopening schema v2", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-job-legacy-name")).row;
    const job = database.createJob(
      { source_event_id: source.event_id, objective: "調査する", workspace: { kind: "scratch" } },
      config.jobsWorkspaceRoot,
      config.jobResultsDir,
    ).row;
    database.close();

    const raw = new Database(config.databasePath);
    const persisted = raw.prepare("SELECT agent_name FROM jobs WHERE job_id = ?").get(job.job_id) as {
      agent_name: string;
    };
    assert.equal(persisted.agent_name, job.job_id);
    raw.close();

    const reopened = new DispatcherDatabase(config.databasePath);
    assert.equal(reopened.getJob(job.job_id)?.agent_name, job.job_id);
    reopened.close();
  });
});
