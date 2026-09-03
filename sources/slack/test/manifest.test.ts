import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";

test("does not declare unsupported custom message metadata", async () => {
  const manifest = await fs.readFile(new URL("../manifest.yaml", import.meta.url), "utf8");
  assert.doesNotMatch(manifest, /^(?:metadata|metadata_events):/m);
  assert.doesNotMatch(manifest, /^      - metadata\.message:read$/m);
});
