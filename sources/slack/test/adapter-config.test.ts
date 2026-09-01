import assert from "node:assert/strict";
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
  });

  test("rejects attempts to disable Socket Mode", () => {
    assert.throws(
      () => loadAdapterConfig({ SLACK_WORKSPACES: "company", SLACK_SOCKET_MODE_ENABLED: "false" }),
      /must be true/,
    );
  });
});
