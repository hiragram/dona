import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { UpdaterClient, UpdaterClientError } from "../src/updater-client.js";

test("UpdaterClient retains a structured rejection from the stable Updater", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-updater-client-"));
  const socketPath = path.join(root, "updater.sock");
  const server = http.createServer((_request, response) => {
    const body = JSON.stringify({
      schema_version: 1,
      error: { code: "request_failed", message: "target_does_not_pass_fixed_ci_trust_gate" },
    });
    response.writeHead(409, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const client = new UpdaterClient(socketPath);
    await assert.rejects(
      client.plan({ source_event_id: "evt_01M1ES03XY5CF8D9PM5CWX4SRV" }),
      (error: unknown) => {
        assert.ok(error instanceof UpdaterClientError);
        assert.equal(error.statusCode, 409);
        assert.equal(error.code, "request_failed");
        assert.equal(error.message, "target_does_not_pass_fixed_ci_trust_gate");
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
