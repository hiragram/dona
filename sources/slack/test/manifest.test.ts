import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";

test("registers the update notification schema at the manifest top level", async () => {
  const manifest = await fs.readFile(new URL("../manifest.yaml", import.meta.url), "utf8");
  const lines = manifest.split(/\r?\n/);
  assert.equal(lines.filter((line) => line === "metadata:").length, 1);
  assert.equal(lines.some((line) => line === "  metadata:"), false);
  assert.match(manifest, /^metadata:\n  event_subscriptions:\n    - event_type: dona\.update_notification$/m);
  assert.match(manifest, /^      - metadata\.message:read$/m);
});
