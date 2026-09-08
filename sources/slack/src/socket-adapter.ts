import crypto from "node:crypto";

import type { SlackAdapterConfig } from "./adapter-config.js";
import type { DispatcherClient, DispatcherResponse } from "./dispatcher-client.js";
import type { SlackLogger } from "./logger.js";
import { normalizeSlackEvent } from "./normalize.js";

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnecting"
  | "disconnected"
  | "authentication_failed";

export interface SocketEnvelopeEvent {
  ack(response?: Record<string, unknown>): Promise<void>;
  envelope_id: string;
  type: string;
  body: Record<string, unknown>;
  retry_num?: number;
  retry_reason?: string;
}

export interface SocketClientLike {
  on(event: string, listener: (...args: any[]) => void): this;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
}

export interface WorkspaceSocket {
  workspace: string;
  client: SocketClientLike;
}

const retryDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const permanentErrors = new Set([
  "invalid_auth",
  "not_authed",
  "not_allowed_token_type",
  "missing_scope",
  "account_inactive",
  "token_revoked",
]);

function shortEnvelopeId(envelopeId: string): string {
  return crypto.createHash("sha256").update(envelopeId).digest("hex").slice(0, 12);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function platformErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const data = (error as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return undefined;
  const value = (data as { error?: unknown }).error;
  return typeof value === "string" ? value : undefined;
}

export class SlackSocketAdapter {
  private readonly states = new Map<string, ConnectionState>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly stableTimers = new Map<string, NodeJS.Timeout>();
  private readonly connecting = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();
  private stopping = false;

  constructor(
    private readonly sockets: readonly WorkspaceSocket[],
    private readonly dispatcher: Pick<DispatcherClient, "postEvent" | "healthReady">,
    private readonly config: SlackAdapterConfig,
    private readonly logger: SlackLogger,
    private readonly random: () => number = Math.random,
  ) {
    for (const socket of sockets) {
      this.states.set(socket.workspace, "disconnected");
      this.bind(socket);
    }
  }

  async start(): Promise<void> {
    this.stopping = false;
    await Promise.all(this.sockets.map((socket) => this.connect(socket, true)));
  }

  async stop(): Promise<void> {
    await this.quiesce();
  }

  async quiesce(): Promise<void> {
    this.stopping = true;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    for (const timer of this.stableTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    this.stableTimers.clear();

    if (this.inFlight.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise((resolve) => setTimeout(resolve, this.config.shutdownGraceMs)),
      ]);
    }
    await Promise.allSettled(this.sockets.map(({ client }) => client.disconnect()));
    if (this.inFlight.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise((resolve) => setTimeout(resolve, this.config.shutdownGraceMs)),
      ]);
    }
  }

  isSocketReady(): boolean {
    return (
      !this.stopping &&
      this.sockets.length > 0 &&
      this.sockets.every(({ workspace }) => this.states.get(workspace) === "connected")
    );
  }

  isStopping(): boolean {
    return this.stopping;
  }

  connectionStates(): Record<string, ConnectionState> {
    return Object.fromEntries(this.states);
  }

  drainStatus(): { quiescing: boolean; drained: boolean; in_flight: number; unsafe_states: string[] } {
    const unsafe = this.inFlight.size > 0 ? [`dispatcher_posts_or_acks:${this.inFlight.size}`] : [];
    return { quiescing: this.stopping, drained: this.stopping && unsafe.length === 0, in_flight: this.inFlight.size, unsafe_states: unsafe };
  }

  trackExternal<T>(operation: Promise<T>): Promise<T> {
    const drain = operation.then(() => undefined, () => undefined);
    this.inFlight.add(drain);
    void drain.finally(() => this.inFlight.delete(drain));
    return operation;
  }

  private bind(socket: WorkspaceSocket): void {
    const { workspace, client } = socket;
    for (const state of ["connecting", "connected", "reconnecting", "disconnecting", "disconnected"] as const) {
      client.on(state, (error?: unknown) => this.onLifecycle(socket, state, error));
    }
    client.on("error", (error: unknown) => {
      this.logger.error("Socket Mode client error", {
        workspace,
        connection_state: this.states.get(workspace),
        error_code: platformErrorCode(error) ?? "socket_mode_error",
        error_message: errorMessage(error),
      });
    });
    client.on("ws_message", (data: string | ArrayBuffer, isBinary: boolean) => {
      if (isBinary) return;
      try {
        const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
        const message = JSON.parse(raw) as { type?: unknown; reason?: unknown };
        if (message.type === "disconnect") {
          this.logger.warn("Slack requested Socket Mode disconnect", {
            workspace,
            connection_state: this.states.get(workspace),
            disconnect_reason: typeof message.reason === "string" ? message.reason : "unknown",
          });
        }
      } catch {
        this.logger.warn("Could not inspect Socket Mode lifecycle message", {
          workspace,
          error_code: "invalid_socket_lifecycle_message",
        });
      }
    });
    client.on("slack_event", (event: SocketEnvelopeEvent) => this.track(this.handleEnvelope(workspace, event)));
  }

  private onLifecycle(socket: WorkspaceSocket, state: ConnectionState, error?: unknown): void {
    const { workspace } = socket;
    this.states.set(workspace, state);
    this.logger.info("Socket Mode connection state changed", {
      workspace,
      connection_state: state,
      reconnect_attempt: this.reconnectAttempts.get(workspace) ?? 0,
      ...(error === undefined ? {} : { disconnect_reason: errorMessage(error) }),
    });
    if (state === "connected") {
      const oldTimer = this.stableTimers.get(workspace);
      if (oldTimer) clearTimeout(oldTimer);
      const timer = setTimeout(() => {
        this.reconnectAttempts.set(workspace, 0);
        this.stableTimers.delete(workspace);
      }, 60_000);
      timer.unref();
      this.stableTimers.set(workspace, timer);
    }
    if (state === "disconnected") {
      const stableTimer = this.stableTimers.get(workspace);
      if (stableTimer) clearTimeout(stableTimer);
      this.stableTimers.delete(workspace);
    }
    if (state === "disconnected" && !this.stopping) this.scheduleReconnect(socket);
  }

  private async connect(socket: WorkspaceSocket, initial: boolean): Promise<void> {
    const { workspace, client } = socket;
    if (
      this.stopping ||
      this.connecting.has(workspace) ||
      this.states.get(workspace) === "authentication_failed"
    ) {
      return;
    }
    this.connecting.add(workspace);
    try {
      await client.start();
    } catch (error) {
      const code = platformErrorCode(error);
      if (code && permanentErrors.has(code)) {
        const reconnectTimer = this.reconnectTimers.get(workspace);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        this.reconnectTimers.delete(workspace);
        this.states.set(workspace, "authentication_failed");
        this.logger.error("Permanent Socket Mode authentication error", {
          workspace,
          connection_state: "authentication_failed",
          error_code: code,
          error_message: errorMessage(error),
        });
        if (initial) throw error;
        return;
      }
      this.logger.warn("Socket Mode connection attempt failed", {
        workspace,
        connection_state: this.states.get(workspace),
        reconnect_attempt: this.reconnectAttempts.get(workspace) ?? 0,
        error_code: code ?? "socket_connect_failed",
        error_message: errorMessage(error),
      });
      this.scheduleReconnect(socket);
    } finally {
      this.connecting.delete(workspace);
    }
  }

  private scheduleReconnect(socket: WorkspaceSocket): void {
    const { workspace } = socket;
    if (this.stopping || this.reconnectTimers.has(workspace) || this.states.get(workspace) === "authentication_failed") {
      return;
    }
    const attempt = (this.reconnectAttempts.get(workspace) ?? 0) + 1;
    this.reconnectAttempts.set(workspace, attempt);
    const base = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)]!;
    const delay = Math.min(30_000, Math.max(100, Math.round(base * (0.8 + this.random() * 0.4))));
    this.states.set(workspace, "reconnecting");
    this.logger.warn("Scheduled Socket Mode reconnect", {
      workspace,
      connection_state: "reconnecting",
      reconnect_attempt: attempt,
      reconnect_delay_ms: delay,
    });
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(workspace);
      void this.connect(socket, false);
    }, delay);
    timer.unref();
    this.reconnectTimers.set(workspace, timer);
  }

  private track(promise: Promise<void>): void {
    const tracked = promise.catch((error: unknown) => {
      this.logger.error("Unhandled Socket Mode envelope error", {
        ack_sent: false,
        error_code: "envelope_handler_failed",
        error_message: errorMessage(error),
      });
    });
    this.inFlight.add(tracked);
    void tracked.finally(() => this.inFlight.delete(tracked));
  }

  private async handleEnvelope(workspace: string, envelope: SocketEnvelopeEvent): Promise<void> {
    const started = Date.now();
    const envelopeLogId = shortEnvelopeId(envelope.envelope_id);
    if (this.stopping) {
      this.logger.warn("Socket Mode envelope left unacknowledged during shutdown", {
        workspace,
        slack_envelope_type: envelope.type,
        slack_envelope_id: envelopeLogId,
        ack_sent: false,
      });
      return;
    }
    if (envelope.type !== "events_api") {
      await this.ackIgnored(workspace, envelope, started, envelopeLogId);
      return;
    }

    const body = envelope.body && typeof envelope.body === "object" ? envelope.body : {};
    let normalized;
    try {
      normalized = normalizeSlackEvent(body, new Date(), envelope.envelope_id);
    } catch (error) {
      this.logger.error("Socket Mode event normalization failed and was not acknowledged", {
        workspace,
        slack_envelope_type: envelope.type,
        slack_envelope_id: envelopeLogId,
        slack_event_id: body.event_id,
        ack_sent: false,
        error_code: "normalization_failed",
        error_message: errorMessage(error),
      });
      return;
    }
    if (!normalized) {
      await this.ackIgnored(workspace, envelope, started, envelopeLogId);
      return;
    }
    const slackEventId = normalized.envelope.external_event_id;
    if (normalized.usedReceivedAt) {
      this.logger.warn("Slack event timestamp was invalid; receive time was used", {
        workspace,
        slack_envelope_id: envelopeLogId,
        slack_event_id: slackEventId,
        error_code: "invalid_occurred_at",
      });
    }

    let response: DispatcherResponse;
    const dispatchStarted = Date.now();
    try {
      response = await this.dispatcher.postEvent(normalized.envelope);
    } catch (error) {
      this.logger.error("Dispatcher connection failed; Socket Mode envelope was not acknowledged", {
        workspace,
        slack_envelope_type: envelope.type,
        slack_envelope_id: envelopeLogId,
        slack_event_id: slackEventId,
        ack_sent: false,
        duration_to_dispatcher_commit_ms: Date.now() - dispatchStarted,
        error_code: "dispatcher_unavailable",
        error_message: errorMessage(error),
      });
      return;
    }
    const dispatcherDuration = Date.now() - dispatchStarted;
    if (response.statusCode !== 200 && response.statusCode !== 202) {
      this.logger.error("Dispatcher did not persist Socket Mode event; envelope was not acknowledged", {
        workspace,
        slack_envelope_type: envelope.type,
        slack_envelope_id: envelopeLogId,
        slack_event_id: slackEventId,
        dispatcher_status_code: response.statusCode,
        ack_sent: false,
        duration_to_dispatcher_commit_ms: dispatcherDuration,
        error_code: response.statusCode >= 500 ? "dispatcher_server_error" : "dispatcher_contract_error",
      });
      return;
    }

    try {
      await envelope.ack({});
      this.logger.info("Socket Mode event persisted and acknowledged", {
        workspace,
        slack_envelope_type: envelope.type,
        slack_envelope_id: envelopeLogId,
        slack_event_id: slackEventId,
        dispatcher_status_code: response.statusCode,
        ack_sent: true,
        duration_to_dispatcher_commit_ms: dispatcherDuration,
        duration_to_ack_ms: Date.now() - started,
      });
    } catch (error) {
      this.logger.error("Dispatcher persisted event but Socket Mode ACK failed", {
        workspace,
        slack_envelope_type: envelope.type,
        slack_envelope_id: envelopeLogId,
        slack_event_id: slackEventId,
        dispatcher_status_code: response.statusCode,
        ack_sent: false,
        ack_error: errorMessage(error),
        duration_to_dispatcher_commit_ms: dispatcherDuration,
        duration_to_ack_ms: Date.now() - started,
      });
    }
  }

  private async ackIgnored(
    workspace: string,
    envelope: SocketEnvelopeEvent,
    started: number,
    envelopeLogId: string,
  ): Promise<void> {
    try {
      await envelope.ack({});
      this.logger.debug("Ignored Socket Mode envelope acknowledged", {
        workspace,
        slack_envelope_type: envelope.type,
        slack_envelope_id: envelopeLogId,
        ack_sent: true,
        duration_to_ack_ms: Date.now() - started,
      });
    } catch (error) {
      this.logger.error("ACK failed for ignored Socket Mode envelope", {
        workspace,
        slack_envelope_type: envelope.type,
        slack_envelope_id: envelopeLogId,
        ack_sent: false,
        ack_error: errorMessage(error),
      });
    }
  }
}
