import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { DispatcherApi } from "../src/api.js";
import { DispatcherApiClient } from "../src/client.js";
import { JobSupervisor } from "../src/job-supervisor.js";
import type { JobAgentRuntime } from "../src/job-runtime.js";
import type { JobResultEnvelope, JobRow } from "../src/types.js";
import { eventEnvelope, tempConfig, waitFor } from "./helpers.js";
import { integrationLogger, SchedulerIntegrationHarness } from "./support/scheduler-integration-harness.js";

function regularJobs(h: SchedulerIntegrationHarness) {
  const source = h.database.enqueue(eventEnvelope("mixed-regular")).row;
  h.database.beginDispatch(source.event_id, path.join(h.root, "event-result.json"));
  h.database.markWaiting(source.event_id);
  const jobs = ["first", "second"].map(job_key => h.database.createJob({ source_event_id: source.event_id,
    job_key, objective: "通常の調査", workspace: { kind: "scratch" } }, path.join(h.root, "jobs"), path.join(h.root, "results")).row);
  h.database.saveCompleted(source.event_id, { schema_version: 1, event_id: source.event_id, status: "completed",
    completed_at: h.clock.now() }, path.join(h.root, "event-result.json"), new Date(h.clock.now()));
  return { source, jobs };
}

function scheduledJob(h: SchedulerIntegrationHarness) {
  const due = new Date(Date.parse(h.clock.now()) + 60_000).toISOString().replace(".000Z", "Z");
  const runId = h.materialize("mixed", h.input("work.read_only", false, due), due);
  const eventId = h.repo.getRun(runId)!.event_id!;
  h.database.beginDispatch(eventId, path.join(h.root, "scheduled-event.json"), new Date(h.clock.now()));
  h.database.recordScheduleJobAccess(eventId, { workspace_id: "T_GATE", channel_id: "C_GATE", user_id: "U_GATE",
    issued_at: new Date(h.clock.now()).toISOString(), nonce: `receipt_${eventId}` }, new Date(h.clock.now()));
  const job = h.database.createJob({ source_event_id: eventId, objective: "inspect repository read-only", workspace: { kind: "scratch" } },
    path.join(h.root, "jobs"), path.join(h.root, "results"), new Date(h.clock.now())).row;
  return { runId, eventId, job };
}

function running(h: SchedulerIntegrationHarness, job: JobRow) {
  const at = new Date(h.clock.now());
  h.database.beginJobPreparation(job.job_id, at); h.database.beginJobDispatch(job.job_id, at); h.database.markJobRunning(job.job_id, at);
}
function result(job: JobRow, completed_at: string, status: "completed" | "failed" = "completed"): JobResultEnvelope {
  return { schema_version: 1, job_id: job.job_id, status, summary: "調査結果", actions: [], completed_at };
}

for (const status of ["completed", "failed", "blocked", "needs_review", "cancelled"] as const) {
  test(`同一DBの通常二件とscheduled ${status}を別ownerへ一度だけ反映する`, () => {
    let h = new SchedulerIntegrationHarness();
    try {
      const { source, jobs } = regularJobs(h);
      const scheduled = scheduledJob(h);
      for (const job of [...jobs, scheduled.job]) {
        // 通常jobも同じfixture時刻で開始する。
        h.raw.prepare("UPDATE jobs SET available_at=? WHERE job_id=?").run(new Date(h.clock.now()).toISOString(), job.job_id);
        running(h, job);
        if (status === "completed" || status === "failed") h.database.saveJobResult(job.job_id, result(job, h.clock.now(), status), job.result_path, new Date(h.clock.now()));
        else if (status === "blocked") h.database.markJobBlocked(job.job_id, "入力待ち");
        else if (status === "needs_review") h.database.markJobNeedsReview(job.job_id, "test_unknown", "確認待ち");
        else { h.database.beginJobCancellation(job.job_id, job.source_event_id); h.database.markJobCancelled(job.job_id, "中止", new Date(h.clock.now())); }
      }
      for (let pass = 0; pass < 3; pass++) for (const job of h.database.listJobsNeedingNotification()) h.database.enqueueJobNotification(job.job_id, new Date(h.clock.now()));
      const group = h.database.getJobGroup(source.event_id)!;
      const expectedAttention = ["failed", "blocked", "needs_review"].includes(status);
      assert.equal(group.attention_event_id !== null, expectedAttention);
      assert.equal(group.all_terminal_event_id !== null, ["completed", "cancelled"].includes(status));
      assert.equal(h.repo.getRun(scheduled.runId)?.status, ["blocked", "needs_review"].includes(status) ? "needs_review" : status);
      assert.equal(h.raw.prepare("SELECT count(*) FROM job_completion_results WHERE job_id=?").pluck().get(scheduled.job.job_id), 1);
      const completion = h.raw.prepare("SELECT work_state,notification_state FROM job_completion_results WHERE job_id=?").get(scheduled.job.job_id) as {work_state:string;notification_state:string};
      assert.equal(completion.work_state, ["blocked", "needs_review"].includes(status) ? "needs_review" : status);
      assert.equal(completion.notification_state, "pending");
      assert.equal(h.database.getJobGroup(scheduled.eventId), undefined);
      const notification = h.database.get(h.database.getJob(scheduled.job.job_id)!.completion_event_id!)!;
      assert.equal(JSON.parse(notification.payload_json).group, undefined);
      assert.equal(JSON.parse(notification.payload_json).workspace, undefined);
      assert.throws(() => h.database.assertJobSourceMatchesThread(jobs[0]!.job_id, notification.event_id), /owner/);
      assert.throws(() => h.database.assertJobSourceMatchesThread(scheduled.job.job_id, group.attention_event_id ?? group.all_terminal_event_id!), /owner/);
      const count = h.database.list().length;
      h = h.reopen();
      assert.deepEqual(h.database.listJobsNeedingNotification(), []);
      assert.equal(h.database.enqueueJobNotification(scheduled.job.job_id).row.event_id, notification.event_id);
      assert.equal(h.database.list().length, count);
    } finally { h.close(); }
  });
}

for (const step of ["event_enqueued", "transition_claimed", "job_linked"] as const) {
  test(`scheduled Resultの${step}失敗はjobとrunと通知を一緒にrollbackする`, () => {
    let h = new SchedulerIntegrationHarness();
    try {
      regularJobs(h);
      const { job, runId } = scheduledJob(h); running(h, job);
      const envelope = result(job, h.clock.now());
      assert.throws(() => h.database.saveJobResult(job.job_id, envelope, job.result_path, new Date(h.clock.now()), at => {
        if (at === step) throw new Error(`fault:${step}`);
      }), /fault:/);
      assert.equal(h.database.getJob(job.job_id)?.status, "running");
      assert.equal(h.repo.getRun(runId)?.status, "started");
      assert.equal(h.raw.prepare("SELECT count(*) FROM job_completion_results").pluck().get(), 0);
      assert.equal(h.database.getByExternalId("dona_job", `${job.job_id}:completed`), undefined);
      h = h.reopen();
      h.database.saveJobResult(job.job_id, envelope, job.result_path, new Date(h.clock.now()));
      const notification = h.database.getJob(job.job_id)?.completion_event_id;
      h = h.reopen();
      h.database.saveJobResult(job.job_id, envelope, job.result_path, new Date(h.clock.now()));
      assert.equal(h.database.getJob(job.job_id)?.completion_event_id, notification);
      assert.equal(h.raw.prepare("SELECT count(*) FROM job_completion_results").pluck().get(), 1);
    } finally { h.close(); }
  });
}

for (const tamper of ["result_id", "run_job", "run_event", "job_source"] as const) {
  test(`Result受理前に${tamper}改変を拒否して別ownerを更新しない`, () => {
    const h = new SchedulerIntegrationHarness();
    try {
      const regular = regularJobs(h); const { job, runId } = scheduledJob(h); running(h, job);
      const envelope = result(job, h.clock.now());
      if (tamper === "result_id") envelope.job_id = regular.jobs[0]!.job_id;
      if (tamper === "run_job") h.raw.prepare("UPDATE schedule_runs SET job_id=? WHERE run_id=?").run(regular.jobs[0]!.job_id, runId);
      if (tamper === "run_event") h.raw.prepare("UPDATE schedule_runs SET event_id=? WHERE run_id=?").run(regular.source.event_id, runId);
      if (tamper === "job_source") h.raw.prepare("UPDATE jobs SET source_event_id=? WHERE job_id=?").run(regular.source.event_id, job.job_id);
      assert.throws(() => h.database.saveJobResult(job.job_id, envelope, job.result_path, new Date(h.clock.now())), /mismatch|owner/);
      assert.equal(h.database.getJob(job.job_id)?.status, "running");
      assert.equal(h.repo.getRun(runId)?.status, "started");
      assert.equal(h.raw.prepare("SELECT count(*) FROM job_completion_results").pluck().get(), 0);
    } finally { h.close(); }
  });
}

for (const schema of ["fresh","v2"] as const) for (const outcome of ["completed", "failed", "blocked", "missing", "invalid"] as const) {
  test(`${schema} DBのUDSから通常二件とscheduled一件を委任しsupervisorで${outcome}を回収する`, async () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    const h = new SchedulerIntegrationHarness(new Date(now - 120_000).toISOString().replace(".000Z", "Z"),schema);
    const { root, config } = await tempConfig();
    let api: DispatcherApi | undefined; let supervisor: JobSupervisor | undefined;
    const jobs: JobRow[] = [];
    try {
      const due = new Date(now - 60_000).toISOString().replace(".000Z", "Z");
      const scheduledObjective = "  inspect repository read-only  ";
      const runId = h.materialize("public", {...h.input("work.read_only", false, due),content:scheduledObjective}, due);
      const eventId = h.repo.getRun(runId)!.event_id!;
      const ordinary = h.database.enqueue(eventEnvelope("public-regular")).row;
      for (const id of [ordinary.event_id, eventId]) { h.database.beginDispatch(id, path.join(root, `${id}.json`)); h.database.markWaiting(id); }
      h.database.recordScheduleJobAccess(eventId, { workspace_id: "T_GATE", channel_id: "C_GATE", user_id: "U_GATE",
        issued_at: new Date().toISOString(), nonce: `receipt_${eventId}` });
      const ok = (agentStatus: "idle" | "done" | "working" | "blocked") => ({ ok: true, stdout: "", stderr: "", exitCode: 0, timedOut: false, aborted: false, agentStatus });
      let prompts = 0;
      const runtime: JobAgentRuntime = {
        async prepare(job) { await fs.mkdir(path.dirname(job.result_path), { recursive: true }); return { herdrWorkspaceId: job.job_id, herdrPaneId: job.job_id }; },
        async prompt(agent) {
          prompts++; const job = jobs.find(j => j.agent_name === agent)!;
          if (outcome === "completed" || outcome === "failed") await fs.writeFile(job.result_path, JSON.stringify(result(job, new Date().toISOString(), outcome)));
          if (outcome === "invalid") await fs.writeFile(job.result_path, "invalid");
          return ok("working");
        },
        async wait() { return ok(outcome === "blocked" ? "blocked" : "done"); },
        async get() { return { ok: false, stdout: "", stderr: "", exitCode: 1, timedOut: false, aborted: false, errorCode: "agent_not_found" }; },
        async cancel() { return ok("done"); },
        async cleanup() { return ok("done"); },
      };
      supervisor = new JobSupervisor(h.database, runtime, config, integrationLogger, () => {});
      api = new DispatcherApi(h.database, { isRunning: () => true, wake() {} }, supervisor, config, integrationLogger);
      await api.start(); const client = new DispatcherApiClient(config.socketPath);
      for (const job_key of ["first", "second"]) {
        const created = await client.createJob({ source_event_id: ordinary.event_id, job_key, objective: "通常の調査", workspace: { kind: "scratch" } }) as { job: { job_id: string } };
        jobs.push(h.database.getJob(created.job.job_id)!);
      }
      const created = await client.delegateScheduledWork(eventId) as { job: { job_id: string } };
      jobs.push(h.database.getJob(created.job.job_id)!);
      assert.equal(jobs[2]!.objective,scheduledObjective);
      for (const id of [ordinary.event_id, eventId]) h.database.saveCompleted(id, { schema_version: 1, event_id: id, status: "completed", completed_at: new Date().toISOString() }, path.join(root, `${id}.json`));
      await supervisor.start();
      await waitFor(() => jobs.every(job => h.database.getJob(job.job_id)?.completion_event_id != null));
      if (outcome === "completed") await waitFor(() => h.database.getJobGroup(ordinary.event_id)?.all_terminal_event_id != null);
      else assert.equal(h.database.getJobGroup(ordinary.event_id)?.all_terminal_event_id,null);
      await supervisor.stop(); supervisor = undefined;
      const expected = ["invalid", "missing"].includes(outcome) ? "needs_review" : outcome;
      for (const job of jobs) assert.equal(h.database.getJob(job.job_id)?.status, expected);
      assert.equal(prompts, 3);
      assert.equal(h.repo.getRun(runId)?.status, expected === "blocked" ? "needs_review" : expected);
      assert.equal(h.database.getJobGroup(eventId), undefined);
      assert.equal(h.raw.prepare("SELECT count(*) FROM job_completion_results WHERE job_id=?").pluck().get(jobs[2]!.job_id), 1);
    } finally { await supervisor?.stop(); await api?.stop(); h.close(); await fs.rm(root, { recursive: true, force: true }); }
  });
}

test("all_terminalをclaimした後は同じ走査の残りjobと再走査から追加通知を作らない", () => {
  const h = new SchedulerIntegrationHarness();
  try {
    const { jobs } = regularJobs(h);
    for (const job of jobs) {
      h.raw.prepare("UPDATE jobs SET available_at=? WHERE job_id=?").run(new Date(h.clock.now()).toISOString(), job.job_id);
      running(h, job); h.database.saveJobResult(job.job_id, result(job, h.clock.now()), job.result_path, new Date(h.clock.now()));
    }
    const snapshot = h.database.listJobsNeedingNotification(); assert.equal(snapshot.length, 2);
    const first = h.database.enqueueJobNotification(snapshot[0]!.job_id);
    const stale = h.database.enqueueJobNotification(snapshot[1]!.job_id);
    assert.equal(stale.row.event_id, first.row.event_id); assert.equal(stale.duplicate, true);
    assert.deepEqual(h.database.listJobsNeedingNotification(), []);
    assert.equal(h.raw.prepare("SELECT count(*) FROM events WHERE source='dona_job'").pluck().get(), 1);
  } finally { h.close(); }
});

for (const grouped of [true, false]) test(`通常${grouped ? "group" : "legacy"}のqueued attentionは取消時に無効化する`, () => {
  const h = new SchedulerIntegrationHarness();
  try {
    const { source, jobs } = regularJobs(h); const job = jobs[0]!;
    if (!grouped) h.raw.prepare("UPDATE job_groups SET notification_mode='legacy' WHERE source_event_id=?").run(source.event_id);
    h.raw.prepare("UPDATE jobs SET available_at=? WHERE job_id=?").run(new Date(h.clock.now()).toISOString(), job.job_id);
    running(h, job); h.database.markJobBlocked(job.job_id, "入力待ち");
    const attention = h.database.enqueueJobNotification(job.job_id);
    h.database.beginJobCancellation(job.job_id, source.event_id);
    assert.equal(h.database.get(attention.row.event_id)?.last_error_code, "job_result_superseded");
    assert.equal(h.database.get(attention.row.event_id)?.status, "completed");
    h.database.markJobCancelled(job.job_id, "中止");
    h.database.enqueueJobNotification(job.job_id);
    assert.equal(h.database.get(attention.row.event_id)?.status, "completed");
    assert.notEqual(h.database.getJob(job.job_id)?.completion_event_id, attention.row.event_id);
  } finally { h.close(); }
});

test("通常attentionの投稿中は取消を曖昧なまま進めずreconcileを要求する", () => {
  const h = new SchedulerIntegrationHarness();
  try {
    const { source, jobs } = regularJobs(h); const job = jobs[0]!;
    h.raw.prepare("UPDATE jobs SET available_at=? WHERE job_id=?").run(new Date(h.clock.now()).toISOString(), job.job_id);
    running(h, job); h.database.markJobBlocked(job.job_id, "入力待ち");
    const attention = h.database.enqueueJobNotification(job.job_id);
    h.database.beginDispatch(attention.row.event_id, path.join(h.root,"notice.json"));
    assert.throws(() => h.database.beginJobCancellation(job.job_id, source.event_id), /reconciliation/);
    assert.equal(h.database.getJob(job.job_id)?.status, "blocked");
    assert.equal(h.database.get(attention.row.event_id)?.status, "dispatching");
  } finally { h.close(); }
});
