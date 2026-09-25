import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import Database from "better-sqlite3";

import {
  DispatcherDatabase,
  JobCreationError,
  migrateDispatcherDatabase,
  type DispatcherMigrationStep,
} from "../src/database.js";
import { envelopeFromRow } from "../src/prompt.js";
import { jobWorkspaceLabel } from "../src/job-display-label.js";
import { canonicalJobPayloadSha256, parseCreateJobRequest } from "../src/validation.js";
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
  test("transactionally migrates a real schema v2 fixture to v3 without losing job state", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const before = await createSchemaV2Fixture(config.databasePath);
    const migration = new Database(config.databasePath);
    migrateDispatcherDatabase(migration, () => {}, false, 3);
    migration.close();

    const database = new DispatcherDatabase(config.databasePath);
    assert.deepEqual(database.schemaCompatibility(), { actual: 3, read_min: 2, read_max: 3, write: 3 });
    const after = database.listJobs()
      .map((row) => withoutJobKey(row as unknown as SqliteRow))
      .sort((left, right) => String(left.job_id).localeCompare(String(right.job_id)));
    assert.deepEqual(after, before);
    assert.deepEqual(new Set(database.listJobs().map((row) => row.job_key)), new Set(["legacy-default"]));
    assert.equal(
      database.reconcileEventJob("evt-source-queued", "legacy-default", "0".repeat(64)),
      "unverified_legacy",
    );
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
    for (const name of ["jobs_event_idx", "jobs_thread_idx", "jobs_run_idx", "jobs_runnable_fair_idx", "jobs_workspace_job_idx", "jobs_nonterminal_workspace_job_idx", "jobs_status_job_idx", "jobs_nonterminal_job_idx"]) {
      assert.equal(migratedIndexes.has(name), true);
    }
    const workspacePlan=migrated.prepare("EXPLAIN QUERY PLAN SELECT job_id FROM jobs WHERE workspace_id=? AND job_id>? ORDER BY job_id LIMIT 500").all("T1","") as Array<{detail:string}>;
    assert.equal(workspacePlan.some((step)=>step.detail.includes("jobs_workspace_job_idx")),true);
    const nonterminalPlan=migrated.prepare("EXPLAIN QUERY PLAN SELECT * FROM jobs WHERE job_id>? AND status NOT IN ('blocked','completed','failed','cancelled','needs_review') ORDER BY job_id LIMIT 500").all("") as Array<{detail:string}>;
    assert.equal(nonterminalPlan.some((step)=>step.detail.includes("jobs_nonterminal_job_idx")),true);
    const workspaceNonterminalPlan=migrated.prepare("EXPLAIN QUERY PLAN SELECT job_id FROM jobs WHERE workspace_id=? AND job_id>? AND status NOT IN ('blocked','completed','failed','cancelled','needs_review') ORDER BY job_id LIMIT 500").all("T1","") as Array<{detail:string}>;
    assert.equal(workspaceNonterminalPlan.some((step)=>step.detail.includes("jobs_nonterminal_workspace_job_idx")),true);
    const runnablePlan = migrated.prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM jobs INDEXED BY jobs_runnable_fair_idx
      WHERE status = 'queued' AND available_at <= ?
        AND source_event_id > ?
        AND source_event_id <= ?
      ORDER BY source_event_id, created_at, job_id
      LIMIT 1
    `).all("2026-09-04T00:00:00.000Z", "", "evt_zzzz") as Array<{ detail: string }>;
    assert.equal(runnablePlan.some(({ detail }) => detail.includes("jobs_runnable_fair_idx")), true);
    assert.equal(runnablePlan.some(({ detail }) => detail.includes("TEMP B-TREE")), false);
    const runnableIndexSql = migrated.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'jobs_runnable_fair_idx'
    `).pluck().get() as string;
    assert.match(runnableIndexSql, /WHERE status = 'queued'/);
    assert.doesNotMatch(runnableIndexSql, /retryable_failed/);
    const cycleEndPlan = migrated.prepare(`
      EXPLAIN QUERY PLAN
      SELECT source_event_id FROM jobs INDEXED BY jobs_runnable_fair_idx
      WHERE status = 'queued' AND available_at <= ?
      ORDER BY source_event_id DESC
      LIMIT 1
    `).all("2026-09-04T00:00:00.000Z") as Array<{ detail: string }>;
    assert.equal(cycleEndPlan.some(({ detail }) => detail.includes("jobs_runnable_fair_idx")), true);
    assert.equal(cycleEndPlan.some(({ detail }) => detail.includes("TEMP B-TREE")), false);
    const retryPromotionPlan = migrated.prepare(`
      EXPLAIN QUERY PLAN
      UPDATE jobs INDEXED BY jobs_run_idx
      SET status = 'queued', updated_at = ?
      WHERE status = 'retryable_failed' AND available_at <= ?
    `).all("2026-09-04T00:00:00.000Z", "2026-09-04T00:00:00.000Z") as Array<{ detail: string }>;
    assert.equal(retryPromotionPlan.some(({ detail }) => detail.includes("jobs_run_idx")), true);
    assert.equal(retryPromotionPlan.some(({ detail }) => detail.includes("TEMP B-TREE")), false);
    const retryPlan = migrated.prepare(`
      EXPLAIN QUERY PLAN
      SELECT available_at FROM jobs INDEXED BY jobs_run_idx
      WHERE status = ? AND available_at > ?
      ORDER BY available_at, created_at
      LIMIT 1
    `).all("retryable_failed", "2026-09-04T00:00:00.000Z") as Array<{ detail: string }>;
    assert.equal(retryPlan.some(({ detail }) => detail.includes("jobs_run_idx")), true);
    assert.equal(retryPlan.some(({ detail }) => detail.includes("TEMP B-TREE")), false);
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
    migrated.exec(`
      DROP INDEX jobs_runnable_fair_idx;
      CREATE INDEX jobs_runnable_fair_idx
        ON jobs(source_event_id, created_at, job_id, available_at)
        WHERE status IN ('queued', 'retryable_failed');
    `);
    migrated.close();

    const existingV3 = new DispatcherDatabase(config.databasePath);
    assert.doesNotThrow(() => existingV3.nextRunnableJob(new Date("2026-09-04T00:00:00.000Z")));
    existingV3.close();
    const reopened = new Database(config.databasePath);
    const repairedIndexSql = reopened.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'jobs_runnable_fair_idx'
    `).pluck().get() as string;
    assert.match(repairedIndexSql, /WHERE status = 'queued'/);
    assert.doesNotMatch(repairedIndexSql, /retryable_failed/);
    reopened.close();
  });

  test("rolls back every v2 table-rebuild phase without leaving intermediate schema", async () => {
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
  });

  test("does not guess schema-v3 write activation for an existing v2 database without a release manifest", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    await createSchemaV2Fixture(config.databasePath);

    const previousManifest = process.env.DONA_RELEASE_MANIFEST_PATH;
    delete process.env.DONA_RELEASE_MANIFEST_PATH;
    try {
      const database = new DispatcherDatabase(config.databasePath);
      assert.deepEqual(database.schemaCompatibility(), { actual: 2, read_min: 2, read_max: 3, write: 2 });
      database.close();
    } finally {
      if (previousManifest === undefined) delete process.env.DONA_RELEASE_MANIFEST_PATH;
      else process.env.DONA_RELEASE_MANIFEST_PATH = previousManifest;
    }

    const reopened = new Database(config.databasePath, { readonly: true });
    assert.equal(reopened.pragma("user_version", { simple: true }), 2);
    assert.equal((reopened.pragma("table_info(jobs)") as Array<{ name: string }>).some(({ name }) => name === "job_key"), true);
    assert.notEqual(reopened.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'job_groups'").get(), undefined);
    reopened.close();
  });

  test("移行したv2 jobのpayloadを推測せず不一致reuseを拒否する", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    await createSchemaV2Fixture(config.databasePath);
    const fixture = new Database(config.databasePath);
    fixture.prepare("UPDATE jobs SET objective = ? WHERE job_id = 'job-queued'")
      .run(`objective-queued\n\n[DONA_FOLLOW_UP]\n${"x".repeat(100_001)}\n[/DONA_FOLLOW_UP]`);
    fixture.close();

    const database = new DispatcherDatabase(config.databasePath);
    assert.equal(
      database.reconcileEventJob("evt-source-queued", "legacy-default", "0".repeat(64)),
      "unverified_legacy",
    );
    const before = database.getJob("job-queued");
    for (const workspace of [{kind:"scratch" as const},{kind:"github" as const,repository:"owner/repo"}]) {
      assert.throws(() => database.createJob({
        source_event_id: "evt-source-queued", objective: "objective-queued", workspace,
      }, config.jobsWorkspaceRoot, config.jobResultsDir),
      error => error instanceof JobCreationError && error.code === "job_idempotency_conflict");
    }
    assert.deepEqual(database.getJob("job-queued"),before);
    assert.equal(database.reconcileEventJob("evt-source-queued","legacy-default","0".repeat(64)),"unverified_legacy");
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
    }
    database.close();
  });

  test("creates distinct keyed jobs and reconciles reuse, conflict, and closed groups", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-keyed-jobs")).row;
    database.beginDispatch(source.event_id, `${config.resultsDir}/${source.event_id}.json`);
    database.markWaiting(source.event_id);
    const firstRequest = {
      source_event_id: source.event_id,
      job_key: "research.primary",
      objective: "  first objective  ",
      workspace: { kind: "scratch" as const },
    };
    const firstCanonicalPayloadSha256 = canonicalJobPayloadSha256(parseCreateJobRequest(firstRequest));
    const first = database.createJob(firstRequest, config.jobsWorkspaceRoot, config.jobResultsDir);
    assert.throws(() => database.createJob({
      source_event_id: source.event_id,
      objective: "implicit legacy job",
      workspace: { kind: "scratch" },
    }, config.jobsWorkspaceRoot, config.jobResultsDir), (error) =>
      error instanceof JobCreationError && error.code === "job_group_closed");
    const second = database.createJob({
      source_event_id: source.event_id,
      job_key: "research.secondary",
      objective: "second objective",
      workspace: { kind: "github", repository: "owner/repo", base_ref: "main" },
    }, config.jobsWorkspaceRoot, config.jobResultsDir);

    assert.equal(first.outcome, "created");
    assert.equal(first.duplicate, false);
    assert.equal(first.row.objective, "first objective");
    assert.equal(second.outcome, "created");
    assert.notEqual(first.row.job_id, second.row.job_id);
    assert.notEqual(first.row.workspace_path, second.row.workspace_path);
    assert.notEqual(first.row.result_path, second.row.result_path);
    assert.notEqual(first.row.agent_name, second.row.agent_name);
    assert.equal(database.getJobGroup(source.event_id)?.notification_mode, "grouped");

    const reused = database.createJob(
      firstRequest,
      config.jobsWorkspaceRoot,
      config.jobResultsDir,
    );
    assert.equal(reused.outcome, "reused");
    assert.equal(reused.duplicate, true);
    assert.equal(reused.row.job_id, first.row.job_id);

    const followUp = database.enqueue(eventEnvelope("Ev-keyed-jobs-follow-up")).row;
    database.appendQueuedJobInstruction(first.row.job_id, followUp.event_id, "include the latest data");
    assert.match(database.getJob(first.row.job_id)!.objective, /include the latest data/);
    const reusedAfterSteer = database.createJob(firstRequest, config.jobsWorkspaceRoot, config.jobResultsDir);
    assert.equal(reusedAfterSteer.outcome, "reused");
    assert.equal(reusedAfterSteer.row.job_id, first.row.job_id);
    assert.equal(
      database.reconcileEventJob(source.event_id, first.row.job_key, firstCanonicalPayloadSha256),
      "matched",
    );

    const persistedBeforeConflict = database.getJob(first.row.job_id);
    assert.throws(
      () => database.createJob(
        { ...firstRequest, objective: "different" },
        config.jobsWorkspaceRoot,
        config.jobResultsDir,
      ),
      (error) => error instanceof JobCreationError && error.code === "job_idempotency_conflict",
    );
    assert.deepEqual(database.getJob(first.row.job_id), persistedBeforeConflict);
    assert.equal(database.listEventJobs(source.event_id).length, 2);

    database.beginJobPreparation(first.row.job_id);
    database.setJobRuntime(first.row.job_id, "workspace-1", "pane-1");
    database.beginJobDispatch(first.row.job_id);
    database.markJobRunning(first.row.job_id);
    database.saveJobResult(first.row.job_id, {
      schema_version: 1,
      job_id: first.row.job_id,
      status: "completed",
      summary: "first completed",
      completed_at: new Date().toISOString(),
    }, first.row.result_path);
    assert.deepEqual(database.listJobsNeedingNotification(), []);
    assert.throws(() => database.enqueueJobNotification(first.row.job_id), /is not sealed/);
    const createdAfterSiblingCompletion = database.createJob({
      source_event_id: source.event_id,
      job_key: "research.after-sibling",
      objective: "third objective",
      workspace: { kind: "scratch" },
    }, config.jobsWorkspaceRoot, config.jobResultsDir);
    assert.equal(createdAfterSiblingCompletion.outcome, "created");

    database.saveCompleted(source.event_id, {
      schema_version: 1,
      event_id: source.event_id,
      status: "completed",
      summary: "delegation complete",
      actions: [],
      memory_candidates: [],
      completed_at: new Date().toISOString(),
    }, `${config.resultsDir}/${source.event_id}.json`);
    const notification = database.enqueueJobNotification(first.row.job_id);
    const notificationPayload = envelopeFromRow(notification.row).payload;
    assert.deepEqual(notificationPayload.workspace, { kind: "scratch" });
    const groupSnapshot = notificationPayload.group as Record<string, unknown>;
    assert.equal(groupSnapshot.source_event_id, source.event_id);
    assert.equal(groupSnapshot.total, 3);
    assert.equal(groupSnapshot.pending, 2);
    assert.deepEqual(groupSnapshot.status_counts, { completed: 1, queued: 2 });
    assert.equal(groupSnapshot.transition, "progress");
    assert.deepEqual(
      (groupSnapshot.jobs as Array<{ job_key: string }>).map(({ job_key }) => job_key).sort(),
      ["research.after-sibling", "research.primary", "research.secondary"],
    );
    assert.equal(database.getJobGroup(source.event_id)?.notification_mode, "grouped");
    assert.notEqual(database.getJobGroup(source.event_id)?.sealed_at, null);
    assert.equal(
      database.createJob(firstRequest, config.jobsWorkspaceRoot, config.jobResultsDir).outcome,
      "reused",
    );
    assert.throws(
      () => database.createJob({
        source_event_id: source.event_id,
        job_key: "research.after-completion",
        objective: "fourth objective",
        workspace: { kind: "scratch" },
      }, config.jobsWorkspaceRoot, config.jobResultsDir),
      (error) => error instanceof JobCreationError && error.code === "job_group_closed",
    );
    assert.deepEqual(database.listEventJobs(source.event_id, "missing"), []);
    assert.equal(
      database.reconcileEventJob(source.event_id, first.row.job_key, firstCanonicalPayloadSha256),
      "matched",
    );
    assert.equal(database.reconcileEventJob(source.event_id, first.row.job_key, "0".repeat(64)), "conflict");
    assert.equal(database.reconcileEventJob(source.event_id, "missing", "0".repeat(64)), "not_found");
    assert.deepEqual(
      database.listEventJobs(source.event_id, first.row.job_key).map(({ job_id }) => job_id),
      [first.row.job_id],
    );
    assert.equal(JSON.stringify(database.listEventJobs(source.event_id)).includes(config.jobsWorkspaceRoot), false);
    assert.equal(JSON.stringify(database.listEventJobs(source.event_id)).includes("first objective"), false);
    database.close();
  });

  test("enforces count admission transactionally while preserving idempotent reuse", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const limits = { jobsPerEventMax: 3, jobObjectiveTotalMaxBytes: 400_000 };
    const database = new DispatcherDatabase(config.databasePath, limits);
    const competingConnection = new DispatcherDatabase(config.databasePath, limits);
    const source = database.enqueue(eventEnvelope("Ev-job-count-limit")).row;
    const request = (jobKey: string) => ({
      source_event_id: source.event_id,
      job_key: jobKey,
      objective: `objective ${jobKey}`,
      workspace: { kind: "scratch" as const },
    });

    const first = database.createJob(request("job.one"), config.jobsWorkspaceRoot, config.jobResultsDir);
    const second = competingConnection.createJob(
      request("job.two"),
      config.jobsWorkspaceRoot,
      config.jobResultsDir,
    );
    const cancellation = database.enqueue(eventEnvelope("Ev-job-count-cancel")).row;
    database.beginJobCancellation(first.row.job_id, cancellation.event_id);
    database.markJobCancelled(first.row.job_id, "test cancellation");
    database.beginJobPreparation(second.row.job_id);
    database.recordJobPreparationFailure(second.row.job_id, "worker_start_failed", "failed", 1);
    const third = competingConnection.createJob(
      request("job.three"),
      config.jobsWorkspaceRoot,
      config.jobResultsDir,
    );

    assert.equal(database.listEventJobs(source.event_id).length, 3);
    assert.equal(database.createJob(
      request("job.three"),
      config.jobsWorkspaceRoot,
      config.jobResultsDir,
    ).row.job_id, third.row.job_id);
    assert.throws(
      () => competingConnection.createJob(
        request("job.four"),
        config.jobsWorkspaceRoot,
        config.jobResultsDir,
      ),
      (error) => error instanceof JobCreationError &&
        error.code === "job_group_limit_exceeded" &&
        error.limitDetails?.resource === "jobs_per_event" &&
        error.limitDetails.attempted === 4,
    );
    assert.equal(database.listEventJobs(source.event_id).length, 3);
    competingConnection.close();
    database.close();
  });

  for (const resource of ["jobs_per_event", "objective_utf8_bytes_per_event"] as const) {
    test(`serializes independent process INSERTs competing for the last ${resource} allowance`, { timeout: 15_000 }, async (t) => {
      const { root, config } = await tempConfig();
      roots.push(root);
      const limits = {
        jobsPerEventMax: resource === "jobs_per_event" ? 2 : 8,
        jobObjectiveTotalMaxBytes: resource === "jobs_per_event" ? 400_000 : 6,
      };
      const database = new DispatcherDatabase(config.databasePath, limits);
      t.after(() => database.close());
      const source = database.enqueue(eventEnvelope(`Ev-process-${resource}`)).row;
      const request = (jobKey: string) => ({
        source_event_id: source.event_id, job_key: jobKey,
        objective: "あ", workspace: { kind: "scratch" as const },
      });
      const seed = database.createJob(request("seed"), config.jobsWorkspaceRoot, config.jobResultsDir);
      const children = ["competitor.one", "competitor.two"].map((key) => {
        const child = fork(new URL("./fixtures/job-admission-child.ts", import.meta.url), [], {
          execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"],
        });
        t.after(() => { if (child.exitCode === null) child.kill(); });
        const ready = once(child, "message");
        const exited = once(child, "exit");
        child.send({
          databasePath: config.databasePath, limits, request: request(key),
          workspaceRoot: config.jobsWorkspaceRoot, resultDir: config.jobResultsDir,
        });
        return { child, ready, exited, key };
      });
      assert.deepEqual((await Promise.all(children.map(({ ready }) => ready))).map(([value]) => value), [{ ready: true }, { ready: true }]);
      const results = children.map(({ child }) => once(child, "message"));
      for (const { child } of children) child.send({ go: true });
      const outcomes = (await Promise.all(results)).map(([value]) => value);
      assert.deepEqual(await Promise.all(children.map(({ exited }) => exited)), [[0, null], [0, null]]);
      assert.equal(outcomes.filter((value) => value.outcome === "created").length, 1);
      const rejected = outcomes.filter((value) => value.code === "job_group_limit_exceeded");
      assert.equal(rejected.length, 1);
      assert.deepEqual(rejected[0].details, {
        resource,
        current: resource === "jobs_per_event" ? 2 : 6,
        attempted: resource === "jobs_per_event" ? 3 : 9,
        maximum: resource === "jobs_per_event" ? 2 : 6,
      });
      const rows = database.listEventJobs(source.event_id);
      assert.equal(rows.length, 2);
      assert.equal(rows.reduce((sum, row) => sum + Buffer.byteLength(database.getJob(row.job_id)!.objective, "utf8"), 0), 6);
      assert.equal(database.createJob(request("seed"), config.jobsWorkspaceRoot, config.jobResultsDir).row.job_id, seed.row.job_id);
      const winnerIndex = outcomes.findIndex((value) => value.outcome === "created");
      const reused = database.createJob(request(children[winnerIndex]!.key), config.jobsWorkspaceRoot, config.jobResultsDir);
      assert.equal(reused.outcome, "reused");
      assert.equal(reused.row.job_id, outcomes[winnerIndex].jobId);
    });
  }

  test("allows the default eight jobs and rejects the ninth", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-default-job-limit")).row;
    for (let index = 1; index <= 8; index += 1) {
      database.createJob({
        source_event_id: source.event_id,
        job_key: `default.${index}`,
        objective: `objective ${index}`,
        workspace: { kind: "scratch" },
      }, config.jobsWorkspaceRoot, config.jobResultsDir);
    }
    assert.throws(
      () => database.createJob({
        source_event_id: source.event_id,
        job_key: "default.9",
        objective: "ninth objective",
        workspace: { kind: "scratch" },
      }, config.jobsWorkspaceRoot, config.jobResultsDir),
      (error) => error instanceof JobCreationError && error.code === "job_group_limit_exceeded",
    );
    assert.equal(database.listEventJobs(source.event_id).length, 8);
    database.close();
  });

  test("作成payloadを保持しqueued steerにも独立した実サイズ上限を適用する", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath, {
      jobsPerEventMax: 8,
      jobObjectiveTotalMaxBytes: 6,
    });
    const source = database.enqueue(eventEnvelope("Ev-job-byte-limit")).row;
    const firstRequest = {
      source_event_id: source.event_id,
      job_key: "unicode.one",
      objective: "あ",
      workspace: { kind: "scratch" as const },
    };
    const first = database.createJob(firstRequest, config.jobsWorkspaceRoot, config.jobResultsDir);
    const followUp = database.enqueue(eventEnvelope("Ev-job-byte-steer")).row;
    const beforeSteer=database.getJob(first.row.job_id);
    assert.throws(()=>database.appendQueuedJobInstruction(first.row.job_id, followUp.event_id, "追加条件".repeat(100)), error=>error instanceof JobCreationError && error.code==="job_group_limit_exceeded");
    assert.deepEqual(database.getJob(first.row.job_id),beforeSteer);
    database.createJob({
      ...firstRequest,
      job_key: "unicode.two",
      objective: "ab",
    }, config.jobsWorkspaceRoot, config.jobResultsDir);
    database.createJob({
      ...firstRequest,
      job_key: "unicode.three",
      objective: "c",
    }, config.jobsWorkspaceRoot, config.jobResultsDir);

    assert.throws(
      () => database.createJob({
        ...firstRequest,
        job_key: "unicode.four",
        objective: "d",
      }, config.jobsWorkspaceRoot, config.jobResultsDir),
      (error) => error instanceof JobCreationError &&
        error.code === "job_group_limit_exceeded" &&
        error.limitDetails?.resource === "objective_utf8_bytes_per_event" &&
        error.limitDetails.current === 6 &&
        error.limitDetails.attempted === 7,
    );
    assert.equal(
      database.createJob(firstRequest, config.jobsWorkspaceRoot, config.jobResultsDir).row.job_id,
      first.row.job_id,
    );
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
    const job = database.createJob({
      source_event_id: first.event_id,
      job_key: "recovery",
      objective: "survive source recovery",
      workspace: { kind: "scratch" },
    }, config.jobsWorkspaceRoot, config.jobResultsDir).row;
    assert.equal(database.nextAvailable()?.event_id, first.event_id);
    database.beginDispatch(first.event_id, `${config.resultsDir}/${first.event_id}.json`);
    assert.equal(database.recoverStaleDispatching(), 1);
    assert.equal(database.get(first.event_id)?.status, "needs_review");
    assert.notEqual(database.getJobGroup(first.event_id)?.sealed_at, null);
    assert.equal(
      database.createJob({
        source_event_id: first.event_id,
        job_key: "recovery",
        objective: "survive source recovery",
        workspace: { kind: "scratch" },
      }, config.jobsWorkspaceRoot, config.jobResultsDir).row.job_id,
      job.job_id,
    );
    assert.throws(
      () => database.createJob({
        source_event_id: first.event_id,
        job_key: "late",
        objective: "too late",
        workspace: { kind: "scratch" },
      }, config.jobsWorkspaceRoot, config.jobResultsDir),
      (error) => error instanceof JobCreationError && error.code === "job_group_closed",
    );
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
    await fs.mkdir(config.resultsDir,{recursive:true});
    await fs.writeFile(`${config.resultsDir}/${event.event_id}.json`,"old result");
    assert.throws(() => database.manualRetry(event.event_id, false), /--force/);
    await fs.rename(`${config.resultsDir}/${event.event_id}.json`,`${config.resultsDir}/${event.event_id}.json.retry-backup`);
    assert.equal(database.manualRetry(event.event_id, true).status, "queued");
    await assert.rejects(fs.access(`${config.resultsDir}/${event.event_id}.json`));
    await assert.rejects(fs.access(`${config.resultsDir}/${event.event_id}.json.retry-backup`));
    database.close();
  });

  test("restores the Result when a manual retry transaction fails", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const event = database.enqueue(eventEnvelope("Ev-retry-rollback")).row;
    const resultPath = `${config.resultsDir}/${event.event_id}.json`;
    database.beginDispatch(event.event_id, resultPath);
    database.markNeedsReview(event.event_id, "prompt_timeout", "unknown acceptance");
    await fs.mkdir(config.resultsDir,{recursive:true});
    await fs.writeFile(resultPath,"old result");
    const trigger = new Database(config.databasePath);
    trigger.exec("CREATE TRIGGER reject_manual_retry BEFORE UPDATE ON events WHEN OLD.external_event_id = 'Ev-retry-rollback' BEGIN SELECT RAISE(ABORT, 'retry rejected'); END;");
    trigger.close();
    assert.throws(() => database.manualRetry(event.event_id, true), /retry rejected/);
    assert.equal(await fs.readFile(resultPath,"utf8"),"old result");
    await assert.rejects(fs.access(`${resultPath}.retry-backup`));
    assert.equal(database.get(event.event_id)?.status,"needs_review");
    database.close();
  });

  test("removes a committed manual retry backup when the database reopens", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    let database = new DispatcherDatabase(config.databasePath);
    const event = database.enqueue(eventEnvelope("Ev-retry-cleanup")).row;
    const resultPath = `${config.resultsDir}/${event.event_id}.json`;
    const backupPath = `${resultPath}.retry-backup`;
    database.beginDispatch(event.event_id, resultPath);
    database.markNeedsReview(event.event_id, "prompt_timeout", "unknown acceptance");
    await fs.mkdir(config.resultsDir,{recursive:true});
    await fs.writeFile(backupPath,"old result");
    const raw = new Database(config.databasePath);
    raw.prepare("UPDATE events SET status='queued',result_path=?,last_error_code='manual_retry_cleanup_pending' WHERE event_id=?").run(backupPath,event.event_id);
    raw.close();
    database.close();

    database = new DispatcherDatabase(config.databasePath);
    await assert.rejects(fs.access(backupPath));
    assert.equal(database.get(event.event_id)?.result_path,null);
    assert.equal(database.get(event.event_id)?.last_error_code,null);
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
    assert.equal(created.row.result_path, `${config.jobResultsDir}/${created.row.job_id}/result.json`);
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
    assert.doesNotThrow(()=>database.assertJobSourceMatchesThread(created.row.job_id,notification.row.event_id));
    const siblingSource=database.enqueue(eventEnvelope("Ev-job-sibling")).row;
    const sibling=database.createJob({source_event_id:siblingSource.event_id,objective:"sibling",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
    assert.doesNotThrow(()=>database.assertJobSourceMatchesThread(sibling.job_id,notification.row.event_id));
    assert.deepEqual(new Set(database.listOwnerJobs(notification.row.event_id).map(row=>row.job_id)),new Set([created.row.job_id,sibling.job_id]));
    assert.equal(notification.row.event_type, "job_completed");
    assert.equal(envelopeFromRow(notification.row).source, "dona_job");
    assert.equal(duplicate.row.event_id, notification.row.event_id);
    assert.equal(database.getJobGroup(source.event_id)?.notification_mode, "legacy");
    database.close();
  });

  test("owner-aware admissionは通常multi-jobの順序・limit・fairnessを維持する",async()=>{
    const {root,config}=await tempConfig(); roots.push(root);
    const database=new DispatcherDatabase(config.databasePath,{jobsPerEventMax:2,jobObjectiveTotalMaxBytes:100});
    const firstEvent=database.enqueue(eventEnvelope("Ev-owner-aware-a" )).row;
    const secondEnvelope=eventEnvelope("Ev-owner-aware-b"); secondEnvelope.reply_target!.thread_ts="1756722031.000001"; secondEnvelope.subject.thread_ts="1756722031.000001";
    const secondEvent=database.enqueue(secondEnvelope).row;
    const request=(source_event_id:string,job_key:string,objective=job_key)=>({source_event_id,job_key,objective,workspace:{kind:"scratch" as const}});
    const first=database.createJob(request(firstEvent.event_id,"one"),config.jobsWorkspaceRoot,config.jobResultsDir);
    const second=database.createJob(request(firstEvent.event_id,"two"),config.jobsWorkspaceRoot,config.jobResultsDir);
    const other=database.createJob(request(secondEvent.event_id,"one"),config.jobsWorkspaceRoot,config.jobResultsDir);
    assert.equal(database.createJob(request(firstEvent.event_id,"one"),config.jobsWorkspaceRoot,config.jobResultsDir).outcome,"reused");
    assert.throws(()=>database.createJob(request(firstEvent.event_id,"one","changed"),config.jobsWorkspaceRoot,config.jobResultsDir),
      (error)=>error instanceof JobCreationError&&error.code==="job_idempotency_conflict");
    assert.throws(()=>database.createJob(request(firstEvent.event_id,"three"),config.jobsWorkspaceRoot,config.jobResultsDir),
      (error)=>error instanceof JobCreationError&&error.code==="job_group_limit_exceeded");
    assert.deepEqual(database.listRunnableJobs().map(row=>row.job_id),[first.row.job_id,other.row.job_id,second.row.job_id]);
    const followUp=database.enqueue(eventEnvelope("Ev-owner-aware-follow-up")).row;
    assert.throws(()=>database.appendQueuedJobInstruction(first.row.job_id,followUp.event_id,"追".repeat(40)),error=>error instanceof JobCreationError && error.code==="job_group_limit_exceeded");
    database.beginJobPreparation(first.row.job_id);
    assert.deepEqual(database.listRunnableJobs().map(row=>row.job_id),[other.row.job_id,second.row.job_id]);
    assert.throws(()=>database.assertJobSourceMatchesThread(first.row.job_id,secondEvent.event_id),/does not belong/);
    database.close();
  });

  test("queued steerの実サイズも後続job admissionへ算入し作成payloadは保持する",async()=>{
    const {root,config}=await tempConfig(); roots.push(root);
    const database=new DispatcherDatabase(config.databasePath,{jobsPerEventMax:3,jobObjectiveTotalMaxBytes:100});
    const event=database.enqueue(eventEnvelope("Ev-steer-admission-bytes")).row;
    const first=database.createJob({source_event_id:event.event_id,job_key:"first",objective:"a",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
    const followUp=database.enqueue(eventEnvelope("Ev-steer-admission-bytes-follow-up")).row;
    database.appendQueuedJobInstruction(first.job_id,followUp.event_id,"b".repeat(50));
    const accepted = database.getJob(first.job_id)!;
    assert.deepEqual(database.appendQueuedJobInstruction(first.job_id,followUp.event_id,"b".repeat(50)),accepted);
    const later = database.enqueue(eventEnvelope("Ev-steer-admission-bytes-later")).row;
    assert.throws(()=>database.appendQueuedJobInstruction(first.job_id,later.event_id,"c"),error=>error instanceof JobCreationError && error.code==="job_group_limit_exceeded");
    assert.deepEqual(database.getJob(first.job_id)!,accepted);
    assert.throws(()=>database.createJob({source_event_id:event.event_id,job_key:"second",objective:"c".repeat(20),workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir),error=>error instanceof JobCreationError && error.code==="job_group_limit_exceeded");
    assert.equal(database.createJob({source_event_id:event.event_id,job_key:"first",objective:"a",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row.job_id,first.job_id);
    assert.throws(()=>database.createJob({source_event_id:event.event_id,job_key:"third",objective:"c".repeat(80),workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir),
      (error)=>error instanceof JobCreationError&&error.code==="job_group_limit_exceeded"&&error.limitDetails?.resource==="objective_utf8_bytes_per_event");
    database.close();
  });

  test("queued steer rejects oversized effective objectives without changing receipt",async()=>{
    const {root,config}=await tempConfig(); roots.push(root);
    const database=new DispatcherDatabase(config.databasePath);
    const event=database.enqueue(eventEnvelope("Ev-steer-character-limit")).row;
    const job=database.createJob({source_event_id:event.event_id,objective:"a".repeat(99_999),workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
    const followUp=database.enqueue(eventEnvelope("Ev-steer-character-follow-up")).row;
    assert.throws(()=>database.appendQueuedJobInstruction(job.job_id,followUp.event_id,"b"),/Effective job objective character limit/);
    assert.deepEqual(database.getJob(job.job_id),job);
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
    raw.prepare("UPDATE jobs SET result_path=? WHERE job_id=?").run(`${config.jobResultsDir}/${job.job_id}.json`,job.job_id);
    raw.close();

    const reopened = new DispatcherDatabase(config.databasePath);
    assert.equal(reopened.getJob(job.job_id)?.agent_name, job.job_id);
    assert.equal(reopened.getJob(job.job_id)?.result_path,`${config.jobResultsDir}/${job.job_id}/result.json`);
    assert.equal(reopened.listLegacySharedGrantJobs().some(row=>row.job_id===job.job_id),false);
    reopened.close();
  });

  test("正規化済み表示ラベルを再起動後も再利用し旧jobはagent nameへfallbackする", async () => {
    const { root, config } = await tempConfig(); roots.push(root);
    let database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-job-persisted-display")).row;
    const displayed = database.createJob({
      source_event_id: source.event_id,
      objective: "objective全文は表示しない",
      workspace: { kind: "github", repository: "owner/repo" },
      display: { short_name: "  表示   作業  ", issue: { repository: "owner/repo", number: 87 } },
    }, config.jobsWorkspaceRoot, config.jobResultsDir).row;
    const legacySource = database.enqueue(eventEnvelope("Ev-job-display-legacy")).row;
    const legacy = database.createJob({ source_event_id: legacySource.event_id, objective: "旧job", workspace: { kind: "scratch" } }, config.jobsWorkspaceRoot, config.jobResultsDir).row;
    database.close();

    const raw = new Database(config.databasePath);
    const legacyWorkspace = JSON.parse(legacy.workspace_json) as Record<string, unknown>;
    legacyWorkspace.__future_metadata = { preserved: true };
    raw.prepare("UPDATE jobs SET workspace_json=? WHERE job_id=?").run(JSON.stringify(legacyWorkspace), legacy.job_id);
    raw.close();

    database = new DispatcherDatabase(config.databasePath);
    const restoredDisplay = database.getJob(displayed.job_id)!;
    const restoredLegacy = database.getJob(legacy.job_id)!;
    assert.equal(jobWorkspaceLabel(restoredDisplay.workspace_json, restoredDisplay.agent_name), "#87 表示 作業");
    assert.equal(jobWorkspaceLabel(restoredLegacy.workspace_json, restoredLegacy.agent_name), legacy.agent_name);
    assert.deepEqual((JSON.parse(restoredLegacy.workspace_json) as Record<string, unknown>).__future_metadata, { preserved: true });
    assert.equal(restoredDisplay.agent_name, restoredDisplay.job_id);
    database.close();
  });

  test("isolates legacy preparing and running jobs whose existing agent grants cannot be verified", async () => {
    const { root, config } = await tempConfig(); roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-job-legacy-preparing")).row;
    const job = database.createJob({source_event_id:source.event_id,objective:"調査する",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
    const secondSource=database.enqueue(eventEnvelope("Ev-job-legacy-running")).row;
    const running=database.createJob({source_event_id:secondSource.event_id,objective:"実行する",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
    database.beginJobPreparation(job.job_id); database.close();
    const raw = new Database(config.databasePath);
    raw.prepare("UPDATE jobs SET result_path=? WHERE job_id=?").run(`${config.jobResultsDir}/${job.job_id}.json`,job.job_id); raw.close();
    const rawRunning=new Database(config.databasePath); rawRunning.prepare("UPDATE jobs SET status='running',result_path=? WHERE job_id=?").run(`${config.jobResultsDir}/${running.job_id}.json`,running.job_id); rawRunning.close();
    const reopened = new DispatcherDatabase(config.databasePath), isolated=reopened.getJob(job.job_id)!;
    assert.equal(isolated.status,"needs_review"); assert.equal(isolated.last_error_code,"legacy_agent_sandbox_unknown");
    assert.equal(reopened.getJob(running.job_id)?.last_error_code,"legacy_agent_sandbox_unknown");
    assert.equal(reopened.isLegacySharedGrantAgentStopped(running.job_id),false);
    const recoveredResult={schema_version:1 as const,job_id:running.job_id,status:"completed" as const,summary:"回収済み",completed_at:new Date().toISOString()};
    assert.throws(()=>reopened.saveJobResult(running.job_id,recoveredResult,`${config.jobResultsDir}/${running.job_id}.json`),/Invalid status transition/);
    reopened.markLegacySharedGrantAgentStopped(running.job_id);
    assert.equal(reopened.isLegacySharedGrantAgentStopped(running.job_id),true);
    reopened.saveJobResult(running.job_id,recoveredResult,`${config.jobResultsDir}/${running.job_id}.json`);
    assert.equal(reopened.getJob(running.job_id)?.status,"completed");
    reopened.close();
  });

  test("does not stop terminal jobs solely because they retain a legacy result path", async () => {
    const { root, config } = await tempConfig(); roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const jobs = ["completed","failed","cancelled"].map((status,index) => {
      const source=database.enqueue(eventEnvelope(`Ev-job-legacy-terminal-${index}`)).row;
      return {status,job:database.createJob({source_event_id:source.event_id,objective:"完了済み",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row};
    });
    database.close();
    const raw = new Database(config.databasePath);
    for(const {status,job} of jobs) {
      raw.prepare("UPDATE jobs SET status=?,result_path=? WHERE job_id=?").run(status,`${config.jobResultsDir}/${job.job_id}.json`,job.job_id);
      raw.prepare("INSERT INTO legacy_job_agents_to_stop(job_id) VALUES(?)").run(job.job_id);
    }
    raw.close();
    const reopened = new DispatcherDatabase(config.databasePath);
    assert.deepEqual(reopened.listLegacySharedGrantJobs(),[]);
    for(const {status,job} of jobs) assert.equal(reopened.getJob(job.job_id)?.status,status);
    assert.equal(reopened.updateSafetyStatus().safe,true);
    assert.equal(reopened.updateSafetyStatus().active_worker_count,0);
    reopened.close();
  });

  test("update safety refuses active and unresolved workers without exposing identities", async () => {
    const { root, config } = await tempConfig(); roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const statuses = ["running", "blocked", "needs_review", "completed", "retryable_failed"];
    const jobs = statuses.map((status, index) => {
      const source = database.enqueue(eventEnvelope(`Ev-update-worker-${index}`)).row;
      return { status, row: database.createJob({source_event_id: source.event_id, objective: `秘密-${index}`,
        workspace: {kind: "scratch"}}, config.jobsWorkspaceRoot, config.jobResultsDir).row };
    });
    const raw = new Database(config.databasePath);
    for (const { status, row } of jobs) raw.prepare("UPDATE jobs SET status=? WHERE job_id=?").run(status, row.job_id);
    raw.prepare("UPDATE jobs SET last_error_code='stale_preparing',herdr_workspace_id=NULL WHERE job_id=?")
      .run(jobs.at(-1)!.row.job_id);
    raw.prepare("UPDATE jobs SET herdr_workspace_id='known-worker' WHERE job_id=?")
      .run(jobs[2]!.row.job_id);
    raw.close();
    const safety = database.updateSafetyStatus();
    assert.equal(safety.safe, false);
    assert.equal(safety.active_worker_count, 4);
    assert.equal(safety.worker_recovery_state, "handoff_unavailable");
    assert.deepEqual(safety.unsafe_states.sort(), ["jobs.blocked:1", "jobs.needs_review:1", "jobs.retryable_failed:1", "jobs.running:1"]);
    assert.equal(JSON.stringify(safety).includes("秘密"), false);
    assert.equal(JSON.stringify(safety).includes(config.jobResultsDir), false);
    database.close();
  });

  test("update safety excludes a proven pre-prepare result path collision", async () => {
    const { root, config } = await tempConfig(); roots.push(root);
    const database = new DispatcherDatabase(config.databasePath);
    const source = database.enqueue(eventEnvelope("Ev-update-pre-prepare-collision")).row;
    const job = database.createJob({ source_event_id: source.event_id, objective: "結果先衝突",
      workspace: { kind: "scratch" } }, config.jobsWorkspaceRoot, config.jobResultsDir).row;
    const raw = new Database(config.databasePath);
    raw.prepare("UPDATE jobs SET status='needs_review',last_error_code='result_path_exists' WHERE job_id=?")
      .run(job.job_id);
    raw.close();
    assert.equal(database.updateSafetyStatus().active_worker_count, 0);
    const guarded = new Database(config.databasePath);
    guarded.prepare("UPDATE jobs SET herdr_workspace_id='possible-worker' WHERE job_id=?").run(job.job_id);
    guarded.close();
    assert.equal(database.updateSafetyStatus().active_worker_count, 1);
    database.close();
  });

  test("schema v3はmulti-jobとschedule runのcardinalityを同時に保持する", async () => {
    const { root, config } = await tempConfig(); roots.push(root);
    const dispatcher = new DispatcherDatabase(config.databasePath);
    const event = dispatcher.enqueue(eventEnvelope("Ev-schema-v3-cardinality")).row;
    dispatcher.close();
    const raw = new Database(config.databasePath);
    assert.equal(raw.pragma("user_version", { simple: true }), 3);
    const original = raw.prepare("SELECT * FROM jobs WHERE 0").all();
    assert.deepEqual(original, []);
    const insert = raw.prepare(`INSERT INTO jobs(job_id,source_event_id,job_key,source,objective,workspace_json,status,available_at,workspace_path,result_path,agent_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const values = (jobId: string, jobKey: string) => [jobId,event.event_id,jobKey,"slack","work","{\"kind\":\"scratch\"}","queued",event.created_at,"/tmp/work","/tmp/result",jobId,event.created_at,event.created_at];
    insert.run(...values("job_schema_v3_a","first"));
    insert.run(...values("job_schema_v3_b","second"));
    assert.throws(() => insert.run(...values("job_schema_v3_c","first")), /UNIQUE constraint failed/);

    const owner = JSON.stringify({kind:"schedule",tenant_id:"T1",owner_id:"U1",schedule_id:"schedule_1",run_id:"run_1",revision:1});
    const destination = JSON.stringify({kind:"none"});
    raw.prepare("INSERT INTO job_owner_bindings VALUES(?,?,?,?)").run("job_schema_v3_a",event.event_id,owner,destination);
    assert.throws(() => raw.prepare("INSERT INTO job_owner_bindings VALUES(?,?,?,?)").run("job_schema_v3_b",event.event_id,owner,destination), /UNIQUE constraint failed/);
    assert.equal(raw.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(raw.pragma("foreign_key_check"), []);
    raw.close();
  });

  test("bridge由来v2のjob key・groupとscheduler tableをv3で保持する", async () => {
    const { root, config } = await tempConfig(); roots.push(root);
    const seeded = new DispatcherDatabase(config.databasePath);
    const event = seeded.enqueue(eventEnvelope("Ev-v2-bridge-preserve")).row;
    const job = seeded.createJob({source_event_id:event.event_id,objective:"preserve",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
    seeded.close();
    const bridge = new Database(config.databasePath);
    bridge.prepare("UPDATE jobs SET job_key='bridge-key' WHERE job_id=?").run(job.job_id);
    bridge.prepare("UPDATE jobs SET workspace_json=?,objective=?,steer_event_id=? WHERE job_id=?").run('{"kind":"scratch"}',
      "preserve\n\n[DONA_FOLLOW_UP]\n追加条件\n[/DONA_FOLLOW_UP]","legacy-follow-up",job.job_id);
    bridge.prepare("INSERT INTO legacy_job_agents_to_stop(job_id,stopped_at) VALUES(?,?)").run(job.job_id,event.updated_at);
    bridge.prepare("UPDATE job_groups SET sealed_at=?,notification_mode='legacy',created_at=?,updated_at=? WHERE source_event_id=?")
      .run(event.updated_at,event.created_at,event.updated_at,event.event_id);
    const schedulerTables = (bridge.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'schedule%'").get() as {count:number}).count;
    bridge.pragma("user_version = 2");
    bridge.close();
    const activationManifest = path.join(root,"activation-manifest.json");
    await fs.writeFile(activationManifest,JSON.stringify({compatibility:{app_schema_write:3}}));
    const previousManifest=process.env.DONA_RELEASE_MANIFEST_PATH;
    process.env.DONA_RELEASE_MANIFEST_PATH=activationManifest;
    let migrated:DispatcherDatabase;
    try { migrated=new DispatcherDatabase(config.databasePath); } finally { if(previousManifest===undefined)delete process.env.DONA_RELEASE_MANIFEST_PATH;else process.env.DONA_RELEASE_MANIFEST_PATH=previousManifest; }
    assert.throws(()=>migrated.createJob({source_event_id:event.event_id,job_key:"bridge-key",objective:"preserve",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir),
      (error)=>error instanceof JobCreationError&&error.code==="job_idempotency_conflict");
    migrated.close();
    const raw = new Database(config.databasePath);
    assert.equal(raw.pragma("user_version", { simple: true }), 3);
    assert.equal((raw.prepare("SELECT job_key FROM jobs WHERE job_id=?").get(job.job_id) as {job_key:string}).job_key,"bridge-key");
    assert.equal((raw.prepare("SELECT notification_mode FROM job_groups WHERE source_event_id=?").get(event.event_id) as {notification_mode:string}).notification_mode,"legacy");
    assert.equal((raw.prepare("SELECT stopped_at FROM legacy_job_agents_to_stop WHERE job_id=?").get(job.job_id) as {stopped_at:string}).stopped_at,event.updated_at);
    assert.equal((raw.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'schedule%'").get() as {count:number}).count,schedulerTables);
    assert.equal(raw.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(raw.pragma("foreign_key_check"), []);
    raw.close();
  });

  test("fingerprintのないlegacy jobは一致payloadだけをreuseする",async()=>{
    const {root,config}=await tempConfig(); roots.push(root);
    const database=new DispatcherDatabase(config.databasePath);
    const event=database.enqueue(eventEnvelope("Ev-legacy-reuse")).row;
    const request={source_event_id:event.event_id,objective:"legacy",workspace:{kind:"scratch" as const}};
    const job=database.createJob(request,config.jobsWorkspaceRoot,config.jobResultsDir).row;
    const raw=new Database(config.databasePath); raw.prepare("UPDATE jobs SET workspace_json=? WHERE job_id=?").run('{"kind":"scratch"}',job.job_id); raw.close();
    assert.equal(database.createJob({...request,display:{short_name:"新しい表示"}},config.jobsWorkspaceRoot,config.jobResultsDir).outcome,"reused");
    const migratedLegacy=database.getJob(job.job_id)!;
    assert.equal(jobWorkspaceLabel(migratedLegacy.workspace_json,migratedLegacy.agent_name),job.agent_name);
    assert.equal((JSON.parse(migratedLegacy.workspace_json) as Record<string,unknown>).__dona_job_display,undefined);
    const followUp=database.enqueue(eventEnvelope("Ev-legacy-reuse-follow-up")).row;
    database.appendQueuedJobInstruction(job.job_id,followUp.event_id,"追加条件");
    assert.equal(database.createJob(request,config.jobsWorkspaceRoot,config.jobResultsDir).outcome,"reused");
    assert.throws(()=>database.createJob({...request,objective:"changed"},config.jobsWorkspaceRoot,config.jobResultsDir),
      (error)=>error instanceof JobCreationError&&error.code==="job_idempotency_conflict");
    database.close();
  });

  for (const fault of ["jobs_copied", "indexes_recreated", "groups_backfilled", "scheduler_schema_ready"] as const) {
    test(`schema v3 migrationは${fault}障害でv2とscheduler永続化をrollbackする`, async () => {
      const { root, config } = await tempConfig(); roots.push(root);
      const seeded = new DispatcherDatabase(config.databasePath);
      const event = seeded.enqueue(eventEnvelope(`Ev-migration-${fault}`)).row;
      seeded.close();
      const before = new Database(config.databasePath);
      before.pragma("user_version = 2");
      const scheduleCount = (before.prepare("SELECT count(*) AS count FROM scheduler_schema").get() as {count:number}).count;
      before.close();
      const manifest=path.join(root,"fault-manifest.json");
      await fs.writeFile(manifest,JSON.stringify({compatibility:{app_schema_write:3}}));
      const previous=process.env.DONA_RELEASE_MANIFEST_PATH;process.env.DONA_RELEASE_MANIFEST_PATH=manifest;
      try { assert.throws(() => new DispatcherDatabase(config.databasePath, (step) => {
        if (step === fault) throw new Error(`injected:${fault}`);
      }), new RegExp(`injected:${fault}`)); } finally { if(previous===undefined)delete process.env.DONA_RELEASE_MANIFEST_PATH;else process.env.DONA_RELEASE_MANIFEST_PATH=previous; }
      const after = new Database(config.databasePath);
      assert.equal(after.pragma("user_version", { simple: true }), 2);
      assert.equal((after.prepare("SELECT count(*) AS count FROM scheduler_schema").get() as {count:number}).count, scheduleCount);
      assert.equal((after.prepare("SELECT external_event_id FROM events WHERE event_id=?").get(event.event_id) as {external_event_id:string}).external_event_id, `Ev-migration-${fault}`);
      assert.equal(after.prepare("SELECT 1 FROM sqlite_master WHERE name='jobs_v3'").get(), undefined);
      assert.equal(after.pragma("integrity_check", { simple: true }), "ok");
      assert.deepEqual(after.pragma("foreign_key_check"), []);
      after.close();
    });
  }
  test("expands a newly created schema-v2 database before bridge runtime queries", async () => {
    const { root, config } = await tempConfig();
    roots.push(root);
    const manifestPath = path.join(root, "bridge-manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify({ compatibility: { app_schema_write: 2 } }));
    const previous = process.env.DONA_RELEASE_MANIFEST_PATH;
    process.env.DONA_RELEASE_MANIFEST_PATH = manifestPath;
    try {
      const database = new DispatcherDatabase(config.databasePath);
      const source = database.enqueue(eventEnvelope("Ev-bridge-explicit-key")).row;
      assert.throws(() => database.createJob({
        source_event_id: source.event_id,
        job_key: "research.primary",
        objective: "調査する",
        workspace: { kind: "scratch" },
      }, config.jobsWorkspaceRoot, config.jobResultsDir), /multi_job_feature_disabled_for_schema_v2_bridge/);
      const first = database.createJob({
        source_event_id: source.event_id,
        objective: "調査する",
        workspace: { kind: "scratch" },
      }, config.jobsWorkspaceRoot, config.jobResultsDir);
      assert.equal(first.row.job_key, "legacy-default");
      database.close();
      const raw = new Database(config.databasePath, { readonly: true });
      assert.equal(raw.pragma("user_version", { simple: true }), 2);
      assert.equal((raw.pragma("table_info(jobs)") as Array<{ name: string }>).some(({ name }) => name === "job_key"), true);
      assert.ok(raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'job_groups'").get());
      raw.close();
    } finally {
      if (previous === undefined) delete process.env.DONA_RELEASE_MANIFEST_PATH;
      else process.env.DONA_RELEASE_MANIFEST_PATH = previous;
    }
  });
});
