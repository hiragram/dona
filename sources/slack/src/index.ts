#!/usr/bin/env node
import "dotenv/config";

import { SocketModeClient } from "@slack/socket-mode";

import { loadAdapterConfig } from "./adapter-config.js";
import { resolveSlackTokens } from "./credentials.js";
import { DispatcherClient } from "./dispatcher-client.js";
import { SlackHealthServer } from "./health-server.js";
import { MacOSKeychainStore } from "./keychain.js";
import { createSlackLogger, createSocketSdkLogger } from "./logger.js";
import { promptSecret } from "./prompt.js";
import { SlackSocketAdapter, type WorkspaceSocket } from "./socket-adapter.js";
import { SlackUpdateNotificationReporter } from "./update-notification.js";
import { SlackJobProgressReporter } from "./job-progress.js";
import { SlackWorkspaceRegistry } from "./workspace-registry.js";

async function main(): Promise<void> {
  const config = loadAdapterConfig();
  const keychain = new MacOSKeychainStore();
  const logger = createSlackLogger(config.logLevel);
  const sockets: WorkspaceSocket[] = [];

  for (const workspace of config.workspaces) {
    const tokens = await resolveSlackTokens(workspace, keychain, promptSecret);
    sockets.push({
      workspace,
      client: new SocketModeClient({
        appToken: tokens.appToken,
        logger: createSocketSdkLogger(logger, config.logLevel),
        autoReconnectEnabled: false,
        pingPongLoggingEnabled: false,
      }),
    });
  }

  const dispatcher = new DispatcherClient({
    socketPath: config.dispatcherSocketPath,
    connectTimeoutMs: config.dispatcherConnectTimeoutMs,
    timeoutMs: config.dispatcherTimeoutMs,
  });
  const registry = await SlackWorkspaceRegistry.load(config.workspaces, keychain, logger);
  const updateNotifications = new SlackUpdateNotificationReporter(registry);
  const adapter = new SlackSocketAdapter(sockets, dispatcher, config, logger);
  const health = new SlackHealthServer(
    config.healthSocketPath,
    adapter,
    dispatcher,
    logger,
    config.buildSha,
    updateNotifications,
    config.updateInternalTokenPath,
    new SlackJobProgressReporter(registry, (progressId) => dispatcher.resolveJobProgress(progressId)),
  );
  await health.start();
  try {
    await adapter.start();
  } catch (error) {
    await adapter.stop();
    await health.stop();
    throw error;
  }

  let stopping = false;
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info("Stopping Slack Socket Mode Adapter", { signal });
    try {
      await adapter.stop();
      await health.stop();
    } catch (error) {
      logger.error("Slack Adapter graceful shutdown failed", {
        error_code: "shutdown_failed",
        error_message: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((error: unknown) => {
  if (error instanceof Error && error.name === "ExitPromptError") {
    console.info("Tokenの入力を中断しました");
    process.exitCode = 130;
    return;
  }

  console.error("Failed to start Slack Socket Mode Adapter", error);
  process.exitCode = 1;
});
