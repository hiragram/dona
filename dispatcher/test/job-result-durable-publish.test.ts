import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import Database from "better-sqlite3";

import { DispatcherDatabase } from "../src/database.js";
import { JobResultDurablePublisher } from "../src/job-result-durable-publish.js";
import { JobResultPublishCapabilities } from "../src/job-result-publish.js";
import type { AuthorizedJobResultPublish } from "../src/job-result-publish.js";
import { readJobResultEnvelope } from "../src/job-result.js";
import { eventEnvelope, tempConfig } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await fs.rm(roots.pop()!,{ recursive: true, force: true }); });

async function fixture() {
  const { root, config } = await tempConfig();
  roots.push(root);
  const database = new DispatcherDatabase(config.databasePath);
  const event = database.enqueue(eventEnvelope(`Ev-result-publish-${roots.length}`)).row;
  const job = database.createJob({ source_event_id: event.event_id, objective: "結果を確認する", workspace: { kind: "scratch" } },
    config.jobsWorkspaceRoot,config.jobResultsDir).row;
  database.beginJobPreparation(job.job_id);
  database.setJobRuntime(job.job_id,"workspace-1","pane-1","session-1");
  database.beginJobDispatch(job.job_id);
  await fs.mkdir(path.dirname(job.result_path),{ recursive: true, mode: 0o700 });
  const session = JSON.stringify(["workspace-1","pane-1",job.agent_name,"session-1"]);
  const grants = new JobResultPublishCapabilities(() => session);
  const grant = grants.issue(database.getJob(job.job_id)!,session);
  const request = { schema_version: 1, status: "completed", summary: "完了", artifacts: [{ kind: "report" }], actions: [] } as const;
  const candidate = (summary: string = request.summary): AuthorizedJobResultPublish =>
    grants.validate(grant.capability,session,{ ...request, summary },id => database.getJob(id));
  return { database, job, candidate, publisher: new JobResultDurablePublisher(database), config };
}

describe("永続Job Result公開", () => {
  test("単一winnerをfileとDBへ確定し、同payloadの再送と通知を冪等に扱う", async () => {
    const { database, job, candidate, publisher } = await fixture();
    try {
      const first = candidate();
      assert.deepEqual(await publisher.commit(first),{ outcome: "created", receipt_id: first.canonicalDigest });
      assert.deepEqual(await readJobResultEnvelope(job.result_path,job.job_id),first.envelope);
      assert.equal((await fs.stat(job.result_path)).mode & 0o077,0);
      assert.equal(database.getJob(job.job_id)?.status,"completed");
      assert.deepEqual(await publisher.reconcile(candidate()),{ outcome: "reused", receipt_id: first.canonicalDigest });
      assert.deepEqual(await publisher.commit(candidate()),{ outcome: "reused", receipt_id: first.canonicalDigest });
      assert.deepEqual(await publisher.reconcile(candidate("別の結果")),{ outcome: "conflict" });
      assert.throws(() => database.saveJobResult(job.job_id,{ ...first.envelope, summary: "別の結果" },job.result_path),
        /job_result_publish_reserved/);
      assert.throws(() => database.enqueueJobNotification(job.job_id,new Date(),() => {
        throw new Error("injected_notification_failure");
      }),/injected_notification_failure/);
      const firstNotice = database.enqueueJobNotification(job.job_id);
      const secondNotice = database.enqueueJobNotification(job.job_id);
      assert.equal(firstNotice.row.event_id,secondNotice.row.event_id);
      assert.equal(database.quarantineIncompletePublishedResults(),0);
    } finally { database.close(); }
  });

  test("rename後のDB失敗を再起動時に隔離し、read-only照合で成功と誤認しない", async () => {
    const { database, job, candidate, publisher, config } = await fixture();
    const publication = candidate();
    let checks = 0;
    publication.assertCurrentGrant = () => { if (++checks === 2) throw new Error("injected_commit_failure"); };
    try {
      await assert.rejects(publisher.commit(publication),/injected_commit_failure/);
      assert.deepEqual(await readJobResultEnvelope(job.result_path,job.job_id),publication.envelope);
      assert.deepEqual(await publisher.reconcile(candidate()),{ outcome: "pending" });
      database.close();
      const reopened = new DispatcherDatabase(config.databasePath);
      try {
        assert.equal(reopened.quarantineIncompletePublishedResults(),1);
        assert.equal(reopened.getJob(job.job_id)?.status,"needs_review");
        assert.equal(reopened.inspectPublishedJobResult(job.job_id,publication.canonicalDigest),"needs_review");
        assert.equal(reopened.quarantineIncompletePublishedResults(),0);
      } finally { reopened.close(); }
    } finally { /* Closed before reopen. */ }
  });

  test("file公開前の失敗と旧方式の確定を混ぜない", async () => {
    const { database, job, candidate, publisher } = await fixture();
    try {
      const publication = candidate();
      const temporary = `${job.result_path}.publish-${publication.canonicalDigest}.tmp`;
      await fs.writeFile(temporary,"stale",{ mode: 0o600 });
      await assert.rejects(publisher.commit(publication),/EEXIST/);
      assert.equal(database.inspectPublishedJobResult(job.job_id,publication.canonicalDigest),"pending");
      assert.throws(() => database.saveJobResult(job.job_id,publication.envelope,job.result_path),/job_result_publish_reserved/);
      assert.equal(database.quarantineIncompletePublishedResults(),1);
      assert.equal(database.getJob(job.job_id)?.status,"needs_review");
    } finally { database.close(); }
  });

  test("既存の旧方式Resultと異なるjobへの公開を拒否する", async () => {
    const { database, job, candidate, publisher } = await fixture();
    try {
      const publication = candidate();
      const wrongJob = candidate();
      wrongJob.envelope = { ...wrongJob.envelope, job_id: "job_other" };
      assert.deepEqual(await publisher.commit(wrongJob),{ outcome: "conflict" });
      await fs.writeFile(job.result_path,JSON.stringify(publication.envelope),{ mode: 0o600 });
      assert.deepEqual(await publisher.commit(publication),{ outcome: "conflict" });
      assert.equal(database.inspectPublishedJobResult(job.job_id,publication.canonicalDigest),"conflict");
    } finally { database.close(); }
  });

  test("DB確定後にfileが失われたらread-only照合がneeds_reviewを返す", async () => {
    const { database, job, candidate, publisher } = await fixture();
    try {
      const publication = candidate();
      assert.equal((await publisher.commit(publication)).outcome,"created");
      assert.equal(database.listJobsNeedingNotification().some(row => row.job_id === job.job_id),true);
      await fs.unlink(job.result_path);
      assert.deepEqual(await publisher.reconcile(candidate()),{ outcome: "needs_review" });
      assert.equal(database.quarantineIncompletePublishedResults(),1);
      assert.equal(database.inspectPublishedJobResult(job.job_id,publication.canonicalDigest),"needs_review");
      assert.equal(database.listJobsNeedingNotification().some(row => row.job_id === job.job_id),false);
      assert.throws(() => database.enqueueJobNotification(job.job_id),/published_result_reconciliation_required/);
    } finally { database.close(); }
  });

  for (const point of ["after_reserve","before_rename","after_rename","before_db_commit","after_db_commit"] as const) {
    test(`${point}の応答喪失をreceiptで照合する`, async () => {
      const { database, job, candidate } = await fixture();
      try {
        const publication = candidate();
        const publisher = new JobResultDurablePublisher(database,() => {},at => {
          if (at === point) throw new Error("injected_response_loss");
        });
        await assert.rejects(publisher.commit(publication),/injected_response_loss/);
        const state = database.inspectPublishedJobResult(job.job_id,publication.canonicalDigest);
        assert.equal(state,point === "after_db_commit" ? "reused" : "pending");
        if (point === "after_db_commit") {
          assert.equal(database.getJob(job.job_id)?.status,"completed");
          assert.equal(database.quarantineIncompletePublishedResults(),0);
        } else {
          assert.equal(database.getJob(job.job_id)?.result_json,null);
          assert.equal(database.quarantineIncompletePublishedResults(),1);
          assert.equal(database.inspectPublishedJobResult(job.job_id,publication.canonicalDigest),"needs_review");
        }
      } finally { database.close(); }
    });
  }

  test("DB busyの後はfileを保持し、別Resultへ置換しない", async () => {
    const { database, job, candidate, config } = await fixture();
    let lock: Database.Database | undefined;
    try {
      const publication = candidate();
      const publisher = new JobResultDurablePublisher(database,() => {},point => {
        if (point === "before_db_commit") {
          lock = new Database(config.databasePath);
          lock.exec("BEGIN IMMEDIATE");
        }
      });
      await assert.rejects(publisher.commit(publication),/database is locked/);
      assert.equal(database.inspectPublishedJobResult(job.job_id,publication.canonicalDigest),"pending");
      assert.equal((await readJobResultEnvelope(job.result_path,job.job_id)).summary,"完了");
      lock!.exec("ROLLBACK"); lock!.close(); lock = undefined;
      assert.deepEqual(await publisher.reconcile(candidate()),{ outcome: "pending" });
      assert.deepEqual(await publisher.reconcile(candidate("別の結果")),{ outcome: "conflict" });
    } finally { lock?.close(); database.close(); }
  });

  test("予約後にjobがterminal fenceを失えば未確定をpendingと表示しない", async () => {
    const { database, job, candidate } = await fixture();
    try {
      const publication = candidate();
      assert.equal(database.reservePublishedJobResult(publication).outcome,"reserved");
      database.markJobNeedsReview(job.job_id,"worker_observation_unknown","Worker observation is unknown");
      assert.equal(database.inspectPublishedJobResult(job.job_id,publication.canonicalDigest),"needs_review");
      assert.equal(database.commitPublishedJobResult(publication),"conflict");
    } finally { database.close(); }
  });
});
