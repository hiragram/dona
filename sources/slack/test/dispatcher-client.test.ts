import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { DispatcherClient } from "../src/dispatcher-client.js";
import { principalProofKeyId } from "../src/principal-proof.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

test("DispatcherClientはprivate keyを毎回読み、署名済みprincipal proofをeventと一緒に送る", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-slack-principal-client-")); roots.push(root);
  const socketPath = path.join(root, "dispatcher.sock"), tokenPath = path.join(root, "dispatcher.token");
  const key = "dispatcher-client-principal-proof-key-long-enough";
  await fs.writeFile(tokenPath, key, { mode: 0o600 });
  let captured: { headers:http.IncomingHttpHeaders; body:string } | undefined;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      captured = { headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
      response.writeHead(202, { "content-type": "application/json" }); response.end("{}");
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  const client = new DispatcherClient({ socketPath, connectTimeoutMs: 500, timeoutMs: 2_000, ingressTokenPath: tokenPath });
  const envelope = { schema_version:1, source:"slack", external_event_id:"Ev-client-proof", type:"message",
    occurred_at:"2026-09-21T00:00:00Z", subject:{workspace_id:"T_FIXTURE",actor_id:"U_OWNER"}, payload:{text:"secret"},
    reply_target:{kind:"slack_thread",workspace_id:"T_FIXTURE",channel_id:"C_PRIVATE",thread_ts:"1.000001"}, trace:{ingress_attempt:2} };
  assert.equal((await client.postEvent(envelope, 2, "T_FIXTURE")).statusCode, 202);
  assert.equal(captured?.body, JSON.stringify(envelope));
  const proofHeader = captured?.headers["x-dona-slack-principal-proof"];
  const signature = captured?.headers["x-dona-slack-principal-signature"];
  assert.equal(typeof proofHeader, "string"); assert.equal(typeof signature, "string");
  const raw = Buffer.from(proofHeader as string, "base64url").toString("utf8");
  const proof = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual({ event_id:proof.event_id, attempt:proof.attempt, workspace_id:proof.workspace_id,
    principal_id:proof.principal_id, key_id:proof.key_id }, {
    event_id:"Ev-client-proof", attempt:2, workspace_id:"T_FIXTURE", principal_id:"U_OWNER", key_id:principalProofKeyId(key),
  });
  assert.equal(signature, createHmac("sha256", key).update(raw).digest("base64url"));
  assert.equal(raw.includes("secret"), false);
  await assert.rejects(
    () => client.postEvent(envelope, 2, "T_OTHER"),
    /invalid_slack_principal_input/,
  );

  const rotatedKey = "rotated-dispatcher-client-principal-key-long-enough";
  await fs.writeFile(tokenPath, rotatedKey, { mode: 0o600 });
  assert.equal((await client.postEvent(envelope, 3, "T_FIXTURE")).statusCode, 202);
  const rotatedRaw = Buffer.from(captured?.headers["x-dona-slack-principal-proof"] as string, "base64url").toString("utf8");
  const rotatedProof = JSON.parse(rotatedRaw) as Record<string, unknown>;
  assert.equal(rotatedProof.key_id, principalProofKeyId(rotatedKey));
  assert.equal(rotatedProof.attempt, 3);

  await fs.chmod(tokenPath, 0o644);
  await assert.rejects(() => client.postEvent(envelope, 4, "T_FIXTURE"), /key is unavailable/);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
