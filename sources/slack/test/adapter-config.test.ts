import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { loadAdapterConfig } from "../src/adapter-config.js";

describe("loadAdapterConfig", () => {
  test("uses Socket Mode and local UDS defaults", () => {
    const config = loadAdapterConfig({ SLACK_WORKSPACES: "company" });
    assert.equal(config.socketModeEnabled, true);
    assert.equal(
      config.dispatcherSocketPath,
      path.join(os.homedir(), "Library", "Application Support", "Dona", "run", "dispatcher.sock"),
    );
    assert.equal(
      config.healthSocketPath,
      path.join(os.homedir(), "Library", "Application Support", "Dona", "run", "slack-adapter.sock"),
    );
    assert.equal(config.appSchemaWrite, 3);
  });

  test("loads bridge schema write compatibility from the release manifest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dona-slack-manifest-"));
    try {
      const manifestPath = path.join(root, "release-manifest.json");
      await fs.writeFile(manifestPath, JSON.stringify({
        sha: "2".repeat(40),
        compatibility: { app_schema_write: 2 },
      }));
      const config = loadAdapterConfig({ SLACK_WORKSPACES: "company", DONA_RELEASE_MANIFEST_PATH: manifestPath });
      assert.equal(config.buildSha, "2".repeat(40));
      assert.equal(config.appSchemaWrite, 2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects attempts to disable Socket Mode", () => {
    assert.throws(
      () => loadAdapterConfig({ SLACK_WORKSPACES: "company", SLACK_SOCKET_MODE_ENABLED: "false" }),
      /must be true/,
    );
  });

});
