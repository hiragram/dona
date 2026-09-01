import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type KeytarAdapter,
  MacOSKeychainStore,
} from "../src/keychain.js";

describe("MacOSKeychainStore", () => {
  it("reads a generic password through the native Keychain API", async () => {
    const keyring: KeytarAdapter = {
      getPassword: async () => "xapp-secret",
      setPassword: async () => {},
    };
    const keychain = new MacOSKeychainStore("test.service", keyring);

    assert.equal(await keychain.get("company.slack-app-token"), "xapp-secret");
  });

  it("returns undefined when an item does not exist", async () => {
    const keyring: KeytarAdapter = {
      getPassword: async () => null,
      setPassword: async () => {},
    };
    const keychain = new MacOSKeychainStore("test.service", keyring);

    assert.equal(await keychain.get("missing"), undefined);
  });

  it("stores a token through the native Keychain API", async () => {
    const writes: string[][] = [];
    const keyring: KeytarAdapter = {
      getPassword: async () => null,
      setPassword: async (...args) => {
        writes.push(args);
      },
    };
    const keychain = new MacOSKeychainStore("test.service", keyring);

    await keychain.set("company.slack-app-token", "xapp-secret");

    assert.deepEqual(writes, [["test.service", "company.slack-app-token", "xapp-secret"]]);
  });

  it("reports unexpected Keychain errors", async () => {
    const keyring: KeytarAdapter = {
      getPassword: async () => { throw new Error("keychain is locked"); },
      setPassword: async () => {},
    };
    const keychain = new MacOSKeychainStore("test.service", keyring);

    await assert.rejects(() => keychain.get("company.slack-app-token"), /keychain is locked/);
  });

  it("never stores an empty token", async () => {
    const keyring: KeytarAdapter = {
      getPassword: async () => null,
      setPassword: async () => { throw new Error("must not run"); },
    };
    const keychain = new MacOSKeychainStore("test.service", keyring);

    await assert.rejects(() => keychain.set("company.slack-app-token", ""), /空のToken/);
  });
});
