import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  keychainAccount,
  loadStoredSlackBotToken,
  resolveSlackTokens,
} from "../src/credentials.js";
import type { KeychainStore } from "../src/keychain.js";
import type { SecretPrompt, SecretPromptOptions } from "../src/prompt.js";

class MemoryKeychain implements KeychainStore {
  readonly values = new Map<string, string>();
  readonly writes: Array<{ account: string; value: string }> = [];
  async get(account: string) {
    return this.values.get(account);
  }
  async set(account: string, value: string) {
    this.values.set(account, value);
    this.writes.push({ account, value });
  }
}

function promptValues(values: string[], asked: SecretPromptOptions[] = []): SecretPrompt {
  return async (options) => {
    asked.push(options);
    const value = values.shift();
    if (value === undefined) throw new Error("No prompt value queued");
    return value;
  };
}

describe("resolveSlackTokens", () => {
  test("loads app and bot tokens from workspace-specific Keychain accounts", async () => {
    const keychain = new MemoryKeychain();
    keychain.values.set("company.slack-app-token", "xapp-company");
    keychain.values.set("company.slack-bot-token", "xoxb-company");
    const tokens = await resolveSlackTokens("company", keychain, async () => {
      throw new Error("must not prompt");
    });
    assert.deepEqual(tokens, { appToken: "xapp-company", botToken: "xoxb-company" });
  });

  test("keeps xapp and xoxb prompts and accounts distinct", async () => {
    const keychain = new MemoryKeychain();
    const asked: SecretPromptOptions[] = [];
    const tokens = await resolveSlackTokens(
      "community",
      keychain,
      promptValues(["xoxb-wrong", "xapp-community", "xoxb-community"], asked),
    );
    assert.deepEqual(tokens, { appToken: "xapp-community", botToken: "xoxb-community" });
    assert.deepEqual(asked.map(({ prefix }) => prefix), ["xapp-", "xapp-", "xoxb-"]);
    assert.deepEqual(keychain.writes.map(({ account }) => account), [
      keychainAccount("community", "slack-app-token"),
      keychainAccount("community", "slack-bot-token"),
    ]);
  });
});

describe("loadStoredSlackBotToken", () => {
  test("reads a workspace-specific token without prompting", async () => {
    const keychain = new MemoryKeychain();
    keychain.values.set("company.slack-bot-token", "xoxb-company");
    assert.equal(await loadStoredSlackBotToken("company", keychain), "xoxb-company");
    assert.deepEqual(keychain.writes, []);
  });

  test("fails with setup guidance instead of reading from MCP stdin", async () => {
    const keychain = new MemoryKeychain();
    await assert.rejects(
      loadStoredSlackBotToken("company", keychain),
      /Slack Adapterを一度起動.*xoxb-/,
    );
    assert.deepEqual(keychain.writes, []);
  });
});
