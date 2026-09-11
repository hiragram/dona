import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { DispatcherDatabase } from "../../src/database.js";
import type { Logger } from "../../src/logger.js";
import { FakeClock } from "../../src/scheduler/clock.js";
import { ReminderPublisher, type ReminderDelivery, type SlackReminderCommand } from "../../src/scheduler/reminder-publisher.js";
import type { Actor, RevisionInput } from "../../src/scheduler/repository.js";
import { SchedulerService } from "../../src/scheduler/service.js";

export const integrationLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
export const integrationActor: Actor = { tenant_id: "T_GATE", actor_id: "U_GATE", role: "owner", source_event_id: null };

export class FaultInjector {
  private readonly armed = new Set<string>();
  private readonly fired = new Map<string, number>();
  arm(point: string): void { this.armed.add(point); }
  hit(point: string): void {
    if (!this.armed.delete(point)) return;
    this.fired.set(point, (this.fired.get(point) ?? 0) + 1);
    throw new Error(`injected:${point}`);
  }
  count(point: string): number { return this.fired.get(point) ?? 0; }
}

export class FakeSlack {
  readonly calls: SlackReminderCommand[] = [];
  constructor(private readonly outcomes: ReminderDelivery[]) {}
  async preflight(): Promise<ReminderDelivery> { return { outcome: "prepared" }; }
  async deliver(command: SlackReminderCommand): Promise<ReminderDelivery> {
    this.calls.push(command);
    return this.outcomes.shift() ?? { outcome: "accepted", receipt_id: `fake-${this.calls.length}` };
  }
}

export class FakeJobRuntime {
  readonly calls: Array<{ event_id: string; objective: string }> = [];
  run(harness: SchedulerIntegrationHarness, eventId: string, objective: string): { job_id: string; status: "completed"; summary: string } {
    this.calls.push({ event_id: eventId, objective });
    harness.database.beginDispatch(eventId, path.join(harness.root, "event-results", `${eventId}.json`), new Date(harness.clock.now()));
    harness.database.recordScheduleJobAccess(eventId, { workspace_id: "T_GATE", channel_id: "C_GATE", user_id: "U_GATE",
      issued_at: new Date(harness.clock.now()).toISOString(), nonce: `receipt_${eventId}` }, new Date(harness.clock.now()));
    const created = harness.database.createJob({ source_event_id: eventId, objective, workspace: { kind: "scratch" } },
      path.join(harness.root, "jobs"), path.join(harness.root, "results"), new Date(harness.clock.now()));
    const job = created.row;
    harness.database.beginJobPreparation(job.job_id, new Date(harness.clock.now()));
    harness.database.beginJobDispatch(job.job_id, new Date(harness.clock.now()));
    harness.database.markJobRunning(job.job_id, new Date(harness.clock.now()));
    harness.database.saveCompleted(eventId, { schema_version: 1, event_id: eventId, status: "completed", summary: "job delegated",
      actions: [], completed_at: harness.clock.now() }, path.join(harness.root, "event-results", `${eventId}.json`), new Date(harness.clock.now()));
    harness.clock.advance(1);
    harness.database.saveJobResult(job.job_id, { schema_version: 1, job_id: job.job_id, status: "completed",
      summary: "read-only work completed", output: { format: "markdown", text: "fixture result" }, actions: [],
      completed_at: harness.clock.now() }, job.result_path, new Date(harness.clock.now()));
    const notification = harness.database.enqueueJobNotification(job.job_id, new Date(harness.clock.now())).row;
    if (notification.event_id !== eventId) {
      const payload = JSON.parse(notification.payload_json) as { result: { summary: string } };
      const bodyHash = createHash("sha256").update(payload.result.summary).digest("hex");
      harness.database.beginDispatch(notification.event_id, path.join(harness.root, "event-results", `${notification.event_id}.json`), new Date(harness.clock.now()));
      harness.database.authorizeJobNotification(notification.event_id, new Date(harness.clock.now()));
      harness.database.authorizeJobNotification(notification.event_id, new Date(harness.clock.now()), { workspace_id: "T_GATE", channel_id: "C_GATE",
        user_id: "U_GATE", issued_at: new Date(harness.clock.now()).toISOString(), nonce: `notify_${notification.event_id}` });
      harness.database.saveCompleted(notification.event_id, { schema_version: 1, event_id: notification.event_id, status: "completed", actions: [
        { tool: "dona_dispatcher.authorize_job_notification", event_id: notification.event_id, authorized: true },
        { tool: "dona_slack.check_user_channel_access", workspace: "test", workspace_id: "T_GATE", channel_id: "C_GATE", user_id: "U_GATE", authorized: true },
        { tool: "dona_dispatcher.authorize_job_notification", event_id: notification.event_id, authorized: true, access_receipt_verified: true },
        { tool: "dona_slack.post_message", event_id: notification.event_id, workspace: "test", channel_id: "C_GATE", thread_ts: "1.000001",
          message_ts: "2.000001", body_sha256: bodyHash, reply_broadcast: false, mrkdwn: false, parse: "none" },
        { tool: "dona_slack.set_agent_session_status", workspace: "test", channel_id: "C_GATE", thread_ts: "1.000001", status: "active" },
      ], completed_at: harness.clock.now() }, path.join(harness.root, "event-results", `${notification.event_id}.json`), new Date(harness.clock.now()),
      { event_id: notification.event_id, workspace_id: "T_GATE", channel_id: "C_GATE", thread_ts: "1.000001", message_ts: "2.000001",
        body_sha256: bodyHash, posted_at: harness.clock.now(), reply_broadcast: false, identity_block_verified: true, session_status: "active" });
    }
    return { job_id: job.job_id, status: "completed", summary: "read-only work completed" };
  }
}

export class SchedulerIntegrationHarness {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), "dona-scheduler-gate-"));
  readonly filename = path.join(this.root, "dispatcher.sqlite");
  readonly database = new DispatcherDatabase(this.filename);
  readonly raw = new Database(this.filename);
  readonly clock: FakeClock;
  readonly repo = this.database.scheduler.withCodecs({ recurrence: value => value, policy: value => value });
  readonly fault = new FaultInjector();
  private readonly policy = fs.readFileSync(new URL("../../../docs/adr/fixtures/scheduler-v1/policy.json", import.meta.url), "utf8");

  constructor(at = "2026-09-05T00:00:00Z") { this.clock = new FakeClock(at); }
  close(): void { this.raw.close(); this.database.close(); fs.rmSync(this.root, { recursive: true, force: true }); }

  input(action: "slack.reminder.post" | "work.read_only", recurring: boolean, due: string): RevisionInput {
    const authorizationEvent = action === "work.read_only" ? this.database.enqueue({ schema_version: 1, source: "slack",
      external_event_id: `gate-auth-${recurring}`, type: "app_mention", occurred_at: new Date(this.clock.now()).toISOString(),
      subject: { workspace_id: "T_GATE", channel_id: "C_GATE", thread_ts: "1.000001", actor_id: "U_GATE" }, payload: { text: "schedule" },
      reply_target: { kind: "slack_thread", workspace_id: "T_GATE", channel_id: "C_GATE", thread_ts: "1.000001" } }).row : undefined;
    return {
      recurrence_json: recurring
        ? '{"interval":1,"kind":"daily","local_time":"09:01:00","start_date":"2026-09-05","timezone":"Asia/Tokyo","tzdb_version":"2025b","version":1}\n'
        : `${JSON.stringify({ at: due, kind: "once", version: 1 })}\n`,
      policy_json: this.policy, policy_version: 1,
      timezone: recurring ? "Asia/Tokyo" : null, tzdb_version: recurring ? "2025b" : null,
      authorization_id: authorizationEvent ? `${authorizationEvent.event_id}:1` : `auth_${action.replaceAll(".", "_")}_${recurring}`, authorization_revision: 1,
      approver_id: integrationActor.actor_id, approved_at: this.clock.now(), expires_at: "2026-09-30T00:00:00Z",
      action,
      target: { kind: "thread", workspace_id: "T_GATE", channel_id: "C_GATE", thread_ts: "1.000001" },
      content: action === "slack.reminder.post" ? "fixture reminder" : "inspect repository read-only",
    };
  }

  materialize(scheduleId: string, input: RevisionInput, due: string): string {
    this.repo.create(scheduleId, input, due, integrationActor, this.clock.now());
    this.clock.set(due);
    const service = new SchedulerService(this.repo, this.clock, () => {}, integrationLogger, { owner: "gate-instance" });
    assert.equal(service.runBatch(), 1);
    const row = this.raw.prepare("SELECT run_id FROM schedule_runs WHERE schedule_id=?").get(scheduleId) as { run_id: string };
    return row.run_id;
  }

  publisher(slack: FakeSlack): ReminderPublisher {
    return new ReminderPublisher(this.repo, slack, this.clock, integrationLogger);
  }

  reopen(): SchedulerIntegrationHarness {
    this.raw.close(); this.database.close();
    const reopened = Object.create(SchedulerIntegrationHarness.prototype) as SchedulerIntegrationHarness;
    Object.assign(reopened, {
      root: this.root, filename: this.filename,
      database: new DispatcherDatabase(this.filename), raw: new Database(this.filename), clock: new FakeClock(this.clock.now()), fault: this.fault,
    });
    Object.defineProperty(reopened, "repo", { value: reopened.database.scheduler.withCodecs({ recurrence: (value: string) => value, policy: (value: string) => value }) });
    Object.defineProperty(reopened, "policy", { value: this.policy });
    return reopened;
  }
}
