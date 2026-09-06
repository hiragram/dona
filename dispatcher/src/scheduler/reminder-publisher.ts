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
  | { outcome: "prepared" }
  | { outcome: "accepted"; receipt_id: string }
  | { outcome: "not_accepted"; code: string; retry_after_seconds: number }
  | { outcome: "authorization_unavailable"; code: string; retry_after_seconds: number }
  | { outcome: "unavailable"; code: string; retry_after_seconds: number }
  | { outcome: "rejected"; code: string }
  | { outcome: "revoked"; code: string }
  | { outcome: "misfire"; code: string }
  | { outcome: "acceptance_unknown"; code: string };
export interface SlackReminderPort {
  preflight(command: SlackReminderCommand): Promise<ReminderDelivery>;
  deliver(command: SlackReminderCommand): Promise<ReminderDelivery>;
}

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
    const claimed = this.repository.claim(now, 240, "slack.reminder.post");
    if (!claimed) return false;
    await this.publishClaimed(claimed, now);
    return true;
  }
  private async publishClaimed(claimed: Outbox, now: string): Promise<void> {
    const token = claimed.claim_token!;
    let input: SlackReminderCommand;
    try { input = command(this.repository, claimed); }
    catch { this.repository.rejectClaimBeforeWrite(claimed.outbox_id, token, now, "invalid_command"); return; }
    let result: ReminderDelivery;
    try { result = await this.slack.preflight(input); }
    catch { result = { outcome: "unavailable", code: "connector_unavailable", retry_after_seconds: 5 }; }
    if (result.outcome !== "prepared") {
      const finishedAt = this.clock.now();
      if (result.outcome === "authorization_unavailable") this.repository.finishWriteAfterPreflight(claimed.outbox_id, token, "authorization_unavailable", finishedAt, result.retry_after_seconds, result.code);
      else if (result.outcome === "unavailable" || result.outcome === "not_accepted") this.repository.finishWriteAfterPreflight(claimed.outbox_id, token, "unavailable", finishedAt, result.retry_after_seconds, result.code);
      else this.repository.finishWriteAfterPreflight(claimed.outbox_id, token, result.outcome === "revoked" ? "revoked" : result.outcome === "misfire" ? "misfire" : "rejected", finishedAt, 0, "code" in result ? result.code : "preflight_failed");
      return;
    }
    // This durable transition is the last operation before the provider write call. A crash afterwards is acceptance unknown.
    this.repository.requestStarted(claimed.outbox_id, token, this.clock.now());
    try { result = await this.slack.deliver(input); }
    catch { result = { outcome: "acceptance_unknown", code: "connector_transport_error" }; }
    const finishedAt = this.clock.now();
    if (result.outcome === "accepted") this.repository.finishWrite(claimed.outbox_id, token, "sent", finishedAt, result.receipt_id);
    else if (result.outcome === "not_accepted") this.repository.finishWrite(claimed.outbox_id, token, "not_accepted", finishedAt, null, result.retry_after_seconds, result.code);
    else if (result.outcome === "authorization_unavailable") this.repository.finishWrite(claimed.outbox_id, token, "authorization_unavailable", finishedAt, null, result.retry_after_seconds, result.code);
    else if (result.outcome === "unavailable") this.repository.finishWrite(claimed.outbox_id, token, "unavailable", finishedAt, null, result.retry_after_seconds, result.code);
    else if (result.outcome === "rejected") this.repository.finishWrite(claimed.outbox_id, token, "rejected", finishedAt, null, 0, result.code);
    else if (result.outcome === "revoked") this.repository.finishWrite(claimed.outbox_id, token, "revoked", finishedAt, null, 0, result.code);
    else if (result.outcome === "misfire") this.repository.finishWrite(claimed.outbox_id, token, "misfire", finishedAt, null, 0, result.code);
    else this.repository.finishWrite(claimed.outbox_id, token, "ambiguous", finishedAt, null, 0,
      "code" in result ? result.code : "invalid_connector_response");
    this.logger.info("Slack reminder delivery settled", { outbox_id: claimed.outbox_id, run_id: claimed.run_id, outcome: result.outcome,
      code: "code" in result ? result.code : undefined });
  }
  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      // Start from one tenant-fair batch, then refill each of the at most 100 slots as soon as it
      // finishes so a slow authorization lookup cannot hold completed capacity behind a barrier.
      const initialAt = this.clock.now();
      const initial = this.repository.claimBatch(initialAt, 240, "slack.reminder.post", 100);
      const worker = async (first: Outbox | undefined): Promise<void> => {
        let row: Outbox | undefined = first;
        while (this.running) {
          row ??= this.repository.claim(this.clock.now(), 240, "slack.reminder.post");
          if (!row) return;
          await this.publishClaimed(row, this.clock.now());
          row = undefined;
        }
      };
      const settled = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => worker(initial[index])));
      const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
    }
    catch (error) { this.logger.error("Slack reminder publisher failed", { error_code: error instanceof Error ? error.message : "publisher_failed" }); }
    if (this.running) { this.timer = setTimeout(() => { this.loopPromise = this.tick(); }, this.pollMs); this.timer.unref(); }
  }
}

function request(socketPath: string, token: string, path: string, body: SlackReminderCommand, timeoutMs: number): Promise<ReminderDelivery> {
  const encoded = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method: "POST", headers: {
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
          if (response.statusCode === 403) resolve({ outcome: "unavailable", code: "internal_auth_failed", retry_after_seconds: 5 });
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
  private readonly preparedTokens = new Map<string, string>();
  constructor(private readonly config: DispatcherConfig) {}
  async preflight(input: SlackReminderCommand): Promise<ReminderDelivery> {
    const token = await readPrivateToken(this.config.updateInternalTokenPath);
    if (!token) return { outcome: "unavailable", code: "missing_internal_token", retry_after_seconds: 5 };
    const result = await this.call(input, "/v1/internal/slack-reminders/preflight", token);
    if (result.outcome === "prepared") {
      this.preparedTokens.set(input.outbox_id, token);
      const cleanup = setTimeout(() => {
        if (this.preparedTokens.get(input.outbox_id) === token) this.preparedTokens.delete(input.outbox_id);
      }, 2_000);
      cleanup.unref();
    }
    return result;
  }
  async deliver(input: SlackReminderCommand): Promise<ReminderDelivery> {
    const token = this.preparedTokens.get(input.outbox_id);
    this.preparedTokens.delete(input.outbox_id);
    if (!token) return { outcome: "unavailable", code: "preflight_token_expired", retry_after_seconds: 0 };
    return await this.call(input, "/v1/internal/slack-reminders", token);
  }
  private async call(input: SlackReminderCommand, path: string, token: string): Promise<ReminderDelivery> {
    const timeoutMs = path.endsWith("/preflight") ? 180_000 : Math.max(this.config.jobCommandTimeoutMs, 180_000);
    try { return await request(this.config.slackAdapterSocketPath, token, path, input, timeoutMs); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (path.endsWith("/preflight")) {
        return code === "ENOENT" || code === "ECONNREFUSED"
          ? { outcome: "unavailable", code: "connector_unavailable", retry_after_seconds: 5 }
          : { outcome: "authorization_unavailable", code: "authorization_check_failed", retry_after_seconds: 5 };
      }
      return code === "ENOENT" || code === "ECONNREFUSED"
        ? { outcome: "unavailable", code: "connector_unavailable", retry_after_seconds: 5 }
        : { outcome: "acceptance_unknown", code: "connector_transport_error" };
    }
  }
}
