import http from "node:http";

import type { DispatcherConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { readPrivateToken } from "../private-token.js";
import type { Clock } from "./clock.js";
import type { Outbox, SchedulerRepository, Target } from "./repository.js";

export interface SlackReminderCommand {
  schema_version: 1; action: "slack.reminder.post"; outbox_id: string; run_id: string;
  idempotency_key: string; owner_id: string; expires_at: string; misfire_at: string; target: Exclude<Target, { kind: "none" }>; text: string;
}
export type ReminderDelivery =
  | { outcome: "accepted"; receipt_id: string }
  | { outcome: "not_accepted"; code: string; retry_after_seconds: number }
  | { outcome: "authorization_unavailable"; code: string; retry_after_seconds: number }
  | { outcome: "unavailable"; code: string; retry_after_seconds: number }
  | { outcome: "rejected"; code: string }
  | { outcome: "revoked"; code: string }
  | { outcome: "misfire"; code: string }
  | { outcome: "acceptance_unknown"; code: string };
export interface SlackReminderPort { deliver(command: SlackReminderCommand): Promise<ReminderDelivery> }

function command(repository: SchedulerRepository, row: Outbox): SlackReminderCommand {
  if (row.kind !== "slack.reminder.post" || row.content === null) throw new Error("invalid_reminder_outbox");
  const target = JSON.parse(row.target_json) as Target;
  if (target.kind === "none" || target.workspace_id.length === 0 || target.channel_id.length === 0) throw new Error("invalid_reminder_target");
  const constraints = repository.reminderConstraints(row.outbox_id);
  if (!constraints) throw new Error("invalid_reminder_owner");
  return { schema_version: 1, action: "slack.reminder.post", outbox_id: row.outbox_id, run_id: row.run_id, ...constraints,
    idempotency_key: row.idempotency_key, target, text: row.content };
}

export class ReminderPublisher {
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private loopPromise: Promise<void> | undefined;
  constructor(private readonly repository: SchedulerRepository, private readonly slack: SlackReminderPort,
    private readonly clock: Clock, private readonly logger: Logger, private readonly pollMs = 1_000) {}
  start(): void { if (!this.running) { this.running = true; this.loopPromise = this.tick(); } }
  async stop(): Promise<void> { this.running = false; if (this.timer) clearTimeout(this.timer); await this.loopPromise; }
  isRunning(): boolean { return this.running; }
  async publishOne(): Promise<boolean> {
    const now = this.clock.now();
    const claimed = this.repository.claim(now, 60, "slack.reminder.post");
    if (!claimed) return false;
    const token = claimed.claim_token!;
    let input: SlackReminderCommand;
    try { input = command(this.repository, claimed); }
    catch { this.repository.requestStarted(claimed.outbox_id, token, now); this.repository.finishWrite(claimed.outbox_id, token, "ambiguous", now); return true; }
    // This durable transition is the last operation before the connector call. A crash afterwards is acceptance unknown.
    this.repository.requestStarted(claimed.outbox_id, token, now);
    let result: ReminderDelivery;
    try { result = await this.slack.deliver(input); }
    catch { result = { outcome: "acceptance_unknown", code: "connector_transport_error" }; }
    const finishedAt = this.clock.now();
    if (result.outcome === "accepted") this.repository.finishWrite(claimed.outbox_id, token, "sent", finishedAt, result.receipt_id);
    else if (result.outcome === "not_accepted") this.repository.finishWrite(claimed.outbox_id, token, "not_accepted", finishedAt, null, result.retry_after_seconds);
    else if (result.outcome === "authorization_unavailable") this.repository.finishWrite(claimed.outbox_id, token, "authorization_unavailable", finishedAt, null, result.retry_after_seconds);
    else if (result.outcome === "unavailable") this.repository.finishWrite(claimed.outbox_id, token, "unavailable", finishedAt, null, result.retry_after_seconds);
    else if (result.outcome === "rejected") this.repository.finishWrite(claimed.outbox_id, token, "rejected", finishedAt);
    else if (result.outcome === "revoked") this.repository.finishWrite(claimed.outbox_id, token, "revoked", finishedAt);
    else if (result.outcome === "misfire") this.repository.finishWrite(claimed.outbox_id, token, "misfire", finishedAt);
    else this.repository.finishWrite(claimed.outbox_id, token, "ambiguous", finishedAt);
    this.logger.info("Slack reminder delivery settled", { outbox_id: claimed.outbox_id, run_id: claimed.run_id, outcome: result.outcome,
      code: "code" in result ? result.code : undefined });
    return true;
  }
  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      while (this.running) {
        const settled = await Promise.all(Array.from({ length: 4 }, () => this.publishOne()));
        if (!settled.some(Boolean)) break;
      }
    }
    catch (error) { this.logger.error("Slack reminder publisher failed", { error_code: error instanceof Error ? error.message : "publisher_failed" }); }
    if (this.running) { this.timer = setTimeout(() => { this.loopPromise = this.tick(); }, this.pollMs); this.timer.unref(); }
  }
}

function request(socketPath: string, token: string, body: SlackReminderCommand, timeoutMs: number): Promise<ReminderDelivery> {
  const encoded = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: "/v1/internal/slack-reminders", method: "POST", headers: {
      "content-type": "application/json", "content-length": String(encoded.length), "x-dona-update-token": token,
    } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          if (parsed && typeof parsed === "object" && "outcome" in parsed) {
            resolve(parsed as ReminderDelivery);
            return;
          }
          const error = parsed?.error && typeof parsed.error === "object" ? parsed.error as Record<string, unknown> : undefined;
          const code = typeof error?.code === "string" ? error.code : "connector_unavailable";
          if (response.statusCode === 403) resolve({ outcome: "rejected", code: "internal_auth_failed" });
          else if (response.statusCode !== undefined && response.statusCode >= 500) resolve({ outcome: "unavailable", code, retry_after_seconds: 5 });
          else throw new Error("invalid_connector_response");
        } catch (error) { reject(error); }
      });
      response.once("aborted", () => reject(new Error("reminder_connector_response_aborted")));
      response.once("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("reminder_connector_timeout")));
    req.once("error", reject); req.end(encoded);
  });
}

export class SlackAdapterReminderClient implements SlackReminderPort {
  constructor(private readonly config: DispatcherConfig) {}
  async deliver(input: SlackReminderCommand): Promise<ReminderDelivery> {
    const token = await readPrivateToken(this.config.updateInternalTokenPath);
    if (!token) return { outcome: "unavailable", code: "missing_internal_token", retry_after_seconds: 5 };
    try { return await request(this.config.slackAdapterSocketPath, token, input, Math.max(this.config.jobCommandTimeoutMs, 180_000)); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ECONNREFUSED"
        ? { outcome: "unavailable", code: "connector_unavailable", retry_after_seconds: 5 }
        : { outcome: "acceptance_unknown", code: "connector_transport_error" };
    }
  }
}
