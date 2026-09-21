#!/usr/bin/env node
import "dotenv/config";

import { loadAdapterConfig } from "./adapter-config.js";
import { DispatcherClient } from "./dispatcher-client.js";
import { normalizeManualEnvelope } from "./manual-envelope.js";

async function readInput(): Promise<unknown> {
  const chunks:Buffer[]=[];let size=0;
  for await (const chunk of process.stdin) {
    const value=Buffer.from(chunk);size+=value.length;
    if(size>1_048_576) throw new Error("Manual event exceeds 1 MiB");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const config=loadAdapterConfig();
const {envelope,attempt,workspaceId}=normalizeManualEnvelope(await readInput());
const client=new DispatcherClient({socketPath:config.dispatcherSocketPath,connectTimeoutMs:config.dispatcherConnectTimeoutMs,
  timeoutMs:config.dispatcherTimeoutMs,ingressTokenPath:config.slackIngressTokenPath});
const response=await client.postEvent(envelope,attempt,workspaceId);
process.stdout.write(`${response.statusCode} ${response.body}\n`);
if(response.statusCode!==200&&response.statusCode!==202) process.exitCode=1;
