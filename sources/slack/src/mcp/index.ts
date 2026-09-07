#!/usr/bin/env node
import "dotenv/config";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs/promises";

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
  let key:string|undefined;
  try { key=(await fs.readFile(config.accessReceiptKeyPath,"utf8")).trim()||undefined; }
  catch(error) { logger.warn("Slack access receipt signing is unavailable",{error_message:error instanceof Error?error.message:String(error)}); }
  const server = createSlackMcpServer(registry, logger, key?input=>{
    const payload=Buffer.from(JSON.stringify({...input,issued_at:new Date().toISOString(),nonce:randomUUID()})).toString("base64url");
    return `${payload}.${createHmac("sha256",key).update(payload).digest("base64url")}`;
  }:undefined);
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
