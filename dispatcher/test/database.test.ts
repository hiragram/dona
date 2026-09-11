import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterEach, describe, test } from "node:test";

import Database from "better-sqlite3";

import { DispatcherDatabase, JobCreationError } from "../src/database.js";
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
    assert.equal(notification.row.event_type, "job_completed");
    assert.equal(envelopeFromRow(notification.row).source, "dona_job");
    assert.equal(duplicate.row.event_id, notification.row.event_id);
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
    assert.throws(()=>database.assertJobSourceMatchesThread(first.row.job_id,secondEvent.event_id),/does not belong/);
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
    reopened.close();
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
    bridge.prepare("INSERT INTO legacy_job_agents_to_stop(job_id,stopped_at) VALUES(?,?)").run(job.job_id,event.updated_at);
    bridge.prepare("UPDATE job_groups SET sealed_at=?,notification_mode='legacy',created_at=?,updated_at=? WHERE source_event_id=?")
      .run(event.updated_at,event.created_at,event.updated_at,event.event_id);
    const schedulerTables = (bridge.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'schedule%'").get() as {count:number}).count;
    bridge.pragma("user_version = 2");
    bridge.close();
    const migrated = new DispatcherDatabase(config.databasePath);
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
      assert.throws(() => new DispatcherDatabase(config.databasePath, (step) => {
        if (step === fault) throw new Error(`injected:${fault}`);
      }), new RegExp(`injected:${fault}`));
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
});
