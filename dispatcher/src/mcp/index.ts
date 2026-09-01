#!/usr/bin/env node
import "dotenv/config";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { DispatcherApiClient } from "../client.js";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { createDispatcherMcpServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger("dona_dispatcher_mcp", { stderrOnly: true });
  const server = createDispatcherMcpServer(
    new DispatcherApiClient(config.socketPath, config.jobCommandTimeoutMs + 5_000),
    logger,
  );
  await server.connect(new StdioServerTransport());
  logger.info("Dona Dispatcher MCP server started", { transport: "stdio" });

  let stopping = false;
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info("Stopping Dona Dispatcher MCP server", { signal });
    await server.close();
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    component: "dona_dispatcher_mcp",
    message: "Failed to start Dona Dispatcher MCP server",
    error_message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
