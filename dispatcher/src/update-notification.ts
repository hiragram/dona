import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import Database from "better-sqlite3";

import type { DispatcherConfig } from "./config.js";
import type { DispatcherDatabase } from "./database.js";
import type { Logger } from "./logger.js";
import { envelopeFromRow } from "./prompt.js";
import { readPrivateToken } from "./private-token.js";
import { readResultEnvelope, ResultNotFoundError } from "./result.js";
import type { EventEnvelope, EventRow, ResultEnvelope } from "./types.js";
import { parseInternalUpdateEventEnvelope, stableStringify } from "./validation.js";

export type UpdateNotificationStatus = "pending" | "delivering" | "posted" | "reported" | "needs_review";

export interface UpdateNotificationRow {
  event_id: string;
  notification_id: string;
  request_id: string;
  terminal_fence: number;
  payload_json: string;
  reply_target_json: string;
  rendered_text: string;
  desired_session_status: "active" | "suspended";
  status: UpdateNotificationStatus;
  attempt_count: number;
  available_at: string;
  post_started_at: string | null;
  message_ts: string | null;
  post_status: "created" | "existing" | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface SlackNotificationReceipt {
  notification_id: string;
  workspace_id: string;
  channel_id: string;
  thread_ts: string;
  message_ts: string;
  post_status: "created" | "existing";
  session_status: "active" | "suspended";
}

export type SlackNotificationOutcome =
  | { outcome: "reported"; receipt: SlackNotificationReceipt }
  | { outcome: "retryable"; code: string; message: string }
  | { outcome: "permanent"; code: string; message: string; receipt?: SlackNotificationReceipt };

export interface SlackNotificationPort {
  deliver(input: Record<string, unknown>): Promise<SlackNotificationOutcome>;
}

const retryDelaysMs = [5_000, 30_000, 120_000, 600_000] as const;

function retryAt(attempt: number, at: Date): string {
  const delay = retryDelaysMs[Math.min(Math.max(attempt - 1, 0), retryDelaysMs.length - 1)]!;
  return new Date(at.getTime() + delay).toISOString();
}

function slackReceipt(value: unknown): SlackNotificationReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  if (typeof receipt.notification_id !== "string" || typeof receipt.workspace_id !== "string" ||
    typeof receipt.channel_id !== "string" || typeof receipt.thread_ts !== "string" ||
    typeof receipt.message_ts !== "string" ||
    (receipt.post_status !== "created" && receipt.post_status !== "existing") ||
    (receipt.session_status !== "active" && receipt.session_status !== "suspended")) return undefined;
  return receipt as unknown as SlackNotificationReceipt;
}

function terminalFence(externalEventId: string): number {
  const value = Number(/:terminal:(\d+)$/.exec(externalEventId)?.[1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("terminal fence is invalid");
  return value;
}

interface RenderedNotification {
  requestId: string;
  terminalFence: number;
  text: string;
  desiredSessionStatus: "active" | "suspended";
}

export function renderUpdateNotification(envelopeInput: EventEnvelope): RenderedNotification {
  const envelope = parseInternalUpdateEventEnvelope(envelopeInput);
  const payload = envelope.payload as {
    request_id: string;
    update_status: "succeeded" | "failed" | "rolled_back" | "needs_review" | "cancelled";
    current_sha: string;
    target_sha: string;
    active_sha: string | null;
    error: { code: string; message: string | null } | null;
  };
  const fence = terminalFence(envelope.external_event_id);
  const active = payload.active_sha ? `\`${payload.active_sha}\`` : null;
  let text: string;
  let desiredSessionStatus: "active" | "suspended";
  switch (payload.update_status) {
    case "succeeded":
      if (!active || (fence === 1 && payload.active_sha !== payload.target_sha)) {
        throw new Error("succeeded update must report a confirmed active SHA");
      }
      text = fence > 1 && payload.active_sha !== payload.target_sha
        ? `確認の結果、対象のセルフアップデートは \`${payload.target_sha}\` への切替を完了していました。現在の稼働SHAは ${active} です。`
        : fence > 1
          ? `確認の結果、セルフアップデートは完了していました。稼働SHAは ${active} です。Dispatcher、Slack Adapter、メインエージェントが対象releaseで稼働していることを確認しました。`
          : `セルフアップデートが完了しました。稼働SHAは ${active} です。Dispatcher、Slack Adapter、メインエージェントが対象releaseで稼働していることを確認しました。`;
      desiredSessionStatus = "active";
      break;
    case "rolled_back":
      if (!active || (fence === 1 && payload.active_sha !== payload.current_sha)) {
        throw new Error("rolled_back update must report a confirmed active SHA");
      }
      text = fence > 1 && payload.active_sha !== payload.current_sha
        ? `確認の結果、対象のセルフアップデートは \`${payload.current_sha}\` へロールバックしていました。現在の稼働SHAは ${active} です。`
        : `セルフアップデートは完了せず、以前のreleaseへロールバックしました。稼働SHAは ${active} です。`;
      desiredSessionStatus = "active";
      break;
    case "cancelled":
      text = active
        ? `セルフアップデートを中止しました。確認できた稼働SHAは ${active} です。`
        : "セルフアップデートを中止しました。稼働SHAの確認を伴わない、切替前の中止です。";
      desiredSessionStatus = "active";
      break;
    case "failed":
      if (!active) throw new Error("failed update must report a confirmed active SHA");
      text = `セルフアップデートに失敗しました。稼働SHAは ${active} です。${payload.error ? `理由コードは \`${payload.error.code}\` です。` : ""}`;
      desiredSessionStatus = "suspended";
      break;
    case "needs_review":
      if (payload.active_sha !== null) throw new Error("needs_review update must not claim an active SHA");
      text = `セルフアップデートの完了状態を確定できず、確認が必要です。対象SHAは \`${payload.target_sha}\` ですが、稼働SHAは確認できません。${payload.error ? `理由コードは \`${payload.error.code}\` です。` : ""}`;
      desiredSessionStatus = "suspended";
      break;
  }
  return { requestId: payload.request_id, terminalFence: fence, text, desiredSessionStatus };
}

export class UpdateNotificationDatabase {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    const directory = path.dirname(databasePath);
    fsSync.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fsSync.chmodSync(directory, 0o700);
    this.db = new Database(databasePath);
    fsSync.chmodSync(databasePath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 2000");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 2) throw new Error(`Update notification database schema ${version} is newer than supported schema 2`);
    const migrate = (sql: string): void => {
      this.db.transaction(() => { this.db.exec(sql); })();
    };
    if (version === 0) migrate(`
      CREATE TABLE update_notifications (
        event_id                TEXT PRIMARY KEY,
        notification_id         TEXT NOT NULL UNIQUE,
        request_id              TEXT NOT NULL,
        terminal_fence          INTEGER NOT NULL,
        payload_json            TEXT NOT NULL,
        reply_target_json       TEXT NOT NULL,
        rendered_text           TEXT NOT NULL,
        desired_session_status  TEXT NOT NULL CHECK (desired_session_status IN ('active', 'suspended')),
        status                  TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'posted', 'reported', 'needs_review')),
        attempt_count           INTEGER NOT NULL DEFAULT 0,
        available_at            TEXT NOT NULL,
        post_started_at         TEXT,
        message_ts              TEXT,
        post_status             TEXT CHECK (post_status IN ('created', 'existing') OR post_status IS NULL),
        last_error_code         TEXT,
        last_error_message      TEXT,
        created_at              TEXT NOT NULL,
        updated_at              TEXT NOT NULL,
        completed_at            TEXT
      );
      CREATE INDEX IF NOT EXISTS update_notifications_run_idx
        ON update_notifications(status, available_at, created_at);
      PRAGMA user_version = 2;
    `);
    if (version === 1) migrate(`
      ALTER TABLE update_notifications ADD COLUMN post_status TEXT
        CHECK (post_status IN ('created', 'existing') OR post_status IS NULL);
      PRAGMA user_version = 2;
    `);
  }

  close(): void {
    this.db.close();
  }

  assertReadableWritable(): void {
    this.db.prepare("SELECT 1").get();
    this.db.prepare("UPDATE update_notifications SET updated_at = updated_at WHERE 0").run();
  }

  ensure(row: EventRow, at = new Date()): UpdateNotificationRow {
    const envelope = parseInternalUpdateEventEnvelope(envelopeFromRow(row));
    const rendered = renderUpdateNotification(envelope);
    const timestamp = at.toISOString();
    const payloadJson = stableStringify(envelope.payload);
    const replyTargetJson = stableStringify(envelope.reply_target);
    this.db.prepare(`
      INSERT OR IGNORE INTO update_notifications (
        event_id, notification_id, request_id, terminal_fence, payload_json, reply_target_json,
        rendered_text, desired_session_status, status, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      row.event_id, envelope.external_event_id, rendered.requestId, rendered.terminalFence,
      payloadJson, replyTargetJson, rendered.text, rendered.desiredSessionStatus,
      timestamp, timestamp, timestamp,
    );
    const existing = this.getRequired(row.event_id);
    if (existing.notification_id !== envelope.external_event_id || existing.payload_json !== payloadJson ||
      existing.reply_target_json !== replyTargetJson || existing.rendered_text !== rendered.text) {
      throw new Error("persisted update notification does not match the event");
    }
    return existing;
  }

  recoverDelivering(at = new Date()): number {
    return this.db.prepare(`
      UPDATE update_notifications SET status = 'pending', available_at = ?,
        last_error_code = 'recovered_ambiguous_delivery',
        last_error_message = 'Delivery will be reconciled by Slack metadata before posting', updated_at = ?
      WHERE status = 'delivering'
    `).run(at.toISOString(), at.toISOString()).changes;
  }

  nextAvailable(at = new Date()): UpdateNotificationRow | undefined {
    return this.db.prepare(`
      SELECT * FROM update_notifications
      WHERE status IN ('pending', 'posted') AND available_at <= ?
      ORDER BY created_at LIMIT 1
    `).get(at.toISOString()) as UpdateNotificationRow | undefined;
  }

  beginDelivery(eventId: string, at = new Date()): UpdateNotificationRow {
    const changed = this.db.prepare(`
      UPDATE update_notifications SET status = 'delivering', attempt_count = attempt_count + 1,
        post_started_at = COALESCE(post_started_at, ?), last_error_code = NULL,
        last_error_message = NULL, updated_at = ?
      WHERE event_id = ? AND status = 'pending'
    `).run(at.toISOString(), at.toISOString(), eventId).changes;
    if (changed !== 1) throw new Error("notification is no longer pending");
    return this.getRequired(eventId);
  }

  markPending(eventId: string, code: string, message: string, at = new Date()): void {
    const row = this.getRequired(eventId);
    this.db.prepare(`
      UPDATE update_notifications SET status = 'pending', available_at = ?, last_error_code = ?,
        last_error_message = ?, updated_at = ? WHERE event_id = ?
    `).run(retryAt(row.attempt_count, at), code, message.slice(0, 2_000), at.toISOString(), eventId);
  }

  markReported(eventId: string, messageTs: string, at = new Date()): void {
    this.db.prepare(`
      UPDATE update_notifications SET status = 'reported', message_ts = ?, completed_at = ?,
        last_error_code = NULL, last_error_message = NULL, updated_at = ? WHERE event_id = ?
    `).run(messageTs, at.toISOString(), at.toISOString(), eventId);
  }

  markPosted(eventId: string, receipt: SlackNotificationReceipt, at = new Date()): UpdateNotificationRow {
    const changed = this.db.prepare(`
      UPDATE update_notifications SET status = 'posted', message_ts = ?, post_status = ?,
        completed_at = COALESCE(completed_at, ?), last_error_code = NULL,
        last_error_message = NULL, updated_at = ? WHERE event_id = ? AND status = 'delivering'
    `).run(receipt.message_ts, receipt.post_status, at.toISOString(), at.toISOString(), eventId).changes;
    if (changed !== 1) throw new Error("notification is no longer delivering");
    return this.getRequired(eventId);
  }

  markPermanentPosted(
    eventId: string,
    code: string,
    message: string,
    receipt?: SlackNotificationReceipt,
    at = new Date(),
  ): UpdateNotificationRow {
    const changed = this.db.prepare(`
      UPDATE update_notifications SET status = 'posted', message_ts = COALESCE(?, message_ts),
        post_status = COALESCE(?, post_status), completed_at = COALESCE(completed_at, ?),
        last_error_code = ?, last_error_message = ?, updated_at = ?
      WHERE event_id = ? AND status = 'delivering'
    `).run(
      receipt?.message_ts ?? null,
      receipt?.post_status ?? null,
      at.toISOString(),
      code,
      message.slice(0, 2_000),
      at.toISOString(),
      eventId,
    ).changes;
    if (changed !== 1) throw new Error("notification is no longer delivering");
    return this.getRequired(eventId);
  }

  markNeedsReview(eventId: string, code: string, message: string, at = new Date()): void {
    this.db.prepare(`
      UPDATE update_notifications SET status = 'needs_review', last_error_code = ?,
        last_error_message = ?, completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE event_id = ?
    `).run(code, message.slice(0, 2_000), at.toISOString(), at.toISOString(), eventId);
  }

  get(eventId: string): UpdateNotificationRow | undefined {
    return this.db.prepare("SELECT * FROM update_notifications WHERE event_id = ?").get(eventId) as UpdateNotificationRow | undefined;
  }

  private getRequired(eventId: string): UpdateNotificationRow {
    const row = this.get(eventId);
    if (!row) throw new Error(`Update notification ${eventId} was not found`);
    return row;
  }
}

function udsRequest(
  socketPath: string,
  token: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const encoded = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path: "/v1/internal/update-notifications",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(encoded.length),
        "x-dona-update-token": token,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Slack Adapter notification request timed out")));
    request.once("error", reject);
    request.end(encoded);
  });
}

export class SlackAdapterNotificationClient implements SlackNotificationPort {
  constructor(private readonly config: DispatcherConfig) {}

  async deliver(input: Record<string, unknown>): Promise<SlackNotificationOutcome> {
    const token = await readPrivateToken(this.config.updateInternalTokenPath);
    if (!token) {
      return { outcome: "permanent", code: "missing_internal_token", message: "Internal token could not be read" };
    }
    try {
      const response = await udsRequest(this.config.slackAdapterSocketPath, token, input, this.config.jobCommandTimeoutMs);
      if (response.statusCode === 200) {
        const receipt = slackReceipt(response.body);
        if (!receipt || receipt.notification_id !== input.notification_id ||
          receipt.workspace_id !== input.workspace_id || receipt.channel_id !== input.channel_id ||
          receipt.thread_ts !== input.thread_ts) {
          return { outcome: "retryable", code: "invalid_slack_adapter_response", message: "Slack Adapter response was invalid" };
        }
        return { outcome: "reported", receipt };
      }
      const error = response.body.error as Record<string, unknown> | undefined;
      const code = typeof error?.code === "string" ? error.code : `slack_adapter_http_${response.statusCode}`;
      const message = typeof error?.message === "string" ? error.message : "Slack Adapter rejected the notification";
      const receipt = response.statusCode === 409 ? slackReceipt(response.body.receipt) : undefined;
      const boundReceipt = receipt && receipt.notification_id === input.notification_id &&
        receipt.workspace_id === input.workspace_id && receipt.channel_id === input.channel_id &&
        receipt.thread_ts === input.thread_ts ? receipt : undefined;
      return [400, 401, 403, 409].includes(response.statusCode)
        ? { outcome: "permanent", code, message, ...(boundReceipt ? { receipt: boundReceipt } : {}) }
        : { outcome: "retryable", code, message };
    } catch (error) {
      return {
        outcome: "retryable",
        code: "slack_adapter_unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

class WakeSignal {
  private resolver: (() => void) | undefined;
  wake(): void { this.resolver?.(); this.resolver = undefined; }
  wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.resolver = undefined; resolve(); }, milliseconds);
      timer.unref();
      this.resolver = () => { clearTimeout(timer); resolve(); };
    });
  }
}

async function publishResult(resultPath: string, result: ResultEnvelope): Promise<void> {
  await fs.mkdir(path.dirname(resultPath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(resultPath), 0o700);
  try {
    const existing = await readResultEnvelope(resultPath, result.event_id);
    if (stableStringify(existing) !== stableStringify(result)) throw new Error("existing Result Envelope differs from notification result");
    return;
  } catch (error) {
    if (!(error instanceof ResultNotFoundError)) throw error;
  }
  const temporary = path.join(path.dirname(resultPath), `.${path.basename(resultPath)}.${process.pid}.${Date.now()}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, resultPath);
  const directory = await fs.open(path.dirname(resultPath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  await readResultEnvelope(resultPath, result.event_id);
}

export class UpdateNotificationWorker {
  private readonly wakeSignal = new WakeSignal();
  private running = false;
  private healthy = true;
  private loopPromise: Promise<void> | undefined;

  constructor(
    private readonly events: DispatcherDatabase,
    private readonly notifications: UpdateNotificationDatabase,
    private readonly slack: SlackNotificationPort,
    private readonly config: DispatcherConfig,
    private readonly logger: Logger,
  ) {}

  isRunning(): boolean { return this.running; }
  isHealthy(): boolean {
    if (!this.healthy) return false;
    try {
      this.notifications.assertReadableWritable();
      return true;
    } catch {
      return false;
    }
  }

  start(): void {
    if (this.loopPromise) return;
    this.notifications.recoverDelivering();
    this.running = true;
    this.loopPromise = this.loop().finally(() => { this.running = false; });
  }

  wake(): void { this.wakeSignal.wake(); }

  async stop(): Promise<void> {
    this.running = false;
    this.wake();
    await this.loopPromise;
    this.loopPromise = undefined;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        for (const event of this.events.updateEventsNeedingNotification()) {
          try {
            // Rendering is deterministic validation. A permanently invalid event must not
            // starve every later terminal notification or poison service readiness.
            renderUpdateNotification(envelopeFromRow(event));
          } catch (error) {
            this.events.quarantineUpdateNotification(
              event.event_id,
              "invalid_update_notification",
              error instanceof Error ? error.message : String(error),
            );
            this.logger.error("Invalid update notification was quarantined", {
              error_code: "invalid_update_notification",
              event_id: event.event_id,
            });
            continue;
          }
          this.notifications.ensure(event);
        }
        const row = this.notifications.nextAvailable();
        if (row) await this.deliver(row);
        this.healthy = true;
      } catch (error) {
        this.healthy = false;
        let recovered = 0;
        try {
          recovered = this.notifications.recoverDelivering();
        } catch (recoveryError) {
          this.logger.error("Update notification recovery failed", {
            error_code: "update_notification_recovery_failed",
            error_message: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
          });
        }
        this.logger.error("Update notification iteration failed", {
          error_code: "update_notification_iteration_failed",
          error_message: error instanceof Error ? error.message : String(error),
          recovered_deliveries: recovered,
        });
      }
      if (this.running) await this.wakeSignal.wait(this.config.queuePollMs);
    }
  }

  private async deliver(candidate: UpdateNotificationRow): Promise<void> {
    const event = this.events.get(candidate.event_id);
    if (!event) {
      this.notifications.markNeedsReview(candidate.event_id, "missing_update_event", "Dispatcher event no longer exists");
      return;
    }
    if (event.result_json && event.status === "completed") {
      this.notifications.markReported(candidate.event_id, candidate.message_ts ?? "unknown");
      return;
    }
    if (event.result_json && event.status === "needs_review") {
      this.notifications.markNeedsReview(
        candidate.event_id,
        event.last_error_code ?? "update_notification_failed",
        event.last_error_message ?? "Update notification requires review",
      );
      return;
    }
    if (candidate.status === "posted") {
      if (candidate.last_error_code) {
        await this.finalizePermanent(event, candidate);
        return;
      }
      if (!candidate.message_ts || !candidate.post_status || !candidate.completed_at) {
        this.notifications.markNeedsReview(candidate.event_id, "invalid_posted_receipt", "Persisted Slack receipt is incomplete");
        return;
      }
      await this.finalizeReported(event, candidate, {
        notification_id: candidate.notification_id,
        workspace_id: (JSON.parse(candidate.reply_target_json) as Record<string, string>).workspace_id!,
        channel_id: (JSON.parse(candidate.reply_target_json) as Record<string, string>).channel_id!,
        thread_ts: (JSON.parse(candidate.reply_target_json) as Record<string, string>).thread_ts!,
        message_ts: candidate.message_ts,
        post_status: candidate.post_status,
        session_status: candidate.desired_session_status,
      });
      return;
    }
    const row = this.notifications.beginDelivery(candidate.event_id);
    const replyTarget = JSON.parse(row.reply_target_json) as Record<string, unknown>;
    const outcome = await this.slack.deliver({
      schema_version: 1,
      notification_id: row.notification_id,
      request_id: row.request_id,
      terminal_fence: row.terminal_fence,
      workspace_id: replyTarget.workspace_id,
      channel_id: replyTarget.channel_id,
      thread_ts: replyTarget.thread_ts,
      text: row.rendered_text,
      desired_session_status: row.desired_session_status,
    });
    if (outcome.outcome === "retryable") {
      this.notifications.markPending(row.event_id, outcome.code, outcome.message);
      return;
    }
    if (outcome.outcome === "permanent") {
      const permanent = this.notifications.markPermanentPosted(
        row.event_id,
        outcome.code,
        outcome.message,
        outcome.receipt,
      );
      await this.finalizePermanent(event, permanent);
      return;
    }
    const posted = this.notifications.markPosted(row.event_id, outcome.receipt);
    await this.finalizeReported(event, posted, outcome.receipt);
  }

  private async finalizeReported(
    event: EventRow,
    row: UpdateNotificationRow,
    receipt: SlackNotificationReceipt,
  ): Promise<void> {
    if (!row.completed_at) throw new Error("Posted notification has no deterministic completion time");
    const resultPath = path.join(this.config.resultsDir, `${event.event_id}.json`);
    const result: ResultEnvelope = {
      schema_version: 1,
      event_id: event.event_id,
      status: "completed",
      summary: "セルフアップデートの終端状態をSlackへ報告し、Agent Sessionを更新しました。",
      actions: [
        {
          tool: "slack_internal_reporter.post_message",
          workspace_id: receipt.workspace_id,
          channel_id: receipt.channel_id,
          thread_ts: receipt.thread_ts,
          message_ts: receipt.message_ts,
          post_status: receipt.post_status,
          success: true,
        },
        {
          tool: "slack_internal_reporter.set_agent_session_status",
          workspace_id: receipt.workspace_id,
          channel_id: receipt.channel_id,
          thread_ts: receipt.thread_ts,
          status: receipt.session_status,
          success: true,
        },
      ],
      memory_candidates: [],
      completed_at: row.completed_at,
    };
    await publishResult(resultPath, result);
    this.events.saveDeterministicCompleted(event.event_id, result, resultPath);
    this.notifications.markReported(row.event_id, receipt.message_ts);
  }

  private async finalizePermanent(event: EventRow, row: UpdateNotificationRow): Promise<void> {
    if (!row.completed_at || !row.last_error_code) throw new Error("Permanent notification failure is incomplete");
    const resultPath = path.join(this.config.resultsDir, `${event.event_id}.json`);
    const replyTarget = JSON.parse(row.reply_target_json) as Record<string, string>;
    const actions: ResultEnvelope["actions"] = row.message_ts && row.post_status
      ? [
          {
            tool: "slack_internal_reporter.post_message",
            workspace_id: replyTarget.workspace_id,
            channel_id: replyTarget.channel_id,
            thread_ts: replyTarget.thread_ts,
            message_ts: row.message_ts,
            post_status: row.post_status,
            success: true,
          },
          {
            tool: "slack_internal_reporter.set_agent_session_status",
            workspace_id: replyTarget.workspace_id,
            channel_id: replyTarget.channel_id,
            thread_ts: replyTarget.thread_ts,
            status: row.desired_session_status,
            success: true,
          },
        ]
      : [];
    const result: ResultEnvelope = {
      schema_version: 1,
      event_id: event.event_id,
      status: "failed",
      summary: `Slack最終報告を完了できませんでした: ${row.last_error_code}`,
      actions,
      memory_candidates: [],
      completed_at: row.completed_at,
    };
    await publishResult(resultPath, result);
    this.events.saveDeterministicFailure(event.event_id, result, resultPath, row.last_error_code);
    this.notifications.markNeedsReview(
      row.event_id,
      row.last_error_code,
      row.last_error_message ?? "Slack Adapter permanently rejected the notification",
    );
  }
}
