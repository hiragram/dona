#!/usr/bin/env node
import "dotenv/config";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadRuntimeConfig } from "../config.js";
import { MacOSKeychainStore } from "../keychain.js";
import { createSlackLogger, sanitizeLogValue } from "../logger.js";
import { SlackWorkspaceRegistry } from "../workspace-registry.js";
import { createSlackMcpServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const logger = createSlackLogger(config.logLevel, {
    component: "dona_slack_mcp",
    stderrOnly: true,
  });
  const registry = await SlackWorkspaceRegistry.load(
    config.workspaces,
    new MacOSKeychainStore(),
    logger,
  );
  const server = createSlackMcpServer(registry, logger);
  await server.connect(new StdioServerTransport());
  logger.info("Dona Slack MCP server started", { transport: "stdio" });

  let stopping = false;
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info("Stopping Dona Slack MCP server", { signal });
    await server.close();
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      component: "dona_slack_mcp",
      message: "Failed to start Dona Slack MCP server",
      error_message: sanitizeLogValue(message),
    })}\n`,
  );
  process.exitCode = 1;
});
