import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { loadRuntimeConfig } from "../src/config.js";

describe("loadRuntimeConfig", () => {
  it("loads valid settings and defaults", () => {
    const config = loadRuntimeConfig({ SLACK_WORKSPACES: "company,community" });

    assert.deepEqual(config, {
      workspaces: ["company", "community"],
      logLevel: "info",
      accessReceiptKeyPath: path.join(os.homedir(),"Library","Application Support","Dona","update-control","dispatcher.token"),
    });
  });

  it("parses optional settings", () => {
    const config = loadRuntimeConfig({
      SLACK_WORKSPACES: "company",
      SLACK_LOG_LEVEL: "DEBUG",
      DONA_UPDATE_INTERNAL_TOKEN_PATH: "~/receipt.key",
    });

    assert.equal(config.logLevel, "debug");
    assert.equal(config.accessReceiptKeyPath,path.join(os.homedir(),"receipt.key"));
  });

  it("rejects a missing workspace list", () => {
    assert.throws(() => loadRuntimeConfig({}), /SLACK_WORKSPACES/);
  });

  it("rejects an invalid workspace alias", () => {
    assert.throws(
      () => loadRuntimeConfig({ SLACK_WORKSPACES: "Company Name" }),
      /ワークスペース別名/,
    );
  });

  it("rejects duplicate workspace aliases", () => {
    assert.throws(
      () => loadRuntimeConfig({ SLACK_WORKSPACES: "company,company" }),
      /同じワークスペース別名/,
    );
  });

});
