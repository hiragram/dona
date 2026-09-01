import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadRuntimeConfig } from "../src/config.js";

describe("loadRuntimeConfig", () => {
  it("loads valid settings and defaults", () => {
    const config = loadRuntimeConfig({ SLACK_WORKSPACES: "company,community" });

    assert.deepEqual(config, {
      workspaces: ["company", "community"],
      logLevel: "info",
    });
  });

  it("parses optional settings", () => {
    const config = loadRuntimeConfig({
      SLACK_WORKSPACES: "company",
      SLACK_LOG_LEVEL: "DEBUG",
    });

    assert.equal(config.logLevel, "debug");
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
