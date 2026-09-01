import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { sanitizeLogValue } from "../src/logger.js";

describe("structured log redaction", () => {
  test("redacts tokens, WebSocket URLs, and payload-like fields", () => {
    const sanitized = sanitizeLogValue({
      error_message: "failed xapp-secret-value xoxb-secret-value wss://wss-primary.slack.com/link/?ticket=secret",
      authorization: "Bearer hidden",
      payload: { text: "private Slack message" },
    });
    const output = JSON.stringify(sanitized);
    assert.doesNotMatch(output, /secret-value|wss-primary|Bearer hidden|private Slack message/);
    assert.match(output, /REDACTED/);
  });
});
