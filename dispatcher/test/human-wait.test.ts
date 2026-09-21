import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, test } from "node:test";
import Database from "better-sqlite3";

import { DispatcherDatabase } from "../src/database.js";
import type { VerifiedSlackPrincipalProof } from "../src/principal-proof.js";
import { eventEnvelope, tempConfig } from "./helpers.js";
import { SchedulerIntegrationHarness } from "./support/scheduler-integration-harness.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))));

function proof(externalEventId: string, principal = "U_WAIT"): VerifiedSlackPrincipalProof {
  return {
    version: 1, key_id: "sha256:0123456789abcdef", event_id: externalEventId, attempt: 1,
    tenant_id: "T_TEST", workspace_id: "T_TEST", principal_kind: "human", principal_id: principal,
    issued_at: "2026-09-21T00:00:00.000Z", expires_at: "2026-09-21T00:02:00.000Z",
    nonce: `nonce-${createHash("sha256").update(externalEventId).digest("hex").slice(0, 24)}`,
    adapter_id: "slack_socket:T_TEST", proof_sha256: createHash("sha256").update(externalEventId).digest("hex"),
  };
}

async function jobFixture(jobKey = "wait.job") {
  const { root, config } = await tempConfig(); roots.push(root);
  const database = new DispatcherDatabase(config.databasePath);
  const envelope = eventEnvelope(`Ev-${jobKey.replaceAll(".", "-")}`);
  const source = database.enqueue(envelope, new Date("2026-09-21T00:00:30.000Z"), proof(envelope.external_event_id)).row;
  database.beginDispatch(source.event_id, `${config.resultsDir}/${source.event_id}.json`, new Date("2026-09-21T00:00:31.000Z"));
  database.markWaiting(source.event_id, new Date("2026-09-21T00:00:32.000Z"));
  const job = database.createJob({ source_event_id: source.event_id, job_key: jobKey, objective: "PRIVATE-CANARY-objective",
    workspace: { kind: "scratch" } }, config.jobsWorkspaceRoot, config.jobResultsDir, new Date("2026-09-21T00:00:40.000Z")).row;
  database.beginJobPreparation(job.job_id, new Date("2026-09-21T00:00:41.000Z"));
  database.beginJobDispatch(job.job_id, new Date("2026-09-21T00:00:42.000Z"));
  database.markJobRunning(job.job_id, new Date("2026-09-21T00:00:43.000Z"));
  return { database, config, source, job };
}

test("blocked jobをverified ownerの安全なwaitへ正規化しterminal transitionで解消する", async () => {
  const { database, config, source, job } = await jobFixture();
  database.markJobBlocked(job.job_id, "PRIVATE-CANARY-error");
  const [wait] = database.humanWaits.listInternal();
  assert.deepEqual({ owner: wait?.owner_kind, principal: wait?.owner_principal_id, reason: wait?.reason_code,
    decision: wait?.decision_kind, resource: wait?.resource_kind }, {
    owner: "human_verified", principal: "U_WAIT", reason: "human_input", decision: "provide_input", resource: "job",
  });
  assert.equal(JSON.stringify(wait).includes("PRIVATE-CANARY"), false);
  assert.match(wait!.item_id, /^wait_[0-9a-f]{32}$/);
  assert.match(wait!.origin_ref, /^origin_[0-9a-f]{32}$/);
  database.beginJobCancellation(job.job_id, source.event_id);
  database.markJobCancelled(job.job_id, "resolved", new Date("2026-09-21T00:01:00.000Z"));
  assert.equal(database.humanWaits.listInternal().length, 0);
  assert.equal(database.humanWaits.listInternal("resolved")[0]?.dedupe_key, `job:${job.job_id}`);
  assert.equal(database.humanWaits.purge(new Date(Date.now()+40*86_400_000).toISOString(),1),1);
  assert.equal(database.humanWaits.get(wait!.item_id),undefined);
  const auditDb=new Database(config.databasePath);
  const audit=auditDb.prepare("SELECT reason_class,transition,actor_class FROM human_wait_audit ORDER BY sequence").all();
  assert.equal(JSON.stringify(audit).includes("PRIVATE-CANARY"),false);
  assert.equal((audit.at(-1) as {transition:string}).transition,"purged");
  auditDb.close();
  database.close();
});

test("unknown reasonをallowlistへ縮退しrestartと同一根因の再openで重複しない", async () => {
  const { database, config, job } = await jobFixture("wait.restart");
  database.markJobNeedsReview(job.job_id, "PRIVATE-CANARY-code", "PRIVATE-CANARY-message");
  const first = database.humanWaits.listInternal()[0]!;
  assert.equal(first.reason_code, "operator_review_unknown");
  assert.equal(JSON.stringify(first).includes("PRIVATE-CANARY"), false);
  database.close();
  const reopened = new DispatcherDatabase(config.databasePath);
  assert.equal(reopened.humanWaits.listInternal().length, 1);
  reopened.markJobNeedsReview(job.job_id, "another_unknown", "not copied");
  assert.equal(reopened.humanWaits.listInternal().length, 1);
  assert.equal(reopened.humanWaits.listInternal()[0]?.item_id, first.item_id);
  reopened.close();
});

test("wall clockが逆行しても現在のsource stateを再投影する", async () => {
  const { database, config, job } = await jobFixture("wait.clock-rollback");
  database.markJobNeedsReview(job.job_id,"ambiguous_prompt_acceptance","unknown acceptance");
  const itemId=database.humanWaits.listInternal()[0]!.item_id;
  const raw=new Database(config.databasePath);
  raw.prepare("UPDATE jobs SET status='blocked',last_error_code='agent_blocked',updated_at=? WHERE job_id=?")
    .run("2026-01-01T00:00:00.000Z",job.job_id);
  raw.close();
  const wait=database.humanWaits.get(itemId)!;
  assert.equal(wait.reason_code,"human_input");
  assert.equal(wait.decision_kind,"provide_input");
  assert.equal(wait.source_revision,"2026-01-01T00:00:00.000Z");
  database.close();
});

test("source transition rollback時はwaitだけを残さずcommit後は一度だけ作る", async () => {
  const { database, config, job } = await jobFixture("wait.transaction-fault");
  const raw=new Database(config.databasePath);
  const fail=raw.transaction(()=>{
    raw.prepare("UPDATE jobs SET status='needs_review',last_error_code='prompt_interrupted',updated_at=? WHERE job_id=?")
      .run("2026-09-21T01:00:00.000Z",job.job_id);
    throw new Error("injected_after_source_update");
  });
  assert.throws(fail,/injected_after_source_update/);
  assert.equal(database.humanWaits.listInternal().length,0);
  raw.prepare("UPDATE jobs SET status='needs_review',last_error_code='prompt_interrupted',updated_at=? WHERE job_id=?")
    .run("2026-09-21T01:00:01.000Z",job.job_id);
  assert.equal(database.humanWaits.listInternal().length,1);
  raw.close();database.close();
});

test("group attentionはbounded snapshotのroot waitへ束ね個別waitを閉じる", async () => {
  const { database, config, source, job } = await jobFixture("wait.group.one");
  const transitionAt = new Date(Date.now() + 60_000);
  const second = database.createJob({ source_event_id: source.event_id, job_key: "wait.group.two", objective: "second",
    workspace: { kind: "scratch" } }, config.jobsWorkspaceRoot, config.jobResultsDir, new Date("2026-09-21T00:00:44.000Z")).row;
  database.markJobBlocked(job.job_id, "input");
  database.saveCompleted(source.event_id, { schema_version:1,event_id:source.event_id,status:"completed",summary:"sealed",actions:[],
    completed_at:transitionAt.toISOString() }, "/tmp/human-wait-source-result.json", transitionAt);
  const notification = database.enqueueJobNotification(job.job_id, new Date(transitionAt.getTime()+1_000));
  assert.notEqual(notification.row.event_id, source.event_id);
  const waits = database.humanWaits.listInternal();
  assert.equal(waits.some(item => item.dedupe_key === `job:${job.job_id}`), false);
  const group = waits.find(item => item.resource_kind === "job_group");
  assert.equal(group?.resource_id, source.event_id);
  assert.equal(group?.owner_principal_id, "U_WAIT");
  assert.equal(JSON.stringify(group).includes(second.objective), false);
  const terminalEvent=database.enqueue(eventEnvelope("Ev-group-terminal")).row;
  database.claimJobGroupTransition(source.event_id,"all_terminal",terminalEvent.event_id,new Date(transitionAt.getTime()+2_000));
  assert.equal(database.humanWaits.listInternal().length,0);
  database.close();
});

test("session waitはdurable causeとverified suspended settlementの両方がある場合だけ昇格する", async () => {
  const { database, source, job } = await jobFixture("wait.session");
  const transitionAt = new Date(Date.now() + 60_000);
  database.markJobBlocked(job.job_id, "input");
  database.saveCompleted(source.event_id, { schema_version:1,event_id:source.event_id,status:"completed",summary:"sealed",actions:[],
    completed_at:transitionAt.toISOString() }, "/tmp/human-wait-session-source.json", transitionAt);
  const notification = database.enqueueJobNotification(job.job_id, new Date(transitionAt.getTime()+1_000)).row;
  const settledAt = new Date(transitionAt.getTime()+2_000).toISOString();
  const receipt={event_id:notification.event_id,workspace_id:"T_TEST",channel_id:"C_TEST",thread_ts:"1756722030.123456",
    desired_session_status:"suspended" as const,session_status:"suspended" as const};
  assert.equal(database.humanWaits.recordVerifiedSessionSettlement({...receipt,session_status:"active"}, settledAt), false);
  assert.equal(database.humanWaits.recordVerifiedSessionSettlement(receipt, settledAt), true);
  const waits = database.humanWaits.listInternal();
  assert.equal(waits.length, 1);
  assert.equal(waits[0]?.session_settlement_verified, 1);
  assert.equal(waits[0]?.owner_principal_id, "U_WAIT");
  database.close();
});

test("repairはbounded cursorとsnapshot fenceを持ちdry-runでは変更しない", async () => {
  const { database, job } = await jobFixture("wait.repair");
  database.markJobNeedsReview(job.job_id, "unknown", "redacted");
  const snapshot = new Date(Date.now()+60_000).toISOString();
  const dry = database.humanWaits.repair({ dryRun:true,limit:1,snapshotRevision:snapshot });
  assert.deepEqual({dry:dry.dry_run,scanned:dry.scanned,repaired:dry.repaired},{dry:true,scanned:1,repaired:0});
  assert.match(dry.digest,/^[0-9a-f]{64}$/);
  assert.throws(() => database.humanWaits.repair({dryRun:false,limit:501,snapshotRevision:snapshot}),/limit/);
  database.close();
});

test("repair snapshot後のlive transitionを別connectionから上書きしない", async () => {
  const { database, config, job } = await jobFixture("wait.concurrent-repair");
  database.markJobNeedsReview(job.job_id,"ambiguous_prompt_acceptance","unknown acceptance");
  const snapshot=database.humanWaits.listInternal()[0]!.source_revision;
  await new Promise(resolve=>setTimeout(resolve,2));
  const peer=new DispatcherDatabase(config.databasePath);
  peer.markJobNeedsReview(job.job_id,"new_unknown_reason","newer transition");
  const current=peer.humanWaits.listInternal()[0]!;
  assert.equal(current.reason_code,"operator_review_unknown");
  database.humanWaits.repair({dryRun:false,limit:500,snapshotRevision:snapshot});
  assert.deepEqual(database.humanWaits.get(current.item_id),current);
  peer.close();database.close();
});

test("schema導入後のbounded repairは既存rowをbackfillしlegacy actorをownerへ昇格しない", async () => {
  const { database, config, job } = await jobFixture("wait.migration");
  database.markJobNeedsReview(job.job_id, "unknown", "PRIVATE-CANARY-migration");
  database.close();
  const raw = new Database(config.databasePath);
  raw.exec(`
    DROP TRIGGER IF EXISTS human_wait_job_insert; DROP TRIGGER IF EXISTS human_wait_job_update;
    DROP TRIGGER IF EXISTS human_wait_job_binding_insert; DROP TRIGGER IF EXISTS human_wait_group_update;
    DROP TRIGGER IF EXISTS human_wait_schedule_run_insert; DROP TRIGGER IF EXISTS human_wait_schedule_run_update;
    DROP TRIGGER IF EXISTS human_wait_schedule_revision; DROP TRIGGER IF EXISTS human_wait_completion_update;
    DROP TRIGGER IF EXISTS human_wait_outbox_insert; DROP TRIGGER IF EXISTS human_wait_outbox_update;
    DROP TRIGGER IF EXISTS human_wait_audit_insert; DROP TRIGGER IF EXISTS human_wait_audit_state;
    DROP TRIGGER IF EXISTS human_wait_no_sensitive_insert;
    DROP TABLE human_wait_quarantine; DROP TABLE human_wait_audit; DROP TABLE human_wait_items; DROP TABLE human_wait_schema;
    DELETE FROM job_authorization_bindings WHERE job_id='${job.job_id}';
  `);
  raw.close();
  const migrated = new DispatcherDatabase(config.databasePath);
  assert.equal(migrated.humanWaits.listInternal().length, 0);
  const repaired = migrated.humanWaits.repair({dryRun:false,limit:20,snapshotRevision:new Date(Date.now()+60_000).toISOString()});
  assert.equal(repaired.repaired, 1);
  const wait=migrated.humanWaits.listInternal()[0]!;
  assert.equal(wait.owner_kind,"unknown");
  assert.equal(wait.owner_principal_id,null);
  assert.equal(JSON.stringify({repaired,wait}).includes("PRIVATE-CANARY"),false);
  migrated.close();
});

test("schedule runとnotification needs_reviewを永続ownerへbindして解消する", () => {
  const harness = new SchedulerIntegrationHarness("2026-09-05T00:00:00Z");
  try {
    const due="2026-09-05T00:01:00Z";
    const runId=harness.materialize("human-wait-reminder",harness.input("slack.reminder.post",false,due),due);
    const outbox=harness.raw.prepare("SELECT outbox_id FROM connector_outbox WHERE run_id=?").get(runId) as {outbox_id:string};
    harness.raw.prepare("UPDATE schedule_runs SET status='needs_review',reason='ambiguous_write',terminal_at=? WHERE run_id=?").run(due,runId);
    harness.raw.prepare("UPDATE connector_outbox SET status='needs_review',updated_at=?,terminal_at=? WHERE outbox_id=?").run(due,due,outbox.outbox_id);
    const open=harness.database.humanWaits.listInternal();
    assert.deepEqual(open.map(item=>item.resource_kind).sort(),["notification","schedule_run"]);
    assert.equal(open.every(item=>item.owner_kind==="schedule"&&item.owner_principal_id==="U_GATE"),true);
    harness.raw.prepare("DELETE FROM human_wait_items").run();
    const repaired=harness.database.humanWaits.repair({dryRun:false,limit:500,snapshotRevision:"2026-09-05T00:03:00.000Z"});
    assert.equal(repaired.repaired>=2,true);
    assert.deepEqual(harness.database.humanWaits.listInternal().map(item=>item.resource_kind).sort(),["notification","schedule_run"]);
    const run=harness.raw.prepare("SELECT schedule_id FROM schedule_runs WHERE run_id=?").get(runId) as {schedule_id:string};
    const columns=(harness.raw.prepare("PRAGMA table_info(schedule_revisions)").all() as Array<{name:string}>).map(({name})=>name);
    harness.raw.prepare(`INSERT INTO schedule_revisions(${columns.join(",")}) SELECT ${columns.map(name=>name==="revision"?"2":name).join(",")}
      FROM schedule_revisions WHERE schedule_id=? AND revision=1`).run(run.schedule_id);
    harness.raw.prepare("UPDATE schedules SET revision=2,updated_at=? WHERE schedule_id=?").run("2026-09-05T00:03:00Z",run.schedule_id);
    assert.equal(harness.database.humanWaits.listInternal().length,0);
    assert.deepEqual(harness.database.humanWaits.listInternal("stale").map(item=>item.resource_kind).sort(),["notification","schedule_run"]);
    harness.raw.prepare("UPDATE connector_outbox SET status='sent',updated_at=? WHERE outbox_id=?").run("2026-09-05T00:02:00Z",outbox.outbox_id);
    harness.raw.prepare("UPDATE schedule_runs SET status='completed',reason=NULL,terminal_at=? WHERE run_id=?").run("2026-09-05T00:02:00Z",runId);
    assert.equal(harness.database.humanWaits.listInternal().length,0);
  } finally { harness.close(); }
});
